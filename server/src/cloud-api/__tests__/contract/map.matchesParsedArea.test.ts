/**
 * Regression test — matchesParsedArea (#66).
 *
 * When the mower re-uploads its map after mowing, each parsed area must match
 * the existing DB row for that zone by its STABLE canonical slot (map0/map1/…),
 * NOT by the user alias in map_name. Matching on the alias meant a renamed map
 * ("test") no longer matched its map2 area on re-upload: the alias was reset to
 * the default label and a duplicate row was created while the renamed row was
 * deleted as stale. This test locks the canonical-slot match.
 */
import { describe, it, expect } from 'vitest';
import { matchesParsedArea } from '../../routes/map.js';

const workArea = { mapIndex: 2, type: 'work' as const };

describe('matchesParsedArea — work maps resolve by canonical slot (#66)', () => {
  it('matches a RENAMED map to its area via canonical_name (the bug)', () => {
    const renamed = { map_type: 'work', map_name: 'test', canonical_name: 'map2' };
    expect(matchesParsedArea(renamed, workArea)).toBe(true);
  });

  it('still matches a default-named map (no regression)', () => {
    const dflt = { map_type: 'work', map_name: 'map2', canonical_name: 'map2' };
    expect(matchesParsedArea(dflt, workArea)).toBe(true);
  });

  it('does NOT match a different slot', () => {
    const other = { map_type: 'work', map_name: 'zij', canonical_name: 'map0' };
    expect(matchesParsedArea(other, workArea)).toBe(false);
  });

  it('falls back to map_name for legacy rows without canonical_name', () => {
    const legacy = { map_type: 'work', map_name: 'map2', canonical_name: null };
    expect(matchesParsedArea(legacy, workArea)).toBe(true);
  });

  it('type must also match', () => {
    const obstacleRow = { map_type: 'obstacle', map_name: 'test', canonical_name: 'map2' };
    expect(matchesParsedArea(obstacleRow, workArea)).toBe(false);
  });
});

describe('matchesParsedArea — obstacles and unicoms resolve by canonical slot', () => {
  it('matches a NAMED obstacle to its area via canonical_name', () => {
    const named = { map_type: 'obstacle', map_name: 'motherInLaw', canonical_name: 'map0_3_obstacle' };
    expect(matchesParsedArea(named, { mapIndex: 0, type: 'obstacle', subIndex: 3 })).toBe(true);
  });

  it('matches a NAMED unicom to its area via canonical_name', () => {
    const named = { map_type: 'unicom', map_name: 'Channel 2', canonical_name: 'map0tomap1_0_unicom' };
    expect(matchesParsedArea(named, { mapIndex: 0, type: 'unicom', target: 'map1_0' })).toBe(true);
  });
});
