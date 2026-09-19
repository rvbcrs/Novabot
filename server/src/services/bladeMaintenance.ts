/**
 * Mes-onderhoud: maai-uren sinds de laatste meswissel, vergeleken met een
 * per-maaier interval. Bron is work_records (work_time in minuten); zonder
 * geregistreerde wissel telt alles vanaf het eerste record.
 *
 * Waarom niet de firmware-teller `mow_blade_work_time` (sensorData.ts,
 * SensorGrid "Blade time")? Die staat wel in de sensor-definities, maar
 * v6.0.2-custom-45 stuurt hem niet mee: op 2026-09-19 ontbreekt het veld in de
 * live snapshot van LFIN1231000211 én LFIN2230700238 (`working_time` is
 * software-uptime in minuten, geen mesteller). Rapporteert een latere
 * firmware hem wel, dan is dat de betere bron.
 */
import { db } from '../db/database.js';
import { equipmentRepo, messageRepo } from '../db/repositories/index.js';

// ponytail: 60 h is een generieke robotmaaier-vuistregel, geen Novabot-spec;
// de gebruiker stelt het interval zelf bij.
const DEFAULT_INTERVAL_HOURS = 60;

interface Row {
  mower_sn: string;
  blade_replaced_at: string | null;
  blade_interval_hours: number;
  blade_reminded_at: string | null;
}

const getRow = db.prepare('SELECT * FROM mower_maintenance WHERE mower_sn = ?');
const upsert = db.prepare(`
  INSERT INTO mower_maintenance (mower_sn, blade_replaced_at, blade_interval_hours, blade_reminded_at, updated_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(mower_sn) DO UPDATE SET
    blade_replaced_at = excluded.blade_replaced_at,
    blade_interval_hours = excluded.blade_interval_hours,
    blade_reminded_at = excluded.blade_reminded_at,
    updated_at = datetime('now')
`);

/** work_record_date-formaat ('YYYY-MM-DD HH:MM:SS', UTC). */
export function toRecordDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function equipmentIdFor(sn: string): string {
  return equipmentRepo.findByMowerSn(sn)?.equipment_id ?? sn;
}

export interface BladeStatus {
  replacedAt: string | null;
  intervalHours: number;
  hoursSince: number;
  due: boolean;
}

export function getBladeStatus(sn: string): BladeStatus {
  const row = (getRow.get(sn) as Row | undefined) ?? null;
  const intervalHours = row?.blade_interval_hours ?? DEFAULT_INTERVAL_HOURS;
  const since = row?.blade_replaced_at ? toRecordDate(new Date(row.blade_replaced_at)) : '';
  const { minutes } = messageRepo.sumWorkByEquipmentIdSince(equipmentIdFor(sn), since);
  const hoursSince = minutes / 60;
  return { replacedAt: row?.blade_replaced_at ?? null, intervalHours, hoursSince, due: hoursSince >= intervalHours };
}

export function setBladeMaintenance(sn: string, update: { replaced?: boolean; intervalHours?: number }): BladeStatus {
  const row = (getRow.get(sn) as Row | undefined) ?? null;
  const replacedAt = update.replaced ? new Date().toISOString() : row?.blade_replaced_at ?? null;
  const interval = Math.max(1, Math.min(1000, update.intervalHours ?? row?.blade_interval_hours ?? DEFAULT_INTERVAL_HOURS));
  // Nieuwe wissel of nieuw interval: de herinnering mag opnieuw vuren.
  upsert.run(sn, replacedAt, interval, null);
  return getBladeStatus(sn);
}

/** Na elke afgeronde maaibeurt: herinner één keer zodra het interval is bereikt.
 *  De notificatie-keten wordt lui geladen (die trekt broker/socket mee). */
export async function checkBladeReminder(sn: string): Promise<void> {
  const row = (getRow.get(sn) as Row | undefined) ?? null;
  if (row?.blade_reminded_at) return;
  const st = getBladeStatus(sn);
  if (!st.due) return;
  upsert.run(sn, row?.blade_replaced_at ?? null, st.intervalHours, new Date().toISOString());
  const { dispatchBladeMaintenanceEvent } = await import('../notifications/eventDetector.js');
  dispatchBladeMaintenanceEvent(sn, st.hoursSince, st.intervalHours);
}
