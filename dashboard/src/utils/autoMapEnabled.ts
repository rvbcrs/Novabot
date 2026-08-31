// Visibility of the "Autonomous mapping" panel under the map. OFF by default:
// it is an experimental feature that otherwise permanently occupies space below
// the map for everyone. The Settings tab writes it, AutoMapPanel reads it.
//
// Display-only: it never stops a session, and the panel overrides it while a
// session is running or awaiting review so the stop/review controls can never
// be hidden behind a preference.

import { useEffect, useState } from 'react';

const KEY = 'novabot.autoMapEnabled';
const EVENT = 'novabot:automapenabled';

export function readAutoMapEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch { /* private mode */ }
  return false;
}

export function writeAutoMapEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
    // Notify same-tab listeners (the storage event only fires cross-tab).
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch { /* ignore */ }
}

/** Reactive read — updates when the preference changes in this or another tab. */
export function useAutoMapEnabled(): boolean {
  const [on, setOn] = useState(readAutoMapEnabled);
  useEffect(() => {
    const sync = () => setOn(readAutoMapEnabled());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return on;
}
