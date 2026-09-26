// Zelfcheck voor localToGps/gpsToLocal: de maaier rekent in UTM (kaartmeters
// lopen langs het UTM-raster), dus de kaart op de foto moet dat ook doen.
// Referentie: PROJ (+proj=utm +zone=32), dezelfde bibliotheek als de maaier,
// rond de oorsprong van LFIN2230700238.
// Draaien: node --experimental-strip-types dashboard/src/utils/coords.check.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localToGps, gpsToLocal, calibrateGps, uncalibrateGps, splitMapCalibration } from './coords.ts';

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

test('draw/brush/paste inverse blijft exact met anker, rotatie, schaal en fysieke verschuiving', () => {
  const anchor = { x: -1.21, y: 0.48 };
  const physical = { x: 0.6, y: -0.35 };
  const shifted = localToGps(physical, ref);
  const cal = { rotation: 37, scale: 1.12, offsetLat: shifted.lat - ref.lat + 0.000004, offsetLng: shifted.lng - ref.lng - 0.000005 };
  const { display, geometryOffset } = splitMapCalibration(cal, cal, physical, ref);
  const point = { x: 20, y: -12 };
  const rawGps = localToGps({ x: point.x - anchor.x, y: point.y - anchor.y }, ref);
  const shown = calibrateGps(rawGps, display, ref, geometryOffset);
  const restored = gpsToLocal(uncalibrateGps(shown, display, ref, geometryOffset), ref);
  assert.ok(Math.hypot(restored.x + anchor.x - point.x, restored.y + anchor.y - point.y) < 1e-6);
  const effectiveGps = localToGps({ x: point.x + physical.x - anchor.x, y: point.y + physical.y - anchor.y }, ref);
  assert.ok(metres(calibrateGps(effectiveGps, display, ref), shown) < 1e-6);
});

test('polygonshift of shift-preview verplaatst een stilstaande maaier niet', () => {
  const zero = { offsetLat: 0, offsetLng: 0, rotation: 21, scale: 0.98 };
  const actual = localToGps({ x: 10, y: 20 }, ref);
  const offset = { x: 0.7, y: -0.4 };
  const shifted = localToGps(offset, ref);
  const saved = { ...zero, offsetLat: shifted.lat - ref.lat, offsetLng: shifted.lng - ref.lng };
  const preview = { ...saved, offsetLat: saved.offsetLat + 0.000003 };
  const before = calibrateGps(actual, zero, ref);
  for (const active of [saved, preview]) {
    const { display } = splitMapCalibration(active, saved, offset, ref);
    assert.ok(metres(calibrateGps(actual, display, ref), before) < 1e-6);
  }
  assert.ok(Number.isNaN(uncalibrateGps(actual, { ...zero, scale: 0 }, ref).lat));
});
