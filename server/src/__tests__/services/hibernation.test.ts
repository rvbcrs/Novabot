/**
 * Winter sleep: no schedule starts while it is on, the schedules keep their
 * own state, and a wake date ends it by itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../services/mowerFileCapability.js', () => ({
  getMowerFileCapability: () => ({ mowerFileApplySupported: true, isOpenNova: true, mowerVersion: 'v6.0.2-custom-test', reason: null }),
  supportsMowerFileWrites: () => true, isOpenNovaMower: () => true,
  UNSUPPORTED_FIRMWARE_REASON: 'unsupported_firmware', UNSUPPORTED_FIRMWARE_MSG_KEY: 'requiresOpenNovaFirmware',
}));
vi.mock('../../mqtt/broker.js', () => ({ isDeviceOnline: vi.fn(() => true) }));
vi.mock('../../mqtt/mapSync.js', () => ({ publishToDevice: vi.fn(), publishToTopic: vi.fn() }));
vi.mock('../../dashboard/socketHandler.js', () => ({ emitScheduleEvent: vi.fn(), pushMqttLog: vi.fn() }));

import { startScheduleRunner, stopScheduleRunner, renderScheduleReason } from '../../services/scheduleRunner.js';
import { getHibernation, setHibernation, isHibernating, onHibernationChange } from '../../services/hibernation.js';
import { scheduleRepo } from '../../db/repositories/index.js';
import { publishToDevice } from '../../mqtt/mapSync.js';
import { db } from '../../db/database.js';

const NOW = new Date('2026-11-12T13:00:30');
const SN = 'LFIN1231000211';

describe('winter sleep', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM dashboard_schedules').run();
    db.prepare('DELETE FROM device_settings').run();
    vi.mocked(publishToDevice).mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => { stopScheduleRunner(); vi.useRealTimers(); });

  it('starts no schedule and says why, while the schedule itself stays enabled', () => {
    setHibernation(SN, true, null);
    scheduleRepo.create({ schedule_id: 's1', mower_sn: SN, start_time: '13:00', weekdays: JSON.stringify([NOW.getDay()]), enabled: 1, rain_pause: 0 });
    startScheduleRunner();
    const row = scheduleRepo.findById('s1')!;
    expect(row.last_result).toBe('skipped');
    expect(renderScheduleReason('en', row.last_result_reason)).toBe('winter sleep');
    expect(row.enabled).toBe(1);
    expect(publishToDevice).not.toHaveBeenCalled();
  });

  it('ends by itself on the wake date, and tells the listeners', () => {
    const seen: boolean[] = [];
    onHibernationChange((_sn, s) => seen.push(s.enabled));
    setHibernation(SN, true, '2026-11-13');
    expect(isHibernating(SN, new Date('2026-11-12T23:59:00'))).toBe(true);
    expect(isHibernating(SN, new Date('2026-11-13T00:00:01'))).toBe(false);
    expect(getHibernation(SN)).toEqual({ enabled: false, until: null });
    expect(seen).toEqual([true, false]);
  });

  it('a wake date only counts while it is on, and must be a date', () => {
    expect(setHibernation(SN, false, '2027-03-01')).toEqual({ enabled: false, until: null });
    expect(() => setHibernation(SN, true, 'spring')).toThrow();
  });
});

describe('Home Assistant winter-sleep switch', () => {
  beforeEach(() => { db.prepare('DELETE FROM device_settings').run(); });

  it('ON and OFF on novabot/<SN>/set/hibernate switch it; a wake date survives ON', async () => {
    const { handleHibernateCommand } = await import('../../mqtt/homeassistant.js');
    setHibernation(SN, true, '2027-03-01');
    expect(handleHibernateCommand(`novabot/${SN}/set/hibernate`, 'OFF')).toBe(true);
    expect(isHibernating(SN)).toBe(false);
    setHibernation(SN, true, '2027-03-01');
    handleHibernateCommand(`novabot/${SN}/set/hibernate`, 'ON');
    expect(getHibernation(SN)).toEqual({ enabled: true, until: '2027-03-01' });
    expect(handleHibernateCommand(`novabot/${SN}/set/dock`, 'ON')).toBe(false);
  });
});
