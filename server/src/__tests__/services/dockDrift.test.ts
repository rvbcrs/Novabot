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
      row('2026-09-12', 0.06, 0.03),
    ]);
    expect(walking.status).toBe('warn');
    expect(walking.referenceAt).toBe('2026-09-01 10:00:00');
    expect(Math.round(walking.latest!.dist * 100)).toBe(7);

    const gone = computeDockDrift([row('2026-09-01', 0, 0), row('2026-09-02', 0, 0), row('2026-09-20', 0.20, 0)]);
    expect(gone.status).toBe('fail');
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
