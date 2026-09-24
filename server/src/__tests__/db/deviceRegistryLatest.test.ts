import { describe, it, expect } from 'vitest';
import { deviceRepo } from '../../db/repositories/index.js';

describe('deviceRepo.listLatestBySn', () => {
  it('returns one row per serial when two client ids were seen in the same second', () => {
    // last_seen has one-second resolution: the mower's own client and a
    // second connection for the same serial tie on MAX(last_seen).
    deviceRepo.upsertDevice('LFIN9990000077_6688', 'LFIN9990000077', null);
    deviceRepo.upsertDevice('LFIN9990000077_ext', 'LFIN9990000077', null);
    const rows = deviceRepo.listLatestBySn().filter(r => r.sn === 'LFIN9990000077');
    expect(rows).toHaveLength(1);
  });
});
