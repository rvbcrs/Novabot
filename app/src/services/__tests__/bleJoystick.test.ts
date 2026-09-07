import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    notify(0, 'ble_start');
    notify(0, '{"type":"save_map_respond",');
    const bb = new Uint8Array(20);
    bb.set([0x62, 0x62]);
    bb.set([0x11, 12, 34, 5, 67], 15);
    notify(1, bb);
    const cc = new Uint8Array(20);
    cc.set([0x63, 0x63, 1, 1, 57]);
    notify(0, cc); // telemetry also leaves an interleaved JSON frame intact
    notify(0, '"message":{"result":0,"value":0}}');
    notify(0, 'ble_end');
    expect(telemetry.mock.calls[0][0]).toEqual({ position: { x: -12.34, y: -5.67 }, closedCycle: false });
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
});
