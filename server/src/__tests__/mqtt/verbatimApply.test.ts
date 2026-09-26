import { ingestPositionTelemetry, clearPositionTelemetry } from '../../services/positionTelemetry.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../mqtt/broker.js', () => ({ isSnBanned: () => false, isDeviceOnline: vi.fn(() => true) }));
vi.mock('../../dashboard/socketHandler.js', () => ({ emitDeviceBound: vi.fn(), emitDevicePaired: vi.fn() }));
vi.mock('../../mqtt/sensorData.js', () => ({ deviceCache: new Map() }));
vi.mock('../../services/frameValidation.js', () => ({ isFrameNavBlocked: () => false, markFrameUnvalidated: vi.fn() }));
vi.mock('../../services/mowerMapOperation.js', () => ({
  assertMowerMapOperation: vi.fn(),
  readMowerMapSnapshot: vi.fn(),
  withMowerMapOperation: vi.fn(),
}));
import { applyVerbatimToMower, verifyMowerMapFiles, type VerbatimMowerFiles } from '../../mqtt/mapSync.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { isDeviceOnline } from '../../mqtt/broker.js';
import { markFrameUnvalidated } from '../../services/frameValidation.js';
import { readMowerMapSnapshot, type MowerMapOperation } from '../../services/mowerMapOperation.js';

const pgm = Buffer.concat([Buffer.from('P5\n2 2\n255\n'), Buffer.alloc(4, 254)]).toString('base64');
const files = (): VerbatimMowerFiles => ({
  csvFiles: { 'map_info.json': JSON.stringify({ charging_pose: { x: 0, y: 0, orientation: 1.5 } }), 'map0tocharge_unicom.csv': '0,0\n1,0\n', 'map0_work.csv': '0,0\n1,0\n1,1\n' },
  x3CsvFiles: { 'map0_work.csv': '0,0\n1,0\n1,1\n', 'map0tocharge_unicom.csv': '0,0\n1,0\n' },
  mapFilesText: { 'map.yaml': 'image: map.pgm\n', 'map0.yaml': 'image: map0.pgm\n' },
  mapFilesB64: { 'map.pgm': pgm, 'map0.pgm': pgm },
  chargingStationYaml: 'charging_pose: [0, 0, 1.5]',
});
function snapshot(f = files()) {
  return { result: 0, snapshot_consistent: true, csv_files: f.csvFiles, x3_csv_files: f.x3CsvFiles,
    map_files_text: f.mapFilesText, map_files_b64: f.mapFilesB64, charging_station_yaml: f.chargingStationYaml, pos_json: '{"origin":123}' };
}
const command = vi.fn<MowerMapOperation['command']>();
const operation: MowerMapOperation = { sn: 'A', id: 'restore-A', command };

describe('confirmed verbatim apply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDeviceOnline).mockReturnValue(true);
    clearPositionTelemetry('A'); ingestPositionTelemetry('A', { battery_state: 'CHARGING' });
    deviceCache.set('A', new Map([['battery_state', 'CHARGING']]));
    vi.mocked(readMowerMapSnapshot).mockResolvedValue(snapshot());
    command.mockImplementation(async () => {
      expect(markFrameUnvalidated).toHaveBeenCalledWith('A');
      return { result: 0 };
    });
  });

  it('requires correlated firmware support before writing and keeps incomplete bundles untouched', async () => {
    vi.mocked(readMowerMapSnapshot).mockResolvedValue(null);
    expect(await applyVerbatimToMower('A', files(), operation)).toMatchObject({ pushed: false, error: 'snapshot_unavailable', uncertain: false });
    expect(command).not.toHaveBeenCalled();
    const incomplete = files();
    delete incomplete.mapFilesB64!['map0.pgm'];
    expect((await applyVerbatimToMower('A', incomplete, operation)).pushed).toBe(false);
    const wrongImage = files();
    wrongImage.mapFilesText!['map0.yaml'] = 'image: /other/map0.pgm\n';
    expect((await applyVerbatimToMower('A', wrongImage, operation)).pushed).toBe(false);
    const conflicting = files();
    conflicting.chargingStationYaml = 'charging_pose: [2, 3, 1.5]';
    expect((await applyVerbatimToMower('A', conflicting, operation)).validation.hardFailures).toContain('inconsistent_dock_anchor');
    expect(markFrameUnvalidated).not.toHaveBeenCalled();
  });

  it('rejects an offline or undocked mower before reading or writing', async () => {
    vi.mocked(isDeviceOnline).mockReturnValue(false);
    expect((await applyVerbatimToMower('A', files(), operation)).error).toBe('mower_offline');
    vi.mocked(isDeviceOnline).mockReturnValue(true);
    deviceCache.clear(); clearPositionTelemetry('A');
    expect((await applyVerbatimToMower('A', files(), operation)).error).toBe('mower_not_docked');
    expect(readMowerMapSnapshot).not.toHaveBeenCalled();
  });

  it('verifies exact CSV, separate x3 and raster sets plus unchanged pos.json', async () => {
    expect(await applyVerbatimToMower('A', files(), operation)).toMatchObject({ pushed: true });
    expect(command.mock.calls[0][1]).toMatchObject({ x3_csv_files: files().x3CsvFiles, restart_mapping: false });
    expect(command.mock.calls[0][1]).not.toHaveProperty('pos_json');
    vi.mocked(readMowerMapSnapshot).mockResolvedValueOnce(snapshot()).mockResolvedValueOnce({ ...snapshot(), pos_json: 'changed' });
    expect(await applyVerbatimToMower('A', files(), operation)).toMatchObject({ pushed: false, uncertain: true });
  });

  it('never treats ACK alone or timeout as success and reconciliation only reads', async () => {
    vi.mocked(readMowerMapSnapshot).mockResolvedValueOnce(snapshot()).mockResolvedValueOnce({ ...snapshot(), x3_csv_files: {} });
    expect((await applyVerbatimToMower('A', files(), operation)).error).toBe('readback_mismatch');
    command.mockResolvedValueOnce(null);
    expect(await applyVerbatimToMower('A', files(), operation)).toMatchObject({ pushed: false, error: 'write_timeout', uncertain: true });
    command.mockClear();
    expect((await verifyMowerMapFiles('A', files(), operation)).pushed).toBe(true);
    expect(command).not.toHaveBeenCalled();
  });
});
