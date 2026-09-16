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
  similarityCorners, derivedPlacement, photoToLatLng, latLngToPhoto, solvePlacement, insidePhoto,
  rotateCorners, scaleCorners, translateCorners, isConvex, centroid, distanceM, M_PER_DEG_LAT,
} from '../../../../dashboard/src/utils/droneOverlayMath.js';
import type { DroneCorners, LatLng } from '../../../../dashboard/src/api/client.js';

const size = { width: 4000, height: 3000 };
const centre = { lat: 52.140889, lng: 6.231036 };
const rect = similarityCorners(centre, 64, -23, size.width / size.height);
const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
/** Distance on the ground between two map points, metres (cos(lat) at the garden; a third of a millimetre from the model's frames). */
const metres = (a: LatLng, b: LatLng) => Math.hypot((a.lat - b.lat) * M_PER_DEG_LAT, (a.lng - b.lng) * M_PER_DEG_LAT * Math.cos(centre.lat * Math.PI / 180));
const expectSameCorners = (got: DroneCorners, want: DroneCorners, tolM: number) => {
  for (let i = 0; i < 4; i++) expect(metres(got[i], want[i])).toBeLessThan(tolM);
};

/**
 * A photo from a camera that was not straight down: the ground is a trapezium
 * in the frame, so on the map the photo's rectangle becomes a trapezium the
 * other way round. Top edge narrower than the bottom, then rotated.
 */
function keystoned(): DroneCorners {
  const flat = similarityCorners(centre, 60, 0, size.width / size.height);
  const c = centroid(flat);
  const cosLat = Math.cos(c.lat * Math.PI / 180);
  const squeeze = (p: LatLng, k: number): LatLng => ({ lat: p.lat, lng: c.lng + (p.lng - c.lng) * k });
  const q: DroneCorners = [squeeze(flat[0], 0.85), squeeze(flat[1], 0.85), squeeze(flat[2], 1.15), squeeze(flat[3], 1.15)];
  void cosLat;
  return rotateCorners(q, 17);
}

describe('drone photo geometry', () => {
  it('lays a photo flat from centre, width and rotation, and reads those back', () => {
    const flat = similarityCorners(centre, 64, 0, size.width / size.height);
    expect(metres(flat[0], flat[1])).toBeCloseTo(64, 3);        // top edge
    expect(metres(flat[0], flat[3])).toBeCloseTo(48, 3);        // left edge, 4:3
    expect(flat[1].lng).toBeGreaterThan(flat[0].lng);           // top-right is east of top-left
    expect(flat[3].lat).toBeLessThan(flat[0].lat);              // bottom-left is south of top-left
    const d = derivedPlacement(rect);
    expect(d.widthM).toBeCloseTo(64, 6);
    expect(d.rotationDeg).toBeCloseTo(-23, 6);
    expect(metres(d.centre, centre)).toBeLessThan(1e-6);
  });

  it('turns clockwise on screen for a positive rotation', () => {
    const turned = similarityCorners(centre, 64, 90, size.width / size.height);
    // top edge now points south: top-right is south of top-left, same longitude
    expect(turned[1].lat).toBeLessThan(turned[0].lat);
    expect(close(turned[1].lng, turned[0].lng, 1e-9)).toBe(true);
    expect(metres(turned[0], turned[1])).toBeCloseTo(64, 3);
  });

  it('maps the photo centre to the centre and inverts exactly, rectangle or trapezium', () => {
    for (const corners of [rect, keystoned()]) {
      const mid = photoToLatLng(corners, size, { u: 2000, v: 1500 });
      if (corners === rect) expect(metres(mid, centre)).toBeLessThan(1e-6);
      for (const px of [{ u: 0, v: 0 }, { u: 4000, v: 3000 }, { u: 123, v: 2870 }, { u: 2000, v: 1500 }]) {
        const back = latLngToPhoto(corners, size, photoToLatLng(corners, size, px));
        expect(close(back.u, px.u, 1e-6) && close(back.v, px.v, 1e-6)).toBe(true);
      }
      // the corners themselves are the photo's corner pixels
      expect(metres(photoToLatLng(corners, size, { u: 0, v: 0 }), corners[0])).toBeLessThan(1e-6);
      expect(metres(photoToLatLng(corners, size, { u: 4000, v: 3000 }), corners[2])).toBeLessThan(1e-6);
    }
  });

  it('one pair only shifts: the pixel lands on its point and the shape stays', () => {
    const target = { lat: centre.lat + 0.0002, lng: centre.lng - 0.0003 };
    const solved = solvePlacement(size, [{ px: { u: 700, v: 2100 }, ll: target }], rect);
    expect(metres(photoToLatLng(solved, size, { u: 700, v: 2100 }), target)).toBeLessThan(1e-6);
    const before = derivedPlacement(rect), after = derivedPlacement(solved);
    // a shift of 22 m north changes what a degree of longitude is worth: a third of a millimetre
    expect(Math.abs(after.widthM - before.widthM)).toBeLessThan(1e-3);
    expect(after.rotationDeg).toBeCloseTo(before.rotationDeg, 2);
  });

  it('recovers a flat placement from two pairs, whatever the starting guess', () => {
    const a = { u: 1240, v: 2610 }, b = { u: 3310, v: 820 };
    const pairs = [{ px: a, ll: photoToLatLng(rect, size, a) }, { px: b, ll: photoToLatLng(rect, size, b) }];
    const wrongGuess = similarityCorners({ lat: 51, lng: 5 }, 300, 100, 1);
    expectSameCorners(solvePlacement(size, pairs, wrongGuess), rect, 1e-3);
  });

  it('three pairs average out a click error', () => {
    const pxs = [{ u: 500, v: 500 }, { u: 3500, v: 600 }, { u: 2000, v: 2800 }];
    const pairs = pxs.map(px => ({ px, ll: photoToLatLng(rect, size, px) }));
    // second point 40 cm off to the east
    pairs[1] = { px: pairs[1].px, ll: { lat: pairs[1].ll.lat, lng: pairs[1].ll.lng + 0.4 / (M_PER_DEG_LAT * Math.cos(centre.lat * Math.PI / 180)) } };
    const solved = solvePlacement(size, pairs, rect);
    // every corner within the error, not shifted by all of it
    for (let i = 0; i < 4; i++) expect(metres(solved[i], rect[i])).toBeLessThan(0.4);
    expect(derivedPlacement(solved).rotationDeg).toBeCloseTo(-23, 0);
  });

  it('four pairs straighten a photo from a tilted camera; two pairs cannot', () => {
    const truth = keystoned();
    const pxs = [{ u: 500, v: 400 }, { u: 3500, v: 600 }, { u: 3300, v: 2700 }, { u: 700, v: 2500 }];
    const pairs = pxs.map(px => ({ px, ll: photoToLatLng(truth, size, px) }));
    const solved = solvePlacement(size, pairs, rect);
    expectSameCorners(solved, truth, 1e-3);
    const check = { u: 2000, v: 1500 };
    expect(metres(photoToLatLng(solved, size, check), photoToLatLng(truth, size, check))).toBeLessThan(1e-3);
    // the best rotate/scale/shift fit from the first two leaves the far corners metres off
    const twoOnly = solvePlacement(size, pairs.slice(0, 2), rect);
    const worst = Math.max(...truth.map((c, i) => metres(twoOnly[i], c)));
    expect(worst).toBeGreaterThan(1);
  });

  it('more than four pairs still fit exactly when the data is exact', () => {
    const truth = keystoned();
    const pxs = [{ u: 300, v: 300 }, { u: 3700, v: 200 }, { u: 3600, v: 2800 }, { u: 400, v: 2700 }, { u: 2000, v: 1500 }, { u: 1000, v: 2000 }];
    const solved = solvePlacement(size, pxs.map(px => ({ px, ll: photoToLatLng(truth, size, px) })), rect);
    expectSameCorners(solved, truth, 1e-3);
  });

  it('falls back to the similarity when four points lie on one line', () => {
    const pxs = [{ u: 500, v: 500 }, { u: 1500, v: 1250 }, { u: 2500, v: 2000 }, { u: 3500, v: 2750 }];
    const pairs = pxs.map(px => ({ px, ll: photoToLatLng(rect, size, px) }));
    const solved = solvePlacement(size, pairs, rect);
    expect(isConvex(solved)).toBe(true);
    expectSameCorners(solved, rect, 1e-3);
  });

  it('knows a folded or mirrored quadrilateral from a proper one', () => {
    expect(isConvex(rect)).toBe(true);
    expect(isConvex(keystoned())).toBe(true);
    expect(isConvex([rect[0], rect[2], rect[1], rect[3]])).toBe(false);   // bow tie
    expect(isConvex([rect[1], rect[0], rect[3], rect[2]])).toBe(false);   // mirrored
  });

  it('rotates and scales about a given pivot, which stays where it is', () => {
    const pivotPx = { u: 1000, v: 2000 };
    const pivot = photoToLatLng(rect, size, pivotPx);
    const turned = rotateCorners(rect, 30, pivot), bigger = scaleCorners(rect, 1.3, pivot);
    expect(metres(photoToLatLng(turned, size, pivotPx), pivot)).toBeLessThan(1e-3);
    expect(metres(photoToLatLng(bigger, size, pivotPx), pivot)).toBeLessThan(1e-3);
    expect(derivedPlacement(turned).rotationDeg).toBeCloseTo(7, 3);   // frames 11 m apart: a ten-thousandth of a degree
    expect(derivedPlacement(bigger).widthM).toBeCloseTo(83.2, 3);
    expect(metres(centroid(turned), centroid(rect))).toBeGreaterThan(1);   // the centre moved, the pivot did not
    expect(distanceM(rect[0], rect[1])).toBeCloseTo(64, 3);
  });

  it('rotates and scales about the centre and shifts as told', () => {
    const c0 = centroid(rect);
    const turned = rotateCorners(rect, 10);
    expect(derivedPlacement(turned).rotationDeg).toBeCloseTo(-13, 6);
    expect(metres(centroid(turned), c0)).toBeLessThan(1e-6);
    const bigger = scaleCorners(rect, 1.5);
    expect(derivedPlacement(bigger).widthM).toBeCloseTo(96, 6);
    expect(metres(centroid(bigger), c0)).toBeLessThan(1e-6);
    const moved = translateCorners(rect, 0.001, -0.002);
    expect(moved[2].lat).toBeCloseTo(rect[2].lat + 0.001, 12);
    expect(moved[2].lng).toBeCloseTo(rect[2].lng - 0.002, 12);
    expect(insidePhoto({ u: 4000, v: 3000 }, size)).toBe(true);
    expect(insidePhoto({ u: 4001, v: 0 }, size)).toBe(false);
    expect(insidePhoto({ u: NaN, v: 0 }, size)).toBe(false);
  });
});
