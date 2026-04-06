/**
 * ExperimentalContext — toggle for experimental/beta features.
 * Persists across restarts via SecureStore.
 */
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import * as SecureStore from 'expo-secure-store';

const STORE_KEY = 'opennova_experimental';

interface ExperimentalState {
  enabled: boolean;
  toggle: () => void;
}

const ExperimentalContext = createContext<ExperimentalState>({
  enabled: false,
  toggle: () => {},
});

export function ExperimentalProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const stored = await SecureStore.getItemAsync(STORE_KEY);
        if (stored === 'true') setEnabled(true);
      } catch { /* ignore */ }
      setLoaded(true);
    })();
  }, []);

  const toggle = useCallback(() => {
    const next = !enabled;
    setEnabled(next);
    SecureStore.setItemAsync(STORE_KEY, next ? 'true' : 'false').catch(() => {});
  }, [enabled]);

  if (!loaded) return null;

  return (
    <ExperimentalContext.Provider value={{ enabled, toggle }}>
      {children}
    </ExperimentalContext.Provider>
  );
}

export function useExperimental(): ExperimentalState {
  return useContext(ExperimentalContext);
}
