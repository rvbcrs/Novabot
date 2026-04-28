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

  // NOTE: auto-switch was REMOVED on 2026-04-26 (user explicitly asked for
  // manual-only switching). The previous behaviour silently promoted an
  // online mower whenever the active one went briefly offline, which leaked
  // the OTHER mower's maps/trail/cover-path data into the active mower's
  // screens (observed: deleted-and-restarted mapping on .211 showed .238's
  // 2336-pt work polygon as a ghost overlay because the app had auto-flipped
  // SN during a network blip). Users with multiple mowers must now switch
  // manually via the device picker.

  // Return the user's *intent* (context value) for activeMowerSn. Falling back
  // to activeMower.sn would mask the picked SN when the chosen mower isn't in
  // the socket-tracked `devices` map (e.g. offline). That broke the
  // "Activate this set" button on HomeScreen — clicking did update the
  // context, but the returned activeMowerSn snapped back to mowers[0].sn,
  // so the comparator `set.mower.sn !== activeMowerSn` stayed true and the
  // button looked like a no-op.
  return {
    activeMower,
    mowers,
    activeMowerSn: activeMowerSn ?? activeMower?.sn ?? null,
    setActiveMowerSn,
    hydrated,
  };
}
