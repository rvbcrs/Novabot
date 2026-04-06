import { createContext, useContext } from 'react';
import en from './locales/en.json';
import nl from './locales/nl.json';

export type Locale = 'en' | 'nl';

const locales: Record<Locale, typeof en> = { en, nl };

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  nl: 'Nederlands',
};

function getNestedValue(obj: Record<string, unknown>, path: string): string {
  const keys = path.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current && typeof current === 'object' && key in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return path;
    }
  }
  return typeof current === 'string' ? current : path;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

export type TFunction = (key: string, params?: Record<string, string | number>) => string;

export function createT(locale: Locale): TFunction {
  const messages = locales[locale] ?? locales.en;
  return (key: string, params?: Record<string, string | number>) => {
    const value = getNestedValue(messages as unknown as Record<string, unknown>, key);
    return interpolate(value, params);
  };
}

export function detectLocale(): Locale {
  const stored = localStorage.getItem('novabot-ble-locale');
  if (stored && stored in locales) return stored as Locale;
  const browserLang = navigator.language.slice(0, 2).toLowerCase();
  if (browserLang === 'nl') return 'nl';
  return 'en';
}

interface I18nContextValue {
  locale: Locale;
  t: TFunction;
  setLocale: (locale: Locale) => void;
}

export const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  t: createT('en'),
  setLocale: () => {},
});

export function useT(): I18nContextValue {
  return useContext(I18nContext);
}
