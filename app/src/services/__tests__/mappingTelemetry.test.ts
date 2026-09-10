import { afterEach, expect, it, vi } from 'vitest';
import type { BleTelemetry } from '../bleFrameAssembler';
import { watchMappingPosition } from '../mappingTelemetry';

afterEach(() => vi.useRealTimers());

function positionStream() {
  let listener: ((update: BleTelemetry) => void) | undefined;
  const unsubscribe = vi.fn(() => { listener = undefined; });
  return {
    subscribe: (callback: (update: BleTelemetry) => void) => { listener = callback; return unsubscribe; },
    emit: (update: BleTelemetry) => listener?.(update),
    unsubscribe,
  };
}

it('keeps identical stationary positions live, then recovers once after positions stop', () => {
  vi.useFakeTimers();
  const stream = positionStream();
  const stale = vi.fn();
  const cleanup = watchMappingPosition(stream.subscribe, stale);
  const stationary = { position: { x: 10, y: 20 } };
  for (let i = 0; i < 10; i++) {
    vi.advanceTimersByTime(5000);
    stream.emit(stationary);
  }
  expect(stale).not.toHaveBeenCalled();
  vi.advanceTimersByTime(5999);
  expect(stale).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(stale).toHaveBeenCalledOnce();
  expect(stream.unsubscribe).toHaveBeenCalledOnce();
  stream.emit(stationary);
  vi.advanceTimersByTime(60000);
  expect(stale).toHaveBeenCalledOnce();
  cleanup();
  expect(stream.unsubscribe).toHaveBeenCalledOnce();
});

it('does not mistake heading-only traffic for live positions', () => {
  vi.useFakeTimers();
  const stream = positionStream();
  const stale = vi.fn();
  watchMappingPosition(stream.subscribe, stale);
  for (let i = 0; i < 5; i++) {
    vi.advanceTimersByTime(1000);
    stream.emit({ orientation: i / 10 });
  }
  expect(stale).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(stale).toHaveBeenCalledOnce();
});

it('removes its subscription and timer when the mapping screen leaves recording', () => {
  vi.useFakeTimers();
  const stream = positionStream();
  const stale = vi.fn();
  const cleanup = watchMappingPosition(stream.subscribe, stale);
  vi.advanceTimersByTime(5999);
  cleanup();
  stream.emit({ position: { x: 1, y: 2 } });
  vi.advanceTimersByTime(60000);
  expect(stale).not.toHaveBeenCalled();
  expect(stream.unsubscribe).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
