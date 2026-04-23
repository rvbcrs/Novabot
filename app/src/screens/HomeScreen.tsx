/**
 * Home screen — real-time mower status and action buttons.
 */
import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  RefreshControl,
  Alert,
  ActivityIndicator,
  Animated,
  Image,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Path as SvgPath } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { colors } from '../theme/colors';
import { BatteryRing } from '../components/BatteryRing';
import { MowerScene } from '../components/mower/MowerScene';
import { useMowerState } from '../hooks/useMowerState';
import { useActiveMower } from '../hooks/useActiveMower';
import { MowerPickerChevron } from '../components/MowerPickerChevron';
import { ApiClient, type Schedule } from '../services/api';
import { getServerUrl, getToken } from '../services/auth';
import { DemoBanner } from '../components/DemoBanner';
import { MowingProgressMap } from '../components/MowingProgressMap';
import HistoryScreen from './HistoryScreen';
import MessagesScreen from './MessagesScreen';
import { useDemo } from '../context/DemoContext';
import { StartMowSheet } from '../components/StartMowSheet';
import { RainOverlay } from '../components/RainOverlay';
import { AppActionSheet, type AppActionSheetItem } from '../components/AppActionSheet';
import CuttingHeightPickerModal from '../components/CuttingHeightPickerModal';
import { useI18n } from '../i18n';
import { getSocket } from '../services/socket';
import type { DeviceState, MowerActivity } from '../types';
import type { MainTabParams } from '../navigation/types';

// ── Derive mower status ──────────────────────────────────────────────

interface MowerDerived {
  sn: string;
  online: boolean;
  activity: MowerActivity;
  battery: number;
  batteryCharging: boolean;
  mowingProgress: number;
  pathDirection: number;
  wifiRssi: string | undefined;
  rtkSat: string | undefined;
  errorStatus: string | undefined;
  errorCode: string | undefined;
  errorMsg: string | undefined;
  hasError: boolean;
  hasSoftWarning: boolean;
  dockFailed: boolean;
  mapNum: number;
  mowerPosX: number | null;
  mowerPosY: number | null;
  mowerHeading: number | null;
}

// ── Cover path helpers ──────────────────────────────────────────────
//
// Mower publishes cover_path.covered via report_state_timer_data.  Server
// (sensorData.ts) forwards the raw strings through the sensor state pipe;
// we just parse them here for the live map view.

function parseFinishedAreas(
  raw: string | undefined,
  mapId: string | undefined,
): string[] | undefined {
  if (!raw) return undefined;
  // Mower stream: " 0 1 2 3 4 5 6 7 8 9 10 11 12 13" → sub-area indices.
  // Server gives plannedPaths[].id = "{map_id}_{sub_id}" (e.g. "1_0", "1_100")
  // so we prefix each index with the active cover_map_id to match. Also emit
  // the bare index so components built against the raw format still work.
  const ids = raw.trim().split(/\s+/).filter(s => s.length > 0);
  if (mapId && mapId.length > 0) {
    return ids.flatMap(sub => [`${mapId}_${sub}`, sub]);
  }
  return ids;
}

function prefixedAreaId(
  raw: string | undefined,
  mapId: string | undefined,
): string | undefined {
  if (!raw) return undefined;
  if (mapId && mapId.length > 0) return `${mapId}_${raw}`;
  return raw;
}

function parseCoveringPoints(raw: string | undefined): Array<{ x: number; y: number }> | undefined {
  if (!raw) return undefined;
  // "2.48 -1.62,2.49 -1.63" — comma separates points, space separates x/y
  const points: Array<{ x: number; y: number }> = [];
  for (const chunk of raw.split(',')) {
    const [xs, ys] = chunk.trim().split(/\s+/);
    const x = parseFloat(xs);
    const y = parseFloat(ys);
    if (!isNaN(x) && !isNaN(y)) points.push({ x, y });
  }
  return points.length > 0 ? points : undefined;
}

function deriveMower(mower: DeviceState | null): MowerDerived | null {
  if (!mower) return null;

  const s = mower.sensors;
  const workStatus = s.work_status ?? '0';
  const isOffline = !mower.online;
  // Error status from report_state_robot.
  //
  // Firmware emits "Robot soft(<subsystem>) error!!! maybe retry or reboot can
  // solve this" for transient init/race failures — Novabot treats these as
  // dismissable popups ("Software not initialized, please wait and retry") and
  // keeps the UI usable. Only hard faults (out-of-bounds, PIN lock, hardware
  // open failures) should actually block the Mow button.
  //
  // Codes catalogued from /root/novabot/install/compound_decision/.../robot_decision strings.
  // Non-blocking (Novabot shows a dismissable popup and keeps the mow button active):
  //   8   Lora disconnect warning
  //   120 Robot soft(mapping)error
  //   122 Robot soft(follow path action)error (nav2 lifecycle not active yet)
  //   123 Robot soft(coverage action)error
  //   124 Robot out of working area — Novabot shows a popup ("please move robot
  //       inside working area to start"), user tikt OK en kan verder. Hij moet
  //       wel handmatig of via Home de mower terug binnen het gebied krijgen
  //       voordat 'ie weer kan maaien, maar de app blokkeert niet.
  //   125 Robot soft(coverage stop)error
  //   126 Recharge failed (user can still start a new mow)
  // Blocking (leave out of this list):
  //   107 Load map failed, 151 Boot PIN lock,
  //   152 Emergency stop PIN, plus all hardware errors (camera/chassis/utm/crash).
  // 132 = "Data transmission loss, robot will auto continue task if received valid
  // data" — self-recovers, shown as warning only.
  // 113 = transient sensor/perception warning that also auto-recovers.
  // 118 = "Input data for coverage action is wrong, maybe file not exists!".
  //       Firmware raises this when the map.yaml / map0.yaml files needed by
  //       the coverage planner are missing — typically after a ZIP-restore
  //       or when save_map type:1 never ran. The flag lingers even after
  //       recovery, so we treat it as a soft warning and let the user try
  //       again (retrying triggers a fresh coverage request, which clears
  //       the flag on success).
  const NON_BLOCKING_ERRORS = [8, 113, 118, 120, 122, 123, 124, 125, 126, 132];
  const errorStatusRaw = parseInt(s.error_status?.match(/\d+/)?.[0] ?? '0', 10);
  const hasError = Boolean(
    errorStatusRaw > 0 && !NON_BLOCKING_ERRORS.includes(errorStatusRaw),
  );
  const hasSoftWarning = errorStatusRaw > 0 && NON_BLOCKING_ERRORS.includes(errorStatusRaw);

  // Activity detection based on firmware report_state_robot fields:
  // - battery_state: "CHARGING" (on dock) / "DISCHARGED" (off dock)
  // - task_mode: 1=COVERAGE, 2=MAPPING
  // - work_status: 0=WAIT, 1=WORKING, 9=FINISHED (firmware-specific, not reliable alone)
  // - recharge_status: 0=IDLE, 1=GOING, 9=FINISHED
  // - msg: "Mode:COVERAGE Work:RUNNING" etc.
  const batteryState = s.battery_state?.toUpperCase() ?? '';
  const taskMode = parseInt(s.task_mode ?? '0', 10);
  const rechargeStatus = parseInt(s.recharge_status ?? '0', 10);
  const msg = s.msg ?? '';
  const isOnDock = batteryState === 'CHARGING';
  const isCoverageRunning = msg.includes('Work:RUNNING') || msg.includes('Work:NAVIGATING') || msg.includes('Work:COVERING') || msg.includes('Work:MOVING')
    || msg.includes('Work:QUIT_PILE_INIT') || msg.includes('Work:SENSOR_INIT') || msg.includes('Work:INIT_SUCCESS') || msg.includes('Work:MAP_INIT')
    || msg.includes('Work:BOUNDARY_COVERING') || msg.includes('Work:AVOIDING');
  // Pauze-state: de firmware zet `Work:USER_STOP` wanneer je pauzeert via app
  // of hardware-knop (verified live 2026-04-20). `Work:PAUSED` is het ROS-niveau
  // pause dat zelden in msg verschijnt. We dekken beide.
  const isCoveragePaused = (msg.includes('Work:PAUSED') || msg.includes('Work:USER_STOP'))
    && taskMode === 1 && !isOnDock;
  // Recharge: FAILED — maaier reed naar dock maar kon niet dokken (miste de
  // charger, sensor glitch, of weg geblokt). Novabot toont hier meteen een
  // "Return to charge failed, please retry or manually move" popup.
  // recharge_status blijft op 1 hangen, maar Recharge: FAILED in msg is de
  // kanoniek waarheid. Behandel dit als een error-situatie zodat de UI uit
  // de "Returning" lus komt.
  const isDockFailed = msg.includes('Recharge: FAILED');
  const isReturning = (rechargeStatus === 1 || msg.includes('Recharge: GOING') || msg.includes('Work:GO_PILE')
    || msg.includes('Work:BACK_CHARGER') || msg.includes('Work:DOCKING'))
    && !isDockFailed;
  // "Sticky" mowing: off dock + coverage mode + work not explicitly stopped/finished
  // Prevents flicker during lane transitions (brief Work:WAIT between lanes)
  // But NOT sticky when returning home or explicitly cancelled/finished
  const isMowingSticky = !isOnDock && taskMode === 1 && !isReturning
    && !msg.includes('Work:FINISHED') && !msg.includes('Work:CANCELLED')
    && workStatus !== '0' && workStatus !== '9';

  let activity: MowerActivity = 'idle';
  if (isOffline) activity = 'idle';
  else if (hasError && !isOnDock) activity = 'error';
  else if (isDockFailed && !isOnDock) activity = 'error';
  else if (isCoverageRunning) activity = 'mowing';
  else if (s.start_edit_or_assistant_map_flag === '1' && taskMode !== 1) activity = 'mapping';
  else if (isCoveragePaused) activity = 'paused';
  else if (isReturning && !isOnDock) activity = 'returning';
  else if (isOnDock) activity = 'charging';
  // Sticky: still mowing during brief lane transitions (work_status != 0/9)
  else if (isMowingSticky) activity = 'mowing';

  return {
    sn: mower.sn,
    online: mower.online,
    activity,
    battery:
      parseInt(s.battery_power ?? s.battery_capacity ?? '0', 10) || 0,
    batteryCharging: activity === 'charging',
    mowingProgress: (() => {
      const ratio = parseFloat(s.cov_ratio ?? '0');
      // cov_ratio is 0.0-1.0 (fraction), convert to 0-100 percentage
      if (ratio > 0 && ratio <= 1) return Math.round(ratio * 100);
      // mowing_progress is already 0-100
      return Math.round(parseFloat(s.mowing_progress ?? '0')) || 0;
    })(),
    pathDirection:
      parseInt(s.path_direction ?? '0', 10) || 0,
    wifiRssi: s.wifi_rssi,
    rtkSat: s.rtk_sat,
    errorStatus: s.error_status,
    errorCode: s.error_code,
    errorMsg: s.error_msg,
    hasError,
    hasSoftWarning,
    dockFailed: isDockFailed,
    mapNum: parseInt(s.map_num ?? '0', 10) || 0,
    mowerPosX: parseFloat(s.map_position_x ?? '') || null,
    mowerPosY: parseFloat(s.map_position_y ?? '') || null,
    mowerHeading: parseFloat(s.map_position_orientation ?? '') || null,
  };
}

// ── Activity display helpers ─────────────────────────────────────────

const ACTIVITY_KEYS: Record<MowerActivity, string> = {
  mowing: 'mowing',
  charging: 'charging',
  returning: 'returning',
  paused: 'paused',
  error: 'errorState',
  mapping: 'mapping',
  idle: 'idle',
};

function getActivityLabel(activity: MowerActivity, t?: (key: string) => string): string {
  if (t) return t(ACTIVITY_KEYS[activity] ?? 'idle');
  switch (activity) {
    case 'mowing': return 'Mowing';
    case 'charging': return 'Charging';
    case 'returning': return 'Returning';
    case 'paused': return 'Paused';
    case 'error': return 'Error';
    case 'mapping': return 'Mapping';
    case 'idle': default: return 'Idle';
  }
}

function getActivityColor(activity: MowerActivity): string {
  switch (activity) {
    case 'mowing':
      return colors.green;
    case 'charging':
      return colors.blue;
    case 'returning':
      return colors.blue;
    case 'paused':
      return colors.amber;
    case 'error':
      return colors.red;
    case 'mapping':
      return colors.purple;
    case 'idle':
    default:
      return colors.textDim;
  }
}

function getBatteryGlowColor(percentage: number): string {
  if (percentage >= 65) return 'rgba(34, 197, 94, 0.18)';
  if (percentage >= 35) return 'rgba(245, 158, 11, 0.16)';
  return 'rgba(239, 68, 68, 0.18)';
}

function getNextScheduleDisplay(
  schedules: Schedule[],
  now = new Date(),
): { day: string; time: string } | null {
  const enabled = schedules.filter((schedule) => schedule.enabled);
  if (enabled.length === 0) return null;

  const daysShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const currentDay = now.getDay();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  let bestDelta = Number.POSITIVE_INFINITY;
  let bestSchedule: { day: string; time: string } | null = null;

  for (const schedule of enabled) {
    const weekdays = schedule.weekdays.length > 0 ? schedule.weekdays : [schedule.day_of_week];
    const [startHour = 0, startMinute = 0] = schedule.startTime.split(':').map((part) => Number(part) || 0);
    const scheduleMinutes = startHour * 60 + startMinute;

    for (const weekday of weekdays) {
      let dayDelta = weekday - currentDay;
      if (dayDelta < 0) dayDelta += 7;
      if (dayDelta === 0 && scheduleMinutes <= currentMinutes) dayDelta = 7;

      const totalDelta = dayDelta * 24 * 60 + (scheduleMinutes - currentMinutes);
      if (totalDelta < bestDelta) {
        bestDelta = totalDelta;
        bestSchedule = {
          day: daysShort[weekday] ?? daysShort[0],
          time: schedule.startTime,
        };
      }
    }
  }

  return bestSchedule;
}

const MOWER_SVG_PATH = "M8.75 7C7.55 7.02 6.52 7.15 5.65 7.53C4.79 7.9 4.02 8.71 4.02 9.72V13.77C2.77 14.96 1.98 16.63 1.98 18.48C1.98 22.07 4.91 25 8.5 25C9.75 25 10.89 24.62 11.86 24H21.81C22.36 24.61 23.14 25 24.02 25C24.89 25 25.67 24.61 26.22 24H26.9C28.59 24 30.02 22.65 30.02 20.96V18.9C30.02 16.27 28.24 14.08 25.85 12.35C23.47 10.63 20.38 9.3 17.3 8.38C14.22 7.47 11.16 6.97 8.75 7ZM8.78 9C10.88 8.97 13.81 9.43 16.73 10.3C19.65 11.17 22.57 12.45 24.68 13.97C26.42 15.23 27.55 16.6 27.89 18H14.92C14.66 14.65 11.92 11.96 8.5 11.96C7.62 11.96 6.78 12.14 6.02 12.46V9.72C6.02 9.58 5.99 9.56 6.45 9.36C6.9 9.17 7.73 9.02 8.78 9ZM8.5 13.96C11.01 13.96 13.02 15.98 13.02 18.48C13.02 20.99 11.01 23 8.5 23C5.99 23 3.98 20.99 3.98 18.48C3.98 15.98 5.99 13.96 8.5 13.96ZM14.71 20H28.02V20.96C28.02 21.53 27.55 22 26.9 22H13.86C14.24 21.39 14.53 20.72 14.71 20Z";

function MowerIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <SvgPath d={MOWER_SVG_PATH} fill={color} />
    </Svg>
  );
}

function getActivityIcon(
  activity: MowerActivity,
): React.ComponentProps<typeof Ionicons>['name'] {
  switch (activity) {
    case 'mowing':
      return 'leaf'; // overridden by custom SVG in render
    case 'charging':
      return 'battery-charging';
    case 'returning':
      return 'home';
    case 'paused':
      return 'pause-circle';
    case 'error':
      return 'alert-circle';
    case 'mapping':
      return 'map';
    case 'idle':
    default:
      return 'moon';
  }
}

// ── Glow colors per activity (matching dashboard StatusHeroCard) ────

const GLOW_COLOR: Record<MowerActivity, string> = {
  idle:      'transparent',
  mowing:    'rgba(16, 185, 129, 0.20)',
  charging:  'rgba(59, 130, 246, 0.20)',
  returning: 'rgba(245, 158, 11, 0.15)',
  paused:    'rgba(234, 179, 8, 0.12)',
  mapping:   'rgba(168, 85, 247, 0.15)',
  error:     'rgba(239, 68, 68, 0.20)',
};

// ── Component ────────────────────────────────────────────────────────

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const route = useRoute<RouteProp<MainTabParams, 'Home'>>();
  const { devices, connected } = useMowerState();
  const { activeMower, activeMowerSn, setActiveMowerSn } = useActiveMower();
  const { t } = useI18n();
  const mower = useMemo(() => deriveMower(activeMower), [activeMower]);
  // Rename flow for the active mower — wired to the pencil icon inside the
  // MowerPickerChevron trigger. Keeping it here (instead of inside the
  // chevron component) so HomeScreen stays the single owner of API + socket
  // calls; the chevron just fires the callback.
  const renameActiveMower = useCallback(() => {
    if (!mower) return;
    Alert.prompt(
      t('renameMower', undefined) || 'Rename Mower',
      t('enterNewName', undefined) || 'Enter a new name:',
      [
        { text: t('cancel', undefined) || 'Cancel', style: 'cancel' },
        {
          text: t('rename', undefined) || 'Rename',
          onPress: async (newName?: string) => {
            const trimmed = (newName ?? '').trim();
            if (!trimmed) return;
            try {
              const url = await getServerUrl();
              if (!url) return;
              const api = new ApiClient(url);
              await api.updateEquipmentNickName(mower.sn, trimmed);
              // Pull fresh snapshot so the new name appears immediately.
              const socket = getSocket();
              socket?.emit('request:snapshot');
            } catch (err) {
              console.warn('[HomeScreen] rename mower failed:', err);
            }
          },
        },
      ],
      'plain-text',
      devices.get(mower.sn)?.nickname || '',
    );
  }, [mower, devices, t]);
  const charger = useMemo(() => {
    const chargers = [...devices.values()].filter((d) => d.deviceType === 'charger');
    return chargers.find((c) => c.online) ?? chargers[0] ?? null;
  }, [devices]);
  const [deviceSets, setDeviceSets] = useState<Array<{
    loraAddress: number | null;
    charger: { sn: string; online: boolean } | null;
    mower: { sn: string; online: boolean } | null;
  }>>([]);
  const [commandLoading, setCommandLoading] = useState<string | null>(null);
  const [showStartMow, setShowStartMow] = useState(false);
  const [startMowInitialMapId, setStartMowInitialMapId] = useState<string | null>(null);
  // Cutting height picker voor edge/spot — user-spec 2026-04-21:
  // ELKE maai-actie moet om de hoogte vragen voordat het command afvuurt.
  // Voor "Full mow" regelt StartMowSheet dat al. Voor edge/spot hadden we
  // geen hoogte-dialog → die hoogte werd dan default 5cm (wire 3) zonder
  // user-confirm. Nu via CuttingHeightPickerModal.
  const [heightPicker, setHeightPicker] = useState<null | {
    mode: 'edge' | 'spot';
    title: string;
    message: string;
    confirmLabel: string;
    /** Voor spot-mow: de GPS polygon die we al hebben berekend. */
    spotPolygon?: Array<{ latitude: number; longitude: number }>;
  }>(null);
  const [commandError, setCommandError] = useState('');
  // Track which soft-error codes the user already dismissed this session so
  // the banner doesn't pop back every time report_state_robot cycles.
  const [dismissedSoftErrors, setDismissedSoftErrors] = useState<Set<number>>(new Set());
  // Long-pause safety: RTK / localization drift na een langere pauze kan de
  // maaier bij resume de verkeerde kant op sturen (gebeurde 2026-04-20 op
  // Ramon's tuin — 83 min pauze → resume → ROBOT_OUT_OF_MAP_HANDLE → error
  // 140 coverage planner crash → maaier reed achteruit de stoep op). We
  // tracken de start-tijd van USER_STOP / PAUSED en waarschuwen de user
  // boven de 15 min zodat hij zelf kiest: resume anyway, of stop & return.
  const [pauseStartedAt, setPauseStartedAt] = useState<number | null>(null);
  const [pauseNowMs, setPauseNowMs] = useState<number>(0);
  const LONG_PAUSE_THRESHOLD_MS = 15 * 60 * 1000;
  const [dismissedLongPauseWarning, setDismissedLongPauseWarning] = useState(false);
  // Start-modes action sheet (opent via de chevron naast de Start-knop) —
  // alternatieve start-commando's zoals edge-only / boundary follow.
  const [showStartModeSheet, setShowStartModeSheet] = useState(false);
  // Force StartMowSheet om zone-keuze te vragen (ook bij één zone). Gebruikt
  // door "Specific zone" item in de start-modes sheet zodat de user altijd
  // bewust een zone kiest i.p.v. auto-selected.
  const [startMowForceZone, setStartMowForceZone] = useState(false);
  // Optimistic activity override — shows expected state immediately while waiting for MQTT update
  const [activityOverride, setActivityOverride] = useState<MowerActivity | null>(null);
  const activityOverrideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setOptimisticActivity = (target: MowerActivity) => {
    setActivityOverride(target);
    if (activityOverrideTimer.current) clearTimeout(activityOverrideTimer.current);
    // Returning can take minutes — use longer timeout
    const timeout = target === 'returning' ? 120000 : 10000;
    activityOverrideTimer.current = setTimeout(() => setActivityOverride(null), timeout);
  };
  // Clear override when real activity matches OR when returning + arrived on dock
  useEffect(() => {
    if (!mower || !activityOverride) return;
    if (mower.activity === activityOverride) {
      setActivityOverride(null);
      if (activityOverrideTimer.current) clearTimeout(activityOverrideTimer.current);
    }
    // Returning override: clear when mower reaches charger
    if (activityOverride === 'returning' && mower.activity === 'charging') {
      setActivityOverride(null);
      if (activityOverrideTimer.current) clearTimeout(activityOverrideTimer.current);
    }
  }, [mower?.activity, activityOverride]);
  const [showHistory, setShowHistory] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  const [activeMapPolygon, setActiveMapPolygon] = useState<Array<{ x: number; y: number }>>([]);
  const [mowingTrail, setMowingTrail] = useState<Array<{ x: number; y: number }>>([]);
  const [plannedPaths, setPlannedPaths] = useState<Array<{ id: string; points: Array<{ x: number; y: number }> }>>([]);
  const [obstaclePolygons, setObstaclePolygons] = useState<Array<{ id: string; points: Array<{ x: number; y: number }> }>>([]);
  // Track mowing settings for safety check + display
  const [mowSettings, setMowSettings] = useState<{ cuttingHeight: number; pathDirection: number } | null>(null);
  const demo = useDemo();

  // Fetch device sets + map count + next schedule from server
  const [serverMapCount, setServerMapCount] = useState(0);
  const [nextSchedule, setNextSchedule] = useState<{ day: string; time: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loadHomeMeta = useCallback(async () => {
    if (demo.enabled) {
      setServerMapCount(0);
      setNextSchedule(null);
      return;
    }

    try {
      setNextSchedule(null);
      const url = await getServerUrl();
      if (!url) return;
      const api = new ApiClient(url);
      const res = await api.getDeviceSets();
      setDeviceSets(res.sets ?? []);

      if (!mower?.sn) {
        setServerMapCount(0);
        return;
      }

      const mapsRes = await api.fetchMaps(mower.sn).catch(() => ({ maps: [] }));
      const workMaps = (mapsRes.maps ?? []).filter((map: any) => map.mapType === 'work');
      setServerMapCount(workMaps.length);

      const schedules = await api.getSchedules(mower.sn).catch(() => []);
      setNextSchedule(getNextScheduleDisplay(schedules));
    } catch {
      // Ignore transient refresh failures on the home screen
    }
  }, [demo.enabled, mower?.sn]);

  useEffect(() => {
    void loadHomeMeta();
  }, [loadHomeMeta, connected]);

  // ── Long-pause safety tracking ────────────────────────────────────
  // Set pauseStartedAt zodra we USER_STOP / PAUSED zien, en wis hem zodra
  // de maaier weer iets anders doet (MOVING / COVERING / FINISHED). De
  // 30s interval geeft een live-tickende duur voor de banner.
  useEffect(() => {
    if (mower?.activity === 'paused') {
      if (pauseStartedAt == null) {
        setPauseStartedAt(Date.now());
        setPauseNowMs(Date.now());
        setDismissedLongPauseWarning(false);
      }
    } else {
      if (pauseStartedAt != null) {
        setPauseStartedAt(null);
        setDismissedLongPauseWarning(false);
      }
    }
  }, [mower?.activity, pauseStartedAt]);
  useEffect(() => {
    if (pauseStartedAt == null) return;
    const i = setInterval(() => setPauseNowMs(Date.now()), 30_000);
    return () => clearInterval(i);
  }, [pauseStartedAt]);

  // ── Auto-safety: ROBOT_OUT_OF_MAP_HANDLE na lange pauze = stop it NU ──
  // Als de maaier binnen 2 minuten na resume in ROBOT_OUT_OF_MAP_HANDLE
  // komt en we zien dat hij voor > 15 min gepauzeerd was, is dit bijna
  // zeker localization drift. Verdere retries crashen de coverage planner
  // (error 140) en fysiek reed de mower achteruit in Ramon's test. Stop
  // hem direct + clear error voordat het erger wordt.
  const lastResumeAtRef = useRef<number | null>(null);
  const autoSafetyFiredRef = useRef(false);
  useEffect(() => {
    // Detect "we just resumed from a long pause"
    const msg = devices.get(mower?.sn ?? '')?.sensors?.msg ?? '';
    const wasLongPause = pauseStartedAt != null
      && (Date.now() - pauseStartedAt) > LONG_PAUSE_THRESHOLD_MS;
    if (mower?.activity === 'mowing' && wasLongPause && lastResumeAtRef.current == null) {
      lastResumeAtRef.current = Date.now();
      autoSafetyFiredRef.current = false;
    }
    if (mower?.activity === 'idle' || mower?.activity === 'charging') {
      lastResumeAtRef.current = null;
      autoSafetyFiredRef.current = false;
    }
    // Trigger safety stop
    if (
      !autoSafetyFiredRef.current
      && lastResumeAtRef.current != null
      && (Date.now() - lastResumeAtRef.current) < 2 * 60 * 1000
      && msg.includes('ROBOT_OUT_OF_MAP_HANDLE')
    ) {
      autoSafetyFiredRef.current = true;
      (async () => {
        try {
          const url = await getServerUrl();
          if (!url || !mower?.sn) return;
          const api = new ApiClient(url);
          console.warn('[LONG-PAUSE-SAFETY] ROBOT_OUT_OF_MAP_HANDLE after long-pause resume — auto-stopping');
          await api.sendCommand(mower.sn, { stop_navigation: { cmd_num: Date.now() % 100000 } });
          await new Promise(r => setTimeout(r, 300));
          await api.sendCommand(mower.sn, { clear_error: {} });
          Alert.alert(
            'Safety stop',
            'Mower went outside the map after a long pause. Automatically stopped before the coverage planner crashed. Move the mower back inside the work area to continue.',
            [{ text: 'OK' }],
          );
        } catch { /* ignore */ }
      })();
    }
  }, [mower?.activity, mower?.sn, pauseStartedAt, devices, LONG_PAUSE_THRESHOLD_MS]);

  // Refresh map count / schedules when the screen regains focus, otherwise
  // returning here from MappingScreen leaves serverMapCount stuck at 0 and the
  // mow button keeps saying "No map — create map first" even after a successful
  // save (the home screen never unmounts and the deps above don't change).
  useEffect(() => {
    const unsub = navigation.addListener('focus', () => { void loadHomeMeta(); });
    return unsub;
  }, [navigation, loadHomeMeta]);

  useEffect(() => {
    if (!route.params?.openStartMow) return;
    setStartMowInitialMapId(route.params.preselectedMapId ?? null);
    setShowStartMow(true);
    (navigation as any).setParams({
      openStartMow: false,
      preselectedMapId: null,
    });
  }, [navigation, route.params?.openStartMow, route.params?.preselectedMapId]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const socket = getSocket();
      if (socket) socket.emit('request:snapshot');
      await loadHomeMeta();
    } finally {
      setRefreshing(false);
    }
  }, [loadHomeMeta]);

  // Fetch first work polygon for mowing progress display
  useEffect(() => {
    if (demo.enabled) {
      setActiveMapPolygon([
        { x: -3, y: 5 }, { x: 1, y: 7 }, { x: 5, y: 6 },
        { x: 6, y: 2 }, { x: 3, y: -1 }, { x: -2, y: 1 },
      ]);
      return;
    }
    if (!mower?.sn) return;
    (async () => {
      try {
        const url = await getServerUrl();
        if (!url) return;
        const api = new ApiClient(url);
        const res = await api.fetchMaps(mower.sn);
        // Show the currently mowing zone, or the first work map as default
        const workMaps = (res.maps ?? []).filter((m: any) => m.mapType === 'work' && m.mapArea?.length >= 3);
        const currentMapIds = parseInt(devices.get(mower.sn)?.sensors?.current_map_ids ?? '0', 10);
        // current_map_ids: 1=map0, 2=map1, etc. (1-indexed during mowing, 0=none)
        const activeIdx = currentMapIds > 0 ? currentMapIds - 1 : 0;
        const activeWork = workMaps[activeIdx] ?? workMaps[0];
        if (activeWork) setActiveMapPolygon(activeWork.mapArea);
        const obs = (res.maps ?? []).filter((m: any) => m.mapType === 'obstacle' && m.mapArea?.length >= 3);
        setObstaclePolygons(obs.map((m: any) => ({ id: m.mapId, points: m.mapArea })));
      } catch { /* ignore */ }
    })();
  }, [mower?.sn, demo.enabled]);

  // Safety check: verify mower cutting height matches what we set.
  // Firmware echoes cutterhigh verbatim as target_height. Both are the wire
  // enum `cm − 2` per CLAUDE.md cutting-height-mapping (user 4cm → cutterhigh:2
  // → target_height:2). Verified 2026-04-19 from live logs on LFIN1231000211.
  // Tolerance = 1 wire unit.
  //
  // Grace period: the firmware takes 3-8s to apply cutterhigh and echo it in
  // target_height. Early reports can still show the previous value (e.g. 2 during
  // dock/raise state). Wait until target_height stops changing before triggering
  // the mismatch alert, otherwise we false-positive every mow start.
  const heightCheckDone = useRef(false);
  const heightFirstSeenRef = useRef<{ value: number; ts: number } | null>(null);
  useEffect(() => {
    if (!mower || !mowSettings || mower.activity !== 'mowing') {
      heightCheckDone.current = false;
      heightFirstSeenRef.current = null;
      return;
    }
    const reportedHeight = parseInt(devices.get(mower.sn)?.sensors?.target_height ?? '0', 10);
    if (reportedHeight === 0 || heightCheckDone.current) return;

    // Only evaluate once the same value has been stable for 6 seconds.
    const now = Date.now();
    const seen = heightFirstSeenRef.current;
    if (!seen || seen.value !== reportedHeight) {
      heightFirstSeenRef.current = { value: reportedHeight, ts: now };
      return;
    }
    if (now - seen.ts < 6000) return;

    // Both target_height and mowSettings.cuttingHeight are wire values (cm - 2, range 0-7).
    // Display as `wire + 2` cm. Allow 1 unit tolerance for firmware rounding.
    if (Math.abs(reportedHeight - mowSettings.cuttingHeight) > 1) {
      heightCheckDone.current = true;
      Alert.alert(
        'Cutting Height Mismatch!',
        `Expected ${mowSettings.cuttingHeight + 2}cm but mower reports ${reportedHeight + 2}cm. Stop mowing for safety?`,
        [
          { text: 'Stop', style: 'destructive', onPress: () => {
            sendCommand(mower.sn, { stop_navigation: { cmd_num: ++cmdNumRef.current } }, 'stop');
            setOptimisticActivity('idle');
          }},
          { text: 'Continue', style: 'cancel' },
        ],
      );
    } else {
      heightCheckDone.current = true;
    }
  }, [mower?.sn, mower?.activity, mowSettings, devices]);

  // Auto-refresh trail every 3s during mowing — ook planned path ophalen (live)
  // Elke 10s een verse refresh van plan_path via onze server (triggert
  // extended_commands op mower).
  useEffect(() => {
    if (!mower || demo.enabled) return;
    const isActive = mower.activity === 'mowing' || mower.activity === 'mapping';
    const isReturning = mower.activity === 'returning';
    if (!isActive && !isReturning) return;
    let tick = 0;
    const refresh = async () => {
      tick++;
      try {
        const url = await getServerUrl();
        if (!url) return;
        const api = new ApiClient(url);
        const [trailRes, pathsRes] = await Promise.all([
          api.getTrail(mower.sn).catch(() => []),
          api.getPlannedPath(mower.sn).catch(() => []),
        ]);
        const trail = Array.isArray(trailRes) ? trailRes : (trailRes as any).trail ?? [];
        setMowingTrail(trail.map((p: any) => ({ x: p.x ?? 0, y: p.y ?? 0 })));
        if (Array.isArray(pathsRes) && pathsRes.length > 0) setPlannedPaths(pathsRes);

        // Elke ~10s een verse plan path pullen via extended_commands.
        // Alleen tijdens active mowing/mapping — NIET tijdens returning, want
        // dan riskeren we dat generate_preview de recharge flow verstoort.
        // Voor returning is de reeds gecachte plannedPath + finished_area
        // voldoende; nieuwe data komt pas bij de volgende maai-sessie.
        if (isActive && tick % 3 === 1) {
          api.refreshPlanPath(mower.sn).then((fresh) => {
            if (Array.isArray(fresh) && fresh.length > 0) setPlannedPaths(fresh);
          }).catch(() => { /* ignore */ });
        }
      } catch { /* ignore */ }
    };
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [mower?.activity, mower?.sn, demo.enabled]);

  // Idle state: toon bestaande cached preview, en trigger op achtergrond een
  // refresh zodat de preview up-to-date is (houdt rekening met huidige
  // path_direction). Zo krijgt de user echte berekende lijntjes i.p.v.
  // gegenereerde rechte strepen.
  //
  // KRITIEK (fix 2026-04-21): Deze useEffect had `devices` in z'n deps,
  // wat betekent dat hij bij ELKE MQTT sensor-update opnieuw vuurt (~elke
  // 2s). Dat produceerde een cascade van POST /refresh-preview-path naar
  // de server — live zichtbaar in de docker logs als spam. Fix:
  //  - `devices` uit deps, sensor-snapshot via ref lezen
  //  - throttle: min 60s tussen refreshes (cached read doet de rest)
  //  - vroege return als mower offline
  const devicesRef = useRef(devices);
  useEffect(() => { devicesRef.current = devices; }, [devices]);
  const lastPreviewRefreshAt = useRef<number>(0);
  useEffect(() => {
    if (!mower || demo.enabled) return;
    if (mower.activity === 'mowing' || mower.activity === 'mapping') return;
    // Mower offline → GEEN refresh trigger. Zonder deze guard stuurt de app
    // oneindig generate_preview commands naar een mower die niet antwoordt,
    // wat de server logs totaal volspamde (bewezen live 2026-04-21).
    if (!mower.online) return;

    const PREVIEW_REFRESH_MIN_INTERVAL_MS = 60_000;
    const now = Date.now();
    const doFreshRefresh = now - lastPreviewRefreshAt.current >= PREVIEW_REFRESH_MIN_INTERVAL_MS;

    let cancelled = false;
    (async () => {
      try {
        const url = await getServerUrl();
        if (!url) return;
        const api = new ApiClient(url);

        // Eerst de cache: instant display als iets beschikbaar is (altijd veilig)
        const cached = await api.getPreviewPath(mower.sn).catch(() => []);
        if (cancelled) return;
        if (Array.isArray(cached) && cached.length > 0) setPlannedPaths(cached);

        if (!doFreshRefresh) return;

        // SAFETY: refreshPreviewPath triggert generate_preview_cover_path op
        // de mower. Die ROS service errort met code 128 als coverage al
        // actief is. We lezen de sensor-state via ref (buiten deps) zodat
        // een state-update niet de useEffect herstart.
        const mowerState = devicesRef.current.get(mower.sn);
        const msg = mowerState?.sensors?.msg ?? '';
        const taskMode = parseInt(mowerState?.sensors?.task_mode ?? '0', 10);
        const workStatus = mowerState?.sensors?.work_status ?? '';
        const errorStatus = parseInt(mowerState?.sensors?.error_status ?? '0', 10);
        const batteryCharging = mowerState?.sensors?.battery_state === 'CHARGING';
        const clearlyIdle =
          batteryCharging
          || msg.includes('Work:STANDBY')
          || msg.includes('Work:IDLE')
          || (taskMode === 0 && workStatus !== '9' && errorStatus === 0);

        if (!clearlyIdle) return;

        lastPreviewRefreshAt.current = now;
        const fresh = await api.refreshPreviewPath(mower.sn, {
          covDirection: mowSettings?.pathDirection,
          mapIds: 1,
        }).catch(() => []);
        if (cancelled) return;
        if (Array.isArray(fresh) && fresh.length > 0) setPlannedPaths(fresh);
      } catch { /* ignore */ }
    })();

    return () => { cancelled = true; };
  }, [mower?.activity, mower?.sn, mower?.online, mowSettings?.pathDirection, demo.enabled]);

  // Mower bounce animation (subtle bob when active)
  const bounceAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  // Auto-incrementing cmd_num for commands (matches Flutter app behavior)
  const cmdNumRef = useRef(0);

  useEffect(() => {
    if (!mower) return;
    const isMoving = mower.activity === 'mowing' || mower.activity === 'returning' || mower.activity === 'mapping';
    if (isMoving) {
      // Continuous bounce
      Animated.loop(
        Animated.sequence([
          Animated.timing(bounceAnim, { toValue: -4, duration: 400, useNativeDriver: true }),
          Animated.timing(bounceAnim, { toValue: 0, duration: 400, useNativeDriver: true }),
        ])
      ).start();
    } else if (mower.activity === 'charging') {
      // Gentle pulse
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.05, duration: 1000, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
        ])
      ).start();
    } else {
      bounceAnim.setValue(0);
      pulseAnim.setValue(1);
    }
  }, [mower?.activity]);

  const sendCommand = async (
    sn: string,
    command: Record<string, unknown>,
    label: string,
  ) => {
    setCommandLoading(label);
    setCommandError('');
    try {
      const url = await getServerUrl();
      if (!url) {
        setCommandError('No server configured');
        return;
      }
      const api = new ApiClient(url);
      const result = await api.sendCommand(sn, command);
      if (!result.ok) {
        setCommandError(result.error ?? 'Command failed');
      }
    } catch (e) {
      setCommandError(e instanceof Error ? e.message : 'Command failed');
    } finally {
      setCommandLoading(null);
    }
  };

  // Go home: send go_pile first, then go_to_charge (matches Flutter app flow)
  const sendGoHome = async (sn: string) => {
    setCommandLoading('home');
    setCommandError('');
    try {
      const url = await getServerUrl();
      if (!url) { setCommandError('No server configured'); return; }
      const api = new ApiClient(url);
      // Step 1: go_pile
      await api.sendCommand(sn, { go_pile: {} });
      // Step 2: go_to_charge (after short delay)
      await new Promise(r => setTimeout(r, 500));
      const result = await api.sendCommand(sn, {
        go_to_charge: { cmd_num: ++cmdNumRef.current, chargerpile: { latitude: 200, longitude: 200 } },
      });
      if (!result.ok) setCommandError(result.error ?? 'Command failed');
    } catch (e) {
      setCommandError(e instanceof Error ? e.message : 'Command failed');
    } finally {
      setCommandLoading(null);
    }
  };

  const handleDeleteDevice = (sn: string, label: string) => {
    Alert.alert(
      `Remove ${label}?`,
      `Remove ${sn} from the server. You can re-provision it later.`,
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              const url = await getServerUrl();
              if (!url) return;
              const api = new ApiClient(url);
              await api.deleteDevice(sn);
              // Refresh device sets
              const res = await api.getDeviceSets();
              setDeviceSets(res.sets ?? []);
            } catch { /* ignore */ }
          },
        },
      ],
    );
  };

  const handlePairMower = async (mowerSn: string) => {
    // Find chargers that have LoRa addresses (already provisioned)
    const chargersWithLora = deviceSets.filter(s => s.charger && s.loraAddress != null);
    if (chargersWithLora.length === 0) {
      Alert.alert(t('noChargerFound'), t('provisionCharger'));
      return;
    }

    // If only one charger, pair directly. Otherwise let user pick.
    const doPair = async (chargerSn: string) => {
      try {
        const url = await getServerUrl();
        if (!url) return;
        const api = new ApiClient(url);

        // 1. Get charger's LoRa config
        const chargerLora = await api.getChargerLora(chargerSn);
        if (!chargerLora) {
          Alert.alert(t('error'), 'Could not read charger LoRa config');
          return;
        }

        // 2. Query mower's current LoRa config
        let mowerLora: { addr?: number; channel?: number } = {};
        try {
          mowerLora = await api.queryMowerLora(mowerSn);
        } catch {
          // Mower may not respond (stock firmware without extended_commands)
        }

        // 3. If LoRa doesn't match, update the mower
        // Mower en charger staan altijd op IDENTIEKE addr+channel (bewezen
        // working-lora-pair 22 apr 2026, addr=718 ch=17 beide devices).
        const mowerChannel = chargerLora.channel;
        if (mowerLora.addr !== chargerLora.address || mowerLora.channel !== mowerChannel) {
          Alert.alert(
            t('loraMismatch'),
            `Mower LoRa: addr=${mowerLora.addr ?? '?'} ch=${mowerLora.channel ?? '?'}\n` +
            `Charger LoRa: addr=${chargerLora.address} ch=${chargerLora.channel}\n\n` +
            `Update mower to addr=${chargerLora.address} ch=${mowerChannel}?`,
            [
              { text: t('cancel'), style: 'cancel' },
              {
                text: t('updateAndPair'),
                onPress: async () => {
                  try {
                    await api.setMowerLora(mowerSn, chargerLora.address, mowerChannel);
                    await api.pairMower(mowerSn, chargerSn);
                    const res = await api.getDeviceSets();
                    setDeviceSets(res.sets ?? []);
                    Alert.alert(t('paired'), `Mower paired with charger.\nLoRa updated to addr=${chargerLora.address} ch=${mowerChannel}`);
                  } catch (e: any) {
                    Alert.alert(t('error'), e.message ?? 'Pairing failed');
                  }
                },
              },
            ],
          );
          return;
        }

        // 4. LoRa matches — just pair
        await api.pairMower(mowerSn, chargerSn);
        const res = await api.getDeviceSets();
        setDeviceSets(res.sets ?? []);
        Alert.alert(t('paired'), `Mower paired with charger (LoRa addr=${chargerLora.address})`);
      } catch (e: any) {
        Alert.alert(t('error'), e.message ?? 'Pairing failed');
      }
    };

    if (chargersWithLora.length === 1) {
      doPair(chargersWithLora[0].charger!.sn);
    } else {
      // Multiple chargers — let user pick
      Alert.alert(
        t('selectCharger'),
        t('whichCharger'),
        chargersWithLora.map(s => ({
          text: `${s.charger!.sn} (LoRa ${s.loraAddress})`,
          onPress: () => doPair(s.charger!.sn),
        })).concat([{ text: t('cancel'), onPress: async () => {} }]),
      );
    }
  };

  // ── No mower / mower offline state ──────────────────────────────
  const mowerOffline = mower && !mower.online;
  const chargerOnline = charger?.online;
  const noMower = !mower;


  if (noMower || mowerOffline) {
    // Pick a SN to query rain forecast against — prefer the (offline) mower
    // from devices, else fall back to any mower SN we have in deviceSets.
    // This lets the rain warning appear even when the mower is offline.
    const rainSn = mower?.sn
      ?? deviceSets.find(s => s.mower?.sn)?.mower?.sn
      ?? '';

    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <ScrollView contentContainerStyle={styles.emptyScroll} refreshControl={
          <RefreshControl refreshing={refreshing} tintColor={colors.purple} onRefresh={handleRefresh} />
        }>

          {/* Rain overlay — shown above device list so the user sees an
              incoming rain warning even when the mower is offline (Ramon:
              "ik verwacht nu regen te zien op het home screen"). */}
          {rainSn !== '' && (
            <View style={{ marginBottom: 16 }}>
              <RainOverlay mowerSn={rainSn} />
            </View>
          )}

          {/* Device sets — sorted: sets with online devices first */}
          {[...deviceSets]
            .sort((a, b) => {
              const aOnline = (a.charger?.online ? 1 : 0) + (a.mower?.online ? 1 : 0);
              const bOnline = (b.charger?.online ? 1 : 0) + (b.mower?.online ? 1 : 0);
              return bOnline - aOnline;
            })
            .map((set, idx) => {
              const paired = set.charger && set.mower;
              const needsMower = set.charger && !set.mower;
              const needsCharger = !set.charger && set.mower;
              const anyOnline = set.charger?.online || set.mower?.online;
              return (
                <View key={idx} style={[styles.setCard, anyOnline && styles.setCardActive]}>
                  {/* Set header */}
                  <View style={styles.setHeader}>
                    <Ionicons
                      name={paired ? 'link' : needsMower ? 'warning' : 'help-circle'}
                      size={16}
                      color={anyOnline ? colors.emerald : colors.textMuted}
                    />
                    <Text style={[styles.setTitle, anyOnline && { color: colors.white }]}>
                      {paired ? t('pairedSet') : needsMower ? t('mowerNeeded') : t('unpairedDevice')}
                    </Text>
                    {set.loraAddress != null && (
                      <Text style={styles.setLora}>LoRa {set.loraAddress}</Text>
                    )}
                  </View>

                  {/* Charger */}
                  {set.charger && (
                    <View style={styles.deviceRow}>
                      <View style={[styles.deviceIcon, { backgroundColor: set.charger.online ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.04)' }]}>
                        <Ionicons name="flash" size={16} color={set.charger.online ? colors.amber : colors.textMuted} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.deviceName, !set.charger.online && { color: colors.textMuted }]}>Charging Station</Text>
                        <Text style={styles.deviceSn}>{set.charger.sn}</Text>
                      </View>
                      <Text style={[styles.deviceStatus, { color: set.charger.online ? colors.green : colors.red }]}>
                        {set.charger.online ? t('online') : t('offline')}
                      </Text>
                      {!set.charger.online && (
                        <TouchableOpacity onPress={() => handleDeleteDevice(set.charger!.sn, 'Charger')} style={styles.deleteBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                          <Ionicons name="trash-outline" size={16} color={colors.textMuted} />
                        </TouchableOpacity>
                      )}
                    </View>
                  )}

                  {/* Mower */}
                  {set.mower && (
                    <View style={styles.deviceRow}>
                      <View style={[styles.deviceIcon, { backgroundColor: set.mower.online ? 'rgba(0,212,170,0.15)' : 'rgba(255,255,255,0.04)' }]}>
                        <Ionicons name="construct" size={16} color={set.mower.online ? colors.emerald : colors.textMuted} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.deviceName, !set.mower.online && { color: colors.textMuted }]}>Mower</Text>
                        <Text style={styles.deviceSn}>{set.mower.sn}</Text>
                      </View>
                      <Text style={[styles.deviceStatus, { color: set.mower.online ? colors.green : colors.red }]}>
                        {set.mower.online ? t('online') : t('offline')}
                      </Text>
                      {!set.mower.online && (
                        <TouchableOpacity onPress={() => handleDeleteDevice(set.mower!.sn, 'Mower')} style={styles.deleteBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                          <Ionicons name="trash-outline" size={16} color={colors.textMuted} />
                        </TouchableOpacity>
                      )}
                    </View>
                  )}

                  {/* Activate button — visible op elk paired set dat NIET de
                      huidige actieve is. Klap-switch de active mower. De
                      Novabot-app filtert userEquipmentList op is_active dus
                      na tap ziet die app alleen dit pair. */}
                  {paired && set.mower!.sn !== activeMowerSn && (
                    <TouchableOpacity
                      style={styles.addDeviceRow}
                      onPress={() => setActiveMowerSn(set.mower!.sn)}
                      activeOpacity={0.7}
                    >
                      <View style={[styles.deviceIcon, { backgroundColor: 'rgba(0,212,170,0.15)' }]}>
                        <Ionicons name="power" size={16} color={colors.emerald} />
                      </View>
                      <Text style={[styles.addDeviceText, { color: colors.emerald, fontWeight: '700' }]}>
                        Activate this set
                      </Text>
                      <Ionicons name="chevron-forward" size={16} color={colors.emerald} />
                    </TouchableOpacity>
                  )}

                  {paired && set.mower!.sn === activeMowerSn && (
                    <View style={[styles.addDeviceRow, { opacity: 0.6 }]}>
                      <View style={[styles.deviceIcon, { backgroundColor: 'rgba(0,212,170,0.1)' }]}>
                        <Ionicons name="checkmark-circle" size={16} color={colors.emerald} />
                      </View>
                      <Text style={[styles.addDeviceText, { color: colors.emerald }]}>Active</Text>
                    </View>
                  )}

                  {/* Unpaired mower — pair with charger */}
                  {needsCharger && (
                    <TouchableOpacity
                      style={styles.addDeviceRow}
                      onPress={() => handlePairMower(set.mower!.sn)}
                      activeOpacity={0.7}
                    >
                      <View style={[styles.deviceIcon, { backgroundColor: 'rgba(124,58,237,0.15)' }]}>
                        <Ionicons name="link" size={16} color={colors.purple} />
                      </View>
                      <Text style={styles.addDeviceText}>{t('pairWithCharger')}</Text>
                      <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
                    </TouchableOpacity>
                  )}

                  {/* Missing mower — call to action */}
                  {needsMower && (
                    <TouchableOpacity
                      style={styles.addDeviceRow}
                      onPress={() => (navigation as any).navigate('AppSettings', { screen: 'ProvisionFlow' })}
                      activeOpacity={0.7}
                    >
                      <View style={[styles.deviceIcon, { backgroundColor: 'rgba(0,212,170,0.1)' }]}>
                        <Ionicons name="add" size={16} color={colors.emerald} />
                      </View>
                      <Text style={styles.addDeviceText}>{t('connectMower')}</Text>
                      <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}

          {/* No mower at all */}
          {noMower && (
            <View style={styles.emptyCenter}>
              <View style={styles.emptyIconCircle}>
                <Ionicons name="construct-outline" size={48} color={colors.textMuted} />
              </View>
              <Text style={styles.emptyTitle}>{t('noMowerFound')}</Text>
              <Text style={styles.emptySubtitle}>
                {!connected
                  ? t('connectingToServer')
                  : chargerOnline
                    ? t('chargerOnlineAddMower')
                    : t('provisionChargerFirst')}
              </Text>
              {!connected && (
                <ActivityIndicator size="small" color={colors.emerald} style={{ marginTop: 16 }} />
              )}
            </View>
          )}

          {/* Action button */}
          {connected && (
            <TouchableOpacity
              style={styles.addMowerButton}
              onPress={() => (navigation as any).navigate('AppSettings', { screen: 'ProvisionFlow' })}
              activeOpacity={0.7}
            >
              <Ionicons name="add-circle-outline" size={20} color={colors.white} />
              <Text style={styles.addMowerText}>
                {noMower && !charger ? t('connectMower') : noMower ? t('connectMower') : t('reProvisionMower')}
              </Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      </View>
    );
  }

  // Apply optimistic override if set
  const displayActivity = activityOverride ?? mower.activity;
  const activityColor = getActivityColor(displayActivity);
  const batteryGlowColor = getBatteryGlowColor(mower.battery);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={[
        styles.scroll,
        { paddingBottom: Math.max(insets.bottom + 120, 132) },
      ]} refreshControl={
        <RefreshControl refreshing={refreshing} tintColor={colors.purple} onRefresh={handleRefresh} />
      }>
        {/* Global demo toggle */}


        {/* Top bar: connection + alert/history icons */}
        <View style={styles.topBar}>
          {/* Mower info — chevron picker shows active mower name + firmware
              version + rename icon; dropdown switches between bound mowers. */}
          <View style={styles.connectionRow}>
            <MowerPickerChevron
              onAddMower={() =>
                (navigation as any).navigate('AppSettings', { screen: 'ProvisionFlow' })
              }
              onRename={renameActiveMower}
            />
          </View>

          {/* Alert + History icons */}
          <View style={styles.topBarIcons}>
            <TouchableOpacity onPress={() => setShowAlerts(true)} style={styles.topBarIcon} activeOpacity={0.7}>
              <Ionicons name="notifications-outline" size={20} color={mower.hasError ? colors.red : colors.textDim} />
              {mower.hasError && <View style={styles.topBarBadge} />}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowHistory(true)} style={styles.topBarIcon} activeOpacity={0.7}>
              <Ionicons name="time-outline" size={20} color={colors.textDim} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Mower animation scene — nickname + rename live in the picker
            chevron now, so the scene is purely the animation. */}
        <MowerScene
          activity={displayActivity}
          battery={mower.battery}
          mowingProgress={mower.mowingProgress}
        />

        {/* Status card */}
        <View style={styles.statusCard}>
          {/* Activity header */}
          <View style={styles.activityRow}>
            {displayActivity === 'mowing' ? (
              <MowerIcon size={24} color={activityColor} />
            ) : (
              <Ionicons
                name={getActivityIcon(displayActivity)}
                size={24}
                color={activityColor}
              />
            )}
            <Text style={[styles.activityLabel, { color: activityColor }]}>
              {getActivityLabel(displayActivity, t)}
            </Text>
            {mower.mowingProgress > 0 && (displayActivity === 'mowing' || displayActivity === 'mapping' || displayActivity === 'returning') && (
              <Text style={[styles.progressText, { color: activityColor }]}>
                {mower.mowingProgress}%
              </Text>
            )}
          </View>

          {/* Progress bar — ook tijdens terugkeren naar de dock, zodat je de
              laatste coverage-state blijft zien totdat een volgende taak start.
              Novabot app doet hetzelfde: "Returning to the charging station"
              + "Progress: 88%" voor de afgelopen sessie. */}
          {mower.mowingProgress > 0 && (displayActivity === 'mowing' || displayActivity === 'mapping' || displayActivity === 'returning') && (
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${mower.mowingProgress}%` as any, backgroundColor: activityColor }]} />
            </View>
          )}


          {/* Mowing/mapping/returning: show progress map instead of battery ring.
              Returning gebruikt dezelfde kaart zodat je ziet waar de maaier geweest
              is (finished_area blijft in de cover_path state van de maaier zolang
              task_mode=1) en waar hij nu naartoe rijdt. */}
          {(displayActivity === 'mowing' || displayActivity === 'mapping' || displayActivity === 'returning') && activeMapPolygon.length >= 3 ? (
            <View style={styles.mowingMapPanel}>
              <MowingProgressMap
                polygon={activeMapPolygon}
                progress={mower.mowingProgress}
                pathDirection={mowSettings?.pathDirection ?? mower.pathDirection}
                fill
                interactive
                trail={mowingTrail}
                plannedPaths={plannedPaths}
                finishedAreas={parseFinishedAreas(
                  devices.get(mower.sn)?.sensors?.finished_area,
                  devices.get(mower.sn)?.sensors?.cover_map_id,
                )}
                activeAreaId={prefixedAreaId(
                  devices.get(mower.sn)?.sensors?.covering_area_id,
                  devices.get(mower.sn)?.sensors?.cover_map_id,
                )}
                activeAreaPoints={parseInt(devices.get(mower.sn)?.sensors?.covering_area_points ?? '0', 10) || undefined}
                liveCoverSegment={parseCoveringPoints(devices.get(mower.sn)?.sensors?.covering_points)}
                obstacles={obstaclePolygons}
                mowerPos={mower.mowerPosX != null && mower.mowerPosY != null ? { x: mower.mowerPosX, y: mower.mowerPosY } : null}
                mowerHeading={mower.mowerHeading ?? undefined}
              />
            </View>
          ) : (
            /* Battery ring + mower image (default) */
            <View style={[styles.batteryContainer, { shadowColor: batteryGlowColor, shadowRadius: 26, shadowOpacity: 1 }]}>
              <BatteryRing
                percentage={mower.battery}
                size={160}
                strokeWidth={10}
                charging={mower.batteryCharging}
              />
              <Animated.View style={[styles.batteryTextOverlay, { transform: [{ translateY: bounceAnim }, { scale: pulseAnim }] }]}>
                <Image
                  source={mower.online ? require('../../assets/mower.png') : require('../../assets/mower_offline.png')}
                  style={styles.mowerImage}
                />
                <View style={styles.batteryRow}>
                  <Text style={styles.batteryPercentage}>{mower.battery}</Text>
                  <Text style={styles.batteryPercSign}>%</Text>
                  {mower.batteryCharging && (
                    <Ionicons name="flash" size={14} color={colors.blue} style={{ marginLeft: 2 }} />
                  )}
                </View>
              </Animated.View>
            </View>
          )}

          <View style={styles.chipsGroup}>
            <View style={styles.chipsRow}>
              {mower.wifiRssi != null && (
                <View style={styles.chip}>
                  <Ionicons name="wifi" size={11} color={colors.textDim} />
                  <Text style={styles.chipText}>{mower.wifiRssi}</Text>
                </View>
              )}
              {mower.rtkSat != null && (
                <View style={styles.chip}>
                  <Ionicons name="navigate" size={11} color={colors.textDim} />
                  <Text style={styles.chipText}>{mower.rtkSat} sat</Text>
                </View>
              )}
              {devices.get(mower.sn)?.sensors?.cpu_temperature != null && (
                <View style={styles.chip}>
                  <Ionicons name="thermometer" size={11} color={colors.textDim} />
                  <Text style={styles.chipText}>{devices.get(mower.sn)?.sensors?.cpu_temperature}°</Text>
                </View>
              )}
            </View>

            <View style={styles.chipsRow}>
            {(displayActivity === 'mowing') && devices.get(mower.sn)?.sensors?.target_height && (
              <View style={styles.chip}>
                <Ionicons name="resize" size={11} color={colors.textDim} />
                <Text style={styles.chipText}>
                  {parseInt(devices.get(mower.sn)!.sensors.target_height ?? '0', 10) + 2} cm
                </Text>
              </View>
            )}
            {/* ETA chip — shown during active mowing. cov_estimate_time is
                in minutes (firmware convention, verified 2026-04-20). We also
                show elapsed cov_work_time so the user has both numbers.
                Hidden when returning/docking/idle because the estimate is
                stale or meaningless there. */}
            {(displayActivity === 'mowing') && (() => {
              const etaMin = parseFloat(devices.get(mower.sn)?.sensors?.cov_estimate_time ?? '');
              const elapsedMin = parseFloat(devices.get(mower.sn)?.sensors?.cov_work_time ?? '');
              const fmt = (mins: number) => {
                if (!isFinite(mins) || mins <= 0) return null;
                if (mins < 60) return `${Math.round(mins)}m`;
                const h = Math.floor(mins / 60);
                const m = Math.round(mins - h * 60);
                return m === 0 ? `${h}h` : `${h}h ${m}m`;
              };
              const etaLabel = fmt(etaMin);
              const elapsedLabel = fmt(elapsedMin);
              return (
                <>
                  {etaLabel && (
                    <View style={styles.chip}>
                      <Ionicons name="timer-outline" size={11} color={colors.textDim} />
                      <Text style={styles.chipText}>~{etaLabel} left</Text>
                    </View>
                  )}
                  {elapsedLabel && (
                    <View style={styles.chip}>
                      <Ionicons name="time-outline" size={11} color={colors.textDim} />
                      <Text style={styles.chipText}>{elapsedLabel}</Text>
                    </View>
                  )}
                </>
              );
            })()}
            {!mower.online && (
              <View style={[styles.chip, styles.chipOffline]}>
                <Ionicons name="cloud-offline" size={11} color={colors.red} />
                <Text style={[styles.chipText, { color: colors.red }]}>{t('offline')}</Text>
              </View>
            )}
            </View>

            {nextSchedule && (displayActivity === 'idle' || displayActivity === 'charging') && (
              <View style={styles.nextScheduleRow}>
                <View style={[styles.chip, styles.nextScheduleChip]}>
                  <MowerIcon size={14} color={colors.emerald} />
                  <Text style={[styles.chipText, { color: colors.emerald }]}>Next mow: {nextSchedule.day} {nextSchedule.time}</Text>
                </View>
              </View>
            )}
          </View>
        </View>

        {/* Rain overlay — placed right under the status card so it's
            visually paired with the battery panel (was buried below the
            error / warning banners which kept it off-screen most of the
            time). Auto-hides when there's no rain forecast within 3h. */}
        <View style={{ marginBottom: 16 }}>
          <RainOverlay mowerSn={mower.sn} />
        </View>

        {/* Error display */}
        {mower.hasError && (
          <View style={styles.errorCard}>
            <Ionicons name="alert-circle" size={22} color={colors.red} />
            <View style={styles.errorContent}>
              <Text style={styles.errorTitle}>
                Error {mower.errorStatus ?? mower.errorCode ?? ''}
              </Text>
              {mower.errorMsg && (
                <Text style={styles.errorMessage}>{mower.errorMsg}</Text>
              )}
            </View>
            <TouchableOpacity
              style={{ backgroundColor: 'rgba(239,68,68,0.15)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 }}
              onPress={async () => {
                try {
                  const url = await getServerUrl();
                  if (!url || !mower.sn) return;
                  const api = new ApiClient(url);
                  await api.sendCommand(mower.sn, { clear_error: {} });
                  await api.sendCommand(mower.sn, { quit_mapping_mode: { value: 1, cmd_num: Date.now() % 100000 } });
                } catch {}
              }}
            >
              <Text style={{ color: colors.red, fontSize: 12, fontWeight: '600' }}>Clear</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Dock-failed banner — shown when the mower attempted to return to
            the charger but could not dock (physical miss, sensor glitch, or
            path blocked). Mirrors Novabot's "Return to charge failed, please
            retry or manually move NOVABOT back" popup but inline so it stays
            actionable. Provides Retry (go_to_charge) and Cancel (stop_navigation
            + clear_error) so the user is not stuck in a phantom "Returning" UI. */}
        {mower.dockFailed && (
          <View style={[styles.errorCard, { backgroundColor: 'rgba(245,158,11,0.12)', borderColor: '#f59e0b' }]}>
            <Ionicons name="home-outline" size={22} color="#f59e0b" />
            <View style={styles.errorContent}>
              <Text style={[styles.errorTitle, { color: '#f59e0b' }]}>
                Return to charger failed
              </Text>
              <Text style={styles.errorMessage}>
                The mower couldn't dock. Retry, or move it back to the charger manually.
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <TouchableOpacity
                style={{ backgroundColor: 'rgba(59,130,246,0.18)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }}
                onPress={async () => {
                  try {
                    const url = await getServerUrl();
                    if (!url || !mower.sn) return;
                    const api = new ApiClient(url);
                    await api.sendCommand(mower.sn, { clear_error: {} });
                    await new Promise((r) => setTimeout(r, 400));
                    sendGoHome(mower.sn);
                    setOptimisticActivity('returning');
                  } catch {}
                }}
              >
                <Text style={{ color: '#3b82f6', fontSize: 12, fontWeight: '600' }}>Retry</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ backgroundColor: 'rgba(239,68,68,0.18)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }}
                onPress={async () => {
                  try {
                    const url = await getServerUrl();
                    if (!url || !mower.sn) return;
                    const api = new ApiClient(url);
                    await api.sendCommand(mower.sn, { stop_navigation: { cmd_num: Date.now() % 100000 } });
                    await new Promise((r) => setTimeout(r, 300));
                    await api.sendCommand(mower.sn, { clear_error: {} });
                    await api.sendCommand(mower.sn, { quit_mapping_mode: { value: 1, cmd_num: Date.now() % 100000 } });
                    setOptimisticActivity('idle');
                  } catch {}
                }}
              >
                <Text style={{ color: colors.red, fontSize: 12, fontWeight: '600' }}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Soft warning banner — dismissable, does NOT block the Mow button.
            Matches Novabot's UX: shows the firmware's own message so the user
            can read it, dismiss, and continue if they want. */}
        {mower.hasSoftWarning && !mower.dockFailed && (() => {
          const code = parseInt(String(mower.errorStatus ?? '0').match(/\d+/)?.[0] ?? '0', 10);
          if (dismissedSoftErrors.has(code)) return null;
          return (
            <View style={[styles.errorCard, { backgroundColor: 'rgba(245,158,11,0.1)', borderColor: '#f59e0b' }]}>
              <Ionicons name="warning-outline" size={22} color="#f59e0b" />
              <View style={styles.errorContent}>
                <Text style={[styles.errorTitle, { color: '#f59e0b' }]}>
                  Warning {mower.errorStatus ?? ''}
                </Text>
                <Text style={styles.errorMessage}>
                  {mower.errorMsg || 'Software not initialized. Please wait a moment and try again.'}
                </Text>
              </View>
              <TouchableOpacity
                style={{ backgroundColor: 'rgba(245,158,11,0.2)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 }}
                onPress={() => setDismissedSoftErrors(prev => new Set(prev).add(code))}
              >
                <Text style={{ color: '#f59e0b', fontSize: 12, fontWeight: '600' }}>Dismiss</Text>
              </TouchableOpacity>
            </View>
          );
        })()}

        {/* Action buttons */}
        <View style={styles.actionsCard}>
          <Text style={styles.actionsTitle}>{t('actions')}</Text>

          {(displayActivity === 'idle' || displayActivity === 'charging' || displayActivity === 'error') && (
            <View style={styles.actionRow}>
              {/* Split action: main "Start Mowing" + chevron voor extra modi */}
              {(() => {
                const noMap = mower.mapNum === 0 && serverMapCount === 0;
                const startDisabled = !mower.online || mower.hasError || noMap;
                const canShowChevron = (displayActivity === 'idle' || displayActivity === 'charging')
                  && mower.online && !mower.hasError && !noMap;
                return (
                  <View style={[styles.splitButtonWrap, startDisabled && { opacity: 1 }]}>
                    <TouchableOpacity
                      style={[
                        styles.splitButtonMain,
                        startDisabled ? styles.actionButtonDisabled : styles.actionButtonGreen,
                      ]}
                      onPress={() => {
                        if (noMap) {
                          (navigation as any).navigate('Map', { screen: 'Mapping' });
                          return;
                        }
                        setStartMowInitialMapId(null);
                        setShowStartMow(true);
                      }}
                      disabled={commandLoading !== null || startDisabled}
                      activeOpacity={0.7}
                    >
                      {commandLoading === 'start' ? (
                        <ActivityIndicator size="small" color={colors.white} />
                      ) : (
                        <>
                          <Ionicons name="play" size={20} color={startDisabled ? colors.textMuted : colors.white} />
                          <Text style={[styles.actionButtonText, startDisabled && { color: colors.textMuted }]}>
                            {/* "Start" i.p.v. "Start Mowing" — korter label
                                zodat het op smalle schermen blijft passen naast
                                de chevron. Disabled-states tonen wel de volledige
                                reden (no map / clear error). */}
                            {noMap ? t('noMapCreateFirst') : mower.hasError ? t('clearErrorFirst') : t('start')}
                          </Text>
                        </>
                      )}
                    </TouchableOpacity>
                    {canShowChevron && (
                      <>
                        <View style={styles.splitButtonDivider} />
                        <TouchableOpacity
                          style={[styles.splitButtonChevron, styles.actionButtonGreen]}
                          onPress={() => setShowStartModeSheet(true)}
                          disabled={commandLoading !== null}
                          activeOpacity={0.7}
                          accessibilityLabel="Show more start options"
                        >
                          <Ionicons name="chevron-down" size={18} color={colors.white} />
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                );
              })()}
              {/* Go Home button — when idle or error, but NOT on charger */}
              {(displayActivity === 'idle' || displayActivity === 'error') && !mower.batteryCharging && (
                <TouchableOpacity
                  style={[styles.actionButton, styles.actionButtonBlue]}
                  onPress={() => { sendGoHome(mower.sn); setOptimisticActivity('returning'); }}
                  disabled={commandLoading !== null || !mower.online}
                  activeOpacity={0.7}
                >
                  {commandLoading === 'home' ? (
                    <ActivityIndicator size="small" color={colors.white} />
                  ) : (
                    <Ionicons name="home" size={20} color={colors.white} />
                  )}
                </TouchableOpacity>
              )}
            </View>
          )}

          {displayActivity === 'mowing' && (
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonAmber]}
                onPress={() => {
                  sendCommand(mower.sn, { pause_navigation: { cmd_num: ++cmdNumRef.current } }, 'pause');
                  setOptimisticActivity('paused');
                }}
                disabled={commandLoading !== null}
                activeOpacity={0.7}
              >
                {commandLoading === 'pause' ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <>
                    <Ionicons name="pause" size={20} color={colors.white} />
                  </>
                )}
              </TouchableOpacity>
              {/* Stop-knop weggelaten tijdens mowing — als je wil stoppen
                  klik je Home (End task & return / Pause then dock).
                  Een blote stop_navigation laat de maaier midden op het gazon
                  staan wat zelden is wat je wilt; Home handelt dat netjes af. */}
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonBlue]}
                onPress={() => {
                  Alert.alert(
                    t('returnHome') || 'Return Home',
                    t('returnHomeDesc') || 'How should the mower return to the charging station?',
                    [
                      {
                        text: t('endTaskReturn') || 'End task & return',
                        onPress: () => {
                          sendCommand(mower.sn, { stop_navigation: { cmd_num: ++cmdNumRef.current } }, 'stop');
                          setTimeout(() => { sendGoHome(mower.sn); }, 500);
                          setOptimisticActivity('returning');
                        },
                      },
                      {
                        text: t('pauseTaskReturn') || 'Pause task & return',
                        onPress: () => {
                          sendCommand(mower.sn, { pause_navigation: { cmd_num: ++cmdNumRef.current } }, 'pause');
                          setTimeout(() => { sendGoHome(mower.sn); }, 500);
                          setOptimisticActivity('returning');
                        },
                      },
                      { text: t('cancel') || 'Cancel', style: 'cancel' },
                    ],
                  );
                }}
                disabled={commandLoading !== null}
                activeOpacity={0.7}
              >
                {commandLoading === 'home' ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <>
                    <Ionicons name="home" size={20} color={colors.white} />
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}

          {displayActivity === 'paused' && (() => {
            // Pauze-duur berekenen voor UX-waarschuwing. Boven de drempel
            // blokkeren we de Resume-knop NIET (firmware kan alsnog goed
            // gaan), maar we tonen een opvallende waarschuwing + een extra
            // "Stop & return" optie omdat resume na lange pauze risicovol is.
            const pausedMs = pauseStartedAt != null ? pauseNowMs - pauseStartedAt : 0;
            const pausedMin = Math.floor(pausedMs / 60000);
            const isLongPause = pausedMs > LONG_PAUSE_THRESHOLD_MS;
            const pausedLabel = pausedMin >= 60
              ? `${Math.floor(pausedMin / 60)}h ${pausedMin % 60}m`
              : `${pausedMin}m`;
            return (
              <>
                {isLongPause && !dismissedLongPauseWarning && (
                  <View style={[styles.errorCard, { backgroundColor: 'rgba(245,158,11,0.12)', borderColor: '#f59e0b', marginHorizontal: 0, marginBottom: 10 }]}>
                    <Ionicons name="warning-outline" size={22} color="#f59e0b" />
                    <View style={styles.errorContent}>
                      <Text style={[styles.errorTitle, { color: '#f59e0b' }]}>
                        Paused for {pausedLabel}
                      </Text>
                      <Text style={styles.errorMessage}>
                        Long pauses can cause localization drift. Resume may drive the mower off the map (firmware error 140). Consider stopping and starting a fresh session from the dock.
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={{ backgroundColor: 'rgba(245,158,11,0.18)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }}
                      onPress={() => setDismissedLongPauseWarning(true)}
                    >
                      <Text style={{ color: '#f59e0b', fontSize: 12, fontWeight: '600' }}>Dismiss</Text>
                    </TouchableOpacity>
                  </View>
                )}
                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={[
                      styles.actionButton,
                      isLongPause ? styles.actionButtonAmber : styles.actionButtonGreen,
                    ]}
                    onPress={() => {
                      if (isLongPause) {
                        Alert.alert(
                          `Paused for ${pausedLabel}`,
                          'Long pauses can cause localization drift. The mower may drive outside the map on resume. Continue anyway?',
                          [
                            { text: 'Cancel', style: 'cancel' },
                            {
                              text: 'Resume anyway', style: 'destructive',
                              onPress: () => {
                                sendCommand(mower.sn, { resume_navigation: { cmd_num: ++cmdNumRef.current } }, 'resume');
                                setOptimisticActivity('mowing');
                              },
                            },
                          ],
                        );
                      } else {
                        sendCommand(mower.sn, { resume_navigation: { cmd_num: ++cmdNumRef.current } }, 'resume');
                        setOptimisticActivity('mowing');
                      }
                    }}
                    disabled={commandLoading !== null}
                    activeOpacity={0.7}
                  >
                    {commandLoading === 'resume' ? (
                      <ActivityIndicator size="small" color={colors.white} />
                    ) : (
                      <Ionicons name="play" size={20} color={colors.white} />
                    )}
                  </TouchableOpacity>
                  {isLongPause && (
                    <TouchableOpacity
                      style={[styles.actionButton, styles.actionButtonRed]}
                      onPress={async () => {
                        try {
                          const url = await getServerUrl();
                          if (!url || !mower?.sn) return;
                          const api = new ApiClient(url);
                          await api.sendCommand(mower.sn, { stop_navigation: { cmd_num: Date.now() % 100000 } });
                          await new Promise(r => setTimeout(r, 300));
                          await api.sendCommand(mower.sn, { clear_error: {} });
                          await api.sendCommand(mower.sn, { quit_mapping_mode: { value: 1, cmd_num: Date.now() % 100000 } });
                          setOptimisticActivity('idle');
                        } catch {}
                      }}
                      disabled={commandLoading !== null}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="stop" size={20} color={colors.white} />
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={[styles.actionButton, styles.actionButtonBlue]}
                    onPress={() => { sendGoHome(mower.sn); setOptimisticActivity('returning'); }}
                    disabled={commandLoading !== null}
                    activeOpacity={0.7}
                  >
                    {commandLoading === 'home' ? (
                      <ActivityIndicator size="small" color={colors.white} />
                    ) : (
                      <Ionicons name="home" size={20} color={colors.white} />
                    )}
                  </TouchableOpacity>
                </View>
              </>
            );
          })()}

          {displayActivity === 'returning' && (
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonRed]}
                onPress={() =>
                  sendCommand(mower.sn, { stop_navigation: { cmd_num: ++cmdNumRef.current } }, 'stop')
                }
                disabled={commandLoading !== null}
                activeOpacity={0.7}
              >
                {commandLoading === 'stop' ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <>
                    <Ionicons name="stop" size={20} color={colors.white} />
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}

          {!mower.online && (
            <Text style={styles.offlineNote}>
              {t('mowerOffline')}
            </Text>
          )}
        </View>

        {/* Command error */}
        {commandError !== '' && (
          <View style={styles.commandError}>
            <Ionicons name="alert-circle" size={16} color={colors.red} />
            <Text style={styles.commandErrorText}>{commandError}</Text>
          </View>
        )}

        {/* Serial number */}
        <Text style={styles.snText}>SN: {mower.sn}</Text>
      </ScrollView>

      {/* History modal */}
      <Modal visible={showHistory} animationType="slide" presentationStyle="pageSheet">
        <View style={styles.modalHeader}>
          <TouchableOpacity onPress={() => setShowHistory(false)} style={styles.modalClose}>
            <Ionicons name="close" size={24} color={colors.textDim} />
          </TouchableOpacity>
        </View>
        <HistoryScreen />
      </Modal>

      {/* Cutting-height picker voor edge & spot mow. Vuurt het juiste commando
          af met de gekozen hoogte — edge heeft geen hoogte-parameter in de
          firmware, dus we zetten de hoogte vóór start_patrol via set_para_info. */}
      {mower && heightPicker && (
        <CuttingHeightPickerModal
          visible={!!heightPicker}
          title={heightPicker.title}
          message={heightPicker.message}
          confirmLabel={heightPicker.confirmLabel}
          initialHeightCm={mowSettings?.cuttingHeight != null
            ? mowSettings.cuttingHeight + 2
            : parseInt(devices.get(mower.sn)?.sensors?.target_height ?? '', 10)
              ? parseInt(devices.get(mower.sn)?.sensors?.target_height ?? '5', 10) + 2
              : 5}
          onCancel={() => setHeightPicker(null)}
          onConfirm={async (heightCm) => {
            const picked = heightPicker;
            setHeightPicker(null);
            if (!mower) return;
            // Wire value = display cm − 2 (see cutting-height-mapping.md).
            const wire = Math.max(0, heightCm - 2);
            try {
              const url = await getServerUrl();
              if (!url) return;
              const api = new ApiClient(url);
              // Pre-set de hoogte. Voor start_run gaat cutGrassHeight in het
              // command zelf; voor start_patrol is er geen height-param, dus
              // we sturen set_para_info eerst.
              await api.sendCommand(mower.sn, {
                set_para_info: { defaultCuttingHeight: wire },
              }).catch(() => { /* non-fatal */ });

              if (picked.mode === 'edge') {
                sendCommand(mower.sn, { start_patrol: null }, 'patrol');
              } else if (picked.mode === 'spot' && picked.spotPolygon) {
                await api.sendCommand(mower.sn, {
                  start_run: {
                    mapNames: ['home'],
                    cutGrassHeight: (wire + 2) * 10, // mm
                    startWay: 1, // SPECIFIED_AREA
                    workArea: picked.spotPolygon,
                    schedule: false,
                    scheduleId: '',
                  },
                });
              }
              setOptimisticActivity('mowing');
              // Update local mowSettings so subsequent status checks line up.
              setMowSettings({ cuttingHeight: wire, pathDirection: mowSettings?.pathDirection ?? 120 });
            } catch {}
          }}
        />
      )}

      {/* Alerts modal */}
      {/* Start Mow Sheet */}
      {mower && (
        <StartMowSheet
          visible={showStartMow}
          onClose={() => {
            setShowStartMow(false);
            setStartMowInitialMapId(null);
            setStartMowForceZone(false);
          }}
          sn={mower.sn}
          onStarted={(settings) => { setCommandLoading(null); setOptimisticActivity('mowing'); setMowSettings(settings); setMowingTrail([]); }}
          initialSelectedMapId={startMowInitialMapId}
          forceZonePicker={startMowForceZone}
          battery={mower.battery}
          isWorking={displayActivity === 'mowing' || displayActivity === 'mapping'}
          currentCuttingHeight={parseInt(devices.get(mower.sn)?.sensors?.target_height ?? '', 10) || undefined}
          currentPathDirection={parseInt(devices.get(mower.sn)?.sensors?.path_direction ?? '', 10) || undefined}
        />
      )}

      {/* Start-mode alternatives opened via the chevron next to Start Mowing. */}
      {mower && (() => {
        // Gebruik serverMapCount die al in loadHomeMeta is geteld (alleen
        // work-maps met mapArea >= 3). Scheelt ook dubbele map-fetch.
        const workZoneCount = serverMapCount;
        const mowerLat = parseFloat(devices.get(mower.sn)?.sensors?.latitude ?? '');
        const mowerLng = parseFloat(devices.get(mower.sn)?.sensors?.longitude ?? '');
        const hasMowerGps = isFinite(mowerLat) && isFinite(mowerLng)
          && mowerLat !== 0 && mowerLng !== 0;

        const items: AppActionSheetItem[] = [
          {
            label: 'Full mow',
            subtitle: 'Cover the entire work area with your chosen pattern',
            icon: 'play-circle-outline',
            onPress: () => {
              setStartMowInitialMapId(null);
              setStartMowForceZone(false);
              setShowStartMow(true);
            },
          },
        ];

        // Specific zone — only useful if there are multiple zones; with one
        // zone "full mow" already mows that single zone, so this entry would
        // just duplicate it.
        if (workZoneCount > 1) {
          items.push({
            label: 'Specific zone',
            subtitle: 'Pick one zone to mow (skip the others)',
            icon: 'layers-outline',
            onPress: () => {
              setStartMowInitialMapId(null);
              setStartMowForceZone(true);
              setShowStartMow(true);
            },
          });
        }

        items.push({
          label: 'Edges only',
          subtitle: 'Drive along the boundary once (boundary follow)',
          icon: 'ellipse-outline',
          onPress: () => {
            // User-spec: ook edge-mow vraagt om bevestiging + maaihoogte.
            setHeightPicker({
              mode: 'edge',
              title: 'Edge mowing',
              message: 'The mower will drive along the boundary of your work area — good for a quick edge trim. Pick the cutting height, then Start.',
              confirmLabel: 'Start edges',
            });
          },
        });

        // Spot mow — send start_run with a small circular workArea (~2 m
        // radius, 12 GPS points) centered on the mower's CURRENT position.
        // Typical workflow: drive mower to the spot you want trimmed with
        // the Control joystick, then tap this option. Firmware interprets
        // this as SPECIFIED_AREA (cov_mode=1) and does a mini coverage pass.
        items.push({
          label: 'Spot mow',
          subtitle: hasMowerGps
            ? 'Mow a small 2m circle at the mower\'s current position'
            : 'Needs GPS fix — waiting for mower position',
          icon: 'locate-outline',
          disabled: !hasMowerGps,
          onPress: () => {
            if (!hasMowerGps) return;
            // Build 12-vertex circle polygon in GPS coords. 2m radius:
            //   lat:  R / 111_320
            //   lng:  R / (111_320 * cos(lat_rad))
            const R = 2.0;
            const latRad = (mowerLat * Math.PI) / 180;
            const dLat = R / 111_320;
            const dLng = R / (111_320 * Math.max(Math.cos(latRad), 0.01));
            const N = 12;
            const polygon: Array<{ latitude: number; longitude: number }> = [];
            for (let i = 0; i < N; i++) {
              const a = (i / N) * 2 * Math.PI;
              polygon.push({
                latitude: mowerLat + Math.sin(a) * dLat,
                longitude: mowerLng + Math.cos(a) * dLng,
              });
            }
            // User-spec: ook spot-mow vraagt om bevestiging + maaihoogte.
            setHeightPicker({
              mode: 'spot',
              title: 'Spot mow',
              message: 'The mower will mow a 2m radius circle at its current position. Make sure it\'s already at the spot you want trimmed (use the Control joystick first if needed).',
              confirmLabel: 'Start here',
              spotPolygon: polygon,
            });
          },
        });

        return (
          <AppActionSheet
            visible={showStartModeSheet}
            title={t('startMowing')}
            message="Choose a mowing mode"
            onClose={() => setShowStartModeSheet(false)}
            actions={items}
          />
        );
      })()}

      <Modal visible={showAlerts} animationType="slide" presentationStyle="pageSheet">
        <View style={styles.modalHeader}>
          <TouchableOpacity onPress={() => setShowAlerts(false)} style={styles.modalClose}>
            <Ionicons name="close" size={24} color={colors.textDim} />
          </TouchableOpacity>
        </View>
        <MessagesScreen />
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  topBarIcons: {
    flexDirection: 'row',
    gap: 4,
  },
  topBarIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  topBarBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.red,
    borderWidth: 1.5,
    borderColor: colors.bg,
  },
  modalHeader: {
    backgroundColor: colors.bg,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  modalClose: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  connectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  connectionText: {
    fontSize: 13,
    color: colors.textDim,
  },
  connectionSpacer: {
    width: 16,
  },
  emptyScroll: {
    padding: 24,
    paddingBottom: 32,
  },
  emptyCenter: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  offlineMowerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 16,
    marginBottom: 16,
  },
  offlineMowerImage: {
    width: 56,
    height: 56,
    resizeMode: 'contain',
    opacity: 0.5,
  },
  offlineMowerTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.red,
    marginBottom: 2,
  },
  offlineMowerSn: {
    fontSize: 11,
    color: colors.textDim,
    fontFamily: 'monospace',
    marginBottom: 6,
  },
  offlineMowerHint: {
    fontSize: 12,
    color: colors.textMuted,
    lineHeight: 16,
  },
  emptyIconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: 'rgba(255,255,255,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.white,
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 15,
    color: colors.textDim,
    textAlign: 'center',
    lineHeight: 22,
  },
  setCard: {
    backgroundColor: colors.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginBottom: 16,
    overflow: 'hidden',
  },
  setCardActive: {
    borderColor: 'rgba(0,212,170,0.25)',
  },
  setHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 4,
  },
  setTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  setLora: {
    fontSize: 10,
    color: colors.textMuted,
    fontFamily: 'monospace',
  },
  addDeviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.04)',
  },
  addDeviceText: {
    flex: 1,
    fontSize: 14,
    color: colors.emerald,
    fontWeight: '500',
  },
  deviceIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  deviceName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.white,
  },
  deviceSn: {
    fontSize: 11,
    color: colors.textDim,
    fontFamily: 'monospace',
    marginTop: 1,
  },
  deviceDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  deviceStatus: {
    fontSize: 12,
    fontWeight: '600',
    width: 48,
  },
  deleteBtn: {
    marginLeft: 8,
    padding: 4,
  },
  hintCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  hintText: {
    flex: 1,
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 18,
  },
  chargerCard: {
    width: '100%',
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 16,
    marginBottom: 24,
  },
  chargerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  chargerTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.white,
  },
  chargerSn: {
    fontSize: 11,
    color: colors.textDim,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  chargerDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  addMowerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 20,
    paddingVertical: 12,
    paddingHorizontal: 24,
    backgroundColor: colors.emerald,
    borderRadius: 12,
  },
  addMowerText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.white,
  },
  statusCard: {
    backgroundColor: colors.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
  },
  activityLabel: {
    fontSize: 22,
    fontWeight: '700',
  },
  progressText: {
    fontSize: 16,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  progressTrack: {
    width: '100%',
    height: 6,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 3,
    marginBottom: 16,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  batteryContainer: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  mowingMapPanel: {
    // Cancel statusCard's horizontal padding (18) so the map spans the full
    // card width edge-to-edge — matches Novabot's large square preview inside
    // the status panel. aspectRatio keeps it a square so pan/zoom feels right.
    alignSelf: 'stretch',
    marginHorizontal: -18,
    width: undefined,
    aspectRatio: 1,
    marginTop: 4,
    marginBottom: 12,
    backgroundColor: 'rgba(15,23,42,0.35)',
    borderRadius: 14,
    overflow: 'hidden',
    alignItems: 'stretch',
    justifyContent: 'center',
  },
  batteryTextOverlay: {
    position: 'absolute',
    alignItems: 'center',
  },
  mowerImage: {
    width: 48,
    height: 48,
    resizeMode: 'contain',
    marginBottom: 2,
  },
  batteryRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  batteryPercentage: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.white,
  },
  batteryPercSign: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textDim,
    marginLeft: 1,
  },
  chipsGroup: {
    width: '100%',
    gap: 6,
  },
  chipsRow: {
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 12,
  },
  chipOffline: {
    backgroundColor: 'rgba(239,68,68,0.1)',
  },
  nextScheduleRow: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  nextScheduleChip: {
    backgroundColor: 'rgba(34,197,94,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.2)',
    paddingVertical: 2,
  },
  chipText: {
    fontSize: 11,
    color: colors.textDim,
  },
  errorCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.2)',
    padding: 16,
    marginBottom: 16,
    gap: 12,
  },
  errorContent: {
    flex: 1,
  },
  errorTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.red,
    marginBottom: 4,
  },
  errorMessage: {
    fontSize: 13,
    color: 'rgba(239,68,68,0.8)',
    lineHeight: 18,
  },
  actionsCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 16,
    marginBottom: 12,
  },
  actionsTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: 12,
    gap: 8,
  },
  actionButtonGreen: {
    backgroundColor: colors.green,
  },
  actionButtonAmber: {
    backgroundColor: colors.amber,
  },
  actionButtonBlue: {
    backgroundColor: colors.blue,
  },
  actionButtonRed: {
    backgroundColor: colors.red,
  },
  actionButtonGray: {
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  actionButtonDisabled: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  actionButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.white,
  },
  // Split-action button — hoofd-knop + kleine chevron-knop aan de rechterkant.
  // Beide helften delen hoogte + achtergrond; een dunne verticale divider
  // scheidt ze optisch zodat het duidelijk is dat de chevron een aparte
  // tap-target is (gebruikt voor de Edges-only dropdown).
  splitButtonWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'stretch',
    height: 48,
    borderRadius: 12,
    overflow: 'hidden',
  },
  splitButtonMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  splitButtonDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  splitButtonChevron: {
    width: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  offlineNote: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 8,
  },
  commandError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 16,
  },
  commandErrorText: {
    fontSize: 13,
    color: colors.red,
  },
  snText: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    fontFamily: 'monospace',
  },
});
