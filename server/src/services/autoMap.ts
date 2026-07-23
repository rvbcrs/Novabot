/**
 * autoMap — orkestrator voor autonoom karteren (route B).
 *
 * De maaier-daemon (auto_map_node.py) rijdt de rand en bewaakt geofence en
 * timeout; deze service orkestreert de FIRMWARE-karteersessie eromheen
 * (start_scan_map … save_map, exact de bewezen BLE-mapping-flow) en houdt de
 * sessiestatus bij voor dashboard/review.
 * Spec: docs/superpowers/specs/2026-07-22-autonomous-mapping-design.md
 */
import {
  publishToDevice, getNextCmdNum,
  onDeviceResponse, offDeviceResponse,
  onExtendedResponse, offExtendedResponse,
} from '../mqtt/mapSync.js';
import { publishExtendedCommand } from '../mqtt/extendedCommands.js';
import { deviceCache } from '../mqtt/sensorData.js';
import {
  AutoMapSession, createSession, updatePhase, getActiveSession, getLatestSession,
} from '../db/repositories/autoMapSessions.js';
import { mapRepo } from '../db/repositories/maps.js';

const TAG = '[autoMap]';
const RESPOND_TIMEOUT_MS = 20_000;
const RECHARGE_TIMEOUT_MS = 30_000;
const SAVE_TOTAL_DELAY_MS = 600;   // ≥600 ms tussen save_recharge_pos_respond en save_map type:1
// Volgmotor-timeout (start_auto_map_test timeoutS) + marge. Als de daemon
// niet reageert (niet geïnstalleerd/gecrasht) blijft de sessie zonder dit
// eeuwig 'actief' tot een server-herstart de orphan-reconciliatie triggert.
const SESSION_WATCHDOG_MS = (1200 + 120) * 1000;

/**
 * Bewuste conservatieve result-check (result-semantiek is niet 100% zeker in
 * dit protocol): een respond telt ALLEEN als FOUT wanneer het result-veld
 * AANWEZIG is én niet 0. Ontbreekt het result-veld (niet elke respond
 * garandeert een echo ervan), dan blijft dat bewust als succes gelden, zoals
 * voorheen.
 */
function isExplicitFailure(payload: Record<string, unknown> | null): boolean {
  if (!payload || !('result' in payload)) return false;
  return Number(payload.result) !== 0;
}

export interface AutoMapProgress {
  sn: string; sessionId: number; phase: string; detail?: Record<string, unknown>;
}

const progressCbs: Array<(p: AutoMapProgress) => void> = [];
export function onProgress(cb: (p: AutoMapProgress) => void): void { progressCbs.push(cb); }

function emit(sn: string, sessionId: number, phase: string, detail?: Record<string, unknown>): void {
  for (const cb of progressCbs) { try { cb({ sn, sessionId, phase, detail }); } catch { /* ignore */ } }
}

/**
 * Wacht op één device-respond met de gegeven sleutel. Optionele `match`-predicate
 * filtert late/duplicaat responds (bv. een verlaat save_map_respond type:0 dat
 * anders de wait voor type:1 vroegtijdig zou resolven).
 */
function waitForRespond(
  sn: string,
  key: string,
  timeoutMs: number,
  match?: (payload: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const handler = (data: Record<string, unknown>) => {
      if (!(key in data)) return;
      const payload = data[key] as Record<string, unknown>;
      if (match && !match(payload)) return;
      cleanup(); resolve(payload);
    };
    const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); offDeviceResponse(sn, handler); };
    onDeviceResponse(sn, handler);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface LiveRun {
  session: AutoMapSession;
  extHandler: (d: Record<string, unknown>) => void;
  /** Door stopAutoMap() aangeroepen om een user-stop nooit te laten verdampen
   *  (bv. tijdens het scan-start-venster, terwijl de daemon nog niet weet
   *  van deze sessie). Zie autoMap.ts requestStop-definitie. */
  requestStop: () => void;
}
const liveRuns = new Map<string, LiveRun>();

function preflight(sn: string): string | null {
  const cache = deviceCache.get(sn);
  const battery = parseInt(cache?.get('battery_power') ?? cache?.get('battery_capacity') ?? '', 10);
  if (isNaN(battery) || battery <= 40) return 'preflight_battery';
  if ((cache?.get('rtk_fix_quality') ?? '') !== '4') return 'preflight_rtk';
  return null;
}

export async function startAutoMap(
  sn: string, opts: { mode: 'test' | 'record'; radiusM?: number },
): Promise<{ ok: true; sessionId: number } | { ok: false; error: string }> {
  // Lazy reconciliation: een sessie die bij een server-herstart in
  // preparing/recording/finishing stond heeft geen live handler meer (liveRuns
  // is een in-memory Map). Zonder dit blijft getActiveSession() hem eeuwig
  // teruggeven en faalt elke nieuwe start met already_running. awaiting_review
  // blijft ongemoeid — accept/reject werken op de DB, geen live handler nodig.
  const orphan = getActiveSession(sn);
  if (orphan && !liveRuns.has(sn) && orphan.phase !== 'awaiting_review') {
    updatePhase(orphan.id, 'error', { error: 'orphaned_by_restart', finished: true });
  }
  if (getActiveSession(sn)) return { ok: false, error: 'already_running' };
  const pf = preflight(sn);
  if (pf) return { ok: false, error: pf };
  // record-mode schrijft onvoorwaardelijk naar map0 — een maaier met al een
  // kaart zou die vóór enige review overschreven zien. Testrit raakt geen
  // kaartdata en mag dus wel op een reeds gekarteerde maaier draaien.
  if (opts.mode === 'record' && mapRepo.findWorkMaps(sn).length > 0) {
    return { ok: false, error: 'map_exists' };
  }

  const radiusM = Math.max(5, Math.min(200, opts.radiusM ?? 30));
  const session = createSession(sn, opts.mode, radiusM);
  const setPhase = (phase: string, patch?: Parameters<typeof updatePhase>[2], detail?: Record<string, unknown>) => {
    updatePhase(session.id, phase, patch); emit(sn, session.id, phase, detail);
  };

  // Expliciete run-toestand tegen de finishing-race: zonder dit kan een
  // aborted/error-event of een tweede result-code-0 tijdens finalize() de
  // afrondreeks en de abort-flow door elkaar laten lopen ("halve kaart").
  let runState: 'running' | 'finishing' | 'closed' = 'running';
  let cancelRequested = false;

  // Server-side sessie-watchdog (bevinding 2): reageert de daemon nooit (niet
  // geïnstalleerd/gecrasht), dan blijft de sessie zonder dit eeuwig actief —
  // orphan-reconciliatie grijpt pas na een server-herstart. Wordt overal waar
  // de sessie sluit opgeruimd zodat normale sessies hem nooit raken en geen
  // timer blijft hangen.
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  const clearWatchdog = () => {
    if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = undefined; }
  };

  const finish = (phase: string, patch?: Parameters<typeof updatePhase>[2], detail?: Record<string, unknown>) => {
    if (runState === 'closed') return; // dubbele finish (bv. late timeout na abort) mag de eindfase niet overschrijven
    runState = 'closed';
    clearWatchdog();
    const run = liveRuns.get(sn);
    if (run) { offExtendedResponse(sn, run.extHandler); liveRuns.delete(sn); }
    setPhase(phase, { ...patch, finished: true }, detail);
  };

  // Afrondreeks (alleen mode record, alleen bij LOOP_CLOSED). Exacte volgorde
  // en payloads: docs/reference/MAPPING-FLOW.md — NOOIT wijzigen.
  const finalize = async () => {
    setPhase('finishing');
    publishToDevice(sn, { stop_scan_map: { value: false, cmd_num: getNextCmdNum(sn) } });
    const stopResp = await waitForRespond(sn, 'stop_scan_map_respond', RESPOND_TIMEOUT_MS);
    if (cancelRequested) return finish('aborted', { error: 'aborted_during_finishing' });
    if (!stopResp) return finish('error', { error: 'stop_scan_map_timeout' });
    if (isExplicitFailure(stopResp)) return finish('error', { error: 'stop_scan_map_failed' });

    publishToDevice(sn, { save_map: { mapName: 'map0', type: 0, cmd_num: getNextCmdNum(sn) } });
    // type-veld kan ontbreken in de respond (niet gegarandeerd dat de firmware
    // 'type' echoot) — dan accepteren we 'm; alleen een EXPLICIETE andere type
    // wordt als een niet-bijpassend (verlaat) duplicaat genegeerd.
    const save0 = await waitForRespond(sn, 'save_map_respond', RESPOND_TIMEOUT_MS,
      (p) => p?.type === undefined || Number(p.type) === 0);
    if (cancelRequested) return finish('aborted', { error: 'aborted_during_finishing' });
    if (!save0) return finish('error', { error: 'save_map0_timeout' });
    if (isExplicitFailure(save0)) return finish('error', { error: 'save_map0_failed' });

    publishToDevice(sn, { save_recharge_pos: { mapName: 'map0', cmd_num: getNextCmdNum(sn) } });
    const recharge = await waitForRespond(sn, 'save_recharge_pos_respond', RECHARGE_TIMEOUT_MS);
    if (cancelRequested) return finish('aborted', { error: 'aborted_during_finishing' });
    if (!recharge) return finish('error', { error: 'save_recharge_pos_timeout' });
    if (isExplicitFailure(recharge)) return finish('error', { error: 'save_recharge_pos_failed' });

    await sleep(SAVE_TOTAL_DELAY_MS);
    if (cancelRequested) return finish('aborted', { error: 'aborted_during_finishing' });

    publishToDevice(sn, { save_map: { mapName: 'map0', type: 1, cmd_num: getNextCmdNum(sn) } });
    const save1 = await waitForRespond(sn, 'save_map_respond', RESPOND_TIMEOUT_MS,
      (p) => p?.type === undefined || Number(p.type) === 1);
    if (cancelRequested) return finish('aborted', { error: 'aborted_during_finishing' });
    if (!save1) return finish('error', { error: 'save_map1_timeout' });
    if (isExplicitFailure(save1)) return finish('error', { error: 'save_map1_failed' });

    setPhase('awaiting_review');
    runState = 'closed';
    clearWatchdog();
    // sessie blijft "actief" tot accept/reject — bewust geen finish()
    const run = liveRuns.get(sn);
    if (run) { offExtendedResponse(sn, run.extHandler); liveRuns.delete(sn); }
  };

  // Abort in record-mode: opname stoppen ZONDER saves (spec: geen halve kaart).
  // Wordt ALLEEN aangeroepen terwijl runState === 'running'; tijdens finishing
  // handelt finalize() de cancellatie zelf af (cancelRequested).
  const abortRecording = (phase: string, patch?: Parameters<typeof updatePhase>[2], detail?: Record<string, unknown>) => {
    publishToDevice(sn, { stop_scan_map: { value: false, cmd_num: getNextCmdNum(sn) } });
    finish(phase, patch, detail);
  };

  // Bevinding 1: user-stop mag nooit verdampen. Dit dekt zowel het
  // scan-start-venster (start_scan_map is al verstuurd, de volgmotor nog
  // niet — de daemon kent deze sessie dan nog niet en publiceert dus nooit
  // een aborted-event) als de normale rijfase. Tijdens 'finishing' zet dit
  // alleen cancelRequested: finalize() rondt de al gestarte save-reeks zelf
  // netjes af (zie de cancelRequested-checks hierboven).
  const requestStop = () => {
    cancelRequested = true;
    if (runState === 'running') {
      if (opts.mode === 'record') abortRecording('aborted', { error: 'user_stop' });
      else finish('aborted', { error: 'user_stop' });
    }
  };

  const extHandler = (data: Record<string, unknown>) => {
    if (runState === 'closed') return;
    const st = data['auto_map_status'] as Record<string, unknown> | undefined;
    if (!st) return;
    const phase = String(st.phase ?? '');
    if (phase === 'searching_boundary' || phase === 'following') {
      // Minor #4: late events tijdens finishing/closed mogen de fase niet
      // terugzetten naar recording.
      if (runState !== 'running') return;
      setPhase(opts.mode === 'record' ? 'recording' : phase, undefined, st);
    } else if (phase === 'result') {
      const code = Number(st.code);
      if (opts.mode === 'record' && code === 0) {
        if (runState !== 'running') return; // dedupe: tweede result code 0
        runState = 'finishing';
        void finalize();
        return;
      }
      if (code === 0) { finish('done', { result_code: 0 }); return; }
      const error = code === 1 ? 'geen grasrand gevonden op startpunt'
        : String(st.name ?? `code_${code}`);
      if (opts.mode === 'record') {
        if (runState === 'finishing') { cancelRequested = true; return; }
        abortRecording('error', { result_code: code, error }, st);
      } else finish('error', { result_code: code, error }, st);
    } else if (phase === 'error' || phase === 'aborted') {
      const error = String(st.error ?? phase);
      if (opts.mode === 'record') {
        // Tijdens finishing NIET abortRecording aanroepen (zou stop_scan_map
        // + finish sturen terwijl finalize() nog save_map-commando's stuurt).
        // finalize() checkt cancelRequested na elke await en rondt zelf af.
        if (runState === 'finishing') { cancelRequested = true; return; }
        abortRecording(phase, { error }, st);
      } else finish(phase, { error }, st);
    }
  };
  onExtendedResponse(sn, extHandler);
  liveRuns.set(sn, { session, extHandler, requestStop });

  // Bevinding 2: reageert de daemon nooit, dan sluit deze watchdog de sessie
  // alsnog af in plaats van eeuwig actief te blijven tot een server-herstart.
  watchdogTimer = setTimeout(() => {
    if (runState === 'closed') return;
    console.warn(`${TAG} ${sn}: sessie ${session.id} watchdog-timeout — daemon reageerde niet binnen ${SESSION_WATCHDOG_MS}ms`);
    if (opts.mode === 'record') {
      publishToDevice(sn, { stop_scan_map: { value: false, cmd_num: getNextCmdNum(sn) } });
    }
    finish('error', { error: 'daemon_timeout' });
  }, SESSION_WATCHDOG_MS);

  void (async () => {
    if (opts.mode === 'record') {
      setPhase('recording');
      publishToDevice(sn, {
        start_scan_map: { model: 'manual', mapName: 'map0', type: 0, cmd_num: getNextCmdNum(sn) },
      });
      const resp = await waitForRespond(sn, 'start_scan_map_respond', RESPOND_TIMEOUT_MS);
      if (!resp) return finish('error', { error: 'scan_start_timeout' });
      if (isExplicitFailure(resp)) return finish('error', { error: 'scan_start_failed' });
    } else {
      setPhase('preparing');
    }
    // Sessie kan tijdens het wachten al beëindigd zijn (abort/stale event,
    // of requestStop tijdens het scan-start-venster): dan geen volgmotor
    // meer starten op een dode sessie.
    if (runState !== 'running') return;
    publishExtendedCommand(sn, { start_auto_map_test: { radiusM, timeoutS: 1200 } });
  })();

  console.log(`${TAG} ${sn}: sessie ${session.id} gestart (${opts.mode}, geofence ${radiusM} m)`);
  return { ok: true, sessionId: session.id };
}

export function stopAutoMap(sn: string): void {
  publishExtendedCommand(sn, { stop_auto_map: {} });
  // de maaier meldt daarna auto_map_status {phase:'aborted', error:'user_stop'}
  // — maar tijdens het scan-start-venster (start_scan_map is al verstuurd,
  // de volgmotor nog niet) kent de daemon deze sessie nog niet en komt dat
  // event nooit. requestStop() dekt dat venster (en de normale rijfase)
  // lokaal af zodat een user-stop nooit verdampt.
  liveRuns.get(sn)?.requestStop();
}

export function getStatus(sn: string): AutoMapSession | undefined {
  return getActiveSession(sn) ?? getLatestSession(sn);
}

export function acceptProposal(sn: string): boolean {
  const s = getActiveSession(sn);
  if (!s || s.phase !== 'awaiting_review') return false;
  updatePhase(s.id, 'done', { finished: true });
  emit(sn, s.id, 'done');
  return true;
}

export function rejectProposal(sn: string): boolean {
  const s = getActiveSession(sn);
  if (!s || s.phase !== 'awaiting_review') return false;
  updatePhase(s.id, 'rejected', { finished: true });
  emit(sn, s.id, 'rejected');
  return true;
}
