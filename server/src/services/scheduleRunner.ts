/**
 * Schedule Runner — achtergrondproces dat maaischema's met rain_pause=1 beheert.
 *
 * Schema's met rain_pause worden NIET als timer_task naar de maaier gestuurd.
 * In plaats daarvan checkt deze runner elke 60s of het tijd is om te starten,
 * controleert het weer via Open-Meteo, en stuurt start_run als het droog is.
 */

import { scheduleRepo, mapRepo, messageRepo } from '../db/repositories/index.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { publishToDevice } from '../mqtt/mapSync.js';
import { getWeatherForecast, shouldPauseForRain } from './weatherService.js';
import { emitScheduleEvent } from '../dashboard/socketHandler.js';
import type { ScheduleRow } from '../db/repositories/schedules.js';

let intervalId: ReturnType<typeof setInterval> | null = null;

/** Haal charger GPS coördinaten op voor een maaier SN */
function getChargerGps(mowerSn: string): { lat: number; lng: number } | null {
  return mapRepo.getChargerGps(mowerSn);
}

function checkSchedules() {
  const now = new Date();
  const currentDay = now.getDay(); // 0=Sunday
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // Haal alle enabled rain_pause schedules op
  const rows = scheduleRepo.findEnabledWithRainPause();

  for (const row of rows) {
    const weekdays: number[] = JSON.parse(row.weekdays);
    if (!weekdays.includes(currentDay)) continue;

    // Check of het de juiste starttijd is (exact match op HH:MM)
    if (row.start_time !== currentTime) continue;

    // Voorkom dubbele trigger: check of al getriggerd in deze minuut
    if (row.last_triggered_at) {
      const lastTriggered = new Date(row.last_triggered_at);
      const diffMs = now.getTime() - lastTriggered.getTime();
      if (diffMs < 120_000) continue; // < 2 minuten geleden
    }

    // Check of maaier online is
    if (!isDeviceOnline(row.mower_sn)) {
      console.log(`[ScheduleRunner] ${row.schedule_id}: maaier ${row.mower_sn} is offline, skip`);
      continue;
    }

    // Haal GPS coördinaten op voor weercheck
    const gps = getChargerGps(row.mower_sn);
    if (!gps) {
      console.log(`[ScheduleRunner] ${row.schedule_id}: geen GPS coördinaten, start zonder weercheck`);
      triggerSchedule(row);
      continue;
    }

    // Async weercheck
    checkWeatherAndTrigger(row, gps).catch(err => {
      console.error(`[ScheduleRunner] Weather check failed for ${row.schedule_id}:`, err);
      // Bij weather API fout: start gewoon (beter maaien dan niet maaien)
      triggerSchedule(row);
    });
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

  // Stuur set_para_info
  publishToDevice(row.mower_sn, {
    set_para_info: {
      cutGrassHeight: row.cutting_height,
      defaultCuttingHeight: row.cutting_height,
      target_height: row.cutting_height,
      path_direction: effectiveDirection,
    },
  });

  // Stuur start_run (direct starten, niet als timer_task)
  publishToDevice(row.mower_sn, {
    start_run: {
      map_id: row.map_id ?? '',
      map_name: row.map_name ?? '',
      work_mode: row.work_mode,
      task_mode: row.task_mode,
      path_direction: effectiveDirection,
    },
  });

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
  intervalId = setInterval(checkSchedules, 60_000);
  console.log('[ScheduleRunner] Started, checking every 60s');
}

export function stopScheduleRunner(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[ScheduleRunner] Stopped');
  }
}
