import { describe, it, expect, vi } from 'vitest';
import { db } from '../../db/database.js';

vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(false),
  writeRawPublish: vi.fn(),
  getBrokerDiagnostics: vi.fn().mockReturnValue({}),
  startMqttBroker: vi.fn(),
  banishSn: vi.fn(),
  forceDisconnectDevice: vi.fn(),
  lookupMac: vi.fn(),
}));

import { signalHistoryRepo } from '../../db/repositories/signalHistory.js';
import { updateDeviceData, consumeWifiRssiRefreshRequest } from '../../mqtt/sensorData.js';

describe('signal_history positioned samples', () => {
  it('has local and GPS position columns for map overlays', () => {
    const cols = db.prepare('PRAGMA table_info(signal_history)').all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toEqual(expect.arrayContaining([
      'map_x',
      'map_y',
      'latitude',
      'longitude',
    ]));
  });

  it('samples explicit WiFi RSSI responses with local map position and normalized RSSI', () => {
    const sn = 'LFIN_HEATMAP_SAMPLE';
    updateDeviceData(sn, Buffer.from(JSON.stringify({
      report_state_timer_data: {
        battery_power: 88,
        loc_quality: 100,
        localization: {
          gps_position: { latitude: 52.1234567, longitude: 6.1234567 },
          map_position: { x: 1.25, y: -2.5, orientation: 0.3 },
          localization_state: 'LOC_SUCCESS',
        },
      },
    })));

    updateDeviceData(sn, Buffer.from(JSON.stringify({
      type: 'get_wifi_rssi_respond',
      message: { result: 0, value: { rssi: 52 } },
    })));

    const row = db.prepare(`
      SELECT wifi_rssi, map_x, map_y, latitude, longitude
      FROM signal_history
      WHERE sn = ? AND wifi_rssi IS NOT NULL AND map_x IS NOT NULL AND map_y IS NOT NULL
    `).get(sn) as {
      wifi_rssi: number;
      map_x: number;
      map_y: number;
      latitude: number;
      longitude: number;
    } | undefined;

    expect(row).toBeDefined();
    expect(row!.wifi_rssi).toBe(52);
    expect(row!.map_x).toBeCloseTo(1.25);
    expect(row!.map_y).toBeCloseTo(-2.5);
    expect(row!.latitude).toBeCloseTo(52.1234567);
    expect(row!.longitude).toBeCloseTo(6.1234567);
  });

  it('pairs close explicit WiFi and local-position frames for heatmap samples', () => {
    vi.useFakeTimers();
    try {
      const sn = 'LFIN_HEATMAP_CLOSE_FRAMES';
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      updateDeviceData(sn, Buffer.from(JSON.stringify({
        report_state_timer_data: {
          battery_capacity: 87,
          localization: {
            gps_position: { latitude: 52.1234567, longitude: 6.1234567 },
            map_position: { x: 3.5, y: -1.75, orientation: 0.1 },
          },
        },
      })));

      vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
      updateDeviceData(sn, Buffer.from(JSON.stringify({
        get_wifi_rssi_respond: { result: 0, value: { rssi: -54 } },
      })));

      const positioned = db.prepare(`
        SELECT wifi_rssi, map_x, map_y
        FROM signal_history
        WHERE sn = ? AND map_x IS NOT NULL AND map_y IS NOT NULL
      `).get(sn) as { wifi_rssi: number; map_x: number; map_y: number } | undefined;

      expect(positioned).toBeDefined();
      expect(positioned!.wifi_rssi).toBe(-54);
      expect(positioned!.map_x).toBeCloseTo(3.5);
      expect(positioned!.map_y).toBeCloseTo(-1.75);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not use report_exception_state WiFi for heatmap samples', () => {
    vi.useFakeTimers();
    try {
      const sn = 'LFIN_HEATMAP_CACHED_HEARTBEAT_WIFI';
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      updateDeviceData(sn, Buffer.from(JSON.stringify({
        report_exception_state: { wifi_rssi: 54, rtk_sat: 29 },
      })));

      vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
      updateDeviceData(sn, Buffer.from(JSON.stringify({
        report_state_timer_data: {
          battery_capacity: 87,
          localization: {
            gps_position: { latitude: 52.1234567, longitude: 6.1234567 },
            map_position: { x: 3.5, y: -1.75, orientation: 0.1 },
          },
        },
      })));

      const positionedCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM signal_history
        WHERE sn = ? AND wifi_rssi IS NOT NULL AND map_x IS NOT NULL AND map_y IS NOT NULL
      `).get(sn) as { count: number };

      expect(positionedCount.count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not attach stale cached WiFi to later position-only samples', () => {
    vi.useFakeTimers();
    try {
      const sn = 'LFIN_HEATMAP_STALE_WIFI';
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      updateDeviceData(sn, Buffer.from(JSON.stringify({
        report_exception_state: { wifi_rssi: 54, rtk_sat: 29 },
      })));

      vi.setSystemTime(new Date('2026-01-01T00:00:31.000Z'));
      updateDeviceData(sn, Buffer.from(JSON.stringify({
        report_state_timer_data: {
          battery_capacity: 86,
          localization: {
            gps_position: { latitude: 52.1234567, longitude: 6.1234567 },
            map_position: { x: 7.0, y: 2.5, orientation: 0.1 },
          },
        },
      })));

      const positionedCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM signal_history
        WHERE sn = ? AND wifi_rssi IS NOT NULL AND map_x IS NOT NULL AND map_y IS NOT NULL
      `).get(sn) as { count: number };

      expect(positionedCount.count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests a WiFi RSSI refresh when positioned mower samples arrive', () => {
    vi.useFakeTimers();
    try {
      const sn = 'LFIN_HEATMAP_REFRESH_REQUEST';
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      updateDeviceData(sn, Buffer.from(JSON.stringify({
        report_state_timer_data: {
          battery_capacity: 86,
          localization: {
            map_position: { x: 1, y: 2, orientation: 0 },
          },
        },
      })));

      expect(consumeWifiRssiRefreshRequest(sn)).toBe(true);
      expect(consumeWifiRssiRefreshRequest(sn)).toBe(false);

      vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
      updateDeviceData(sn, Buffer.from(JSON.stringify({
        report_state_timer_data: {
          battery_capacity: 85,
          localization: {
            map_position: { x: 1.1, y: 2.1, orientation: 0 },
          },
        },
      })));

      expect(consumeWifiRssiRefreshRequest(sn)).toBe(false);

      vi.setSystemTime(new Date('2026-01-01T00:00:31.000Z'));
      updateDeviceData(sn, Buffer.from(JSON.stringify({
        report_state_timer_data: {
          battery_capacity: 84,
          localization: {
            map_position: { x: 1.2, y: 2.2, orientation: 0 },
          },
        },
      })));

      expect(consumeWifiRssiRefreshRequest(sn)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns only positioned WiFi samples for heatmap rendering', () => {
    const sn = 'LFIN_HEATMAP_REPO';
    db.prepare(`
      INSERT INTO signal_history (sn, wifi_rssi, battery, map_x, map_y, latitude, longitude, ts)
      VALUES
        (?, -51, 80, 1.2, -0.4, 52.1, 6.1, datetime('now', '-10 minutes')),
        (?, -65, 75, NULL, NULL, 52.2, 6.2, datetime('now', '-9 minutes')),
        (?, NULL, 70, 2.0, 3.0, 52.3, 6.3, datetime('now', '-8 minutes')),
        (?, -72, 60, 4.5, 1.5, 52.4, 6.4, datetime('now', '-7 minutes'))
    `).run(sn, sn, sn, sn);

    const rows = signalHistoryRepo.findWifiHeatmapBySnWithinHours(sn, 1);

    expect(rows).toEqual([
      expect.objectContaining({ wifi_rssi: -51, map_x: 1.2, map_y: -0.4 }),
      expect.objectContaining({ wifi_rssi: -72, map_x: 4.5, map_y: 1.5 }),
    ]);
  });
});
