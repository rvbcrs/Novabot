// Zelfcheck voor de nachtpatrouille-plan helpers: nummering, toestanden, samenvatting.
// Draaien: npx tsx dashboard/src/utils/patrolPlan.check.ts  (patrolPlan.ts importeert editGeometry zonder extensie)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOverlay, markStates, normalizePlan, pickOutRun, planPoints, planRoutes, prepareObstacles, prepareRail, prepareZone, routeAround, routeWithin, runEnding, summarizeRun } from './patrolPlan.ts';

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

// ---- de gestippelde lijn: een route om de vastgelegde obstakels heen ----

const sq = (cx: number, cy: number, half: number) =>
  [{ x: cx - half, y: cy - half }, { x: cx + half, y: cy - half }, { x: cx + half, y: cy + half }, { x: cx - half, y: cy + half }];
const O = (x: number, y: number) => ({ x, y });
const pathLen = (path: Array<{ x: number; y: number }>) => path.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0);
// onafhankelijk van routeAround: bemonster de lijn en kijk of een punt strikt in de rechthoek valt
const through = (path: Array<{ x: number; y: number }>, inside: (p: { x: number; y: number }) => boolean) =>
  path.slice(1).some((q, i) => {
    const p = path[i];
    for (let t = 0; t <= 1; t += 0.004) if (inside({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })) return true;
    return false;
  });
const inBox = (cx: number, cy: number, half: number) => (p: { x: number; y: number }) => Math.abs(p.x - cx) < half - 1e-6 && Math.abs(p.y - cy) < half - 1e-6;

test('route: recht als de lijn vrij is, ook met obstakels ver weg of op ruime afstand', () => {
  const a = O(0, 0), b = O(10, 0);
  assert.deepEqual(routeAround(a, b, [], 0.6), [a, b]);
  const far = routeAround(a, b, [sq(5, 20, 1.5), sq(-30, 0, 1.5), sq(50, 0, 1.5)], 0.6);
  assert.equal(far.length, 2);
  assert.equal(far[0], a);
  assert.equal(far[1], b);
  // 3 m erboven: de rand van de marge (y = 0.9) ligt nog 0,9 m van de lijn
  assert.equal(routeAround(a, b, [sq(5, 3, 1.5)], 0.6).length, 2);
  // een lijn langs de rand van de marge raakt alleen: vrij
  assert.equal(routeAround(O(0, 2.1), O(10, 2.1), [sq(5, 0, 1.5)], 0.6).length, 2);
});

test('route: om een vierkant van 3 x 3 m heen, met 0,6 m ruimte, over de kortste kant', () => {
  const a = O(0, 0), b = O(10, 0);
  const path = routeAround(a, b, [sq(5, 0, 1.5)], 0.6);
  assert.equal(path.length, 4);
  assert.equal(path[0], a);
  assert.equal(path[3], b);
  assert.ok(Math.abs(path[1].x - 2.9) < 1e-9 && Math.abs(Math.abs(path[1].y) - 2.1) < 1e-9, JSON.stringify(path[1]));
  assert.ok(Math.abs(path[2].x - 7.1) < 1e-9 && Math.abs(path[2].y - path[1].y) < 1e-9, JSON.stringify(path[2]));
  assert.ok(Math.abs(pathLen(path) - (2 * Math.hypot(2.9, 2.1) + 4.2)) < 1e-9);
  assert.ok(!through(path, inBox(5, 0, 2.1)), 'de lijn loopt door de marge');
  // zonder ruimte houdt de lijn de hoeken van het obstakel zelf aan
  const tight = routeAround(a, b, [sq(5, 0, 1.5)], 0);
  assert.ok(Math.abs(Math.abs(tight[1].y) - 1.5) < 1e-9 && !through(tight, inBox(5, 0, 1.5)));
});

test('route: de kortste kant wint, ook als die niet symmetrisch is', () => {
  // het obstakel zit ruimer onder de lijn dan erboven: erboven om is korter
  const path = routeAround(O(0, 0), O(10, 0), [sq(5, -0.5, 1.5)], 0.6);
  assert.ok(path.every(p => p.y > -0.5), 'liep om de lange kant');
  assert.ok(!through(path, inBox(5, -0.5, 2.1)));
});

test('route: een eindpunt in de marge van een obstakel krijgt toch een pad', () => {
  const ob = [sq(5, 0, 1.5)];
  // begin 0,3 m van de rand (binnen de marge van 0,6 m), einde ver weg
  const fromMargin = routeAround(O(3.2, 0), O(10, 0), ob, 0.6);
  assert.deepEqual([fromMargin[0], fromMargin[fromMargin.length - 1]], [O(3.2, 0), O(10, 0)]);
  assert.ok(fromMargin.length >= 3 && !through(fromMargin, inBox(5, 0, 1.5)), 'door het obstakel zelf');
  // einde in de marge aan de andere kant
  const toMargin = routeAround(O(0, 0), O(6.8, 0.2), ob, 0.6);
  assert.deepEqual(toMargin[toMargin.length - 1], O(6.8, 0.2));
  assert.ok(toMargin.length >= 3 && !through(toMargin, inBox(5, 0, 1.5)));
  // een eindpunt in het obstakel zelf: een pad zonder fouten, het eindpunt blijft
  const inside = routeAround(O(5, 0), O(10, 0), ob, 0.6);
  assert.deepEqual([inside[0], inside[inside.length - 1]], [O(5, 0), O(10, 0)]);
  assert.ok(inside.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
});

test('route: een tweede obstakel buiten het vak van de lijn telt mee zodra de omweg er tegenaan loopt', () => {
  // omweg boven langs (korter) loopt in het tweede obstakel: dan moet het onderlangs
  const ob = [sq(5, -0.5, 1.5), sq(5, 3.1, 1.5)];
  const path = routeAround(O(0, 0), O(10, 0), ob, 0.6);
  assert.ok(!through(path, inBox(5, -0.5, 2.1)) && !through(path, inBox(5, 3.1, 2.1)), JSON.stringify(path));
  assert.ok(path.some(p => p.y < -2));
});

test('route: een hoekig obstakel (L) wordt gemeden, en rommel in de invoer geeft de rechte lijn', () => {
  const L = [O(3, -1), O(7, -1), O(7, 1), O(5, 1), O(5, 4), O(3, 4)];
  const inL = (p: { x: number; y: number }) => (p.x > 3 + 1e-6 && p.x < 7 - 1e-6 && p.y > -1 + 1e-6 && p.y < 1 - 1e-6) || (p.x > 3 + 1e-6 && p.x < 5 - 1e-6 && p.y > -1 + 1e-6 && p.y < 4 - 1e-6);
  const path = routeAround(O(0, 0), O(10, 0), [L], 0.6);
  assert.ok(path.length > 2 && !through(path, inL));
  const a = O(0, 0), b = O(10, 0);
  assert.deepEqual(routeAround(a, b, [[O(NaN, 1), O(2, 2)], []], 0.6), [a, b]);
  assert.deepEqual(routeAround(O(NaN, 0), b, [sq(5, 0, 1.5)], 0.6).length, 2);
});

// ---- echte obstakels zijn dichte ringen van tientallen tot honderden punten: de route gaat om hun convexe omhulsel ----

const ring = (cx: number, cy: number, r: number, n: number, wobble = 0) =>
  Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n, rr = r * (1 + wobble * Math.sin(i * 7.3));
    return { x: cx + rr * Math.cos(t), y: cy + rr * Math.sin(t) };
  });
const rect = (x0: number, y0: number, x1: number, y1: number) => (p: { x: number; y: number }) =>
  p.x > x0 + 1e-6 && p.x < x1 - 1e-6 && p.y > y0 + 1e-6 && p.y < y1 - 1e-6;
const A = O(0, 0), B = O(10, 0);

test('route: een obstakel van 200 punten (een cirkel) op de lijn wordt omlopen, niet doorkruist', () => {
  const path = routeAround(A, B, [ring(5, 0, 1.5, 200)], 0.6);
  assert.ok(path.length >= 4, String(path.length));
  assert.ok(!through(path, p => Math.hypot(p.x - 5, p.y) < 2.09), 'door de marge van de cirkel');
  const len = pathLen(path);
  assert.ok(len > 10.6 && len < 11.2, `om de omtrek heen, geen ommetje: ${len}`);
  // dezelfde ring met 220 punten en een rafelige rand: ook nu geen doorsteek
  const rough = routeAround(A, B, [ring(5, 0, 1.5, 220, 0.04)], 0.6);
  assert.ok(rough.length >= 4 && !through(rough, p => Math.hypot(p.x - 5, p.y) < 1.5 * 0.96 + 0.55));
});

test('route: een gesloten ring (eerste punt aan het eind herhaald) en een vierkant met de klok mee geven dezelfde route', () => {
  const plain = routeAround(A, B, [sq(5, 0, 1.5)], 0.6);
  const closed = [...sq(5, 0, 1.5), sq(5, 0, 1.5)[0]];
  const clockwise = [...sq(5, 0, 1.5)].reverse();
  for (const poly of [closed, clockwise]) {
    const path = routeAround(A, B, [poly], 0.6);
    assert.equal(path.length, 4);
    assert.ok(Math.abs(pathLen(path) - pathLen(plain)) < 1e-9);
    assert.ok(!through(path, inBox(5, 0, 2.1)));
  }
});

test('route: vierkanten die elkaar raken of overlappen zijn een muur', () => {
  for (const obstacles of [[sq(3.5, 0, 1.5), sq(6.5, 0, 1.5)], [sq(3.5, 0, 1.5), sq(5.5, 0.5, 1.5)]]) {
    const path = routeAround(A, B, obstacles, 0.6);
    assert.ok(path.length > 2);
    for (const [cx, cy] of obstacles.map(o => [(o[0].x + o[2].x) / 2, (o[0].y + o[2].y) / 2])) {
      assert.ok(!through(path, inBox(cx, cy, 2.1)), JSON.stringify(path));
    }
  }
});

test('route: een opening van 2 m laat de lijn door (0,8 m tussen de marges), een van 0,8 m niet', () => {
  const pair = (g: number) => [sq(5.5, g / 2 + 1.5, 1.5), sq(5.5, -(g / 2 + 1.5), 1.5)];
  assert.equal(routeAround(A, B, pair(2), 0.6).length, 2);
  assert.equal(routeAround(A, B, pair(1.3), 0.6).length, 2);   // 0,1 m over: nog vrij
  const shut = routeAround(A, B, pair(0.8), 0.6);
  assert.ok(shut.length > 2);
  const top = rect(3.4, 0.4 - 0.6, 7.6, 0.4 + 3 + 0.6), bottom = rect(3.4, -(0.4 + 3 + 0.6), 7.6, -(0.4 - 0.6));
  assert.ok(!through(shut, top) && !through(shut, bottom), JSON.stringify(shut));
});

test('route: een haag van 6 obstakels in een rij wordt aan het eind omlopen', () => {
  const hedge = (n: number) => Array.from({ length: n }, (_, i) => sq(5, (i - (n - 1) / 2) * 2.4, 1));   // 0,4 m ertussen: een muur
  const six = hedge(6);
  const path = routeAround(A, B, six, 0.6);
  six.forEach((_, i) => assert.ok(!through(path, inBox(5, (i - 2.5) * 2.4, 1.6)), `door obstakel ${i}`));
  assert.ok(path.some(p => Math.abs(p.y) > 7.5), 'niet om het eind heen');
  // een lange haag: de omweg loopt steeds in het volgende obstakel, ver voorbij vier rondes
  const long = hedge(24);
  const around = routeAround(A, B, long, 0.6);
  long.forEach((_, i) => assert.ok(!through(around, inBox(5, (i - 11.5) * 2.4, 1.6)), `door obstakel ${i}`));
  assert.ok(around.some(p => Math.abs(p.y) > 28), 'niet om het eind heen');
});

test('route: een obstakel één keer klaarmaken geeft dezelfde routes als elke keer opnieuw', () => {
  const obstacles = [sq(5, 0, 1.5), ring(12, 3, 1, 50), ring(20, -2, 2, 120, 0.05)];
  const prepared = prepareObstacles(obstacles, 0.6);
  for (const [from, to] of [[A, B], [O(0, 3), O(24, 3)], [O(12, -5), O(12, 9)], [O(18, -2), O(25, -2)]]) {
    assert.deepEqual(routeAround(from, to, prepared), routeAround(from, to, obstacles, 0.6));
  }
  // een vlak zonder oppervlak (drie punten op een lijn) is geen obstakel
  assert.deepEqual(prepareObstacles([[O(0, 0), O(1, 1), O(2, 2)], [O(1, 1)]], 0.6).hulls, []);
});

// ---- binnen de zone: de lijn blijft in het werkgebied, en steekt naar een andere zone alleen over via het kanaal ----

const none = prepareObstacles([], 0.6);
const U = [O(0, 0), O(20, 0), O(20, 10), O(12, 10), O(12, 4), O(8, 4), O(8, 10), O(0, 10)];   // een U: inham van boven tussen x = 8..12
const insideU = (p: { x: number; y: number }) =>
  p.x > -1e-6 && p.x < 20 + 1e-6 && p.y > -1e-6 && p.y < 10 + 1e-6 && !(p.x > 8 + 1e-6 && p.x < 12 - 1e-6 && p.y > 4 + 1e-6);
const near = (p: { x: number; y: number }, x: number, y: number) => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9;

test('zone: een lijn over de inham blijft in de zone en gaat er 0,3 m binnen de hoeken omheen', () => {
  const zone = prepareZone(U);
  assert.ok(zone && zone.corners.length === 2, JSON.stringify(zone?.corners));
  const path = routeWithin(O(4, 8), O(16, 8), [zone!], none);
  assert.ok(path && path.length === 4, JSON.stringify(path));
  assert.ok(!through(path!, p => !insideU(p)), 'buiten de zone');
  assert.ok(near(path![1], 7.7, 3.7) && near(path![2], 12.3, 3.7), JSON.stringify(path));
  // met de klok mee: dezelfde route
  const cw = routeWithin(O(4, 8), O(16, 8), [prepareZone([...U].reverse())!], none);
  assert.ok(cw && cw.length === 4 && Math.abs(pathLen(cw) - pathLen(path!)) < 1e-9, JSON.stringify(cw));
  // een vrije lijn blijft recht
  assert.deepEqual(routeWithin(O(2, 2), O(18, 2), [zone!], none), [O(2, 2), O(18, 2)]);
});

test('zone: een obstakel in de zone wordt binnen de zone omlopen', () => {
  const strip = prepareZone([O(0, 0), O(20, 0), O(20, 6), O(0, 6)])!;
  const ob = prepareObstacles([sq(10, 3, 1.5)], 0.6);   // marge tot y = 0,9 en 5,1: aan beide kanten 0,9 m over
  const path = routeWithin(O(2, 3), O(18, 3), [strip], ob);
  assert.ok(path && path.length === 4 && !through(path, inBox(10, 3, 2.1)), JSON.stringify(path));
  assert.ok(path!.every(p => p.y > -1e-9 && p.y < 6 + 1e-9), 'buiten de strook');
  // het obstakel tegen de rand (marge tot y = -1,1 en 3,1): de omweg kan maar één kant op, en die blijft in de strook
  const low = prepareObstacles([sq(10, 1, 1.5)], 0.6);
  const over = routeWithin(O(2, 3), O(18, 3), [strip], low);
  assert.ok(over && over.length === 4 && !through(over, inBox(10, 1, 2.1)), JSON.stringify(over));
  assert.ok(over!.every(p => p.y > -1e-9 && p.y < 6 + 1e-9), JSON.stringify(over));
});

test('zone: een eindpunt buiten de zone, of geen zone, geeft niets (de kaart tekent die leg dan niet)', () => {
  const strip = prepareZone([O(0, 0), O(20, 0), O(20, 6), O(0, 6)])!;
  assert.equal(routeWithin(O(-5, 3), O(18, 3), [strip], none), null);
  assert.equal(routeWithin(O(2, 3), O(18, 9), [strip], none), null);
  assert.equal(routeWithin(O(NaN, 3), O(18, 3), [strip], none), null);
  assert.equal(routeWithin(O(2, 3), O(18, 3), [], none), null);
  assert.equal(prepareZone([O(0, 0), O(1, 1)]), null);
  assert.equal(prepareZone([O(0, 0), O(1, 1), O(2, 2)]), null);
  assert.equal(prepareZone([O(0, 0), O(NaN, 1), O(2, 2), O(0, 2)])?.ring.length, 3);
});

test('zone: tussen twee zones alleen via het kanaal, met speling voor een kanaal dat net buiten de rand begint', () => {
  const Z1 = prepareZone([O(0, 0), O(10, 0), O(10, 10), O(0, 10)])!, Z2 = prepareZone([O(20, 0), O(30, 0), O(30, 10), O(20, 10)])!;
  assert.equal(routeWithin(O(8, 5), O(22, 5), [Z1, Z2], none), null);
  const rail = prepareRail([O(9.5, 5), O(12, 7), O(15, 8), O(18, 7), O(20.5, 5)]);
  assert.deepEqual(routeWithin(O(8, 5), O(22, 5), [Z1, Z2], none, [rail]), [O(8, 5), ...rail, O(22, 5)]);
  // de uiteinden 0,5 m buiten de zones: toch gekoppeld
  const past = prepareRail([O(10.5, 5), O(15, 8), O(19.5, 5)]);
  assert.deepEqual(routeWithin(O(8, 5), O(22, 5), [Z1, Z2], none, [past]), [O(8, 5), ...past, O(22, 5)]);
  // het kanaal begint 2,2 m buiten de zone (zo staat een opgenomen kanaal er echt): toch gekoppeld
  const off = prepareRail([O(12.2, 5), O(15, 8), O(20.5, 5)]);
  assert.deepEqual(routeWithin(O(8, 5), O(22, 5), [Z1, Z2], none, [off]), [O(8, 5), ...off, O(22, 5)]);
  // een kanaal 10 m van beide zones hoort hier niet: geen lijn
  const far = prepareRail([O(5, 20), O(15, 22), O(25, 20)]);
  assert.equal(routeWithin(O(8, 5), O(22, 5), [Z1, Z2], none, [far]), null);
  // andersom opgenomen: hetzelfde pad, andersom gevolgd
  const back = routeWithin(O(22, 5), O(8, 5), [Z1, Z2], none, [rail]);
  assert.deepEqual(back, [O(22, 5), ...[...rail].reverse(), O(8, 5)]);
  // een kanaal wordt uitgedund tot een punt per meter, de uiteinden blijven
  const dense = Array.from({ length: 101 }, (_, i) => O(9.5 + i * 0.11, 5 + Math.sin(i / 10)));
  const thin = prepareRail(dense);
  assert.ok(thin.length > 8 && thin.length < 20 && thin[0] === dense[0] && thin[thin.length - 1] === dense[100], String(thin.length));
  // zones die overlappen hebben geen kanaal nodig
  const Z3 = prepareZone([O(8, 0), O(30, 0), O(30, 10), O(8, 10)])!;
  assert.deepEqual(routeWithin(O(5, 5), O(25, 5), [Z1, Z3], none), [O(5, 5), O(25, 5)]);
});

test('zone: een opgenomen rand van duizenden punten is snel klaar en de lijn blijft erbinnen', () => {
  // de U met een punt om de centimeter en 5 cm ruis, zoals een opgenomen rand
  const dense: Array<{ x: number; y: number }> = [];
  U.forEach((p, i) => {
    const q = U[(i + 1) % U.length], n = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 0.01);
    for (let k = 0; k < n; k++) {
      const t = k / n;
      dense.push({ x: p.x + (q.x - p.x) * t + 0.05 * Math.sin(k * 3.1), y: p.y + (q.y - p.y) * t + 0.05 * Math.cos(k * 2.7) });
    }
  });
  const t0 = performance.now();
  const zone = prepareZone(dense)!;
  const legs = Array.from({ length: 20 }, (_, i) => routeWithin(O(2 + (i % 5), 8), O(16 + (i % 3), 9 - (i % 4)), [zone], none));
  const ms = performance.now() - t0;
  assert.ok(dense.length > 7000 && zone.ring.length < 60, `${dense.length} punten → ring van ${zone.ring.length}`);
  assert.ok(ms < 1500, `${ms} ms`);
  for (const path of legs) {
    assert.ok(path && path.length >= 4, JSON.stringify(path));
    assert.ok(!through(path!, p => p.x > 8.2 && p.x < 11.8 && p.y > 4.2), 'door de inham');
  }
});

// ---- een eindpunt in de holte van een obstakel (een L, een U): de lijn gaat de holte uit, niet dwars door het obstakel ----

test('holte: een checkpoint in de holte van een L krijgt een lijn de holte uit', () => {
  const L = [O(3, -1), O(7, -1), O(7, 1), O(5, 1), O(5, 4), O(3, 4)];
  const inL = (p: { x: number; y: number }) => (p.x > 3 + 1e-6 && p.x < 7 - 1e-6 && p.y > -1 + 1e-6 && p.y < 1 - 1e-6) || (p.x > 3 + 1e-6 && p.x < 5 - 1e-6 && p.y > -1 + 1e-6 && p.y < 4 - 1e-6);
  const inHollow = O(6.2, 3);   // in het omhulsel van de L, buiten de L zelf, 1,2 m van de rand
  for (const [from, to] of [[inHollow, O(0, 0)], [O(0, 0), inHollow], [inHollow, O(1, 4)]]) {
    const path = routeAround(from, to, [L], 0.6);
    assert.ok(path.length >= 3 && !through(path, inL), `${JSON.stringify([from, to])} → ${JSON.stringify(path)}`);
    assert.deepEqual([path[0], path[path.length - 1]], [from, to]);
  }
  // hetzelfde binnen een zone
  const zone = prepareZone([O(-2, -6), O(12, -6), O(12, 8), O(-2, 8)])!;
  const within = routeWithin(inHollow, O(0, 0), [zone], prepareObstacles([L], 0.6));
  assert.ok(within && within.length >= 3 && !through(within, inL), JSON.stringify(within));
});

test('holte: een checkpoint onder in een U gaat er bovenlangs uit', () => {
  const U2 = [O(3, -1), O(9, -1), O(9, 4), O(7, 4), O(7, 1), O(5, 1), O(5, 4), O(3, 4)];
  const inU = (p: { x: number; y: number }) =>
    (p.x > 3 + 1e-6 && p.x < 9 - 1e-6 && p.y > -1 + 1e-6 && p.y < 1 - 1e-6)
    || (p.x > 3 + 1e-6 && p.x < 5 - 1e-6 && p.y > -1 + 1e-6 && p.y < 4 - 1e-6)
    || (p.x > 7 + 1e-6 && p.x < 9 - 1e-6 && p.y > -1 + 1e-6 && p.y < 4 - 1e-6);
  const path = routeAround(O(6, 2.5), O(6, -4), [U2], 0.6);
  assert.ok(path.length >= 4 && !through(path, inU), JSON.stringify(path));
  assert.ok(path.some(p => p.y > 4), 'niet bovenlangs');
  // een dichte, rafelige U van 300 punten: ook dan de holte uit
  const dense: Array<{ x: number; y: number }> = [];
  U2.forEach((p, i) => { const q = U2[(i + 1) % U2.length], n = 40; for (let k = 0; k < n; k++) { const t = k / n; dense.push({ x: p.x + (q.x - p.x) * t + 0.03 * Math.sin(k * 2.9 + i), y: p.y + (q.y - p.y) * t + 0.03 * Math.cos(k * 1.7 + i) }); } });
  const rough = routeAround(O(6, 2.5), O(6, -4), [dense], 0.6);
  assert.ok(rough.length >= 4 && !through(rough, p => inU({ x: p.x, y: p.y }) && Math.abs(p.x - 6) > 1.1), JSON.stringify(rough));
  assert.ok(rough.some(p => p.y > 4), 'niet bovenlangs');
});

test('holte: een checkpoint in de binnenbocht van een halve maan gaat er aan de open kant uit', () => {
  // een halve maan (C) met de opening naar rechts: buitenstraal 4, binnenstraal 2.5, middelpunt (5, 0)
  const outer = Array.from({ length: 60 }, (_, i) => { const t = Math.PI / 2 + (Math.PI * i) / 59; return O(5 + 4 * Math.cos(t), 4 * Math.sin(t)); });
  const inner = Array.from({ length: 40 }, (_, i) => { const t = (3 * Math.PI) / 2 - (Math.PI * i) / 39; return O(5 + 2.5 * Math.cos(t), 2.5 * Math.sin(t)); });
  const crescent = [...outer, ...inner];
  const inC = (p: { x: number; y: number }) => { const r = Math.hypot(p.x - 5, p.y); return p.x < 5 - 1e-6 && r > 2.5 + 1e-6 && r < 4 - 1e-6; };
  const path = routeAround(O(4.2, 0), O(-3, 0), [crescent], 0.6);   // in de binnenbocht, 1,7 m van de binnenrand
  assert.ok(path.length >= 3 && !through(path, inC), JSON.stringify(path));
  assert.ok(path.some(p => p.x > 5), 'niet door de opening');
});

// ---- de lijnen van het plan: alleen binnen de zone, anders geen lijn ----

test('plan: een onbekende zone krijgt geen lijn, een leg buiten de zone breekt de lijn, en de oversteek bestaat alleen met twee bekende zones', () => {
  const Z1 = prepareZone([O(0, 0), O(10, 0), O(10, 10), O(0, 10)])!, Z2 = prepareZone([O(20, 0), O(30, 0), O(30, 10), O(20, 10)])!;
  const zones = new Map([['map0', Z1], ['map1', Z2]]);
  const rail = { zones: ['map0', 'map1'] as const, rail: prepareRail([O(9.5, 5), O(15, 8), O(20.5, 5)]) };
  const geometry = [['map0', [[2, 2], [8, 2], [8, 8]]], ['map1', [[22, 5], [28, 5]]]] as const;
  const routes = planRoutes(geometry, zones, [rail], none);
  assert.equal(routes.length, 2);
  assert.deepEqual(routes[0].pieces, [[O(2, 2), O(8, 2), O(8, 8)]]);
  assert.deepEqual(routes[0].crossing, [O(8, 8), ...rail.rail, O(22, 5)]);
  assert.deepEqual(routes[1].pieces, [[O(22, 5), O(28, 5)]]);
  assert.equal(routes[1].crossing, null);
  // een checkpoint buiten de zone (verouderd plan): die legs krijgen geen lijn, de rest wel
  const stale = [['map0', [[2, 2], [8, 2], [12, 2], [8, 8], [2, 8]]]] as const;
  assert.deepEqual(planRoutes(stale, zones, [], none)[0].pieces, [[O(2, 2), O(8, 2)], [O(8, 8), O(2, 8)]]);
  // een zone die de kaart niet kent: niets, ook geen oversteek, ook niet van de bekende zone ernaar toe
  const unknown = [['map0', [[2, 2], [8, 2]]], ['map7', [[42, 5], [48, 5]]]] as const;
  const gone = planRoutes(unknown, zones, [], none);
  assert.deepEqual(gone[0].pieces, [[O(2, 2), O(8, 2)]]);
  assert.equal(gone[0].crossing, null);
  assert.deepEqual(gone[1].pieces, []);
  // zonder kanaal tussen losse zones: geen oversteek, de lijnen in de zones blijven
  const apart = planRoutes(geometry, zones, [], none);
  assert.equal(apart[0].crossing, null);
  assert.equal(apart[0].pieces.length + apart[1].pieces.length, 2);
  // een zone met één checkpoint: geen lijn, geen fout
  assert.deepEqual(planRoutes([['map0', [[5, 5]]]] as const, zones, [], none)[0].pieces, []);
});

test('plan: een regelmatige zigzagrand van duizenden punten (tanden groter dan de uitdunning) blaast de uitdunning niet op en blijft snel', () => {
  // elk punt 1 cm verder langs een vierkant van 20 m, om en om 30 cm naar binnen en naar buiten: 8000 punten
  const zigzag: Array<{ x: number; y: number }> = [];
  const square = [O(0, 0), O(20, 0), O(20, 20), O(0, 20)];
  square.forEach((p, i) => { const q = square[(i + 1) % 4]; const n = 2000; for (let k = 0; k < n; k++) { const t = k / n, s = k % 2 ? 0.3 : -0.3; zigzag.push({ x: p.x + (q.x - p.x) * t + (q.y - p.y) / 20 * s, y: p.y + (q.y - p.y) * t - (q.x - p.x) / 20 * s }); } });
  const t0 = performance.now();
  // zo'n rand is geen zone: geen lijn (de cirkels blijven), geen blanco kaart, geen minutenlange berekening
  assert.equal(prepareZone(zigzag), null);
  // als obstakel telt zo'n vorm als zijn omhulsel
  const obstacles = prepareObstacles([zigzag.map(p => ({ x: p.x / 4 + 30, y: p.y / 4 }))], 0.6);
  assert.ok(obstacles.hulls[0].ring.length <= 8, String(obstacles.hulls[0].ring.length));
  const zone = prepareZone([O(-5, -5), O(45, -5), O(45, 25), O(-5, 25)])!;
  const route = planRoutes([['map0', [[25, 2], [40, 2]]]] as const, new Map([['map0', zone]]), [], obstacles);
  assert.ok(route[0].pieces.length === 1 && route[0].pieces[0].length >= 4 && !through(route[0].pieces[0], p => p.x > 30.6 && p.x < 34.4 && p.y > 0.6 && p.y < 4.4), JSON.stringify(route[0].pieces));
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `${ms} ms`);
});

test('plan: een kanaal van een ander zonepaar wordt niet gebruikt, en een onbekende eerste zone met een bekende tweede tekent alleen de tweede', () => {
  const Z1 = prepareZone([O(0, 0), O(10, 0), O(10, 10), O(0, 10)])!, Z2 = prepareZone([O(20, 0), O(30, 0), O(30, 10), O(20, 10)])!, Z3 = prepareZone([O(40, 0), O(50, 0), O(50, 10), O(40, 10)])!;
  const zones = new Map([['map0', Z1], ['map1', Z2], ['map2', Z3]]);
  const r01 = { zones: ['map0', 'map1'] as const, rail: prepareRail([O(9.5, 5), O(15, 8), O(20.5, 5)]) };
  const r12 = { zones: ['map1', 'map2'] as const, rail: prepareRail([O(29.5, 5), O(35, 2), O(40.5, 5)]) };
  const geometry = [['map0', [[2, 5], [8, 5]]], ['map2', [[42, 5], [48, 5]]]] as const;
  // map0 -> map2 heeft geen eigen kanaal: geen oversteek, ook niet via de twee andere kanalen
  assert.equal(planRoutes(geometry, zones, [r01, r12], none)[0].crossing, null);
  const viaAll = planRoutes([['map0', [[2, 5], [8, 5]]], ['map1', [[22, 5], [28, 5]]], ['map2', [[42, 5], [48, 5]]]] as const, zones, [r12, r01], none);
  assert.deepEqual(viaAll[0].crossing, [O(8, 5), ...r01.rail, O(22, 5)]);
  assert.deepEqual(viaAll[1].crossing, [O(28, 5), ...r12.rail, O(42, 5)]);
  const firstUnknown = planRoutes([['map9', [[2, 5], [8, 5]]], ['map1', [[22, 5], [28, 5]]]] as const, zones, [r01], none);
  assert.deepEqual(firstUnknown[0].pieces, []);
  assert.equal(firstUnknown[0].crossing, null);
  assert.deepEqual(firstUnknown[1].pieces, [[O(22, 5), O(28, 5)]]);
});
