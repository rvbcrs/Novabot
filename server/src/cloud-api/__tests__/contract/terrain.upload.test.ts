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

/** [ix, iy, label, maxH, cnt] per cel. */
function tgo1Cells(cells: Array<[number, number, number, number, number]>): Buffer {
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

  it('live-sessie: final=0 vervangt actieve laag, final=1 vouwt één keer in', async () => {
    const app = buildTestApp();
    const S = 'sn=LFIN2230700238&session=111&final=0';
    await request(app).post(`/api/nova-file-server/terrain/uploadTerrainGrid?${S}`)
      .set('Content-Type', 'application/octet-stream').send(tgr1Cells([[0, 0, 0.1, 5]])).expect(200);
    await request(app).post(`/api/nova-file-server/terrain/uploadTerrainGrid?${S}`)
      .set('Content-Type', 'application/octet-stream').send(tgr1Cells([[0, 0, 0.1, 5], [1, 0, 0.2, 3]])).expect(200);
    const before = terrainGridRepo.findBySn('LFIN2230700238');
    await request(app).post('/api/nova-file-server/terrain/uploadTerrainGrid?sn=LFIN2230700238&session=111&final=1')
      .set('Content-Type', 'application/octet-stream').send(tgr1Cells([[0, 0, 0.1, 5], [1, 0, 0.2, 3]])).expect(200);
    const after = terrainGridRepo.findBySn('LFIN2230700238')!;
    expect(after.sessions).toBe((before?.sessions ?? 0) + 1);  // tussentijdse uploads telden NIET
  });

  it('uploadObjectGrid accepteert TGO1 en registreert obj-metadata', async () => {
    const app = buildTestApp();
    await request(app).post('/api/nova-file-server/terrain/uploadObjectGrid?sn=LFIN2230700238&final=1')
      .set('Content-Type', 'application/octet-stream').send(tgo1Cells([[3, 4, 1, 0.5, 7]])).expect(200);
    expect(terrainGridRepo.findBySn('LFIN2230700238')!.obj_sessions).toBeGreaterThanOrEqual(1);
  });

  it('terrain final=1 laat een .active.tgo van dezelfde sessie ongemoeid; latere sessie-wissel vouwt hem alsnog in', async () => {
    const app = buildTestApp();
    const sn = 'LFIN2230700239';
    // object-laag start als actieve sessie S1 (final=0)
    await request(app).post(`/api/nova-file-server/terrain/uploadObjectGrid?sn=${sn}&session=S1&final=0`)
      .set('Content-Type', 'application/octet-stream').send(tgo1Cells([[2, 2, 3, 0.4, 2]])).expect(200);
    // een terrain-upload finalt dezelfde sessie — mag de gedeelde .active.json
    // NIET wissen zolang .active.tgo (object-laag, zelfde sessie) nog bestaat
    await request(app).post(`/api/nova-file-server/terrain/uploadTerrainGrid?sn=${sn}&session=S1&final=1`)
      .set('Content-Type', 'application/octet-stream').send(tgr1Cells([[0, 0, 0.1, 1]])).expect(200);
    const before = terrainGridRepo.findBySn(sn);
    // een NIEUWE sessie start een non-final object-upload — moet eerst de
    // achtergebleven S1-object-laag invouwen (foldActive) in plaats van hem
    // stilletjes te overschrijven
    await request(app).post(`/api/nova-file-server/terrain/uploadObjectGrid?sn=${sn}&session=S2&final=0`)
      .set('Content-Type', 'application/octet-stream').send(tgo1Cells([[9, 9, 5, 0.9, 1]])).expect(200);
    const after = terrainGridRepo.findBySn(sn)!;
    expect(after.obj_sessions).toBe((before?.obj_sessions ?? 0) + 1);
  });
});

describe('POST /api/nova-file-server/terrain/uploadSessionFrame', () => {
  it('uploadSessionFrame bewaart jpeg + pose-sidecar en begrenst per sessie', async () => {
    const app = buildTestApp();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const res = await request(app)
      .post('/api/nova-file-server/terrain/uploadSessionFrame?sn=LFIN2230700238&session=555&seq=1&x=1.5&y=-2.25&yaw=0.7854')
      .set('Content-Type', 'application/octet-stream').send(jpeg);
    expect(res.status).toBe(200);
    const dir = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain', 'frames', 'LFIN2230700238');
    expect(fs.readFileSync(path.join(dir, '555_1.jpg')).equals(jpeg)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '555_1.json'), 'utf8'))).toEqual({ x: 1.5, y: -2.25, yaw: 0.7854 });
  });

  it('uploadSessionFrame weigert ongeldige sn/seq', async () => {
    const app = buildTestApp();
    await request(app).post('/api/nova-file-server/terrain/uploadSessionFrame?sn=../x&session=1&seq=1&x=0&y=0&yaw=0')
      .set('Content-Type', 'application/octet-stream').send(Buffer.from([0xff, 0xd8])).expect(400);
    await request(app).post('/api/nova-file-server/terrain/uploadSessionFrame?sn=LFIN2230700238&session=1&seq=99&x=0&y=0&yaw=0')
      .set('Content-Type', 'application/octet-stream').send(Buffer.from([0xff, 0xd8])).expect(400); // seq > 20
  });

  it('sessie-rotatie evict numeriek oudste, niet lexicografisch oudste', async () => {
    const app = buildTestApp();
    const sn = 'LFIN2230700240';
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    for (const session of ['9', '10', '11', '12', '13', '14']) {
      await request(app)
        .post(`/api/nova-file-server/terrain/uploadSessionFrame?sn=${sn}&session=${session}&seq=1&x=0&y=0&yaw=0`)
        .set('Content-Type', 'application/octet-stream').send(jpeg).expect(200);
    }
    const dir = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain', 'frames', sn);
    expect(fs.existsSync(path.join(dir, '9_1.jpg'))).toBe(false); // numeriek oudste: weg
    for (const session of ['10', '11', '12', '13', '14']) {
      expect(fs.existsSync(path.join(dir, `${session}_1.jpg`))).toBe(true);
    }
  });
});
