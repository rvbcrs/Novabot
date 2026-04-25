import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useColorScheme } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { darkColors, lightColors, type Colors } from './colors';

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ColorScheme = 'light' | 'dark';
export type MowerColor = 'white' | 'grey';

interface ThemeContextValue {
  mode: ThemeMode;
  colorScheme: ColorScheme;
  colors: Colors;
  setMode: (mode: ThemeMode) => Promise<void>;
  mowerColor: MowerColor;
  setMowerColor: (color: MowerColor) => Promise<void>;
}

const STORAGE_KEY = 'themeMode';
const MOWER_COLOR_KEY = 'mowerColor';
const DEFAULT_MODE: ThemeMode = 'auto';
const DEFAULT_MOWER_COLOR: MowerColor = 'white';

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(DEFAULT_MODE);
  const [mowerColor, setMowerColorState] = useState<MowerColor>(DEFAULT_MOWER_COLOR);
  const systemScheme = useColorScheme(); // 'light' | 'dark' | null

  // Load persisted prefs once on mount.
  useEffect(() => {
    SecureStore.getItemAsync(STORAGE_KEY)
      .then((value) => {
        if (value === 'auto' || value === 'light' || value === 'dark') {
          setModeState(value);
        }
      })
      .catch((err) => {
        console.warn('[theme] SecureStore read failed:', err);
      });
    SecureStore.getItemAsync(MOWER_COLOR_KEY)
      .then((value) => {
        if (value === 'white' || value === 'grey') {
          setMowerColorState(value);
        }
      })
      .catch((err) => {
        console.warn('[theme] SecureStore read failed (mowerColor):', err);
      });
  }, []);

  const setMode = useCallback(async (next: ThemeMode) => {
    setModeState(next);
    try {
      await SecureStore.setItemAsync(STORAGE_KEY, next);
    } catch (err) {
      console.warn('[theme] SecureStore write failed:', err);
    }
  }, []);

  const setMowerColor = useCallback(async (next: MowerColor) => {
    setMowerColorState(next);
    try {
      await SecureStore.setItemAsync(MOWER_COLOR_KEY, next);
    } catch (err) {
      console.warn('[theme] SecureStore write failed (mowerColor):', err);
    }
  }, []);

  const colorScheme: ColorScheme = useMemo(() => {
    if (mode === 'auto') return systemScheme === 'light' ? 'light' : 'dark';
    return mode;
  }, [mode, systemScheme]);

  const palette = colorScheme === 'light' ? lightColors : darkColors;

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, colorScheme, colors: palette, setMode, mowerColor, setMowerColor }),
    [mode, colorScheme, palette, setMode, mowerColor, setMowerColor],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
