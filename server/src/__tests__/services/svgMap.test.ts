import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the data sources before importing the renderer so the module
// pulls our stubs at first load.
vi.mock('../../db/repositories/maps.js', () => ({
  mapRepo: {
    findWithArea: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../../mqtt/sensorData.js', () => ({
  deviceCache: new Map<string, Map<string, string>>(),
  getLocalTrail: vi.fn().mockReturnValue([]),
  translateValue: (field: string, v: string) => (field === 'work_status' && v === '0' ? 'Finished' : v),
}));

import { renderMowerMapSvg } from '../../render/svgMap.js';
import { mapRepo } from '../../db/repositories/maps.js';
import { deviceCache, getLocalTrail } from '../../mqtt/sensorData.js';

const SN = 'LFIN1231000211';

beforeEach(() => {
  vi.mocked(mapRepo.findWithArea).mockReset().mockReturnValue([]);
  vi.mocked(getLocalTrail).mockReset().mockReturnValue([]);
  deviceCache.clear();
});

function row(id: string, type: string, points: Array<{x: number; y: number}>) {
  return {
    id: 1,
    map_id: id,
    mower_sn: SN,
    map_name: id,
    map_type: type,
    map_area: JSON.stringify(points),
    map_max_min: null,
    file_name: null,
    file_size: null,
    canonical_name: id,
    created_at: '',
    updated_at: '',
  };
}

describe('renderMowerMapSvg', () => {
  it('returns a valid SVG document with svg root + viewBox', () => {
    const out = renderMowerMapSvg(SN);
    expect(out).toMatch(/^<\?xml version="1.0"/);
    expect(out).toContain('<svg ');
    expect(out).toContain('viewBox="0 0 600 600"');
    expect(out).toContain('</svg>');
  });

  it('emits a polygon for each work map row', () => {
    vi.mocked(mapRepo.findWithArea).mockReturnValue([
      row('map0', 'work', [{x: 0, y: 0}, {x: 4, y: 0}, {x: 4, y: 4}, {x: 0, y: 4}]),
    ]);
    const out = renderMowerMapSvg(SN);
    expect(out).toContain('class="work-fill"');
    expect(out).toContain('<polygon');
  });

  it('normalizes lowercase URL SNs before map lookup', () => {
    vi.mocked(mapRepo.findWithArea).mockImplementation((sn: string) => (
      sn === SN
        ? [row('map0', 'work', [{x: 0, y: 0}, {x: 4, y: 0}, {x: 4, y: 4}, {x: 0, y: 4}])]
        : []
    ));

    const out = renderMowerMapSvg(SN.toLowerCase());

    expect(mapRepo.findWithArea).toHaveBeenCalledWith(SN);
    expect(out).toContain('class="work-fill"');
    expect(out).not.toContain('No work map yet');
  });

  it('renders obstacles dashed red and unicom as polylines', () => {
    vi.mocked(mapRepo.findWithArea).mockReturnValue([
      row('map0_0_obstacle', 'obstacle', [{x: 1, y: 1}, {x: 2, y: 1}, {x: 2, y: 2}]),
      row('map0tomap1_0_unicom', 'unicom', [{x: 0, y: 0}, {x: 3, y: 3}]),
    ]);
    const out = renderMowerMapSvg(SN);
    expect(out).toContain('class="obstacle-fill"');
    expect(out).toContain('class="unicom-fill"');
    expect(out).toContain('<polyline class="unicom-fill"');
  });

  it('places a charger marker at the local origin', () => {
    const out = renderMowerMapSvg(SN);
    expect(out).toContain('class="charger-base"');
    expect(out).toContain('class="charger-bolt"');
  });

  it('places a mower marker when map_position cache is present', () => {
    deviceCache.set(SN, new Map([
      ['map_position_x', '1.5'],
      ['map_position_y', '-2'],
      ['map_position_orientation', '0'],
    ]));
    const out = renderMowerMapSvg(SN);
    expect(out).toContain('class="mower"');
    expect(out).toContain('class="mower-arrow"');
  });

  it('omits the mower marker when no pose cached', () => {
    const out = renderMowerMapSvg(SN);
    expect(out).not.toContain('class="mower"');
  });

  it('renders the recent trail as a polyline when ≥ 2 points', () => {
    vi.mocked(getLocalTrail).mockReturnValue([
      { x: 0, y: 0, ts: 0 },
      { x: 1, y: 0, ts: 0 },
      { x: 1, y: 1, ts: 0 },
    ]);
    const out = renderMowerMapSvg(SN);
    expect(out).toContain('class="trail"');
  });

  it('renders missed_points as orange circle markers', () => {
    deviceCache.set(SN, new Map([
      ['missed_points', '1 2;3 -4'],
    ]));
    const out = renderMowerMapSvg(SN);
    const markers = [...out.matchAll(/<circle class="missed-point" /g)];
    expect(out).toContain('.missed-point { fill: #f97316;');
    expect(out).toContain('fill-opacity: 0.4;');
    expect(out).toContain('stroke: none;');
    expect(markers).toHaveLength(2);
    expect(out).toContain('r="2.5"');
  });

  it('ignores malformed missed_points entries and keeps valid points in bounds', () => {
    deviceCache.set(SN, new Map([
      ['missed_points', 'bad;10 0; ;1 nope;2'],
    ]));
    const out = renderMowerMapSvg(SN);
    const matches = [...out.matchAll(/<circle class="missed-point" cx="([\d.]+)" cy="([\d.]+)"/g)];
    expect(matches).toHaveLength(1);
    const cx = Number(matches[0][1]);
    const cy = Number(matches[0][2]);
    expect(cx).toBeGreaterThan(500);
    expect(cx).toBeLessThanOrEqual(600);
    expect(cy).toBeGreaterThanOrEqual(0);
    expect(cy).toBeLessThanOrEqual(600);
    expect(out).toContain('No work map yet');
  });

  it('projects missed_points through the same local SVG transform as the trail', () => {
    vi.mocked(getLocalTrail).mockReturnValue([
      { x: 0, y: 0, ts: 0 },
      { x: 1, y: 2, ts: 0 },
    ]);
    deviceCache.set(SN, new Map([
      ['missed_points', '1 2'],
    ]));
    const out = renderMowerMapSvg(SN);
    const trail = out.match(/<polyline class="trail" points="([^"]+)"/);
    const marker = out.match(/<circle class="missed-point" cx="([\d.]+)" cy="([\d.]+)"/);
    expect(trail && marker).toBeTruthy();
    const trailLast = trail![1].trim().split(' ').at(-1);
    expect(trailLast).toBe(`${marker![1]},${marker![2]}`);
  });

  it('shows progress badge when cov_ratio is cached', () => {
    deviceCache.set(SN, new Map([
      ['cov_ratio', '0.42'],
      ['cov_area', '12.5'],
    ]));
    const out = renderMowerMapSvg(SN);
    expect(out).toContain('42%');
    expect(out).toContain('12.5 m²');
  });

  it('keeps the status text inside its badge, whatever its length (#131)', () => {
    deviceCache.set(SN, new Map([['work_status', '0'], ['battery_capacity', '100']]));
    const out = renderMowerMapSvg(SN);
    const rect = out.match(/<rect x="([\d.]+)" y="10"\s+width="([\d.]+)"/);
    const text = out.match(/<text class="badge" x="([\d.]+)" y="25"\s+text-anchor="end">([^<]+)</);
    expect(rect && text).toBeTruthy();
    const left = Number(rect![1]);
    const right = left + Number(rect![2]);
    const textRight = Number(text![1]);
    // end-anchored text: its right edge must sit just inside the rect
    expect(textRight).toBeLessThan(right);
    expect(textRight).toBeGreaterThan(right - 12);
    // and the rect must be wide enough for it (13px/600 is at most ~7.5px per char)
    expect(right - left).toBeGreaterThanOrEqual(text![2].length * 7.5);
  });

  it('handles a totally empty mower (no maps, no pose, no trail)', () => {
    const out = renderMowerMapSvg(SN);
    expect(out).toContain('<svg ');
    expect(out).toContain('class="charger-base"');     // charger always drawn
  });
});
