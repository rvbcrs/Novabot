/**
 * useMowerColor — per-mower colour preference (white / grey).
 *
 * Persisted to expo-secure-store under key `mowerColor:<SN>`. A small
 * module-level cache + listener set keeps every consumer (AppSettings
 * segment, AnimatedMower body asset, picker chevron icon) in sync the
 * moment the user toggles the segment.
 *
 * Default = 'white' (matches the stock body PNG).
 */
import { useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';

export type MowerColor = 'white' | 'grey';

const KEY_PREFIX = 'mowerColor:';
const DEFAULT_COLOR: MowerColor = 'white';

const cache = new Map<string, MowerColor>();
const listeners = new Map<string, Set<(c: MowerColor) => void>>();

function emit(sn: string, color: MowerColor) {
  cache.set(sn, color);
  listeners.get(sn)?.forEach((cb) => cb(color));
}

function isMowerColor(v: unknown): v is MowerColor {
  return v === 'white' || v === 'grey';
}

export function useMowerColor(sn: string | null | undefined): {
  mowerColor: MowerColor;
  setMowerColor: (color: MowerColor) => Promise<void>;
} {
  const key = sn ?? '';
  const [mowerColor, setMowerColorState] = useState<MowerColor>(
    () => (key && cache.get(key)) || DEFAULT_COLOR,
  );

  // Subscribe to cross-component updates for this SN.
  useEffect(() => {
    if (!key) return;
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(setMowerColorState);
    return () => {
      set?.delete(setMowerColorState);
    };
  }, [key]);

  // Lazy-load from SecureStore once per SN.
  useEffect(() => {
    if (!key) return;
    if (cache.has(key)) {
      // Already in cache — sync local state.
      setMowerColorState(cache.get(key)!);
      return;
    }
    SecureStore.getItemAsync(KEY_PREFIX + key)
      .then((value) => {
        const v = isMowerColor(value) ? value : DEFAULT_COLOR;
        emit(key, v);
      })
      .catch((err) => {
        console.warn('[mowerColor] SecureStore read failed:', err);
        emit(key, DEFAULT_COLOR);
      });
  }, [key]);

  const setMowerColor = useCallback(
    async (next: MowerColor) => {
      if (!key) return;
      emit(key, next);
      try {
        await SecureStore.setItemAsync(KEY_PREFIX + key, next);
      } catch (err) {
        console.warn('[mowerColor] SecureStore write failed:', err);
      }
    },
    [key],
  );

  return { mowerColor, setMowerColor };
}
