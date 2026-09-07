import { afterEach, expect, it, vi } from 'vitest';
import { sendMappingCommand } from '../mappingCommand';
import type { BleRespond } from '../bleFrameAssembler';
import { isMappingLoopClosed, scanStartPoint } from '../../utils/mapPoints';

afterEach(() => vi.useRealTimers());

function transport() {
  let listener: ((reply: BleRespond) => void) | undefined;
  const unsubscribe = vi.fn(() => { listener = undefined; });
  return {
    subscribe: (cb: (reply: BleRespond) => void) => { listener = cb; return unsubscribe; },
    emit: (data: unknown, command = 'save_map_respond') => listener?.({ command, data }),
    unsubscribe,
  };
}

it('accepts an immediate BLE save response without a server', async () => {
  const t = transport();
  await sendMappingCommand('save_map_respond', async () => {
    t.emit({ result: 0, value: 0 });
  }, t.subscribe, 100);
  expect(t.unsubscribe).toHaveBeenCalledOnce();
});

it('does not report a timed-out save as successful or accept another command', async () => {
  vi.useFakeTimers();
  const t = transport();
  const save = sendMappingCommand('save_map_respond', async () => {
    t.emit({ result: 0, value: null }, 'stop_scan_map_respond');
  }, t.subscribe, 100);
  const check = expect(save).rejects.toThrow('No confirmation');
  await vi.advanceTimersByTimeAsync(100);
  await check;
  expect(t.unsubscribe).toHaveBeenCalledOnce();
});

it.each([{ result: 1, value: 0 }, { result: 0, value: 120 }, { result: 0 }, { result: 0, value: null }, { result: 0, value: '120' }, null])('rejects failed or malformed acknowledgements: %j', async data => {
  const t = transport();
  await expect(sendMappingCommand('save_map_respond', async () => t.emit(data), t.subscribe, 100)).rejects.toThrow();
  expect(t.unsubscribe).toHaveBeenCalledOnce();
});

it('cleans up on a disconnected BLE write, without continuing the save sequence', async () => {
  const t = transport();
  const next = vi.fn();
  const save = sendMappingCommand('save_map_respond', async () => {
    throw new Error('Device is not connected');
  }, t.subscribe, 100).then(next);
  await expect(save).rejects.toThrow('not connected');
  expect(next).not.toHaveBeenCalled();
  expect(t.unsubscribe).toHaveBeenCalledOnce();
});

it('requires the write to succeed even if a response arrives first', async () => {
  const t = transport();
  await expect(sendMappingCommand('save_map_respond', async () => {
    t.emit({ result: 0, value: 0 });
    throw new Error('Device is not connected');
  }, t.subscribe, 100)).rejects.toThrow('not connected');
  expect(t.unsubscribe).toHaveBeenCalledOnce();
});

it('ignores an explicitly different save phase or command number', async () => {
  vi.useFakeTimers();
  const t = transport();
  const save = sendMappingCommand('save_map_respond', async () => {
    t.emit({ result: 0, value: 0, type: 0, cmd_num: 4 });
    t.emit({ result: 0, value: 0, type: 1, cmd_num: 3 });
  }, t.subscribe, 100, { type: 1, cmd_num: 4 });
  const check = expect(save).rejects.toThrow('No confirmation');
  await vi.advanceTimersByTimeAsync(100);
  await check;
});

it('waits beyond the old 8-second guess and preserves the mower-confirmed recording origin', async () => {
  vi.useFakeTimers();
  const t = transport();
  // Start position and response delay from the reported mower session.
  const start = { x: 3.4389715299902321, y: 5.21046304784252 };
  const started = vi.fn();
  const command = sendMappingCommand('add_scan_map_respond', async () => {}, t.subscribe, 20000).then(reply => {
    started();
    return scanStartPoint(reply.data);
  });
  await vi.advanceTimersByTimeAsync(8000);
  expect(started).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(4900);
  t.emit({ result: 0, value: { map_position: start } }, 'add_scan_map_respond');
  expect(await command).toEqual(start);

  // Synthetic lap returning to that confirmed start closes; using an old
  // position two metres away would leave the UI reporting an open boundary.
  const lap = Array.from({ length: 12 }, (_, i) => ({
    x: start.x + 3 * Math.sin(i * 2 * Math.PI / 11),
    y: start.y + 3 * (1 - Math.cos(i * 2 * Math.PI / 11)),
  }));
  expect(isMappingLoopClosed(lap)).toBe(true);
  expect(isMappingLoopClosed([{ x: start.x - 2, y: start.y }, ...lap.slice(1)])).toBe(false);
  expect(isMappingLoopClosed(Array(12).fill(start))).toBe(false);
  expect(isMappingLoopClosed(lap.slice(0, 6))).toBe(false);
  expect(scanStartPoint({ value: { map_position: { x: NaN, y: 1 } } })).toBeNull();
});
