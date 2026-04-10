/**
 * Signal History Repository — signal_history query operations.
 */
import { db } from '../database.js';

export interface SignalHistoryRow {
  ts: string;
  battery: number | null;
  wifi_rssi: number | null;
  rtk_sat: number | null;
  loc_quality: number | null;
  cpu_temp: number | null;
}

export class SignalHistoryRepository {
  private _findBySnWithinHours = db.prepare(`
    SELECT ts, battery, wifi_rssi, rtk_sat, loc_quality, cpu_temp
    FROM signal_history
    WHERE sn = ? AND ts >= datetime('now', ? || ' hours')
    ORDER BY ts ASC
  `);

  findBySnWithinHours(sn: string, hours: number): SignalHistoryRow[] {
    return this._findBySnWithinHours.all(sn, String(-hours)) as SignalHistoryRow[];
  }
}

export const signalHistoryRepo = new SignalHistoryRepository();
