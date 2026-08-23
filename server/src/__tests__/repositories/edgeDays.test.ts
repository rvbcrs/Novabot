import { describe, it, expect } from 'vitest';
import { scheduleRepo } from '../../db/repositories/index.js';

describe('ScheduleRepository.edge_days', () => {
  it('default NULL, settable en clearbaar via update', () => {
    scheduleRepo.create({ schedule_id: 'edge-1', mower_sn: 'LFIN0001', start_time: '09:00' });
    expect(scheduleRepo.findById('edge-1')?.edge_days).toBeNull();

    scheduleRepo.update('edge-1', { edge_days: JSON.stringify([5]) });
    expect(scheduleRepo.findById('edge-1')?.edge_days).toBe('[5]');

    scheduleRepo.update('edge-1', { edge_days: null });
    expect(scheduleRepo.findById('edge-1')?.edge_days).toBeNull();
  });

  it('create accepteert edge_days direct', () => {
    scheduleRepo.create({ schedule_id: 'edge-2', mower_sn: 'LFIN0001', start_time: '10:00', edge_days: JSON.stringify([1, 4]) });
    expect(scheduleRepo.findById('edge-2')?.edge_days).toBe('[1,4]');
  });
});
