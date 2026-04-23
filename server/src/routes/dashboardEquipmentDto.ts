/**
 * OpenNova-side equipment DTO. Started as a verbatim copy of the cloud-api
 * serializer (`src/cloud-api/serializers/equipmentDto.ts`) on 2026-04-23 so
 * the two can diverge safely. Dashboard/admin changes are scoped to this
 * file — do NOT import from `cloud-api/**` here.
 *
 * NOTE: no Zod schema here — dashboard doesn't need contract-shape
 * guarantees. If you need them, add them without importing from cloud-api.
 *
 * Behavioural invariants copied verbatim from the cloud-api serializer:
 *   - chargerAddress: charger → 718 default, mower → always null
 *   - chargerChannel: charger → 16 default,  mower → always null
 *   - userId: always 0 in the DTO (call sites override where needed)
 *   - sysVersion: charger → charger_version, mower → mower_version
 *   - account: charger → 'li9hep19', mower → null
 *   - password: charger → 'jzd4wac6', mower → null
 */
import type { EquipmentRow } from '../db/repositories/equipment.js';

// MQTT credentials die de cloud teruggeeft — charger gebruikt deze om te
// verbinden met de broker. Gekopieerd uit `nova-user/equipment.ts` via de
// cloud-api serializer.
const MQTT_ACCOUNT = 'li9hep19';
const MQTT_PASSWORD = 'jzd4wac6';

function snToEquipmentType(sn: string): string {
  // Eerste 5 tekens van SN = equipmentType (bijv. "LFIC1", "LFIN2")
  return sn.slice(0, 5);
}

function snToDeviceType(sn: string): 'charger' | 'mower' {
  // LFIC = charger, LFIN = mower
  return sn.startsWith('LFIC') ? 'charger' : 'mower';
}

/**
 * Plain-TS shape for the dashboard/admin DTO. Kept in sync manually with
 * `CloudEquipmentDto` at the moment of the copy (2026-04-23). Divergence is
 * allowed from here on — dashboard needs may drift from cloud-api needs.
 */
export interface DashboardEquipmentDto {
  equipmentId:       number;
  email:             string;
  deviceType:        'charger' | 'mower';
  sn:                string;
  equipmentCode:     string;
  equipmentName:     string;
  equipmentNickName: string;
  equipmentType:     string;
  userId:            number;
  sysVersion:        string;
  period:            string;
  status:            number;
  activationTime:    string;
  importTime:        string;
  batteryState:      null;
  macAddress:        string | null;
  chargerAddress:    number | null;
  chargerChannel:    number | null;
  account:           string | null;
  password:          string | null;
}

/**
 * Build the dashboard/admin equipment DTO for one row. Logic is 1:1 with the
 * cloud-api `rowToCloudDto` at the time of the copy. NO spread operators —
 * explicit fields — so drift is trivial to spot in diffs.
 */
export function rowToDashboardDto(r: EquipmentRow, email: string): DashboardEquipmentDto {
  // mower_sn is altijd de primaire key (ook bij charger-only binding waar
  // charger SN in mower_sn staat)
  const sn = r.mower_sn;
  const deviceType = snToDeviceType(sn);
  const isCharger = deviceType === 'charger';
  // Cloud retourneert mower firmware voor mowers (v6.0.0/v5.7.1), charger
  // firmware voor chargers (v0.3.6)
  const sysVersion = isCharger
    ? (r.charger_version ?? 'v0.3.6')
    : (r.mower_version ?? 'v5.7.1');

  return {
    equipmentId:       r.id ?? 1,
    email:             email,
    deviceType:        deviceType,
    sn:                sn,
    equipmentCode:     sn,
    equipmentName:     sn,
    equipmentNickName: r.equipment_nick_name ?? '',
    equipmentType:     snToEquipmentType(sn),
    userId:            0,
    sysVersion:        sysVersion,
    period:            isCharger ? '2029-02-22 00:00:00' : '2026-11-16 00:00:00',
    status:            1,
    activationTime:    r.created_at ?? new Date().toISOString().replace('T', ' ').slice(0, 19),
    importTime:        r.created_at ?? new Date().toISOString().replace('T', ' ').slice(0, 19),
    batteryState:      null,
    macAddress:        r.mac_address ?? null,
    chargerAddress:    isCharger ? (r.charger_address ? Number(r.charger_address) : 718) : null,
    chargerChannel:    isCharger ? (r.charger_channel ? Number(r.charger_channel) : 16) : null,
    account:           isCharger ? MQTT_ACCOUNT : null,
    password:          isCharger ? MQTT_PASSWORD : null,
  };
}
