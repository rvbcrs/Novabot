/**
 * Route test — GET /api/dashboard/terrain/:sn
 *
 * Mounts the dashboardRouter in a minimal Express app (no MQTT broker, no
 * Socket.io) and verifies the display-grid endpoint used by the dashboard's
 * 3D-terreinviewer (Task 7).
 *
 * Heavy deps (broker, socketHandler, mapSync, etc.) are mocked so the test
 * stays fast and avoids the circular-init issues those modules have at
 * ESM top-level. Mock pattern mirrors dashboardSystemHealth.test.ts exactly.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import http from 'http';
import type { AddressInfo } from 'net';

// ── Mock heavy deps BEFORE any import of dashboard.ts ───────────
vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(false),
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
  publishToExtended: vi.fn(),
  onExtendedResponse: vi.fn(),
  offExtendedResponse: vi.fn(),
  notifyRespond: vi.fn(),
  setDemoInterceptor: vi.fn(),
  onMowerConnected: vi.fn(),
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

// ── Now import dashboard.ts (after mocks are in place) ───────────
import { dashboardRouter } from '../../routes/dashboard.js';
import { mergeIntoTgm1, mergeIntoTgmo, parseTgr1, parseTgo1 } from '../../services/terrainGrid.js';

// Minimal Express wrapper — mirrors how index.ts mounts the router
const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);

function tgr1(cells: Array<[number, number, number, number]>): Buffer {
  const buf = Buffer.alloc(16 + cells.length * 16);
  buf.write('TGR1', 0, 'ascii');
  buf.writeDoubleLE(0.05, 4);
  buf.writeInt32LE(cells.length, 12);
  cells.forEach(([ix, iy, mean, cnt], i) => {
    const o = 16 + i * 16;
    buf.writeInt32LE(ix, o); buf.writeInt32LE(iy, o + 4);
    buf.writeFloatLE(mean, o + 8); buf.writeUInt32LE(cnt, o + 12);
  });
  return buf;
}

/** [ix, iy, label, maxH, cnt] per cel. */
function tgo1(cells: Array<[number, number, number, number, number]>): Buffer {
  const buf = Buffer.alloc(16 + cells.length * 17);
  buf.write('TGO1', 0, 'ascii');
  buf.writeDoubleLE(0.05, 4);
  buf.writeInt32LE(cells.length, 12);
  cells.forEach(([ix, iy, label, maxH, cnt], i) => {
    const o = 16 + i * 17;
    buf.writeInt32LE(ix, o); buf.writeInt32LE(iy, o + 4);
    buf.writeUInt8(label, o + 8);
    buf.writeFloatLE(maxH, o + 9); buf.writeUInt32LE(cnt, o + 13);
  });
  return buf;
}

describe('GET /api/dashboard/terrain/:sn', () => {
  it('404 zonder terrein', async () => {
    const res = await request(app).get('/api/dashboard/terrain/LFIN0000000001');
    expect(res.status).toBe(404);
  });

  it('400 bij een sn met een geëncodeerde slash (path-traversal guard)', async () => {
    // Express decodeURIComponent()-t de :sn param NA het matchen van de
    // route, dus '..%2f..%2fx' matcht als één path-segment en wordt
    // daarna '../../x' — zonder de sn-regex-guard zou dit buiten
    // STORAGE_PATH/terrain kunnen lezen.
    const res = await request(app).get('/api/dashboard/terrain/..%2f..%2fx');
    expect(res.status).toBe(400);
  });

  it('levert gzip TGR1 als het TGM-bestand bestaat', async () => {
    const dir = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'LFIN2230700238.tgm'), mergeIntoTgm1(null, tgr1([[0, 0, 0.2, 5]])));

    // supertest/superagent auto-decompresses any response carrying a
    // Content-Encoding header before a custom .parse() callback ever sees
    // it (see node_modules/superagent/lib/node/index.js _shouldDecompress /
    // decompress()) — there is no public option to turn that off. To
    // actually prove the bytes on the wire are gzip-compressed TGR1, this
    // test talks to the app over a real socket with Node's plain `http`
    // client, which does not decompress on its own.
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const { status, headers, body } = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/api/dashboard/terrain/LFIN2230700238' }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        }).on('error', reject);
      });
      expect(status).toBe(200);
      expect(headers['content-encoding']).toBe('gzip');
      const raw = zlib.gunzipSync(body);
      expect(raw.toString('ascii', 0, 4)).toBe('TGR1');
      expect(raw.readInt32LE(12)).toBe(1);
    } finally {
      server.close();
    }
  });

  it('500 JSON bij een corrupt/afgekapt TGM-bestand (geen server-crash)', async () => {
    const dir = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'LFIN9999999999.tgm'), Buffer.from('GARBAGE'));
    const res = await request(app).get('/api/dashboard/terrain/LFIN9999999999');
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });

  it('display bevat de actieve laag; raw=1 is ongecomprimeerd', async () => {
    // schrijf persistente TGM + actieve laag
    const dir = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'LFIN2230700238.tgm'), mergeIntoTgm1(null, tgr1([[0, 0, 0.2, 5]])));
    fs.writeFileSync(path.join(dir, 'LFIN2230700238.active.tgr'), tgr1([[9, 9, 0.9, 1]]));
    fs.writeFileSync(path.join(dir, 'LFIN2230700238.active.json'), JSON.stringify({ session: '42' }));
    const res = await request(app).get('/api/dashboard/terrain/LFIN2230700238?raw=1')
      .buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    const disp = parseTgr1(res.body as Buffer);
    expect(disp.cells.has('9,9')).toBe(true);   // actieve laag zichtbaar
    expect(disp.cells.has('0,0')).toBe(true);
  });
});

describe('GET /api/dashboard/terrain-objects/:sn', () => {
  it('GET terrain-objects levert TGO1-display', async () => {
    const dir = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'LFIN2230700238.tgmo'), mergeIntoTgmo(null, tgo1([[1, 1, 10, 0.3, 4]])));
    const res = await request(app).get('/api/dashboard/terrain-objects/LFIN2230700238?raw=1')
      .buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(parseTgo1(res.body as Buffer).cells.has('1,1,10')).toBe(true);
  });

  it('404 zonder objecten', async () => {
    const res = await request(app).get('/api/dashboard/terrain-objects/LFIN0000000002');
    expect(res.status).toBe(404);
  });
});
