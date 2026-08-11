import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Zelfde mock-conventie als edgeCutStart.test.ts / mowingService.test.ts: alleen
// de MQTT-randen en de socket-log worden vervangen, zodat de pre-existente
// TDZ-crash in de broker/socketHandler/demoSimulator-keten niet meespeelt.
// De rest draait ECHT: de scheduleRunner-lus, scheduleRepo/mapRepo op de
// in-memory DB, en de echte startMowing / getMowerPhase / startEdgeCut uit
// mowingService. Deze tests dekken de bekabeling, niet de pure state machine
// (die staat in edgeWatch.test.ts).
vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn(() => true),
}));
vi.mock('../../mqtt/mapSync.js', () => ({
  publishToDevice: vi.fn(),
}));
vi.mock('../../dashboard/socketHandler.js', () => ({
  emitScheduleEvent: vi.fn(),
  pushMqttLog: vi.fn(),
}));

import {
  startScheduleRunner, stopScheduleRunner, __getPendingEdgeForTest,
} from '../../services/scheduleRunner.js';
import { scheduleRepo } from '../../db/repositories/index.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { publishToDevice } from '../../mqtt/mapSync.js';

const TICK_MS = 30_000;             // CHECK_INTERVAL_MS in scheduleRunner
const TIMEOUT_MS = 12 * 60 * 60 * 1000; // EDGE_WATCH_TIMEOUT_MS

// Vaste klok in het VERLEDEN t.o.v. de echte systeemtijd. Dat is geen
// cosmetica: scheduleRepo.updateLastTriggered schrijft SQLite's datetime('now'),
// en dat is de ECHTE klok (native, niet door vi.useFakeTimers beïnvloed). Met
// een neptijd in het verleden ligt last_triggered_at dus altijd ná de geplande
// occurrence, waardoor de dubbel-trigger-guard van de runner op elke volgende
// tick netjes grijpt en alleen de watcher-lus nog werk doet.
const NOW = new Date('2026-08-05T10:00:30');

/** Maak een schema dat op de neptijd NU aan de beurt is. */
function createDueSchedule(sn: string, edgeDays: string | null, cuttingHeight = 50): void {
  scheduleRepo.create({
    schedule_id: `sched-${sn}`,
    mower_sn: sn,
    start_time: `${String(NOW.getHours()).padStart(2, '0')}:${String(NOW.getMinutes()).padStart(2, '0')}`,
    weekdays: JSON.stringify([NOW.getDay()]),
    enabled: 1,
    cutting_height: cuttingHeight,
    rain_pause: 0,
    edge_days: edgeDays,
  });
}

/** Sensor-momentopnames die getMowerPhase in de drie fases duwen. */
function setIdleOnDock(sn: string): void {
  deviceCache.set(sn, new Map([['battery_state', 'FINISHED'], ['work_status', '0'], ['msg', '']]));
}
function setMowing(sn: string): void {
  deviceCache.set(sn, new Map([
    ['battery_state', ''], ['work_status', '100'],
    ['msg', 'Mode:COVERAGE Work:COVERING Recharge: WAIT'],
  ]));
}
/** Afgeronde beurt op het dock. ECHTE CAPTURE, volledige payload uit
 *  research/documents/obstacle-capture-norelay-20260601-162451.jsonl:
 *  cov_ratio 1, finished_num 1, work_status 9, task_mode 1. */
function setDockedAfterFinishedMow(sn: string): void {
  deviceCache.set(sn, new Map([
    ['battery_state', 'CHARGING'], ['work_status', '9'], ['task_mode', '1'],
    ['cov_ratio', '1'], ['finished_num', '1'], ['error_status', '0'],
    ['msg', 'Mode:COVERAGE Work:FINISHED Prev work:FINISHED_ONCE Recharge: FINISHED'],
  ]));
}
/** De ANDERE vorm van een afgeronde beurt op het dock: met Work:CANCELLED als
 *  leidende tag. Twee keer los gemeld in issue #17 en vastgelegd in
 *  equipmentState.ts:243-264; het dekkingsbewijs komt uit de capture hierboven. */
function setDockedAfterFinishedMowIssue17(sn: string): void {
  deviceCache.set(sn, new Map([
    ['battery_state', 'CHARGING'], ['work_status', '2'],
    ['cov_ratio', '1'], ['finished_num', '1'],
    ['msg', 'Mode:COVERAGE Work:CANCELLED Prev work:USER_RECHARGE_STOP Recharge: FINISHED'],
  ]));
}
/** Halverwege afgebroken beurt die daarna dockt: BYTE-IDENTIEKE msg aan de
 *  afrondvorm hierboven, alleen het dekkingsbewijs verschilt (40% gemaaid). */
function setDockedAfterAbortedMow(sn: string): void {
  deviceCache.set(sn, new Map([
    ['battery_state', 'CHARGING'], ['work_status', '2'],
    ['cov_ratio', '0.4'], ['finished_num', '0'],
    ['msg', 'Mode:COVERAGE Work:CANCELLED Prev work:USER_RECHARGE_STOP Recharge: FINISHED'],
  ]));
}

/** Alle start_edge_cut-payloads die naar de maaier zijn gegaan. */
function edgeCutCalls(): Array<Record<string, unknown>> {
  return vi.mocked(publishToDevice).mock.calls
    .map(c => c[1] as Record<string, unknown>)
    .filter(cmd => 'start_edge_cut' in cmd);
}

describe('rand-dag watcher bekabeling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deviceCache.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    stopScheduleRunner();
    vi.useRealTimers();
  });

  it('rand-dag: armt bij de start en stuurt na maaien+dokken één randmaai', () => {
    const SN = 'WIRE_HAPPY';
    createDueSchedule(SN, JSON.stringify([NOW.getDay()]));
    setIdleOnDock(SN);

    startScheduleRunner();                       // tick 1: schema vuurt, watcher armt
    expect(__getPendingEdgeForTest().get(SN)).toMatchObject({ mapName: 'map0', sawMowing: false });
    expect(edgeCutCalls()).toHaveLength(0);      // nog niets bewogen

    setMowing(SN);
    vi.advanceTimersByTime(TICK_MS);             // tick 2: maaien gezien
    expect(__getPendingEdgeForTest().get(SN)?.sawMowing).toBe(true);
    expect(edgeCutCalls()).toHaveLength(0);

    setDockedAfterFinishedMow(SN);
    vi.advanceTimersByTime(TICK_MS);             // tick 3: beurt klaar → randmaai
    expect(edgeCutCalls()).toHaveLength(1);
    // cutting_height 50 (mm uit de dashboard-editor) → 50 mm bladehoogte.
    expect(edgeCutCalls()[0]).toMatchObject({ start_edge_cut: { mapName: 'map0', bladeHeight: 50 } });
    // Watcher is opgeruimd: geen tweede randmaai op de volgende ticks.
    expect(__getPendingEdgeForTest().has(SN)).toBe(false);
    vi.advanceTimersByTime(TICK_MS * 3);
    expect(edgeCutCalls()).toHaveLength(1);
  });

  // Dezelfde keten, maar met de andere live afrond-msg (issue #17). Dit is de
  // vorm waarop de feature in ronde 1 stil dood was: de suite bleef groen op
  // geïdealiseerde msg-vormen terwijl echte hardware nooit een randmaai kreeg.
  // Daarom staat hij hier end-to-end, niet alleen als unit-test op getMowerPhase.
  it('rand-dag: vuurt ook op de live afrond-msg met Work:CANCELLED (issue #17)', () => {
    const SN = 'WIRE_ISSUE17';
    createDueSchedule(SN, JSON.stringify([NOW.getDay()]));
    setIdleOnDock(SN);

    startScheduleRunner();
    setMowing(SN);
    vi.advanceTimersByTime(TICK_MS);
    setDockedAfterFinishedMowIssue17(SN);
    vi.advanceTimersByTime(TICK_MS);

    expect(edgeCutCalls()).toHaveLength(1);
    expect(edgeCutCalls()[0]).toMatchObject({ start_edge_cut: { mapName: 'map0', bladeHeight: 50 } });
  });

  // Finding NEW-3/NEW-2 end-to-end: de maaier maait, wordt halverwege gestopt
  // en dockt met een msg die niet te onderscheiden is van een afgeronde beurt.
  // Alleen het dekkingsbewijs (cov_ratio 0.4) scheidt de twee. Er mag dan geen
  // bewegingscommando uitgaan, ook niet op latere ticks.
  it('afgebroken beurt (cov_ratio 0.4) met afrond-vormige msg → GEEN randmaai', () => {
    const SN = 'WIRE_ABORTED';
    createDueSchedule(SN, JSON.stringify([NOW.getDay()]));
    setIdleOnDock(SN);

    startScheduleRunner();
    setMowing(SN);
    vi.advanceTimersByTime(TICK_MS);
    expect(__getPendingEdgeForTest().get(SN)?.sawMowing).toBe(true);

    setDockedAfterAbortedMow(SN);
    vi.advanceTimersByTime(TICK_MS * 4);
    expect(edgeCutCalls()).toHaveLength(0);
    // Watcher blijft netjes wachten (geen vuur, geen verlies) tot de timeout.
    expect(__getPendingEdgeForTest().has(SN)).toBe(true);
  });

  it('edge_days NULL armt niets en stuurt nooit een randmaai (huidig gedrag)', () => {
    const SN = 'WIRE_NULL';
    createDueSchedule(SN, null);
    setIdleOnDock(SN);

    startScheduleRunner();
    expect(__getPendingEdgeForTest().has(SN)).toBe(false);

    // Zelfde maai-en-dok-cyclus als het rand-dag schema: er mag niets gebeuren.
    setMowing(SN);
    vi.advanceTimersByTime(TICK_MS);
    setDockedAfterFinishedMow(SN);
    vi.advanceTimersByTime(TICK_MS);

    expect(__getPendingEdgeForTest().has(SN)).toBe(false);
    expect(edgeCutCalls()).toHaveLength(0);
  });

  it('armt niet als de maaibeurt niet is gestart (afgewezen start)', () => {
    const SN = 'WIRE_BUSY';
    createDueSchedule(SN, JSON.stringify([NOW.getDay()]));
    // Maaier zit al in een taak → startMowing's isMowerBusy-guard wijst af.
    deviceCache.set(SN, new Map([
      ['battery_state', ''], ['work_status', '100'],
      ['msg', 'Mode:COVERAGE Work:COVERING Recharge: WAIT'],
    ]));

    startScheduleRunner();
    // Geen start_navigation → geen watcher, ook al is het vandaag rand-dag.
    const startCalls = vi.mocked(publishToDevice).mock.calls
      .map(c => c[1] as Record<string, unknown>)
      .filter(cmd => 'start_navigation' in cmd);
    expect(startCalls).toHaveLength(0);
    expect(__getPendingEdgeForTest().has(SN)).toBe(false);

    // En ook daarna niet: dokken mag geen randmaai uitlokken.
    setDockedAfterFinishedMow(SN);
    vi.advanceTimersByTime(TICK_MS);
    expect(edgeCutCalls()).toHaveLength(0);
  });

  it('een verlopen watcher vuurt niet meer, ook niet als de maaier dan gaat laden', () => {
    const SN = 'WIRE_TIMEOUT';
    createDueSchedule(SN, JSON.stringify([NOW.getDay()]));
    setIdleOnDock(SN);

    startScheduleRunner();
    setMowing(SN);
    vi.advanceTimersByTime(TICK_MS);
    expect(__getPendingEdgeForTest().get(SN)?.sawMowing).toBe(true);

    // Klok voorbij de timeout zetten ZONDER ticks te draaien, zodat de eerst
    // volgende tick de entry tegenkomt die tegelijk verlopen is EN zou vuren
    // (sawMowing + laden). Dat is precies de tak die een spookstart uren later
    // voorkomt: de timeout gaat vóór het vuren.
    vi.setSystemTime(new Date(NOW.getTime() + TIMEOUT_MS + 60_000));
    setDockedAfterFinishedMow(SN);
    vi.advanceTimersByTime(TICK_MS);

    // De entry is opgeruimd (bewijst dat de tick echt gelopen heeft) en er is
    // geen bewegingscommando gestuurd.
    expect(__getPendingEdgeForTest().has(SN)).toBe(false);
    expect(edgeCutCalls()).toHaveLength(0);

    // Blijft weg op volgende ticks, terwijl de maaier nog steeds laadt.
    vi.advanceTimersByTime(TICK_MS * 3);
    expect(edgeCutCalls()).toHaveLength(0);
  });
});
