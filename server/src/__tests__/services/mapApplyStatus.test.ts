/**
 * Status van het toepassen van een kaart op de maaier (sync_map →
 * regenerate_per_map_files → wachten tot de planner terug is), als virtuele
 * sensor zodat het dashboard kan tonen dat een net getekende of gekopieerde
 * zone nog niet klaar is. Aanleiding: na een zone-kopie gaf Start 50 s lang
 * "Clear error first" door Error 140 terwijl sync_map de planner herstartte.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../mqtt/sensorData.js', () => ({ deviceCache: new Map<string, Map<string, string>>() }));
vi.mock('../../dashboard/socketHandler.js', () => ({ forwardToDashboard: vi.fn() }));

import { deviceCache } from '../../mqtt/sensorData.js';
import { forwardToDashboard } from '../../dashboard/socketHandler.js';
import { beginMapApply, waitForPlannerBack, errorCodeOf, PHASE_KEY, ERROR_KEY } from '../../services/mapApplyStatus.js';

const SN = 'LFIN_APPLY';
const phase = () => deviceCache.get(SN)?.get(PHASE_KEY);

describe('beginMapApply', () => {
  beforeEach(() => { deviceCache.clear(); vi.mocked(forwardToDashboard).mockClear(); });

  it('publiceert elke fase live naar het dashboard en wist hem bij done', () => {
    const a = beginMapApply(SN);
    a.phase('syncing');
    expect(phase()).toBe('syncing');
    expect(vi.mocked(forwardToDashboard).mock.calls[0][1]).toEqual(new Map([[PHASE_KEY, 'syncing'], [ERROR_KEY, '']]));
    a.phase('regenerating');
    a.done();
    expect(phase()).toBe('');
    expect(vi.mocked(forwardToDashboard).mock.calls.map(c => (c[1] as Map<string, string>).get(PHASE_KEY))).toEqual(['syncing', 'regenerating', '']);
  });

  it('fail zet failed met een foutcode', () => {
    beginMapApply(SN).fail('sync_timeout');
    expect(phase()).toBe('failed');
    expect(deviceCache.get(SN)?.get(ERROR_KEY)).toBe('sync_timeout');
  });

  it('een oudere push overschrijft de status van een nieuwere niet', () => {
    const older = beginMapApply(SN);
    const newer = beginMapApply(SN);
    newer.phase('syncing');
    older.done();
    older.fail('sync_failed');
    older.phase('settling');
    expect(phase()).toBe('syncing');
  });
});

describe('errorCodeOf', () => {
  it('leest ruwe en vertaalde error_status', () => {
    expect(errorCodeOf('140')).toBe(140);
    expect(errorCodeOf('Error (140)')).toBe(140);
    expect(errorCodeOf('0')).toBe(0);
    expect(errorCodeOf('OK')).toBe(0);
    expect(errorCodeOf(undefined)).toBe(0);
  });
});

describe('waitForPlannerBack', () => {
  const timing = { settleMinMs: 30, settleMaxMs: 400, pollMs: 5 };
  beforeEach(() => { deviceCache.clear(); deviceCache.set(SN, new Map()); });

  it('wacht zolang Error 140 (planner herstart) staat, en is klaar zodra hij weg is', async () => {
    deviceCache.get(SN)!.set('error_status', '140');
    setTimeout(() => deviceCache.get(SN)!.set('error_status', '0'), 80);
    const t0 = Date.now();
    expect(await waitForPlannerBack(SN, timing)).toBe('settled');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
  });

  it('wacht altijd minstens settleMinMs, ook zonder fout (140 kan nog komen)', async () => {
    deviceCache.get(SN)!.set('error_status', '0');
    const t0 = Date.now();
    expect(await waitForPlannerBack(SN, timing)).toBe('settled');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(timing.settleMinMs);
  });

  it('geeft op na settleMaxMs als 140 blijft staan', async () => {
    deviceCache.get(SN)!.set('error_status', '140');
    expect(await waitForPlannerBack(SN, timing)).toBe('timeout');
  });

  it('een andere fout hoort niet bij de push: niet op wachten', async () => {
    deviceCache.get(SN)!.set('error_status', '151');
    expect(await waitForPlannerBack(SN, timing)).toBe('settled');
  });
});
