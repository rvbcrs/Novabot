import { describe, expect, it } from 'vitest';
import { mapToGps, gpsToMap, effectiveMapPoints, validMapPoint } from '../mapProjection';
const ref = { lat: 52.140845931081316, lng: 6.2311545451881649 };
const anchor = { x: -1.21, y: 0.48 };
describe('UTM grid projection with a nonzero dock anchor', () => {
  it('agrees with independent PROJ coordinates within a centimetre in both directions', () => {
    const expected = { lat: 52.14098749228963, lng: 6.231438093593753 };
    const point = { x: anchor.x + 20, y: anchor.y + 15 };
    const gps = mapToGps(point, ref, anchor);
    expect(Math.hypot((gps.lat - expected.lat) * 111265, (gps.lng - expected.lng) * 68477)).toBeLessThan(0.01);
    const roundTrip = gpsToMap(expected, ref, anchor);
    expect(Math.hypot(roundTrip.x - point.x, roundTrip.y - point.y)).toBeLessThan(0.01);
    expect(mapToGps(anchor, ref, anchor)).toEqual(ref);
    expect(validMapPoint(null)).toBe(false);
  });
  it('shifts geometry but preserves the dock point and leaves inputs unchanged', () => {
    const points = [anchor, { x: 2, y: 3 }];
    expect(effectiveMapPoints(points, { x: 1, y: -1 }, 'map1tocharge_unicom')).toEqual([anchor, { x: 3, y: 2 }]);
    const shifted = effectiveMapPoints(points, { x: 1, y: -1 }, 'map1')[0];
    expect(shifted.x).toBeCloseTo(-0.21);
    expect(shifted.y).toBeCloseTo(-0.52);
    expect(points[1]).toEqual({ x: 2, y: 3 });
  });
});
