import { clearPositionTelemetry, ingestPositionTelemetry } from '../../services/positionTelemetry.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../mqtt/mapSync.js', () => ({ readLatestZipChargingPose: vi.fn() }));
vi.mock('../../services/mowerMapOperation.js', () => ({ readMowerMapSnapshot: vi.fn() }));
vi.mock('../../mqtt/sensorData.js', () => ({ deviceCache: new Map(), getDockPose: vi.fn() }));
import { deviceCache } from '../../mqtt/sensorData.js';
import { readMowerMapSnapshot } from '../../services/mowerMapOperation.js';
import { capturePortableBundle } from '../../services/portableBackup.js';
import { geometryFromMowerFiles, mowerFilesManifest } from '../../services/portableSnapshot.js';
import { mapRepo } from '../../db/repositories/maps.js';
import { parseBundle, exportBundle } from '../../services/portableMap.js';

const files = {
  csvFiles: { 'map0_work.csv': '0,0\n5,0\n5,5\n0,5\n',
    'map_info.json': JSON.stringify({ charging_pose: { x: 0.1, y: 0.2, orientation: 1.5 } }),
    'map0tocharge_unicom.csv': '0.1,0.2\n0,0\n' },
  x3CsvFiles: { 'map0tomap1_0_unicom.csv': '' },
  chargingStationYaml: 'charging_pose: [0.1, 0.2, 1.5]\n', posJson: '{"utm_origin":{"x":1,"y":2}}',
  mapFilesText: { 'map.yaml': 'image: map.pgm', 'map0.yaml': 'image: map0.pgm' },
  mapFilesB64: { 'map.pgm': Buffer.from('P5\n1 1\n255\n\xff', 'binary').toString('base64'),
    'map0.pgm': Buffer.from('P5\n1 1\n255\n\xff', 'binary').toString('base64') },
};
const raw = () => ({ result: 0, snapshot_consistent: true, captured_at: new Date().toISOString(),
  snapshot_manifest: mowerFilesManifest(files), csv_files: files.csvFiles, x3_csv_files: files.x3CsvFiles,
  charging_station_yaml: files.chargingStationYaml, pos_json: files.posJson,
  map_files_text: files.mapFilesText, map_files_b64: files.mapFilesB64 });

beforeEach(() => {
  clearPositionTelemetry('A'); ingestPositionTelemetry('A', { battery_state: 'CHARGING' });
  deviceCache.set('A', new Map([['battery_state', 'CHARGING']]));
  vi.mocked(readMowerMapSnapshot).mockResolvedValue(raw());
});

describe('consistent live portable snapshot', () => {
  it('uses live coordinates, DB aliases only, and preserves x3-only empty channels', async () => {
    mapRepo.create({ mower_sn: 'A', map_id: 'stale', canonical_name: 'map0', map_name: 'Garden',
      map_type: 'work', map_area: JSON.stringify([{ x: 99, y: 99 }]) });
    mapRepo.setPolygonOffset('A', 20, 30);
    const parsed = await parseBundle(await capturePortableBundle('A'));
    expect(parsed.polygons[0].points[0]).toEqual({ x: 0, y: 0 });
    expect(parsed.polygons[0].alias).toBe('Garden');
    expect(parsed.unicom.find(p => p.name === 'map0tomap1_0_unicom')?.points).toEqual([]);
    expect(parsed.mowerFiles?.x3CsvFiles).toEqual(files.x3CsvFiles);
    expect(parsed.metadata.snapshot).toMatchObject({ kind: 'live', complete: true, consistencyVerified: true });
  });
  it('rejects an unstable source, corrupt bytes and incomplete capture', async () => {
    vi.mocked(readMowerMapSnapshot).mockResolvedValueOnce({ ...raw(), snapshot_consistent: false });
    await expect(capturePortableBundle('A')).rejects.toThrow('consistent snapshot');
    vi.mocked(readMowerMapSnapshot).mockResolvedValueOnce({ ...raw(), pos_json: 'changed' });
    await expect(capturePortableBundle('A')).rejects.toThrow('manifest');
    const incomplete = { ...files, posJson: null };
    vi.mocked(readMowerMapSnapshot).mockResolvedValueOnce({ ...raw(), pos_json: null, snapshot_manifest: mowerFilesManifest(incomplete) });
    await expect(capturePortableBundle('A')).rejects.toThrow('Incomplete live snapshot');
  });
  it('uses the complete x3 connector when csv_file is its filtered subsequence', () => {
    const csvFiles = { ...files.csvFiles, 'map0tomap1_0_unicom.csv': '2,2\n3,3\n' };
    const x3CsvFiles = { 'map0tomap1_0_unicom.csv': '1,1\n2,2\n3,3\n4,4\n' };
    const geometry = geometryFromMowerFiles({ ...files, csvFiles, x3CsvFiles });
    expect(geometry.unicom.find(p => p.canonical === 'map0tomap1_0_unicom')?.points).toEqual([{x:1,y:1},{x:2,y:2},{x:3,y:3},{x:4,y:4}]);
  });
  it('rejects malformed coordinates and disagreeing connector copies', () => {
    expect(() => geometryFromMowerFiles({ ...files, x3CsvFiles: { 'map0tocharge_unicom.csv': '20,20\n21,21' } })).toThrow('Conflicting');
    expect(() => geometryFromMowerFiles({ ...files, csvFiles: { ...files.csvFiles, 'map0_work.csv': 'garbage,0' } })).toThrow('Invalid coordinate');
  });
  it('checks a present manifest but accepts old bundles with no consistency claim', async () => {
    const geometry = geometryFromMowerFiles(files);
    const input = { sn: 'A', chargerLat: 52, chargerLng: 6, rtkQuality: null, ...geometry,
      csvFilesRaw: files.csvFiles, chargingStationYaml: files.chargingStationYaml };
    const old = await parseBundle(await exportBundle(input));
    expect(old.metadata.snapshot).toBeUndefined();
    await expect(parseBundle(await exportBundle({ ...input, snapshot: { kind: 'live', capturedAt: new Date().toISOString(),
      complete: true, consistencyVerified: true, missing: [], files: {} } }))).rejects.toThrow('manifest');
  });
});
