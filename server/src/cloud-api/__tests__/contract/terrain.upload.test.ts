/**
 * Contract test — POST /api/nova-file-server/terrain/uploadTerrainGrid.
 *
 * Mower firmware (terrain_scan.py) POSTs a raw TGR1 session-grid buffer.
 * The route must merge it into the persistent TGM1 file under
 * STORAGE_PATH/terrain/<sn>.tgm and upsert `terrain_grids` metadata.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { buildTestApp } from '../testHarness.js';
import { terrainGridRepo } from '../../../db/repositories/index.js';

function tgr1Cells(cells: Array<[number, number, number, number]>): Buffer {
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

describe('POST /api/nova-file-server/terrain/uploadTerrainGrid', () => {
  it('accepteert TGR1, merget en registreert metadata', async () => {
    const app = buildTestApp();
    const res = await request(app)
      .post('/api/nova-file-server/terrain/uploadTerrainGrid?sn=LFIN2230700238')
      .set('Content-Type', 'application/octet-stream')
      .send(tgr1Cells([[0, 0, 0.1, 3], [5, -2, 0.4, 1]]));
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(200);
    const row = terrainGridRepo.findBySn('LFIN2230700238')!;
    expect(row.sessions).toBeGreaterThanOrEqual(1);
    expect(row.cells).toBe(2);
    const tgm = path.join(process.env.STORAGE_PATH ?? './storage', 'terrain', 'LFIN2230700238.tgm');
    expect(fs.existsSync(tgm)).toBe(true);
  });

  it('weigert kapotte payload met 400', async () => {
    const app = buildTestApp();
    const res = await request(app)
      .post('/api/nova-file-server/terrain/uploadTerrainGrid?sn=LFIN2230700238')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('GARBAGE'));
    expect(res.status).toBe(400);
  });

  it('weigert ontbrekende sn met 400', async () => {
    const app = buildTestApp();
    const res = await request(app)
      .post('/api/nova-file-server/terrain/uploadTerrainGrid')
      .set('Content-Type', 'application/octet-stream')
      .send(tgr1Cells([[0, 0, 0.1, 1]]));
    expect(res.status).toBe(400);
  });
});
