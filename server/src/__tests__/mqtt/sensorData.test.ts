import { describe, it, expect, vi } from 'vitest';

// Break the broker chain that fires when sensorData.ts is imported.
vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(false),
  writeRawPublish: vi.fn(),
  getBrokerDiagnostics: vi.fn().mockReturnValue({}),
  startMqttBroker: vi.fn(),
  banishSn: vi.fn(),
  forceDisconnectDevice: vi.fn(),
  lookupMac: vi.fn(),
}));

import { SENSORS, translateValue, updateDeviceData, deviceCache } from '../../mqtt/sensorData.js';
import {
  markFrameUnvalidated, clearFrameUnvalidated, isFrameUnvalidated, noteAutoRecharge,
  markMapInstallPending, clearMapInstallPending,
} from '../../services/frameValidation.js';
import { scheduleRepo } from '../../db/repositories/schedules.js';

describe('translateValue rtk_fix_quality', () => {
  it('maps GGA quality codes to labels', () => {
    expect(translateValue('rtk_fix_quality', '4')).toBe('RTK Fixed');
    expect(translateValue('rtk_fix_quality', '5')).toBe('RTK Float');
    expect(translateValue('rtk_fix_quality', '2')).toBe('DGPS');
    expect(translateValue('rtk_fix_quality', '1')).toBe('GPS');
    expect(translateValue('rtk_fix_quality', '0')).toBe('No fix');
  });
  it('passes through unknown codes unchanged', () => {
    expect(translateValue('rtk_fix_quality', '7')).toBe('7');
  });
});

describe('translateValue mower_status (charger LoRa relay uint32)', () => {
  it('decodes the work_status byte (bits 16-23) from the packed uint32 LE', () => {
    // 0x00090001 → work_status byte = 0x09 = Finished
    expect(translateValue('mower_status', '589825')).toBe('Finished');
    // work_status = 90 (0x5a) → Mowing:  90<<16 = 0x005a0000 = 5898240
    expect(translateValue('mower_status', String(90 << 16))).toBe('Mowing');
    // work_status = 50 → Return to charger
    expect(translateValue('mower_status', String(50 << 16))).toBe('Return to charger');
  });
  it('falls back to derived_mode (byte 0) when work_status is unmapped', () => {
    // work_status 0 (Wait is mapped) — use an unmapped work_status (200) with derived_mode=2 (Mowing)
    expect(translateValue('mower_status', String((200 << 16) | 2))).toBe('Mowing');
  });
  it('keeps the legacy string status map and passes through truly unknown values', () => {
    expect(translateValue('mower_status', 'startMowing')).toBe('Mowing');
    expect(translateValue('mower_status', 'totally-unknown')).toBe('totally-unknown');
  });
});

describe('updateDeviceData null/non-object payloads (crash guard)', () => {
  // JSON.parse accepts these WITHOUT throwing — `parsed` becomes null or a
  // non-object, and Object.keys(null) used to crash the broker handler. Must
  // return null and never throw for any of them.
  it.each([
    ['literal null', 'null'],
    ['bare number', '123'],
    ['bare bool', 'true'],
    ['bare string', '"hello"'],
    ['empty buffer', ''],
    ['garbage', 'not json'],
  ])('returns null without throwing for %s', (_label, raw) => {
    expect(() => updateDeviceData('LFIN9999000002', Buffer.from(raw))).not.toThrow();
    expect(updateDeviceData('LFIN9999000002', Buffer.from(raw))).toBeNull();
  });
});

describe('frame_unvalidated lifecycle in updateDeviceData', () => {
  const docked = (sn: string) =>
    updateDeviceData(sn, Buffer.from(JSON.stringify({ report_state_robot: { recharge_status: 9 } })));
  const undocked = (sn: string) =>
    updateDeviceData(sn, Buffer.from(JSON.stringify({ report_state_robot: { recharge_status: 0 } })));

  it('clears for a mower that reports stock firmware, keeps it for OpenNova', () => {
    const S = 'LFIN_STOCK_FLAG', O = 'LFIN_CUSTOM_FLAG';
    clearFrameUnvalidated(S); clearFrameUnvalidated(O);
    markFrameUnvalidated(S); markFrameUnvalidated(O);
    updateDeviceData(S, Buffer.from(JSON.stringify({ report_state_robot: { sw_version: 'v6.0.2', recharge_status: 9 } })));
    updateDeviceData(O, Buffer.from(JSON.stringify({ report_state_robot: { sw_version: 'v6.0.2-custom-45', recharge_status: 9 } })));
    expect(isFrameUnvalidated(S)).toBe(false);
    expect(isFrameUnvalidated(O)).toBe(true);
  });

  it('does NOT clear while still docked at import time (regression: imported while parked)', () => {
    const SN = 'LFIN_DOCK_A';
    clearFrameUnvalidated(SN);
    markFrameUnvalidated(SN);
    // Mower was already on the dock when the bundle was imported.
    docked(SN);
    docked(SN);
    expect(isFrameUnvalidated(SN)).toBe(true); // must stay locked
  });

  it('does NOT clear on a stray bounce-redock with no auto_recharge', () => {
    const SN = 'LFIN_DOCK_D';
    clearFrameUnvalidated(SN);
    markFrameUnvalidated(SN);
    docked(SN);    // parked
    undocked(SN);  // 1cm bounce off the dock during backward drive
    docked(SN);    // rolled back on - but NO auto_recharge was issued
    expect(isFrameUnvalidated(SN)).toBe(true); // must stay locked
  });

  it('keeps the frame locked after auto_recharge and a passive docked report', () => {
    const SN = 'LFIN_DOCK_C';
    clearFrameUnvalidated(SN);
    markFrameUnvalidated(SN);
    docked(SN);                       // still parked -> stays set
    expect(isFrameUnvalidated(SN)).toBe(true);
    noteAutoRecharge(SN);             // wizard issued the deliberate dock
    expect(isFrameUnvalidated(SN)).toBe(true); // command alone does not clear
    docked(SN);                       // dock report does not verify the map frame
    expect(isFrameUnvalidated(SN)).toBe(true);
  });

  it('surfaces frame_unvalidated as a device field while set (not docked)', () => {
    const SN = 'LFIN_DOCK_B';
    clearFrameUnvalidated(SN);
    markFrameUnvalidated(SN);
    const changes = updateDeviceData(SN, Buffer.from(JSON.stringify({ report_state_robot: { battery_power: 80 } })));
    expect(changes?.get('frame_unvalidated')).toBe('1');
  });

  it('tells an unfinished map install apart from a frame that needs re-anchoring', () => {
    const SN = 'LFIN_INSTALL_FLAG';
    clearFrameUnvalidated(SN); clearMapInstallPending(SN);
    markMapInstallPending(SN);
    const during = updateDeviceData(SN, Buffer.from(JSON.stringify({ report_state_robot: { battery_power: 80 } })));
    expect(during?.get('frame_unvalidated')).toBe('1');   // still blocks start
    expect(during?.get('map_install_pending')).toBe('1');
    clearMapInstallPending(SN);
    const after = updateDeviceData(SN, Buffer.from(JSON.stringify({ report_state_robot: { battery_power: 81 } })));
    expect(after?.get('frame_unvalidated')).toBe('0');
    expect(after?.get('map_install_pending')).toBe('0');
  });
});

// rain_paused only lived in the full snapshot, so a dashboard that loaded during
// a rain pause kept '1' after the pause ended and called the next manual
// go-home a rain return.
describe('rain_paused in updateDeviceData', () => {
  it('pushes the flag as a change when the rain session starts and ends', () => {
    const SN = 'LFIN_RAIN_FLAG';
    const report = (battery: number) =>
      updateDeviceData(SN, Buffer.from(JSON.stringify({ report_state_robot: { battery_power: battery } })));
    scheduleRepo.createRainSession('rain-flag-test', 'manual', SN, null, null, 3, 120, 0, 0, 0, 0.1, 50, 0.5);
    expect(report(80)?.get('rain_paused')).toBe('1');
    scheduleRepo.resumeRainSession('rain-flag-test');
    expect(report(81)?.get('rain_paused')).toBe('0');
  });
});

// SENSORS.find() takes the first match for discovery, so a second entry for
// the same field is silently dead, and once contradicted it: finished_area was
// published as a measurement while its value is a list of sub-area indices,
// which HA refuses (user report 2026-09-19).
describe('sensor definitions', () => {
  it('defines every field once', () => {
    const seen = new Set<string>();
    const dupes = SENSORS.map(s => s.field).filter(f => seen.size === seen.add(f).size);
    expect(dupes).toEqual([]);
  });

  it('does not call the finished sub-area list a measurement', () => {
    expect(SENSORS.find(s => s.field === 'finished_area')?.state_class).toBeUndefined();
  });

  // robot_decision divides the planner's navigation_time and
  // estimate_remaining_time (both seconds) by 60 and logs
  // "cov_work_time(min)"; CovTaskInfo.msg documents the work times as minutes.
  it('reports the coverage times in minutes', () => {
    for (const field of ['cov_work_time', 'valid_cov_work_time', 'cov_estimate_time']) {
      expect(SENSORS.find(s => s.field === field)?.unit).toBe('min');
    }
  });
});

describe('ingestSensorStream (novabot/sensor/<SN> from extended_commands.py)', () => {
  it('forwards the RTK fix quality as its label, like the regular sensor path, and caches the raw code', async () => {
    const { ingestSensorStream, deviceCache } = await import('../../mqtt/sensorData.js');
    const sn = 'LFIN_SENSOR_STREAM';
    const changes = ingestSensorStream(sn, { rtk_fix_quality: 4, rtk_sat: 35 });
    expect(changes.get('rtk_fix_quality')).toBe('RTK Fixed');
    expect(changes.get('rtk_sat')).toBe('35');
    expect(deviceCache.get(sn)?.get('rtk_fix_quality')).toBe('4');
    // unchanged values are not forwarded again
    expect(ingestSensorStream(sn, { rtk_fix_quality: 4 }).size).toBe(0);
  });
});

describe('a cleared error', () => {
  const frame = (o: object) => Buffer.from(JSON.stringify({ report_state_robot: o }));
  it('stays cleared while the mower repeats it, and ends when it reports anything else', () => {
    const sn = 'LFIN9999000077';
    updateDeviceData(sn, frame({ error_status: 130 }));
    deviceCache.get(sn)!.set('error_ack', '130');
    updateDeviceData(sn, frame({ error_status: 130, battery_power: 50 }));
    expect(deviceCache.get(sn)!.get('error_ack')).toBe('130');
    const changes = updateDeviceData(sn, frame({ error_status: 0 }));
    expect(deviceCache.get(sn)!.has('error_ack')).toBe(false);
    expect(changes?.get('error_ack')).toBe('');
  });
});
