/**
 * Rain Monitor — bewaakt het weer tijdens actieve maaisessies.
 *
 * Flow (Optie A — stop + herstart):
 * 1. ScheduleRunner start een maaisessie met rain_pause=1
 * 2. RainMonitor detecteert via sensor data dat de maaier aan het maaien is
 * 3. Elke 5 minuten: poll Open-Meteo voor regenvoorspelling
 * 4. Regen verwacht → stuur go_to_charge → sla sessie op in rain_sessions
 * 5. Maaier keert terug naar laadstation
 * 6. Elke 5 minuten: check of regen voorbij is
 * 7. Droog + maaier geladen → stuur start_run met opgeslagen parameters
 *
 * De monitor luistert naar sensor updates (mower_status / work_status) om te
 * weten wanneer de maaier daadwerkelijk aan het maaien is.
 */

import { randomUUID } from 'crypto';
import { scheduleRepo, mapRepo, rainSettingsRepo } from '../db/repositories/index.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { publishToDevice, goToChargePayload, getNextCmdNum } from '../mqtt/mapSync.js';
import { deviceCache, isDockedByValues } from '../mqtt/sensorData.js';
import { getWeatherForecast, shouldPauseForRain } from './weatherService.js';
import { isPatrolDriving } from './patrolRuns.js';
import { emitScheduleEvent } from '../dashboard/socketHandler.js';
import { dispatchRainDockFailedEvent, dispatchRainResumeFailedEvent, type RainReport } from '../notifications/eventDetector.js';
import { getRecentEvents } from '../notifications/dispatcher.js';
import type { RainSessionRow, ScheduleRow } from '../db/repositories/schedules.js';

// ── State ──────────────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minuten

// Track welke maaiers al een go_to_charge hebben gekregen (voorkom dubbele commando's)
const pendingGoCharge = new Set<string>();

/**
 * How long the go home after a rain pause may take before the owner hears it
 * did not reach the dock (GH #156). The monitor ticks every 5 minutes, so that
 * comes 10 to 15 minutes after the go home.
 */
export const RAIN_GO_HOME_TIMEOUT_MS = 10 * 60_000;

// Rain sessions whose go home is settled: the mower reached its dock, or the
// owner heard that it did not. In memory: after a server restart a mower still
// off its dock is reported once more.
const goHomeSettled = new Set<string>();

// Per-mower opt-out: user vinkte "Negeer regen deze sessie" aan in StartMowSheet.
// Geldig tot maaier niet meer mowing rapporteert (auto-clear in checkActiveMowers).
const ignoreSessionSet = new Set<string>();

/**
 * Set the rain-ignore flag for a single mowing session. When active, the
 * monitor skips its pause-trigger for this SN. Auto-clears the moment the
 * mower transitions out of active mowing (next 5-minute tick).
 */
export function setRainIgnoreSession(sn: string, active: boolean): void {
  if (active) {
    ignoreSessionSet.add(sn);
    console.log(`[RainMonitor] Rain-ignore enabled for session: ${sn}`);
    // The user is taking manual control of this rain pause (e.g. tapping Resume
    // during rain). Release any auto-paused rain_session so checkPausedSessions
    // can't later re-issue start_run and re-mow the map after the manual resume.
    const paused = scheduleRepo.findRainSessionByMower(sn, 'paused');
    if (paused) cancelSession(paused, 'manual_rain_ignore');
  } else if (ignoreSessionSet.delete(sn)) {
    console.log(`[RainMonitor] Rain-ignore disabled for: ${sn}`);
  }
}

export function isRainIgnoredForSession(sn: string): boolean {
  return ignoreSessionSet.has(sn);
}

/** Zou de monitor deze maaier voor regen pauzeren? Zelfde poort als in
 *  checkActiveMowers. Uit = de startwaarschuwing in app/dashboard is zinloos. */
export function rainPauseEnabled(sn: string): boolean {
  return !!scheduleRepo.findActiveRainSchedule(sn) || rainSettingsRepo.getEffective(sn).enabled;
}

// ── Helpers ────────────────────────────────────────────────────────

/** Haal charger GPS coördinaten op voor een maaier SN */
function getChargerGps(mowerSn: string): { lat: number; lng: number } | null {
  return mapRepo.getChargerGps(mowerSn);
}

/** Check of maaier momenteel aan het maaien is */
function isMowing(mowerSn: string): boolean {
  const sensors = deviceCache.get(mowerSn);
  if (!sensors) return false;

  // A night patrol is no mow and has no rain pause (spec 2026-10-14). Its
  // firmware departure does report an off-dock coverage task (task_mode 1,
  // Work:MOVING or COVERING), which the checks below would take for a mow.
  if (isPatrolDriving(mowerSn, sensors.get('patrol_phase'))) return false;

  // Check mower_status (via charger LoRa) — "startMowing" = actief maaien
  const mowerStatus = sensors.get('mower_status');
  if (mowerStatus === 'startMowing') return true;

  // Check work_status (directe maaier sensor) — diverse waarden die actief maaien aanduiden
  const workStatus = sensors.get('work_status');
  if (workStatus === '1') return true; // COVER state

  // Parse `msg` field — exactly mirrors HomeScreen activity detection
  const msg = sensors.get('msg') ?? '';
  const taskMode = parseInt(sensors.get('task_mode') ?? '0', 10);
  const rechargeStatus = parseInt(sensors.get('recharge_status') ?? '0', 10);
  const batteryState = (sensors.get('battery_state') ?? '').toUpperCase();
  const onDock = batteryState === 'CHARGING';
  const coverageRunning = msg.includes('Work:RUNNING') || msg.includes('Work:COVERING')
    || msg.includes('Work:NAVIGATING') || msg.includes('Work:MOVING');
  const returning = rechargeStatus === 1 || msg.includes('Recharge: GOING')
    || msg.includes('Work:GO_PILE') || msg.includes('Work:BACK_CHARGER')
    || msg.includes('Work:DOCKING');
  if (coverageRunning || (taskMode === 1 && !onDock && !returning)) return true;
  return false;
}

/** Default thresholds for manual (non-scheduled) rain-pause sessions. */
const DEFAULT_RAIN_MM = 0.1;
const DEFAULT_RAIN_PROB = 50;
const DEFAULT_RAIN_HOURS = 0.5; // lookahead window while mowing
const MANUAL_SCHEDULE_ID = 'manual';

/**
 * When the session was paused, in ms. SQLite writes paused_at with
 * datetime('now'): UTC without a zone, which new Date() reads as local time.
 * In the container's Europe/Amsterdam a pause looked two hours old the moment
 * it began; west of UTC the timeouts came hours late.
 */
function pausedAtMs(session: RainSessionRow): number {
  const at = session.paused_at;
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? at : `${at.replace(' ', 'T')}Z`);
}

/**
 * Where the mower is by its last report: on its dock (charging or full, or
 * recharge_status 9: isDockedByValues), off it, or unknown (no report says).
 * Not freshPositionState: it counts recharge_status 1 as docked, and on the way
 * home the mower reports 1 (RETURNING_RECHARGE_STATUS in sensorData.ts).
 */
function dockState(sn: string): 'docked' | 'off' | 'unknown' {
  const sensors = deviceCache.get(sn);
  if (!sensors || !(sensors.has('battery_state') || sensors.has('recharge_status'))) return 'unknown';
  return isDockedByValues(sensors) ? 'docked' : 'off';
}

/**
 * The mower drives: it mows (again: the stock app's Continue reaches it without
 * the server knowing) or is still on its way. By the work state alone: a mower
 * that stopped keeps the recharge state it had (GH #156 ended on
 * "Work:FAILED Prev work:RECOVER_ERROR_STOP Recharge: ALIGN_PILE").
 */
function isUnderWay(sn: string): boolean {
  return /\bWork:(RUNNING|COVERING|NAVIGATING|BOUNDARY_COVERING|AVOIDING|MOVING|GO_PILE|BACK_CHARGER|DOCKING)\b/
    .test(deviceCache.get(sn)?.get('msg') ?? '');
}

/** The mower's last report, for a rain notification. */
function reportOf(sn: string): RainReport {
  const s = deviceCache.get(sn);
  return {
    msg: s?.get('msg') ?? '',
    errorStatus: s?.get('error_status') ?? '0',
    errorMsg: s?.get('error_msg') ?? '',
    batteryPower: parseInt(s?.get('battery_power') ?? '0', 10) || 0,
  };
}

/**
 * Did the go home of this rain pause reach the dock? RAIN_GO_HOME_TIMEOUT_MS
 * after it, a mower that stands still off its dock gives one dock_failed: the
 * reporter's ended in an error stop on the lawn, and nothing said so (GH #156).
 * Not while it drives (still on its way, or mowing again), and not when the
 * event detector reported a failed recharge since the go home already.
 */
function checkGoHome(session: RainSessionRow): void {
  if (goHomeSettled.has(session.session_id)) return;
  const sn = session.mower_sn;
  const where = dockState(sn);
  if (where === 'docked') {
    goHomeSettled.add(session.session_id);
    return;
  }
  const since = pausedAtMs(session);
  if (where === 'unknown' || Date.now() - since < RAIN_GO_HOME_TIMEOUT_MS || isUnderWay(sn)) return;
  goHomeSettled.add(session.session_id);
  if (getRecentEvents(sn, 50).some(e => e.type === 'dock_failed' && e.ts >= since)) return;
  console.log(`[RainMonitor] ${sn} did not reach its dock after the rain go home (session ${session.session_id})`);
  dispatchRainDockFailedEvent(sn, {
    ...reportOf(sn), sessionId: session.session_id, minutes: RAIN_GO_HOME_TIMEOUT_MS / 60_000,
  });
}

/** Check of maaier aan het laden is en batterij voldoende is */
function isChargedAndReady(mowerSn: string): boolean {
  const sensors = deviceCache.get(mowerSn);
  if (!sensors) return false;

  // Check batterijniveau
  const battery = parseInt(sensors.get('battery_power') ?? sensors.get('battery_capacity') ?? '0', 10);
  if (isNaN(battery) || battery < 80) return false;

  // Check of maaier niet aan het maaien of navigeren is
  const mowerStatus = sensors.get('mower_status');
  if (mowerStatus === 'startMowing' || mowerStatus === 'backingCharger' || mowerStatus === 'gotoCharging') {
    return false;
  }

  return true;
}

// ── Core logica ────────────────────────────────────────────────────

/**
 * Check actief maaende maaiers met rain_pause schedules.
 * Als regen verwacht wordt → stuur go_to_charge en maak een rain_session.
 */
async function checkActiveMowers(): Promise<void> {
  // Check EVERY mower that is currently online and mowing, regardless of whether
  // a rain_pause schedule exists. Scheduled sessions use the schedule's thresholds;
  // manual sessions use the DEFAULT_RAIN_* values below.
  //
  // Candidate set = union of (scheduled rain_pause mowers) and (all currently-
  // mowing online mowers as seen by deviceCache/isMowing).
  const scheduled = new Set(scheduleRepo.findDistinctMowersWithRainPause());
  const candidates = new Set<string>(scheduled);
  for (const sn of getAllCachedMowerSns()) candidates.add(sn);

  // Auto-clear ignore flags for any mower no longer mowing — flag is per-session,
  // so once the session ends the next start should pause normally again.
  for (const sn of Array.from(ignoreSessionSet)) {
    if (!isMowing(sn)) {
      ignoreSessionSet.delete(sn);
      console.log(`[RainMonitor] Rain-ignore auto-cleared for ${sn} (mowing ended)`);
    }
  }

  for (const mower_sn of candidates) {
    if (!isDeviceOnline(mower_sn)) continue;

    // User opted to ride out the rain for this session.
    if (ignoreSessionSet.has(mower_sn)) continue;

    // Check of er al een actieve rain session is voor deze maaier
    const existing = scheduleRepo.findRainSessionByMower(mower_sn, 'paused');
    if (existing) continue; // Al gepauzeerd, wordt afgehandeld door checkPausedSessions()

    // Check of maaier aan het maaien is
    if (!isMowing(mower_sn)) continue;

    // Skip als we al een go_to_charge hebben gestuurd (wacht op state change)
    if (pendingGoCharge.has(mower_sn)) continue;

    // Haal per-maaier settings (user-configurable via /api/dashboard/rain-settings).
    // Scheduled sessies hebben eigen thresholds op de schedule row; die hebben
    // voorrang. Voor manual sessies vallen we terug op de per-maaier settings.
    const schedule = scheduleRepo.findActiveRainSchedule(mower_sn);
    const settings = rainSettingsRepo.getEffective(mower_sn);
    if (!schedule && !settings.enabled) continue; // user disabled auto-pause

    // Haal GPS op voor weercheck
    const gps = getChargerGps(mower_sn);
    if (!gps) continue; // Geen GPS = geen weercheck mogelijk

    try {
      const forecast = await getWeatherForecast(gps.lat, gps.lng);
      const rainMm = schedule?.rain_threshold_mm ?? settings.thresholdMm;
      const rainProb = schedule?.rain_threshold_probability ?? settings.thresholdProbability;
      const rainHours = schedule ? DEFAULT_RAIN_HOURS : settings.lookaheadHours;

      const rainComing = shouldPauseForRain(forecast, rainMm, rainProb, rainHours);

      if (rainComing) {
        const kind = schedule ? `scheduled (${schedule.schedule_id})` : 'manual';
        console.log(`[RainMonitor] Rain expected for ${mower_sn} (${kind}) — sending go_to_charge`);
        pauseForRain(mower_sn, schedule);
      }
    } catch (err) {
      console.error(`[RainMonitor] Weather check failed for ${mower_sn}:`, err);
    }
  }
}

/** Return every SN we have cached sensor data for that looks like a mower. */
function getAllCachedMowerSns(): string[] {
  const out: string[] = [];
  for (const sn of deviceCache.keys()) {
    if (sn.startsWith('LFIN')) out.push(sn);
  }
  return out;
}

/** Stuur maaier naar huis en maak een rain_session */
function pauseForRain(mowerSn: string, schedule: ScheduleRow | null | undefined): void {
  // Pauzeer eerst de actieve coverage (net als de app-knop "Pause task &
  // return": pause_navigation → ~500ms → go_to_charge), dán naar de dock. Zo
  // landt de maaier in dezelfde resumebare Work:USER_STOP-staat als een
  // handmatige pauze, waardoor de Continue-knop + resume_navigation in de app
  // ook na een regen-pauze identiek werken. De auto-resume bij opgeklaarde
  // regen stuurt dezelfde resume_navigation, zie _resumeSession (#112).
  publishToDevice(mowerSn, { pause_navigation: { cmd_num: getNextCmdNum(mowerSn) } });
  setTimeout(() => publishToDevice(mowerSn, goToChargePayload(mowerSn)), 500);
  pendingGoCharge.add(mowerSn);

  // Maak rain session in DB. Voor manual sessions gebruiken we sentinel schedule_id.
  // Map/height/path_direction komen uit live sensor cache zodat we een sessie kunnen
  // herstarten (voor scheduled sessies worden deze uit de schedule gebruikt).
  const sensors = deviceCache.get(mowerSn);
  const sessionId = randomUUID();
  scheduleRepo.createRainSession(
    sessionId,
    schedule?.schedule_id ?? MANUAL_SCHEDULE_ID,
    mowerSn,
    schedule?.map_id ?? null,
    schedule?.map_name ?? null,
    schedule?.cutting_height ?? parseInt(sensors?.get('target_height') ?? '5', 10),
    schedule?.path_direction ?? parseInt(sensors?.get('path_direction') ?? '120', 10),
    schedule?.work_mode ?? 0,
    schedule?.task_mode ?? 0,
    schedule?.edge_offset ?? 0,
    schedule?.rain_threshold_mm ?? DEFAULT_RAIN_MM,
    schedule?.rain_threshold_probability ?? DEFAULT_RAIN_PROB,
    schedule?.rain_check_hours ?? DEFAULT_RAIN_HOURS,
  );

  // Emit event naar dashboard
  emitScheduleEvent('rain:paused', {
    sessionId,
    scheduleId: schedule?.schedule_id ?? MANUAL_SCHEDULE_ID,
    mowerSn,
    reason: 'rain_detected_during_mowing',
    manual: !schedule,
  });

  console.log(`[RainMonitor] Rain session ${sessionId} created for ${mowerSn} (${schedule ? 'scheduled' : 'manual'})`);

  // Clear pendingGoCharge na 2 minuten (genoeg tijd voor maaier om te reageren)
  setTimeout(() => pendingGoCharge.delete(mowerSn), 120_000);
}

/**
 * Check gepauzeerde rain_sessions — als regen voorbij is en maaier geladen,
 * herstart de maaisessie.
 */
async function checkPausedSessions(): Promise<void> {
  const sessions = scheduleRepo.findPausedRainSessions();

  for (const session of sessions) {
    // Check of maaier online is
    if (!isDeviceOnline(session.mower_sn)) {
      // Als maaier > 2 uur offline is, annuleer de sessie
      if (Date.now() - pausedAtMs(session) > 2 * 60 * 60 * 1000) {
        cancelSession(session, 'mower_offline_timeout');
      }
      continue;
    }

    checkGoHome(session);

    // Check of maaier geladen en klaar is
    if (!isChargedAndReady(session.mower_sn)) continue;

    // Haal GPS op voor weercheck
    const gps = getChargerGps(session.mower_sn);
    if (!gps) {
      // Geen GPS meer? Herstart gewoon (beter maaien dan wachten)
      _resumeSession(session);
      continue;
    }

    try {
      const forecast = await getWeatherForecast(gps.lat, gps.lng);
      const stillRaining = shouldPauseForRain(
        forecast,
        session.rain_threshold_mm,
        session.rain_threshold_probability,
        session.rain_check_hours,
      );

      if (!stillRaining) {
        console.log(`[RainMonitor] Rain is over for ${session.mower_sn}, resuming`);
        _resumeSession(session);
      }
    } catch (err) {
      console.error(`[RainMonitor] Weather check failed for paused session ${session.session_id}:`, err);
    }

    // Auto-cancel na 6 uur pauze (te lang gewacht, niet meer zinvol)
    if (Date.now() - pausedAtMs(session) > 6 * 60 * 60 * 1000) {
      cancelSession(session, 'timeout_6h');
    }
  }
}

/**
 * Hervat een gepauzeerde maaisessie (#112).
 *
 * pauseForRain parkeert de taak precies zoals de app-knop "Pause task &
 * return" (pause_navigation + go_to_charge → Work:USER_STOP), dus hervatten
 * is precies de app-knop "Continue": resume_navigation. De taak houdt zijn
 * eigen cutterhigh en gaat verder waar hij was. Een verse start_navigation
 * zou bij 0% beginnen en wordt door robot_decision bij work_status > 9
 * geweigerd ("Can't not start task in running status"); de oude start_run
 * bestaat in v6-mqtt_node niet eens.
 *
 * Staat er geen geparkeerde taak meer (herstart tijdens de pauze), dan is er
 * niets om te hervatten: sessie annuleren, niets naar de maaier.
 */
export function _resumeSession(session: RainSessionRow): void {
  const sensors = deviceCache.get(session.mower_sn);
  const parked = sensors?.get('work_status') === '10'
    || /Work:USER_STOP\b/.test(sensors?.get('msg') ?? '');
  if (!parked) {
    cancelSession(session, 'no_parked_task');
    // The owner expects the mow to go on and heard nothing (GH #156). Not when
    // it mows again: the owner took over.
    if (!isUnderWay(session.mower_sn)) {
      const where = dockState(session.mower_sn);
      dispatchRainResumeFailedEvent(session.mower_sn, {
        ...reportOf(session.mower_sn), sessionId: session.session_id,
        onDock: where === 'unknown' ? null : where === 'docked',
      });
    }
    return;
  }

  publishToDevice(session.mower_sn, {
    resume_navigation: { cmd_num: getNextCmdNum(session.mower_sn) },
  });

  // Update sessie in DB
  scheduleRepo.resumeRainSession(session.session_id);
  goHomeSettled.delete(session.session_id);

  // Emit event naar dashboard
  emitScheduleEvent('rain:resumed', {
    sessionId: session.session_id,
    scheduleId: session.schedule_id,
    mowerSn: session.mower_sn,
  });

  console.log(`[RainMonitor] Session ${session.session_id} resumed for ${session.mower_sn}`);
}

/** Annuleer een rain session */
function cancelSession(session: RainSessionRow, reason: string): void {
  scheduleRepo.cancelRainSession(session.session_id);
  goHomeSettled.delete(session.session_id);

  emitScheduleEvent('rain:cancelled', {
    sessionId: session.session_id,
    scheduleId: session.schedule_id,
    mowerSn: session.mower_sn,
    reason,
  });

  console.log(`[RainMonitor] Session ${session.session_id} cancelled: ${reason}`);
}

// ── Tick ───────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  try {
    await checkActiveMowers();
    await checkPausedSessions();
  } catch (err) {
    console.error('[RainMonitor] Tick error:', err);
  }
}

// ── Public API ─────────────────────────────────────────────────────

export function startRainMonitor(): void {
  if (intervalId) return;
  intervalId = setInterval(tick, CHECK_INTERVAL);
  console.log(`[RainMonitor] Started, checking every ${CHECK_INTERVAL / 1000}s`);
}

export function stopRainMonitor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[RainMonitor] Stopped');
  }
}

/** Haal actieve rain sessions op (voor dashboard display) */
export function getActiveRainSessions(mowerSn?: string): RainSessionRow[] {
  if (mowerSn) {
    return scheduleRepo.findPausedRainSessionsByMower(mowerSn);
  }
  return scheduleRepo.findPausedRainSessions();
}

/**
 * Notify de rain monitor dat een maaisessie handmatig gestopt is.
 * Als er een actieve rain session is, markeer die als completed.
 */
export function onMowingCompleted(mowerSn: string): void {
  const session = scheduleRepo.findRainSessionForCompletion(mowerSn);

  if (session) {
    scheduleRepo.completeRainSession(session.session_id);
    goHomeSettled.delete(session.session_id);

    emitScheduleEvent('rain:completed', {
      sessionId: session.session_id,
      mowerSn,
    });

    console.log(`[RainMonitor] Session ${session.session_id} completed (mowing ended)`);
  }
}
