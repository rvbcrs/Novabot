/**
 * Equipment DTO serializer — the heart of the cloud-api freeze.
 *
 * Every response that represents a single equipment row (userEquipmentList,
 * getEquipmentBySN, …) goes through this serializer. Fields are enumerated
 * explicitly both in the Zod schema AND in the return object literal — a new
 * DB column will NOT appear in the wire response unless the developer
 * deliberately adds it here.
 *
 * NOTE: Copied from `src/routes/nova-user/equipment.ts` on 2026-04-23. Logic
 * is identical — same defaults, same conditionals, same sentinels. The
 * existing implementation in `nova-user/equipment.ts` remains in place until
 * Task 9 switches the route imports over.
 *
 * CLAUDE.md invariants preserved verbatim:
 *   - chargerAddress: charger → 718 default, mower → always null
 *   - chargerChannel: charger → 16 default, mower → always null
 *   - userId: 0 when user_id = NULL in DB (→ app does BLE provisioning)
 *   - sysVersion: charger → charger_version, mower → mower_version
 *   - account: charger → 'li9hep19', mower → null
 *   - password: charger → 'jzd4wac6', mower → null
 */
import { z } from 'zod';
// Use the shared `EquipmentRow` from `types/index.ts` — this is the shape the
// original local `rowToCloudDto` in `nova-user/equipment.ts` accepted before
// the Task 9 move. The `db/repositories/equipment.ts` interface is stricter
// (adds `mower_ip`, `user_id: string | null`) and would reject callers that
// still use the `types/index.ts` shape. Keeping the loose `types/index.ts`
// import preserves behaviour 1:1.
import type { EquipmentRow } from '../../types/index.js';

// MQTT credentials die de cloud teruggeeft — charger gebruikt deze om te
// verbinden met de broker. Gekopieerd uit `nova-user/equipment.ts`.
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
 * Frozen schema for the equipment DTO. Every field returned by
 * `rowToCloudDto` must appear here, and `tsc --noEmit` will catch any drift
 * between the schema and the function's return literal.
 */
export const cloudEquipmentDtoSchema = z.object({
  equipmentId:       z.number(),
  email:             z.string(),
  deviceType:        z.enum(['charger', 'mower']),
  sn:                z.string(),
  equipmentCode:     z.string(),
  equipmentName:     z.string(),
  equipmentNickName: z.string(),
  equipmentType:     z.string(),
  userId:            z.number(),
  sysVersion:        z.string(),
  period:            z.string(),
  status:            z.number(),
  activationTime:    z.string(),
  importTime:        z.string(),
  batteryState:      z.null(),
  macAddress:        z.string().nullable(),
  chargerAddress:    z.number().nullable(),
  chargerChannel:    z.number().nullable(),
  account:           z.string().nullable(),
  password:          z.string().nullable(),
});

export type CloudEquipmentDto = z.infer<typeof cloudEquipmentDtoSchema>;

/**
 * Build the cloud-compatible DTO for one equipment row. Mirrors the legacy
 * implementation in `nova-user/equipment.ts` 1:1 — behaviour must NOT change
 * until a CHANGELOG entry says otherwise.
 */
export function rowToCloudDto(r: EquipmentRow, email: string): CloudEquipmentDto {
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
