import { describe, it, expect, vi, beforeEach } from 'vitest';

const published: Array<Record<string, unknown>> = [];
const extended: Array<Record<string, unknown>> = [];
let devHandlers: Array<(d: Record<string, unknown>) => void> = [];
let extHandlers: Array<(d: Record<string, unknown>) => void> = [];

vi.mock('../../mqtt/mapSync.js', () => ({
  publishToDevice: vi.fn((_sn: string, p: Record<string, unknown>) => { published.push(p); }),
  getNextCmdNum: vi.fn(() => 42),
  onDeviceResponse: vi.fn((_sn: string, h: (d: Record<string, unknown>) => void) => { devHandlers.push(h); }),
  offDeviceResponse: vi.fn((_sn: string, h: (d: Record<string, unknown>) => void) => {
    devHandlers = devHandlers.filter((x) => x !== h);
  }),
  onExtendedResponse: vi.fn((_sn: string, h: (d: Record<string, unknown>) => void) => { extHandlers.push(h); }),
  offExtendedResponse: vi.fn((_sn: string, h: (d: Record<string, unknown>) => void) => {
    extHandlers = extHandlers.filter((x) => x !== h);
  }),
}));
vi.mock('../../mqtt/extendedCommands.js', () => ({
  publishExtendedCommand: vi.fn((_sn: string, c: Record<string, unknown>) => { extended.push(c); }),
}));
// Break the broker chain that fires when sensorData.ts is imported (same
// precedent as __tests__/mqtt/sensorData.test.ts) — without this,
// socketHandler.js -> broker.js -> demoSimulator.js -> socketHandler.js
// circular import throws "Cannot access 'demoModeChecker' before
// initialization" at module-init time, unrelated to autoMap.ts itself.
vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(false),
  writeRawPublish: vi.fn(),
  getBrokerDiagnostics: vi.fn().mockReturnValue({}),
  startMqttBroker: vi.fn(),
  banishSn: vi.fn(),
  forceDisconnectDevice: vi.fn(),
  lookupMac: vi.fn(),
}));

import { deviceCache } from '../../mqtt/sensorData.js';
import { startAutoMap, getStatus, acceptProposal } from '../../services/autoMap.js';
import { createSession, updatePhase } from '../../db/repositories/autoMapSessions.js';
import { db } from '../../db/database.js';

const SN = 'LFIN_TEST_AUTOMAP';
function setCache(fields: Record<string, string>) {
  deviceCache.set(SN, new Map(Object.entries(fields)));
}
const emitExt = (d: Record<string, unknown>) => { for (const h of [...extHandlers]) h(d); };
const emitDev = (d: Record<string, unknown>) => { for (const h of [...devHandlers]) h(d); };
const flush = () => new Promise((r) => setTimeout(r, 750)); // > 600ms save-delay

describe('autoMap orchestrator', () => {
  beforeEach(() => {
    published.length = 0; extended.length = 0;
    devHandlers = []; extHandlers = [];
  });

  it('preflight weigert bij lage accu', async () => {
    setCache({ battery_power: '35', rtk_fix_quality: '4' });
    const r = await startAutoMap(SN, { mode: 'test' });
    expect(r).toEqual({ ok: false, error: 'preflight_battery' });
  });

  it('preflight weigert zonder RTK Fixed', async () => {
    setCache({ battery_power: '80', rtk_fix_quality: '1' });
    const r = await startAutoMap(SN, { mode: 'test' });
    expect(r).toEqual({ ok: false, error: 'preflight_rtk' });
  });

  it('record-flow: LOOP_CLOSED -> afrondreeks -> awaiting_review', async () => {
    setCache({ battery_power: '80', rtk_fix_quality: '4' });
    const r = await startAutoMap(SN, { mode: 'record', radiusM: 30 });
    expect(r.ok).toBe(true);
    // start_scan_map is verstuurd met exact het app-payload
    expect(published[0]).toEqual({
      start_scan_map: { model: 'manual', mapName: 'map0', type: 0, cmd_num: 42 },
    });
    emitDev({ start_scan_map_respond: { result: 0 } });
    await flush();
    // volgmotor gestart via extended command
    expect(extended[0]).toHaveProperty('start_auto_map_test');
    // rit klaar: LOOP_CLOSED
    emitExt({ auto_map_status: { phase: 'result', code: 0, name: 'LOOP_CLOSED' } });
    await flush();
    expect(published[1]).toHaveProperty('stop_scan_map');
    emitDev({ stop_scan_map_respond: { result: 0 } });
    await flush();
    expect(published[2]).toEqual({ save_map: { mapName: 'map0', type: 0, cmd_num: 42 } });
    emitDev({ save_map_respond: { result: 0, type: 0 } });
    await flush();
    expect(published[3]).toHaveProperty('save_recharge_pos');
    emitDev({ save_recharge_pos_respond: { result: 0 } });
    await flush();
    expect(published[4]).toEqual({ save_map: { mapName: 'map0', type: 1, cmd_num: 42 } });
    emitDev({ save_map_respond: { result: 0, type: 1 } });
    await flush();
    expect(getStatus(SN)?.phase).toBe('awaiting_review');
    expect(acceptProposal(SN)).toBe(true);
    expect(getStatus(SN)?.phase).toBe('done');
  });

  it('geofence-abort in record-mode stuurt stop_scan_map ZONDER saves', async () => {
    setCache({ battery_power: '80', rtk_fix_quality: '4' });
    await startAutoMap(SN, { mode: 'record' });
    emitDev({ start_scan_map_respond: { result: 0 } });
    await flush();
    emitExt({ auto_map_status: { phase: 'aborted', error: 'geofence', dist_m: 31.2 } });
    await flush();
    const cmds = published.map((p) => Object.keys(p)[0]);
    expect(cmds).toContain('stop_scan_map');
    expect(cmds).not.toContain('save_map');
    expect(getStatus(SN)?.phase).toBe('aborted');
    expect(getStatus(SN)?.error).toBe('geofence');
  });

  it('abort tijdens de afrondreeks stuurt geen verdere saves', async () => {
    const sn = `${SN}_FINISHING_ABORT`;
    deviceCache.set(sn, new Map(Object.entries({ battery_power: '80', rtk_fix_quality: '4' })));
    const r = await startAutoMap(sn, { mode: 'record', radiusM: 30 });
    expect(r.ok).toBe(true);
    emitDev({ start_scan_map_respond: { result: 0 } });
    await flush();
    // rit klaar: LOOP_CLOSED -> finalize() start en stuurt stop_scan_map
    emitExt({ auto_map_status: { phase: 'result', code: 0, name: 'LOOP_CLOSED' } });
    await flush();
    expect(published.map((p) => Object.keys(p)[0])).toContain('stop_scan_map');
    // aborted-event (geofence) komt VÓÓR de stop_scan_map_respond binnen —
    // dit mag finalize() niet onderbreken met een abortRecording, alleen de
    // cancelRequested-vlag zetten.
    emitExt({ auto_map_status: { phase: 'aborted', error: 'geofence', dist_m: 31.2 } });
    emitDev({ stop_scan_map_respond: { result: 0 } });
    await flush();
    const cmds = published.map((p) => Object.keys(p)[0]);
    expect(cmds).not.toContain('save_map');
    expect(getStatus(sn)?.phase).toBe('aborted');
  });

  it('verweesde sessie na herstart blokkeert nieuwe start niet', async () => {
    const sn = `${SN}_ORPHAN`;
    const orphan = createSession(sn, 'record', 30);
    updatePhase(orphan.id, 'recording'); // niet finished — simuleert crash tijdens run
    deviceCache.set(sn, new Map(Object.entries({ battery_power: '80', rtk_fix_quality: '4' })));
    const r = await startAutoMap(sn, { mode: 'test' });
    expect(r).toMatchObject({ ok: true });
    const orphanRow = db.prepare('SELECT * FROM auto_map_sessions WHERE id = ?').get(orphan.id) as
      { phase: string; error: string | null };
    expect(orphanRow.phase).toBe('error');
    expect(orphanRow.error).toBe('orphaned_by_restart');
  });
});
