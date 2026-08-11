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

  // Regressie (Task 6 review, finding 2): stop_navigation zet task_mode terug
  // op 0. De oude gate eiste task_mode === 1, dus een halverwege gestopte
  // maaibeurt die daarna naar het dock reed werd als 'charging' geclassificeerd
  // en de rand-dag watcher startte binnen 30 seconden een randmaai op een beurt
  // die de gebruiker juist bewust had afgebroken. De msg draagt de reden nog
  // wel, dus daar moet de classificatie op leunen, niet op task_mode.
  it('gedockt + CHARGING na handmatige stop met task_mode 0 → NIET charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'],
      ['task_mode', '0'],
      ['msg', 'Mode:COVERAGE Work:USER_STOP Recharge: FINISHED'],
      ['work_status', '0'],
    ]));
    expect(getMowerPhase('SN1')).toBe('other');
  });

  // Realistische vorm ná het dokken: de live Work-status is al doorgerold naar
  // WAIT en de uitkomst van de afgebroken beurt zit nog in de ruwe
  // work_status-code (10 = USER_STOP, zie IDLE_WORK_STATUS in mowingService).
  // Alleen op de msg toetsen zou dit geval missen.
  it('gedockt + CHARGING met work_status 10 (USER_STOP) na het dokken → NIET charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'],
      ['task_mode', '0'],
      ['msg', 'Mode:COVERAGE Work:WAIT Prev work:USER_STOP Recharge: FINISHED'],
      ['work_status', '10'],
    ]));
    expect(getMowerPhase('SN1')).toBe('other');
  });

  // Regressie (Task 6 review ronde 2): "Work:CANCELLED" is op deze firmware
  // GEEN betrouwbaar afbreeksignaal. Dit is de LETTERLIJKE msg die een netjes
  // afgeronde beurt rapporteert nadat hij gedockt is, twee keer los gemeld door
  // gebruikers in issue #17 (waltervl) en vastgelegd in
  // server/src/cloud-api/routes/equipmentState.ts:243-264. Work:FINISHED
  // ontbreekt hier; de afronding zit in "Prev work:USER_RECHARGE_STOP" en
  // "Recharge: FINISHED". Wie CANCELLED alsnog als afbreking behandelt, maakt
  // de hele randmaai-feature stil dood op echte hardware terwijl de suite groen
  // blijft. NIET "vereenvoudigen" naar een CANCELLED-is-afgebroken regel.
  it('afgeronde beurt die als Work:CANCELLED rapporteert (issue #17, live) → WEL charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'],
      ['msg', 'Mode:COVERAGE Work:CANCELLED Prev work:USER_RECHARGE_STOP Recharge: FINISHED'],
    ]));
    expect(getMowerPhase('SN1')).toBe('charging');
  });

  it('zelfde live msg met work_status 2 (CANCELLED) → WEL charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'],
      ['work_status', '2'],
      ['msg', 'Mode:COVERAGE Work:CANCELLED Prev work:USER_RECHARGE_STOP Recharge: FINISHED'],
    ]));
    expect(getMowerPhase('SN1')).toBe('charging');
  });

  // Tegenhanger: dezelfde doorgerolde vorm, maar met een gebruikersstop als
  // vorige status. Dat is wél een afgebroken beurt en moet geblokkeerd blijven.
  // Dit is het enige veld dat de twee gevallen uit elkaar houdt.
  it("Work:CANCELLED met 'Prev work:USER_STOP' → NIET charging (afgebroken)", () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'],
      ['work_status', '0'],
      ['msg', 'Mode:COVERAGE Work:CANCELLED Prev work:USER_STOP Recharge: FINISHED'],
    ]));
    expect(getMowerPhase('SN1')).toBe('other');
  });

  // GEDOCUMENTEERD GAT, bewust zo gelaten. Als de firmware bij die live
  // afgeronde beurt work_status 11 (USER_RECHARGE_STOP) meldt in plaats van 2,
  // dan is die toestand niet te onderscheiden van een mid-mow laadpauze die
  // toevallig al naar Work:WAIT/CANCELLED is doorgerold: exact dezelfde
  // msg-velden, exact dezelfde code. Dan kiezen we de veilige kant (niet
  // vuren), want de andere kant betekent een randmaai starten terwijl de
  // firmware de gepauzeerde coverage hervat. Kosten: de randmaai blijft stil
  // achterwege. Zie het rapport: dit is het hardware-verificatiepunt (welke
  // work_status meldt een AFGERONDE beurt op het dock?).
  it('GAP: dezelfde live msg met work_status 11 → other (veilige kant, zie rapport)', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'],
      ['work_status', '11'],
      ['msg', 'Mode:COVERAGE Work:CANCELLED Prev work:USER_RECHARGE_STOP Recharge: FINISHED'],
    ]));
    expect(getMowerPhase('SN1')).toBe('other');
  });

  it('afgebroken door tijdslimiet of fout → NIET charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'],
      ['msg', 'Mode:COVERAGE Work:TIME_LIMIT_STOP Recharge: FINISHED'],
    ]));
    expect(getMowerPhase('SN1')).toBe('other');
    deviceCache.set('SN2', new Map([
      ['battery_state', 'CHARGING'],
      ['msg', 'Mode:COVERAGE Work:ERROR_STOP Recharge: FINISHED'],
    ]));
    expect(getMowerPhase('SN2')).toBe('other');
  });

  // Tegenhanger van de vorige tests: NIET over-strak afknijpen. Dit is de
  // letterlijke msg-vorm van een afgeronde beurt op het dock (zie de captures
  // in research/): huidige status WAIT, uitkomst FINISHED in "Prev work". Zou
  // dit 'other' opleveren, dan vuurt de rand-dag watcher nooit en is de hele
  // feature dood. task_mode staat hier nog op 1.
  it('afgeronde beurt op het dock (Work:WAIT + Prev work:FINISHED) → WEL charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'],
      ['task_mode', '1'],
      ['msg', 'Mode:COVERAGE Work:WAIT Prev work:FINISHED Recharge: FINISHED'],
      ['work_status', '0'],
    ]));
    expect(getMowerPhase('SN1')).toBe('charging');
  });

  it('afgeronde beurt met Work:FINISHED en task_mode 1 → WEL charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'],
      ['task_mode', '1'],
      ['msg', 'Mode:COVERAGE Work:FINISHED Recharge: FINISHED'],
      ['work_status', '0'],
    ]));
    expect(getMowerPhase('SN1')).toBe('charging');
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
