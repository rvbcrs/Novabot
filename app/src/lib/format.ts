/**
 * Locale-aware date/time formatting.
 *
 * Two layers of correctness:
 *
 * 1. Locale tag — Hermes' Intl on iOS defaults to en-US if no locale is
 *    passed, regardless of device region. We pull the BCP-47 tag from
 *    `expo-localization` and pass it explicitly so a NL device sees Dutch
 *    months, US sees English, etc.
 *
 * 2. 24h vs 12h — even with the right locale Hermes' ICU subset sometimes
 *    falls back to AM/PM for non-en locales. We *also* read the device's
 *    `uses24hourClock` from `getCalendars()` and force `hour12` explicitly,
 *    so a Dutch user always sees "19:00" and a US user "7:00 PM" no matter
 *    what Hermes thinks the default is. This was the root cause of Ramon
 *    seeing "7:00 PM" on his NL iPhone after we shipped the locale-aware
 *    formatter the first time.
 *
 * Cached per process — `getLocales()` / `getCalendars()` do native calls
 * each invocation which adds up if a screen formats hundreds of stamps.
 */
import { getLocales, getCalendars } from 'expo-localization';

let cachedTag: string | null = null;
let cachedHour12: boolean | null = null;

/** Device's primary BCP-47 language tag (e.g. "nl-NL", "en-US"). Falls back to "en-US". */
export function getDeviceLocale(): string {
  if (cachedTag) return cachedTag;
  try {
    const locales = getLocales();
    cachedTag = locales[0]?.languageTag ?? 'en-US';
  } catch {
    cachedTag = 'en-US';
  }
  return cachedTag;
}

/** True when the device prefers AM/PM (12h), false for 24h. Used to force `hour12` on Hermes. */
function getDeviceHour12(): boolean {
  if (cachedHour12 !== null) return cachedHour12;
  try {
    const cal = getCalendars()[0];
    // expo-localization returns `uses24hourClock` as boolean | null.
    // null = undetectable → fall back to locale heuristic (en-US/en-CA/en-AU
    // typically use 12h, most others 24h).
    if (cal?.uses24hourClock === true) cachedHour12 = false;
    else if (cal?.uses24hourClock === false) cachedHour12 = true;
    else {
      const tag = getDeviceLocale();
      cachedHour12 = /^en-(US|CA|AU|PH)/i.test(tag);
    }
  } catch {
    cachedHour12 = true;
  }
  return cachedHour12;
}

/** Format a Date or ISO string as device-localised "HH:MM" or "h:MM AM/PM". */
export function formatTime(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  return d.toLocaleTimeString(getDeviceLocale(), {
    hour: '2-digit', minute: '2-digit', hour12: getDeviceHour12(),
  });
}

/** Format as device-localised short date (no time). */
export function formatDate(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  return d.toLocaleDateString(getDeviceLocale(), { day: 'numeric', month: 'short' });
}

/** Format as device-localised "HH:MM:SS" / "h:MM:SS AM/PM". */
export function formatTimeWithSeconds(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  return d.toLocaleTimeString(getDeviceLocale(), {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: getDeviceHour12(),
  });
}
