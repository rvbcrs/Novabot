/**
 * "New in OpenNova": features worth a look, shown once per browser when the
 * dashboard opens.
 *
 * To announce a feature: add an entry at the top, put its video (a short muted
 * loop, 16:9, ~1280×720 mp4) and a poster frame in public/whats-new/, and its
 * title and text under whatsNew.<id> in the four locale files.
 */

/** Where "Try it" takes you. The shell turns it into a tab and an event. */
export type WhatsNewAction = 'angled-render';

export interface WhatsNewEntry {
  id: string;
  /** Release date, YYYY-MM-DD. Entries older than SHOW_FOR_DAYS stay quiet. */
  date: string;
  video: string;
  poster: string;
  action?: WhatsNewAction;
}

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    id: 'render3d',
    date: '2026-09-23',
    video: '/whats-new/3d-render.mp4',
    poster: '/whats-new/3d-render-poster.webp',
    action: 'angled-render',
  },
];

/** A newcomer should not get a pile of old news: only recent entries pop up. */
const SHOW_FOR_DAYS = 45;
const SEEN_KEY = 'whatsNew.seen';

function readSeen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Entries to show now: recent and not yet seen in this browser, newest first. */
export function unseenWhatsNew(entries: WhatsNewEntry[], seen: string[], now: number): WhatsNewEntry[] {
  const cutoff = now - SHOW_FOR_DAYS * 86_400_000;
  return entries.filter(e => !seen.includes(e.id) && Date.parse(e.date) >= cutoff);
}

export function pendingWhatsNew(now = Date.now()): WhatsNewEntry[] {
  return unseenWhatsNew(WHATS_NEW, readSeen(), now);
}

export function markWhatsNewSeen(ids: string[]): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...new Set([...readSeen(), ...ids])]));
  } catch { /* private window: it shows again next time, no harm */ }
}
