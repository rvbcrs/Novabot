import { expect, it, vi } from 'vitest';
import type { AppStateEvent, AppStateStatus } from 'react-native';
import { stopOnAppBlur } from '../mappingAppState';

it.each([false, true])('stops on native focus loss, never restarts, and removes listeners (Android=%s)', android => {
  const listeners = new Map<AppStateEvent, (state: AppStateStatus) => void>();
  const appState = {
    currentState: 'active' as AppStateStatus,
    addEventListener: (event: AppStateEvent, listener: (state: AppStateStatus) => void) => {
      listeners.set(event, listener);
      return { remove: () => { listeners.delete(event); } };
    },
  };
  const stop = vi.fn();
  const foreground = vi.fn();
  const cleanup = stopOnAppBlur(appState, stop, android, foreground);
  expect(foreground).toHaveBeenLastCalledWith(true);
  listeners.get('change')?.('inactive');
  expect(foreground).toHaveBeenLastCalledWith(false);
  listeners.get('change')?.('background');
  expect(stop).toHaveBeenCalledTimes(2);
  listeners.get('change')?.('active');
  expect(foreground).toHaveBeenLastCalledWith(true);
  expect(stop).toHaveBeenCalledTimes(2);
  listeners.get('blur')?.('active'); // Android quick settings leaves AppState active.
  expect(stop).toHaveBeenCalledTimes(android ? 3 : 2);
  expect(foreground).toHaveBeenLastCalledWith(!android);
  listeners.get('change')?.('active'); // AppState alone cannot override Android blur.
  expect(foreground).toHaveBeenLastCalledWith(!android);
  listeners.get('focus')?.('active');
  expect(foreground).toHaveBeenLastCalledWith(true);
  expect(stop).toHaveBeenCalledTimes(android ? 3 : 2);
  listeners.get('change')?.('background');
  listeners.get('focus')?.('background'); // Window focus alone cannot override background.
  expect(foreground).toHaveBeenLastCalledWith(false);
  cleanup();
  expect(listeners.size).toBe(0);
});
