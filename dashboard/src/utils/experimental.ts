// Experimental features toggle for the dashboard. OFF by default, so anything
// unfinished stays out of everyone's way until they opt in.
//
// Mirrors the app's ExperimentalContext (app/src/context/ExperimentalContext.tsx,
// key `opennova_experimental`). Separate storage on purpose: this is a
// per-browser preference and the app's lives in expo-secure-store on the phone,
// so there is nothing to sync between them.
//
// Gates: the Terrain tab.

import { useEffect, useState } from 'react';

const KEY = 'novabot.experimental';
const EVENT = 'novabot:experimental';

export function readExperimental(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch { /* private mode */ }
  return false;
}

export function writeExperimental(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
    // Notify same-tab listeners (the storage event only fires cross-tab).
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch { /* ignore */ }
}

/** Reactive read — updates when the preference changes in this or another tab. */
export function useExperimental(): boolean {
  const [on, setOn] = useState(readExperimental);
  useEffect(() => {
    const sync = () => setOn(readExperimental());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return on;
}
