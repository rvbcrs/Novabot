import { describe, it, expect } from 'vitest';
import { terrainGridRepo } from '../../db/repositories/index.js';

describe('terrainGridRepo', () => {
  it('upsert maakt aan en telt sessies op', () => {
    terrainGridRepo.upsertMeta({ mower_sn: 'LFIN2230700238', cell_size: 0.05, cells: 100, sessions_delta: 1 });
    terrainGridRepo.upsertMeta({ mower_sn: 'LFIN2230700238', cell_size: 0.05, cells: 250, sessions_delta: 1 });
    const row = terrainGridRepo.findBySn('LFIN2230700238')!;
    expect(row.sessions).toBe(2);
    expect(row.cells).toBe(250);
    expect(row.cell_size).toBe(0.05);
  });

  it('findBySn onbekend → undefined', () => {
    expect(terrainGridRepo.findBySn('LFIN0000000000')).toBeUndefined();
  });
});
