import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { expect, it } from 'vitest';
import { liveMapMarkerPosition, placeClosingLabel } from '../liveMapLayout';
import { MOWER_MAP_IMAGE } from '../../components/mower/mowerMapImage';

it('bundles the real mower icon in JS so rendering needs no network asset request', () => {
  expect(MOWER_MAP_IMAGE.startsWith('data:image/png;base64,')).toBe(true);
  const embedded = Buffer.from(MOWER_MAP_IMAGE.split(',')[1], 'base64');
  const original = readFileSync(new URL('../../../assets/lawn_mower.png', import.meta.url));
  expect(embedded.equals(original)).toBe(true);
});

it('keeps a closed-loop distance label clear of the mower and inside the map', () => {
  for (const marker of [{ sx: 150, sy: 75 }, { sx: 22, sy: 22 }, { sx: 278, sy: 128 }]) {
    const label = placeClosingLabel(marker, marker, 36, 20, 150);
    expect(Math.abs(label.sy - marker.sy)).toBeGreaterThan(7.5 + 20);
    expect(label.sy).toBeGreaterThanOrEqual(7.5);
    expect(label.sy).toBeLessThanOrEqual(150 - 7.5);
    expect(label.sx).toBeGreaterThanOrEqual(18);
    expect(label.sx).toBeLessThanOrEqual(282);
  }
  expect(placeClosingLabel({ sx: 50, sy: 50 }, { sx: 150, sy: 75 }, 36, 20, 150)).toEqual({ sx: 50, sy: 50 });
});

it('uses the current mower position and avoids it even when the recorded trail lags', () => {
  const trailEnd = { sx: 50, sy: 50 };
  const current = { sx: 150, sy: 75 };
  const marker = liveMapMarkerPosition(trailEnd, current);
  expect(marker).toBe(current);
  expect(liveMapMarkerPosition(trailEnd, null)).toBe(trailEnd);
  const label = placeClosingLabel(current, marker, 36, 20, 150);
  expect(Math.abs(label.sy - current.sy)).toBeGreaterThan(27.5);
});
