/**
 * DemoContext — global demo mode toggle.
 * When active, injects a fake mower + charger into device state
 * and provides fake data for schedules, history, and alerts.
 */
import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import type { DeviceState, MowerActivity } from '../types';
import type { Schedule, WorkRecord } from '../services/api';

interface DemoState {
  enabled: boolean;
  toggle: () => void;
  activity: MowerActivity;
  cycleActivity: () => void;
  demoDevices: Map<string, DeviceState>;
  demoSchedules: Schedule[];
  demoHistory: WorkRecord[];
}

const DEMO_SN = 'LFIN0000DEMO';
const DEMO_CHARGER_SN = 'LFIC0000DEMO';

const ACTIVITIES: MowerActivity[] = [
  'idle', 'mowing', 'charging', 'returning', 'paused', 'mapping', 'error',
];

function makeDemoDevices(activity: MowerActivity): Map<string, DeviceState> {
  const map = new Map<string, DeviceState>();

  const battery = activity === 'charging' ? '42' : activity === 'mowing' ? '78' : '95';
  const workStatus = activity === 'mowing' ? '1' : activity === 'charging' ? '2'
    : activity === 'returning' ? '3' : activity === 'paused' ? '4' : '0';

  map.set(DEMO_SN, {
    sn: DEMO_SN,
    deviceType: 'mower',
    online: activity !== 'idle' || true, // always online in demo
    sensors: {
      battery_power: battery,
      battery_state: activity === 'charging' ? 'CHARGING' : 'IDLE',
      work_status: workStatus,
      error_status: activity === 'error' ? '151' : '0',
      error_code: activity === 'error' ? '151' : '0',
      error_msg: activity === 'error' ? 'Obstacle detected — mower stuck' : '',
      wifi_rssi: '-52',
      rtk_sat: '14',
      sw_version: '6.0.2',
      mower_version: '6.0.2',
      latitude: '52.0907',
      longitude: '5.1214',
      heading: '45',
      loc_quality: '100',
      start_edit_or_assistant_map_flag: activity === 'mapping' ? '1' : '0',
      headlight: '0',
    },
    lastUpdate: Date.now(),
  });

  map.set(DEMO_CHARGER_SN, {
    sn: DEMO_CHARGER_SN,
    deviceType: 'charger',
    online: true,
    sensors: {
      charger_version: '0.4.0',
      charger_status: '1',
      latitude: '52.0907',
      longitude: '5.1214',
    },
    lastUpdate: Date.now(),
  });

  return map;
}

const DEMO_SCHEDULES: Schedule[] = [
  { id: 901, sn: DEMO_SN, day_of_week: 1, start_hour: 9, start_minute: 0, duration_minutes: 90, enabled: true, cuttingHeight: 40, pathDirection: 0, created_at: '2026-03-28' },
  { id: 902, sn: DEMO_SN, day_of_week: 3, start_hour: 10, start_minute: 30, duration_minutes: 60, enabled: true, cuttingHeight: 50, pathDirection: 90, created_at: '2026-03-28' },
  { id: 903, sn: DEMO_SN, day_of_week: 5, start_hour: 8, start_minute: 0, duration_minutes: 120, enabled: true, cuttingHeight: 30, pathDirection: 45, created_at: '2026-03-28' },
  { id: 904, sn: DEMO_SN, day_of_week: 0, start_hour: 14, start_minute: 0, duration_minutes: 45, enabled: false, cuttingHeight: 40, pathDirection: 180, created_at: '2026-03-28' },
];

const DEMO_HISTORY: WorkRecord[] = [
  { id: 801, sn: DEMO_SN, start_time: new Date(Date.now() - 3600000 * 2).toISOString(), end_time: new Date(Date.now() - 3600000).toISOString(), duration_seconds: 3420, area_m2: 245, status: 'completed', map_name: 'Front Yard' },
  { id: 802, sn: DEMO_SN, start_time: new Date(Date.now() - 86400000).toISOString(), end_time: new Date(Date.now() - 86400000 + 5400000).toISOString(), duration_seconds: 5280, area_m2: 380, status: 'completed', map_name: 'Back Garden' },
  { id: 803, sn: DEMO_SN, start_time: new Date(Date.now() - 86400000 * 2).toISOString(), end_time: new Date(Date.now() - 86400000 * 2 + 1800000).toISOString(), duration_seconds: 1740, area_m2: 120, status: 'interrupted', map_name: 'Front Yard' },
  { id: 804, sn: DEMO_SN, start_time: new Date(Date.now() - 86400000 * 4).toISOString(), end_time: new Date(Date.now() - 86400000 * 4 + 7200000).toISOString(), duration_seconds: 7080, area_m2: 510, status: 'completed', map_name: 'Full Property' },
];

const DemoContext = createContext<DemoState>({
  enabled: false,
  toggle: () => {},
  activity: 'mowing',
  cycleActivity: () => {},
  demoDevices: new Map(),
  demoSchedules: [],
  demoHistory: [],
});

export function DemoProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  const [actIdx, setActIdx] = useState(1); // start at 'mowing'

  const toggle = useCallback(() => setEnabled((v) => !v), []);
  const cycleActivity = useCallback(() => setActIdx((i) => (i + 1) % ACTIVITIES.length), []);

  const activity = ACTIVITIES[actIdx];
  const demoDevices = useMemo(() => makeDemoDevices(activity), [activity]);

  const value = useMemo<DemoState>(() => ({
    enabled,
    toggle,
    activity,
    cycleActivity,
    demoDevices,
    demoSchedules: DEMO_SCHEDULES,
    demoHistory: DEMO_HISTORY,
  }), [enabled, toggle, activity, cycleActivity, demoDevices]);

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemo(): DemoState {
  return useContext(DemoContext);
}

export { DEMO_SN };
