import { describe, it, expect } from 'vitest';
import { computeDockDrift, median } from '../../services/dockDrift.js';
import type { DockSampleRow } from '../../db/repositories/dockSamples.js';

const row = (day: string, x: number, y: number, lat = 52.0, lng = 5.0): DockSampleRow =>
  ({ id: 0, sn: 'x', ts: `${day} 10:00:00`, map_x: x, map_y: y, lat, lng, n: 10 });

describe('dock drift', () => {
  it('median is robust to one bad park', () => {
    expect(median([0.01, 0.02, 0.9])).toBe(0.02);
  });

  it('a stable dock is ok, a walking one warns and then fails', () => {
    const stable = computeDockDrift([row('2026-09-01', 0.02, 0.01), row('2026-09-02', 0.03, 0.00), row('2026-09-03', 0.02, 0.02), row('2026-09-10', 0.04, 0.01)]);
    expect(stable.status).toBe('ok');
    expect(stable.latest!.dist).toBeLessThan(0.05);

    const walking = computeDockDrift([
      row('2026-09-01', 0, 0), row('2026-09-02', 0.01, 0), row('2026-09-03', 0, 0.01),
      row('2026-09-12', 0.27, 0.05, 52.0000025, 5.0),   // the station moved ~28 cm
    ]);
    expect(walking.status).toBe('warn');
    expect(walking.referenceAt).toBe('2026-09-01 10:00:00');
    expect(Math.round(walking.latest!.dist * 100)).toBe(27);

    const gone = computeDockDrift([row('2026-09-01', 0, 0), row('2026-09-02', 0, 0), row('2026-09-20', 0.50, 0, 52.0000045, 5.0)]);
    expect(gone.status).toBe('fail');
  });

  // A station that did not move still parks a few cm apart: 6 cm on the map and
  // 7 cm RTK after a firmware update, with nothing moved (LFIN2231200033, Oct
  // 2026). The zones barely shift at that size, so it is no warning.
  it('a few centimetres is ok', () => {
    const d = computeDockDrift([row('2026-10-14', 0, 0), row('2026-10-15', 0, 0), row('2026-10-16', 0, 0),
      row('2026-10-20', 0.05, 0.03, 52.00000063, 5.0)]);
    expect(Math.round(d.latest!.gpsDist! * 100)).toBe(7);
    expect(d.status).toBe('ok');
  });

  it('20 cm is still ok: warnings start at 25 cm', () => {
    const d = computeDockDrift([row('2026-10-14', 0, 0), row('2026-10-15', 0, 0), row('2026-10-16', 0, 0),
      row('2026-10-20', 0.20, 0, 52.0000018, 5.0)]);
    expect(Math.round(d.latest!.gpsDist! * 100)).toBe(20);
    expect(d.status).toBe('ok');
  });

  it('one bad stint in a day does not raise the alarm: the day is a median', () => {
    const d = computeDockDrift([row('2026-09-01', 0, 0), row('2026-09-02', 0, 0),
      row('2026-09-05', 0.30, 0.30), row('2026-09-05', 0.01, 0), row('2026-09-05', 0.02, 0.01)]);
    expect(d.status).toBe('ok');
    expect(d.daily.length).toBe(3);
  });

  it('gps offset is reported in metres next to the map offset', () => {
    const d = computeDockDrift([row('2026-09-01', 0, 0, 52, 5), row('2026-09-02', 0, 0, 52, 5), row('2026-09-09', 0.08, 0, 52, 5.0000012)]);
    expect(d.latest!.gpsDist).toBeGreaterThan(0.07);
    expect(d.latest!.gpsDist).toBeLessThan(0.10);
  });

  it('needs at least two stints', () => {
    expect(computeDockDrift([row('2026-09-01', 0, 0)]).status).toBe('unknown');
  });
});

describe('dock drift judges the station by RTK (live LFIN2230700238)', () => {
  // The map position on the dock sat ~1.3 m off after a restart while the RTK
  // position stayed within a few cm: the station never moved, mowing was fine.
  it('a wandering map position with a steady RTK position is ok', () => {
    const d = computeDockDrift([row('2026-09-23', 0, 0), row('2026-09-24', 0, 0), row('2026-09-25', 0, 0),
      row('2026-10-13', -1.29, 0.42, 52.0000001, 5.0)]);
    expect(d.latest!.dist).toBeGreaterThan(1.3);
    expect(d.status).toBe('ok');
  });
  it('a moved RTK position warns, also with the map position in place', () => {
    const d = computeDockDrift([row('2026-09-01', 0, 0), row('2026-09-02', 0, 0),
      row('2026-09-09', 0, 0, 52.0000025, 5.0)]);   // ~28 cm north
    expect(d.status).toBe('warn');
  });
  it('without GPS in the samples the map offset still counts', () => {
    const noGps = (day: string, x: number) => ({ ...row(day, x, 0), lat: null, lng: null });
    expect(computeDockDrift([noGps('2026-09-01', 0), noGps('2026-09-02', 0), noGps('2026-09-09', 0.5)]).status).toBe('fail');
  });
});
