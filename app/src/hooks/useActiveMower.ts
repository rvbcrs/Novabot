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
import { useEffect, useMemo, useRef } from 'react';
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

  // Auto-switch: als de actieve mower offline is én er een andere mower
  // online is, promoot de online mower tot actief. Voorkomt dat een user
  // met twee pairs vastzit op een offline pair terwijl het andere pair
  // wel bereikbaar is (zowel OpenNova als Novabot app profiteren, de
  // Novabot app filtert userEquipmentList op is_active serverside).
  // De autoSwitchedRef voorkomt dat dit direct terugklapt wanneer de
  // offline mower even online terug flapt — één keer per offline-episode.
  const autoSwitchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hydrated || mowers.length < 2) return;
    if (!activeMower || activeMower.online) {
      autoSwitchedRef.current = null;
      return;
    }
    if (autoSwitchedRef.current === activeMower.sn) return;
    const onlineAlternative = mowers.find((m) => m.online && m.sn !== activeMower.sn);
    if (!onlineAlternative) return;
    autoSwitchedRef.current = activeMower.sn;
    setActiveMowerSn(onlineAlternative.sn);
  }, [hydrated, activeMower, mowers, setActiveMowerSn]);

  return {
    activeMower,
    mowers,
    activeMowerSn: activeMower?.sn ?? null,
    setActiveMowerSn,
    hydrated,
  };
}
