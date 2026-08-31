/**
 * DemoContext — global demo mode toggle.
 * When active, injects a fake mower + charger into device state
 * and provides fake data for schedules, history, and alerts.
 */
import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react';
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
  'idle', 'mowing', 'charging', 'returning', 'paused', 'mapping', 'error', 'following_unicom',
];

/** Phases of the scripted `mow_zone_status` demo stream — mirrors the
 *  mower-side mow_zone orchestrator (research/documents/
 *  unicom-follow-transit-design.md) so the app's `following_unicom`
 *  activity + UnicomTransitAnimation can be exercised in demo mode without
 *  a real mower. See the timer in DemoProvider below. */
type MowZoneDemoPhase = 'undocking' | 'following_unicom' | 'covering' | 'done';

function makeDemoDevices(activity: MowerActivity, mowZonePhase: MowZoneDemoPhase): Map<string, DeviceState> {
  const map = new Map<string, DeviceState>();

  const battery = activity === 'charging' ? '42' : activity === 'mowing' ? '78' : '95';
  const workStatus = activity === 'mowing' ? '1' : activity === 'charging' ? '2'
    : activity === 'returning' ? '3' : activity === 'paused' ? '4'
    : activity === 'error' ? '1' : activity === 'following_unicom' ? '1' : '0'; // error happens while mowing

  // While cycled onto the `following_unicom` demo slot, drive the sensors
  // through the same undocking -> following_unicom -> covering -> done
  // sequence the real mow_zone orchestrator streams, so deriveMower (in
  // HomeScreen) derives the exact same activity a live mower would.
  const isUnicomDemo = activity === 'following_unicom';
  const unicomMsg = isUnicomDemo
    ? (mowZonePhase === 'undocking' ? 'Mode:COVERAGE Work:QUIT_PILE_INIT'
      : mowZonePhase === 'covering' || mowZonePhase === 'done' ? 'Mode:COVERAGE Work:RUNNING'
      : '')
    : '';
  const unicomProgress = isUnicomDemo
    ? (mowZonePhase === 'covering' ? '35' : mowZonePhase === 'done' ? '55' : '0')
    : '0';

  map.set(DEMO_SN, {
    sn: DEMO_SN,
    deviceType: 'mower',
    online: activity !== 'idle' || true, // always online in demo
    sensors: {
      battery_power: battery,
      battery_state: activity === 'charging' ? 'CHARGING' : 'IDLE',
      work_status: workStatus,
      task_mode: isUnicomDemo ? '1' : '0',
      msg: unicomMsg,
      error_status: activity === 'error' ? '151' : '0',
      error_code: activity === 'error' ? '151' : '0',
      error_msg: activity === 'error' ? 'Obstacle detected — mower stuck' : '',
      mowing_progress: activity === 'mowing' ? '63' : activity === 'mapping' ? '41' : unicomProgress,
      path_direction: '45',
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
      // Scripted mow_zone phase stream (see MowZoneDemoPhase timer below) —
      // mirrors what broker.ts writes from the real extended_response
      // mow_zone_status event.
      ...(isUnicomDemo ? { mow_zone_phase: mowZonePhase, mow_zone_map: 'map3' } : {}),
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
  { id: '901', scheduleId: '901', sn: DEMO_SN, day_of_week: 1, weekdays: [1], start_hour: 9, start_minute: 0, startTime: '09:00', duration_minutes: 90, enabled: true, cuttingHeight: 40, pathDirection: 0, created_at: '2026-03-28' },
  { id: '902', scheduleId: '902', sn: DEMO_SN, day_of_week: 3, weekdays: [3], start_hour: 10, start_minute: 30, startTime: '10:30', duration_minutes: 60, enabled: true, cuttingHeight: 50, pathDirection: 90, created_at: '2026-03-28' },
  { id: '903', scheduleId: '903', sn: DEMO_SN, day_of_week: 5, weekdays: [5], start_hour: 8, start_minute: 0, startTime: '08:00', duration_minutes: 120, enabled: true, cuttingHeight: 30, pathDirection: 45, created_at: '2026-03-28' },
  { id: '904', scheduleId: '904', sn: DEMO_SN, day_of_week: 0, weekdays: [0], start_hour: 14, start_minute: 0, startTime: '14:00', duration_minutes: 45, enabled: false, cuttingHeight: 40, pathDirection: 180, created_at: '2026-03-28' },
];

const isoNow = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const DEMO_HISTORY: WorkRecord[] = [
  { recordId: '801', dateTime: isoNow(-3600000),         workTime: 57, workArea: 245, cutGrassHeight: 1, pathDirection: 90,  mapNames: 'Front Yard',   workStatus: 'finished',                startWay: 'app', workRecordDate: isoNow(-3600000) },
  { recordId: '802', dateTime: isoNow(-86400000),        workTime: 88, workArea: 380, cutGrassHeight: 1, pathDirection: 45,  mapNames: 'Back Garden',  workStatus: 'finished',                startWay: 'app', workRecordDate: isoNow(-86400000) },
  { recordId: '803', dateTime: isoNow(-86400000 * 2),    workTime: 29, workArea: 120, cutGrassHeight: 2, pathDirection: 120, mapNames: 'Front Yard',   workStatus: 'interrupted artificially', startWay: 'app', workRecordDate: isoNow(-86400000 * 2) },
  { recordId: '804', dateTime: isoNow(-86400000 * 4),    workTime: 118, workArea: 510, cutGrassHeight: 1, pathDirection: 0,   mapNames: 'Full Property',workStatus: 'finished',                startWay: 'app', workRecordDate: isoNow(-86400000 * 4) },
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

export function DemoProvider({
  children,
  initialEnabled = false,
}: {
  children: React.ReactNode;
  /** Boot directly into demo mode (used by fastlane snapshot runs). */
  initialEnabled?: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [actIdx, setActIdx] = useState(1); // start at 'mowing'
  const [mowZonePhase, setMowZonePhase] = useState<MowZoneDemoPhase>('following_unicom');

  const toggle = useCallback(() => setEnabled((v) => !v), []);
  const cycleActivity = useCallback(() => setActIdx((i) => (i + 1) % ACTIVITIES.length), []);

  const activity = ACTIVITIES[actIdx];

  // Scripted mow_zone_status sequence: undocking -> following_unicom ->
  // covering -> done over ~8s, replayed on a loop while the demo is parked
  // on the `following_unicom` activity slot. Lets the app + UnicomTransitAnimation
  // be exercised end-to-end without a real mower streaming extended_response.
  // Self-scheduling chain (rather than a dependency-array trick) so each leg
  // is queued only after the previous one actually ran.
  useEffect(() => {
    if (activity !== 'following_unicom') return;
    let cancelled = false;
    const pending: ReturnType<typeof setTimeout>[] = [];
    const schedule = (phase: MowZoneDemoPhase, delayMs: number) => {
      pending.push(setTimeout(() => {
        if (cancelled) return;
        setMowZonePhase(phase);
      }, delayMs));
    };
    const runLoop = () => {
      schedule('undocking', 0);
      schedule('following_unicom', 2000);
      schedule('covering', 5000);
      schedule('done', 7500);
      pending.push(setTimeout(() => { if (!cancelled) runLoop(); }, 8000));
    };
    runLoop();
    return () => {
      cancelled = true;
      pending.forEach(clearTimeout);
    };
  }, [activity]);

  const demoDevices = useMemo(
    () => makeDemoDevices(activity, mowZonePhase),
    [activity, mowZonePhase],
  );

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
