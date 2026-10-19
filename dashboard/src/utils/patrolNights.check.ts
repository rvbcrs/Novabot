// Zelfcheck voor het groeperen van patrouilles per nacht: de nacht begint 's avonds en loopt tot de volgende middag.
// Draaien: npx tsx dashboard/src/utils/patrolNights.check.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByNight, nightDate, nightKey } from './patrolNights.ts';

/** Lokale tijd van de browser; zo geeft de check dezelfde uitkomst in elke tijdzone. */
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

/** Draait `fn` in een andere tijdzone (Node leest TZ opnieuw als hij verandert) en zet de oude terug. */
function inZone<T>(zone: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

test('een ronde van 23:30 en die van 00:10 en 05:50 daarna horen bij dezelfde nacht', () => {
  const key = nightKey(at(2026, 10, 18, 23, 30));
  assert.equal(key, '2026-10-18');
  assert.equal(nightKey(at(2026, 10, 19, 0, 10)), key);
  assert.equal(nightKey(at(2026, 10, 19, 5, 50)), key);
});

test('om 12:00 begint een nieuwe nacht, een minuut ervoor hoort nog bij de vorige', () => {
  assert.equal(nightKey(at(2026, 10, 19, 11, 59)), '2026-10-18');
  assert.equal(nightKey(at(2026, 10, 19, 12, 0)), '2026-10-19');
  assert.equal(nightKey(at(2026, 10, 19, 12, 0)), nightKey(at(2026, 10, 19, 23, 59)));
});

test('een ISO-tekst en een getal geven dezelfde sleutel', () => {
  const ms = at(2026, 10, 19, 0, 10);
  assert.equal(nightKey(new Date(ms).toISOString()), nightKey(ms));
  assert.equal(nightKey(new Date(ms).toISOString()), '2026-10-18');
});

test('een nacht over de jaargrens en over een maandgrens', () => {
  assert.equal(nightKey(at(2027, 1, 1, 0, 10)), '2026-12-31');
  assert.equal(nightKey(at(2026, 11, 1, 3, 0)), '2026-10-31');
  assert.equal(nightKey(at(2028, 3, 1, 3, 0)), '2028-02-29');   // schrikkeljaar
});

test('op een dag dat de klok verspringt blijft de middag de grens', () => {
  // Amsterdam: op 29 maart 2026 is het 23 uur lang, op 25 oktober 2026 25 uur.
  inZone('Europe/Amsterdam', () => {
    assert.equal(nightKey(at(2026, 10, 25, 11, 30)), '2026-10-24');   // 12 uur terugtellen gaf hier de 25e
    assert.equal(nightKey(at(2026, 10, 25, 12, 30)), '2026-10-25');
    assert.equal(nightKey(at(2026, 10, 25, 0, 10)), '2026-10-24');
    assert.equal(nightKey(at(2026, 3, 29, 11, 30)), '2026-03-28');
    assert.equal(nightKey(at(2026, 3, 29, 12, 30)), '2026-03-29');    // 12 uur terugtellen gaf hier de 28e
    assert.equal(nightKey(at(2026, 3, 29, 23, 30)), '2026-03-29');
  });
});

test('de nacht volgt de lokale klok, in elke tijdzone', () => {
  for (const zone of ['UTC', 'Europe/Amsterdam', 'America/Los_Angeles', 'Pacific/Auckland']) {
    inZone(zone, () => {
      assert.equal(nightKey(at(2026, 10, 18, 23, 30)), '2026-10-18', zone);
      assert.equal(nightKey(at(2026, 10, 19, 5, 50)), '2026-10-18', zone);
      assert.equal(nightKey(at(2026, 10, 19, 12, 0)), '2026-10-19', zone);
    });
  }
});

test('de datum van een nacht is de lokale kalenderdag, ook ten westen van UTC', () => {
  for (const zone of ['UTC', 'Europe/Amsterdam', 'America/Los_Angeles', 'Pacific/Auckland']) {
    inZone(zone, () => {
      const d = nightDate('2026-10-18');
      assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [2026, 9, 18], zone);
    });
  }
});

test('groeperen houdt nieuwste eerst aan en splitst op de nachtgrens', () => {
  const runs = [
    { run: 'e', startedAt: at(2026, 10, 19, 23, 0) },    // nacht van de 19e
    { run: 'd', startedAt: at(2026, 10, 19, 5, 30) },    // nacht van de 18e
    { run: 'c', startedAt: at(2026, 10, 19, 0, 30) },
    { run: 'b', startedAt: at(2026, 10, 18, 23, 30) },
    { run: 'a', startedAt: at(2026, 10, 18, 11, 0) },    // nacht van de 17e
  ];
  const groups = groupByNight(runs);
  assert.deepEqual(groups.map(g => g.night), ['2026-10-19', '2026-10-18', '2026-10-17']);
  assert.deepEqual(groups.map(g => g.runs.map(r => r.run)), [['e'], ['d', 'c', 'b'], ['a']]);
});

test('groeperen werkt ook met ISO-teksten en laat de ronden zelf ongemoeid', () => {
  const runs = [
    { run: 'b', startedAt: new Date(at(2026, 10, 19, 0, 10)).toISOString() },
    { run: 'a', startedAt: at(2026, 10, 18, 23, 30) },
  ];
  const groups = groupByNight(runs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].runs[0], runs[0]);
  assert.equal(groups[0].runs[1], runs[1]);
});

test('zonder ronden zijn er geen groepen', () => {
  assert.deepEqual(groupByNight([]), []);
});
