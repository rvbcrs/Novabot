import { ingestPositionTelemetry, clearPositionTelemetry } from '../../services/positionTelemetry.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../mqtt/broker.js', () => ({ isSnBanned: () => false, isDeviceOnline: vi.fn(() => true) }));
vi.mock('../../dashboard/socketHandler.js', () => ({ emitDeviceBound: vi.fn(), emitDevicePaired: vi.fn() }));
vi.mock('../../mqtt/sensorData.js', () => ({ deviceCache: new Map() }));
vi.mock('../../services/frameValidation.js', () => ({ isFrameNavBlocked: () => false, markFrameUnvalidated: vi.fn(), markMapInstallPending: vi.fn(), clearMapInstallPending: vi.fn() }));
const apply = vi.hoisted(() => ({ phase: () => {}, fail: (() => {}) as (e: string) => void, done: () => {} }));
vi.mock('../../services/mapApplyStatus.js', () => ({ beginMapApply: () => apply }));
vi.mock('../../services/portableBackup.js', () => ({ listBackups: () => [], readBackup: () => Buffer.from('zip') }));
vi.mock('../../services/portableMap.js', () => ({ parseBundle: async () => ({ mowerFiles: files() }) }));
vi.mock('../../services/mowerMapOperation.js', () => ({
  assertMowerMapOperation: vi.fn(),
  readMowerMapSnapshot: vi.fn(),
  withMowerMapOperation: vi.fn(),
}));
import { applyVerbatimToMower, verifyMowerMapFiles, pushMapToMowerVerbatim, type VerbatimMowerFiles } from '../../mqtt/mapSync.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { isDeviceOnline } from '../../mqtt/broker.js';
import { markFrameUnvalidated } from '../../services/frameValidation.js';
import { readMowerMapSnapshot, withMowerMapOperation, type MowerMapOperation } from '../../services/mowerMapOperation.js';

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
    command.mockResolvedValue({ result: 0 });
  });

  // Like sync_map: only a new origin or dock file changes the frame. pos.json is
  // never written here, so a write that keeps charging_station.yaml leaves the
  // frame as it was; a map edit no longer asks for a re-anchor every time.
  it('leaves the frame alone when charging_station.yaml stays the same', async () => {
    expect(await applyVerbatimToMower('A', files(), operation)).toMatchObject({ pushed: true });
    expect(markFrameUnvalidated).not.toHaveBeenCalled();
  });

  it('marks the frame unvalidated before a write that changes charging_station.yaml', async () => {
    vi.mocked(readMowerMapSnapshot).mockResolvedValueOnce({ ...snapshot(), charging_station_yaml: 'charging_pose: [5, 5, 0]' });
    command.mockImplementation(async () => {
      expect(markFrameUnvalidated).toHaveBeenCalledWith('A');
      return { result: 0 };
    });
    expect(await applyVerbatimToMower('A', files(), operation)).toMatchObject({ pushed: true });
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

  // seam_fix_daemon (custom-50) rewrites map.pgm, the mapN.pgm and the PNGs as
  // soon as they are written: same size, other pixels. An exact compare read a
  // good edit back as failed and left the install pending (GH #159).
  const pgmOf = (w: number, h: number, fill: number) =>
    Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), Buffer.alloc(w * h, fill)]).toString('base64');
  const pngOf = (w: number, h: number, extra: number) => {
    const ihdr = Buffer.alloc(25);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ihdr, 0);
    ihdr.writeUInt32BE(13, 8); ihdr.write('IHDR', 12, 'ascii');
    ihdr.writeUInt32BE(w, 16); ihdr.writeUInt32BE(h, 20); ihdr[24] = 8;
    return Buffer.concat([ihdr, Buffer.from([extra])]).toString('base64');
  };
  it('accepts rasters the mower rewrote at the same size', async () => {
    const sent = files();
    sent.mapFilesB64!['map.png'] = pngOf(2, 2, 1);
    const rewritten = snapshot(sent);
    rewritten.map_files_b64 = { 'map.pgm': pgmOf(2, 2, 0), 'map0.pgm': pgmOf(2, 2, 254), 'map.png': pngOf(2, 2, 7) };
    vi.mocked(readMowerMapSnapshot).mockResolvedValueOnce(snapshot(sent)).mockResolvedValueOnce(rewritten);
    expect(await applyVerbatimToMower('A', sent, operation)).toMatchObject({ pushed: true });
  });

  it('still rejects a raster of another size, a missing raster and changed text files', async () => {
    const otherSize = snapshot();
    otherSize.map_files_b64 = { ...otherSize.map_files_b64, 'map0.pgm': pgmOf(3, 2, 254) };
    const missing = snapshot();
    missing.map_files_b64 = { 'map.pgm': files().mapFilesB64!['map.pgm'] };
    const yaml = snapshot();
    yaml.map_files_text = { ...yaml.map_files_text, 'map0.yaml': 'image: other.pgm\n' };
    for (const after of [otherSize, missing, yaml]) {
      vi.mocked(readMowerMapSnapshot).mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(after);
      expect(await applyVerbatimToMower('A', files(), operation)).toMatchObject({ pushed: false, error: 'readback_mismatch' });
    }
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

// A failed edit push only logged "GEBLOKKEERD door kaartvalidatie": the cause
// was lost and map_apply_phase never said failed, so the dashboard's Retry
// banner never showed (LFIN1231000265, Oct 2026).
describe('a failed verbatim push', () => {
  it('shows the failure with its cause, so the dashboard offers Retry', async () => {
    const sn = 'LFIN_A';
    vi.mocked(isDeviceOnline).mockReturnValue(true);
    clearPositionTelemetry(sn); ingestPositionTelemetry(sn, { battery_state: 'CHARGING' });
    vi.mocked(readMowerMapSnapshot).mockResolvedValue(snapshot());
    vi.mocked(withMowerMapOperation).mockImplementation(async (_sn, fn) => fn({ ...operation, sn }));
    const failed = vi.spyOn(apply, 'fail');
    command.mockResolvedValueOnce(null);

    expect(await pushMapToMowerVerbatim(sn, 'edit.zip')).toMatchObject({ ok: false, error: 'write_timeout' });
    expect(failed).toHaveBeenCalledWith('sync_timeout');
  });
});
