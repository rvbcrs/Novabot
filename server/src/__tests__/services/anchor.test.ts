import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/repositories/maps.js', () => ({
  mapRepo: {
    findAllByMowerSnAndType: vi.fn().mockReturnValue([]),
    getPolygonChargingOrientation: vi.fn().mockReturnValue(null),
  },
}));

import {
  getPolygonAnchor,
  isLocalizationHealthy,
  resolveOrientation,
  resolveSavedOrientation,
} from '../../services/anchor.js';
import { mapRepo } from '../../db/repositories/maps.js';

const SN = 'LFIN1231000211';

function unicomRow(canonical: string, points: Array<{ x: number; y: number }>) {
  return {
    id: 1,
    map_id: canonical,
    mower_sn: SN,
    map_name: canonical,
    map_type: 'unicom',
    map_area: JSON.stringify(points),
    map_max_min: null,
    file_name: null,
    file_size: null,
    canonical_name: canonical,
    created_at: '',
    updated_at: '',
  };
}

beforeEach(() => {
  vi.mocked(mapRepo.findAllByMowerSnAndType).mockReset().mockReturnValue([]);
  vi.mocked(mapRepo.getPolygonChargingOrientation).mockReset().mockReturnValue(null);
});

describe('getPolygonAnchor', () => {
  it('returns null when no unicom map exists', () => {
    expect(getPolygonAnchor(SN)).toBeNull();
  });

  it('returns first point of mapNtocharge_unicom + default orientation', () => {
    vi.mocked(mapRepo.findAllByMowerSnAndType).mockReturnValue([
      unicomRow('map0tocharge_unicom', [
        { x: -1.21, y: 0.48 },
        { x: -1.2, y: 0.45 },
      ]),
    ]);
    const a = getPolygonAnchor(SN);
    expect(a).not.toBeNull();
    expect(a!.x).toBeCloseTo(-1.21);
    expect(a!.y).toBeCloseTo(0.48);
    expect(a!.orientation).toBeCloseTo(1.5);
    expect(a!.orientationSource).toBe('default');
  });

  it('never anchors on a map-to-map unicom (#119: deleted dock channel shifted the map)', () => {
    vi.mocked(mapRepo.findAllByMowerSnAndType).mockReturnValue([
      unicomRow('map0tomap1_0_unicom', [{ x: 99, y: 99 }]),
    ]);
    expect(getPolygonAnchor(SN)).toBeNull();
  });

  it('prefers tocharge_unicom over map-to-map unicom', () => {
    vi.mocked(mapRepo.findAllByMowerSnAndType).mockReturnValue([
      unicomRow('map0tomap1_0_unicom', [{ x: 99, y: 99 }]),
      unicomRow('map0tocharge_unicom', [{ x: -1.21, y: 0.48 }]),
    ]);
    const a = getPolygonAnchor(SN);
    expect(a!.x).toBeCloseTo(-1.21);
    expect(a!.y).toBeCloseTo(0.48);
  });

  it('uses sensor map_position_orientation when localization is healthy', () => {
    vi.mocked(mapRepo.findAllByMowerSnAndType).mockReturnValue([
      unicomRow('map0tocharge_unicom', [{ x: -1.21, y: 0.48 }]),
    ]);
    const sensors = new Map<string, string>();
    sensors.set('localization_state', 'RUNNING');
    sensors.set('map_position_orientation', '1.586');

    const a = getPolygonAnchor(SN, sensors);
    expect(a!.orientation).toBeCloseTo(1.586);
    expect(a!.orientationSource).toBe('sensor');
  });

  it('falls back to default orientation when localization is Not initialized', () => {
    vi.mocked(mapRepo.findAllByMowerSnAndType).mockReturnValue([
      unicomRow('map0tocharge_unicom', [{ x: -1.21, y: 0.48 }]),
    ]);
    const sensors = new Map<string, string>();
    sensors.set('localization_state', 'Not initialized');
    sensors.set('map_position_orientation', '0');

    const a = getPolygonAnchor(SN, sensors);
    expect(a!.orientation).toBeCloseTo(1.5);
    expect(a!.orientationSource).toBe('default');
  });

  it.each([
    ['Initializing'],
    ['LOST'],
    ['failed'],
    ['error'],
    [''],
  ])('rejects bad localization_state %s and uses default', (state) => {
    vi.mocked(mapRepo.findAllByMowerSnAndType).mockReturnValue([
      unicomRow('map0tocharge_unicom', [{ x: -1.21, y: 0.48 }]),
    ]);
    const sensors = new Map<string, string>();
    sensors.set('localization_state', state);
    sensors.set('map_position_orientation', '2.5');

    const a = getPolygonAnchor(SN, sensors);
    expect(a!.orientationSource).toBe('default');
  });

  it('returns null when unicom CSV has no points', () => {
    vi.mocked(mapRepo.findAllByMowerSnAndType).mockReturnValue([
      unicomRow('map0tocharge_unicom', []),
    ]);
    expect(getPolygonAnchor(SN)).toBeNull();
  });

  it('returns null when map_area JSON is malformed', () => {
    vi.mocked(mapRepo.findAllByMowerSnAndType).mockReturnValue([
      {
        id: 1,
        map_id: 'map0tocharge_unicom',
        mower_sn: SN,
        map_name: 'map0tocharge_unicom',
        map_type: 'unicom',
        map_area: 'not-json{',
        map_max_min: null,
        file_name: null,
        file_size: null,
        canonical_name: 'map0tocharge_unicom',
        created_at: '',
        updated_at: '',
      },
    ]);
    expect(getPolygonAnchor(SN)).toBeNull();
  });

  it('returns null when first point has non-finite coords', () => {
    vi.mocked(mapRepo.findAllByMowerSnAndType).mockReturnValue([
      unicomRow('map0tocharge_unicom', [{ x: NaN, y: 0 }]),
    ]);
    expect(getPolygonAnchor(SN)).toBeNull();
  });
});

describe('isLocalizationHealthy', () => {
  it('rejects null/undefined/empty', () => {
    expect(isLocalizationHealthy(null)).toBe(false);
    expect(isLocalizationHealthy(undefined)).toBe(false);
    expect(isLocalizationHealthy('')).toBe(false);
  });

  it.each(['NOT_INITIALIZED', 'not_initialized', 'Not initialized', 'INITIALIZING', 'LOST', 'failed', 'error'])(
    'rejects %s',
    (state) => {
      expect(isLocalizationHealthy(state)).toBe(false);
    },
  );

  it.each(['INITIALIZED', 'RUNNING', 'OK', 'unknown_label'])('accepts %s', (state) => {
    expect(isLocalizationHealthy(state)).toBe(true);
  });
});

describe('resolveOrientation', () => {
  it('returns default when sensors null', () => {
    expect(resolveOrientation(null)).toEqual({ orientation: 1.5, source: 'default' });
    expect(resolveOrientation(undefined)).toEqual({ orientation: 1.5, source: 'default' });
  });

  it('returns sensor value when healthy + finite', () => {
    const s = new Map([
      ['localization_state', 'RUNNING'],
      ['map_position_orientation', '0.42'],
    ]);
    expect(resolveOrientation(s)).toEqual({ orientation: 0.42, source: 'sensor' });
  });

  it('returns default when value not finite', () => {
    const s = new Map([
      ['localization_state', 'RUNNING'],
      ['map_position_orientation', 'not-a-number'],
    ]);
    expect(resolveOrientation(s)).toEqual({ orientation: 1.5, source: 'default' });
  });
});

describe('resolveSavedOrientation (DB-first, then live)', () => {
  it('returns saved DB value when present (overrides live IMU)', () => {
    vi.mocked(mapRepo.getPolygonChargingOrientation).mockReturnValue(1.498);
    const sensors = new Map([
      ['localization_state', 'RUNNING'],
      ['map_position_orientation', '1.97'],
    ]);
    expect(resolveSavedOrientation(SN, sensors)).toEqual({
      orientation: 1.498,
      source: 'saved',
    });
  });

  it('falls back to live sensor when DB is null and localization healthy', () => {
    vi.mocked(mapRepo.getPolygonChargingOrientation).mockReturnValue(null);
    const sensors = new Map([
      ['localization_state', 'RUNNING'],
      ['map_position_orientation', '1.97'],
    ]);
    expect(resolveSavedOrientation(SN, sensors)).toEqual({
      orientation: 1.97,
      source: 'sensor',
    });
  });

  it('falls back to default when DB null + localization unhealthy', () => {
    vi.mocked(mapRepo.getPolygonChargingOrientation).mockReturnValue(null);
    const sensors = new Map([
      ['localization_state', 'NOT_INITIALIZED'],
      ['map_position_orientation', '0'],
    ]);
    expect(resolveSavedOrientation(SN, sensors)).toEqual({
      orientation: 1.5,
      source: 'default',
    });
  });

  it('rejects non-finite saved value (treats as null)', () => {
    vi.mocked(mapRepo.getPolygonChargingOrientation).mockReturnValue(NaN);
    expect(resolveSavedOrientation(SN, null).source).not.toBe('saved');
  });
});

describe('getPolygonAnchor with saved theta', () => {
  it('uses DB-saved orientation regardless of sensor reading', () => {
    vi.mocked(mapRepo.findAllByMowerSnAndType).mockReturnValue([
      unicomRow('map0tocharge_unicom', [{ x: -1.21, y: 0.48 }]),
    ]);
    vi.mocked(mapRepo.getPolygonChargingOrientation).mockReturnValue(1.4979550142618929);

    const sensors = new Map([
      ['localization_state', 'RUNNING'],
      ['map_position_orientation', '1.9796'],
    ]);

    const a = getPolygonAnchor(SN, sensors);
    expect(a!.orientation).toBeCloseTo(1.4979550142618929);
    expect(a!.orientationSource).toBe('saved');
  });
});
