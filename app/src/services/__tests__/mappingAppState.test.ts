import { expect, it, vi } from 'vitest';
import type { AppStateEvent, AppStateStatus } from 'react-native';
import { stopOnAppBlur } from '../mappingAppState';

it.each([false, true])('stops on native focus loss, never restarts, and removes listeners (Android=%s)', android => {
  const listeners = new Map<AppStateEvent, (state: AppStateStatus) => void>();
  const appState = {
    addEventListener: (event: AppStateEvent, listener: (state: AppStateStatus) => void) => {
      listeners.set(event, listener);
      return { remove: () => { listeners.delete(event); } };
    },
  };
  const stop = vi.fn();
  const cleanup = stopOnAppBlur(appState, stop, android);
  listeners.get('change')?.('inactive');
  listeners.get('change')?.('background');
  expect(stop).toHaveBeenCalledTimes(2);
  listeners.get('change')?.('active');
  expect(stop).toHaveBeenCalledTimes(2);
  listeners.get('blur')?.('active'); // Android quick settings leaves AppState active.
  expect(stop).toHaveBeenCalledTimes(android ? 3 : 2);
  cleanup();
  expect(listeners.size).toBe(0);
});
