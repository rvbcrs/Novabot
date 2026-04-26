/**
 * ActiveMowerContext — holds the currently selected mower SN for users
 * with more than one bound mower. Persisted across restarts via
 * expo-secure-store (same pattern as DevModeContext/ExperimentalContext).
 *
 * This context does NOT derive the DeviceState object — that is done in
 * `useActiveMower()` so it can combine with useMowerState().devices.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import * as SecureStore from 'expo-secure-store';
import { getServerUrl } from '../services/auth';
import { ApiClient } from '../services/api';

// SecureStore keys allow ONLY alphanumerics, '.', '-', '_'. The original
// 'novabot:activeMowerSn' key contained ':' which Expo SDK 49+ rejects with
// "Invalid key" — every read/write silently failed and fell back to null.
// Migration: try the legacy colon key once on hydrate; if a value exists
// there we copy it across and delete the legacy entry.
const STORE_KEY = 'novabot_activeMowerSn';
const LEGACY_STORE_KEY = 'novabot:activeMowerSn';

interface ActiveMowerContextValue {
  activeMowerSn: string | null;
  setActiveMowerSn: (sn: string | null) => void;
  hydrated: boolean;
}

const defaultValue: ActiveMowerContextValue = {
  activeMowerSn: null,
  setActiveMowerSn: () => {},
  hydrated: false,
};

export const ActiveMowerContext = createContext<ActiveMowerContextValue>(defaultValue);

export function ActiveMowerProvider({ children }: { children: React.ReactNode }) {
  const [activeMowerSn, setActiveMowerSnState] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const mounted = useRef(true);

  // Load persisted SN on mount.
  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        let stored: string | null = null;
        try {
          stored = await SecureStore.getItemAsync(STORE_KEY);
        } catch {
          stored = null;
        }
        // Migrate from the legacy colon-containing key one time. The legacy
        // key actually NEVER persisted because SecureStore rejected the
        // write — but try anyway in case some platform tolerated it.
        if (!stored) {
          try {
            const legacy = await SecureStore.getItemAsync(LEGACY_STORE_KEY);
            if (legacy) {
              stored = legacy;
              try {
                await SecureStore.setItemAsync(STORE_KEY, legacy);
                await SecureStore.deleteItemAsync(LEGACY_STORE_KEY);
              } catch { /* ignore migration failure */ }
            }
          } catch { /* ignore — legacy key may simply not exist */ }
        }
        if (mounted.current && stored) setActiveMowerSnState(stored);
      } catch {
        // Ignore — falls back to null.
      } finally {
        if (mounted.current) setHydrated(true);
      }
    })();
    return () => { mounted.current = false; };
  }, []);

  const setActiveMowerSn = useCallback((sn: string | null) => {
    setActiveMowerSnState(sn);
    if (sn) {
      SecureStore.setItemAsync(STORE_KEY, sn).catch(() => {});
      // Sync naar server zodat de officiële Novabot-app alleen deze pair
      // ziet via userEquipmentList. Fire-and-forget — UI wacht niet, fouten
      // zijn niet-fataal (kan offline zijn of server niet bereikbaar).
      (async () => {
        try {
          const url = await getServerUrl();
          if (!url) return;
          const api = new ApiClient(url);
          await api.setActiveMower(sn);
        } catch {
          // Ignore — de lokale keuze werkt ook zonder server-sync.
        }
      })();
    } else {
      SecureStore.deleteItemAsync(STORE_KEY).catch(() => {});
    }
  }, []);

  return (
    <ActiveMowerContext.Provider value={{ activeMowerSn, setActiveMowerSn, hydrated }}>
      {children}
    </ActiveMowerContext.Provider>
  );
}

export function useActiveMowerContext(): ActiveMowerContextValue {
  return useContext(ActiveMowerContext);
}

/**
 * Imperative clear — called from the logout handler because it has to fire
 * outside the React tree (the provider will have been unmounted by then).
 */
export async function clearPersistedActiveMowerSn(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORE_KEY);
  } catch {
    // Ignore — key may not exist.
  }
}
