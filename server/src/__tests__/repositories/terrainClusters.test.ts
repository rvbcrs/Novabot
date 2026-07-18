import { describe, it, expect } from 'vitest';
import { terrainClusterRepo } from '../../db/repositories/index.js';

describe('terrainClusterRepo', () => {
  const base = { mower_sn: 'LFIN0001', cluster_key: '1,2', cx: 1.2, cy: 3.4, min_x: 1, min_y: 3, max_x: 2, max_y: 4, cells: 40, max_h: 0.6 };
  it('upsert + override-behoud', () => {
    terrainClusterRepo.upsert({ ...base, class_name: 'trampoline', confidence: 0.6, crop_file: 'a.jpg' });
    terrainClusterRepo.setOverride('LFIN0001', '1,2', 'tree');
    terrainClusterRepo.upsert({ ...base, class_name: 'bush/hedge', confidence: 0.7, crop_file: 'b.jpg' });
    const row = terrainClusterRepo.findBySn('LFIN0001')[0];
    expect(row.user_override).toBe('tree');       // override overleeft her-classificatie
    expect(row.crop_file).toBe('b.jpg');           // maar de nieuwste foto wél bijgewerkt
    terrainClusterRepo.setOverride('LFIN0001', '1,2', null);
    expect(terrainClusterRepo.findBySn('LFIN0001')[0].user_override).toBeNull();
  });
});
