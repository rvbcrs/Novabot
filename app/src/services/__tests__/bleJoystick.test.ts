import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchMappingPosition } from '../mappingTelemetry';

const manager = vi.hoisted(() => ({
  connectToDevice: vi.fn(),
  isDeviceConnected: vi.fn(),
  onDeviceDisconnected: vi.fn(),
}));
vi.mock('react-native-ble-plx', () => ({ BleManager: class { constructor() { return manager; } } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, PermissionsAndroid: {} }));

type Notify = (err: unknown, char: { value: string } | null) => void;
function fakeDevice() {
  const notifications: Notify[] = [];
  const removals = [vi.fn(), vi.fn()];
  const writes: string[] = [];
  const device = {
    id: 'mower-ios-uuid',
    discoverAllServicesAndCharacteristics: vi.fn(async () => device),
    characteristicsForService: vi.fn(async () => removals.map(remove => ({
      isNotifiable: true,
      monitor: (cb: Notify) => { notifications.push(cb); return { remove }; },
    }))),
    cancelConnection: vi.fn(async () => {}),
    writeCharacteristicWithoutResponseForService: vi.fn(async (_service: string, _char: string, value: string) => {
      writes.push(Buffer.from(value, 'base64').toString('utf8'));
    }),
  };
  return { device, notifications, removals, writes };
}

let ble: typeof import('../ble');
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  manager.isDeviceConnected.mockResolvedValue(true);
  manager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });
  ble = await import('../ble');
});
afterEach(async () => {
  await ble.bleJoystickDisconnect();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('BLE mapping connection', () => {
  it('recovers silent position reception despite working writes, stopping before reconnect without replaying a scan or save', async () => {
    const { device, notifications, writes } = fakeDevice();
    manager.connectToDevice.mockResolvedValue(device);
    const logs: string[] = [];
    ble.setBleLogCallback(line => logs.push(line));
    await ble.bleJoystickConnect(device.id);
    const received = vi.fn();
    const off = ble.onBleTelemetry(received);
    let recovery: Promise<boolean> | undefined;
    const recover = vi.fn(() => {
      recovery = ble.bleJoystickStopAndDisconnect().then(() => ble.bleJoystickConnect(device.id));
    });
    const cleanup = watchMappingPosition(ble.onBleTelemetry, recover);
    const bb = new Uint8Array(20);
    bb.set([0x62, 0x62]);
    bb[16] = 10;
    const notify = (index: number, raw: Uint8Array) => notifications[index](null, {
      value: Buffer.from(raw).toString('base64'),
    });
    notify(0, bb);
    await vi.advanceTimersByTimeAsync(5000);
    notify(0, bb); // A stationary mower is still delivering live positions.
    expect(logs.some(line => line.includes('"packets":2') && line.includes('"unchangedMs":5000'))).toBe(true);
    await ble.bleJoystickMove({ x_w: 0, y_v: 0.2, z_g: 0 });
    expect(ble.isBleJoystickConnected()).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    notify(0, new Uint8Array([0x63, 0x63, ...new Array(18).fill(0)]));
    expect(recover).not.toHaveBeenCalled();
    // Heading/working writes/native connected cannot hide missing bb positions.
    device.cancelConnection.mockImplementation(async () => {
      expect(writes.at(-1)).toBe('{"stop_move":null}');
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await recovery).toBe(true);
    expect(recover).toHaveBeenCalledOnce();
    expect(manager.connectToDevice).toHaveBeenCalledTimes(2);
    expect(writes).toHaveLength(2); // Only mst + stop_move, no mapping replay.
    const before = received.mock.calls.length;
    notify(0, bb); // An old callback from the same native Device is fenced.
    expect(received).toHaveBeenCalledTimes(before);
    bb[16] = 11;
    notify(2, bb);
    expect(received.mock.calls.at(-1)?.[0].position).toEqual({ x: 11, y: 0 });
    cleanup();
    off();
  });

  it('receives bb/cc and framed responds from both mower characteristics without a server', async () => {
    const { device, notifications } = fakeDevice();
    manager.connectToDevice.mockResolvedValue(device);
    const telemetry = vi.fn();
    const respond = vi.fn();
    const off = ble.onBleTelemetry(telemetry);
    ble.onBleRespond(respond);
    expect(await ble.bleJoystickConnect(device.id)).toBe(true);
    expect(notifications).toHaveLength(2);
    const notify = (index: number, raw: Uint8Array | string) => notifications[index](null, {
      value: Buffer.from(raw).toString('base64'),
    });
    notify(0, 'ble_start\0');
    notify(0, '{"type":"save_map_respond",');
    const bb = new Uint8Array(20);
    bb.set([0x62, 0x62]);
    bb.set([0x11, 12, 34, 5, 67], 15);
    notify(1, bb);
    const cc = new Uint8Array(20);
    cc.set([0x63, 0x63, 1, 1, 57]);
    notify(0, cc); // telemetry also leaves an interleaved JSON frame intact
    notify(0, '"message":{"result":0,"value":0}}');
    notify(0, 'ble_end\0');
    expect(telemetry.mock.calls[0][0]).toMatchObject({ position: { x: -12.34, y: -5.67 }, closedCycle: false });
    expect(telemetry.mock.calls[1][0].orientation).toBeCloseTo(-1.57);
    expect(respond).toHaveBeenCalledWith({ command: 'save_map_respond', data: { result: 0, value: 0 } });
    off();
    notify(1, bb);
    expect(telemetry).toHaveBeenCalledTimes(2);
  });

  it('writes the pending stop before an atomic mapping frame, followed by later joystick moves', async () => {
    const { device, writes } = fakeDevice();
    manager.connectToDevice.mockResolvedValue(device);
    await ble.bleJoystickConnect(device.id);
    const stop = ble.bleJoystickStop();
    const frame = ble.sendBleCommand({ save_map: { mapName: 'map1', type: 0, cmd_num: 1 } });
    const move = ble.bleJoystickMove({ x_w: 0.1, y_v: 0.2, z_g: 0 });
    await vi.runAllTimersAsync();
    await Promise.all([stop, frame, move]);
    const end = writes.indexOf('ble_end');
    expect(writes[0]).toBe('{"stop_move":null}');
    expect(writes[1]).toBe('ble_start');
    expect(JSON.parse(writes.slice(2, end).join(''))).toEqual({ save_map: { mapName: 'map1', type: 0, cmd_num: 1 } });
    expect(JSON.parse(writes.slice(end + 1).join(''))).toEqual({ mst: [10, 20, 8] });
  });

  it('rejects disconnected commands and removes subscriptions on a failed native write', async () => {
    await expect(ble.sendBleCommand({ stop_scan_map: {} })).rejects.toThrow('not connected');
    const { device, removals } = fakeDevice();
    manager.connectToDevice.mockResolvedValue(device);
    const disconnected = vi.fn();
    ble.onBleJoystickDisconnect(disconnected);
    await ble.bleJoystickConnect(device.id);
    device.writeCharacteristicWithoutResponseForService.mockRejectedValueOnce(new Error('BleError: Device is not connected'));
    await expect(ble.sendBleCommand({ stop_scan_map: {} })).rejects.toThrow('not connected');
    expect(ble.isBleJoystickConnected()).toBe(false);
    expect(disconnected).toHaveBeenCalledOnce();
    for (const remove of removals) expect(remove).toHaveBeenCalledOnce();
  });

  it('invalidates a connection when notifications stop with an error, even if native BLE still reports connected', async () => {
    const { device, notifications, removals } = fakeDevice();
    manager.connectToDevice.mockResolvedValue(device);
    const disconnected = vi.fn();
    ble.onBleJoystickDisconnect(disconnected);
    await ble.bleJoystickConnect(device.id);
    notifications[0](new Error('Characteristic monitor failed'), null);
    expect(ble.isBleJoystickConnected()).toBe(false);
    expect(disconnected).toHaveBeenCalledOnce();
    for (const remove of removals) expect(remove).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(device.cancelConnection).toHaveBeenCalledOnce();
    await expect(ble.sendBleCommand({ stop_scan_map: {} })).rejects.toThrow('not connected');
    expect(await ble.bleJoystickConnect(device.id)).toBe(true);
    expect(manager.connectToDevice).toHaveBeenCalledTimes(2);
  });

  it('waits for failed-session native teardown before reconnecting to the same mower', async () => {
    const { device, notifications } = fakeDevice();
    manager.connectToDevice.mockResolvedValue(device);
    await ble.bleJoystickConnect(device.id);
    let finishDisconnect!: () => void;
    device.cancelConnection.mockImplementationOnce(() =>
      new Promise<void>(resolve => { finishDisconnect = resolve; }));
    let reconnect!: Promise<boolean>;
    ble.onBleJoystickDisconnect(() => { reconnect = ble.bleJoystickConnect(device.id); });
    notifications[0](new Error('Characteristic monitor failed'), null);
    await vi.advanceTimersByTimeAsync(0);
    expect(device.cancelConnection).toHaveBeenCalledOnce();
    expect(manager.connectToDevice).toHaveBeenCalledOnce();
    expect(ble.isBleJoystickConnected()).toBe(false);
    await expect(ble.sendBleCommand({ stop_scan_map: {} })).rejects.toThrow('not connected');

    finishDisconnect();
    expect(await reconnect).toBe(true);
    expect(manager.connectToDevice).toHaveBeenCalledTimes(2);
    notifications[0](new Error('Late old monitor error'), null);
    expect(ble.isBleJoystickConnected()).toBe(true);
    expect(device.cancelConnection).toHaveBeenCalledOnce();
  });

  it('releases a stalled write queue without sending a late mapping command after its timeout', async () => {
    const { device, writes } = fakeDevice();
    manager.connectToDevice.mockResolvedValue(device);
    await ble.bleJoystickConnect(device.id);
    let releaseWrite!: () => void;
    device.writeCharacteristicWithoutResponseForService.mockImplementationOnce(() =>
      new Promise<void>(resolve => { releaseWrite = resolve; }));
    const move = ble.bleJoystickMove({ x_w: -1.25, y_v: -1.25, z_g: 0 });
    await vi.advanceTimersByTimeAsync(0);
    const stop = ble.sendBleCommand({ stop_scan_map: { value: false } });
    const failedStop = expect(stop).rejects.toThrow('not connected');
    const cleanup = ble.bleJoystickStopAndDisconnect();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ble.isBleJoystickConnected()).toBe(false);
    expect(device.cancelConnection).toHaveBeenCalledOnce();
    await Promise.all([move, failedStop, cleanup]);
    expect(await ble.bleJoystickConnect(device.id)).toBe(true);
    releaseWrite();
    await vi.runAllTimersAsync();
    expect(writes).toEqual([]);
    expect(device.writeCharacteristicWithoutResponseForService).toHaveBeenCalledTimes(1);
  });

  it('old disconnect/notify callbacks and queued moves cannot affect a reconnected mower', async () => {
    const old = fakeDevice();
    const current = fakeDevice();
    const telemetry = vi.fn();
    ble.onBleTelemetry(telemetry);
    manager.connectToDevice.mockResolvedValueOnce(old.device).mockResolvedValueOnce(current.device);
    await ble.bleJoystickConnect(old.device.id);
    const oldDisconnect = manager.onDeviceDisconnected.mock.calls[0][1];
    let releaseWrite!: () => void;
    old.device.writeCharacteristicWithoutResponseForService.mockImplementationOnce(() => new Promise<void>(resolve => { releaseWrite = resolve; }));
    const first = ble.bleJoystickMove({ x_w: 0.1, y_v: 0.2, z_g: 0 });
    await vi.advanceTimersByTimeAsync(0);
    const queued = ble.bleJoystickMove({ x_w: 0.9, y_v: 0.9, z_g: 0 });
    await ble.bleJoystickDisconnect();
    await ble.bleJoystickConnect(current.device.id);
    oldDisconnect(null);
    expect(ble.isBleJoystickConnected()).toBe(true);
    old.notifications[0](null, { value: Buffer.from([0x63, 0x63, ...new Array(18).fill(0)]).toString('base64') });
    expect(telemetry).not.toHaveBeenCalled();
    releaseWrite();
    await Promise.all([first, queued]);
    expect(current.writes).toEqual([]);
    const frame = ble.sendBleCommand({ get_signal_info: 0 });
    await vi.runAllTimersAsync();
    await frame;
    expect(current.writes[0]).toBe('ble_start');
  });

  it('does not finish an old mapping frame after reconnecting during its chunk delay', async () => {
    const old = fakeDevice();
    const current = fakeDevice();
    manager.connectToDevice.mockResolvedValueOnce(old.device).mockResolvedValueOnce(current.device);
    await ble.bleJoystickConnect(old.device.id);
    const frame = ble.sendBleCommand({ save_map: { mapName: 'map1', type: 0 } });
    const outcome = frame.then(() => null, error => error as Error);
    await vi.advanceTimersByTimeAsync(0);
    expect(old.writes).toEqual(['ble_start']);
    await ble.bleJoystickDisconnect();
    await ble.bleJoystickConnect(current.device.id);
    await vi.runAllTimersAsync();
    expect((await outcome)?.message).toContain('not connected');
    expect(old.writes).toEqual(['ble_start']);
    expect(current.writes).toEqual([]);
    expect(ble.isBleJoystickConnected()).toBe(true);
  });

  it('does not send remaining raw joystick chunks after a connection change', async () => {
    const old = fakeDevice();
    const current = fakeDevice();
    manager.connectToDevice.mockResolvedValueOnce(old.device).mockResolvedValueOnce(current.device);
    await ble.bleJoystickConnect(old.device.id);
    let releaseWrite!: () => void;
    old.device.writeCharacteristicWithoutResponseForService.mockImplementationOnce(() =>
      new Promise<void>(resolve => { releaseWrite = resolve; }));
    // Both negative velocities make a 21-byte, two-chunk raw JSON message.
    const move = ble.bleJoystickMove({ x_w: -1.25, y_v: -1.25, z_g: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await ble.bleJoystickDisconnect();
    await ble.bleJoystickConnect(current.device.id);
    releaseWrite();
    await move;
    expect(old.device.writeCharacteristicWithoutResponseForService).toHaveBeenCalledTimes(1);
    expect(current.writes).toEqual([]);
    expect(ble.isBleJoystickConnected()).toBe(true);
  });

  it.each(['bleJoystickDisconnect', 'bleJoystickStopAndDisconnect'] as const)(
    '%s cancels a connection that completes after the mapping screen disconnects', async cleanup => {
    const { device } = fakeDevice();
    let finishConnect!: (value: typeof device) => void;
    manager.connectToDevice.mockImplementationOnce(() => new Promise(resolve => { finishConnect = resolve; }));
    const connecting = ble.bleJoystickConnect(device.id);
    await vi.advanceTimersByTimeAsync(0);
    await ble[cleanup]();
    finishConnect(device);
    expect(await connecting).toBe(false);
    expect(ble.isBleJoystickConnected()).toBe(false);
    expect(device.cancelConnection).toHaveBeenCalledOnce();
    expect(device.discoverAllServicesAndCharacteristics).not.toHaveBeenCalled();
  });

  it('does not restore a connection after disconnecting during service discovery', async () => {
    const { device } = fakeDevice();
    let finishDiscovery!: (value: typeof device) => void;
    manager.connectToDevice.mockResolvedValue(device);
    device.discoverAllServicesAndCharacteristics.mockImplementationOnce(() =>
      new Promise(resolve => { finishDiscovery = resolve; }));
    const connecting = ble.bleJoystickConnect(device.id);
    await vi.advanceTimersByTimeAsync(0);
    await ble.bleJoystickDisconnect();
    finishDiscovery(device);
    expect(await connecting).toBe(false);
    expect(ble.isBleJoystickConnected()).toBe(false);
    expect(device.cancelConnection).toHaveBeenCalledOnce();
    expect(manager.onDeviceDisconnected).not.toHaveBeenCalled();
  });

  it('an old failed connect cannot disconnect a newer successful connection', async () => {
    const { device } = fakeDevice();
    let failOldConnect!: (error: Error) => void;
    manager.connectToDevice.mockImplementationOnce(() =>
      new Promise((_resolve, reject) => { failOldConnect = reject; })).mockResolvedValueOnce(device);
    const oldConnect = ble.bleJoystickConnect('old-mower');
    await vi.advanceTimersByTimeAsync(0);
    expect(await ble.bleJoystickConnect(device.id)).toBe(true);
    failOldConnect(new Error('Connection cancelled'));
    expect(await oldConnect).toBe(false);
    expect(ble.isBleJoystickConnected()).toBe(true);
    expect(device.cancelConnection).not.toHaveBeenCalled();
  });

  it('a superseded connect cannot cancel the newer connection to the same native device ID', async () => {
    const old = fakeDevice();
    const current = fakeDevice();
    let finishOldConnect!: (value: typeof old.device) => void;
    manager.connectToDevice.mockImplementationOnce(() =>
      new Promise(resolve => { finishOldConnect = resolve; })).mockResolvedValueOnce(current.device);
    const oldConnect = ble.bleJoystickConnect(old.device.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(await ble.bleJoystickConnect(current.device.id)).toBe(true);
    finishOldConnect(old.device);
    expect(await oldConnect).toBe(false);
    expect(old.device.cancelConnection).not.toHaveBeenCalled();
    expect(old.device.discoverAllServicesAndCharacteristics).not.toHaveBeenCalled();
    expect(ble.isBleJoystickConnected()).toBe(true);
  });

  it('waits for the queued stop write before disconnecting', async () => {
    const { device, writes } = fakeDevice();
    manager.connectToDevice.mockResolvedValue(device);
    await ble.bleJoystickConnect(device.id);
    let finishMove!: () => void;
    device.writeCharacteristicWithoutResponseForService.mockImplementationOnce(() =>
      new Promise<void>(resolve => { finishMove = () => { writes.push('move'); resolve(); }; }));
    device.cancelConnection.mockImplementationOnce(async () => { writes.push('disconnect'); });
    const move = ble.bleJoystickMove({ x_w: 0.1, y_v: 0.2, z_g: 0 });
    await vi.advanceTimersByTimeAsync(0);
    const queuedMove = ble.bleJoystickMove({ x_w: 0.9, y_v: 0.9, z_g: 0 });
    const cleanup = ble.bleJoystickStopAndDisconnect();
    expect(device.cancelConnection).not.toHaveBeenCalled();
    finishMove();
    await Promise.all([move, queuedMove, cleanup]);
    expect(writes).toEqual(['move', '{"stop_move":null}', 'disconnect']);
    expect(ble.isBleJoystickConnected()).toBe(false);
  });

  it.each([false, true])('old cleanup cannot disconnect a newer session (reuse device: %s)', async reuseDevice => {
    const old = fakeDevice();
    const current = reuseDevice ? old : fakeDevice();
    manager.connectToDevice.mockResolvedValueOnce(old.device).mockResolvedValueOnce(current.device);
    await ble.bleJoystickConnect(old.device.id);
    let finishMove!: () => void;
    old.device.writeCharacteristicWithoutResponseForService.mockImplementationOnce(() =>
      new Promise<void>(resolve => { finishMove = resolve; }));
    const move = ble.bleJoystickMove({ x_w: 0.1, y_v: 0.2, z_g: 0 });
    await vi.advanceTimersByTimeAsync(0);
    const cleanup = ble.bleJoystickStopAndDisconnect();
    if (!reuseDevice) await ble.bleJoystickDisconnect();
    expect(await ble.bleJoystickConnect(current.device.id)).toBe(true);
    finishMove();
    await Promise.all([move, cleanup]);
    expect(current.device.cancelConnection).not.toHaveBeenCalled();
    expect(ble.isBleJoystickConnected()).toBe(true);
  });
});
