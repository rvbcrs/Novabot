/**
 * Single source of truth for "a newer mower firmware is available". One poll
 * (mount + foreground + every 12h, mirroring the app-update check) feeds three
 * passive surfaces: the Home banner, the Settings-tab dot and the OTA-row dot.
 *
 * PASSIVE only — never a modal — so it doesn't add to the Android app-update
 * popup the user already gets. The raw `available` drives the persistent
 * badges; `bannerVisible` (available AND not dismissed) drives the banner, so
 * dismissing the banner hides the nag while the badges keep it discoverable.
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useActiveMower } from '../hooks/useActiveMower';
import { ApiClient, type FirmwareAdvisory } from '../services/api';
import { getServerUrl } from '../services/auth';
import {
  checkMowerFirmwareUpdate,
  getDismissedFirmwareVersion,
  setDismissedFirmwareVersion,
  type MowerFirmwareUpdate,
} from '../services/firmwareUpdate';

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

interface FirmwareUpdateState {
  /** Raw availability — drives the persistent badges (tab icon + OTA row). */
  available: MowerFirmwareUpdate | null;
  /** The mower's custom build was withdrawn (manifest): update required,
   *  banner not dismissible. Null when fine or unknown. */
  advisory: FirmwareAdvisory | null;
  /** Available AND not dismissed for this version — drives the Home banner. */
  bannerVisible: boolean;
  /** Hide the banner for the current version (persisted). Badges stay on. */
  dismiss: () => void;
}

const FirmwareUpdateContext = createContext<FirmwareUpdateState>({
  available: null,
  advisory: null,
  bannerVisible: false,
  dismiss: () => {},
});

export function FirmwareUpdateProvider({ children }: { children: React.ReactNode }) {
  const { activeMower } = useActiveMower();
  const currentVersion =
    (activeMower?.sensors?.sw_version as string | undefined) ??
    (activeMower?.sensors?.mower_version as string | undefined) ??
    activeMower?.firmwareVersion ??
    null;

  const [available, setAvailable] = useState<MowerFirmwareUpdate | null>(null);
  const [advisory, setAdvisory] = useState<FirmwareAdvisory | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const activeSn = activeMower?.sn ?? null;

  // Hydrate the persisted dismissed version once.
  useEffect(() => {
    let cancelled = false;
    getDismissedFirmwareVersion().then((v) => {
      if (!cancelled) setDismissedVersion(v);
    });
    return () => { cancelled = true; };
  }, []);

  // Poll: on mount, on every foreground, every 12h, and whenever the active
  // mower's reported version changes (so it clears right after an OTA finishes).
  useEffect(() => {
    let cancelled = false;
    const versionStr = currentVersion ? String(currentVersion) : null;

    async function run() {
      try {
        const res = await checkMowerFirmwareUpdate(versionStr);
        if (!cancelled) setAvailable(res);
      } catch {
        // Network/server failures are silent — never crash the app.
      }
      try {
        const url = activeSn ? await getServerUrl() : null;
        const adv = url ? await new ApiClient(url).getFirmwareAdvisory(activeSn as string) : null;
        if (!cancelled) setAdvisory(adv?.required ? adv : null);
      } catch {
        // Older server without the endpoint: no advisory.
        if (!cancelled) setAdvisory(null);
      }
    }
    run();

    function onAppState(s: AppStateStatus) {
      if (s === 'active') run();
    }
    const sub = AppState.addEventListener('change', onAppState);
    const interval = setInterval(run, TWELVE_HOURS_MS);

    return () => {
      cancelled = true;
      sub.remove();
      clearInterval(interval);
    };
  }, [currentVersion, activeSn]);

  const dismiss = useCallback(() => {
    if (!available) return;
    setDismissedVersion(available.version);
    void setDismissedFirmwareVersion(available.version);
  }, [available]);

  // A required update ignores the dismissal: the banner stays until the
  // mower reports another version.
  const bannerVisible = !!advisory || (!!available && available.version !== dismissedVersion);

  return (
    <FirmwareUpdateContext.Provider value={{ available, advisory, bannerVisible, dismiss }}>
      {children}
    </FirmwareUpdateContext.Provider>
  );
}

export function useFirmwareUpdate(): FirmwareUpdateState {
  return useContext(FirmwareUpdateContext);
}
