// Zelfcheck voor het gereden spoor van een nachtpatrouille: sessies, drempels, koppeling aan de run.
// Draaien: node --experimental-strip-types dashboard/src/utils/patrolTrack.check.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceTrack, liveTrack, MAX_POINTS, NO_TRACKS, splitTrack, trackForRun, trackForView, type TrackInput, type TrackState } from './patrolTrack.ts';

const base: TrackInput = { sn: 'M1', enabled: true, phase: 'patrolling', active: true, point: null, reportsRun: null };
const step = (state: TrackState, over: Partial<TrackInput>) => advanceTrack(state, { ...base, ...over });
const at = (x: number, y: number) => ({ x, y });
const last = (state: TrackState) => state.sessions[state.sessions.length - 1];

test('een patrouille begint een sessie en legt de positie vast, kleine stapjes niet', () => {
  let s = step(NO_TRACKS, { point: at(1, 1) });
  assert.equal(s.sessions.length, 1);
  assert.deepEqual(last(s).points, [at(1, 1)]);
  s = step(s, { point: at(1.05, 1) });          // 5 cm: te dichtbij
  assert.equal(last(s).points.length, 1);
  s = step(s, { point: at(1.2, 1) });           // 20 cm van het laatste punt
  assert.deepEqual(last(s).points, [at(1, 1), at(1.2, 1)]);
  assert.deepEqual(liveTrack(s), last(s).points);
});

test('geen positie, (0, 0) en onzin worden niet vastgelegd', () => {
  let s = step(NO_TRACKS, { point: null });
  assert.equal(last(s).points.length, 0);
  s = step(s, { point: at(0, 0) });
  s = step(s, { point: at(NaN, 2) });
  assert.equal(last(s).points.length, 0);
  s = step(s, { point: at(0, 3) });             // 0 op een as is wel een positie
  assert.equal(last(s).points.length, 1);
});

test('met dezelfde invoer verandert er niets, en het is dezelfde toestand terug', () => {
  const s = step(NO_TRACKS, { point: at(1, 1), reportsRun: null });
  assert.equal(step(s, { point: at(1, 1) }), s);
  assert.equal(step(s, { point: at(1.02, 1) }), s);
});

test('buiten een patrouille wordt niets vastgelegd; het spoor van de laatste blijft bewaard', () => {
  let s = step(NO_TRACKS, { point: at(1, 1) });
  s = step(s, { point: at(2, 1) });
  const done = step(s, { phase: 'done', active: false, point: at(5, 5) });
  assert.equal(liveTrack(done), null);
  assert.deepEqual(last(done).points, [at(1, 1), at(2, 1)]);
  assert.equal(step(done, { phase: 'done', active: false, point: at(9, 9) }), done);
});

test('een nieuwe patrouille begint een nieuw spoor, ook als starting opnieuw komt', () => {
  let s = step(NO_TRACKS, { point: at(1, 1) });
  s = step(s, { phase: 'done', active: false });
  s = step(s, { phase: 'starting', point: at(3, 3) });          // actief geworden: nieuwe sessie
  assert.equal(s.sessions.length, 2);
  assert.deepEqual(last(s).points, [at(3, 3)]);
  // een patrouille zonder tussentijds inactief moment: starting na patrolling
  s = step(s, { phase: 'patrolling', point: at(4, 3) });
  s = step(s, { phase: 'starting', point: at(8, 8) });
  assert.equal(s.sessions.length, 3);
  assert.deepEqual(last(s).points, [at(8, 8)]);
});

test('het spoor hoort bij de run die er verslag van doet, en een oude run telt niet mee', () => {
  // de pagina hield nog de meldingen van r1 vast toen de patrouille begon (herverbinding)
  let s = step(NO_TRACKS, { point: at(1, 1), reportsRun: 'r1' });
  assert.equal(last(s).run, null);
  s = step(s, { point: at(2, 1), reportsRun: 'r1' });
  assert.equal(last(s).run, null);
  // de eerste melding van een andere run is van deze patrouille
  s = step(s, { point: at(3, 1), reportsRun: 'r2' });
  assert.equal(last(s).run, 'r2');
  assert.deepEqual(trackForRun(s, 'r2'), [at(1, 1), at(2, 1), at(3, 1)]);
  assert.equal(trackForRun(s, 'r1'), null);
  // meldingen zonder run (na de wis bij starting) binden niets
  const fresh = step(NO_TRACKS, { point: at(1, 1), reportsRun: null });
  assert.equal(last(fresh).run, null);
  assert.equal(last(step(fresh, { reportsRun: 'r5' })).run, 'r5');
});

test('een andere run die meldt terwijl er een gekoppeld is, is een nieuwe patrouille', () => {
  let s = step(NO_TRACKS, { point: at(1, 1), reportsRun: null });
  s = step(s, { reportsRun: 'r1' });
  s = step(s, { point: at(2, 1), reportsRun: 'r1' });
  s = step(s, { point: at(7, 7), reportsRun: 'r2' });           // r2 meldt: r1 was klaar zonder dat de pagina het zag
  assert.equal(s.sessions.length, 2);
  assert.equal(last(s).run, 'r2');
  assert.deepEqual(last(s).points, [at(7, 7)]);
  assert.deepEqual(trackForRun(s, 'r1'), [at(1, 1), at(2, 1)]);
  // en een late melding van r1 bindt de nieuwe sessie niet opnieuw
  assert.equal(last(step(s, { reportsRun: 'r1' })).run, 'r2');
});

test('bij meer dan MAX_POINTS blijft de vorm over: om de andere punt, en het laatste punt blijft', () => {
  let s = step(NO_TRACKS, { point: at(1, 1) });
  for (let i = 1; i <= MAX_POINTS; i++) s = step(s, { point: at(1 + i * 0.2, 1) });
  const pts = last(s).points;
  assert.ok(pts.length <= MAX_POINTS && pts.length > MAX_POINTS / 2 - 2, String(pts.length));
  assert.deepEqual(pts[pts.length - 1], at(1 + MAX_POINTS * 0.2, 1));
  assert.deepEqual(pts[0], at(1, 1));
});

test('een andere maaier of de schakelaar uit: niets wordt vastgelegd', () => {
  let s = step(NO_TRACKS, { point: at(1, 1) });
  const other = step(s, { sn: 'M2', point: at(5, 5) });
  assert.equal(other.sessions.length, 1);
  assert.deepEqual(last(other).points, [at(5, 5)]);
  const off = step(NO_TRACKS, { enabled: false, point: at(1, 1) });
  assert.equal(off.sessions.length, 0);
  assert.equal(liveTrack(off), null);
  // aanzetten midden in een patrouille begint daar een spoor
  s = step(off, { enabled: true, point: at(2, 2) });
  assert.deepEqual(last(s).points, [at(2, 2)]);
});

test('welk spoor bij de kaart hoort: het levende bij een patrouille, het bewaarde bij een rapport, anders geen', () => {
  let s = step(NO_TRACKS, { point: at(1, 1), reportsRun: null });
  s = step(s, { point: at(2, 1), reportsRun: 'r2' });
  assert.deepEqual(trackForView(s, { mode: 'live', run: null }), { points: [at(1, 1), at(2, 1)], live: true });
  assert.deepEqual(trackForView(s, { mode: 'finished', run: 'r2' }), { points: [at(1, 1), at(2, 1)], live: false });
  assert.equal(trackForView(s, { mode: 'finished', run: 'r9' }), null);
  assert.equal(trackForView(s, { mode: 'plan', run: null }), null);
  assert.equal(trackForView(s, null), null);
  // afgelopen: live is er niet meer, het bewaarde spoor wel
  const over = step(s, { phase: 'done', active: false });
  assert.equal(trackForView(over, { mode: 'live', run: null }), null);
  assert.equal(trackForView(over, { mode: 'finished', run: 'r2' })?.points.length, 2);
  // een sessie zonder punten geeft niets om te tekenen
  assert.equal(trackForView(step(NO_TRACKS, { point: null }), { mode: 'live', run: null }), null);
});

test('een sprong over een signaalgat geeft twee stukken, geen lijn dwars door obstakels', () => {
  const line = [at(0, 0), at(0.4, 0), at(0.8, 0), at(10.8, 0), at(11.2, 0)];   // 10 m verder, na een minuut slapen
  assert.deepEqual(splitTrack(line), [[at(0, 0), at(0.4, 0), at(0.8, 0)], [at(10.8, 0), at(11.2, 0)]]);
  assert.deepEqual(splitTrack([at(0, 0), at(5, 0), at(10, 0)]), [[at(0, 0), at(5, 0), at(10, 0)]]);   // precies 5 m: een rit
  assert.equal(splitTrack([at(0, 0), at(5.01, 0)]).length, 2);
  assert.equal(splitTrack([at(0, 0), at(1, 0), at(9, 0), at(18, 0), at(18.5, 0)]).length, 3);
  assert.deepEqual(splitTrack([]), []);
  assert.deepEqual(splitTrack([at(1, 1)]), [[at(1, 1)]]);
});

test('een zevende sessie laat de oudste vallen, ook met zijn run', () => {
  let s = NO_TRACKS;
  for (let i = 1; i <= 7; i++) {
    s = step(s, { phase: 'starting', active: true, point: at(i, 1), reportsRun: null });
    s = step(s, { point: at(i, 2), reportsRun: `r${i}` });
    s = step(s, { phase: 'done', active: false });
  }
  assert.equal(s.sessions.length, 6);
  assert.equal(trackForRun(s, 'r1'), null);
  assert.deepEqual(trackForRun(s, 'r2'), [at(2, 1), at(2, 2)]);
  assert.deepEqual(trackForRun(s, 'r7'), [at(7, 1), at(7, 2)]);
  assert.deepEqual(s.sessions.map(x => x.id), [2, 3, 4, 5, 6, 7]);
});
