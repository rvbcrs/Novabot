/**
 * LoRa pair comparison — pure, and deliberately in its own file.
 *
 * deviceHealth.ts also translates sensor values, which pulls in sensorData and
 * through it the socketHandler -> broker -> demoSimulator import cycle. Anything
 * that only wants to know whether the pair matches should not have to drag that
 * along; the connection diagnosis learned this the hard way.
 *
 * The rule itself is simple and absolute: address AND channel must be identical
 * on both sides, or the two never hear each other.
 */
import { equipmentRepo } from '../db/repositories/equipment.js';

export interface LoraSide {
  addr: number | null;
  channel: number | null;
}

export type LoraPairIssue =
  | 'missing-charger-cache'
  | 'missing-mower-cache'
  | 'addr-mismatch'
  | 'channel-mismatch'
  | 'unpaired';

export interface LoraPair {
  ok: boolean;
  issues: LoraPairIssue[];
  charger: LoraSide | null;
  mower: LoraSide | null;
}

function parseLora(row: { charger_address: string | null; charger_channel: string | null } | undefined): LoraSide | null {
  if (!row) return null;
  const addr = row.charger_address != null && row.charger_address !== '' ? parseInt(row.charger_address, 10) : null;
  const channel = row.charger_channel != null && row.charger_channel !== '' ? parseInt(row.charger_channel, 10) : null;
  if (addr == null && channel == null) return null;
  return {
    addr: isNaN(addr ?? NaN) ? null : addr,
    channel: isNaN(channel ?? NaN) ? null : channel,
  };
}

export function getLoraPair(sn: string): LoraPair | null {
  const isMower = sn.startsWith('LFIN');
  const isCharger = sn.startsWith('LFIC');
  const eq = equipmentRepo.findBySn(sn);
  const mower_sn = eq?.mower_sn ?? null;
  const charger_sn = eq?.charger_sn ?? null;

  const issues: LoraPairIssue[] = [];
  if (charger_sn || mower_sn) {
    const chargerLora = charger_sn ? parseLora(equipmentRepo.getLoraCache(charger_sn)) : null;
    const mowerLora = mower_sn ? parseLora(equipmentRepo.getLoraCache(mower_sn)) : null;

    if (charger_sn && !chargerLora) issues.push('missing-charger-cache');
    if (mower_sn && !mowerLora) issues.push('missing-mower-cache');
    if (chargerLora && mowerLora) {
      if (chargerLora.addr !== mowerLora.addr) issues.push('addr-mismatch');
      if (chargerLora.channel !== mowerLora.channel) issues.push('channel-mismatch');
    }
    return {
      ok: issues.length === 0 && !!chargerLora && !!mowerLora,
      issues,
      charger: chargerLora,
      mower: mowerLora,
    };
  }
  if (isMower || isCharger) {
    return { ok: false, issues: ['unpaired'], charger: null, mower: null };
  }
  return null;
}
