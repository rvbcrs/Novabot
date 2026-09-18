import { describe, it, expect } from 'vitest';
import { mapRepo } from '../../db/repositories/index.js';

// #120: where a zone came from. The mower uploads every zone back after an
// apply, so a re-upload must not turn a drawn zone into a driven one.
const SN = 'LFIN_SOURCE_120';
const area = JSON.stringify([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }]);

describe('maps.source', () => {
  it('a drawn zone keeps its origin when the mower uploads it back', () => {
    mapRepo.create({ map_id: 's120-a', mower_sn: SN, map_name: 'Front', map_type: 'work', canonical_name: 'map0', map_area: area, source: 'drawn' });
    expect(mapRepo.findById('s120-a')?.source).toBe('drawn');
    // same map_id, as mapSync does
    mapRepo.upsert({ map_id: 's120-a', mower_sn: SN, map_name: 'Front', map_type: 'work', canonical_name: 'map0', map_area: area, source: 'mower' });
    expect(mapRepo.findById('s120-a')?.source).toBe('drawn');
    // a new row from the mower is a driven zone
    mapRepo.upsert({ map_id: 's120-b', mower_sn: SN, map_name: 'Back', map_type: 'work', canonical_name: 'map1', map_area: area, source: 'mower' });
    expect(mapRepo.findById('s120-b')?.source).toBe('mower');
  });

  it('a row from before the column stays unknown, also after a re-upload', () => {
    mapRepo.create({ map_id: 's120-c', mower_sn: SN, map_name: 'Old', map_type: 'work', canonical_name: 'map2', map_area: area });
    expect(mapRepo.findById('s120-c')?.source ?? null).toBeNull();
    mapRepo.upsert({ map_id: 's120-c', mower_sn: SN, map_name: 'Old', map_type: 'work', canonical_name: 'map2', map_area: area, source: 'mower' });
    expect(mapRepo.findById('s120-c')?.source ?? null).toBeNull();
  });
});
