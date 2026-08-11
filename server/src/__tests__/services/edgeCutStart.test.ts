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

// HERKOMST VAN DE MSG-STRINGS IN DIT BESTAND (Task 6 review ronde 3).
// Ronde 1 en 2 gingen allebei mis op geïdealiseerde msg-vormen die groen bleven
// terwijl de feature op echte hardware stuk was. Daarom staat bij elke test of
// de string uit een ECHTE CAPTURE komt of GECONSTRUEERD is; alleen de eerste
// soort draagt bewijskracht over het gedrag in het veld.
//
// ECHTE CAPTURES (research/documents/obstacle-capture-*.jsonl, volledige
// report_state_robot payloads):
//   "Mode:COVERAGE Work:FINISHED Prev work:FINISHED_ONCE Recharge: FINISHED"
//        cov_ratio 1, finished_num 1, work_status 9, task_mode 1, error_status 0
//        → dit is een AFGERONDE maaibeurt op het dock.
//   "Mode:COVERAGE Work:WAIT Prev work:WAIT Recharge: FINISHED"
//        cov_ratio 0, finished_num 0, work_status 0  → idle op het dock.
//   "Mode:MAPPING Work:MANUAL_MAPPING_OBSTACLE Prev work:REQUEST_START Recharge: WAIT"
//        cov_ratio 0  → bewijst dat "Recharge: WAIT" geen afrondingssignaal is.
// GEDOCUMENTEERDE LIVE MELDING (geen capture met velden, wel twee losse
// gebruikersmeldingen in issue #17, vastgelegd in equipmentState.ts:243-264):
//   "Mode:COVERAGE Work:CANCELLED Prev work:USER_RECHARGE_STOP Recharge: FINISHED"
// GECONSTRUEERD (nergens in deze repo vastgelegd, samengesteld uit de
// gedocumenteerde veldpatronen): alles wat hieronder als zodanig gemarkeerd is.
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
  // ECHTE CAPTURE, volledige payload. Dit is de referentievorm van een
  // afgeronde maaibeurt op het dock en beantwoordt meteen de openstaande
  // hardware-vraag uit ronde 2: work_status is 9 (FINISHED), niet 11.
  it('ECHTE CAPTURE: afgeronde beurt op het dock (ws 9, cov_ratio 1) → WEL charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'], ['work_status', '9'], ['task_mode', '1'],
      ['cov_ratio', '1'], ['finished_num', '1'], ['error_status', '0'],
      ['msg', 'Mode:COVERAGE Work:FINISHED Prev work:FINISHED_ONCE Recharge: FINISHED'],
    ]));
    expect(getMowerPhase('SN1')).toBe('charging');
  });

  // GEDOCUMENTEERDE LIVE MELDING (issue #17) + het dekkingsbewijs uit de echte
  // capture hierboven. Zo ziet een afgeronde beurt eruit die als CANCELLED
  // rapporteert. NIET "vereenvoudigen" naar een CANCELLED-is-afgebroken regel:
  // dat maakte in ronde 1 de hele feature stil dood.
  it('issue #17 CANCELLED-afrondvorm MET dekkingsbewijs → WEL charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'], ['work_status', '2'],
      ['cov_ratio', '1'], ['finished_num', '1'],
      ['msg', 'Mode:COVERAGE Work:CANCELLED Prev work:USER_RECHARGE_STOP Recharge: FINISHED'],
    ]));
    expect(getMowerPhase('SN1')).toBe('charging');
  });

  // Regressie (Task 6 review ronde 3, finding NEW-2). Ná het dokken rollen de
  // msg-velden door en wordt een halverwege afgebroken beurt BYTE-IDENTIEK aan
  // de afrondvorm hierboven: elk msg-veld beschrijft de dok-cyclus, niet de
  // maaibeurt. Alleen cov_ratio gaat over de maaibeurt zelf. Zonder die toets
  // startte de server een autonome randmaai op een beurt die op 40% was
  // gestopt, mogelijk terwijl de firmware de coverage weer oppakt.
  it('zelfde msg maar cov_ratio 0.4 (halverwege gestopt) → NIET charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'], ['work_status', '2'],
      ['cov_ratio', '0.4'], ['finished_num', '0'],
      ['msg', 'Mode:COVERAGE Work:CANCELLED Prev work:USER_RECHARGE_STOP Recharge: FINISHED'],
    ]));
    expect(getMowerPhase('SN1')).toBe('other');
  });

  it('zelfde msg zonder cov_ratio/finished_num → NIET charging (geen bewijs = veilige kant)', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'], ['work_status', '2'],
      ['msg', 'Mode:COVERAGE Work:CANCELLED Prev work:USER_RECHARGE_STOP Recharge: FINISHED'],
    ]));
    expect(getMowerPhase('SN1')).toBe('other');
  });

  it('onleesbare cov_ratio → NIET charging (veilige kant)', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'], ['work_status', '2'],
      ['cov_ratio', 'n/a'], ['finished_num', '0'],
      ['msg', 'Mode:COVERAGE Work:CANCELLED Prev work:USER_RECHARGE_STOP Recharge: FINISHED'],
    ]));
    expect(getMowerPhase('SN1')).toBe('other');
  });

  // cov_ratio komt als fractie 0..1 binnen; svgMap.ts en de app accepteren ook
  // een percentage-encoding. Beide moeten hetzelfde oordeel geven, anders zou
  // een firmware die 98 stuurt als 98% gelezen worden als "ver boven 0.95" en
  // een die 40 stuurt als "ver boven 0.95" ook.
  it('cov_ratio als percentage: 98 telt als gedekt, 40 niet', () => {
    const withRatio = (v: string) => new Map([
      ['battery_state', 'CHARGING'], ['work_status', '2'], ['cov_ratio', v], ['finished_num', '0'],
      ['msg', 'Mode:COVERAGE Work:CANCELLED Prev work:USER_RECHARGE_STOP Recharge: FINISHED'],
    ]);
    deviceCache.set('SN1', withRatio('98'));
    expect(getMowerPhase('SN1')).toBe('charging');
    deviceCache.set('SN2', withRatio('40'));
    expect(getMowerPhase('SN2')).toBe('other');
  });

  // GECONSTRUEERD (geen capture): de doorgerolde vorm met een gebruikersstop
  // als vorige status. Deze test leunt op prevWorkAborted, en dat patroon is
  // een aanname: de ENE echte capture laat zien dat "Prev work" bij het dokken
  // doorrolt (naar FINISHED_ONCE), dus mogelijk overleeft USER_STOP dat niet.
  // De echte bescherming voor dit scenario is daarom de cov_ratio-toets
  // hierboven, niet deze test.
  it('GECONSTRUEERD: Work:CANCELLED met Prev work:USER_STOP → NIET charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'], ['work_status', '0'],
      ['cov_ratio', '1'], ['finished_num', '1'],
      ['msg', 'Mode:COVERAGE Work:CANCELLED Prev work:USER_STOP Recharge: FINISHED'],
    ]));
    expect(getMowerPhase('SN1')).toBe('other');
  });

  // Finding NEW-3, deel 1: onderbroken coverage laat "Prev work:COVERING"
  // achter. Bewust met "Recharge: FINISHED" én dekkingsbewijs, zodat alle
  // andere regels deze msg zouden doorlaten en ALLEEN prevWorkAborted hem nog
  // tegenhoudt. Zonder COVERING in dat patroon geeft deze test 'charging'.
  it('GECONSTRUEERD: Prev work:COVERING met afrondstaart → NIET charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'], ['work_status', '0'],
      ['cov_ratio', '1'], ['finished_num', '1'],
      ['msg', 'Mode:COVERAGE Work:CANCELLED Prev work:COVERING Recharge: FINISHED'],
    ]));
    expect(getMowerPhase('SN1')).toBe('other');
  });

  it('GECONSTRUEERD: Prev work:MOVING / RUNNING → NIET charging', () => {
    for (const prev of ['MOVING', 'RUNNING']) {
      deviceCache.set('SN1', new Map([
        ['battery_state', 'CHARGING'], ['work_status', '0'],
        ['cov_ratio', '1'], ['finished_num', '1'],
        ['msg', `Mode:COVERAGE Work:CANCELLED Prev work:${prev} Recharge: FINISHED`],
      ]));
      expect(getMowerPhase('SN1')).toBe('other');
    }
  });

  // Finding NEW-3, deel 2: "Recharge: WAIT" is GEEN afrondingssignaal. Het
  // beschrijft de dok-cyclus en komt in de echte captures ook midden in een
  // mapping-sessie voor ("Mode:MAPPING Work:MANUAL_MAPPING_OBSTACLE ...
  // Recharge: WAIT", cov_ratio 0). Zou het wél als afronding tellen, dan zou
  // een kale CANCELLED daarmee worden witgewassen en 'charging' opleveren.
  it("GECONSTRUEERD: 'Recharge: WAIT' wast een CANCELLED niet wit", () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'], ['work_status', '0'],
      ['cov_ratio', '1'], ['finished_num', '1'],
      ['msg', 'Mode:COVERAGE Work:CANCELLED Prev work:WAIT Recharge: WAIT'],
    ]));
    expect(getMowerPhase('SN1')).toBe('other');
  });

  // GAP, bewust de veilige kant. Meldt een afgeronde beurt onverhoopt tóch
  // work_status 11, dan blijft de randmaai achterwege. De echte capture zegt
  // dat het 9 is, dus dit is nu een randgeval in plaats van een open vraag.
  it('GAP: afrondvorm met work_status 11 → other (veilige kant)', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'], ['work_status', '11'],
      ['cov_ratio', '1'], ['finished_num', '1'],
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
