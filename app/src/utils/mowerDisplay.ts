/**
 * Single source of truth for how a mower is rendered in text. Falls back to
 * the full SN (e.g. "LFIN1231000211") when no nickname is set — matches the
 * spec decision to keep the SN recognisable without truncation.
 */
import type { DeviceState } from '../types';

export function mowerDisplayName(mower: Pick<DeviceState, 'sn' | 'nickname'>): string {
  return (mower.nickname && mower.nickname.trim()) || mower.sn;
}
