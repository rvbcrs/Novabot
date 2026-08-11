import { describe, it, expect, beforeEach, vi } from 'vitest';

// Zelfde mock-conventie als mowingService.test.ts: zonder deze mocks laadt
// mowingService.ts (via mapSync.js) de echte broker.js/socketHandler.js/
// demoSimulator.js keten, die bij deze import-volgorde een pre-existente
// TDZ-crash geeft ("Cannot access 'demoModeChecker' before initialization",
// onafhankelijk van dit task, ook aanwezig op master).
// isDeviceOnline is dynamisch: alleen 'OFFLINE_SN' is offline, zodat zowel de
// offline-guard test als de succespad-test (echte publishToDevice-call) in
// dit bestand passen zonder losse mock-registraties per test.
vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn((sn: string) => sn !== 'OFFLINE_SN'),
}));
vi.mock('../../mqtt/mapSync.js', () => ({
  publishToDevice: vi.fn(),
}));

import { getMowerPhase, startEdgeCut } from '../../services/mowingService.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { publishToDevice } from '../../mqtt/mapSync.js';

describe('getMowerPhase', () => {
  beforeEach(() => deviceCache.clear());
  it('CHARGING battery_state → charging', () => {
    deviceCache.set('SN1', new Map([['battery_state', 'CHARGING'], ['work_status', '0']]));
    expect(getMowerPhase('SN1')).toBe('charging');
  });
  it('actieve maaistatus → mowing', () => {
    deviceCache.set('SN1', new Map([['work_status', '100'], ['msg', 'Work:COVERING']]));
    expect(getMowerPhase('SN1')).toBe('mowing');
  });
  it('onbekend/leeg → other', () => {
    expect(getMowerPhase('SNX')).toBe('other');
  });

  // Regressie (Task 5 review, finding 1): de firmware pauzeert een lopende
  // coverage-taak voor een low-battery recharge, dockt, laadt op en hervat
  // de taak zelf zodra de accu ~96% is (coverContinueDeal, zie
  // research/documents/firmware-auto-continue-after-recharge.md). battery_state
  // staat dan al op CHARGING terwijl de taak feitelijk nog loopt (gepauzeerd).
  // Als getMowerPhase dat als 'charging' zou classificeren, vuurt de rand-dag
  // watcher (Task 6) startEdgeCut af terwijl de firmware de gepauzeerde
  // coverage hervat: twee conflicterende bewegingscommando's op echte
  // hardware. Dit moet dus 'other' opleveren (watcher blijft wachten), NIET
  // 'charging'. Zie ook dashboard/src/utils/mowerActivity.ts:isInterruptedCoverage,
  // waarvan deze classificatie is overgenomen.
  it('gedockt + CHARGING maar nog gepauzeerde coverage (mid-mow recharge) → NIET charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'],
      ['task_mode', '1'],
      ['msg', 'Mode:COVERAGE Work:USER_RECHARGE_STOP Recharge: FINISHED'],
      ['work_status', '11'],
    ]));
    expect(getMowerPhase('SN1')).toBe('other');
  });

  it('gedockt + CHARGING met gepauzeerde coverage door user_stop → NIET charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'],
      ['task_mode', '1'],
      ['msg', 'Mode:COVERAGE Work:USER_STOP Recharge: WAIT'],
      ['work_status', '10'],
    ]));
    expect(getMowerPhase('SN1')).toBe('other');
  });
});

describe('startEdgeCut guards', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offline maaier → ok:false', () => {
    const r = startEdgeCut('OFFLINE_SN', 'map0', 40);
    expect(r.ok).toBe(false);
    expect(publishToDevice).not.toHaveBeenCalled();
  });

  it('lege sn → ok:false', () => {
    const r = startEdgeCut('', 'map0', 40);
    expect(r.ok).toBe(false);
    expect(publishToDevice).not.toHaveBeenCalled();
  });
});

describe('startEdgeCut succespad', () => {
  beforeEach(() => vi.clearAllMocks());

  // Pint de exacte payload-vorm die de app ook stuurt (zie CLAUDE.md): geen
  // hernoemde velden, bladeHeight blijft in mm. Een toekomstige rename of
  // eenheid-wijziging breekt deze test in plaats van stil de maaier te laten
  // negeren of op de verkeerde hoogte te laten maaien.
  it('stuurt exact { start_edge_cut: { mapName, bladeHeight } } in mm via publishToDevice', () => {
    const r = startEdgeCut('ONLINE_SN', 'map0', 40);
    expect(r.ok).toBe(true);
    expect(publishToDevice).toHaveBeenCalledOnce();
    expect(vi.mocked(publishToDevice).mock.calls[0][1]).toMatchObject({
      start_edge_cut: { mapName: 'map0', bladeHeight: 40 },
    });
  });

  it('geeft bladeHeightMm ongewijzigd door voor een andere waarde', () => {
    startEdgeCut('ONLINE_SN', 'map1', 65);
    expect(vi.mocked(publishToDevice).mock.calls[0][1]).toMatchObject({
      start_edge_cut: { mapName: 'map1', bladeHeight: 65 },
    });
  });
});
