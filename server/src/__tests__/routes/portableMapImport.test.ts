/**
 * Route test — GET /api/admin-status/maps/:sn/export-portable
 *
 * Verifies that the endpoint:
 *   - returns HTTP 200
 *   - sets Content-Type: application/zip
 *   - streams a non-trivial ZIP body (> 200 bytes)
 */
import { describe, it, expect, vi, beforeEach, type MockInstance, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';

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
  applyVerbatimToMower: vi.fn(),
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
  getValidationTrail: vi.fn().mockReturnValue([]),
  clearValidationTrail: vi.fn(),
  getLocalTrail: vi.fn().mockReturnValue([]),
}));

vi.mock('../../mqtt/mapConverter.js', () => ({
  generateMapZipFromDb: vi.fn(),
  gpsToLocal: vi.fn(),
  localToGps: vi.fn(),
  parseMapZip: vi.fn(),
  polygonArea: vi.fn().mockReturnValue(10),
}));

// ── Now import the router + deps ─────────────────────────────────────────────
import { adminStatusRouter } from '../../routes/adminStatus.js';
import { db } from '../../db/database.js';
import { equipmentRepo, mapRepo } from '../../db/repositories/index.js';
import { exportBundle, parseBundle } from '../../services/portableMap.js';
import * as mapSyncMock from '../../mqtt/mapSync.js';
import * as sensorDataMock from '../../mqtt/sensorData.js';

// Inject fake userId to bypass auth middleware
const app = express();
app.use(express.json());

// Eén luisteraar voor dit hele bestand. `request(server)` laat supertest per
// verzoek een NIEUWE efemere poort openen, en dat botst onder belasting met een
// andere luisteraar: het antwoord komt dan ergens anders vandaan. Bewezen op
// 2026-09-14, een 403 op /reanchor zonder x-powered-by en zonder serverkant-
// regel in de trace, wat drie beta-builds heeft gekost.
const server = app.listen(0);
afterAll(() => new Promise<void>(r => { server.close(() => r()); }));
app.use('/api/admin-status', (req, _res, next) => {
  (req as any).userId = 'u';
  next();
}, adminStatusRouter);

const SN = 'LFIN_TEST_EXP';

// ── Seed test data ─────────────────────────────────────────────────────────────
// NOTE: vitest's global setup.ts runs `DELETE FROM` all tables in beforeEach,
// so we must re-seed in beforeEach (not beforeAll) to survive that wipe.

beforeEach(() => {
  db.prepare(
    `INSERT INTO map_calibration (mower_sn, charger_lat, charger_lng) VALUES (?, ?, ?)`,
  ).run(SN, 52.14, 6.23);
  const ins = db.prepare(
    `INSERT INTO maps (mower_sn, map_id, map_name, map_type, file_name, map_area, canonical_name) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run(
    SN, 'm1', 'Tuin', 'work', 'map0_work.csv',
    JSON.stringify([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]),
    'map0',
  );
  ins.run(
    SN, 'u1', 'to charge', 'unicom', 'map0tocharge_unicom.csv',
    JSON.stringify([{ x: -1.21, y: 0.48 }, { x: -0.5, y: 0.0 }]),
    'map0tocharge_unicom',
  );
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /export-portable', () => {
  it('streams a ZIP buffer', async () => {
    // Endpoint awaits MQTT read_map_files for verbatim mower files; in
    // tests the mower is mocked, so wire publishToExtended to immediately
    // fire a result=1 (skip) so export falls back to DB-only payload.
    let capturedListener: ((data: Record<string, unknown>) => void) | null = null;
    vi.mocked(mapSyncMock.onExtendedResponse).mockImplementationOnce((_sn: string, fn: (data: Record<string, unknown>) => void) => {
      capturedListener = fn;
    });
    vi.mocked(mapSyncMock.publishToExtended).mockImplementationOnce(() => {
      setTimeout(() => capturedListener?.({ read_map_files_respond: { result: 1 } }), 5);
    });
    const res = await request(server)
      .get(`/api/admin-status/maps/${SN}/export-portable`)
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    vi.mocked(mapSyncMock.publishToExtended).mockReset();
    vi.mocked(mapSyncMock.onExtendedResponse).mockReset();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/zip/);
    expect((res.body as Buffer).length).toBeGreaterThan(200);
  });

  it('keeps metadata-only inter-map unicoms in the portable bundle manifest', async () => {
    mapRepo.create({
      map_id: 'u-inter-map0-map1',
      mower_sn: SN,
      map_name: 'map0tomap1_0_unicom',
      map_type: 'unicom',
      file_name: 'map0tomap1_0_unicom.csv',
      canonical_name: 'map0tomap1_0_unicom',
      map_area: null,
      file_size: 0,
    });
    let capturedListener: ((data: Record<string, unknown>) => void) | null = null;
    vi.mocked(mapSyncMock.onExtendedResponse).mockImplementationOnce((_sn: string, fn: (data: Record<string, unknown>) => void) => {
      capturedListener = fn;
    });
    vi.mocked(mapSyncMock.publishToExtended).mockImplementationOnce(() => {
      setTimeout(() => capturedListener?.({ read_map_files_respond: { result: 1 } }), 5);
    });

    const res = await request(server)
      .get(`/api/admin-status/maps/${SN}/export-portable`)
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    vi.mocked(mapSyncMock.publishToExtended).mockReset();
    vi.mocked(mapSyncMock.onExtendedResponse).mockReset();
    expect(res.status).toBe(200);
    const parsed = await parseBundle(res.body as Buffer);
    const channel = parsed.unicom.find((u) => u.name === 'map0tomap1_0_unicom');
    expect(channel).toBeDefined();
    expect(channel?.points).toEqual([]);
  });
});

describe('POST /import-portable', () => {
  it('accepts a valid bundle and returns staging_id', async () => {
    // Same MQTT mock dance as export test — short-circuit read_map_files.
    let cap: ((data: Record<string, unknown>) => void) | null = null;
    vi.mocked(mapSyncMock.onExtendedResponse).mockImplementationOnce((_sn: string, fn: (data: Record<string, unknown>) => void) => { cap = fn; });
    vi.mocked(mapSyncMock.publishToExtended).mockImplementationOnce(() => {
      setTimeout(() => cap?.({ read_map_files_respond: { result: 1 } }), 5);
    });
    const expRes = await request(server)
      .get(`/api/admin-status/maps/${SN}/export-portable`)
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    vi.mocked(mapSyncMock.publishToExtended).mockReset();
    vi.mocked(mapSyncMock.onExtendedResponse).mockReset();
    const zip = expRes.body as Buffer;
    const res = await request(server)
      .post(`/api/admin-status/maps/${SN}/import-portable`)
      .attach('bundle', zip, 'fixture.novabotmap');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.stagingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.state).toBe('UPLOADED');
  });

  it('rejects garbage bundle with 400', async () => {
    // Use a different SN so there is no active session from the previous test
    const res = await request(server)
      .post(`/api/admin-status/maps/LFIN_TEST_GARBAGE/import-portable`)
      .attach('bundle', Buffer.from('not a zip'), 'bad.novabotmap');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeVerbatimBundle(sourceSn = SN): Promise<Buffer> {
  return exportBundle({
    sn: sourceSn,
    chargerLat: 52.14,
    chargerLng: 6.23,
    rtkQuality: null,
    chargingPose: { x: 0, y: 0, orientation: 0 },
    workMaps: [{
      canonical: 'map0',
      alias: 'Front',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    }],
    obstacles: [],
    unicom: [{
      canonical: 'map0tocharge_unicom',
      targetMapName: 'charge',
      points: [{ x: -1, y: 0 }, { x: 0, y: 0 }],
    }],
    csvFilesRaw: {
      'map0_work.csv': '0,0\n10,0\n10,10\n0,10\n',
      'map0tocharge_unicom.csv': '-1,0\n0,0\n',
      'map_info.json': JSON.stringify({ charging_pose: { x: 0, y: 0, orientation: 0 } }),
    },
    chargingStationYaml: 'charging_pose: [0, 0, 0]\n',
    mapFilesText: {
      'map.yaml': 'image: map.pgm\nresolution: 0.05\norigin: [0, 0, 0]\n',
    },
    mapFilesB64: {
      'map.pgm': Buffer.from('P5\n1 1\n255\n\0', 'binary').toString('base64'),
    },
  });
}

async function stageVerbatimBundle(targetSn: string): Promise<string> {
  const zip = await makeVerbatimBundle(targetSn);
  const res = await request(server)
    .post(`/api/admin-status/maps/${targetSn}/import-portable`)
    .attach('bundle', zip, 'verbatim.novabotmap');
  expect(res.status).toBe(200);
  expect(res.body.verbatimRestore).toBe(true);
  return res.body.stagingId as string;
}

/** Export a bundle from SN_ANCHOR then upload it to targetSn; returns stagingId. */
async function uploadBundle(targetSn: string): Promise<string> {
  const expRes = await request(server)
    .get(`/api/admin-status/maps/${SN}/export-portable`)
    .buffer()
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  const res = await request(server)
    .post(`/api/admin-status/maps/${targetSn}/import-portable`)
    .attach('bundle', expRes.body as Buffer, 'b.novabotmap');
  expect(res.status).toBe(200);
  return res.body.stagingId as string;
}

/** Seed deviceCache with GPS + RTK + CHARGING values for SN. */
function seedSensorCache(sn: string, lat: string, lng: string): void {
  const m = new Map<string, string>();
  m.set('latitude', lat);
  m.set('longitude', lng);
  m.set('loc_quality', '100');
  m.set('battery_state', 'CHARGING');
  (sensorDataMock.deviceCache as Map<string, Map<string, string>>).set(sn, m);
}

/** Get the shared deviceCache map for a given SN (for mutation in drive tests). */
function getSensorMap(sn: string): Map<string, string> {
  return (sensorDataMock.deviceCache as Map<string, Map<string, string>>).get(sn)!;
}

describe('POST /apply-verbatim firmware capability', () => {
  it('rejects stock firmware before write_map_files is attempted', async () => {
    const sn = 'LFIN_STOCK_VERBATIM';
    equipmentRepo.create({
      equipment_id: `eq-${sn}`,
      mower_sn: sn,
      charger_sn: 'LFIC_STOCK_VERBATIM',
      mower_version: '5.7.1',
    });
    const stagingId = await stageVerbatimBundle(sn);

    vi.mocked(mapSyncMock.applyVerbatimToMower).mockClear();
    const res = await request(server)
      .post(`/api/admin-status/maps/${sn}/import-portable/${stagingId}/apply-verbatim`);

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('MOWER_FILE_WRITE_UNSUPPORTED');
    expect(res.body.error).toMatch(/OpenNova|custom firmware/i);
    expect(vi.mocked(mapSyncMock.applyVerbatimToMower)).not.toHaveBeenCalled();
  });

  it('allows stock firmware to import the server/app copy without mower writes', async () => {
    const sn = 'LFIN_STOCK_SERVER_COPY';
    equipmentRepo.create({
      equipment_id: `eq-${sn}`,
      mower_sn: sn,
      charger_sn: 'LFIC_STOCK_SERVER_COPY',
      mower_version: '5.7.1',
    });
    const stagingId = await stageVerbatimBundle(sn);

    vi.mocked(mapSyncMock.applyVerbatimToMower).mockClear();
    vi.mocked(mapSyncMock.publishToExtended).mockClear();
    const res = await request(server)
      .post(`/api/admin-status/maps/${sn}/import-portable/${stagingId}/import-server-copy`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.mode).toBe('server-copy');
    expect(mapRepo.findAllByMowerSnAndType(sn, 'work')).toHaveLength(1);
    expect(mapRepo.findAllByMowerSnAndType(sn, 'unicom')).toHaveLength(1);
    expect(vi.mocked(mapSyncMock.applyVerbatimToMower)).not.toHaveBeenCalled();
    expect(vi.mocked(mapSyncMock.publishToExtended)).not.toHaveBeenCalled();
  });
});

/** Drive through set-anchor for a given SN (sensors already seeded). */
async function runSetAnchor(sn: string, stagingId: string): Promise<void> {
  const res = await request(server)
    .post(`/api/admin-status/maps/${sn}/import-portable/${stagingId}/set-anchor`);
  expect(res.status).toBe(200);
}

// ── Task 11: POST /set-anchor ──────────────────────────────────────────────

// SKIP: legacy wizard flow predates drive-first state machine. New
// exact-restore path (apply-exact) bypasses set-anchor/start-drive/preview/
// confirm. Rewrite when re-asserting wizard behaviour.
describe.skip('POST /set-anchor', () => {
  it('snapshots RTK pose when mower at dock', async () => {
    const sn = 'LFIN_T11A';
    db.prepare(`INSERT OR IGNORE INTO map_calibration (mower_sn, charger_lat, charger_lng) VALUES (?, ?, ?)`)
      .run(sn, 52.14, 6.23);
    const stagingId = await uploadBundle(sn);
    seedSensorCache(sn, '52.140888', '6.231036');

    const res = await request(server)
      .post(`/api/admin-status/maps/${sn}/import-portable/${stagingId}/set-anchor`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ANCHOR_SET');
    expect(res.body.newCharger.lat).toBeCloseTo(52.140888, 6);
  });

  it('returns 409 when no GPS in sensor cache', async () => {
    const sn = 'LFIN_T11B';
    db.prepare(`INSERT OR IGNORE INTO map_calibration (mower_sn, charger_lat, charger_lng) VALUES (?, ?, ?)`)
      .run(sn, 52.14, 6.23);
    const stagingId = await uploadBundle(sn);
    // No cache entry for this SN
    (sensorDataMock.deviceCache as Map<string, Map<string, string>>).delete(sn);

    const res = await request(server)
      .post(`/api/admin-status/maps/${sn}/import-portable/${stagingId}/set-anchor`);
    expect(res.status).toBe(409);
  });

  it('returns 404 for unknown stagingId', async () => {
    const res = await request(server)
      .post(`/api/admin-status/maps/LFIN_T11C/import-portable/nonexistent-id/set-anchor`);
    expect(res.status).toBe(404);
  });
});

// ── Task 12: POST /start-drive ────────────────────────────────────────────

describe.skip('POST /start-drive', () => {
  it('fires calibration_drive and derives heading on success', async () => {
    const sn = 'LFIN_T12A';
    db.prepare(`INSERT OR IGNORE INTO map_calibration (mower_sn, charger_lat, charger_lng) VALUES (?, ?, ?)`)
      .run(sn, 52.14, 6.23);
    const stagingId = await uploadBundle(sn);
    seedSensorCache(sn, '52.140888', '6.231036');
    await runSetAnchor(sn, stagingId);

    const sensorMap = getSensorMap(sn);

    // Configure onExtendedResponse mock to capture the listener
    let capturedListener: ((data: Record<string, unknown>) => void) | null = null;
    vi.mocked(mapSyncMock.onExtendedResponse).mockImplementation((_sn: string, fn: (data: Record<string, unknown>) => void) => {
      capturedListener = fn;
    });

    // Configure publishToExtended to simulate the mower driving 1m east then firing respond
    vi.mocked(mapSyncMock.publishToExtended).mockImplementation((_sn: string, _cmd: unknown) => {
      setTimeout(() => {
        // Move the sensor cache position 1m east
        const cosLat = Math.cos((52.140888 * Math.PI) / 180);
        const dEast = 1.0 / (cosLat * 111320);
        sensorMap.set('longitude', String(6.231036 + dEast));
        capturedListener?.({ calibration_drive_respond: { result: 0, duration_s: 5 } });
      }, 30);
    });

    const res = await request(server)
      .post(`/api/admin-status/maps/${sn}/import-portable/${stagingId}/start-drive`);

    vi.mocked(mapSyncMock.publishToExtended).mockReset();
    vi.mocked(mapSyncMock.onExtendedResponse).mockReset();

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('DRIVE_COMPLETE');
    expect(res.body.derivedHeadingRad).toBeCloseTo(0, 2);
    expect(res.body.distanceM).toBeCloseTo(1, 2);
  });

  it('returns 409 when session is not in ANCHOR_SET state', async () => {
    const sn = 'LFIN_T12B';
    db.prepare(`INSERT OR IGNORE INTO map_calibration (mower_sn, charger_lat, charger_lng) VALUES (?, ?, ?)`)
      .run(sn, 52.14, 6.23);
    const stagingId = await uploadBundle(sn);
    // Still in UPLOADED state, not ANCHOR_SET
    const res = await request(server)
      .post(`/api/admin-status/maps/${sn}/import-portable/${stagingId}/start-drive`);
    expect(res.status).toBe(409);
  });
});

// ── Task 13: GET /preview ─────────────────────────────────────────────────

/** Helper: upload → set-anchor → start-drive for a given SN. Returns stagingId in DRIVE_COMPLETE. */
async function runThroughDrive(sn: string): Promise<string> {
  db.prepare(`INSERT OR IGNORE INTO map_calibration (mower_sn, charger_lat, charger_lng) VALUES (?, ?, ?)`)
    .run(sn, 52.14, 6.23);
  const stagingId = await uploadBundle(sn);
  seedSensorCache(sn, '52.140888', '6.231036');
  await runSetAnchor(sn, stagingId);

  const sensorMap = getSensorMap(sn);
  let capturedListener: ((data: Record<string, unknown>) => void) | null = null;
  vi.mocked(mapSyncMock.onExtendedResponse).mockImplementationOnce((_sn: string, fn: (data: Record<string, unknown>) => void) => {
    capturedListener = fn;
  });
  vi.mocked(mapSyncMock.publishToExtended).mockImplementationOnce(() => {
    setTimeout(() => {
      const cosLat = Math.cos((52.140888 * Math.PI) / 180);
      sensorMap.set('longitude', String(6.231036 + 1.0 / (cosLat * 111320)));
      capturedListener?.({ calibration_drive_respond: { result: 0, duration_s: 5 } });
    }, 30);
  });
  const driveRes = await request(server)
    .post(`/api/admin-status/maps/${sn}/import-portable/${stagingId}/start-drive`);
  expect(driveRes.status).toBe(200);
  return stagingId;
}

describe.skip('GET /preview', () => {
  it('returns GeoJSON FeatureCollection in DRIVE_COMPLETE state', async () => {
    const sn = 'LFIN_T13A';
    const stagingId = await runThroughDrive(sn);

    const res = await request(server)
      .get(`/api/admin-status/maps/${sn}/import-portable/${stagingId}/preview`);
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('FeatureCollection');
    expect(Array.isArray(res.body.features)).toBe(true);
    expect(res.body.features.length).toBeGreaterThan(0);
    // The first feature should be the work polygon
    expect(res.body.features[0].properties.kind).toBe('work');
    expect(res.body.features[0].geometry.type).toBe('Polygon');
  });

  it('returns 409 when session is not in DRIVE_COMPLETE or PREVIEW_SHOWN state', async () => {
    const sn = 'LFIN_T13B';
    db.prepare(`INSERT OR IGNORE INTO map_calibration (mower_sn, charger_lat, charger_lng) VALUES (?, ?, ?)`)
      .run(sn, 52.14, 6.23);
    const stagingId = await uploadBundle(sn);
    // Still in UPLOADED state
    const res = await request(server)
      .get(`/api/admin-status/maps/${sn}/import-portable/${stagingId}/preview`);
    expect(res.status).toBe(409);
  });
});

// ── Task 14: POST /confirm ────────────────────────────────────────────────

/** Helper: upload → set-anchor → start-drive → preview. Returns stagingId in PREVIEW_SHOWN. */
async function runThroughPreview(sn: string): Promise<string> {
  const stagingId = await runThroughDrive(sn);
  // reset publishToExtended mock so it doesn't fire the drive response again
  vi.mocked(mapSyncMock.publishToExtended).mockReset();
  const prevRes = await request(server)
    .get(`/api/admin-status/maps/${sn}/import-portable/${stagingId}/preview`);
  expect(prevRes.status).toBe(200);
  return stagingId;
}

describe.skip('POST /confirm', () => {
  it('writes polygon to DB, triggers set_pos_origin and sync_map, returns APPLIED', async () => {
    const sn = 'LFIN_T14A';
    db.prepare(`INSERT OR IGNORE INTO map_calibration (mower_sn, charger_lat, charger_lng) VALUES (?, ?, ?)`)
      .run(sn, 52.14, 6.23);
    const stagingId = await runThroughPreview(sn);

    const publishCalls: unknown[] = [];
    vi.mocked(mapSyncMock.publishToExtended).mockImplementation((_sn: string, cmd: unknown) => {
      publishCalls.push(cmd);
    });

    const res = await request(server)
      .post(`/api/admin-status/maps/${sn}/import-portable/${stagingId}/confirm`);

    vi.mocked(mapSyncMock.publishToExtended).mockReset();

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('APPLIED');

    // Verify sync_map was triggered
    const hasSyncMap = publishCalls.some((c) => (c as any).sync_map !== undefined);
    expect(hasSyncMap).toBe(true);

    // Verify polygon was written to DB
    const maps = db.prepare(`SELECT * FROM maps WHERE mower_sn = ?`).all(sn);
    expect(maps.length).toBeGreaterThan(0);
    expect((maps as any[]).some((m) => m.map_type === 'work')).toBe(true);
  });

  it('returns 409 when session is not in PREVIEW_SHOWN state', async () => {
    const sn = 'LFIN_T14B';
    db.prepare(`INSERT OR IGNORE INTO map_calibration (mower_sn, charger_lat, charger_lng) VALUES (?, ?, ?)`)
      .run(sn, 52.14, 6.23);
    const stagingId = await uploadBundle(sn);
    // Still UPLOADED, not PREVIEW_SHOWN
    const res = await request(server)
      .post(`/api/admin-status/maps/${sn}/import-portable/${stagingId}/confirm`);
    expect(res.status).toBe(409);
  });
});

// ── Task 15: POST /cancel + GET /active ───────────────────────────────────

describe.skip('POST /cancel and GET /active', () => {
  it('cancel wipes session; /active returns null after', async () => {
    const sn = 'LFIN_T15A';
    db.prepare(`INSERT OR IGNORE INTO map_calibration (mower_sn, charger_lat, charger_lng) VALUES (?, ?, ?)`)
      .run(sn, 52.14, 6.23);
    const stagingId = await uploadBundle(sn);

    // Active should reflect the uploaded session
    const active1 = await request(server)
      .get(`/api/admin-status/maps/${sn}/import-portable/active`);
    expect(active1.status).toBe(200);
    expect(active1.body.stagingId).toBe(stagingId);
    expect(active1.body.state).toBe('UPLOADED');

    // Cancel the session
    const cancel = await request(server)
      .post(`/api/admin-status/maps/${sn}/import-portable/${stagingId}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.ok).toBe(true);

    // Active should now return null
    const active2 = await request(server)
      .get(`/api/admin-status/maps/${sn}/import-portable/active`);
    expect(active2.status).toBe(200);
    expect(active2.body.stagingId).toBeNull();
    expect(active2.body.state).toBeNull();
  });

  it('cancel is idempotent — returns 200 for unknown stagingId', async () => {
    const res = await request(server)
      .post(`/api/admin-status/maps/LFIN_T15B/import-portable/nonexistent-id/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('/active returns null when no session exists for SN', async () => {
    const res = await request(server)
      .get(`/api/admin-status/maps/LFIN_T15C/import-portable/active`);
    expect(res.status).toBe(200);
    expect(res.body.stagingId).toBeNull();
  });
});
