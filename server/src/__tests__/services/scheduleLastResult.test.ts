/**
 * Waarom liep de beurt niet? De runner legt zijn laatste beslissing op het
 * schema vast (last_result / last_result_reason), ook als hij er zelf niet
 * bij was: een venster dat voorbij ging zonder beslissing is 'missed'.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../services/mowerFileCapability.js', () => ({
  getMowerFileCapability: () => ({ mowerFileApplySupported: true, isOpenNova: true, mowerVersion: 'v6.0.2-custom-test', reason: null }),
  supportsMowerFileWrites: () => true, isOpenNovaMower: () => true,
  UNSUPPORTED_FIRMWARE_REASON: 'unsupported_firmware', UNSUPPORTED_FIRMWARE_MSG_KEY: 'requiresOpenNovaFirmware',
}));
vi.mock('../../mqtt/broker.js', () => ({ isDeviceOnline: vi.fn(() => false) }));
vi.mock('../../mqtt/mapSync.js', () => ({ publishToDevice: vi.fn(), publishToTopic: vi.fn() }));
vi.mock('../../dashboard/socketHandler.js', () => ({ emitScheduleEvent: vi.fn(), pushMqttLog: vi.fn() }));

import { startScheduleRunner, stopScheduleRunner, normalizeTimezone } from '../../services/scheduleRunner.js';
import { scheduleRepo } from '../../db/repositories/index.js';
import { db } from '../../db/database.js';

const NOW = new Date('2026-08-05T13:00:30');
const SN = 'LFIN1231000211';

function schedule(startTime: string, extra: Record<string, unknown> = {}) {
  scheduleRepo.create({
    schedule_id: `s-${startTime}`, mower_sn: SN, start_time: startTime,
    weekdays: JSON.stringify([NOW.getDay()]), enabled: 1, rain_pause: 0, ...extra,
  });
}

describe('last result on the schedule', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM dashboard_schedules').run();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => { stopScheduleRunner(); vi.useRealTimers(); });

  it('records why a due schedule was skipped (mower offline)', () => {
    schedule('13:00');
    startScheduleRunner();
    const row = scheduleRepo.findById('s-13:00')!;
    expect(row.last_result).toBe('skipped');
    expect(row.last_result_reason).toBe('mower offline');
    expect(row.last_result_at).toBeTruthy();
  });

  it('marks an occurrence the server slept through as missed, once', () => {
    // 11:00 today came and went while the server was down; created yesterday.
    schedule('11:00');
    db.prepare("UPDATE dashboard_schedules SET created_at = '2026-08-01 08:00:00' WHERE schedule_id = ?").run('s-11:00');
    startScheduleRunner();
    const row = scheduleRepo.findById('s-11:00')!;
    expect(row.last_result).toBe('missed');
    expect(row.last_result_reason).toContain('11:00');
    // a schedule created after its own start time today is not "missed"
    schedule('09:00');
    vi.advanceTimersByTime(30_000);
    expect(scheduleRepo.findById('s-09:00')!.last_result).toBeNull();
  });

  it('understands the GMT+2:00 the Novabot app sends', () => {
    expect(normalizeTimezone('GMT+2:00')).toBe('Etc/GMT-2');
    expect(normalizeTimezone('GMT-5')).toBe('Etc/GMT+5');
    expect(normalizeTimezone('GMT+5:30')).toBe('GMT+5:30');
    expect(normalizeTimezone('Europe/Amsterdam')).toBe('Europe/Amsterdam');
  });
});
