/**
 * runRecognition — orchestratie-test (objectherkenning-plan Task 7).
 *
 * Bouwt een minimale .tgmo-file + frame-sidecars in de test-storage-dir en
 * stubt de classifier-pipeline (_setPipelineForTest) zodat er NOOIT een
 * echt model gedownload wordt. Elke test gebruikt een eigen SN — de
 * test-storage-dir wordt niet tussen tests binnen dit bestand opgeruimd
 * (zie __tests__/setup.ts: één wegwerp-dir per testbestand), dus SN-hergebruik
 * zou state laten lekken tussen scenario's.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { runRecognition } from '../../services/terrainRecognition.js';
import { mergeIntoTgmo } from '../../services/terrainGrid.js';
import { _setPipelineForTest, LABELS } from '../../services/terrainClassifier.js';
import { terrainClusterRepo } from '../../db/repositories/index.js';

function tgo1(cells: Array<[number, number, number, number, number]>, cellSize = 0.05): Buffer {
  const buf = Buffer.alloc(16 + cells.length * 17);
  buf.write('TGO1', 0, 'ascii');
  buf.writeDoubleLE(cellSize, 4);
  buf.writeInt32LE(cells.length, 12);
  cells.forEach(([ix, iy, label, maxH, cnt], i) => {
    const o = 16 + i * 17;
    buf.writeInt32LE(ix, o); buf.writeInt32LE(iy, o + 4);
    buf.writeUInt8(label, o + 8); buf.writeFloatLE(maxH, o + 9); buf.writeUInt32LE(cnt, o + 13);
  });
  return buf;
}

/** 3x3-blok (9 cellen, ruim boven MIN_CELLS=8) op cel (0..2, 0..2) → cluster-
 *  centrum op (0.075, 0.075) m bij cellSize 0.05 (zelfde blok als
 *  terrainClusters.test.ts). */
function nineCellCluster(): Array<[number, number, number, number, number]> {
  const cells: Array<[number, number, number, number, number]> = [];
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) cells.push([x, y, 1, 0.5, 3]);
  return cells;
}

function terrainDir(): string {
  return path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain');
}

function writeTgmo(sn: string, cells: Array<[number, number, number, number, number]>): void {
  const dir = terrainDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sn}.tgmo`), mergeIntoTgmo(null, tgo1(cells)));
}

async function writeFrame(sn: string, session: number, seq: number, pose: { x: number; y: number; yaw: number }): Promise<void> {
  const dir = path.join(terrainDir(), 'frames', sn);
  fs.mkdirSync(dir, { recursive: true });
  const jpeg = await sharp({ create: { width: 200, height: 150, channels: 3, background: { r: 90, g: 140, b: 70 } } }).jpeg().toBuffer();
  fs.writeFileSync(path.join(dir, `${session}_${seq}.jpg`), jpeg);
  fs.writeFileSync(path.join(dir, `${session}_${seq}.json`), JSON.stringify(pose));
}

// Recht aangekeken vanaf (-1,-1) naar het (0.075, 0.075)-cluster: hoek 0,
// afstand ≈1.52 m — ruim binnen scoreFrame's bereik [0.3, 4] m.
const AIMED_POSE = { x: -1, y: -1, yaw: Math.atan2(1.075, 1.075) };

describe('runRecognition', () => {
  afterEach(() => {
    _setPipelineForTest(null);
    delete process.env.TERRAIN_CLASSIFY;
  });

  it('classificeert het cluster met het beste frame en upsert crop_file', async () => {
    const sn = 'LFIN9990000001';
    writeTgmo(sn, nineCellCluster());
    await writeFrame(sn, 1, 1, AIMED_POSE);
    const pipeline = vi.fn(async () => LABELS.map((l) => ({ label: l.prompt, score: l.prompt === 'trampoline' ? 0.62 : 0.01 })));
    _setPipelineForTest(pipeline);

    const count = await runRecognition(sn);

    expect(count).toBe(1);
    expect(pipeline).toHaveBeenCalledTimes(1);
    const row = terrainClusterRepo.findBySn(sn)[0];
    expect(row.class_name).toBe('trampoline');
    expect(row.confidence).toBeCloseTo(0.62, 5);
    expect(row.crop_file).toBe(`${row.cluster_key}.jpg`);
    const cropPath = path.join(terrainDir(), 'crops', sn, row.crop_file!);
    expect(fs.existsSync(cropPath)).toBe(true);
  });

  it('TERRAIN_CLASSIFY=0 → 0, geen db-writes (initClassifier faalt bewust)', async () => {
    const sn = 'LFIN9990000002';
    writeTgmo(sn, nineCellCluster());
    await writeFrame(sn, 1, 1, AIMED_POSE);
    process.env.TERRAIN_CLASSIFY = '0';
    const count = await runRecognition(sn);
    expect(count).toBe(0);
    expect(terrainClusterRepo.findBySn(sn)).toHaveLength(0);
  });

  it('geen terreindata voor deze sn → 0, geen crash', async () => {
    _setPipelineForTest(async () => []);
    expect(await runRecognition('LFIN9990000003')).toBe(0);
  });

  it('geen bruikbaar frame → cluster overgeslagen (met warn), geometrie wél opgeslagen', async () => {
    const sn = 'LFIN9990000004';
    writeTgmo(sn, nineCellCluster());
    // >4m weg → scoreFrame geeft null voor elk frame
    await writeFrame(sn, 1, 1, { x: -100, y: -100, yaw: 0 });
    const pipeline = vi.fn(async () => LABELS.map((l) => ({ label: l.prompt, score: 0.9 })));
    _setPipelineForTest(pipeline);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const count = await runRecognition(sn);

    expect(count).toBe(0);
    expect(pipeline).not.toHaveBeenCalled();
    const row = terrainClusterRepo.findBySn(sn)[0];
    expect(row).toBeTruthy(); // geometrie is wel opgeslagen
    expect(row.class_name).toBeNull();
    expect(row.crop_file).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('user_override: geometrie ververst, maar niet opnieuw croppen/classificeren', async () => {
    const sn = 'LFIN9990000005';
    writeTgmo(sn, nineCellCluster());
    await writeFrame(sn, 1, 1, AIMED_POSE);
    const firstPipeline = vi.fn(async () => LABELS.map((l) => ({ label: l.prompt, score: l.prompt === 'trampoline' ? 0.62 : 0.01 })));
    _setPipelineForTest(firstPipeline);
    await runRecognition(sn);
    const key = terrainClusterRepo.findBySn(sn)[0].cluster_key;
    terrainClusterRepo.setOverride(sn, key, 'tree');

    const secondPipeline = vi.fn(async () => LABELS.map((l) => ({ label: l.prompt, score: l.prompt === 'bush/hedge' ? 0.9 : 0.01 })));
    _setPipelineForTest(secondPipeline);
    const count = await runRecognition(sn);

    expect(count).toBe(0); // override-cluster telt niet mee als "geclassificeerd"
    expect(secondPipeline).not.toHaveBeenCalled();
    const row = terrainClusterRepo.findBySn(sn)[0];
    expect(row.user_override).toBe('tree');           // override blijft staan
    expect(row.class_name).toBe('trampoline');        // model-classificatie van de EERSTE run blijft staan
  });

  it('meerdere clusters: alleen niet-overridede clusters tellen mee in het totaal', async () => {
    const sn = 'LFIN9990000006';
    // twee losstaande 3x3-blokken ver genoeg uit elkaar om apart te clusteren
    const cells: Array<[number, number, number, number, number]> = [...nineCellCluster()];
    for (let x = 40; x < 43; x++) for (let y = 40; y < 43; y++) cells.push([x, y, 1, 0.4, 2]);
    writeTgmo(sn, cells);
    await writeFrame(sn, 1, 1, AIMED_POSE);
    // tweede cluster centrum: (41*0.05+0.025, 41*0.05+0.025) ≈ (2.075, 2.075)
    await writeFrame(sn, 1, 2, { x: 0, y: 0, yaw: Math.atan2(2.075, 2.075) });
    const pipeline = vi.fn(async () => LABELS.map((l) => ({ label: l.prompt, score: l.prompt === 'tree' ? 0.5 : 0.01 })));
    _setPipelineForTest(pipeline);

    const count = await runRecognition(sn);

    expect(count).toBe(2);
    expect(terrainClusterRepo.findBySn(sn)).toHaveLength(2);
  });
});
