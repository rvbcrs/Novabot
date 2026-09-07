import { afterEach, expect, it, vi } from 'vitest';
import { sendMappingCommand } from '../mappingCommand';
import type { BleRespond } from '../bleFrameAssembler';

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
