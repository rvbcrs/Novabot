// Optional link to the user's own container manager (Portainer, Dokploy,
// Dockge, ...). When set, the "update available" banner offers a shortcut to it
// so updating doesn't require dropping to a terminal (GH #95).
//
// Per-browser preference, same shape as autoMapEnabled / experimental.

import { useEffect, useState } from 'react';

const KEY = 'novabot.containerManagerUrl';
const EVENT = 'novabot:containermanagerurl';

/**
 * Accept only http(s) absolute URLs.
 *
 * This value is typed by the user and rendered straight into an `href`, so a
 * `javascript:` or `data:` URL would be a self-XSS waiting to happen. Anything
 * that isn't a parseable http(s) URL is treated as "not set".
 */
export function normalizeManagerUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function readContainerManagerUrl(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch { /* private mode */ }
  return '';
}

export function writeContainerManagerUrl(raw: string): void {
  try {
    const url = normalizeManagerUrl(raw);
    if (url) localStorage.setItem(KEY, url);
    else localStorage.removeItem(KEY);
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch { /* ignore */ }
}

/** Reactive read — the validated URL, or null when unset/invalid. */
export function useContainerManagerUrl(): string | null {
  const [url, setUrl] = useState(() => normalizeManagerUrl(readContainerManagerUrl()));
  useEffect(() => {
    const sync = () => setUrl(normalizeManagerUrl(readContainerManagerUrl()));
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return url;
}
