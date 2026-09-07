import { afterEach, expect, it, vi } from 'vitest';
import { runAutoDock } from '../autoDock';

afterEach(() => vi.useRealTimers());

it('reads status arriving after the command and stops retrying once docking starts', async () => {
  vi.useFakeTimers();
  let status = { errorStatus: 0, progressing: false };
  const send = vi.fn(async () => true);
  const result = runAutoDock(send, () => status, () => true);
  await vi.advanceTimersByTimeAsync(1000);
  status = { errorStatus: 122, progressing: false };
  await vi.advanceTimersByTimeAsync(2000);
  status = { errorStatus: 122, progressing: true };
  await vi.advanceTimersByTimeAsync(500);
  expect(await result).toBe('accepted');
  expect(send).toHaveBeenCalledOnce();
});

it('does not send another docking command after save or exit cancels a retry', async () => {
  vi.useFakeTimers();
  let active = true;
  const send = vi.fn(async () => true);
  const result = runAutoDock(send, () => ({ errorStatus: 122, progressing: false }), () => active);
  await vi.advanceTimersByTimeAsync(1000);
  active = false;
  await vi.advanceTimersByTimeAsync(20000);
  expect(await result).toBe('cancelled');
  expect(send).toHaveBeenCalledOnce();
});

it('ends after six failed nav2 retries so the screen can offer another action', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async () => true);
  const result = runAutoDock(send, () => ({ errorStatus: 122, progressing: false }), () => true);
  await vi.runAllTimersAsync();
  expect(await result).toBe('exhausted');
  expect(send).toHaveBeenCalledTimes(6);
});

it('does not poll or retry a rejected command', async () => {
  const send = vi.fn(async () => false);
  expect(await runAutoDock(send, () => ({ errorStatus: 0, progressing: false }), () => true)).toBe('failed');
  expect(send).toHaveBeenCalledOnce();
});
