/**
 * awaitCommand around mqtt_node restarts (live .244, 2026-09-26: a delete_map
 * published in the 25 s restart gap was lost and the user got a timeout).
 * A command waits for someone to listen on the device's command topic, and is
 * sent once more when the listener drops and returns while we wait.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../mqtt/broker.js', () => ({
  isSnBanned: () => false,
  isDeviceOnline: () => true,
}));

import { awaitCommand, notifyRespond, initMapSync, setDemoInterceptor } from '../../mqtt/mapSync.js';
import { noteSubscribe, noteDisconnect, resetCommandChannel } from '../../mqtt/commandChannel.js';

const SN = 'LFIN_AWAIT_0001';
const TOPIC = `Dart/Send_mqtt/${SN}`;
let sent: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  resetCommandChannel();
  sent = [];
  initMapSync({} as never);
  // The demo interceptor sees every publish that would reach the broker;
  // returning true keeps it from going further.
  setDemoInterceptor((sn, command) => { if (sn === SN) sent.push(Object.keys(command)[0]); return true; });
});
afterEach(() => { setDemoInterceptor(null as never); vi.useRealTimers(); });

describe('awaitCommand and the command listener', () => {
  it('sends straight away when the device listens (or has never been seen)', async () => {
    const p = awaitCommand(SN, 'delete_map', { map_name: 'map1' }, 5000);
    expect(sent).toEqual(['delete_map']);
    notifyRespond(SN, 'delete_map_respond', { result: 0 });
    await expect(p).resolves.toEqual({ result: 0 });
  });

  it('holds the command while mqtt_node is gone and sends it when it subscribes again', async () => {
    noteSubscribe('mower_node', TOPIC);
    noteDisconnect('mower_node');
    const p = awaitCommand(SN, 'delete_map', { map_name: 'map1' }, 5000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent).toEqual([]);                     // not lost into an empty topic
    noteSubscribe('mower_node', TOPIC);
    expect(sent).toEqual(['delete_map']);
    // The answer window starts at the send, not at the call.
    await vi.advanceTimersByTimeAsync(4_000);
    notifyRespond(SN, 'delete_map_respond', { result: 0 });
    await expect(p).resolves.toEqual({ result: 0 });
  });

  it('sends once more when the listener drops and returns before the answer', async () => {
    noteSubscribe('mower_node', TOPIC);
    const p = awaitCommand(SN, 'delete_map', { map_name: 'map1' }, 5000);
    noteDisconnect('mower_node');
    noteSubscribe('mower_node', TOPIC);
    noteDisconnect('mower_node');
    noteSubscribe('mower_node', TOPIC);
    expect(sent).toEqual(['delete_map', 'delete_map']);   // once more, not every time
    notifyRespond(SN, 'delete_map_respond', { result: 0 });
    await expect(p).resolves.toEqual({ result: 0 });
  });

  it('gives up with a clear reason when the device does not come back', async () => {
    noteSubscribe('mower_node', TOPIC);
    noteDisconnect('mower_node');
    const p = awaitCommand(SN, 'delete_map', {}, 5000, 30_000);
    const check = expect(p).rejects.toThrow(/did not come back/);
    await vi.advanceTimersByTimeAsync(30_000);
    await check;
    expect(sent).toEqual([]);
  });

  it('still times out on a listening device that never answers', async () => {
    const p = awaitCommand(SN, 'delete_map', {}, 5000);
    const check = expect(p).rejects.toThrow(/timeout after 5000ms/);
    await vi.advanceTimersByTimeAsync(5_000);
    await check;
  });
});
