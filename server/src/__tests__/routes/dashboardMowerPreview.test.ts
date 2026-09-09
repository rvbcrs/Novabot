import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(true),
  writeRawPublish: vi.fn().mockReturnValue(false),
  getBrokerDiagnostics: vi.fn().mockReturnValue({}),
  startMqttBroker: vi.fn(),
}));

vi.mock('../../dashboard/socketHandler.js', () => ({
  getRecentLogs: vi.fn().mockReturnValue([]),
  forwardToDashboard: vi.fn(),
  onLogEntry: vi.fn(),
  emitMapsChanged: vi.fn(),
  emitDeviceOnline: vi.fn(),
  emitDeviceOffline: vi.fn(),
  emitTrailClear: vi.fn(),
  emitCoveredLanes: vi.fn(),
  setDemoModeChecker: vi.fn(),
  setOutlineEmitter: vi.fn(),
  initBleLogger: vi.fn(),
  sendBleLogHistory: vi.fn(),
  pushMqttLog: vi.fn(),
  emitOtaEvent: vi.fn(),
  emitPinEvent: vi.fn(),
  emitExtendedEvent: vi.fn(),
  emitCommandRespond: vi.fn(),
}));

vi.mock('../../mqtt/mapSync.js', () => ({
  requestMapList: vi.fn(),
  requestMapOutline: vi.fn(),
  publishToDevice: vi.fn(),
  publishRawToDevice: vi.fn(),
  publishEncryptedOnTopic: vi.fn(),
  publishToTopic: vi.fn(),
  goToChargePayload: vi.fn(),
  getNextCmdNum: vi.fn().mockReturnValue(1),
  initMapSync: vi.fn(),
  handleMapMessage: vi.fn(),
  handleExtendedResponse: vi.fn(),
  handleDeviceResponse: vi.fn(),
  onDeviceResponse: vi.fn(),
  offDeviceResponse: vi.fn(),
  publishToExtended: vi.fn(),
  onExtendedResponse: vi.fn(),
  offExtendedResponse: vi.fn(),
  notifyRespond: vi.fn(),
  setDemoInterceptor: vi.fn(),
  onMowerConnected: vi.fn(),
}));

vi.mock('../../mqtt/extendedCommands.js', () => ({
  publishExtendedCommand: vi.fn(),
}));

vi.mock('../../mqtt/mapConverter.js', () => ({
  generateMapZipFromDb: vi.fn(),
  gpsToLocal: vi.fn(),
  localToGps: vi.fn(),
  parseMapZip: vi.fn(),
}));

vi.mock('../../services/demoSimulator.js', () => ({
  isDemoMode: vi.fn().mockReturnValue(false),
  setDemoMode: vi.fn(),
  getDemoStatus: vi.fn().mockReturnValue({}),
  setDemoInterceptor: vi.fn(),
}));

vi.mock('../../services/mowerIpDiscovery.js', () => ({
  resolveMowerIp: vi.fn().mockResolvedValue(null),
  startMowerIpDiscovery: vi.fn(),
}));

vi.mock('../../services/anchor.js', () => ({
  getPolygonAnchor: vi.fn().mockReturnValue({ x: 0, y: 0, orientation: 1.5 }),
}));

vi.mock('../../services/mowerFileCapability.js', () => ({
  getMowerFileCapability: vi.fn().mockReturnValue({
    mowerFileApplySupported: false,
    isOpenNova: false,
    mowerVersion: null,
    reason: null,
  }),
  isOpenNovaMower: () => true,
  supportsMowerFileWrites: () => true,
  UNSUPPORTED_FIRMWARE_REASON: 'unsupported_firmware',
  UNSUPPORTED_FIRMWARE_MSG_KEY: 'requiresOpenNovaFirmware',
}));

import { deviceSettingsRepo } from '../../db/repositories/index.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { dashboardRouter } from '../../routes/dashboard.js';
import {
  COVERAGE_PLANNER_RADIUS_KEY,
} from '../../services/coveragePlannerRadius.js';
import * as extendedCommands from '../../mqtt/extendedCommands.js';
import * as mapSync from '../../mqtt/mapSync.js';
import { getMowerFileCapability } from '../../services/mowerFileCapability.js';

/** Encode a preview-path object the way stock mqtt_node does: value.data = UTF-8 byte array. */
function nativePreviewRespond(pathObj: Record<string, unknown>) {
  return {
    type: 'get_preview_cover_path_respond',
    message: { result: 0, value: { data: Array.from(Buffer.from(JSON.stringify(pathObj), 'utf-8')) } },
  };
}

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);

const SN = 'LFINTEST';

beforeEach(() => {
  vi.clearAllMocks();
  deviceCache.clear();
  vi.mocked(getMowerFileCapability).mockReturnValue({
    mowerFileApplySupported: false,
    isOpenNova: false,
    mowerVersion: null,
    reason: null,
  });
});

describe('POST /api/dashboard/native-preview-path/:sn', () => {
  it('is removed from the standard server so stale clients cannot run native generation', async () => {
    const res = await request(app)
      .post(`/api/dashboard/native-preview-path/${SN}`)
      .send({ canonical: 'map1', startLocal: { x: 11, y: 2 }, cov_direction: 90 });

    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({
      ok: false,
      source: 'removed',
      error: expect.stringContaining('native coverage preview has been removed'),
    });
    expect(mapSync.publishToDevice).not.toHaveBeenCalled();
    expect(mapSync.publishToExtended).not.toHaveBeenCalled();
  });
});

describe('coverage planner radius', () => {
  it('persists a coverage planner radius and dispatches the mower extended command', async () => {
    const res = await request(app)
      .put(`/api/dashboard/coverage-planner-radius/${SN}`)
      .send({ radius: 0.35, force: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      radius: 0.35,
      mowerCommand: 'sent',
    });
    expect(deviceCache.get(SN)?.get(COVERAGE_PLANNER_RADIUS_KEY)).toBe('0.35');
    expect(deviceSettingsRepo.findBySn(SN)).toEqual([
      expect.objectContaining({ key: COVERAGE_PLANNER_RADIUS_KEY, value: '0.35' }),
    ]);
    expect(extendedCommands.publishExtendedCommand).toHaveBeenCalledWith(SN, {
      set_coverage_planner_radius: { radius: 0.35, force: true },
    });
  });

  it('rejects unsafe coverage planner radii', async () => {
    const res = await request(app)
      .put(`/api/dashboard/coverage-planner-radius/${SN}`)
      .send({ radius: 0.05 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: expect.stringContaining('radius') });
    expect(extendedCommands.publishExtendedCommand).not.toHaveBeenCalled();
  });
});

describe('POST /api/dashboard/refresh-preview-path/:sn', () => {
  it('fetches the preview over plain MQTT (like the Novabot app) on stock firmware', async () => {
    // Stock firmware (is_opennova=false) has no extended_commands.py backchannel,
    // so the preview must be fetched the way the real app does it: a plain-MQTT
    // get_preview_cover_path, with the byte-array value.data response decoded.
    let deviceHandler: ((data: Record<string, unknown>) => void) | null = null;
    let extendedHandler: ((data: Record<string, unknown>) => void) | null = null;

    vi.mocked(mapSync.onDeviceResponse).mockImplementation((_sn, handler) => { deviceHandler = handler; });
    vi.mocked(mapSync.offDeviceResponse).mockImplementation((_sn, handler) => {
      if (deviceHandler === handler) deviceHandler = null;
    });
    vi.mocked(mapSync.onExtendedResponse).mockImplementation((_sn, handler) => { extendedHandler = handler; });
    vi.mocked(mapSync.offExtendedResponse).mockImplementation((_sn, handler) => {
      if (extendedHandler === handler) extendedHandler = null;
    });
    vi.mocked(mapSync.publishToDevice).mockImplementation((_sn, command) => {
      if ('generate_preview_cover_path' in command) {
        setTimeout(() => deviceHandler?.({
          type: 'generate_preview_cover_path_respond', message: { result: 0, value: {} },
        }), 0);
      } else if ('get_preview_cover_path' in command) {
        setTimeout(() => deviceHandler?.(nativePreviewRespond({ '1': { '0': '1.00 2.00,3.00 4.00' } })), 0);
      }
    });
    // If the (buggy) extended path is still used, let it answer so the request
    // returns fast and the assertions below fail cleanly instead of timing out.
    vi.mocked(mapSync.publishToExtended).mockImplementation(() => {
      setTimeout(() => extendedHandler?.({
        get_preview_cover_path_respond: { result: 0, value: { '1': { '0': '1.00 2.00,3.00 4.00' } } },
      }), 0);
    });

    const res = await request(app)
      .post(`/api/dashboard/refresh-preview-path/${SN}`)
      .send({ map_ids: 11, cov_direction: 45 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      count: 1,
      source: 'mower',
      paths: [{ id: '1_0', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }],
    });
    // Plain-MQTT fetch, exactly like the app — NOT the extended backchannel.
    expect(mapSync.publishToDevice).toHaveBeenCalledWith(SN, {
      get_preview_cover_path: { map_name: 'all' },
    });
    expect(mapSync.publishToExtended).not.toHaveBeenCalled();
  });

  it('uses the stock preview command response before fetching the preview path', async () => {
    let deviceHandler: ((data: Record<string, unknown>) => void) | null = null;
    let extendedHandler: ((data: Record<string, unknown>) => void) | null = null;

    vi.mocked(mapSync.onDeviceResponse).mockImplementation((_sn, handler) => {
      deviceHandler = handler;
    });
    vi.mocked(mapSync.offDeviceResponse).mockImplementation((_sn, handler) => {
      if (deviceHandler === handler) deviceHandler = null;
    });
    vi.mocked(mapSync.onExtendedResponse).mockImplementation((_sn, handler) => {
      extendedHandler = handler;
    });
    vi.mocked(mapSync.offExtendedResponse).mockImplementation((_sn, handler) => {
      if (extendedHandler === handler) extendedHandler = null;
    });
    vi.mocked(mapSync.publishToDevice).mockImplementation((_sn, command) => {
      if ('generate_preview_cover_path' in command) {
        setTimeout(() => deviceHandler?.({
          type: 'generate_preview_cover_path_respond',
          message: { result: 0, value: {} },
        }), 0);
      } else if ('get_preview_cover_path' in command) {
        setTimeout(() => deviceHandler?.(nativePreviewRespond({ '1': { '0': '1.00 2.00,3.00 4.00' } })), 0);
      }
    });

    const res = await request(app)
      .post(`/api/dashboard/refresh-preview-path/${SN}`)
      .send({ map_ids: 11, cov_direction: 45 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      count: 1,
      source: 'mower',
      cmd_num: expect.any(Number),
      ackTimeout: false,
      generateAckMs: expect.any(Number),
      fetchMs: expect.any(Number),
      durationMs: expect.any(Number),
      cachedAt: expect.any(Number),
      paths: [{ id: '1_0', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }],
    });
    expect(mapSync.onDeviceResponse).toHaveBeenCalledWith(SN, expect.any(Function));
    expect(mapSync.offDeviceResponse).toHaveBeenCalledWith(SN, expect.any(Function));
    expect(mapSync.publishToDevice).toHaveBeenCalledWith(SN, {
      generate_preview_cover_path: expect.objectContaining({
        map_ids: 11,
        cov_direction: 45,
      }),
    });
    expect(mapSync.publishToDevice).toHaveBeenCalledWith(SN, {
      get_preview_cover_path: { map_name: 'all' },
    });
    expect(mapSync.publishToExtended).not.toHaveBeenCalled();
  });

  it('retries generate_preview_cover_path with a fresh cmd_num when the planner returns result:1 (busy)', async () => {
    // The coverage planner is single-threaded; a generate fired while one is still
    // planning returns result:1 ("couldn't compute"). The server must retry with a
    // FRESH cmd_num (firmware dedups on cmd_num) instead of surfacing a hard error.
    process.env.PREVIEW_GEN_RETRY_BACKOFF_MS = '0'; // no real wait between retries
    let deviceHandler: ((data: Record<string, unknown>) => void) | null = null;
    vi.mocked(mapSync.onDeviceResponse).mockImplementation((_sn, handler) => { deviceHandler = handler; });
    vi.mocked(mapSync.offDeviceResponse).mockImplementation((_sn, handler) => {
      if (deviceHandler === handler) deviceHandler = null;
    });
    vi.mocked(mapSync.onExtendedResponse).mockImplementation(() => {});
    vi.mocked(mapSync.offExtendedResponse).mockImplementation(() => {});

    const genCmdNums: number[] = [];
    vi.mocked(mapSync.publishToDevice).mockImplementation((_sn, command) => {
      const c = command as { generate_preview_cover_path?: { cmd_num: number } };
      if (c.generate_preview_cover_path) {
        genCmdNums.push(c.generate_preview_cover_path.cmd_num);
        // First attempt: planner busy (result:1). Retry: success (result:0).
        const result = genCmdNums.length === 1 ? 1 : 0;
        setTimeout(() => deviceHandler?.({
          type: 'generate_preview_cover_path_respond', message: { result, value: null },
        }), 0);
      } else if ('get_preview_cover_path' in command) {
        setTimeout(() => deviceHandler?.(nativePreviewRespond({ '1': { '0': '1.00 2.00,3.00 4.00' } })), 0);
      }
    });

    const res = await request(app)
      .post(`/api/dashboard/refresh-preview-path/${SN}`)
      .send({ map_ids: 11, cov_direction: 60 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, count: 1 });
    // It retried: two generate calls with DISTINCT cmd_nums.
    expect(genCmdNums).toHaveLength(2);
    expect(genCmdNums[0]).not.toBe(genCmdNums[1]);

    delete process.env.PREVIEW_GEN_RETRY_BACKOFF_MS;
  });

  it('normalizes auto direction requests by omitting invalid direction sentinels', async () => {
    let deviceHandler: ((data: Record<string, unknown>) => void) | null = null;
    let extendedHandler: ((data: Record<string, unknown>) => void) | null = null;

    vi.mocked(mapSync.onDeviceResponse).mockImplementation((_sn, handler) => {
      deviceHandler = handler;
    });
    vi.mocked(mapSync.offDeviceResponse).mockImplementation((_sn, handler) => {
      if (deviceHandler === handler) deviceHandler = null;
    });
    vi.mocked(mapSync.onExtendedResponse).mockImplementation((_sn, handler) => {
      extendedHandler = handler;
    });
    vi.mocked(mapSync.offExtendedResponse).mockImplementation((_sn, handler) => {
      if (extendedHandler === handler) extendedHandler = null;
    });
    vi.mocked(mapSync.publishToDevice).mockImplementation((_sn, command) => {
      if ('generate_preview_cover_path' in command) {
        setTimeout(() => deviceHandler?.({
          type: 'generate_preview_cover_path_respond',
          message: { result: 0, value: {} },
        }), 0);
      } else if ('get_preview_cover_path' in command) {
        setTimeout(() => deviceHandler?.(nativePreviewRespond({ '1': { '0': '1.00 2.00,3.00 4.00' } })), 0);
      }
    });

    const res = await request(app)
      .post(`/api/dashboard/refresh-preview-path/${SN}`)
      .send({ map_ids: 1, cov_direction: -1 });

    expect(res.status).toBe(200);
    const payload = vi.mocked(mapSync.publishToDevice).mock.calls[0]?.[1] as {
      generate_preview_cover_path?: Record<string, unknown>;
    };
    expect(payload.generate_preview_cover_path).toMatchObject({ map_ids: 1 });
    expect(payload.generate_preview_cover_path).not.toHaveProperty('cov_direction');
    expect(payload.generate_preview_cover_path).not.toHaveProperty('specify_direction');
  });

  it('keeps the extended_commands backchannel on OpenNova/custom firmware', async () => {
    // OpenNova firmware has extended_commands.py, which reads the preview file in
    // Python and sidesteps the stock mqtt_node buffer overflow on large maps.
    vi.mocked(getMowerFileCapability).mockReturnValue({
      mowerFileApplySupported: true,
      isOpenNova: true,
      mowerVersion: 'v6.0.2-custom-24',
      reason: null,
    });

    let deviceHandler: ((data: Record<string, unknown>) => void) | null = null;
    let extendedHandler: ((data: Record<string, unknown>) => void) | null = null;

    vi.mocked(mapSync.onDeviceResponse).mockImplementation((_sn, handler) => { deviceHandler = handler; });
    vi.mocked(mapSync.offDeviceResponse).mockImplementation((_sn, handler) => {
      if (deviceHandler === handler) deviceHandler = null;
    });
    vi.mocked(mapSync.onExtendedResponse).mockImplementation((_sn, handler) => { extendedHandler = handler; });
    vi.mocked(mapSync.offExtendedResponse).mockImplementation((_sn, handler) => {
      if (extendedHandler === handler) extendedHandler = null;
    });
    vi.mocked(mapSync.publishToDevice).mockImplementation((_sn, command) => {
      if ('generate_preview_cover_path' in command) {
        setTimeout(() => deviceHandler?.({
          type: 'generate_preview_cover_path_respond', message: { result: 0, value: {} },
        }), 0);
      }
    });
    vi.mocked(mapSync.publishToExtended).mockImplementation(() => {
      setTimeout(() => extendedHandler?.({
        get_preview_cover_path_respond: { result: 0, value: { '1': { '0': '1.00 2.00,3.00 4.00' } } },
      }), 0);
    });

    const res = await request(app)
      .post(`/api/dashboard/refresh-preview-path/${SN}`)
      .send({ map_ids: 11, cov_direction: 45 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      count: 1,
      source: 'mower',
      paths: [{ id: '1_0', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }],
    });
    expect(mapSync.publishToExtended).toHaveBeenCalledWith(SN, {
      get_preview_cover_path: { map_name: 'all' },
    });
    expect(mapSync.publishToDevice).not.toHaveBeenCalledWith(SN, {
      get_preview_cover_path: { map_name: 'all' },
    });
  });
});
