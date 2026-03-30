/**
 * DevModeContext — hidden developer mode toggle.
 * Default: only provisioning visible.
 * Tap version text 7 times → full app unlocked.
 * Persists across restarts via SecureStore.
 */
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import * as SecureStore from 'expo-secure-store';
import { Alert } from 'react-native';

const STORE_KEY = 'opennova_dev_mode';

interface DevModeState {
  unlocked: boolean;
  tapCount: number;
  handleTap: () => void;
}

const DevModeContext = createContext<DevModeState>({
  unlocked: false,
  tapCount: 0,
  handleTap: () => {},
});

export function DevModeProvider({ children }: { children: React.ReactNode }) {
  const [unlocked, setUnlocked] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const tapCountRef = useRef(0);
  const [tapCount, setTapCount] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load persisted state
  useEffect(() => {
    (async () => {
      try {
        const stored = await SecureStore.getItemAsync(STORE_KEY);
        if (stored === 'true') setUnlocked(true);
      } catch { /* ignore */ }
      setLoaded(true);
    })();
  }, []);

  const handleTap = useCallback(() => {
    // Reset counter after 3 seconds of no taps
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      tapCountRef.current = 0;
      setTapCount(0);
    }, 3000);

    tapCountRef.current += 1;
    const count = tapCountRef.current;
    setTapCount(count);

    if (count >= 4 && count < 7) {
      // Show countdown hint
      const remaining = 7 - count;
      // No alert, just update tapCount for UI feedback
    }

    if (count === 7) {
      tapCountRef.current = 0;
      setTapCount(0);

      const newState = !unlocked;
      setUnlocked(newState);
      SecureStore.setItemAsync(STORE_KEY, newState ? 'true' : 'false').catch(() => {});

      Alert.alert(
        newState ? 'Developer Mode Enabled' : 'Developer Mode Disabled',
        newState
          ? 'All app features are now visible.'
          : 'Only provisioning is visible.',
      );
    }
  }, [unlocked]);

  if (!loaded) return null;

  return (
    <DevModeContext.Provider value={{ unlocked, tapCount, handleTap }}>
      {children}
    </DevModeContext.Provider>
  );
}

export function useDevMode(): DevModeState {
  return useContext(DevModeContext);
}
