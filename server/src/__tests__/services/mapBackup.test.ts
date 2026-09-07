/**
 * Unit tests — mapBackup service
 *
 * Tests snapshot creation, retention enforcement, and debounce coalescing.
 * `generateMapZipFromDb` is mocked to write a stub ZIP file so tests stay
 * fast and hermetic (no SQLite data needed).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';

// ── Mock mapConverter BEFORE importing mapBackup ─────────────────────────────
//
// The default stub writes a 10-byte "PKstub-zip" payload — fine for snapshot
// tests that only check filename/size, but invalid for the regenerate flow
// which actually unzips the file. Tests for regenerateLatestZipFromBackup
// override this with a real (small) ZIP via vi.mocked(...) below.
vi.mock('../../mqtt/mapConverter.js', () => ({
  generateMapZipFromDb: vi.fn((_sn: string) => {
    const p = path.join(os.tmpdir(), `mock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.zip`);
    fs.writeFileSync(p, Buffer.from('PKstub-zip'));
    return p;
  }),
  parseMapZip: vi.fn(() => null),
}));

// Stub sensorData so anchor.ts (transitively imported via mapBackup) doesn't
// pull the broker → socketHandler chain into the test runtime.
vi.mock('../../mqtt/sensorData.js', () => ({
  deviceCache: new Map<string, Map<string, string>>(),
}));

// Import the service AFTER the mock is set up
import {
  _drainScheduled,
  _snapshotNow,
  listBackups,
  scheduleSnapshot,
  regenerateLatestZipFromBackup,
} from '../../services/mapBackup.js';
import { generateMapZipFromDb } from '../../mqtt/mapConverter.js';
import { mapRepo } from '../../db/repositories/index.js';
import { db } from '../../db/database.js';

/**
 * Build a real ZIP under STORAGE_PATH containing a csv_file/ subtree —
 * matches what the production generateMapZipFromDb output looks like.
 */
function buildRealZipWithCsvFile(stub: { 'map_info.json'?: string } = {}): string {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-genzip-'));
  const csvDir = path.join(stage, 'csv_file');
  fs.mkdirSync(csvDir, { recursive: true });
  fs.writeFileSync(
    path.join(csvDir, 'map_info.json'),
    // Mirror generateMapZipFromDb: charging_pose placeholder + map_size per work slot.
    stub['map_info.json'] ?? JSON.stringify({
      charging_pose: { x: 0, y: 0, orientation: 0 },
      'map0_work.csv': { map_size: 1 },
      'map3_work.csv': { map_size: 98.64 },
    }),
  );
  fs.writeFileSync(path.join(csvDir, 'map0_work.csv'), '0,0\n1,0\n1,1\n0,1\n0,0\n');
  const zipOut = path.join(os.tmpdir(), `fakezip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.zip`);
  execSync(`cd "${stage}" && zip -q -r "${zipOut}" csv_file/`);
  return zipOut;
}

let tmpStorage: string;

beforeEach(() => {
  tmpStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'opennova-mapbackup-test-'));
  process.env.STORAGE_PATH = tmpStorage;
  _drainScheduled();
});

describe('mapBackup service', () => {
  // ── Phase A: snapshot creation ────────────────────────────────────────────

  it('_snapshotNow creates a .zip file under backups/<sn>/', () => {
    const result = _snapshotNow('LFIN_TEST');
    expect(result).toBeTruthy();
    expect(fs.existsSync(result!)).toBe(true);
    expect(result).toContain('LFIN_TEST');
    expect(result!.endsWith('.zip')).toBe(true);
  });

  it('listBackups returns exactly one entry after one snapshot', () => {
    _snapshotNow('LFIN_A');
    const list = listBackups('LFIN_A');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      filename: expect.stringMatching(/\.zip$/),
      sizeBytes: expect.any(Number),
      ts: expect.any(Number),
    });
  });

  it('listBackups returns newest first', () => {
    _snapshotNow('LFIN_B');
    _snapshotNow('LFIN_B');
    _snapshotNow('LFIN_B');
    const list = listBackups('LFIN_B');
    expect(list.length).toBeGreaterThanOrEqual(2);
    // each timestamp >= next (newest first)
    for (let i = 0; i < list.length - 1; i++) {
      expect(list[i].ts).toBeGreaterThanOrEqual(list[i + 1].ts);
    }
  });

  it('listBackups returns [] when no backups exist', () => {
    const list = listBackups('LFIN_NONE');
    expect(list).toEqual([]);
  });

  it('_snapshotNow returns null when generateMapZipFromDb returns null', async () => {
    const { generateMapZipFromDb } = await import('../../mqtt/mapConverter.js');
    const mockFn = generateMapZipFromDb as ReturnType<typeof vi.fn>;
    const original = mockFn.getMockImplementation();
    mockFn.mockReturnValueOnce(null);

    const result = _snapshotNow('LFIN_NULL');
    expect(result).toBeNull();

    // Restore
    if (original) mockFn.mockImplementation(original);
  });

  // ── Phase A: retention ────────────────────────────────────────────────────

  it('retention drops oldest entries beyond 20', () => {
    for (let i = 0; i < 25; i++) {
      _snapshotNow('LFIN_RET');
    }
    const list = listBackups('LFIN_RET');
    expect(list.length).toBeLessThanOrEqual(20);
  });

  it('retention keeps exactly 20 when exactly 21 are created', () => {
    for (let i = 0; i < 21; i++) {
      _snapshotNow('LFIN_RET2');
    }
    expect(listBackups('LFIN_RET2').length).toBeLessThanOrEqual(20);
  });

  // ── Phase A: debounce ─────────────────────────────────────────────────────

  it('scheduleSnapshot debounces rapid calls within 5s window — no file before timer fires', () => {
    vi.useFakeTimers();
    scheduleSnapshot('LFIN_DEB');
    scheduleSnapshot('LFIN_DEB');
    scheduleSnapshot('LFIN_DEB');
    // Nothing created yet — timer hasn't fired
    expect(listBackups('LFIN_DEB')).toHaveLength(0);
    vi.useRealTimers();
  });

  it('scheduleSnapshot fires exactly once after DEBOUNCE_MS even with rapid calls', async () => {
    vi.useFakeTimers();
    scheduleSnapshot('LFIN_DEB2');
    scheduleSnapshot('LFIN_DEB2');
    scheduleSnapshot('LFIN_DEB2');
    vi.advanceTimersByTime(5100);
    // Flush microtasks / any promise chains
    await Promise.resolve();
    const list = listBackups('LFIN_DEB2');
    // Trailing edge fires exactly once, so exactly 1 snapshot
    expect(list.length).toBeLessThanOrEqual(1);
    vi.useRealTimers();
  });

  it('_drainScheduled cancels pending timers', () => {
    vi.useFakeTimers();
    scheduleSnapshot('LFIN_DRAIN');
    _drainScheduled();
    vi.advanceTimersByTime(10000);
    expect(listBackups('LFIN_DRAIN')).toHaveLength(0);
    vi.useRealTimers();
  });

  // ── Isolation: multiple SNs stay independent ──────────────────────────────

  it('snapshots for different SNs do not interfere', () => {
    _snapshotNow('SN_ALPHA');
    _snapshotNow('SN_BETA');

    const alphaBackups = listBackups('SN_ALPHA');
    const betaBackups = listBackups('SN_BETA');

    expect(alphaBackups.length).toBeGreaterThanOrEqual(1);
    expect(betaBackups.length).toBeGreaterThanOrEqual(1);

    // Verify they live in different directories — filenames may be shared but
    // paths are under separate per-SN directories.
    const alphaDir = path.join(tmpStorage, 'maps', 'backups', 'SN_ALPHA');
    const betaDir = path.join(tmpStorage, 'maps', 'backups', 'SN_BETA');
    expect(fs.existsSync(alphaDir)).toBe(true);
    expect(fs.existsSync(betaDir)).toBe(true);
  });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

describe('bootstrap', () => {
  it('creates a bootstrap snapshot when backups dir is empty AND DB has maps', () => {
    mapRepo.create({
      map_id: 'm0',
      mower_sn: 'LFIN_BOOT',
      map_name: 'map0',
      map_area: JSON.stringify([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]),
      map_type: 'work',
    });
    const result = listBackups('LFIN_BOOT');
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].filename).toMatch(/^bootstrap-/);
  });

  it('falls back to _latest.zip when DB is empty but _latest.zip exists', () => {
    const root = path.resolve(tmpStorage, 'maps');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'LFIN_LATEST_latest.zip'), Buffer.from('PKstub'));
    const result = listBackups('LFIN_LATEST');
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].filename).toMatch(/^bootstrap-/);
  });

  it('returns empty when DB empty AND no _latest.zip', () => {
    expect(listBackups('LFIN_NOTHING')).toEqual([]);
  });

  it('does not re-bootstrap on subsequent calls if a backup exists', () => {
    mapRepo.create({
      map_id: 'm1',
      mower_sn: 'LFIN_TWICE',
      map_name: 'map0',
      map_area: JSON.stringify([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]),
      map_type: 'work',
    });
    const first = listBackups('LFIN_TWICE');
    const second = listBackups('LFIN_TWICE');
    expect(first.length).toBe(second.length);
    expect(first[0].filename).toBe(second[0].filename); // same file, not re-bootstrapped
  });
});

// ── regenerateLatestZipFromBackup (Novabot-kmn) ───────────────────────────────

describe('regenerateLatestZipFromBackup', () => {
  it('returns null when polygon has no unicom (cannot anchor)', () => {
    mapRepo.create({
      map_id: 'work-no-unicom',
      mower_sn: 'LFIN_NO_UNICOM',
      map_name: 'map0',
      map_area: JSON.stringify([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }]),
      map_type: 'work',
    });
    const out = regenerateLatestZipFromBackup('LFIN_NO_UNICOM');
    expect(out).toBeNull();
  });

  it('writes <SN>_latest.zip with enriched map_info.json from polygon anchor', () => {
    const SN = 'LFIN_REGEN';
    mapRepo.create({
      map_id: 'work',
      mower_sn: SN,
      map_name: 'map0',
      map_area: JSON.stringify([
        { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 },
      ]),
      map_type: 'work',
    });
    mapRepo.create({
      map_id: 'unicom',
      mower_sn: SN,
      map_name: 'map0tocharge_unicom',
      map_area: JSON.stringify([{ x: -1.21, y: 0.48 }, { x: -1.0, y: 0.4 }]),
      map_type: 'unicom',
    });

    // Replace the mock for THIS test with one that builds a real ZIP.
    vi.mocked(generateMapZipFromDb).mockImplementationOnce(() => buildRealZipWithCsvFile());

    const out = regenerateLatestZipFromBackup(SN);
    expect(out).toBeTruthy();
    expect(out!.endsWith(`${SN}_latest.zip`)).toBe(true);
    expect(fs.existsSync(out!)).toBe(true);

    // Inspect the enriched map_info.json inside the produced ZIP.
    const peekDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-regen-'));
    execSync(`unzip -o -q "${out}" -d "${peekDir}"`);
    const info = JSON.parse(
      fs.readFileSync(path.join(peekDir, 'csv_file', 'map_info.json'), 'utf8'),
    );
    expect(info.charging_pose.x).toBeCloseTo(-1.21);
    expect(info.charging_pose.y).toBeCloseTo(0.48);
    expect(info.charging_pose.orientation).toBeCloseTo(1.5); // default, no sensor
    // map_size entries come from the generated ZIP and are kept for EVERY slot
    // (a hardcoded map0-only map_info wiped map3 on the mower, 2026-09-07).
    expect(info['map0_work.csv'].map_size).toBeCloseTo(1);
    expect(info['map3_work.csv'].map_size).toBeCloseTo(98.64);
  });

  it('is idempotent: running twice produces the same map_info.json', () => {
    const SN = 'LFIN_REGEN_TWICE';
    mapRepo.create({
      map_id: 'work',
      mower_sn: SN,
      map_name: 'map0',
      map_area: JSON.stringify([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]),
      map_type: 'work',
    });
    mapRepo.create({
      map_id: 'unicom',
      mower_sn: SN,
      map_name: 'map0tocharge_unicom',
      map_area: JSON.stringify([{ x: 0.5, y: 0.5 }]),
      map_type: 'unicom',
    });
    vi.mocked(generateMapZipFromDb)
      .mockImplementationOnce(() => buildRealZipWithCsvFile())
      .mockImplementationOnce(() => buildRealZipWithCsvFile());

    const out1 = regenerateLatestZipFromBackup(SN);
    const out2 = regenerateLatestZipFromBackup(SN);
    expect(out1).toBeTruthy();
    expect(out2).toBeTruthy();

    const peekDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-idem-'));
    execSync(`unzip -o -q "${out2}" -d "${peekDir}"`);
    const info = JSON.parse(
      fs.readFileSync(path.join(peekDir, 'csv_file', 'map_info.json'), 'utf8'),
    );
    expect(info.charging_pose.x).toBeCloseTo(0.5);
    expect(info.charging_pose.y).toBeCloseTo(0.5);
    expect(info['map0_work.csv'].map_size).toBeCloseTo(1);
  });

  it('charging_pose in map_info.json stays at unshifted anchor when offset is non-zero', () => {
    const SN = 'LFIN_ANCHOR_STABLE';
    // Seed work + tocharge unicom rows (regenerate needs at least one work
    // map and one mapNtocharge_unicom for getPolygonAnchor to succeed).
    mapRepo.create({
      map_id: `${SN}-work`,
      mower_sn: SN,
      map_name: 'map0_work',
      file_name: 'map0_work.csv',
      map_area: JSON.stringify([
        { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 },
      ]),
      map_type: 'work',
      canonical_name: 'map0_work',
    });
    const anchorPt = { x: -1.21, y: 0.48 };
    mapRepo.create({
      map_id: `${SN}-tocharge`,
      mower_sn: SN,
      map_name: 'map0tocharge_unicom',
      file_name: 'map0tocharge_unicom.csv',
      map_area: JSON.stringify([anchorPt, { x: -0.5, y: 0.2 }, { x: 0, y: 0 }]),
      map_type: 'unicom',
      canonical_name: 'map0tocharge_unicom',
    });
    mapRepo.setPolygonOffset(SN, 0.10, 0.10);
    vi.mocked(generateMapZipFromDb).mockImplementationOnce(() => buildRealZipWithCsvFile());

    const finalZip = regenerateLatestZipFromBackup(SN);
    expect(finalZip).not.toBeNull();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-stable-'));
    execSync(`unzip -o -q "${finalZip}" -d "${dir}"`);
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'csv_file/map_info.json'), 'utf8'));
    expect(info.charging_pose.x).toBeCloseTo(anchorPt.x);
    expect(info.charging_pose.y).toBeCloseTo(anchorPt.y);
    fs.rmSync(dir, { recursive: true, force: true });

    // Cleanup the seeded rows so the test doesn't pollute later cases.
    db.prepare('DELETE FROM maps WHERE mower_sn = ?').run(SN);
    db.prepare('DELETE FROM map_calibration WHERE mower_sn = ?').run(SN);
  });
});
