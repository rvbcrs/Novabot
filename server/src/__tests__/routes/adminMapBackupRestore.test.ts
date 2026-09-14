/**
 * Route tests — map-backup /contents and /restore endpoints
 *
 * Tests the overwrite-vs-skip conflict resolution added to:
 *   GET  /api/admin-status/map-backups/:sn/:filename/contents
 *   POST /api/admin-status/map-backups/:sn/:filename/restore
 *
 * Heavy deps (broker, socketHandler, mapSync, mdns, etc.) are mocked so the
 * test stays fast and avoids circular-init issues.
 *
 * The mapBackup service and parseMapZip are mocked so we don't need real ZIP
 * files on disk.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { isFrameUnvalidated, clearFrameUnvalidated } from '../../services/frameValidation.js';

// ── Mock heavy deps BEFORE any import of adminStatus.ts ─────────────────────

vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(false),
  writeRawPublish: vi.fn().mockReturnValue(false),
  getBrokerDiagnostics: vi.fn().mockReturnValue({}),
  startMqttBroker: vi.fn(),
  banishSn: vi.fn(),
  unbanSn: vi.fn(),
  listBannedSns: vi.fn().mockReturnValue([]),
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
  publishToExtended: vi.fn(),
  onExtendedResponse: vi.fn(),
  offExtendedResponse: vi.fn(),
  notifyRespond: vi.fn(),
  setDemoInterceptor: vi.fn(),
  onMowerConnected: vi.fn(),
  awaitCommand: vi.fn(),
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

vi.mock('../../services/mdnsAdvertiser.js', () => ({
  startMdnsAdvertiser: vi.fn(),
  stopMdnsAdvertiser: vi.fn(),
  getActiveAdvertisement: vi.fn().mockReturnValue(null),
}));

// ── Mock mapBackup service ────────────────────────────────────────────────────
// We don't want real file I/O. backupPath just needs to return a path string;
// the real fs.existsSync is mocked per-test via vi.spyOn on the 'fs' module.
// NOTE: vi.mock factories are hoisted to the top of the file by vitest, so we
// cannot reference variables defined in the test body. Use vi.fn() inline.

vi.mock('../../services/mapBackup.js', () => ({
  listBackups: vi.fn().mockReturnValue([]),
  backupPath: vi.fn().mockReturnValue('/fake/backup.zip'),
  scheduleSnapshot: vi.fn(),
  regenerateLatestZipFromBackup: vi.fn().mockReturnValue('/fake/_latest.zip'),
}));

vi.mock('../../services/anchor.js', () => ({
  getPolygonAnchor: vi.fn().mockReturnValue(null),
}));

vi.mock('../../mqtt/sensorData.js', () => ({
  deviceCache: new Map<string, Map<string, string>>(),
}));

// ── Mock fs.existsSync (used by the endpoints to check the ZIP exists) ────────
import fs from 'fs';
const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);

// ── Mock parseMapZip + polygonArea ────────────────────────────────────────────
// Same hoisting constraint: use vi.fn() inline inside the factory.

vi.mock('../../mqtt/mapConverter.js', () => ({
  generateMapZipFromDb: vi.fn(),
  gpsToLocal: vi.fn(),
  localToGps: vi.fn(),
  parseMapZip: vi.fn(),
  polygonArea: vi.fn().mockReturnValue(10),
}));

// ── Now import the router + deps ─────────────────────────────────────────────
import { adminStatusRouter } from '../../routes/adminStatus.js';
import { mapRepo } from '../../db/repositories/index.js';
import * as mapConverter from '../../mqtt/mapConverter.js';
import type { MapArea } from '../../mqtt/mapConverter.js'; // type-only import safe alongside vi.mock
import * as broker from '../../mqtt/broker.js';
import * as anchor from '../../services/anchor.js';
import * as mapSync from '../../mqtt/mapSync.js';
import * as mapBackupModule from '../../services/mapBackup.js';
import { deviceCache } from '../../mqtt/sensorData.js';

// Grab typed references to the mocked functions
const mockParseMapZip = vi.mocked(mapConverter.parseMapZip);

const app = express();
app.use(express.json());
app.use('/api/admin-status', adminStatusRouter);

// Eén luisteraar voor dit hele bestand. `request(server)` laat supertest per
// verzoek een NIEUWE efemere poort openen, en dat botst onder belasting met een
// andere luisteraar: het antwoord komt dan ergens anders vandaan. Bewezen op
// 2026-09-14, een 403 op /reanchor zonder x-powered-by en zonder serverkant-
// regel in de trace, wat drie beta-builds heeft gekost.
const server = app.listen(0);
afterAll(() => new Promise<void>(r => { server.close(() => r()); }));

// ── Helpers ───────────────────────────────────────────────────────────────────

const SN = 'LFIN2230700238';
const FILENAME = '2026-04-29T12-00-00.zip';

/** A minimal work-area MapArea with enough points. */
function makeWorkArea(mapIndex = 0): MapArea {
  return {
    type: 'work',
    mapIndex,
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
  } as MapArea;
}

/** Seed a row into the DB using mapRepo.create directly. */
function seedMap(canonicalName: string, type = 'work') {
  mapRepo.create({
    map_id: uuidv4(),
    mower_sn: SN,
    map_name: canonicalName,
    file_name: canonicalName + '_work.csv',
    map_area: JSON.stringify([{ x: 0, y: 0 }, { x: 1, y: 1 }]),
    map_max_min: JSON.stringify({ minX: 0, maxX: 1, minY: 0, maxY: 1 }),
    map_type: type,
    canonical_name: canonicalName,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /map-backups/:sn/:filename/contents', () => {
  beforeEach(() => {
    existsSpy.mockReturnValue(true);
  });

  it('flags existsInDb=false when canonical row is NOT in DB', async () => {
    const area = makeWorkArea(0);
    mockParseMapZip.mockReturnValueOnce({ areas: [area], chargingPose: { x: 0, y: 0, orientation: 0 } });

    const res = await request(server)
      .get(`/api/admin-status/map-backups/${SN}/${FILENAME}/contents`);

    expect(res.status).toBe(200);
    expect(res.body.work).toHaveLength(1);
    expect(res.body.work[0].canonicalName).toBe('map0');
    expect(res.body.work[0].existsInDb).toBe(false);
  });

  it('flags existsInDb=true when canonical row IS in DB', async () => {
    // Seed the row before the request
    seedMap('map0', 'work');

    const area = makeWorkArea(0);
    mockParseMapZip.mockReturnValueOnce({ areas: [area], chargingPose: { x: 0, y: 0, orientation: 0 } });

    const res = await request(server)
      .get(`/api/admin-status/map-backups/${SN}/${FILENAME}/contents`);

    expect(res.status).toBe(200);
    expect(res.body.work).toHaveLength(1);
    expect(res.body.work[0].existsInDb).toBe(true);
  });
});

describe('POST /map-backups/:sn/:filename/restore', () => {
  beforeEach(() => {
    existsSpy.mockReturnValue(true);
    clearFrameUnvalidated(SN);
  });

  it('inserts a new row (restored=1) when item does not exist in DB', async () => {
    const area = makeWorkArea(0);
    mockParseMapZip.mockReturnValueOnce({ areas: [area], chargingPose: { x: 0, y: 0, orientation: 0 } });

    const res = await request(server)
      .post(`/api/admin-status/map-backups/${SN}/${FILENAME}/restore`)
      .send({ items: [{ canonicalName: 'map0', type: 'work', overwrite: false }] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.restored).toBe(1);
    expect(res.body.overwritten).toBe(0);
    expect(res.body.skippedExisting).toBe(0);
    expect(res.body.skippedNotInBackup).toBe(0);

    // Row should now exist in DB
    const row = mapRepo.findBySnAndCanonical(SN, 'map0');
    expect(row).toBeDefined();
    expect(row?.map_type).toBe('work');

    // Restoring sets the frame_unvalidated safety flag (locks go_to_charge).
    expect(isFrameUnvalidated(SN)).toBe(true);
  });

  it('skips item (skippedExisting=1) when row EXISTS and overwrite=false', async () => {
    seedMap('map0', 'work');

    const area = makeWorkArea(0);
    mockParseMapZip.mockReturnValueOnce({ areas: [area], chargingPose: { x: 0, y: 0, orientation: 0 } });

    const res = await request(server)
      .post(`/api/admin-status/map-backups/${SN}/${FILENAME}/restore`)
      .send({ items: [{ canonicalName: 'map0', type: 'work', overwrite: false }] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.restored).toBe(0);
    expect(res.body.overwritten).toBe(0);
    expect(res.body.skippedExisting).toBe(1);
    expect(res.body.skippedNotInBackup).toBe(0);
  });

  it('overwrites item (overwritten=1) when row EXISTS and overwrite=true', async () => {
    seedMap('map0', 'work');

    // Confirm the seeded row exists
    const before = mapRepo.findBySnAndCanonical(SN, 'map0');
    expect(before).toBeDefined();
    const oldMapId = before!.map_id;

    const area = makeWorkArea(0);
    mockParseMapZip.mockReturnValueOnce({ areas: [area], chargingPose: { x: 0, y: 0, orientation: 0 } });

    const res = await request(server)
      .post(`/api/admin-status/map-backups/${SN}/${FILENAME}/restore`)
      .send({ items: [{ canonicalName: 'map0', type: 'work', overwrite: true }] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.restored).toBe(0);
    expect(res.body.overwritten).toBe(1);
    expect(res.body.skippedExisting).toBe(0);
    expect(res.body.skippedNotInBackup).toBe(0);

    // Row should still exist but have a new map_id (it was deleted + re-inserted)
    const after = mapRepo.findBySnAndCanonical(SN, 'map0');
    expect(after).toBeDefined();
    expect(after!.map_id).not.toBe(oldMapId);
  });

  it('returns skippedNotInBackup when item is not present in the ZIP', async () => {
    mockParseMapZip.mockReturnValueOnce({ areas: [], chargingPose: { x: 0, y: 0, orientation: 0 } });

    const res = await request(server)
      .post(`/api/admin-status/map-backups/${SN}/${FILENAME}/restore`)
      .send({ items: [{ canonicalName: 'map99', type: 'work', overwrite: false }] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.restored).toBe(0);
    expect(res.body.skippedNotInBackup).toBe(1);
  });

  it('handles mixed items correctly', async () => {
    // map0 already in DB → overwrite
    seedMap('map0', 'work');
    // map1 already in DB → skip
    seedMap('map1', 'work');
    // map2 not in DB → insert

    const areas: MapArea[] = [makeWorkArea(0), makeWorkArea(1), makeWorkArea(2)];
    mockParseMapZip.mockReturnValueOnce({ areas, chargingPose: { x: 0, y: 0, orientation: 0 } });

    const res = await request(server)
      .post(`/api/admin-status/map-backups/${SN}/${FILENAME}/restore`)
      .send({
        items: [
          { canonicalName: 'map0', type: 'work', overwrite: true },
          { canonicalName: 'map1', type: 'work', overwrite: false },
          { canonicalName: 'map2', type: 'work', overwrite: false },
          { canonicalName: 'map99', type: 'work', overwrite: false }, // not in ZIP
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.restored).toBe(1);        // map2
    expect(res.body.overwritten).toBe(1);     // map0
    expect(res.body.skippedExisting).toBe(1); // map1
    expect(res.body.skippedNotInBackup).toBe(1); // map99
  });
});

// ── POST /map-backups/:sn/:filename/restore-and-realign (Novabot-uvf) ─────────

describe('POST /map-backups/:sn/:filename/restore-and-realign', () => {
  beforeEach(() => {
    existsSpy.mockReturnValue(true);
    deviceCache.clear();
    vi.mocked(anchor.getPolygonAnchor).mockReset().mockReturnValue(null);
    vi.mocked(broker.isDeviceOnline).mockReset().mockReturnValue(false);
    vi.mocked(mapSync.publishToExtended).mockReset();
    vi.mocked(mapSync.onExtendedResponse).mockReset();
    vi.mocked(mapSync.offExtendedResponse).mockReset();
    vi.mocked(mapBackupModule.regenerateLatestZipFromBackup)
      .mockReset()
      .mockReturnValue('/fake/_latest.zip');
  });

  function setupGoodBackup() {
    const area = makeWorkArea(0);
    mockParseMapZip.mockReturnValueOnce({ areas: [area], chargingPose: { x: 0, y: 0, orientation: 0 } });
  }

  function setupGps(sn: string, lat = 52.14, lng = 6.23) {
    const sensors = new Map<string, string>();
    sensors.set('gps_latitude', String(lat));
    sensors.set('gps_longitude', String(lng));
    deviceCache.set(sn, sensors);
  }

  it('returns 400 when backup has no unicom (cannot anchor)', async () => {
    setupGoodBackup();
    vi.mocked(anchor.getPolygonAnchor).mockReturnValue(null);

    const res = await request(server)
      .post(`/api/admin-status/map-backups/${SN}/${FILENAME}/restore-and-realign`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('cannot anchor');
  });

  it('returns 400 when mower GPS is not reported', async () => {
    setupGoodBackup();
    vi.mocked(anchor.getPolygonAnchor).mockReturnValue({
      x: -1.21, y: 0.48, orientation: 1.5, orientationSource: 'default',
    });
    // No sensors set in deviceCache

    const res = await request(server)
      .post(`/api/admin-status/map-backups/${SN}/${FILENAME}/restore-and-realign`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('GPS not reported');
  });

  it('returns 404 when mower offline', async () => {
    setupGoodBackup();
    vi.mocked(anchor.getPolygonAnchor).mockReturnValue({
      x: -1.21, y: 0.48, orientation: 1.5, orientationSource: 'default',
    });
    setupGps(SN);
    vi.mocked(broker.isDeviceOnline).mockReturnValue(false);

    const res = await request(server)
      .post(`/api/admin-status/map-backups/${SN}/${FILENAME}/restore-and-realign`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Mower offline');
    expect(res.body.anchor).toEqual(expect.objectContaining({ x: -1.21, y: 0.48 }));
  });

  it(
    'happy path: returns 200 with anchor + gps when sync_map respond ok=0',
    async () => {
      setupGoodBackup();
      vi.mocked(anchor.getPolygonAnchor).mockReturnValue({
        x: -1.21, y: 0.48, orientation: 1.5, orientationSource: 'default',
      });
      setupGps(SN, 52.14088864656, 6.23103579689);
      vi.mocked(broker.isDeviceOnline).mockReturnValue(true);

      // The endpoint registers an onExtendedResponse handler then calls
      // publishToExtended. We fire the simulated mower respond from inside the
      // publishToExtended mock — by then the handler is already in place.
      let registeredHandler: ((data: Record<string, unknown>) => void) | null = null;
      vi.mocked(mapSync.onExtendedResponse).mockImplementation((_sn: string, fn) => {
        registeredHandler = fn as (data: Record<string, unknown>) => void;
      });
      vi.mocked(mapSync.publishToExtended).mockImplementation(() => {
        // Microtask ensures the resolve fires inside the same tick as the
        // request handler's await — keeps the test under default 5s timeout.
        queueMicrotask(() => {
          registeredHandler?.({ sync_map_respond: { result: 0, md5: 'deadbeef' } });
        });
      });

      const res = await request(server)
        .post(`/api/admin-status/map-backups/${SN}/${FILENAME}/restore-and-realign`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.anchor.x).toBeCloseTo(-1.21);
      expect(res.body.anchor.y).toBeCloseTo(0.48);
      expect(res.body.gps).toEqual({ lat: 52.14088864656, lng: 6.23103579689 });
    },
  );

  it('returns 500 when regenerateLatestZipFromBackup fails', async () => {
    setupGoodBackup();
    vi.mocked(anchor.getPolygonAnchor).mockReturnValue({
      x: -1.21, y: 0.48, orientation: 1.5, orientationSource: 'default',
    });
    setupGps(SN);
    vi.mocked(broker.isDeviceOnline).mockReturnValue(true);
    vi.mocked(mapBackupModule.regenerateLatestZipFromBackup).mockReturnValue(null);

    const res = await request(server)
      .post(`/api/admin-status/map-backups/${SN}/${FILENAME}/restore-and-realign`);

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('regenerate');
  });
});

// ── /polygons endpoint — full geometry for ghost preview ─────────────────────
describe('GET /map-backups/:sn/:filename/polygons', () => {
  beforeEach(() => {
    existsSpy.mockReturnValue(true);
  });

  it('returns full polygon points + chargingPose for a valid backup', async () => {
    const work: MapArea = {
      type: 'work',
      mapIndex: 0,
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    } as MapArea;
    mockParseMapZip.mockReturnValueOnce({
      areas: [work],
      chargingPose: { x: -1.21, y: 0.48, orientation: 1.498 },
    });

    const res = await request(server)
      .get(`/api/admin-status/map-backups/${SN}/${FILENAME}/polygons`);

    expect(res.status).toBe(200);
    expect(res.body.maps).toHaveLength(1);
    expect(res.body.maps[0].mapType).toBe('work');
    expect(res.body.maps[0].canonicalName).toBe('map0');
    expect(res.body.maps[0].mapArea).toHaveLength(4);
    expect(res.body.maps[0].mapArea[0]).toEqual({ x: 0, y: 0 });
    expect(res.body.chargingPose).toEqual({ x: -1.21, y: 0.48, orientation: 1.498 });
  });

  it('returns 404 when the backup file is missing', async () => {
    existsSpy.mockReturnValue(false);

    const res = await request(server)
      .get(`/api/admin-status/map-backups/${SN}/${FILENAME}/polygons`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('backup not found');
  });

  it('returns 400 when parseMapZip rejects the file', async () => {
    mockParseMapZip.mockReturnValueOnce(null);

    const res = await request(server)
      .get(`/api/admin-status/map-backups/${SN}/${FILENAME}/polygons`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('failed to parse');
  });

  it('skips polygons with fewer than 2 points', async () => {
    const work: MapArea = {
      type: 'work', mapIndex: 0,
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
    } as MapArea;
    const obstacle: MapArea = {
      type: 'obstacle', mapIndex: 0, subIndex: 0,
      points: [{ x: 0, y: 0 }], // single point — should be filtered
    } as MapArea;
    mockParseMapZip.mockReturnValueOnce({
      areas: [work, obstacle],
      chargingPose: null as unknown as { x: number; y: number; orientation: number },
    });

    const res = await request(server)
      .get(`/api/admin-status/map-backups/${SN}/${FILENAME}/polygons`);

    expect(res.status).toBe(200);
    expect(res.body.maps).toHaveLength(1);
    expect(res.body.maps[0].mapType).toBe('work');
    expect(res.body.chargingPose).toBeNull();
  });
});

// ── /upload endpoint — REMOVED 2026-05-09 (Import ZIP feature dropped) ────────
describe.skip('POST /map-backups/:sn/upload', () => {
  beforeEach(() => {
    existsSpy.mockReturnValue(true);
  });

  it('accepts a structurally-valid Novabot map ZIP', async () => {
    const work: MapArea = {
      type: 'work', mapIndex: 0,
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    } as MapArea;
    mockParseMapZip.mockReturnValueOnce({
      areas: [work],
      chargingPose: { x: -1.21, y: 0.48, orientation: 1.498 },
    });
    // copyFileSync is called server-side to drop the upload into the
    // backup dir. Stub it so tests don't touch disk.
    const copySpy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => undefined);
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as unknown as string);

    const res = await request(server)
      .post(`/api/admin-status/map-backups/${SN}/upload`)
      .attach('zip', Buffer.from('PK\x03\x04fake-zip-bytes'), 'mybackup.zip');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.work).toBe(1);
    expect(res.body.filename).toMatch(/^imported_\d+\.zip$/);
    expect(copySpy).toHaveBeenCalled();
    expect(mkdirSpy).toHaveBeenCalled();

    copySpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  it('rejects non-.zip filenames before parseMapZip runs', async () => {
    mockParseMapZip.mockClear();

    const res = await request(server)
      .post(`/api/admin-status/map-backups/${SN}/upload`)
      .attach('zip', Buffer.from('whatever'), 'photo.jpg');

    // multer's fileFilter throws -> express surfaces it as 500 by default,
    // but the file is not stored either way. We assert the upload did not
    // result in a parsed backup.
    expect([400, 500]).toContain(res.status);
    expect(mockParseMapZip).not.toHaveBeenCalled();
  });

  it('rejects ZIPs that parseMapZip cannot understand', async () => {
    mockParseMapZip.mockReturnValueOnce(null);

    const res = await request(server)
      .post(`/api/admin-status/map-backups/${SN}/upload`)
      .attach('zip', Buffer.from('not a real zip'), 'bogus.zip');

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('parseMapZip');
  });

  it('rejects ZIPs with a (0,0,0) chargingPose stub', async () => {
    const work: MapArea = {
      type: 'work', mapIndex: 0,
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    } as MapArea;
    mockParseMapZip.mockReturnValueOnce({
      areas: [work],
      chargingPose: { x: 0, y: 0, orientation: 0 },
    });

    const res = await request(server)
      .post(`/api/admin-status/map-backups/${SN}/upload`)
      .attach('zip', Buffer.from('zip'), 'stub.zip');

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('(0,0,0)');
  });

  it('rejects ZIPs with a missing chargingPose', async () => {
    const work: MapArea = {
      type: 'work', mapIndex: 0,
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    } as MapArea;
    mockParseMapZip.mockReturnValueOnce({
      areas: [work],
      chargingPose: null as unknown as { x: number; y: number; orientation: number },
    });

    const res = await request(server)
      .post(`/api/admin-status/map-backups/${SN}/upload`)
      .attach('zip', Buffer.from('zip'), 'nopose.zip');

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/charging[Pp]ose/);
  });

  it('rejects ZIPs without a work polygon', async () => {
    const obstacle: MapArea = {
      type: 'obstacle', mapIndex: 0, subIndex: 0,
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
    } as MapArea;
    mockParseMapZip.mockReturnValueOnce({
      areas: [obstacle],
      chargingPose: { x: -1.21, y: 0.48, orientation: 1.498 },
    });

    const res = await request(server)
      .post(`/api/admin-status/map-backups/${SN}/upload`)
      .attach('zip', Buffer.from('zip'), 'obstacleonly.zip');

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('work polygon');
  });

  it('returns 400 when no file is attached', async () => {
    const res = await request(server)
      .post(`/api/admin-status/map-backups/${SN}/upload`)
      .send();

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('No file');
  });
});
