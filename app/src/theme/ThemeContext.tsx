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

interface ThemeContextValue {
  mode: ThemeMode;
  colorScheme: ColorScheme;
  colors: Colors;
  setMode: (mode: ThemeMode) => Promise<void>;
}

const STORAGE_KEY = 'themeMode';
const DEFAULT_MODE: ThemeMode = 'auto';

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(DEFAULT_MODE);
  const systemScheme = useColorScheme(); // 'light' | 'dark' | null

  // Load persisted theme mode once on mount.
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
  }, []);

  const setMode = useCallback(async (next: ThemeMode) => {
    setModeState(next);
    try {
      await SecureStore.setItemAsync(STORAGE_KEY, next);
    } catch (err) {
      console.warn('[theme] SecureStore write failed:', err);
    }
  }, []);

  const colorScheme: ColorScheme = useMemo(() => {
    if (mode === 'auto') return systemScheme === 'light' ? 'light' : 'dark';
    return mode;
  }, [mode, systemScheme]);

  const palette = colorScheme === 'light' ? lightColors : darkColors;

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, colorScheme, colors: palette, setMode }),
    [mode, colorScheme, palette, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
