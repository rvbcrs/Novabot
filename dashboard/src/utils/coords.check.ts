// Zelfcheck voor localToGps/gpsToLocal: de maaier rekent in UTM (kaartmeters
// lopen langs het UTM-raster), dus de kaart op de foto moet dat ook doen.
// Referentie: PROJ (+proj=utm +zone=32), dezelfde bibliotheek als de maaier,
// rond de oorsprong van LFIN2230700238.
// Draaien: node --experimental-strip-types dashboard/src/utils/coords.check.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localToGps, gpsToLocal } from './coords.ts';

const ref = { lat: 52.140845931081316, lng: 6.2311545451881649 };
// Rasterverschuiving (m) vanaf ref, en waar PROJ die neerlegt.
const cases: Array<[number, number, number, number]> = [
  [20, 15, 52.14098749228963, 6.231438093593753],
  [-12.5, 30, 52.14111105172895, 6.230955382849581],
  [0, 25, 52.14107043698007, 6.231140612434456],
  [25, 0, 52.140854503011845, 6.231519429153085],
];

const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  Math.hypot((a.lat - b.lat) * 111265, (a.lng - b.lng) * 68477);

test('kaartmeters landen waar PROJ ze neerlegt (binnen 1 cm)', () => {
  for (const [x, y, lat, lng] of cases) {
    const d = metres(localToGps({ x, y }, ref), { lat, lng });
    assert.ok(d < 0.01, `(${x}, ${y}) ligt ${(d * 100).toFixed(1)} cm naast PROJ`);
  }
});

test('terug naar kaartmeters geeft hetzelfde punt (binnen 1 cm)', () => {
  for (const [x, y, lat, lng] of cases) {
    const l = gpsToLocal({ lat, lng }, ref);
    const d = Math.hypot(l.x - x, l.y - y);
    assert.ok(d < 0.01, `(${x}, ${y}) komt terug op (${l.x.toFixed(3)}, ${l.y.toFixed(3)})`);
  }
});
