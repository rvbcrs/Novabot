// Zelfcheck voor de nachtpatrouille-plan helpers: nummering, toestanden, samenvatting.
// Draaien: node --experimental-strip-types dashboard/src/utils/patrolPlan.check.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOverlay, markStates, normalizePlan, pickOutRun, planPoints, runEnding, summarizeRun } from './patrolPlan.ts';

const plan = [
  { zone: 'map0', points: [[0, 0], [1, 0], [2, 0], [3, 0]] as Array<[number, number]> },
  { zone: 'map1', points: [[10, 0], [11, 0]] as Array<[number, number]> },
];
const states = (m: Map<number, string>) => [...m.entries()].map(([, s]) => s).join(' ');

test('de nummering loopt over alle zones door, vanaf 1', () => {
  const pts = planPoints(plan);
  assert.deepEqual(pts.map(p => p.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(pts.map(p => p.zone), ['map0', 'map0', 'map0', 'map0', 'map1', 'map1']);
});

test('een kapot punt telt mee in de nummering maar wordt niet getekend', () => {
  const broken = [{ zone: 'map0', points: [[0, 0], [NaN, 1], [2, 0]] as Array<[number, number]> }];
  assert.deepEqual(planPoints(broken).map(p => p.valid), [true, false, true]);
  const overlay = buildOverlay(broken, { mode: 'plan' });
  assert.deepEqual(overlay?.zones[0].points.map(p => p.seq), [1, 3]);
});

test('plan: alles wacht, niets is huidig', () => {
  assert.equal(states(markStates(planPoints(plan), { mode: 'plan' })), 'pending pending pending pending pending pending');
});

test('live: bereikt = groen, het eerste dat nog niet is geweest = huidig', () => {
  const m = markStates(planPoints(plan), { mode: 'live', reached: [1, 2] });
  assert.equal(states(m), 'done done current pending pending pending');
});

test('live: een overgeslagen punt wordt niet huidig, en onder een bereikt punt is overgeslagen', () => {
  const reported = markStates(planPoints(plan), { mode: 'live', reached: [1], skippedSeqs: [2] });
  assert.equal(states(reported), 'done skipped current pending pending pending');
  const inferred = markStates(planPoints(plan), { mode: 'live', reached: [1, 5] });
  assert.equal(states(inferred), 'done skipped skipped skipped done current');
});

test('live: een hele overgeslagen zone slaat al haar punten over', () => {
  const m = markStates(planPoints(plan), { mode: 'live', reached: [1, 2, 3, 4], skippedZones: ['map1'] });
  assert.equal(states(m), 'done done done done skipped skipped');
});

test('gemeld bereikt wint van gemeld overgeslagen', () => {
  const m = markStates(planPoints(plan), { mode: 'live', reached: [2], skippedSeqs: [2] });
  assert.equal(m.get(2), 'done');
});

test('afgerond met done: wat niet bereikt is, is overgeslagen', () => {
  const m = markStates(planPoints(plan), { mode: 'finished', reached: [1, 2, 3], endedPhase: 'done' });
  assert.equal(states(m), 'done done done skipped skipped skipped');
});

test('gestopt of mislukt: daarna blijft het wachten, daarvoor is overgeslagen', () => {
  for (const endedPhase of ['stopped', 'error', null, undefined]) {
    const m = markStates(planPoints(plan), { mode: 'finished', reached: [1, 3], endedPhase });
    assert.equal(states(m), 'done skipped done pending pending pending', String(endedPhase));
  }
});

test('afgerond: nooit een huidig punt', () => {
  const m = markStates(planPoints(plan), { mode: 'finished', reached: [], endedPhase: 'stopped' });
  assert.ok(![...m.values()].includes('current'));
});

test('overlay: per zone gegroepeerd, met de toestand erbij; zonder plan geen overlay', () => {
  const o = buildOverlay(plan, { mode: 'live', reached: [1] });
  assert.deepEqual(o?.zones.map(z => [z.zone, z.points.length]), [['map0', 4], ['map1', 2]]);
  assert.equal(o?.zones[0].points[0].state, 'done');
  assert.equal(o?.zones[0].points[1].state, 'current');
  assert.equal(buildOverlay(null, { mode: 'plan' }), null);
  assert.equal(buildOverlay([], { mode: 'plan' }), null);
});

test('normalizePlan: rommel is geen plan, getallen als tekst worden getallen', () => {
  assert.equal(normalizePlan(undefined), null);
  assert.equal(normalizePlan('x'), null);
  assert.equal(normalizePlan([{ zone: 5, points: [[0, 0]] }]), null);
  assert.equal(normalizePlan([{ zone: 'map0', points: [] }]), null);
  assert.deepEqual(normalizePlan([{ zone: 'map0', points: [['1', '2'], 'kapot'] }]), [{ zone: 'map0', points: [[1, 2], [NaN, NaN]] }]);
});

const frame = (seq: number, seen: Array<'person' | 'animal'> | null) =>
  ({ seq, x: 0, y: 0, person: 0, animal: 0, frames: 10, image: true, ts: 1, seen });

test('samenvatting van een run met plan', () => {
  const s = summarizeRun({
    frames: [frame(1, []), frame(2, ['person']), frame(4, ['person', 'animal']), frame(5, null)],
    plan, endedPhase: 'done',
  });
  assert.deepEqual(s, { reached: 4, total: 6, skipped: 2, persons: 2, animals: 1 });
});

test('samenvatting zonder plan: totaal en overgeslagen onbekend, de rest telt gewoon', () => {
  const s = summarizeRun({ frames: [frame(1, ['animal']), frame(2, [])] });
  assert.deepEqual(s, { reached: 2, total: null, skipped: null, persons: 0, animals: 1 });
});

test('hoe een run eindigde: wat de server zegt, en een lopende run alleen als er een patrouille uit is', () => {
  assert.equal(runEnding({ endedPhase: 'done' }, false), 'done');
  assert.equal(runEnding({ endedPhase: 'stopped' }, true), 'stopped');
  assert.equal(runEnding({ endedPhase: 'error' }, false), 'error');
  assert.equal(runEnding({ endedPhase: null }, true), 'running');
  assert.equal(runEnding({ endedPhase: null }, false), 'unknown');
  assert.equal(runEnding({}, false), null);          // een oudere server zegt niets
  assert.equal(runEnding({}, true), 'running');
});

test('live: terug naar huis is de ronde voorbij, dus geen huidig punt meer', () => {
  const base = { mode: 'live' as const, reached: [1, 2] };
  assert.equal(states(markStates(planPoints(plan), { ...base, phase: 'patrolling' })), 'done done current pending pending pending');
  assert.equal(states(markStates(planPoints(plan), { ...base, phase: 'returning' })), 'done done pending pending pending pending');
  // voor de ronde (starting, localizing) en zonder fase geldt het eerste punt als huidig
  for (const phase of ['starting', 'localizing', undefined, null]) {
    assert.equal(states(markStates(planPoints(plan), { ...base, phase })), 'done done current pending pending pending', String(phase));
  }
  // de overlay geeft de fase door
  const o = buildOverlay(plan, { ...base, phase: 'returning' });
  assert.ok(!o?.zones.some(z => z.points.some(p => p.state === 'current')));
});

test('welke run is uit: de server zegt het, en alleen live meldingen van die run tellen', () => {
  const old = { run: 'r1', endedPhase: 'done' as const };
  const out = { run: 'r2', endedPhase: null };
  // de nieuwste is niet afgelopen: dat is de run die uit is, en meldingen van r1 (een reconnect) tellen niet mee
  assert.deepEqual(pickOutRun([out, old], 'r1'), { run: out, reportsApply: false });
  assert.deepEqual(pickOutRun([out, old], 'r2'), { run: out, reportsApply: true });
  assert.deepEqual(pickOutRun([out, old], null), { run: out, reportsApply: true });
  // de server zegt dat de nieuwste klaar is: geen run uit (de lijst loopt achter op een start),
  // en meldingen van die afgelopen run (of van een run die nog niet in de lijst staat) tellen niet
  assert.deepEqual(pickOutRun([old], 'r1'), { run: undefined, reportsApply: false });
  assert.deepEqual(pickOutRun([old], 'r2'), { run: undefined, reportsApply: false });
  assert.deepEqual(pickOutRun([old], null), { run: undefined, reportsApply: true });
  assert.deepEqual(pickOutRun([], null), { run: undefined, reportsApply: true });
  assert.deepEqual(pickOutRun([], 'r1'), { run: undefined, reportsApply: false });
});

test('welke run is uit: een oudere server zegt niet hoe runs eindigden, dan geldt de run van de meldingen', () => {
  const legacy = [{ run: 'r2' }, { run: 'r1' }];
  assert.deepEqual(pickOutRun(legacy, 'r1'), { run: legacy[1], reportsApply: true });
  assert.deepEqual(pickOutRun(legacy, 'r2'), { run: legacy[0], reportsApply: true });
  assert.deepEqual(pickOutRun(legacy, 'zzz'), { run: undefined, reportsApply: false });
  assert.deepEqual(pickOutRun(legacy, null), { run: undefined, reportsApply: true });
});
