import { equipmentRepo } from '../db/repositories/index.js';

export const MOWER_FILE_WRITE_UNSUPPORTED_CODE = 'MOWER_FILE_WRITE_UNSUPPORTED';
export const MOWER_FILE_WRITE_UNSUPPORTED_MESSAGE =
  'Mower file restore requires OpenNova/custom firmware. Stock firmware does not support write_map_files; use server-copy import only unless the same maps already exist on the mower.';

export interface MowerFileCapability {
  mowerFileApplySupported: boolean;
  isOpenNova: boolean;
  mowerVersion: string | null;
  reason: string | null;
}

/** Test-knop: `SIMULATE_STOCK_FIRMWARE=LFIN...,LFIN...` laat de server deze
 *  maaiers als stock behandelen (gate actief) en hun gerapporteerde versie
 *  vervangen, zodat ook de UI-gates in dashboard en app aangaan. Alleen voor
 *  het testen van de stock-ervaring op een custom-firmware maaier. */
export const SIMULATED_STOCK_VERSION = '5.7.1-simulated-stock';
export function isSimulatedStock(sn: string): boolean {
  const raw = process.env.SIMULATE_STOCK_FIRMWARE ?? '';
  if (!raw) return false;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).includes(sn);
}

export function getMowerFileCapability(sn: string, fallbackVersion?: string | null): MowerFileCapability {
  if (isSimulatedStock(sn)) {
    return {
      mowerFileApplySupported: false,
      isOpenNova: false,
      mowerVersion: SIMULATED_STOCK_VERSION,
      reason: 'simulated stock firmware (SIMULATE_STOCK_FIRMWARE)',
    };
  }
  const row = equipmentRepo.findBySn(sn) as ({ mower_version?: string | null; is_opennova?: unknown } | undefined);
  const firmware = row?.mower_version ?? fallbackVersion ?? null;
  const fwLower = String(firmware ?? '').toLowerCase();
  const flag = row?.is_opennova;
  const isOpenNova = flag === true
    || flag === 1
    || flag === '1'
    || fwLower.includes('custom')
    || fwLower.includes('opennova');

  return {
    mowerFileApplySupported: isOpenNova,
    isOpenNova,
    mowerVersion: firmware,
    reason: isOpenNova ? null : MOWER_FILE_WRITE_UNSUPPORTED_MESSAGE,
  };
}

export function supportsMowerFileWrites(sn: string, fallbackVersion?: string | null): boolean {
  return getMowerFileCapability(sn, fallbackVersion).mowerFileApplySupported;
}

/** Live-versie uit de sensor-cache als fallback op de equipment-rij: een maaier
 *  die net custom firmware kreeg heeft niet altijd al een bijgewerkte
 *  mower_version in de DB, maar rapporteert wel zijn sw_version via MQTT. */
export function isOpenNovaMower(sn: string, cache?: Map<string, string>): boolean {
  const live = cache?.get('sw_version') ?? cache?.get('version') ?? cache?.get('mower_version') ?? null;
  return getMowerFileCapability(sn, live).isOpenNova;
}

export const UNSUPPORTED_FIRMWARE_REASON = 'unsupported_firmware';
export const UNSUPPORTED_FIRMWARE_MSG_KEY = 'requiresOpenNovaFirmware';
