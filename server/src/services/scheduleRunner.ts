/**
 * Schedule Runner — achtergrondproces dat maaischema's met rain_pause=1 beheert.
 *
 * Schema's met rain_pause worden NIET als timer_task naar de maaier gestuurd.
 * In plaats daarvan checkt deze runner elke 60s of het tijd is om te starten,
 * controleert het weer via Open-Meteo, en stuurt start_run als het droog is.
 */

import { db } from '../db/database.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { publishToDevice } from '../mqtt/mapSync.js';
import { getWeatherForecast, shouldPauseForRain } from './weatherService.js';
import { emitScheduleEvent } from '../dashboard/socketHandler.js';

interface RainScheduleRow {
  schedule_id: string;
  mower_sn: string;
  start_time: string;
  end_time: string | null;
  weekdays: string;
  map_id: string | null;
  map_name: string | null;
  cutting_height: number;
  path_direction: number;
  work_mode: number;
  task_mode: number;
  alternate_direction: number;
  alternate_step: number;
  edge_offset: number;
  rain_threshold_mm: number;
  rain_threshold_probability: number;
  rain_check_hours: number;
  last_triggered_at: string | null;
}

let intervalId: ReturnType<typeof setInterval> | null = null;

/** Haal charger GPS coördinaten op voor een maaier SN */
function getChargerGps(mowerSn: string): { lat: number; lng: number } | null {
  // Probeer map_calibration (handmatig ingesteld)
  const cal = db.prepare(
    `SELECT charger_lat, charger_lng FROM map_calibration WHERE mower_sn = ?`
  ).get(mowerSn) as { charger_lat: number | null; charger_lng: number | null } | undefined;

  if (cal?.charger_lat && cal?.charger_lng) {
    return { lat: cal.charger_lat, lng: cal.charger_lng };
  }

  // Probeer charger GPS uit sensor cache (via equipment → charger_sn → device_registry)
  const eq = db.prepare(`SELECT charger_sn FROM equipment WHERE mower_sn = ?`).get(mowerSn) as { charger_sn: string | null } | undefined;
  if (!eq?.charger_sn) return null;

  // Geen directe sensor cache in DB — fallback: null
  return null;
}

function checkSchedules() {
  const now = new Date();
  const currentDay = now.getDay(); // 0=Sunday
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // Haal alle enabled rain_pause schedules op
  const rows = db.prepare(`
    SELECT * FROM dashboard_schedules
    WHERE enabled = 1 AND rain_pause = 1
  `).all() as RainScheduleRow[];

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
  row: RainScheduleRow,
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
    db.prepare(`UPDATE dashboard_schedules SET last_triggered_at = datetime('now') WHERE schedule_id = ?`)
      .run(row.schedule_id);
    return;
  }

  console.log(`[ScheduleRunner] ${row.schedule_id}: weer OK, start maaier`);
  triggerSchedule(row);
}

function triggerSchedule(row: RainScheduleRow) {
  // Bereken effectieve richting (met alternerende rotatie)
  let effectiveDirection = row.path_direction;
  if (row.alternate_direction === 1) {
    const triggerCount = db.prepare(
      `SELECT COUNT(*) as cnt FROM work_records WHERE schedule_id = ?`
    ).get(row.schedule_id) as { cnt: number } | undefined;
    const count = triggerCount?.cnt ?? 0;
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
  db.prepare(`UPDATE dashboard_schedules SET last_triggered_at = datetime('now') WHERE schedule_id = ?`)
    .run(row.schedule_id);

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
