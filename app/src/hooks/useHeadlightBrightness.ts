/**
 * Persistent user-chosen headlight brightness (0-255). Shared across screens
 * so both MowerSettings (slider) and JoystickScreen / HomeScreen headlight
 * toggles apply the same value.
 *
 * Stored via expo-secure-store so it survives app restarts. Default 255 —
 * full brightness, matches the "night docking working" setup from the
 * project memory (LED=255 is required for ArUco detection at night).
 */
import { useEffect, useState, useCallback } from 'react';
import * as SecureStore from 'expo-secure-store';

const STORE_KEY = 'opennova_headlight_brightness';
const DEFAULT_BRIGHTNESS = 255;

let _cached: number | null = null;
const _listeners = new Set<(v: number) => void>();

function notify(v: number) {
  _cached = v;
  for (const l of _listeners) l(v);
}

export function useHeadlightBrightness() {
  const [brightness, setLocalBrightness] = useState<number>(
    _cached ?? DEFAULT_BRIGHTNESS,
  );

  // Hydrate from secure store once per app session
  useEffect(() => {
    if (_cached != null) {
      setLocalBrightness(_cached);
      return;
    }
    (async () => {
      try {
        const raw = await SecureStore.getItemAsync(STORE_KEY);
        const parsed = raw == null ? DEFAULT_BRIGHTNESS : parseInt(raw, 10);
        const v = Number.isFinite(parsed) ? Math.max(0, Math.min(255, parsed)) : DEFAULT_BRIGHTNESS;
        _cached = v;
        setLocalBrightness(v);
      } catch {
        _cached = DEFAULT_BRIGHTNESS;
        setLocalBrightness(DEFAULT_BRIGHTNESS);
      }
    })();
  }, []);

  // Subscribe to cross-screen updates
  useEffect(() => {
    const listener = (v: number) => setLocalBrightness(v);
    _listeners.add(listener);
    return () => { _listeners.delete(listener); };
  }, []);

  const setBrightness = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(255, Math.round(v)));
    notify(clamped);
    SecureStore.setItemAsync(STORE_KEY, String(clamped)).catch(() => {});
  }, []);

  return { brightness, setBrightness };
}
