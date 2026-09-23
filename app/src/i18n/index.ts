/**
 * i18n — lightweight translation system.
 * No external dependencies. Uses React context + SecureStore for persistence.
 */
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import * as SecureStore from 'expo-secure-store';
import en from './en';
import nl from './nl';
import de from './de';
import fr from './fr';

const STORE_KEY = 'opennova_language';

export type Language = 'en' | 'nl' | 'de' | 'fr';

export const LANGUAGES: Array<{ code: Language; label: string; flag: string }> = [
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'nl', label: 'Nederlands', flag: '🇳🇱' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
];

const translations: Record<Language, Record<string, string>> = { en, nl, de, fr };

// The server writes its messages (errors, status) in the reader's language and
// reads it from X-Lang. Screens call fetch() directly all over the app, so the
// header is added here, once, for every request to an OpenNova /api/ path.
// ponytail: global fetch wrapper; fine in React Native (no CORS preflight).
let currentLanguage: Language = 'en';
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes('/api/')) return nativeFetch(input, init);
  const headers = new Headers(init?.headers);
  if (!headers.has('X-Lang')) headers.set('X-Lang', currentLanguage);
  return nativeFetch(input, { ...init, headers });
}) as typeof fetch;

interface I18nState {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nState>({
  language: 'en',
  setLanguage: () => {},
  t: (key) => key,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [language, setLang] = useState<Language>('en');
  currentLanguage = language;
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const stored = await SecureStore.getItemAsync(STORE_KEY);
        if (stored && stored in translations) setLang(stored as Language);
      } catch { /* ignore */ }
      setLoaded(true);
    })();
  }, []);

  const setLanguage = useCallback((lang: Language) => {
    setLang(lang);
    SecureStore.setItemAsync(STORE_KEY, lang).catch(() => {});
  }, []);

  const t = useCallback((key: string, params?: Record<string, string | number>) => {
    let str = translations[language]?.[key] ?? translations.en[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(`{{${k}}}`, String(v));
      }
    }
    return str;
  }, [language]);

  if (!loaded) return null;

  return React.createElement(
    I18nContext.Provider,
    { value: { language, setLanguage, t } },
    children,
  );
}

export function useI18n(): I18nState {
  return useContext(I18nContext);
}
