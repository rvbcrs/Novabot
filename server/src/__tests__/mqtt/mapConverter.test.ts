/**
 * Unit tests for generateMapZipFromDb — focus on polygon offset application.
 * Uses the real in-memory DB + real ZIP I/O so we verify the actual bytes
 * written to disk (the shift cannot be observed through mapBackup tests
 * because those mock mapConverter wholesale).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execSync } from 'child_process';

import { generateMapZipFromDb } from '../../mqtt/mapConverter.js';
import { mapRepo } from '../../db/repositories/maps.js';
import { db } from '../../db/database.js';

const SN = 'LFIN_OFFSET_TEST';

const WORK_PTS = [
  { x: 0, y: 0 },
  { x: 5, y: 0 },
  { x: 5, y: 5 },
  { x: 0, y: 5 },
];
const OBSTACLE_PTS = [
  { x: 1, y: 1 },
  { x: 2, y: 1 },
  { x: 2, y: 2 },
  { x: 1, y: 2 },
];
const UNICOM_TOCHARGE_PTS = [
  { x: -1.21, y: 0.48 },
  { x: -0.5, y: 0.2 },
  { x: 0, y: 0 },
];

function readCsv(p: string): Array<{ x: number; y: number }> {
  return fs.readFileSync(p, 'utf8').trim().split('\n').map(l => {
    const [x, y] = l.split(',').map(parseFloat);
    return { x, y };
  });
}

function unzipTo(zip: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unzip-test-'));
  execSync(`unzip -o -q "${zip}" -d "${dir}"`);
  return dir;
}

beforeEach(() => {
  // Wipe per-test state so each case starts fresh
  db.prepare('DELETE FROM maps WHERE mower_sn = ?').run(SN);
  db.prepare('DELETE FROM map_calibration WHERE mower_sn = ?').run(SN);
  // Seed work + obstacle + tocharge unicom for SN
  mapRepo.create({
    map_id: `${SN}-work`,
    mower_sn: SN,
    map_name: 'map0_work',
    file_name: 'map0_work.csv',
    map_area: JSON.stringify(WORK_PTS),
    map_type: 'work',
    canonical_name: 'map0_work',
  });
  mapRepo.create({
    map_id: `${SN}-obs`,
    mower_sn: SN,
    map_name: 'map0_0_obstacle',
    file_name: 'map0_0_obstacle.csv',
    map_area: JSON.stringify(OBSTACLE_PTS),
    map_type: 'obstacle',
    canonical_name: 'map0_0_obstacle',
  });
  mapRepo.create({
    map_id: `${SN}-unicom-tocharge`,
    mower_sn: SN,
    map_name: 'map0tocharge_unicom',
    file_name: 'map0tocharge_unicom.csv',
    map_area: JSON.stringify(UNICOM_TOCHARGE_PTS),
    map_type: 'unicom',
    canonical_name: 'map0tocharge_unicom',
  });
});

describe('generateMapZipFromDb polygon offset', () => {
  it('with offset (0,0) produces unshifted CSV', () => {
    const zip = generateMapZipFromDb(SN, 0);
    expect(zip).not.toBeNull();
    const dir = unzipTo(zip!);
    const work = readCsv(path.join(dir, 'csv_file/map0_work.csv'));
    expect(work[0].x).toBeCloseTo(0);
    expect(work[0].y).toBeCloseTo(0);
    expect(work[1].x).toBeCloseTo(5);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('with positive offset shifts work and obstacle CSVs', () => {
    mapRepo.setPolygonOffset(SN, 0.05, -0.03);
    const zip = generateMapZipFromDb(SN, 0);
    const dir = unzipTo(zip!);

    const work = readCsv(path.join(dir, 'csv_file/map0_work.csv'));
    expect(work[0].x).toBeCloseTo(0.05);
    expect(work[0].y).toBeCloseTo(-0.03);
    expect(work[1].x).toBeCloseTo(5.05);
    expect(work[1].y).toBeCloseTo(-0.03);

    const obs = readCsv(path.join(dir, 'csv_file/map0_0_obstacle.csv'));
    expect(obs[0].x).toBeCloseTo(1.05);
    expect(obs[0].y).toBeCloseTo(0.97);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exempts the first point of mapNtocharge_unicom from the shift', () => {
    mapRepo.setPolygonOffset(SN, 0.05, -0.03);
    const zip = generateMapZipFromDb(SN, 0);
    const dir = unzipTo(zip!);

    const tocharge = readCsv(path.join(dir, 'csv_file/map0tocharge_unicom.csv'));
    // Anchor (index 0) MUST stay at original coords
    expect(tocharge[0].x).toBeCloseTo(UNICOM_TOCHARGE_PTS[0].x);
    expect(tocharge[0].y).toBeCloseTo(UNICOM_TOCHARGE_PTS[0].y);
    // Other points shift normally
    expect(tocharge[1].x).toBeCloseTo(UNICOM_TOCHARGE_PTS[1].x + 0.05);
    expect(tocharge[1].y).toBeCloseTo(UNICOM_TOCHARGE_PTS[1].y - 0.03);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shifts every point of map-to-map unicom (no anchor exemption)', () => {
    // Add a second work area + a non-tocharge unicom row pointing at it.
    const MAP1_TO_MAP0_PTS = [
      { x: 6.0, y: 6.0 },
      { x: 5.0, y: 5.5 },
      { x: 4.5, y: 5.0 },
    ];
    mapRepo.create({
      map_id: `${SN}-work2`,
      mower_sn: SN,
      map_name: 'map1_work',
      file_name: 'map1_work.csv',
      map_area: JSON.stringify([
        { x: 10, y: 10 }, { x: 12, y: 10 }, { x: 12, y: 12 }, { x: 10, y: 12 },
      ]),
      map_type: 'work',
      canonical_name: 'map1_work',
    });
    // Use map1tomap0_0_unicom as the unicom for work area 1 (unicomRows index 1).
    // map_id "LFIN_OFFSET_TEST-unicom-zzz-m2m" sorts after "-unicom-tocharge" so this
    // row becomes unicomRows[1] and is picked up for work area index 1 (map1_work).
    mapRepo.create({
      map_id: `${SN}-unicom-zzz-m2m`,
      mower_sn: SN,
      map_name: 'map1tomap0_0_unicom',
      file_name: 'map1tomap0_0_unicom.csv',
      map_area: JSON.stringify(MAP1_TO_MAP0_PTS),
      map_type: 'unicom',
      canonical_name: 'map1tomap0_0_unicom',
    });
    mapRepo.setPolygonOffset(SN, 0.05, -0.03);

    const zip = generateMapZipFromDb(SN, 0);
    const dir = unzipTo(zip!);

    // map-to-map unicom: every point shifted (no anchor exemption)
    const m2m = readCsv(path.join(dir, 'csv_file/map1tomap0_0_unicom.csv'));
    expect(m2m[0].x).toBeCloseTo(MAP1_TO_MAP0_PTS[0].x + 0.05);
    expect(m2m[0].y).toBeCloseTo(MAP1_TO_MAP0_PTS[0].y - 0.03);
    expect(m2m[1].x).toBeCloseTo(MAP1_TO_MAP0_PTS[1].x + 0.05);
    expect(m2m[1].y).toBeCloseTo(MAP1_TO_MAP0_PTS[1].y - 0.03);

    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('keeps canonical slots and unicoms when file_name is the ZIP bundle name (2026-09-07 .244 regression)', () => {
    // Rows as the mower-upload parser stores them: canonical name in map_name,
    // the uploaded bundle name in file_name. map1/map2 were deleted; map3 remains.
    db.prepare('DELETE FROM maps WHERE mower_sn = ?').run(SN);
    const bundle = `${SN}_1788609847354.zip`;
    const add = (id: string, name: string, type: string, pts: unknown[]) => mapRepo.create({
      map_id: `${SN}-${id}`, mower_sn: SN, map_name: name, file_name: bundle,
      map_area: JSON.stringify(pts), map_type: type, canonical_name: name,
    });
    add('a-map0', 'map0', 'work', WORK_PTS);
    add('b-map3', 'map3', 'work', [{ x: 10, y: 10 }, { x: 12, y: 10 }, { x: 12, y: 12 }, { x: 10, y: 12 }]);
    add('c-obs', 'map0_1_obstacle', 'obstacle', OBSTACLE_PTS);
    add('d-uni', 'map0tomap3_0_unicom', 'unicom', [{ x: 5, y: 5 }, { x: 10, y: 10 }]);
    add('e-uni', 'map0tocharge_unicom', 'unicom', UNICOM_TOCHARGE_PTS);

    const dir = unzipTo(generateMapZipFromDb(SN, 0)!);
    const files = fs.readdirSync(path.join(dir, 'csv_file')).sort();
    expect(files).toEqual([
      'map0_1_obstacle.csv', 'map0_work.csv', 'map0tocharge_unicom.csv',
      'map0tomap3_0_unicom.csv', 'map3_work.csv', 'map_info.json',
    ]);
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'csv_file/map_info.json'), 'utf8'));
    expect(Object.keys(info).sort()).toEqual(['charging_pose', 'map0_work.csv', 'map3_work.csv']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
