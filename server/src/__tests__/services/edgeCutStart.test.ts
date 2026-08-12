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
// publishToTopic wordt hier ook gemockt: startEdgeCut loopt via de ECHTE
// publishExtendedCommand (incl. de echte frame-guard) en die publiceert op
// het extended-topic via publishToTopic. Zo pint deze suite het kanaal én de
// guard op het pad dat de randmaai daadwerkelijk neemt, niet alleen het
// predicaat.
vi.mock('../../mqtt/mapSync.js', () => ({
  publishToDevice: vi.fn(),
  publishToTopic: vi.fn(),
}));

import { getMowerPhase, startEdgeCut } from '../../services/mowingService.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { publishToDevice, publishToTopic } from '../../mqtt/mapSync.js';
import { markFrameUnvalidated, clearFrameUnvalidated } from '../../services/frameValidation.js';

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
//        → dit is een AFGERONDE maaibeurt op het dock (LFIN1231000211). De tag
//        staat URENLANG stabiel (1729 samples over meerdere captures); hij rolt
//        binnen het capture-venster nooit door naar WAIT of CANCELLED.
//   "Mode:COVERAGE Work:WAIT Prev work:WAIT Recharge: FINISHED"
//        cov_ratio 0, finished_num 0, work_status 0  → idle op het dock.
//        LET OP: dit is een ANDERE maaier (LFIN2230700238) die naast de
//        afgeronde staat; eerdere rondes lazen die twee als één "alternerende"
//        maaier. De vorm is dus een echte idle-dock, geen afrond-rollover.
//   "Mode:MAPPING Work:FINISHED Prev work:REQUEST_START Recharge: FINISHED"
//        cov_ratio 0.099, work_status 9, task_mode 2  → een MAPPING-sessie
//        rapporteert óók een live "Work:FINISHED" met "Recharge: FINISHED";
//        daarom eist het vertrouwde afrond-signaal "Mode:COVERAGE" erbij.
//   "Mode:MAPPING Work:MANUAL_MAPPING_OBSTACLE Prev work:REQUEST_START Recharge: WAIT"
//        cov_ratio 0  → bewijst dat "Recharge: WAIT" geen afrondingssignaal is.
// NIET in de captures aanwezig (ronde 4 geverifieerd): geen enkele vorm met
// "Prev work:MOVING", "Prev work:RUNNING" of "Prev work:COVERING", geen
// go-home-rit na een afgeronde beurt, geen gebruikersstop. Uitspraken over die
// vormen zijn dus aannames, geen bewijs.
// GEDOCUMENTEERDE LIVE MELDING (geen capture met velden, wel twee losse
// gebruikersmeldingen in issue #17, vastgelegd in equipmentState.ts:243-264):
//   "Mode:COVERAGE Work:CANCELLED Prev work:USER_RECHARGE_STOP Recharge: FINISHED"
// PLAN-DOC FIXTURE (zwak bewijs, geen ruwe capture in de repo):
//   "Mode:COVERAGE Work:WAIT Prev work:FINISHED Recharge: FINISHED"
//        alleen in docs/superpowers/plans/2026-04-26-open-mqtt-node.md:3191.
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

  // Ronde 4, finding 1 tegenhanger: het dekkingsbewijs is NIET universeel
  // verplicht. De live tag "Mode:COVERAGE Work:FINISHED" verschijnt nooit
  // midden in een maaibeurt (capture: urenlang stabiel op het dock) en blijft
  // daarom vertrouwd, óók zonder cov_ratio. Zou dit 'other' opleveren, dan is
  // de feature dood op elke firmware die cov_ratio niet meestuurt.
  // GECONSTRUEERD: capture-msg, maar met cov_ratio/finished_num weggelaten.
  it('afgeronde beurt met Work:FINISHED maar ZONDER cov_ratio → toch charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'], ['work_status', '9'], ['task_mode', '1'],
      ['msg', 'Mode:COVERAGE Work:FINISHED Prev work:FINISHED_ONCE Recharge: FINISHED'],
    ]));
    expect(getMowerPhase('SN1')).toBe('charging');
  });

  // Ronde 4: een MAPPING-sessie rapporteert óók een live "Work:FINISHED" met
  // "Recharge: FINISHED" (ECHTE CAPTURE, cov_ratio 0.099, ws 9, task_mode 2).
  // Zonder de Mode:COVERAGE-eis zou het vertrouwde afrond-signaal hierop
  // aanslaan en een randmaai starten na een kaartsessie.
  it('ECHTE CAPTURE: mapping-sessie met live Work:FINISHED → NIET charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'], ['work_status', '9'], ['task_mode', '2'],
      ['cov_ratio', '0.099'], ['finished_num', '0'],
      ['msg', 'Mode:MAPPING Work:FINISHED Prev work:REQUEST_START Recharge: FINISHED'],
    ]));
    expect(getMowerPhase('SN1')).toBe('other');
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

  // Ronde 4, finding 1: de WAIT-spelling van dezelfde rollover. De oude gate
  // hing alleen aan Work:CANCELLED, dus "Work:WAIT Prev work:USER_RECHARGE_STOP"
  // met cov_ratio 0.4 glipte er als 'charging' doorheen en vuurde een randmaai
  // op een onafgemaakte beurt. Elke ambigue Work-tag moet het dekkingsbewijs
  // eisen, niet alleen CANCELLED.
  // GECONSTRUEERD: WAIT-variant van de issue #17-vorm; ws 0 omdat de ruwe code
  // dan ook al doorgerold is (anders vangt a3 hem al).
  it('Work:WAIT Prev work:USER_RECHARGE_STOP met cov_ratio 0.4 → NIET charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'], ['work_status', '0'],
      ['cov_ratio', '0.4'], ['finished_num', '0'],
      ['msg', 'Mode:COVERAGE Work:WAIT Prev work:USER_RECHARGE_STOP Recharge: FINISHED'],
    ]));
    expect(getMowerPhase('SN1')).toBe('other');
  });

  // Ronde 4, finding 2: finished_num telt afgeronde ZONES en zegt niets over
  // wat er nog openstaat. Meerzone-tuin: map0 klaar (finished_num 1), beurt
  // tijdens map1 afgebroken (cov_ratio ~0.4). Met finished_num als bewijs zou
  // dit als afgeronde beurt tellen en een randmaai starten.
  // GECONSTRUEERD: issue #17-vorm met de velden van dat meerzone-scenario.
  it('meerzone-afbreking: cov_ratio 0.4 met finished_num 1 → NIET charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'], ['work_status', '2'],
      ['cov_ratio', '0.4'], ['finished_num', '1'],
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

  // Ronde 4, finding 3: MOVING en RUNNING zijn UIT prevWorkAborted gehaald.
  // Een afgeronde beurt rijdt als laatste "werk" naar het dock, dus
  // "Prev work:MOVING" kan legitiem bij een afgeronde beurt horen; hard
  // afwijzen zou de randmaai dan stil en voorgoed overslaan. Geen enkele
  // capture toont MOVING/RUNNING als "Prev work" (de echte afrond-capture
  // toont FINISHED_ONCE), dus dit is een aanname in de VEILIG-BLIJVENDE
  // richting: deze vormen vallen nu onder de ambigue gate, waar cov_ratio
  // beslist. MET dekkingsbewijs vuren ze dus wel.
  // GECONSTRUEERD: dok-vorm met MOVING/RUNNING als vorige status.
  it('GECONSTRUEERD: Prev work:MOVING / RUNNING met dekkingsbewijs → WEL charging', () => {
    for (const prev of ['MOVING', 'RUNNING']) {
      deviceCache.set('SN1', new Map([
        ['battery_state', 'CHARGING'], ['work_status', '0'],
        ['cov_ratio', '1'], ['finished_num', '1'],
        ['msg', `Mode:COVERAGE Work:CANCELLED Prev work:${prev} Recharge: FINISHED`],
      ]));
      expect(getMowerPhase('SN1')).toBe('charging');
    }
  });

  it('GECONSTRUEERD: Prev work:MOVING / RUNNING zonder dekkingsbewijs → NIET charging', () => {
    for (const prev of ['MOVING', 'RUNNING']) {
      deviceCache.set('SN1', new Map([
        ['battery_state', 'CHARGING'], ['work_status', '0'],
        ['cov_ratio', '0.4'], ['finished_num', '0'],
        ['msg', `Mode:COVERAGE Work:CANCELLED Prev work:${prev} Recharge: FINISHED`],
      ]));
      expect(getMowerPhase('SN1')).toBe('other');
    }
  });

  // Ronde 4: msg-tokens zijn GEEN afrondingsbewijs meer, in geen enkele
  // richting. "Recharge: FINISHED" / "Recharge: WAIT" / "Prev work:..."
  // beschrijven allemaal de dok-cyclus; voor de ambigue vormen beslist alleen
  // cov_ratio. Deze twee kanten pinnen dat: dezelfde CANCELLED-vorm is
  // 'charging' met cov_ratio 1 en 'other' zonder cov_ratio, ongeacht welke
  // Recharge-tekst erachter staat.
  it("GECONSTRUEERD: 'Recharge: WAIT' verandert het oordeel niet, cov_ratio wel", () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'], ['work_status', '0'],
      ['cov_ratio', '1'], ['finished_num', '1'],
      ['msg', 'Mode:COVERAGE Work:CANCELLED Prev work:WAIT Recharge: WAIT'],
    ]));
    expect(getMowerPhase('SN1')).toBe('charging');
    deviceCache.set('SN2', new Map([
      ['battery_state', 'CHARGING'], ['work_status', '0'],
      ['msg', 'Mode:COVERAGE Work:CANCELLED Prev work:WAIT Recharge: WAIT'],
    ]));
    expect(getMowerPhase('SN2')).toBe('other');
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

  // Ronde 4, finding 1: dit stond eerder gemarkeerd als "letterlijke msg-vorm
  // uit de captures", maar de captures bevatten hem NIET; hij komt alleen als
  // PLAN-DOC FIXTURE voor (zie header). Work:WAIT is een ambigue dok-vorm
  // (de echte idle-dock capture heeft exact dezelfde WAIT-spelling met
  // cov_ratio 0), dus zonder dekkingsbewijs geldt de veilige kant: 'other'.
  // De feature gaat daar niet aan dood: de echte afrond-capture houdt de
  // vertrouwde tag "Work:FINISHED" urenlang vast, dus de watcher (tick per
  // 30 s) ziet die vorm ruimschoots.
  it('Work:WAIT + Prev work:FINISHED zonder cov_ratio → other (ambigu, geen bewijs)', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'],
      ['task_mode', '1'],
      ['msg', 'Mode:COVERAGE Work:WAIT Prev work:FINISHED Recharge: FINISHED'],
      ['work_status', '0'],
    ]));
    expect(getMowerPhase('SN1')).toBe('other');
  });

  it('Work:WAIT + Prev work:FINISHED MET cov_ratio 1 → WEL charging', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'],
      ['task_mode', '1'],
      ['cov_ratio', '1'],
      ['msg', 'Mode:COVERAGE Work:WAIT Prev work:FINISHED Recharge: FINISHED'],
      ['work_status', '0'],
    ]));
    expect(getMowerPhase('SN1')).toBe('charging');
  });

  // ECHTE CAPTURE: de idle-dock vorm (LFIN2230700238, nooit gemaaid, cov 0).
  // Byte-hetzelfde WAIT-patroon als een doorgerolde afronding; alleen
  // cov_ratio scheidt ze. Voor de watcher is 'other' hier ook praktisch
  // gelijk aan het oude gedrag: zonder sawMowing vuurde 'charging' toch niet.
  it('ECHTE CAPTURE: idle op het dock (Work:WAIT, cov_ratio 0) → other', () => {
    deviceCache.set('SN1', new Map([
      ['battery_state', 'CHARGING'], ['work_status', '0'], ['task_mode', '1'],
      ['cov_ratio', '0'], ['finished_num', '0'],
      ['msg', 'Mode:COVERAGE Work:WAIT Prev work:WAIT Recharge: FINISHED'],
    ]));
    expect(getMowerPhase('SN1')).toBe('other');
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
    expect(publishToTopic).not.toHaveBeenCalled();
  });

  it('lege sn → ok:false', () => {
    const r = startEdgeCut('', 'map0', 40);
    expect(r.ok).toBe(false);
    expect(publishToTopic).not.toHaveBeenCalled();
  });
});

describe('startEdgeCut succespad', () => {
  beforeEach(() => vi.clearAllMocks());

  // Pint KANAAL + payload. Kanaal: start_edge_cut wordt alleen door
  // extended_commands.py afgehandeld, dat uitsluitend op novabot/extended/<SN>
  // luistert; stock mqtt_node (Dart/Send_mqtt/<SN>) negeert het commando
  // volledig. Wie dit terugzet naar publishToDevice/sendCommand maakt de hele
  // rand-dag feature stil dood ("EDGE STARTED" in de log, niets op de maaier).
  // Payload: dezelfde vorm als de app stuurt — geen hernoemde velden,
  // bladeHeight blijft in mm.
  it('stuurt { start_edge_cut: { mapName, bladeHeight, departFromDock } } naar novabot/extended/<SN>', () => {
    const r = startEdgeCut('ONLINE_SN', 'map0', 40, true);
    expect(r.ok).toBe(true);
    expect(publishToTopic).toHaveBeenCalledOnce();
    expect(vi.mocked(publishToTopic).mock.calls[0][0]).toBe('novabot/extended/ONLINE_SN');
    expect(vi.mocked(publishToTopic).mock.calls[0][1]).toMatchObject({
      start_edge_cut: { mapName: 'map0', bladeHeight: 40, departFromDock: true },
    });
    // En expliciet NIET via het stock-kanaal (publishToDevice → Dart/Send_mqtt).
    expect(publishToDevice).not.toHaveBeenCalled();
  });

  it('geeft bladeHeightMm ongewijzigd door; departFromDock default false', () => {
    startEdgeCut('ONLINE_SN', 'map1', 65);
    expect(vi.mocked(publishToTopic).mock.calls[0][1]).toMatchObject({
      start_edge_cut: { mapName: 'map1', bladeHeight: 65, departFromDock: false },
    });
  });
});

describe('startEdgeCut frame-guard (post bundle-restore)', () => {
  const SN = 'ONLINE_SN';
  beforeEach(() => {
    vi.clearAllMocks();
    clearFrameUnvalidated(SN);
  });

  // Finding 3 (whole-branch review): de guard moet op het pad zitten dat de
  // randmaai daadwerkelijk neemt (publishExtendedCommand), niet alleen als los
  // predicaat. Deze test draait de ECHTE publishExtendedCommand + de echte
  // isFrameNavBlocked; alleen de MQTT-rand (publishToTopic) is gemockt. Haalt
  // iemand de guard uit publishExtendedCommand, dan faalt deze test — het
  // pure-predicaat-testbestand (publishToDeviceGuard.test.ts) blijft dan groen.
  it('blokkeert start_edge_cut zolang het frame niet gevalideerd is', () => {
    markFrameUnvalidated(SN);
    const r = startEdgeCut(SN, 'map0', 40, true);
    expect(r.ok).toBe(true); // zelfde semantiek als startMowing: de blokkade logt zelf
    expect(publishToTopic).not.toHaveBeenCalled();
  });

  it('laat start_edge_cut weer door zodra het frame gevalideerd is', () => {
    markFrameUnvalidated(SN);
    clearFrameUnvalidated(SN);
    startEdgeCut(SN, 'map0', 40, true);
    expect(publishToTopic).toHaveBeenCalledOnce();
  });
});
