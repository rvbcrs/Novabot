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
import { db } from '../db/database.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { publishToDevice } from '../mqtt/mapSync.js';
import { deviceCache } from '../mqtt/sensorData.js';
import { getWeatherForecast, shouldPauseForRain } from './weatherService.js';
import { emitScheduleEvent } from '../dashboard/socketHandler.js';

// ── Types ──────────────────────────────────────────────────────────

interface RainSession {
  session_id: string;
  schedule_id: string;
  mower_sn: string;
  state: 'paused' | 'resuming' | 'completed' | 'cancelled';
  map_id: string | null;
  map_name: string | null;
  cutting_height: number;
  path_direction: number;
  work_mode: number;
  task_mode: number;
  edge_offset: number;
  rain_threshold_mm: number;
  rain_threshold_probability: number;
  rain_check_hours: number;
  paused_at: string;
  resumed_at: string | null;
}

interface RainScheduleRow {
  schedule_id: string;
  mower_sn: string;
  map_id: string | null;
  map_name: string | null;
  cutting_height: number;
  path_direction: number;
  work_mode: number;
  task_mode: number;
  edge_offset: number;
  rain_threshold_mm: number;
  rain_threshold_probability: number;
  rain_check_hours: number;
  alternate_direction: number;
  alternate_step: number;
}

// ── State ──────────────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minuten

// Track welke maaiers al een go_to_charge hebben gekregen (voorkom dubbele commando's)
const pendingGoCharge = new Set<string>();

// ── Helpers ────────────────────────────────────────────────────────

/** Haal charger GPS coördinaten op voor een maaier SN */
function getChargerGps(mowerSn: string): { lat: number; lng: number } | null {
  const cal = db.prepare(
    `SELECT charger_lat, charger_lng FROM map_calibration WHERE mower_sn = ?`
  ).get(mowerSn) as { charger_lat: number | null; charger_lng: number | null } | undefined;

  if (cal?.charger_lat && cal?.charger_lng) {
    return { lat: cal.charger_lat, lng: cal.charger_lng };
  }
  return null;
}

/** Check of maaier momenteel aan het maaien is */
function isMowing(mowerSn: string): boolean {
  const sensors = deviceCache.get(mowerSn);
  if (!sensors) return false;

  // Check mower_status (via charger LoRa) — "startMowing" = actief maaien
  const mowerStatus = sensors.get('mower_status');
  if (mowerStatus === 'startMowing') return true;

  // Check work_status (directe maaier sensor) — diverse waarden die actief maaien aanduiden
  const workStatus = sensors.get('work_status');
  if (workStatus === '1') return true; // COVER state

  return false;
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

/** Haal de actieve rain_pause schedule op voor een maaier */
function getActiveRainSchedule(mowerSn: string): RainScheduleRow | null {
  return db.prepare(`
    SELECT * FROM dashboard_schedules
    WHERE mower_sn = ? AND enabled = 1 AND rain_pause = 1
    ORDER BY last_triggered_at DESC LIMIT 1
  `).get(mowerSn) as RainScheduleRow | null;
}

// ── Core logica ────────────────────────────────────────────────────

/**
 * Check actief maaende maaiers met rain_pause schedules.
 * Als regen verwacht wordt → stuur go_to_charge en maak een rain_session.
 */
async function checkActiveMowers(): Promise<void> {
  // Haal alle maaiers op die een rain_pause schedule hebben
  const schedules = db.prepare(`
    SELECT DISTINCT mower_sn FROM dashboard_schedules
    WHERE enabled = 1 AND rain_pause = 1
  `).all() as Array<{ mower_sn: string }>;

  for (const { mower_sn } of schedules) {
    if (!isDeviceOnline(mower_sn)) continue;

    // Check of er al een actieve rain session is voor deze maaier
    const existing = db.prepare(
      `SELECT session_id FROM rain_sessions WHERE mower_sn = ? AND state = 'paused'`
    ).get(mower_sn) as { session_id: string } | undefined;
    if (existing) continue; // Al gepauzeerd, wordt afgehandeld door checkPausedSessions()

    // Check of maaier aan het maaien is
    if (!isMowing(mower_sn)) continue;

    // Skip als we al een go_to_charge hebben gestuurd (wacht op state change)
    if (pendingGoCharge.has(mower_sn)) continue;

    // Haal GPS op voor weercheck
    const gps = getChargerGps(mower_sn);
    if (!gps) continue; // Geen GPS = geen weercheck mogelijk

    try {
      const forecast = await getWeatherForecast(gps.lat, gps.lng);
      const schedule = getActiveRainSchedule(mower_sn);
      if (!schedule) continue;

      const rainComing = shouldPauseForRain(
        forecast,
        schedule.rain_threshold_mm,
        schedule.rain_threshold_probability,
        // Kijk 30 minuten vooruit voor actieve sessies (korter dan bij start)
        0.5,
      );

      if (rainComing) {
        console.log(`[RainMonitor] Regen verwacht voor ${mower_sn}, stuur go_to_charge`);
        pauseForRain(mower_sn, schedule);
      }
    } catch (err) {
      console.error(`[RainMonitor] Weather check failed for ${mower_sn}:`, err);
    }
  }
}

/** Stuur maaier naar huis en maak een rain_session */
function pauseForRain(mowerSn: string, schedule: RainScheduleRow): void {
  // Stuur go_to_charge
  publishToDevice(mowerSn, { go_to_charge: {} });
  pendingGoCharge.add(mowerSn);

  // Maak rain session in DB
  const sessionId = randomUUID();
  db.prepare(`
    INSERT INTO rain_sessions (
      session_id, schedule_id, mower_sn, state,
      map_id, map_name, cutting_height, path_direction,
      work_mode, task_mode, edge_offset,
      rain_threshold_mm, rain_threshold_probability, rain_check_hours
    ) VALUES (?, ?, ?, 'paused', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, schedule.schedule_id, mowerSn,
    schedule.map_id, schedule.map_name, schedule.cutting_height, schedule.path_direction,
    schedule.work_mode, schedule.task_mode, schedule.edge_offset,
    schedule.rain_threshold_mm, schedule.rain_threshold_probability, schedule.rain_check_hours,
  );

  // Emit event naar dashboard
  emitScheduleEvent('rain:paused', {
    sessionId,
    scheduleId: schedule.schedule_id,
    mowerSn,
    reason: 'rain_detected_during_mowing',
  });

  console.log(`[RainMonitor] Rain session ${sessionId} created for ${mowerSn}`);

  // Clear pendingGoCharge na 2 minuten (genoeg tijd voor maaier om te reageren)
  setTimeout(() => pendingGoCharge.delete(mowerSn), 120_000);
}

/**
 * Check gepauzeerde rain_sessions — als regen voorbij is en maaier geladen,
 * herstart de maaisessie.
 */
async function checkPausedSessions(): Promise<void> {
  const sessions = db.prepare(
    `SELECT * FROM rain_sessions WHERE state = 'paused'`
  ).all() as RainSession[];

  for (const session of sessions) {
    // Check of maaier online is
    if (!isDeviceOnline(session.mower_sn)) {
      // Als maaier > 2 uur offline is, annuleer de sessie
      const pausedAt = new Date(session.paused_at).getTime();
      if (Date.now() - pausedAt > 2 * 60 * 60 * 1000) {
        cancelSession(session, 'mower_offline_timeout');
      }
      continue;
    }

    // Check of maaier geladen en klaar is
    if (!isChargedAndReady(session.mower_sn)) continue;

    // Haal GPS op voor weercheck
    const gps = getChargerGps(session.mower_sn);
    if (!gps) {
      // Geen GPS meer? Herstart gewoon (beter maaien dan wachten)
      resumeSession(session);
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
        console.log(`[RainMonitor] Regen voorbij voor ${session.mower_sn}, herstart`);
        resumeSession(session);
      }
    } catch (err) {
      console.error(`[RainMonitor] Weather check failed for paused session ${session.session_id}:`, err);
    }

    // Auto-cancel na 6 uur pauze (te lang gewacht, niet meer zinvol)
    const pausedAt = new Date(session.paused_at).getTime();
    if (Date.now() - pausedAt > 6 * 60 * 60 * 1000) {
      cancelSession(session, 'timeout_6h');
    }
  }
}

/** Herstart een gepauzeerde maaisessie */
function resumeSession(session: RainSession): void {
  // Stuur set_para_info met opgeslagen parameters
  publishToDevice(session.mower_sn, {
    set_para_info: {
      cutGrassHeight: session.cutting_height,
      defaultCuttingHeight: session.cutting_height,
      target_height: session.cutting_height,
      path_direction: session.path_direction,
    },
  });

  // Stuur start_run
  publishToDevice(session.mower_sn, {
    start_run: {
      map_id: session.map_id ?? '',
      map_name: session.map_name ?? '',
      work_mode: session.work_mode,
      task_mode: session.task_mode,
      path_direction: session.path_direction,
    },
  });

  // Update sessie in DB
  db.prepare(`
    UPDATE rain_sessions SET state = 'resumed', resumed_at = datetime('now')
    WHERE session_id = ?
  `).run(session.session_id);

  // Emit event naar dashboard
  emitScheduleEvent('rain:resumed', {
    sessionId: session.session_id,
    scheduleId: session.schedule_id,
    mowerSn: session.mower_sn,
  });

  console.log(`[RainMonitor] Session ${session.session_id} resumed for ${session.mower_sn}`);
}

/** Annuleer een rain session */
function cancelSession(session: RainSession, reason: string): void {
  db.prepare(`
    UPDATE rain_sessions SET state = 'cancelled', completed_at = datetime('now')
    WHERE session_id = ?
  `).run(session.session_id);

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
export function getActiveRainSessions(mowerSn?: string): RainSession[] {
  if (mowerSn) {
    return db.prepare(
      `SELECT * FROM rain_sessions WHERE mower_sn = ? AND state = 'paused' ORDER BY paused_at DESC`
    ).all(mowerSn) as RainSession[];
  }
  return db.prepare(
    `SELECT * FROM rain_sessions WHERE state = 'paused' ORDER BY paused_at DESC`
  ).all() as RainSession[];
}

/**
 * Notify de rain monitor dat een maaisessie handmatig gestopt is.
 * Als er een actieve rain session is, markeer die als completed.
 */
export function onMowingCompleted(mowerSn: string): void {
  const session = db.prepare(
    `SELECT * FROM rain_sessions WHERE mower_sn = ? AND state IN ('paused', 'resuming') ORDER BY paused_at DESC LIMIT 1`
  ).get(mowerSn) as RainSession | undefined;

  if (session) {
    db.prepare(`
      UPDATE rain_sessions SET state = 'completed', completed_at = datetime('now')
      WHERE session_id = ?
    `).run(session.session_id);

    emitScheduleEvent('rain:completed', {
      sessionId: session.session_id,
      mowerSn,
    });

    console.log(`[RainMonitor] Session ${session.session_id} completed (mowing ended)`);
  }
}
