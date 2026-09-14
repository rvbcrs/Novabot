/**
 * Device health helpers — surface LoRa pair mismatch + mower-error
 * gateway state in one shape so admin UI + the OpenNova app can render
 * matching warnings without each re-deriving the same logic.
 *
 * Returned health is informational only — nothing on the server changes
 * behaviour based on it. The fields are intended for badge / banner
 * rendering on the consumers.
 */
import { equipmentRepo } from '../db/repositories/equipment.js';
import { translateValue, getMowerErrorState } from '../mqtt/sensorData.js';
import { getLoraPair, type LoraSide, type LoraPairIssue } from './loraPair.js';

export type { LoraSide, LoraPairIssue };

export interface DeviceHealth {
  /** SN that was queried (echoed for clients that batch-call). */
  sn: string;
  /** Paired counterpart SN, when this device is part of a bound equipment row. */
  pairedWith: string | null;
  /** Whether the device-type combination supports a LoRa pair check at all. */
  loraSupported: boolean;
  /** Non-null only when LoRa cache is available for at least one side. */
  loraPair: {
    ok: boolean;
    issues: LoraPairIssue[];
    charger: LoraSide | null;
    mower: LoraSide | null;
  } | null;
  /** Decoded mower_error reported by the charger via LoRa up_status_info. */
  mowerError: { code: number; label: string } | null;
}


function findPairedSn(sn: string): { mower_sn: string | null; charger_sn: string | null } {
  const eq = equipmentRepo.findBySn(sn);
  return {
    mower_sn: eq?.mower_sn ?? null,
    charger_sn: eq?.charger_sn ?? null,
  };
}

export function getDeviceHealth(sn: string): DeviceHealth {
  const isMower = sn.startsWith('LFIN');
  const isCharger = sn.startsWith('LFIC');
  const { mower_sn, charger_sn } = findPairedSn(sn);

  const counterpart = isMower ? charger_sn : isCharger ? mower_sn : null;

  const loraPair: DeviceHealth['loraPair'] = getLoraPair(sn);

  // mower_error — published by the charger inside up_status_info every ~1s.
  // Surface only after MOWER_ERROR_THRESHOLD consecutive identical non-zero
  // samples so transient code 2 ("Searching mower") blips during routine
  // LoRa handshakes don't trigger the warning banner. Counter is reset on
  // any `0` or value-change in sensorData.ts._updateMowerErrorCounter.
  const MOWER_ERROR_THRESHOLD = 50;
  let mowerError: DeviceHealth['mowerError'] = null;
  if (charger_sn) {
    const state = getMowerErrorState(charger_sn);
    if (state && state.count >= MOWER_ERROR_THRESHOLD) {
      const code = parseInt(state.value, 10);
      if (!isNaN(code)) {
        mowerError = { code, label: translateValue('mower_error', state.value) };
      }
    }
  }

  return {
    sn,
    pairedWith: counterpart,
    loraSupported: !!(charger_sn && mower_sn),
    loraPair,
    mowerError,
  };
}
