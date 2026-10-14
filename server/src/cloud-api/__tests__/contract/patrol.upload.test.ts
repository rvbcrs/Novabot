/**
 * Contract test: POST /api/nova-file-server/patrol/uploadFrame.
 * mow_zone_drive.py (patrol mode) posts one checkpoint: a JPEG or an empty
 * body, the scores in the query. Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Server } from 'http';
import type { Express } from 'express';
import fs from 'fs';
import path from 'path';

vi.mock('../../../services/patrolService.js', () => ({ onPatrolFrame: vi.fn(() => []) }));

import { buildTestApp } from '../testHarness.js';
import { onPatrolFrame } from '../../../services/patrolService.js';

const openServers: Server[] = [];
function api(app: Express) {
  const server = app.listen(0);
  openServers.push(server);
  return request(server);
}
afterEach(() => {
  for (const s of openServers.splice(0)) s.close();
  vi.clearAllMocks();
});

const SN = 'LFIN2230700238';
const DIR = path.resolve(process.env.STORAGE_PATH ?? './storage', 'patrol', SN, '777');
const Q = `/api/nova-file-server/patrol/uploadFrame?sn=${SN}&run=777&x=1.5&y=-2.25&frames=3&person=60&animal=0`;

describe('POST /api/nova-file-server/patrol/uploadFrame', () => {
  it('keeps the photo and metadata and hands the scores to the service', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9]);
    const res = await api(buildTestApp()).post(`${Q}&seq=1`)
      .set('Content-Type', 'application/octet-stream').send(jpeg);
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(DIR, '1.jpg')).equals(jpeg)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(DIR, '1.json'), 'utf8')))
      .toMatchObject({ seq: 1, x: 1.5, y: -2.25, person: 60, animal: 0, frames: 3, image: true });
    expect(onPatrolFrame).toHaveBeenCalledWith(SN, { run: '777', seq: 1, person: 60, animal: 0, frames: 3, image: true });
  });

  it('a checkpoint without a photo is kept as metadata only', async () => {
    const res = await api(buildTestApp()).post(`${Q}&seq=2`)
      .set('Content-Type', 'application/octet-stream').send(Buffer.alloc(0));
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(DIR, '2.jpg'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(DIR, '2.json'), 'utf8')).image).toBe(false);
  });

  it('refuses bad identifiers, bad numbers and a body that is no JPEG', async () => {
    const app = buildTestApp();
    const send = (url: string, body = Buffer.from([0xff, 0xd8])) =>
      api(app).post(url).set('Content-Type', 'application/octet-stream').send(body);
    expect((await send(`/api/nova-file-server/patrol/uploadFrame?sn=../x&run=1&seq=1&x=0&y=0&frames=0&person=0&animal=0`)).status).toBe(400);
    expect((await send(`/api/nova-file-server/patrol/uploadFrame?sn=${SN}&run=1a&seq=1&x=0&y=0&frames=0&person=0&animal=0`)).status).toBe(400);
    expect((await send(`/api/nova-file-server/patrol/uploadFrame?sn=${SN}&run=1&seq=999&x=0&y=0&frames=0&person=0&animal=0`)).status).toBe(400);
    expect((await send(`/api/nova-file-server/patrol/uploadFrame?sn=${SN}&run=1&seq=1&x=nan&y=0&frames=0&person=0&animal=0`)).status).toBe(400);
    expect((await send(`/api/nova-file-server/patrol/uploadFrame?sn=${SN}&run=1&seq=1&x=0&y=0&frames=0&person=-1&animal=0`)).status).toBe(400);
    expect((await send(`${Q}&seq=3`, Buffer.from('<html>'))).status).toBe(400);
    expect(onPatrolFrame).not.toHaveBeenCalled();
  });
});
