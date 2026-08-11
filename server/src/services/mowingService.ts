/**
 * Mowing Service — centrale module voor het starten/stoppen van maaisessies.
 *
 * Gebruikt EXACT dezelfde code path als de dashboard command handler
 * (encrypt + publishRawToDevice) — bewezen werkend vanuit het HomeScreen.
 *
 * Gebruikt door:
 * - Schedule runner (automatisch op schema)
 * - Dashboard API (handmatige start via browser)
 * - App API (start via OpenNova/Novabot app)
 */

import { publishToDevice } from '../mqtt/mapSync.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { deviceCache } from '../mqtt/sensorData.js';
import { deviceSettingsRepo } from '../db/repositories/deviceSettings.js';
import { selectParaRepush } from '../mqtt/paraRepush.js';

/** Settle time (ms) between re-applying the saved para and start_navigation, so
 *  the mower has processed set_para_info before it captures perception_level /
 *  path_direction at task start. */
export const MOW_PARA_SETTLE_MS = 1500;

/**
 * Returns true when the mower is already executing a task (mowing, edge,
 * mapping, returning, init/startup transitions). Accepting another
 * start_navigation during an active task triggers Error 2 "Already in running
 * task" on the firmware (issue #13), so the scheduler skips those.
 *
 * deviceCache holds the RAW numeric work_status (the dashboard translates only
 * at display time), so we compare raw codes here.
 *
 * IDLE/TERMINAL codes (NOT busy — a fresh start is allowed): WAIT(0), FAILED(1),
 * CANCELLED(2), FAILED_ONCE(7), FINISHED(8/9) and the stop codes USER_STOP(10),
 * USER_RECHARGE_STOP(11), LOWER_POWER_STOP(12), ERROR_STOP(13),
 * TIME_LIMIT_STOP(14), RECOVER_ERROR_STOP(15).
 *
 * CRITICAL FIX: the old set was only {0,2,9}, so FAILED(1) and the stop codes
 * counted as "busy". After ONE aborted scheduled mow the mower parked at
 * work_status=1 (FAILED) and EVERY later scheduled startMowing was silently
 * rejected with "mower busy" — forever — until a manual app-start (which does
 * NOT go through this guard) reset the state. That is exactly the "schedule
 * stopped firing for days while manual still works" symptom.
 */
const IDLE_WORK_STATUS = new Set([
  '', '0', '1', '2', '7', '8', '9', '10', '11', '12', '13', '14', '15',
]);

export function isMowerBusy(sn: string): boolean {
  const raw = deviceCache.get(sn);
  if (!raw) return false;
  const ws = raw.get('work_status') ?? '';
  if (!IDLE_WORK_STATUS.has(ws)) return true;
  const msg = raw.get('msg') ?? '';
  return /Work:(MOVING|COVERING|REQUEST_START|INIT_|RUNNING|MAPPING)/.test(msg)
    || /Recharge:(MOVING|RUNNING|GOING)/.test(msg);
}

export interface MowingParams {
  sn: string;
  /**
   * User-facing cutting height in cm (2-9). Wire value sent to mqtt_node is `cm - 2`.
   * Verified 2026-04-19 via live Novabot-app capture on LFIN1231000211
   * (mqtt_node_20260419_163617_821948.log @ 18:18:09):
   *   user picks 4cm → MQTT cutterhigh:2 → physical blade 40mm ✓
   *   user picks 6cm → MQTT cutterhigh:4 → physical blade 60mm
   * Firmware formula: physical_mm = (cutterhigh + 2) * 10.
   *
   * Auto-normalisation accepts multiple encodings from legacy callers.
   */
  cuttingHeight?: number;
  pathDirection?: number;   // degrees (0-359), default 120
  // Decimal positional bitmask: map0=1, map1=10, map2=100; sum for multi-map
  // (11=map0+map1, 111=all three). The firmware mows every set map in one task.
  // Passed verbatim to start_navigation. See research/documents/multi-map-area-bitmask-decode.md.
  area?: number;
}

export interface MowingResult {
  ok: boolean;
  error?: string;
}

/**
 * Normalise a schedule's stored cutting height to the firmware wire enum
 * (`cutterhigh = cm − 2`, range 0..7). `dashboard_schedules.cutting_height` is
 * stored in DIFFERENT units by the two schedule editors, but in DISJOINT
 * ranges, so we can tell them apart unambiguously:
 *   - app ScheduleScreen  → user cm  (2..9)
 *   - dashboard Scheduler → mm       (20..90)
 * So: ≥ 20 is mm (÷10), anything below is already user cm. Clamp to 2..9 cm.
 *
 * This replaces an older value-range heuristic whose "3..11 → legacy cm+2 wire,
 * subtract 2" branch mis-read app cm values: a 9 cm schedule became 7 cm
 * (9 − 2). The wire (0..2) and legacy-cm+2 branches are dropped — the only
 * caller (scheduleRunner) always passes cm or mm, never a wire value.
 */
export function cuttingHeightToWire(input: number): number {
  const displayCm = input >= 20 ? Math.round(input / 10) : input;
  const clampedCm = Math.max(2, Math.min(9, Math.round(displayCm)));
  return Math.max(0, clampedCm - 2);
}

/** Randmaai bladehoogte in mm voor start_edge_cut. cutting_height komt als mm
 *  (dashboard, >=20) of user-cm (app) binnen — zelfde heuristiek als
 *  cuttingHeightToWire. extended_commands.py clamt óók 20..90 op de maaier;
 *  we clampen hier alvast zodat de payload nooit buiten bereik valt. */
export function edgeBladeHeightMm(cuttingHeight: number): number {
  const mm = cuttingHeight >= 20 ? Math.round(cuttingHeight) : Math.round(cuttingHeight * 10);
  return Math.max(20, Math.min(90, mm));
}

/** Publish a command to the mower. Delegates to publishToDevice which
 *  checks isAesCapable() and falls back to plain JSON for stock v5.x
 *  mowers and charger v0.3.x — both silently drop AES payloads, so
 *  the schedule runner + start_navigation flow previously failed
 *  invisibly on those firmwares (issues #45 / #49). */
function sendCommand(sn: string, command: Record<string, unknown>): void {
  publishToDevice(sn, command);
  console.log(`[MowingService] Sent ${Object.keys(command)[0]} to ${sn}`);
}

/**
 * Start een maaisessie op de maaier.
 * Stuurt start_navigation, exact als de Novabot app en het HomeScreen.
 */
export function startMowing(params: MowingParams): MowingResult {
  const { sn, cuttingHeight = 5, area = 1 } = params;
  const pathDirection = params.pathDirection;

  if (!sn) return { ok: false, error: 'sn required' };
  if (!isDeviceOnline(sn)) return { ok: false, error: 'mower offline' };
  if (isMowerBusy(sn)) {
    console.log(`[MowingService] Reject start: ${sn} already busy (work_status/msg active)`);
    return { ok: false, error: 'mower busy — already in a task' };
  }

  // Normalise the stored cutting height (cm from the app, mm from the dashboard)
  // to the firmware wire enum. See cuttingHeightToWire.
  const cutterhigh = cuttingHeightToWire(cuttingHeight);
  const cmdNum = Date.now() % 100000;

  // Re-apply the user's saved para (mow direction + obstacle avoidance + lights/
  // sound/joystick) RIGHT BEFORE the mow. The mower does NOT persist set_para_info
  // over a reconnect, so without this a task can start with reset defaults: most
  // critically perception_level 0 = camera obstacle-avoidance OFF, and direction
  // 0°. Both perception_level and path_direction are captured at task START, so we
  // send the FULL saved block first (selectParaRepush — partial would reset the
  // omitted fields to 0), let it settle, then start_navigation. Only when there
  // are saved settings; otherwise mow as-is (never send a partial block).
  const para = selectParaRepush(deviceSettingsRepo.findBySn(sn));
  if (para) {
    if (typeof pathDirection === 'number') para.path_direction = pathDirection;
    sendCommand(sn, { set_para_info: para });
  }

  const fireStart = (): void => {
    sendCommand(sn, {
      start_navigation: { mapName: 'test', cutterhigh, area, cmd_num: cmdNum },
    });
    console.log(`[MowingService] Started: sn=${sn} cutterhigh=${cutterhigh} (=${cutterhigh + 2}cm) dir=${pathDirection ?? '(saved)'}° area=${area} reapplied_para=${para ? 'yes' : 'none'}`);
  };
  if (para) setTimeout(fireStart, MOW_PARA_SETTLE_MS);
  else fireStart();

  return { ok: true };
}

/**
 * Stop een actieve maaisessie.
 */
export function stopMowing(sn: string): MowingResult {
  if (!sn) return { ok: false, error: 'sn required' };

  const cmdNum = Date.now() % 100000;
  sendCommand(sn, {
    stop_navigation: { cmd_num: cmdNum },
  });

  console.log(`[MowingService] Stopped: sn=${sn}`);
  return { ok: true };
}

/** Grove maaier-fase uit de sensor-cache, voor de rand-dag watcher.
 *  charging = battery_state CHARGING ÉN het is een echt einde-taak-dock;
 *  mowing = actieve coverage-status; other = al het overige (undocken, idle,
 *  offline, en ook een dock ná een mid-mow laadpauze of een afgebroken
 *  beurt, zie hieronder). */
export function getMowerPhase(sn: string): 'mowing' | 'charging' | 'other' {
  const raw = deviceCache.get(sn);
  if (!raw) return 'other';
  const batteryState = (raw.get('battery_state') ?? '').toUpperCase();
  const msg = raw.get('msg') ?? '';

  // Een gedockte, ladende maaier telt alleen als 'charging' wanneer het een
  // ECHT einde-taak-dock is. Twee gevallen waarin hij wel laadt maar de
  // maaibeurt NIET is afgerond, en die dus vóór de battery_state-check moeten
  // komen, want beide zouden anders een autonome randmaai uitlokken:
  //
  // 1. Mid-mow laadpauze. De firmware pauzeert een lopende coverage-taak zelf
  //    voor een low-battery recharge, dockt, laadt tot ongeveer 96% en hervat
  //    dan de gepauzeerde taak zelf (coverContinueDeal, zie
  //    research/documents/firmware-auto-continue-after-recharge.md).
  //    battery_state staat dan al op CHARGING terwijl de taak feitelijk nog
  //    loopt. Zou dit 'charging' opleveren, dan vuurt de rand-dag watcher
  //    startEdgeCut af terwijl de firmware vrijwel gelijktijdig de coverage
  //    hervat: twee conflicterende bewegingscommando's op echte hardware.
  //
  // 2. Afgebroken beurt. De gebruiker stopt halverwege (stop_navigation) en
  //    stuurt de maaier naar het dock, of de beurt eindigt op een tijdslimiet
  //    of een fout. Een bewust of foutief afgebroken beurt is geen afgeronde
  //    maaibeurt en mag dus nooit alsnog een randmaai uitlokken.
  //
  // Deze check leunt bewust NIET (meer) op task_mode === 1, zoals
  // isInterruptedCoverage in dashboard/src/utils/mowerActivity.ts wel doet:
  // stop_navigation zet task_mode terug op 0, waardoor geval 2 door die gate
  // heen glipte en een halverwege gestopte beurt binnen 30 seconden alsnog een
  // randmaai startte. Strenger dan de dashboard-variant mag hier: die kiest
  // alleen een knop-label, deze gate laat een echt bewegingscommando toe of niet.
  //
  // De rangorde op het dock, gestoeld op de captures (Task 6 ronde 4,
  // research/documents/obstacle-capture-*.jsonl):
  //
  //   a. Expliciete stop-/afbreeksignalen (live Work-tag, "Prev work", ruwe
  //      work_status-code) winnen altijd: 'other'.
  //   b. De live tag "Mode:COVERAGE ... Work:FINISHED" is het VERTROUWDE
  //      einde-taak-signaal en heeft GEEN dekkingsbewijs nodig. In de echte
  //      capture van een afgeronde beurt op het dock staat die tag urenlang
  //      stabiel (ws 9, cov_ratio 1, finished_num 1, 1729 samples) en hij
  //      verschijnt nooit midden in een maaibeurt. Zo blijft de feature ook
  //      leven wanneer cov_ratio ontbreekt. "Mode:COVERAGE" is verplicht:
  //      mapping-sessies rapporteren OOK een live "Work:FINISHED"
  //      ("Mode:MAPPING Work:FINISHED ... Recharge: FINISHED", cov_ratio
  //      0.099 in de capture) en een randmaai na een mapping-sessie is fout.
  //   c. ELKE andere live Work-tag op het dock (WAIT, CANCELLED, of welke
  //      doorgerolde spelling dan ook) is AMBIGU en vereist dekkingsbewijs
  //      (cov_ratio >= 0.95). Ná het dokken rollen de msg-velden namelijk
  //      door en worden een afgeronde beurt, een handmatig gestopte beurt en
  //      een laadpauze byte-identiek: elk msg-veld beschrijft de DOK-cyclus,
  //      alleen cov_ratio gaat over de maaibeurt zelf. Issue #17 (twee live
  //      meldronden, zie equipmentState.ts:243-264) bewijst dat een NETJES
  //      afgeronde beurt als "Work:CANCELLED Prev work:USER_RECHARGE_STOP
  //      Recharge: FINISHED" kan rapporteren; de idle-dock capture bewijst
  //      dat "Work:WAIT Prev work:WAIT Recharge: FINISHED" met cov_ratio 0
  //      OOK bestaat. Dezelfde vorm, tegengestelde betekenis: cov_ratio
  //      beslist.
  const onDock = batteryState === 'CHARGING' || batteryState === 'FINISHED';
  const workStatus = raw.get('work_status') ?? '';

  // Dekkingsbewijs voor de ambigue vormen: cov_ratio >= 0.95, en ALLEEN
  // cov_ratio. finished_num telt hier bewust NIET mee (Task 6 ronde 4): dat
  // veld telt afgeronde zones en zegt niets over de zones die nog openstaan.
  // In een meerzone-tuin waar map0 klaar was en de beurt tijdens map1 werd
  // afgebroken staat finished_num al op 1 bij cov_ratio ~0.4; met finished_num
  // als bewijs zou dat als afgeronde beurt tellen en een randmaai starten.
  // Live capture van een afgeronde beurt op het dock (obstacle-capture-norelay
  // 20260601): cov_ratio 1 (en finished_num 1, maar dat voegt daar niets toe).
  // cov_ratio komt als fractie 0..1 binnen (zie app HomeScreen.tsx:317); een
  // waarde > 1 wordt als percentage gelezen, net als in render/svgMap.ts.
  // ONTBREEKT of onleesbaar: GEEN bewijs, en dus de veilige kant. Liever een
  // randmaai gemist dan een randmaai gestart op een beurt die halverwege is
  // afgebroken.
  const covRatioRaw = parseFloat(raw.get('cov_ratio') ?? '');
  const covRatio = Number.isFinite(covRatioRaw)
    ? (covRatioRaw > 1 ? covRatioRaw / 100 : covRatioRaw)
    : null;
  const coverageEvidence = covRatio !== null && covRatio >= 0.95;

  // a1. De LIVE Work-status zegt dat de taak nu stilstaat: gepauzeerd voor een
  //     recharge, door de gebruiker gestopt, of op een limiet/fout geëindigd.
  //     Dit weegt zwaarder dan welk afrondingssignaal dan ook: tijdens een
  //     mid-mow laadpauze staat er óók "Recharge: FINISHED" in de msg (de
  //     dok-cyclus zelf verliep prima), en juist dan mag er niets starten.
  //     CANCELLED staat hier bewust NIET tussen: per issue #17 kan een netjes
  //     afgeronde beurt als CANCELLED rapporteren (zie rangorde-blok
  //     hierboven); CANCELLED valt daarom onder de ambigue vormen (c).
  const liveStopTag = /Work:(USER_STOP|PAUSED|USER_RECHARGE_STOP|BATTERY_LOW_RECHARGE|TIME_LIMIT_STOP|ERROR_STOP)\b/.test(msg);
  // a2. De VORIGE Work-status wijst op een afbreking. Bij het dokken is de live
  //     tag vaak al doorgerold naar WAIT of CANCELLED en blijft de reden alleen
  //     in "Prev work" staan (kleine w, dus geen overlap met de regex
  //     hierboven). USER_RECHARGE_STOP hoort hier NIET thuis: dat is per issue
  //     #17 juist het handtekening-signaal van een normaal afgeronde beurt.
  //     MOVING en RUNNING horen hier evenmin (Task 6 ronde 4): een afgeronde
  //     beurt rijdt als laatste "werk" naar het dock, dus "Prev work:MOVING"
  //     kan legitiem bij een afgeronde beurt horen; hard afwijzen zou de
  //     feature dan stil doden. Geen enkele capture toont MOVING/RUNNING als
  //     "Prev work" (de ene echte afrond-capture toont FINISHED_ONCE), dus dit
  //     is niet uit bewijs te beslissen; die vormen vallen daarom onder de
  //     ambigue gate (c), waar cov_ratio het echte afbreek-scenario al afvangt.
  //     COVERING blijft WEL staan: midden uit de dekking gerukt en gedockt is
  //     nooit een afgeronde beurt.
  const prevWorkAborted = /Prev work:(USER_STOP|PAUSED|TIME_LIMIT_STOP|ERROR_STOP|COVERING)\b/.test(msg);
  // a3. Ruwe work_status-code van een afgebroken beurt, de codes uit
  //     IDLE_WORK_STATUS hierboven: FAILED(1), FAILED_ONCE(7), USER_STOP(10),
  //     USER_RECHARGE_STOP(11), LOWER_POWER_STOP(12), ERROR_STOP(13),
  //     TIME_LIMIT_STOP(14), RECOVER_ERROR_STOP(15). Vangnet voor het geval de
  //     msg al helemaal is doorgerold. CANCELLED(2) staat er bewust niet in
  //     (issue #17), FINISHED(8/9) en WAIT(0) evenmin: dat zijn juist de
  //     afgeronde beurten waar de randmaai op moet volgen.
  const abortedWorkStatus = ['1', '7', '10', '11', '12', '13', '14', '15'].includes(workStatus);

  if (onDock && (liveStopTag || prevWorkAborted || abortedWorkStatus)) return 'other';

  // b. Het vertrouwde einde-taak-signaal: live "Work:FINISHED" in Mode:COVERAGE.
  //    De \b sluit "Work:FINISHED_ONCE" uit (underscore is een woordteken) en
  //    de hoofdletter W matcht "Prev work:FINISHED" niet.
  const trustedFinishTag = msg.includes('Mode:COVERAGE') && /Work:FINISHED\b/.test(msg);
  // c. Elke ANDERE live Work-tag op het dock is ambigu en vereist
  //    dekkingsbewijs. \bWork: matcht de live tag maar niet "Prev work:"
  //    (kleine w). Een msg zonder enige Work-tag (leeg, of alleen
  //    battery-payload gezien) valt hier bewust buiten: dat is afwezigheid van
  //    data, geen doorgerolde spelling, en het bestaande gedrag (kaal CHARGING
  //    telt als charging) blijft staan.
  const ambiguousDockShape = !trustedFinishTag && /\bWork:[A-Z]/.test(msg);
  if (onDock && ambiguousDockShape && !coverageEvidence) return 'other';

  if (batteryState === 'CHARGING') return 'charging';
  const ws = parseInt(workStatus, 10);
  if ([100, 101, 102, 103, 150].includes(ws)) return 'mowing';
  if (/Work:(COVERING|RUNNING|MOVING|BOUNDARY_COVERING)/.test(msg)) return 'mowing';
  return 'other';
}

/** Start een losse randmaai-sessie (zelfde payload als de app). bladeHeightMm
 *  wordt op de maaier (extended_commands.py) nogmaals 20..90 geclamd. */
export function startEdgeCut(sn: string, mapName: string, bladeHeightMm: number): MowingResult {
  if (!sn) return { ok: false, error: 'sn required' };
  if (!isDeviceOnline(sn)) return { ok: false, error: 'mower offline' };
  sendCommand(sn, { start_edge_cut: { mapName, bladeHeight: bladeHeightMm } });
  console.log(`[MowingService] start_edge_cut: sn=${sn} map=${mapName} blade=${bladeHeightMm}mm`);
  return { ok: true };
}

/**
 * Stuur de maaier naar het laadstation.
 */
export function goHome(sn: string): MowingResult {
  if (!sn) return { ok: false, error: 'sn required' };

  const cmdNum = Date.now() % 100000;
  sendCommand(sn, { go_pile: {} });
  setTimeout(() => {
    sendCommand(sn, {
      go_to_charge: {
        cmd_num: cmdNum,
        chargerpile: { latitude: 200, longitude: 200 },
      },
    });
  }, 500);

  console.log(`[MowingService] Go home: sn=${sn}`);
  return { ok: true };
}
