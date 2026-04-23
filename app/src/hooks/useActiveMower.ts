/**
 * useActiveMower — single entry point for every screen that needs to act on
 * "the mower the user is currently looking at". Replaces the widespread
 * pattern `[...devices.values()].find(d => d.deviceType === 'mower')`, which
 * silently picked whichever mower happened to come first.
 *
 * Contract:
 *   - `activeMower` is the DeviceState for the selected SN, or the first
 *     mower in the device list if nothing is selected, or null when no
 *     mower is bound at all.
 *   - `mowers` is the full, stable-ordered list of mowers (sorted by SN
 *     so the picker UI does not reshuffle on unrelated socket updates).
 *   - `setActiveMowerSn(sn)` writes through to SecureStore.
 */
import { useMemo } from 'react';
import { useMowerState } from './useMowerState';
import { useActiveMowerContext } from '../context/ActiveMowerContext';
import type { DeviceState } from '../types';

interface UseActiveMowerResult {
  activeMower: DeviceState | null;
  mowers: DeviceState[];
  activeMowerSn: string | null;
  setActiveMowerSn: (sn: string | null) => void;
  hydrated: boolean;
}

export function useActiveMower(): UseActiveMowerResult {
  const { devices } = useMowerState();
  const { activeMowerSn, setActiveMowerSn, hydrated } = useActiveMowerContext();

  const mowers = useMemo(
    () =>
      [...devices.values()]
        .filter((d) => d.deviceType === 'mower')
        .sort((a, b) => a.sn.localeCompare(b.sn)),
    [devices],
  );

  const activeMower = useMemo<DeviceState | null>(() => {
    if (activeMowerSn) {
      const stored = devices.get(activeMowerSn);
      if (stored && stored.deviceType === 'mower') return stored;
    }
    return mowers[0] ?? null;
  }, [devices, activeMowerSn, mowers]);

  return {
    activeMower,
    mowers,
    activeMowerSn: activeMower?.sn ?? null,
    setActiveMowerSn,
    hydrated,
  };
}
