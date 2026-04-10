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
import { scheduleRepo, mapRepo } from '../db/repositories/index.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { publishToDevice, goToChargePayload } from '../mqtt/mapSync.js';
import { deviceCache } from '../mqtt/sensorData.js';
import { getWeatherForecast, shouldPauseForRain } from './weatherService.js';
import { emitScheduleEvent } from '../dashboard/socketHandler.js';
import type { RainSessionRow, ScheduleRow } from '../db/repositories/schedules.js';

// ── State ──────────────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minuten

// Track welke maaiers al een go_to_charge hebben gekregen (voorkom dubbele commando's)
const pendingGoCharge = new Set<string>();

// ── Helpers ────────────────────────────────────────────────────────

/** Haal charger GPS coördinaten op voor een maaier SN */
function getChargerGps(mowerSn: string): { lat: number; lng: number } | null {
  return mapRepo.getChargerGps(mowerSn);
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

// ── Core logica ────────────────────────────────────────────────────

/**
 * Check actief maaende maaiers met rain_pause schedules.
 * Als regen verwacht wordt → stuur go_to_charge en maak een rain_session.
 */
async function checkActiveMowers(): Promise<void> {
  // Haal alle maaiers op die een rain_pause schedule hebben
  const mowerSns = scheduleRepo.findDistinctMowersWithRainPause();

  for (const mower_sn of mowerSns) {
    if (!isDeviceOnline(mower_sn)) continue;

    // Check of er al een actieve rain session is voor deze maaier
    const existing = scheduleRepo.findRainSessionByMower(mower_sn, 'paused');
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
      const schedule = scheduleRepo.findActiveRainSchedule(mower_sn);
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
function pauseForRain(mowerSn: string, schedule: ScheduleRow): void {
  // Stuur go_to_charge
  publishToDevice(mowerSn, goToChargePayload(mowerSn));
  pendingGoCharge.add(mowerSn);

  // Maak rain session in DB
  const sessionId = randomUUID();
  scheduleRepo.createRainSession(
    sessionId, schedule.schedule_id, mowerSn,
    schedule.map_id ?? null, schedule.map_name ?? null, schedule.cutting_height, schedule.path_direction,
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
  const sessions = scheduleRepo.findPausedRainSessions();

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
function resumeSession(session: RainSessionRow): void {
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
  scheduleRepo.resumeRainSession(session.session_id);

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

    emitScheduleEvent('rain:completed', {
      sessionId: session.session_id,
      mowerSn,
    });

    console.log(`[RainMonitor] Session ${session.session_id} completed (mowing ended)`);
  }
}
