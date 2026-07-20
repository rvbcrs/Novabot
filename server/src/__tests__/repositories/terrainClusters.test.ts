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

  it('deleteMissingForSn ruimt wezen op, ook met override', () => {
    // Het scenario van 2026-07-20: één reuzencluster wordt opgeknipt in
    // tegels; de oude rij (mét handmatige correctie) moet verdwijnen.
    terrainClusterRepo.upsert({ ...base, mower_sn: 'LFIN0002', cluster_key: 'oud', class_name: 'trampoline', confidence: 0.4, crop_file: null });
    terrainClusterRepo.setOverride('LFIN0002', 'oud', 'trampoline');
    terrainClusterRepo.upsert({ ...base, mower_sn: 'LFIN0002', cluster_key: 'tegel-1', class_name: null, confidence: null, crop_file: null });
    terrainClusterRepo.upsert({ ...base, mower_sn: 'LFIN0002', cluster_key: 'tegel-2', class_name: null, confidence: null, crop_file: null });

    const weg = terrainClusterRepo.deleteMissingForSn('LFIN0002', ['tegel-1', 'tegel-2']);
    expect(weg).toBe(1);
    expect(terrainClusterRepo.findBySn('LFIN0002').map(r => r.cluster_key).sort()).toEqual(['tegel-1', 'tegel-2']);
  });

  it('deleteMissingForSn wist niets bij een lege sleutellijst', () => {
    terrainClusterRepo.upsert({ ...base, mower_sn: 'LFIN0003', cluster_key: 'a', class_name: null, confidence: null, crop_file: null });
    expect(terrainClusterRepo.deleteMissingForSn('LFIN0003', [])).toBe(0);
    expect(terrainClusterRepo.findBySn('LFIN0003')).toHaveLength(1);
  });

  it('deleteMissingForSn raakt andere maaiers niet', () => {
    terrainClusterRepo.upsert({ ...base, mower_sn: 'LFIN0004', cluster_key: 'x', class_name: null, confidence: null, crop_file: null });
    terrainClusterRepo.upsert({ ...base, mower_sn: 'LFIN0005', cluster_key: 'y', class_name: null, confidence: null, crop_file: null });
    terrainClusterRepo.deleteMissingForSn('LFIN0004', ['zzz']);
    expect(terrainClusterRepo.findBySn('LFIN0005')).toHaveLength(1);
  });
});
