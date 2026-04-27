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

  it('shows progress badge when cov_ratio is cached', () => {
    deviceCache.set(SN, new Map([
      ['cov_ratio', '0.42'],
      ['cov_area', '12.5'],
    ]));
    const out = renderMowerMapSvg(SN);
    expect(out).toContain('42%');
    expect(out).toContain('12.5 m²');
  });

  it('handles a totally empty mower (no maps, no pose, no trail)', () => {
    const out = renderMowerMapSvg(SN);
    expect(out).toContain('<svg ');
    expect(out).toContain('class="charger-base"');     // charger always drawn
  });
});
