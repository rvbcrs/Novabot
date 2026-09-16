/**
 * Geometry of the drone photo placement (#124).
 *
 * The module is dashboard code, but it is pure arithmetic with no DOM and no
 * Leaflet, and the dashboard has no test runner. A wrong sign here puts the
 * photo somewhere else than where the user clicked, silently, so it is
 * checked from the server suite instead of not at all.
 */
import { describe, it, expect } from 'vitest';
import {
  latLngFromPhotoPixel, photoPixelFromLatLng, solveTwoPoint, overlayBounds, insidePhoto,
} from '../../../../dashboard/src/utils/droneOverlayMath.js';

const size = { width: 4000, height: 3000 };
const placement = { lat: 52.140889, lng: 6.231036, widthM: 64, rotationDeg: -23, opacity: 0.8 };
const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

describe('drone photo geometry', () => {
  it('maps the photo centre to the placement centre, whatever the rotation', () => {
    for (const rot of [0, 45, -23, 180]) {
      const ll = latLngFromPhotoPixel({ ...placement, rotationDeg: rot }, size, { u: 2000, v: 1500 });
      expect(close(ll.lat, placement.lat, 1e-9)).toBe(true);
      expect(close(ll.lng, placement.lng, 1e-9)).toBe(true);
    }
  });

  it('puts the right edge east at 0° and south at +90° (clockwise on screen)', () => {
    const right = latLngFromPhotoPixel({ ...placement, rotationDeg: 0 }, size, { u: 4000, v: 1500 });
    expect(right.lng).toBeGreaterThan(placement.lng);
    expect(close(right.lat, placement.lat, 1e-9)).toBe(true);
    const turned = latLngFromPhotoPixel({ ...placement, rotationDeg: 90 }, size, { u: 4000, v: 1500 });
    expect(turned.lat).toBeLessThan(placement.lat);            // 32 m south
    expect(close(turned.lng, placement.lng, 1e-9)).toBe(true);
    expect(close((placement.lat - turned.lat) * 111_320, 32, 0.01)).toBe(true);
  });

  it('inverts exactly', () => {
    for (const px of [{ u: 0, v: 0 }, { u: 4000, v: 3000 }, { u: 123, v: 2870 }]) {
      const back = photoPixelFromLatLng(placement, size, latLngFromPhotoPixel(placement, size, px));
      expect(close(back.u, px.u, 1e-6)).toBe(true);
      expect(close(back.v, px.v, 1e-6)).toBe(true);
    }
  });

  it('recovers a placement from two correspondences', () => {
    // Two photo points, where they land under the true placement, solve.
    const a = { u: 1240, v: 2610 }, b = { u: 3310, v: 820 };
    const A = latLngFromPhotoPixel(placement, size, a);
    const B = latLngFromPhotoPixel(placement, size, b);
    // Flat-earth model: cos(lat) is taken at A rather than at the centre, which
    // over a garden is worth a ten-thousandth of a degree and a hundredth of a
    // millimetre. A sign or convention error would be tens of degrees.
    const solved = solveTwoPoint(size, a, A, b, B)!;
    expect(close(solved.lat, placement.lat, 1e-7)).toBe(true);
    expect(close(solved.lng, placement.lng, 1e-7)).toBe(true);
    expect(close(solved.widthM, placement.widthM, 1e-3)).toBe(true);
    expect(close(solved.rotationDeg, placement.rotationDeg, 1e-3)).toBe(true);
  });

  it('recovers it from any starting guess, because the solve ignores the guess', () => {
    // The user picks pixels through whatever placement is current; the solve
    // only sees pixels and map points, so the wrong starting guess cannot leak in.
    const a = { u: 500, v: 500 }, b = { u: 3500, v: 2500 };
    const A = latLngFromPhotoPixel(placement, size, a), B = latLngFromPhotoPixel(placement, size, b);
    const solved = solveTwoPoint(size, a, A, b, B)!;
    expect(close(solved.rotationDeg, placement.rotationDeg, 1e-3)).toBe(true);
    expect(close(solved.widthM, placement.widthM, 1e-3)).toBe(true);
    // and pixel a lands back on A to within a millimetre (that point was the anchor)
    const A2 = latLngFromPhotoPixel(solved, size, a);
    expect(close((A2.lat - A.lat) * 111_320, 0, 1e-3)).toBe(true);
    expect(close((A2.lng - A.lng) * 111_320 * Math.cos(A.lat * Math.PI / 180), 0, 1e-3)).toBe(true);
  });

  it('refuses two identical pixels', () => {
    const a = { u: 100, v: 100 };
    expect(solveTwoPoint(size, a, { lat: 52, lng: 6 }, a, { lat: 52.001, lng: 6 })).toBeNull();
  });

  it('keeps the bounds and the pixel mapping consistent at the corners', () => {
    const [[s, w], [n, e]] = overlayBounds({ ...placement, rotationDeg: 0 }, size.width / size.height);
    const nw = latLngFromPhotoPixel({ ...placement, rotationDeg: 0 }, size, { u: 0, v: 0 });
    const se = latLngFromPhotoPixel({ ...placement, rotationDeg: 0 }, size, { u: 4000, v: 3000 });
    expect(close(nw.lat, n, 1e-9) && close(nw.lng, w, 1e-9)).toBe(true);
    expect(close(se.lat, s, 1e-9) && close(se.lng, e, 1e-9)).toBe(true);
    expect(insidePhoto({ u: 4000, v: 3000 }, size)).toBe(true);
    expect(insidePhoto({ u: 4001, v: 0 }, size)).toBe(false);
  });
});
