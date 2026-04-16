/**
 * Schedule Runner — achtergrondproces dat maaischema's met rain_pause=1 beheert.
 *
 * Schema's met rain_pause worden NIET als timer_task naar de maaier gestuurd.
 * In plaats daarvan checkt deze runner periodiek of een starttijd net is bereikt,
 * controleert het weer via Open-Meteo, en stuurt start_run als het droog is.
 */

import { scheduleRepo, mapRepo, messageRepo } from '../db/repositories/index.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { publishToDevice } from '../mqtt/mapSync.js';
import { startMowing } from './mowingService.js';
import { getWeatherForecast, shouldPauseForRain } from './weatherService.js';
import { emitScheduleEvent } from '../dashboard/socketHandler.js';
import type { ScheduleRow } from '../db/repositories/schedules.js';

let intervalId: ReturnType<typeof setInterval> | null = null;
const CHECK_INTERVAL_MS = 30_000;
const TRIGGER_WINDOW_MS = 5 * 60_000; // 5 minuten window — ruim genoeg voor restarts

/** Haal charger GPS coördinaten op voor een maaier SN */
function getChargerGps(mowerSn: string): { lat: number; lng: number } | null {
  return mapRepo.getChargerGps(mowerSn);
}

function getScheduleOccurrence(row: ScheduleRow, now: Date): Date | null {
  const weekdays: number[] = JSON.parse(row.weekdays);
  const currentDay = now.getDay(); // 0=Sunday
  if (!weekdays.includes(currentDay)) return null;

  const [hourText = '0', minuteText = '0'] = row.start_time.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  const occurrence = new Date(now);
  occurrence.setHours(hour, minute, 0, 0);
  return occurrence;
}

function checkSchedules() {
  const now = new Date();

  // Haal ALLE enabled schedules op — de runner handelt alles af
  const rows = scheduleRepo.findEnabled();
  if (rows.length > 0) {
    const day = now.getDay();
    const time = `${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`;
    console.log(`[ScheduleRunner] Checking ${rows.length} schedule(s) at ${time} (day=${day})`);
  }

  for (const row of rows) {
    const scheduledAt = getScheduleOccurrence(row, now);
    if (!scheduledAt) {
      // Niet vandaag
      continue;
    }
    const sinceScheduledMs = now.getTime() - scheduledAt.getTime();
    if (sinceScheduledMs < 0 || sinceScheduledMs > TRIGGER_WINDOW_MS) {
      // Buiten trigger window
      continue;
    }

    // Voorkom dubbele trigger voor dezelfde geplande run.
    if (row.last_triggered_at) {
      const lastTriggered = new Date(row.last_triggered_at);
      if (!Number.isNaN(lastTriggered.getTime()) && lastTriggered.getTime() >= scheduledAt.getTime()) {
        continue;
      }
    }

    // Check of maaier online is
    if (!isDeviceOnline(row.mower_sn)) {
      console.log(`[ScheduleRunner] ${row.schedule_id}: maaier ${row.mower_sn} is offline, skip`);
      continue;
    }

    // Rain pause: check weer als ingeschakeld, anders direct starten
    if (row.rain_pause) {
      const gps = getChargerGps(row.mower_sn);
      if (!gps) {
        console.log(`[ScheduleRunner] ${row.schedule_id}: geen GPS coördinaten, start zonder weercheck`);
        triggerSchedule(row);
        continue;
      }
      checkWeatherAndTrigger(row, gps).catch(err => {
        console.error(`[ScheduleRunner] Weather check failed for ${row.schedule_id}:`, err);
        triggerSchedule(row);
      });
    } else {
      triggerSchedule(row);
    }
  }
}

async function checkWeatherAndTrigger(
  row: ScheduleRow,
  gps: { lat: number; lng: number },
) {
  const forecast = await getWeatherForecast(gps.lat, gps.lng);
  const shouldPause = shouldPauseForRain(
    forecast,
    row.rain_threshold_mm,
    row.rain_threshold_probability,
    row.rain_check_hours,
  );

  if (shouldPause) {
    console.log(`[ScheduleRunner] ${row.schedule_id}: regen verwacht, pauzeer`);
    emitScheduleEvent('weather:paused', {
      scheduleId: row.schedule_id,
      mowerSn: row.mower_sn,
      reason: 'rain',
    });
    // Update last_triggered_at zodat we niet elke seconde opnieuw checken
    scheduleRepo.updateLastTriggered(row.schedule_id);
    return;
  }

  console.log(`[ScheduleRunner] ${row.schedule_id}: weer OK, start maaier`);
  triggerSchedule(row);
}

function triggerSchedule(row: ScheduleRow) {
  // Bereken effectieve richting (met alternerende rotatie)
  let effectiveDirection = row.path_direction;
  if (row.alternate_direction === 1) {
    const count = messageRepo.countWorkRecordsBySchedule(row.schedule_id);
    effectiveDirection = (row.path_direction + count * (row.alternate_step ?? 90)) % 360;
  }

  // Start maaien via centrale mowingService
  const result = startMowing({
    sn: row.mower_sn,
    cuttingHeight: row.cutting_height ?? 5,
    pathDirection: effectiveDirection,
    area: 1,
  });
  console.log(`[ScheduleRunner] ${row.schedule_id}: ${result.ok ? 'started' : 'FAILED: ' + result.error} (height=${row.cutting_height}, dir=${effectiveDirection})`);

  // Update last_triggered_at
  scheduleRepo.updateLastTriggered(row.schedule_id);

  emitScheduleEvent('weather:started', {
    scheduleId: row.schedule_id,
    mowerSn: row.mower_sn,
    effectiveDirection,
  });
}

export function startScheduleRunner(): void {
  if (intervalId) return;
  checkSchedules();
  intervalId = setInterval(checkSchedules, CHECK_INTERVAL_MS);
  console.log(`[ScheduleRunner] Started, checking every ${CHECK_INTERVAL_MS / 1000}s`);
}

export function stopScheduleRunner(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[ScheduleRunner] Stopped');
  }
}
