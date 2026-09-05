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
  ActivityIndicator,
  Animated,
  Image,
  Modal,
  Alert,
} from 'react-native';
import { appAlertCompat } from '../context/AppAlertContext';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Svg, { Path as SvgPath } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { useTheme, useStyles, type Colors } from '../theme';
import { BatteryRing } from '../components/BatteryRing';
import { MowerScene } from '../components/mower/MowerScene';
import { MOWER_SVG_PATH } from '../components/mower/mowerIconPath';
import { UnicomTransitAnimation } from '../components/UnicomTransitAnimation';
import { useMowerState } from '../hooks/useMowerState';
import { useActiveMower } from '../hooks/useActiveMower';
import { useActiveMowerContext } from '../context/ActiveMowerContext';
import { isOpenNovaFirmware } from '../utils/firmwareCapability';
import { fixQualityLabel } from '../utils/fixQuality';
import { parseFinishedAreas, prefixedAreaId, parseCoveringPoints } from '../utils/coverPathProgress';
import { MowerPickerChevron } from '../components/MowerPickerChevron';
import { ApiClient, type MapData, type Schedule } from '../services/api';
import { getServerUrl, getToken } from '../services/auth';
import { flushPendingMapSync } from '../services/pendingMapSync';
import { DemoBanner } from '../components/DemoBanner';
import { HealthBanner } from '../components/HealthBanner';
import { FirmwareUpdateBanner } from '../components/FirmwareUpdateBanner';
import { MowingProgressMap } from '../components/MowingProgressMap';
import { resolveMowingMapSelection, gateCoverTelemetry, type CoverTelemetryBaseline } from '../utils/mowingMapSelection';
import HistoryScreen from './HistoryScreen';
import MessagesScreen from './MessagesScreen';
import { useDemo } from '../context/DemoContext';
import { StartMowSheet } from '../components/StartMowSheet';
import { RainOverlay } from '../components/RainOverlay';
import {
  ReturnReasonModal,
  deriveReturnReason,
  RETURN_REASON_META,
  type ReturnReason,
} from '../components/ReturnReasonModal';
import { AppActionSheet, type AppActionSheetItem } from '../components/AppActionSheet';
import CuttingHeightPickerModal from '../components/CuttingHeightPickerModal';
import ReanchorWizard from '../components/ReanchorWizard';
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
  /** Blade RPM relayed via novabot/sensor/<SN> from /blade_speed_get. */
  bladeSpeed: number;
  /** True when activity = mowing/edge_cutting AND blade RPM = 0 — the
   *  mower thinks it's mowing but the blades aren't actually turning.
   *  Caught the LFIN1231000211 incident 2026-05-21 where a stuck
   *  state-machine left blades at height 7 (raised) so the cutter
   *  motor never engaged. Warning prompts the user to power-cycle
   *  before the mower drives the whole lawn without cutting. */
  bladeStuckWarning: boolean;
  /** Server-translated work_status label (e.g. "Mowing", "Avoiding obstacle").
   *  Finer-grained than `activity`; shown as a chip during active mowing. */
  workStatusLabel: string | null;
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
  /** Live driving speed in m/s, derived server-side from the pose stream. */
  driveSpeed: number;
  /** Forwarded from `DeviceState.firmwareVersion` so the capability gates
   *  (edge cut, joystick, camera) can read it without a second lookup. */
  firmwareVersion: string | null;
  /** Target zone slot (e.g. "map3") from the latest `mow_zone_status`, used
   *  by the `following_unicom` copy ("Moving to {{zone}}..."). Null when no
   *  mow_zone transit has streamed a status yet. */
  mowZoneMap: string | null;
}

function previewMapIdsFromMaps(maps: MapData[]): number {
  const weights = new Set<number>();
  for (const map of maps) {
    const source = map.canonicalName ?? map.mapId;
    const match = source.match(/^map(\d+)$/);
    if (!match) continue;
    const idx = Number(match[1]);
    if (idx === 0) weights.add(1);
    else if (idx === 1) weights.add(10);
    else if (idx === 2) weights.add(100);
  }
  const mask = Array.from(weights).reduce((sum, value) => sum + value, 0);
  return mask || 1;
}

// ── Cover path helpers ──────────────────────────────────────────────
// Verplaatst naar de gedeelde util (app + dashboard): app/src/utils/coverPathProgress.ts.
// parseFinishedAreas / prefixedAreaId / parseCoveringPoints worden bovenaan geïmporteerd.

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
  // 139 = "Charging station position error" — fires on a spurious [0,0,0]
  //       charging pose (map_info.json) even when the dock is physically fine.
  //       Treat as a warning so it never blocks operating the mower.
  // 2 =  "Already in running task" — een geweigerde dubbele start terwijl de
  //       taak gewoon loopt. Sinds de mow_zone→start_navigation fallback in
  //       StartMowSheet is dit een verwacht race-bijproduct: de maai draait
  //       prima, dus blokkeren/badgen is misleidend. Alleen in Berichten.
  const NON_BLOCKING_ERRORS = [2, 8, 113, 118, 120, 122, 123, 124, 125, 126, 132, 139];
  // Codes the stock Novabot app NEVER surfaces to the user — they fire so
  // often (LoRa flicker, transient perception/data-loss) and self-recover so
  // quickly that showing a banner each time becomes noise. Mirror that
  // suppression so OpenNova matches stock UX. Same set as the server-side
  // SUPPRESSED_ERROR_CODES in eventDetector.ts that gates ntfy.
  const HIDDEN_TRANSIENT_ERRORS = [2, 8, 113, 132];
  const errorStatusRaw = parseInt(s.error_status?.match(/\d+/)?.[0] ?? '0', 10);
  const hasError = Boolean(
    errorStatusRaw > 0 && !NON_BLOCKING_ERRORS.includes(errorStatusRaw),
  );
  const batteryState = s.battery_state?.toUpperCase() ?? '';
  const isChargingNow = batteryState === 'CHARGING' || batteryState === 'FINISHED';
  const STALE_WHEN_CHARGING = [124, 126];
  const isStaleChargeError =
    isChargingNow && STALE_WHEN_CHARGING.includes(errorStatusRaw);
  const isHiddenTransient = HIDDEN_TRANSIENT_ERRORS.includes(errorStatusRaw);
  const hasSoftWarning =
    errorStatusRaw > 0 &&
    NON_BLOCKING_ERRORS.includes(errorStatusRaw) &&
    !isStaleChargeError &&
    !isHiddenTransient;

  // Activity detection based on firmware report_state_robot fields:
  // - battery_state: "CHARGING" (on dock) / "DISCHARGED" (off dock)
  // - task_mode: 1=COVERAGE, 2=MAPPING
  // - work_status: 0=WAIT, 1=WORKING, 9=FINISHED (firmware-specific, not reliable alone)
  // - recharge_status: 0=IDLE, 1=GOING, 9=FINISHED
  // - msg: "Mode:COVERAGE Work:RUNNING" etc.
  const taskMode = parseInt(s.task_mode ?? '0', 10);
  // recharge_status komt afhankelijk van het pad RUW ("50") of VERTAALD
  // ("Charging (50)", of kaal "Charging" voor code 1) binnen. parseInt op het
  // label gaf NaN, waardoor de hele numerieke returning-lijst sinds de
  // vertaling DODE code was (#31). Cijfer-extractie dekt beide vormen.
  const rechargeRaw = s.recharge_status ?? '0';
  const rechargeStatus = rechargeRaw === 'Charging'
    ? 1
    : parseInt(rechargeRaw.match(/\d+/)?.[0] ?? '0', 10);
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
  // Issue #31: post-finished return-to-charge slipped through this check
  // because firmware v5.7.1 emits `Recharge: ALIGN_PILE` / recharge_status
  // values like 191/193 mid-dock that the original list never covered, so
  // the mower showed "Idle" while it was driving to the charger. Broaden
  // both the numeric and the msg-substring matches to all known
  // "transitional dock states", excluding only the two terminal ones:
  //    9   = FINISHED (charging complete)
  //    0   = NONE (not docking)
  // Anything else with task_mode === 1 (we were running coverage) is a
  // returning state.
  // 50/53 erbij: stock 5.7.1 rapporteert de terugrit NA het afmaken met die
  // codes (#31, waltervl's live data) — de msg matcht daar geen enkele regex,
  // dus alleen het nummer verraadt de rit. De numerieke match wordt wel
  // onderdrukt zodra msg expliciet "Recharge: FINISHED" zegt: laden-klaar is
  // zeker geen terugrit, en dat vangt een eventueel blijven hangen nummer af
  // nu de (jarenlang dode) numerieke tak weer echt meedoet.
  const RETURNING_RECHARGE_STATUS = new Set([1, 2, 50, 53, 191, 192, 193]);
  const rechargeTerminal = /Recharge:\s*FINISHED/i.test(msg);
  const isReturning = (
    (RETURNING_RECHARGE_STATUS.has(rechargeStatus) && !rechargeTerminal)
    || /Recharge:\s*(GOING|ALIGN_PILE|ALIGNING|MOVING|RUNNING|BACK|DOCKING)/i.test(msg)
    || msg.includes('Work:GO_PILE')
    || msg.includes('Work:BACK_CHARGER')
    || msg.includes('Work:DOCKING')
  ) && !isDockFailed && !isOnDock;
  // "Sticky" mowing: off dock + coverage mode + work not explicitly stopped/finished
  // Prevents flicker during lane transitions (brief Work:WAIT between lanes)
  // But NOT sticky when returning home or explicitly cancelled/finished
  //
  // The server translates work_status numeric → human label (sensorData.ts
  // WORK_STATUS_LABELS). Check both raw and translated forms so the UI
  // works regardless of which side does the translation. Idle-like states
  // (mower not actively executing a coverage path):
  //   '0'/'Idle', '9'/'Ready', '70'/'Finished once', '72'/'Cancelled'
  const IDLE_WORK_STATES = ['0', '9', '70', '72', 'Idle', 'Ready', 'Finished once', 'Cancelled'];
  // Work:FAILED counts as idle too: a mow that failed to START (e.g. Error 124
  // "out of working area") lands in Work:FAILED but the firmware keeps reporting
  // task_mode:1 + work_status:1 (WORKING). Without this the app shows a phantom
  // "mowing" state with a Stop button that does nothing — the mower isn't mowing,
  // so the firmware rejects Stop with "not in working status". Trust the msg.
  const isMowingSticky = !isOnDock && taskMode === 1 && !isReturning
    && !msg.includes('Work:FINISHED') && !msg.includes('Work:CANCELLED')
    && !msg.includes('Work:FAILED')
    && !IDLE_WORK_STATES.includes(workStatus);

  // Edge-cut state is surfaced by the firmware via extended_response edge_cut_status
  // → server writes `edge_active` ('0'/'1') + supporting fields to the sensor cache.
  // Because we bypass robot_decision when dispatching NTCP with only_edge_mode, the
  // regular msg/work_status fields don't reflect BOUNDARY_COVERING. This dedicated
  // sensor is the one source of truth for the edge-cutting activity.
  const isEdgeCutting = s.edge_active === '1' && !isOnDock;

  // mow_zone overlay state (research/documents/unicom-follow-transit-design.md):
  // the mower-side `mow_zone` orchestrator streams `{ phase, map }` on the
  // extended_response channel while it drives the recorded unicom line
  // between zones. The server mirrors this into `mow_zone_phase` /
  // `mow_zone_map` (mirrors the edge_active pattern above). Only the
  // `following_unicom` phase gets its own activity — `undocking` and
  // `covering` fall back to the normal report_state_robot detection above,
  // and `done`/`error` simply stop matching here so the state clears itself
  // once the next phase update arrives.
  const isFollowingUnicom = s.mow_zone_phase === 'following_unicom' && !isOnDock;

  // Mapping detection mirrors MappingScreen (the authoritative one): trust
  // msg + task_mode, and treat the post-save echo (Work:FINISHED / Work:WAIT)
  // as DONE. start_edit_or_assistant_map_flag is unreliable — mqtt_node leaves
  // it '1' indefinitely after a save, and msg/task_mode freeze on the last
  // report_state_robot (the periodic report_state_timer_data carries neither),
  // so the raw flag stranded HomeScreen on 'mapping' forever after an obstacle
  // add even though the mower itself had already left mapping mode.
  const inMappingMode = taskMode === 2 || taskMode === 3 || msg.includes('Mode:MAPPING');
  const isMappingPostSave = msg.includes('Work:FINISHED') || msg.includes('Work:WAIT');
  const isMappingActive = inMappingMode && !isMappingPostSave;

  let activity: MowerActivity = 'idle';
  if (isOffline) activity = 'idle';
  else if (hasError && !isOnDock) activity = 'error';
  else if (isDockFailed && !isOnDock) activity = 'error';
  else if (isEdgeCutting) activity = 'edge_cutting';
  else if (isFollowingUnicom) activity = 'following_unicom';
  else if (isCoverageRunning) activity = 'mowing';
  else if (isMappingActive) activity = 'mapping';
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
      // During edge_cutting, progress comes from the NTCP monitor's
      // covered_ratio — mqtt_node's cov_ratio doesn't track a task
      // that we bypassed robot_decision for.
      if (s.edge_active === '1') {
        const er = parseFloat(s.edge_covered_ratio ?? '0');
        if (er > 0 && er <= 1) return Math.round(er * 100);
        return 0;
      }
      const ratio = parseFloat(s.cov_ratio ?? '0');
      // cov_ratio is 0.0-1.0 (fraction), convert to 0-100 percentage
      if (ratio > 0 && ratio <= 1) return Math.round(ratio * 100);
      // mowing_progress is already 0-100
      return Math.round(parseFloat(s.mowing_progress ?? '0')) || 0;
    })(),
    pathDirection:
      parseInt(s.path_direction ?? '0', 10) || 0,
    // Blade RPM relayed by extended_commands.py from /blade_speed_get ROS
    // topic. > 0 means the cutting disc is physically spinning. Used by the
    // status card to switch the icon from a static mower body to a spinning
    // saw-blade glyph so the user can tell at a glance whether the mower is
    // actually cutting (blades on) versus driving (blades stopped during
    // an avoid manoeuvre or lane transition).
    bladeSpeed: parseInt(s.blade_speed ?? '0', 10) || 0,
    bladeStuckWarning:
      (activity === 'mowing' || activity === 'edge_cutting')
      && s.blade_speed != null
      && s.blade_speed !== ''
      && parseInt(s.blade_speed, 10) === 0,
    workStatusLabel: s.work_status ?? null,
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
    // Live driving speed (m/s), derived server-side from the pose stream.
    driveSpeed: parseFloat(s.mow_speed ?? '') || 0,
    firmwareVersion: mower.firmwareVersion ?? null,
    mowZoneMap: s.mow_zone_map ?? null,
  };
}

// ── Activity display helpers ─────────────────────────────────────────

const ACTIVITY_KEYS: Record<MowerActivity, string> = {
  mowing: 'mowing',
  edge_cutting: 'edgeCutting',
  // Short chip label (no placeholder) — the interpolated "Moving to {{zone}}"
  // sentence lives in its own render block below (uses the 'followingUnicom'
  // i18n key directly with the {{zone}} param).
  following_unicom: 'followingUnicomShort',
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
    case 'edge_cutting': return 'Edge cutting';
    case 'following_unicom': return 'Moving between zones';
    case 'charging': return 'Charging';
    case 'returning': return 'Returning';
    case 'paused': return 'Paused';
    case 'error': return 'Error';
    case 'mapping': return 'Mapping';
    case 'idle': default: return 'Idle';
  }
}

function getActivityColor(activity: MowerActivity, c: Colors): string {
  switch (activity) {
    case 'mowing':
      return c.green;
    case 'edge_cutting':
      return c.amber;
    case 'following_unicom':
      return c.emerald;
    case 'charging':
      return c.blue;
    case 'returning':
      return c.blue;
    case 'paused':
      return c.amber;
    case 'error':
      return c.red;
    case 'mapping':
      return c.purple;
    case 'idle':
    default:
      return c.textDim;
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

function MowerIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <SvgPath d={MOWER_SVG_PATH} fill={color} />
    </Svg>
  );
}

/**
 * Spinning saw-blade icon — animates a 360° rotation when blade RPM is
 * non-zero. Used in the activity card so the operator can tell at a glance
 * whether the mower is physically cutting (blades on, icon spinning) or
 * just driving (blades stopped, no spin even when activity = 'mowing').
 *
 * Uses the existing react-native Animated driver so no extra dependency.
 * Spin period scales loosely with RPM: 0 = static (no animation), > 0
 * spins at a sensible visual rate (~700 ms / revolution) regardless of
 * absolute value. Showing the *exact* RPM as a rotation period would
 * either be too slow at low RPM or unwatchable at high RPM, so this
 * trades fidelity for legibility — the on/off semantic is what the user
 * actually needs.
 */
function BladeIcon({
  size,
  color,
  spinning,
}: { size: number; color: string; spinning: boolean }) {
  const rotation = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!spinning) {
      rotation.stopAnimation();
      rotation.setValue(0);
      return;
    }
    rotation.setValue(0);
    const loop = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 700,
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    loop.start();
    return () => { loop.stop(); };
  }, [spinning, rotation]);

  const spin = rotation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <Animated.View style={{ transform: [{ rotate: spin }] }}>
      <MaterialCommunityIcons name="saw-blade" size={size} color={color} />
    </Animated.View>
  );
}

function getActivityIcon(
  activity: MowerActivity,
): React.ComponentProps<typeof Ionicons>['name'] {
  switch (activity) {
    case 'mowing':
      return 'leaf'; // overridden by custom SVG in render
    case 'edge_cutting':
      return 'scan-outline';
    case 'following_unicom':
      return 'git-network-outline';
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
  idle:              'transparent',
  mowing:            'rgba(16, 185, 129, 0.20)',
  edge_cutting:      'rgba(245, 158, 11, 0.20)',
  following_unicom:  'rgba(0, 212, 170, 0.20)',
  charging:          'rgba(59, 130, 246, 0.20)',
  returning:         'rgba(245, 158, 11, 0.15)',
  paused:            'rgba(234, 179, 8, 0.12)',
  mapping:           'rgba(168, 85, 247, 0.15)',
  error:             'rgba(239, 68, 68, 0.20)',
};

// ── Hero palette (light-mode pastel variant, spec visual choice B) ───

const HERO_PALETTE = {
  dark: {
    gradientFrom: '#065f46',
    gradientTo: '#059669',
    text: '#ffffff',
    chipBg: 'rgba(255,255,255,0.05)',
    chipText: '#9ca3af', // darkColors.textDim — hard-coded so HERO_PALETTE.dark stays palette-independent

    subtitleText: 'rgba(255,255,255,0.7)',
  },
  light: {
    gradientFrom: '#d4f0d4',
    gradientTo: '#a8d5aa',
    text: '#1b3a1d',
    chipBg: 'rgba(27,58,29,0.12)',
    chipText: '#1b3a1d',
    subtitleText: 'rgba(27,58,29,0.65)',
  },
} as const;

// ── Component ────────────────────────────────────────────────────────

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const route = useRoute<RouteProp<MainTabParams, 'Home'>>();
  const { devices, connected } = useMowerState();
  const { activeMower, activeMowerSn, setActiveMowerSn } = useActiveMower();
  const { activeMowerSn: pickedMowerSn, hydrated: activePickHydrated } = useActiveMowerContext();
  const { t } = useI18n();
  const { colorScheme, colors } = useTheme();
  const styles = useStyles(makeStyles);
  const hero = HERO_PALETTE[colorScheme];
  const mower = useMemo(() => deriveMower(activeMower), [activeMower]);
  // Post-restore safety: while the map frame is unvalidated, go_to_charge would
  // navigate the bad frame and drive the mower anywhere. Lock Go-home and show
  // the re-anchor wizard until a successful dock clears the server-side flag.
  const frameUnvalidated =
    (devices.get(mower?.sn ?? '')?.sensors?.frame_unvalidated ?? '0') === '1';
  // Auto-close the re-anchor wizard once the server clears the flag (a
  // successful dock re-anchored the frame) so the modal does not hang open.
  useEffect(() => {
    if (!frameUnvalidated) setShowReanchor(false);
  }, [frameUnvalidated]);
  // Blade-not-spinning warning gets a 15s grace period: the mower routinely
  // stops the cutter for a second or two during route re-planning and lane
  // transitions, so an instant warning flashes noise. Only show when the
  // condition has persisted long enough that "just a brief pause" is no
  // longer a plausible explanation.
  const BLADE_STUCK_GRACE_MS = 15000;
  const [bladeStuckVisible, setBladeStuckVisible] = useState(false);
  const bladeStuckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const instantBladeStuck = mower?.bladeStuckWarning ?? false;
  const activeMowerSnForBladeWarn = mower?.sn ?? null;
  useEffect(() => {
    // Reset whenever we switch mowers — fresh grace window per device.
    setBladeStuckVisible(false);
    if (bladeStuckTimerRef.current != null) {
      clearTimeout(bladeStuckTimerRef.current);
      bladeStuckTimerRef.current = null;
    }
  }, [activeMowerSnForBladeWarn]);
  useEffect(() => {
    if (instantBladeStuck) {
      // Condition is true — start grace timer if not already running.
      if (!bladeStuckVisible && bladeStuckTimerRef.current == null) {
        bladeStuckTimerRef.current = setTimeout(() => {
          setBladeStuckVisible(true);
          bladeStuckTimerRef.current = null;
        }, BLADE_STUCK_GRACE_MS);
      }
    } else {
      // Condition cleared — cancel pending timer + hide if currently shown.
      if (bladeStuckTimerRef.current != null) {
        clearTimeout(bladeStuckTimerRef.current);
        bladeStuckTimerRef.current = null;
      }
      if (bladeStuckVisible) setBladeStuckVisible(false);
    }
    return () => {
      if (bladeStuckTimerRef.current != null) {
        clearTimeout(bladeStuckTimerRef.current);
        bladeStuckTimerRef.current = null;
      }
    };
  }, [instantBladeStuck, bladeStuckVisible]);
  // Dismiss-state for the error banner. Issue #13: stock firmware re-emits
  // the same error_status on every report_state_robot tick, so even after
  // hitting Clear the banner reappears within milliseconds. We hide it
  // locally when the user dismisses, and only re-show when the underlying
  // error code/text actually changes (a new fault).
  const [dismissedError, setDismissedError] = useState<{ status: string; msg: string } | null>(null);
  // Reset dismissal when the mower switches OR the error fingerprint changes.
  useEffect(() => {
    if (!dismissedError) return;
    const curStatus = String(mower?.errorStatus ?? '');
    const curMsg = String(mower?.errorMsg ?? '');
    if (curStatus !== dismissedError.status || curMsg !== dismissedError.msg) {
      setDismissedError(null);
    }
  }, [mower?.sn, mower?.errorStatus, mower?.errorMsg, dismissedError]);
  const errorBannerHidden = !!dismissedError
    && String(mower?.errorStatus ?? '') === dismissedError.status
    && String(mower?.errorMsg ?? '') === dismissedError.msg;
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
  const [showReanchor, setShowReanchor] = useState(false);
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

  // Fresh-session coverage suppression. After starting a new mow the mower keeps
  // reporting the PREVIOUS session's coverage (mowing_progress, finished_area,
  // planned paths) until it reaches the start point and begins fresh coverage.
  // We hide that carried-over coverage on the home map until new data arrives,
  // so a freshly started mow shows a clean slate instead of last time's lines.
  const [freshSession, setFreshSession] = useState(false);
  const freshSessionFingerprint = useRef('');
  const freshSessionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-show the return-reason modal once per new reason while the mower is
  // returning / charging / paused. Reset the guard when it goes actively
  // off-dock (mowing/edge_cutting) or truly idle, so a future return re-pops.
  const effectiveActivity = activityOverride ?? mower?.activity ?? null;
  const returnReason = deriveReturnReason(
    mower ? devices.get(mower.sn)?.sensors : undefined,
    mower?.hasError ?? false,
  );
  // Reveal live coverage again once the mower reports fresh session data (its
  // finished_area / cover_map_id changed from the carried-over session), or it
  // is clearly no longer mowing. The timeout armed in onStarted is the safety net.
  useEffect(() => {
    if (!freshSession) return;
    const s = mower ? devices.get(mower.sn)?.sensors : undefined;
    // Transiënt lege sensor-snapshot (socket reconnect / gedropt veld) telt
    // niet als "verse data" — anders flikkert de oude coverage terug omdat
    // de fingerprint heel even naar "|" springt.
    if (s?.finished_area === undefined && s?.cover_map_id === undefined) return;
    const fp = `${s?.finished_area ?? ''}|${s?.cover_map_id ?? ''}`;
    if (
      fp !== freshSessionFingerprint.current ||
      effectiveActivity === 'idle' ||
      effectiveActivity === 'charging'
    ) {
      setFreshSession(false);
      if (freshSessionTimer.current) {
        clearTimeout(freshSessionTimer.current);
        freshSessionTimer.current = null;
      }
    }
  }, [devices, mower?.sn, effectiveActivity, freshSession]);
  // Sessie gestart buiten de app om (schema / dashboard / andere telefoon):
  // activity springt van dock/idle naar mowing zonder dat StartMowSheet.onStarted
  // draaide. Zonder gate toont de kaart dan minutenlang de cover-paths van de
  // VORIGE sessie (firmware echoot die tot de nieuwe coverage echt begint).
  // Zelfde suppressie als onStarted: lokale overlays wissen + carried-over
  // coverage verbergen tot de fingerprint verandert. Bewust NIET bij
  // returning→mowing (regen-hervatting: zelfde sessie, coverage is echt).
  const prevActivityForFreshRef = useRef<MowerActivity | null>(null);
  useEffect(() => {
    const prev = prevActivityForFreshRef.current;
    prevActivityForFreshRef.current = effectiveActivity;
    const startedOutsideApp =
      (effectiveActivity === 'mowing' || effectiveActivity === 'edge_cutting') &&
      (prev === 'idle' || prev === 'charging');
    // freshSession al aan = start kwam via StartMowSheet.onStarted (die zet
    // optimistic activity en de gate in dezelfde batch) — niets te doen.
    if (!startedOutsideApp || freshSession) return;
    setMowingTrail([]);
    setPlannedPaths([]);
    const s = mower ? devices.get(mower.sn)?.sensors : undefined;
    freshSessionFingerprint.current = `${s?.finished_area ?? ''}|${s?.cover_map_id ?? ''}`;
    setFreshSession(true);
    if (freshSessionTimer.current) clearTimeout(freshSessionTimer.current);
    freshSessionTimer.current = setTimeout(() => setFreshSession(false), 180000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveActivity, freshSession, mower?.sn]);

  useEffect(() => {
    const prev = prevActivityRef.current;
    prevActivityRef.current = effectiveActivity;
    if (
      effectiveActivity === 'mowing' ||
      effectiveActivity === 'edge_cutting' ||
      effectiveActivity === 'idle' ||
      effectiveActivity === null
    ) {
      // Actively working or truly idle: nothing to explain. Reset so the next
      // real return re-pops, and retract the chip.
      lastShownReasonRef.current = null;
      setLiveReturn(false);
      return;
    }
    // Dock states (returning/charging/paused). Only surface the return-reason
    // UI when we just transitioned here from an off-dock state DURING this app
    // session. On a cold app open of an already-docked mower `prev` is null, so
    // we never ambush the user with a stale popup/chip that "survives" a restart.
    const cameFromOffDock =
      prev === 'mowing' || prev === 'edge_cutting' || prev === 'returning';
    if (cameFromOffDock && returnReason) {
      setLiveReturn(true);
      if (returnReason !== lastShownReasonRef.current) {
        lastShownReasonRef.current = returnReason;
        setReasonModalVisible(true);
      }
    }
  }, [effectiveActivity, returnReason]);

  // Request a fresh snapshot once when entering returning/charging so the
  // server-side rain_paused flag is current for the reason derivation.
  useEffect(() => {
    if (effectiveActivity === 'returning' || effectiveActivity === 'charging') {
      if (snapshotRequestedForRef.current !== effectiveActivity) {
        snapshotRequestedForRef.current = effectiveActivity;
        getSocket()?.emit('request:snapshot');
      }
    } else {
      snapshotRequestedForRef.current = null;
    }
  }, [effectiveActivity]);
  // ── Return-reason modal: explain WHY the mower returned to the dock ──
  const [reasonModalVisible, setReasonModalVisible] = useState(false);
  // True only after we observed the mower return from an off-dock state in THIS
  // app session. Gates both the auto-popup and the chip so neither survives an
  // app restart (was: stale "Mowing finished" popup ambushing on cold open).
  const [liveReturn, setLiveReturn] = useState(false);
  // Tracks the reason we last auto-showed so we don't re-pop the modal for the
  // same ongoing reason. Reset to null when the mower goes actively off-dock.
  const lastShownReasonRef = useRef<ReturnReason>(null);
  // Previous effectiveActivity, to detect a live off-dock -> dock transition.
  const prevActivityRef = useRef<MowerActivity | null>(null);
  // Fire a single fresh snapshot request per transition into returning/charging
  // so the server-side rain_paused flag is current when we derive the reason.
  const snapshotRequestedForRef = useRef<MowerActivity | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  const [activeMapPolygon, setActiveMapPolygon] = useState<Array<{ x: number; y: number }>>([]);
  // Issue #14: home preview now keeps every work polygon so the mower icon
  // can never appear "outside" the visible boundary just because we picked
  // the wrong slot. Active polygon (above) renders highlighted; the rest
  // render dimmed underneath.
  const [allWorkPolygons, setAllWorkPolygons] = useState<Array<{ id: string; points: Array<{ x: number; y: number }>; label?: string | null }>>([]);
  const [activeMapLabel, setActiveMapLabel] = useState<string | null>(null);
  const [startedMapIds, setStartedMapIds] = useState<string[]>([]);
  const [mapSelectionMismatch, setMapSelectionMismatch] = useState<{ expected: string; actual: string } | null>(null);
  const [mowingTrail, setMowingTrail] = useState<Array<{ x: number; y: number }>>([]);
  const [plannedPaths, setPlannedPaths] = useState<Array<{ id: string; points: Array<{ x: number; y: number }> }>>([]);
  const [obstaclePolygons, setObstaclePolygons] = useState<Array<{ id: string; points: Array<{ x: number; y: number }>; label?: string | null }>>([]);
  const [channelPolylines, setChannelPolylines] = useState<Array<{ id: string; points: Array<{ x: number; y: number }> }>>([]);
  // Track mowing settings for safety check + display
  const [mowSettings, setMowSettings] = useState<{ cuttingHeight: number; pathDirection: number } | null>(null);
  const demo = useDemo();
  // The user's selected map(s) for this run. The firmware mows them all from one
  // start_navigation (bitmask area), advancing between zones itself — so this is
  // the whole selected SET, and telemetry landing on any of them is correct.
  const intendedActiveMapIds = startedMapIds;
  const intendedSessionKey = startedMapIds.join(',');

  useEffect(() => {
    const sessionActive =
      effectiveActivity === 'mowing'
      || effectiveActivity === 'edge_cutting'
      || effectiveActivity === 'mapping'
      || effectiveActivity === 'paused'
      || effectiveActivity === 'returning';
    if (!sessionActive) {
      setStartedMapIds([]);
      setMapSelectionMismatch(null);
    }
  }, [effectiveActivity, mower?.sn]);

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

      // A map created over BLE without WiFi is still only on the mower; now
      // that we can reach the server, ask the mower (via the server) to upload
      // it. No-op unless MappingScreen left a pending flag. Fire-and-forget so
      // it never delays the home screen.
      void flushPendingMapSync(mower.sn).then((r) => {
        if (r !== 'nothing') console.log(`[Home] pending map sync for ${mower.sn}: ${r}`);
      });

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

  // Auto-select the only online set so the user doesn't have to tap
  // "Activate this set" when there's nothing to disambiguate. Runs only
  // when the picker hasn't been hydrated to a real choice yet — never
  // overrides an explicit user pick. Triggers when deviceSets changes.
  useEffect(() => {
    if (!activePickHydrated) return;
    if (pickedMowerSn) return;
    const setsWithMower = deviceSets.filter((s) => s.mower);
    if (setsWithMower.length === 0) return;
    const onlineSets = setsWithMower.filter(
      (s) => s.mower?.online || s.charger?.online,
    );
    const candidate =
      onlineSets.length === 1
        ? onlineSets[0]
        : setsWithMower.length === 1
          ? setsWithMower[0]
          : null;
    if (candidate?.mower) setActiveMowerSn(candidate.mower.sn);
  }, [deviceSets, activePickHydrated, pickedMowerSn, setActiveMowerSn]);

  // Server emits `maps:changed` whenever a map is created / deleted. Refetch
  // so the Start button immediately reflects the new DB state even if the
  // mower hasn't updated its report_state_robot.map_num sensor yet.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handler = (e: { sn: string }) => {
      if (!e?.sn || (mower?.sn && e.sn !== mower.sn)) return;
      void loadHomeMeta();
    };
    socket.on('maps:changed', handler);
    return () => { socket.off('maps:changed', handler); };
  }, [loadHomeMeta, mower?.sn]);

  // Debug: temporary alert showing /userdata/pos.json after the mower
  // docks. Server SSH-reads the file on the docking transition and emits
  // `debug:pos_json`. Only show for the currently-selected mower.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handler = (e: { sn: string; pos: unknown; raw: string | null; timestamp: number }) => {
      if (!e?.sn || (mower?.sn && e.sn !== mower.sn)) return;
      const body = e.pos != null
        ? JSON.stringify(e.pos, null, 2)
        : (e.raw ?? '(empty)');
      appAlertCompat.alert(`pos.json — ${e.sn}`, body);
    };
    socket.on('debug:pos_json', handler);
    return () => { socket.off('debug:pos_json', handler); };
  }, [mower?.sn]);

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
          appAlertCompat.alert(
            t('safetyStopTitle'),
            t('safetyStopBody'),
            [{ text: t('ok') }],
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

  // Fetch + select active work polygon for mowing progress display.
  // Re-runs whenever the firmware reports a new cover_map_id so multi-map
  // sessions update the highlight as the mower moves between zones.
  const liveCoverMapId = devices.get(mower?.sn ?? '')?.sensors?.cover_map_id;
  const liveCurrentMapIds = devices.get(mower?.sn ?? '')?.sensors?.current_map_ids;
  // cover_map_id is sticky firmware state that survives across sessions
  // (sensorData.ts only ever writes it from telemetry, never clears it on a new
  // start). Right after the user starts a mow it still holds the PREVIOUS run's
  // map, so comparing it to the just-selected map false-flags a mismatch AND
  // highlights the wrong polygon until the mower emits its first coverage tick —
  // which can take minutes if it has to drive to a far zone. Treat telemetry as
  // stale until cover_map_id changes from the value captured at session start.
  // ponytail: snapshot-and-wait-for-change, no timer (drive time is unbounded).
  const coverTelemetryBaselineRef = useRef<CoverTelemetryBaseline | null>(null);
  useEffect(() => {
    if (demo.enabled) {
      setActiveMapPolygon([
        { x: -3, y: 5 }, { x: 1, y: 7 }, { x: 5, y: 6 },
        { x: 6, y: 2 }, { x: 3, y: -1 }, { x: -2, y: 1 },
      ]);
      setMapSelectionMismatch(null);
      return;
    }
    if (!mower?.sn) return;

    // Telemetry freshness gate (see coverTelemetryBaselineRef above). While the
    // live cover_map_id still matches the value captured at session start it's
    // stale leftover state, so feed `undefined` and let the selection fall back
    // to the user's chosen map (no false mismatch, correct polygon highlighted).
    const sessionKey = intendedSessionKey;
    const liveCover = liveCoverMapId == null ? null : String(liveCoverMapId);
    const gated = gateCoverTelemetry(coverTelemetryBaselineRef.current, sessionKey, liveCover);
    coverTelemetryBaselineRef.current = gated.baseline;
    const telemetryFresh = gated.fresh;

    (async () => {
      try {
        const url = await getServerUrl();
        if (!url) return;
        const api = new ApiClient(url);
        const res = await api.fetchMaps(mower.sn);
        const workMaps = (res.maps ?? []).filter((m: any) => m.mapType === 'work' && m.mapArea?.length >= 3);

        const selection = resolveMowingMapSelection(workMaps, {
          intendedMapIds: intendedActiveMapIds,
          coverMapId: telemetryFresh ? liveCoverMapId : undefined,
          currentMapIds: telemetryFresh ? liveCurrentMapIds : undefined,
        });
        const activeWork = selection.activeMap;
        const mapLabel = (m: any) => m?.mapName ?? m?.canonicalName ?? m?.mapId ?? 'unknown map';
        // Mismatch = the mower reports a map the user did NOT select. Moving
        // between selected zones (native firmware multi-map) is expected, so the
        // set-membership check in resolveMowingMapSelection already handles it.
        setMapSelectionMismatch(selection.mismatch && selection.expectedMap && selection.telemetryMap
          ? { expected: mapLabel(selection.expectedMap), actual: mapLabel(selection.telemetryMap) }
          : null);
        if (activeWork) {
          setActiveMapPolygon(activeWork.mapArea);
          setActiveMapLabel(activeWork.mapName ?? activeWork.canonicalName ?? null);
        }
        // Stash the OTHER polygons so the canvas can render them dimmed
        // beneath the active one. Without this the mower icon (plotted in
        // the global map frame) drifts outside the visible polygon when
        // we pick the wrong slot.
        setAllWorkPolygons(
          workMaps
            .filter((m: any) => m.mapId !== activeWork?.mapId)
            .map((m: any) => ({
              id: m.mapId,
              points: m.mapArea,
              label: m.mapName ?? m.canonicalName ?? null,
            })),
        );
        const obs = (res.maps ?? []).filter((m: any) => m.mapType === 'obstacle' && m.mapArea?.length >= 3);
        setObstaclePolygons(obs.map((m: any) => ({
          id: m.mapId,
          points: m.mapArea,
          label: m.mapName ?? m.canonicalName ?? null,
        })));
        // Inter-zone channels (unicom connectors). Exclude the charger
        // connector (mapXtocharge) — users only care about map-to-map links.
        const chans = (res.maps ?? []).filter((m: any) =>
          m.mapType === 'unicom'
          && (m.mapArea?.length ?? 0) >= 2
          && !/tocharge/i.test(m.canonicalName ?? m.fileName ?? m.mapName ?? ''));
        setChannelPolylines(chans.map((m: any) => ({ id: m.mapId, points: m.mapArea })));
      } catch { /* ignore */ }
    })();
  }, [mower?.sn, demo.enabled, liveCoverMapId, liveCurrentMapIds, intendedActiveMapIds, intendedSessionKey]);

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
      appAlertCompat.alert(
        t('heightMismatchTitle'),
        t('heightMismatchBody', { expected: mowSettings.cuttingHeight + 2, actual: reportedHeight + 2 }),
        [
          { text: t('stop'), style: 'destructive', onPress: () => {
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
    const isActive = mower.activity === 'mowing' || mower.activity === 'edge_cutting' || mower.activity === 'mapping';
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
        const mapsRes = await api.fetchMaps(mower.sn).catch(() => ({ maps: [] as MapData[] }));
        const workMaps = (mapsRes.maps ?? []).filter((m: MapData) => m.mapType === 'work' && (m.mapArea?.length ?? 0) >= 3);
        const preferredMaps = startedMapIds.length > 0
          ? workMaps.filter((m: MapData) => startedMapIds.includes(m.mapId))
          : workMaps;
        const fresh = await api.refreshPreviewPath(mower.sn, {
          covDirection: mowSettings?.pathDirection,
          mapIds: previewMapIdsFromMaps(preferredMaps.length > 0 ? preferredMaps : workMaps),
        }).catch(() => []);
        if (cancelled) return;
        if (Array.isArray(fresh) && fresh.length > 0) setPlannedPaths(fresh);
      } catch { /* ignore */ }
    })();

    return () => { cancelled = true; };
  }, [mower?.activity, mower?.sn, mower?.online, mowSettings?.pathDirection, startedMapIds, demo.enabled]);

  // Mower bounce animation (subtle bob when active)
  const bounceAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  // Auto-incrementing cmd_num for commands (matches Flutter app behavior)
  // Seed from the clock so cmd_num is always large + monotonically advancing and
  // never resets to a low value on an app reload. The firmware dedups commands on
  // cmd_num (`if (novabot_cmd_num != cmd_num)` — a repeat is silently ignored), so
  // a reset-to-0 counter collided with the mower's last value and made
  // resume_navigation a silent no-op. Mirrors the Novabot app's global monotonic
  // cmd_num counter.
  const cmdNumRef = useRef(Date.now() % 100000);

  useEffect(() => {
    if (!mower) return;
    const isMoving = mower.activity === 'mowing' || mower.activity === 'edge_cutting' || mower.activity === 'returning' || mower.activity === 'mapping';
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
    if (frameUnvalidated) {
      appAlertCompat.alert(
        t('reanchorRequiredTitle'),
        t('reanchorRequiredBody'),
      );
      return;
    }
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

  // Resume an interrupted coverage (paused mid-mow, or returned to the dock for
  // rain / low battery). resume_navigation continues the existing cov_path — a
  // fresh start_navigation would restart from 0%. cmd_num must be unique or the
  // firmware dedups it away (see cmdNumRef seed). If rain is forecast within ~3h
  // we ask first, exactly like the start flow: the server's rain monitor would
  // otherwise immediately re-pause the resume and the mower never leaves the
  // dock. "Ignore & resume" sets the per-session rain-ignore flag.
  const resumeCoverage = async (sn: string) => {
    const send = async (ignoreRain: boolean) => {
      try {
        setCommandLoading('start');
        const url = await getServerUrl();
        if (!url) return;
        const api = new ApiClient(url);
        if (ignoreRain) {
          try { await api.setRainIgnoreSession(sn, true); }
          catch (e) { console.log('[HomeScreen] rain-ignore-session POST failed:', e); }
        }
        await api.sendCommand(sn, { resume_navigation: { cmd_num: ++cmdNumRef.current } });
        setOptimisticActivity('mowing');
      } catch (e) {
        console.log('[HomeScreen] resume_navigation failed:', e);
      } finally {
        setCommandLoading(null);
      }
    };
    // Rain forecast check — mirrors StartMowSheet.fetchIncomingRain.
    let rain: { mm: number; prob: number } | null = null;
    try {
      const url = await getServerUrl();
      if (url) {
        const res = await fetch(`${url}/api/dashboard/rain-forecast/${encodeURIComponent(sn)}`);
        const data = await res.json() as { available?: boolean; upcoming?: Array<{ time: string; mm: number; prob: number }> };
        if (data.available && data.upcoming?.length) {
          const now = Date.now();
          const horizon = 3 * 60 * 60 * 1000;
          for (const h of data.upcoming) {
            const at = new Date(h.time).getTime();
            if (at < now || at - now > horizon) continue;
            if (h.mm >= 0.1 || h.prob >= 50) { rain = { mm: h.mm, prob: h.prob }; break; }
          }
        }
      }
    } catch { /* no forecast available — resume without prompting */ }

    if (rain) {
      appAlertCompat.alert(
        t('rainWarningTitle') || 'Rain forecast',
        t('rainResumeBody') || 'Rain is expected soon. Resume anyway and ignore rain for this session? Otherwise the mower stays on the dock.',
        [
          { text: t('cancel') || 'Cancel', style: 'cancel' },
          { text: t('rainIgnoreResume') || 'Ignore rain & resume', onPress: () => { void send(true); } },
        ],
      );
    } else {
      void send(false);
    }
  };

  const handleDeleteDevice = (sn: string, label: string) => {
    appAlertCompat.alert(
      t('removeDeviceTitle', { label }),
      t('removeDeviceBody', { sn }),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('removeBtn'),
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
      appAlertCompat.alert(t('noChargerFound'), t('provisionCharger'));
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
          appAlertCompat.alert(t('error'), 'Could not read charger LoRa config');
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
          appAlertCompat.alert(
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
                    appAlertCompat.alert(t('paired'), `Mower paired with charger.\nLoRa updated to addr=${chargerLora.address} ch=${mowerChannel}`);
                  } catch (e: any) {
                    appAlertCompat.alert(t('error'), e.message ?? 'Pairing failed');
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
        appAlertCompat.alert(t('paired'), `Mower paired with charger (LoRa addr=${chargerLora.address})`);
      } catch (e: any) {
        appAlertCompat.alert(t('error'), e.message ?? 'Pairing failed');
      }
    };

    if (chargersWithLora.length === 1) {
      doPair(chargersWithLora[0].charger!.sn);
    } else {
      // Multiple chargers — let user pick
      appAlertCompat.alert(
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
  const activityColor = getActivityColor(displayActivity, colors);
  const batteryGlowColor = getBatteryGlowColor(mower.battery);
  // The hero shows the progress MAP (not the big battery ring) only while an
  // active task has a drawable polygon. Used both for the ternary below and to
  // gate the small battery chip — the chip only appears when the ring doesn't,
  // so the percentage is never shown twice.
  const mapShown =
    (displayActivity === 'mowing' || displayActivity === 'edge_cutting'
      || displayActivity === 'mapping' || displayActivity === 'returning')
    && activeMapPolygon.length >= 3;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <FirmwareUpdateBanner />
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

        {/* Post-restore re-anchor banner (non-blocking): the map frame for THIS
            mower is unvalidated after a bundle restore. Go-home stays locked,
            but the app and other mowers remain usable. Tap to open the wizard. */}
        {frameUnvalidated && (
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => setShowReanchor(true)}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 10,
              backgroundColor: 'rgba(245,158,11,0.12)',
              borderWidth: 1, borderColor: 'rgba(245,158,11,0.4)',
              borderRadius: 12, padding: 12, marginBottom: 12,
            }}
          >
            <Ionicons name="warning-outline" size={20} color="#f59e0b" />
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#f59e0b', fontWeight: '700', fontSize: 13 }}>
                {t('reanchorBannerTitle')}
              </Text>
              <Text style={{ color: colors.textDim, fontSize: 12 }}>
                {t('reanchorBannerBody')}
              </Text>
            </View>
            <Text style={{ color: '#f59e0b', fontWeight: '700', fontSize: 13 }}>{t('reanchorBannerCta')}</Text>
          </TouchableOpacity>
        )}

        {/* Mower animation scene — nickname + rename live in the picker
            chevron now, so the scene is purely the animation. */}
        <MowerScene
          activity={displayActivity}
          battery={mower.battery}
          mowingProgress={mower.mowingProgress}
        />

        {/* Status card */}
        <View style={styles.statusCard}>
          {/* Activity header — saw-blade spins when blades are physically
              turning (chassis-published RPM > 0), MowerIcon during mowing
              when blades are paused, Ionicons for everything else. */}
          <View style={styles.activityRow}>
            {(displayActivity === 'mowing' || displayActivity === 'edge_cutting') && mower.bladeSpeed > 0 ? (
              <BladeIcon size={24} color={activityColor} spinning={true} />
            ) : displayActivity === 'mowing' || displayActivity === 'edge_cutting' ? (
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
            {mower.mowingProgress > 0 && (displayActivity === 'mowing' || displayActivity === 'edge_cutting' || displayActivity === 'mapping' || displayActivity === 'returning') && (
              <Text style={[styles.progressText, { color: activityColor }]}>
                {mower.mowingProgress}%
              </Text>
            )}
          </View>

          {bladeStuckVisible && (
            <View style={styles.bladeStuckBanner}>
              <Ionicons name="warning" size={16} color={colors.red} />
              <Text style={styles.bladeStuckBannerText}>{t('bladesNotSpinning')}</Text>
            </View>
          )}

          {/* Following-unicom overlay: the mower is driving the recorded
              map-to-map transit line (mow_zone orchestrator, phase
              "following_unicom"). Shows the Novabot map-to-map animation +
              copy naming the destination zone. Clears itself automatically
              once the phase moves to "covering"/"done"/"error" — deriveMower
              only sets this activity while mow_zone_phase === 'following_unicom'. */}
          {displayActivity === 'following_unicom' && (
            <View style={styles.unicomTransitBox}>
              <UnicomTransitAnimation />
              <Text style={[styles.unicomTransitText, { color: colors.textDim }]}>
                {t('followingUnicom', { zone: mower.mowZoneMap ?? '' })}
              </Text>
            </View>
          )}

          {/* Return-reason chip — appears when the modal has been dismissed but
              the mower is still back on the dock. Tap to re-open the modal. */}
          {returnReason && !reasonModalVisible && liveReturn &&
            (displayActivity === 'returning' || displayActivity === 'charging' || displayActivity === 'paused') && (
              <TouchableOpacity
                style={styles.returnReasonChip}
                onPress={() => setReasonModalVisible(true)}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={RETURN_REASON_META[returnReason].icon}
                  size={16}
                  color={RETURN_REASON_META[returnReason].color}
                />
                <Text style={[styles.returnReasonChipText, { color: RETURN_REASON_META[returnReason].color }]}>
                  {t('rrReturnedShort') || 'Waarom teruggekeerd?'}
                </Text>
                <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
              </TouchableOpacity>
            )}

          {/* Progress bar — ook tijdens terugkeren naar de dock, zodat je de
              laatste coverage-state blijft zien totdat een volgende taak start.
              Novabot app doet hetzelfde: "Returning to the charging station"
              + "Progress: 88%" voor de afgelopen sessie. */}
          {mower.mowingProgress > 0 && (displayActivity === 'mowing' || displayActivity === 'edge_cutting' || displayActivity === 'mapping' || displayActivity === 'returning') && (
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${mower.mowingProgress}%` as any, backgroundColor: activityColor }]} />
            </View>
          )}

          {/* Mowing/mapping/returning: show progress map instead of battery ring.
              Returning gebruikt dezelfde kaart zodat je ziet waar de maaier geweest
              is (finished_area blijft in de cover_path state van de maaier zolang
              task_mode=1) en waar hij nu naartoe rijdt.
              mapShown gates the battery chip too: it only appears when the map
              (not the big battery ring) is on screen, so we don't show the
              percentage twice. */}
          {mapShown ? (
            <View style={styles.mowingMapPanel}>
              {mapSelectionMismatch && (
                <View style={styles.mapMismatchBanner}>
                  <Ionicons name="warning-outline" size={16} color="#f59e0b" />
                  <Text style={styles.mapMismatchText}>
                    Started {mapSelectionMismatch.expected}, mower reports {mapSelectionMismatch.actual}
                  </Text>
                </View>
              )}
              <MowingProgressMap
                polygon={activeMapPolygon}
                activeLabel={activeMapLabel}
                progress={freshSession ? 0 : mower.mowingProgress}
                pathDirection={mowSettings?.pathDirection ?? mower.pathDirection}
                fill
                interactive
                trail={freshSession ? [] : mowingTrail}
                plannedPaths={plannedPaths}
                finishedAreas={freshSession ? [] : parseFinishedAreas(
                  devices.get(mower.sn)?.sensors?.finished_area,
                  devices.get(mower.sn)?.sensors?.cover_map_id,
                )}
                activeAreaId={freshSession ? undefined : prefixedAreaId(
                  devices.get(mower.sn)?.sensors?.covering_area_id,
                  devices.get(mower.sn)?.sensors?.cover_map_id,
                )}
                activeAreaPoints={freshSession ? undefined : (parseInt(devices.get(mower.sn)?.sensors?.covering_area_points ?? '0', 10) || undefined)}
                liveCoverSegment={freshSession ? undefined : parseCoveringPoints(devices.get(mower.sn)?.sensors?.covering_points)}
                obstacles={obstaclePolygons}
                channels={channelPolylines}
                inactivePolygons={allWorkPolygons}
                mowerPos={mower.mowerPosX != null && mower.mowerPosY != null ? { x: mower.mowerPosX, y: mower.mowerPosY } : null}
                mowerHeading={mower.mowerHeading ?? undefined}
                chargerPose={devices.get(mower.sn)?.dockPose ?? null}
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
                  <Text style={[styles.batteryPercentage, { color: hero.text }]}>{mower.battery}</Text>
                  <Text style={[styles.batteryPercSign, { color: hero.subtitleText }]}>%</Text>
                  {mower.batteryCharging && (
                    <Ionicons name="flash" size={14} color={colors.blue} style={{ marginLeft: 2 }} />
                  )}
                </View>
              </Animated.View>
            </View>
          )}

          <View style={styles.chipsGroup}>
            <View style={styles.chipsRow}>
            {(() => {
              const isActiveCut =
                displayActivity === 'mowing' ||
                displayActivity === 'edge_cutting' ||
                displayActivity === 'returning' ||
                displayActivity === 'mapping';
              if (!isActiveCut) return null;
              // target_height is the firmware-echoed wire enum (cm − 2). Fall
              // back to the user's selected mowSettings so the chip never goes
              // blank during the 3-8s window before mqtt_node echoes back.
              const reported = devices.get(mower.sn)?.sensors?.target_height;
              const wire =
                reported != null
                  ? parseInt(reported, 10)
                  : mowSettings?.cuttingHeight ?? null;
              if (wire == null || !Number.isFinite(wire)) return null;
              const cm = wire + 2;
              return (
                <View style={[styles.chip, styles.chipHighlight]}>
                  <Ionicons name="resize" size={13} color="#4ade80" />
                  <Text style={styles.chipHighlightText}>{cm} cm</Text>
                </View>
              );
            })()}
            {(() => {
              // Maairichting — zelfde bron als de kaart (mowSettings van de
              // gestarte sessie, fallback firmware-echo), dus de chip toont
              // wat er werkelijk naar de maaier gestuurd is.
              const active =
                displayActivity === 'mowing' || displayActivity === 'edge_cutting';
              const deg = mowSettings?.pathDirection ?? mower.pathDirection;
              if (!active || deg == null || !Number.isFinite(deg)) return null;
              return (
                <View style={[styles.chip, styles.chipHighlight]}>
                  <Ionicons name="compass-outline" size={13} color="#4ade80" />
                  <Text style={styles.chipHighlightText}>{Math.round(deg)}°</Text>
                </View>
              );
            })()}
            {(() => {
              // Fine-grained firmware state (Mowing / Avoiding obstacle /
              // Re-covering missed spots / Driving) during active mowing — same
              // info as the dashboard's status chip. work_status arrives already
              // translated from the server; skip raw numeric codes and non-active
              // states (the hero + map convey those).
              const active =
                displayActivity === 'mowing' ||
                displayActivity === 'edge_cutting' ||
                displayActivity === 'returning';
              const label = mower.workStatusLabel;
              if (!active || !label || Number.isFinite(Number(label))) return null;
              return (
                <View style={[styles.chip, styles.chipHighlight]}>
                  <Ionicons name="pulse" size={13} color="#4ade80" />
                  <Text style={styles.chipHighlightText}>{label}</Text>
                </View>
              );
            })()}
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
                    <View style={[styles.chip, styles.chipHighlight]}>
                      <Ionicons name="timer-outline" size={13} color="#4ade80" />
                      <Text style={styles.chipHighlightText}>~{etaLabel} left</Text>
                    </View>
                  )}
                  {elapsedLabel && (
                    <View style={[styles.chip, styles.chipHighlight]}>
                      <Ionicons name="time-outline" size={13} color="#4ade80" />
                      <Text style={styles.chipHighlightText}>{elapsedLabel}</Text>
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

            <View style={styles.chipsRow}>
              {mower.battery > 0 && mapShown && (() => {
                // Battery level chip — glanceable full/empty during mowing.
                // Only shown when the map (not the big battery ring) is on screen,
                // so the percentage never appears twice.
                // Colour matches BatteryRing: green >=65, amber 35-64, red <35.
                const batColor = mower.battery >= 65 ? '#4ade80' : mower.battery >= 35 ? '#fbbf24' : colors.red;
                const batIcon = mower.batteryCharging
                  ? 'battery-charging'
                  : mower.battery >= 65 ? 'battery-full' : mower.battery >= 35 ? 'battery-half' : 'battery-dead';
                return (
                  <View style={styles.chip}>
                    <Ionicons name={batIcon} size={12} color={batColor} />
                    <Text style={[styles.chipText, { color: batColor }]}>{mower.battery}%</Text>
                  </View>
                );
              })()}
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
              {mower.driveSpeed > 0.05 && (
                <View style={styles.chip}>
                  <Ionicons name="speedometer-outline" size={11} color={colors.textDim} />
                  <Text style={styles.chipText}>{mower.driveSpeed.toFixed(1)} m/s</Text>
                </View>
              )}
              {(() => {
                // Always render so the RTK chip stays put on the battery-circle
                // view; show "No data" greyed during a brief gap rather than
                // disappearing.
                const rtkFix = fixQualityLabel(devices.get(mower.sn)?.sensors?.rtk_fix_quality);
                return (
                  <View style={styles.chip}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: rtkFix.color }} />
                    <Text style={[styles.chipText, { color: rtkFix.color }]}>{rtkFix.label}</Text>
                  </View>
                );
              })()}
              {devices.get(mower.sn)?.sensors?.cpu_temperature != null && (
                <View style={styles.chip}>
                  <Ionicons name="thermometer" size={11} color={colors.textDim} />
                  <Text style={styles.chipText}>{devices.get(mower.sn)?.sensors?.cpu_temperature}°</Text>
                </View>
              )}
              {mower.bladeSpeed > 0 && (
                <View style={styles.chip}>
                  <MaterialCommunityIcons name="saw-blade" size={11} color={colors.textDim} />
                  <Text style={styles.chipText}>{mower.bladeSpeed} rpm</Text>
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

        {/* Server-computed health banner — LoRa pair mismatch + mower_error.
            Shown above rain/error banners so the user sees the actionable
            issue first when something is off in the device pair. */}
        <HealthBanner health={devices.get(mower.sn)?.health ?? null} />

        {/* Rain overlay — placed right under the status card so it's
            visually paired with the battery panel (was buried below the
            error / warning banners which kept it off-screen most of the
            time). Auto-hides when there's no rain forecast within 3h. */}
        <View style={{ marginBottom: 16 }}>
          <RainOverlay mowerSn={mower.sn} />
        </View>

        {/* Error display */}
        {mower.hasError && !errorBannerHidden && (
          <View style={styles.errorCard}>
            <Ionicons name="alert-circle" size={22} color={colors.red} />
            <View style={styles.errorContent}>
              <Text style={styles.errorTitle}>
                Error {String(mower.errorStatus ?? mower.errorCode ?? '').match(/\d+/)?.[0] ?? ''}
              </Text>
              {String(mower.errorStatus ?? mower.errorCode ?? '').match(/\d+/)?.[0] === '155' ? (
                <Text style={styles.errorMessage}>
                  {t('error155Pin', undefined) || 'Enter the PIN code directly on the mower to unlock it.'}
                </Text>
              ) : mower.errorMsg ? (
                <Text style={styles.errorMessage}>{mower.errorMsg}</Text>
              ) : null}
            </View>
            <TouchableOpacity
              style={{ backgroundColor: 'rgba(239,68,68,0.15)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 }}
              onPress={async () => {
                // Hide locally first — the mower keeps re-emitting the same
                // error_status, so without this dismissal the banner pops
                // back instantly and the user gets stuck in a clear-loop
                // (issue #13).
                setDismissedError({
                  status: String(mower.errorStatus ?? ''),
                  msg: String(mower.errorMsg ?? ''),
                });
                try {
                  const url = await getServerUrl();
                  if (!url || !mower.sn) return;
                  const api = new ApiClient(url);
                  // Earlier revisions only sent clear_error + quit_mapping_mode,
                  // which never recovered Error 2 / "Already in running task":
                  // the underlying coverage task was still flagged active so
                  // the firmware re-emitted the same error_status the next
                  // tick. Verified live 2026-05-06 — the only sequence that
                  // actually recovers a stuck error is stop_navigation FIRST,
                  // then clear_error, then quit_mapping_mode. Each step is
                  // independently idempotent.
                  await api.sendCommand(mower.sn, { stop_navigation: { cmd_num: Date.now() % 100000 } });
                  await new Promise((r) => setTimeout(r, 600));
                  await api.clearError(mower.sn);
                  await new Promise((r) => setTimeout(r, 300));
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
                  Warning {String(mower.errorStatus ?? '').match(/\d+/)?.[0] ?? ''}
                </Text>
                <Text style={styles.errorMessage}>
                  {mower.errorMsg || 'Software not initialized. Please wait a moment and try again.'}
                </Text>
              </View>
              <TouchableOpacity
                style={{ backgroundColor: 'rgba(245,158,11,0.2)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 }}
                onPress={async () => {
                  setDismissedSoftErrors(prev => {
                    const next = new Set(prev);
                    next.add(code);
                    return next;
                  });
                  try {
                    const url = await getServerUrl();
                    if (!url || !mower.sn) return;
                    const api = new ApiClient(url);
                    await api.clearError(mower.sn);
                  } catch {}
                }}
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
                // Server-DB is authoritative for "is there a map": mower's
                // report_state_robot.map_num is a lagging sensor that keeps
                // reporting 1 for a while after a delete until the firmware
                // processes delete_map MQTT (if it ever does). Using server
                // count alone keeps the Start button in sync with the map
                // list the user actually sees.
                const noMap = serverMapCount === 0;
                // Mower already executing a task — firmware would reject a
                // duplicate start_navigation with Error 2 'Already in
                // running task' (issue #13). Detect via msg only because
                // sensors.work_status comes pre-translated in the initial
                // socket snapshot (e.g. "Ready" instead of "9") and only
                // becomes raw after the first live device:update event.
                // msg has no case in translateValue → always raw.
                const busyMsg = devices.get(mower.sn)?.sensors?.msg ?? '';
                const mowerBusy =
                  /Work:(MOVING|COVERING|REQUEST_START|INIT_|RUNNING|MAPPING)/.test(busyMsg)
                  || /Recharge:(MOVING|RUNNING|GOING)/.test(busyMsg);
                // Issue #30: detect a coverage session that paused for low-
                // battery so the user gets a Continue button instead of Start.
                //
                // Earlier revisions used a mix of sticky sensor fields
                // (prev_task_mode, cov_ratio, cov_remaining_area, msg
                // substrings) which all linger for hours after a normal idle
                // dock. Combined they triggered false positives — a fresh
                // Hervatten button on a fully-charged idle mower that had
                // ever finished a coverage at <99%.
                //
                // Match the stock Novabot app behaviour by requiring the
                // CURRENT task_mode to still be 1 (coverage active). When
                // a task fully ends the firmware flips task_mode to 0; only
                // a paused-mid-coverage state keeps it at 1 while the mower
                // sits on the dock. Drop the cov_ratio / cov_remaining /
                // prev_task_mode signals — task_mode + on-dock + the live
                // recharge-stop msg substring is enough.
                const sensorsForResume = devices.get(mower.sn)?.sensors;
                const taskMode = parseInt(sensorsForResume?.task_mode ?? '0', 10);
                const onDock = (sensorsForResume?.battery_state ?? '').toUpperCase() === 'CHARGING'
                  || (sensorsForResume?.battery_state ?? '').toUpperCase() === 'FINISHED';
                // Match the CURRENT Work field only — 'Prev work:USER_RECHARGE_STOP'
                // lingers after the firmware cancels the coverage task (e.g.
                // rain timeout) and would otherwise keep Resume alive even
                // though robot_decision then rejects it with "No need to
                // continue coverage task" (verified live 2026-05-06).
                const pausedForRecharge =
                  /Work:USER_RECHARGE_STOP\b/.test(busyMsg) ||
                  /Work:BATTERY_LOW_RECHARGE\b/.test(busyMsg);
                // Manual "Pause task & return" (e.g. rain): the firmware sets
                // Work:USER_STOP / Work:PAUSED and keeps it across the return-to-
                // dock (verified live on .100: msg stays "Work:USER_STOP" while
                // charging). Same resumable state as the recharge pause, so offer
                // the dock-side "Continue" (resume_navigation) here too.
                const pausedByUser =
                  /Work:USER_STOP\b/.test(busyMsg) ||
                  /Work:PAUSED\b/.test(busyMsg);
                // Stock 5.7.1 zet bij een accu-laadpauze midden in een beurt
                // GEEN van bovenstaande msg-strings, maar work_status 12
                // ("Low power") — de sleutel die beide melders van #30
                // aanleverden. Gedockt + coverage-taak + Low power = zelfde
                // hervatbare pauze, dus ook dan Continue i.p.v. verse start.
                const wsRaw = sensorsForResume?.work_status ?? '';
                const lowPowerPause = wsRaw === '12' || wsRaw === 'Low power';
                const isInterruptedCoverage =
                  onDock && taskMode === 1 && (pausedForRecharge || pausedByUser || lowPowerPause);
                const startDisabled = !mower.online || mower.hasError || noMap || mowerBusy || frameUnvalidated;
                // Keep the chevron (start-modes) reachable even when "Continue"
                // is shown, so the user can always start a fresh session instead
                // of resuming — never a dead-end.
                const canShowChevron = (displayActivity === 'idle' || displayActivity === 'charging')
                  && mower.online && !mower.hasError && !noMap && !mowerBusy;
                return (
                  <>
                  <View style={[styles.splitButtonWrap, startDisabled && { opacity: 1 }]}>
                    <TouchableOpacity
                      style={[
                        styles.splitButtonMain,
                        startDisabled ? styles.actionButtonDisabled : styles.actionButtonGreen,
                      ]}
                      onPress={async () => {
                        if (noMap) {
                          (navigation as any).navigate('Map', { screen: 'Mapping' });
                          return;
                        }
                        // Issue #30: an interrupted coverage session continues
                        // via resume_navigation, NOT a fresh start_navigation
                        // (the latter would restart from 0% and dump the
                        // already-mowed cov_path).
                        if (isInterruptedCoverage) {
                          await resumeCoverage(mower.sn);
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
                          <Ionicons
                            name={isInterruptedCoverage ? 'play-skip-forward' : 'play'}
                            size={20}
                            color={startDisabled ? colors.textMuted : colors.white}
                          />
                          <Text style={[styles.actionButtonText, startDisabled && { color: colors.textMuted }]}>
                            {/* "Start" i.p.v. "Start Mowing" — korter label
                                zodat het op smalle schermen blijft passen naast
                                de chevron. Disabled-states tonen wel de volledige
                                reden (no map / clear error). Issue #30:
                                'Continue' (t('resume')) when an interrupted
                                coverage session is waiting on the dock. */}
                            {noMap
                              ? t('noMapCreateFirst')
                              : mower.hasError
                              ? t('clearErrorFirst')
                              : isInterruptedCoverage
                              ? t('resume')
                              : t('start')}
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
                          disabled={commandLoading !== null || startDisabled}
                          activeOpacity={0.7}
                          accessibilityLabel="Show more start options"
                        >
                          <Ionicons name="chevron-down" size={18} color={colors.white} />
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                  {/* END SESSION — next to the interrupted-coverage "Resume":
                      end the paused session entirely instead of resuming it. */}
                  {isInterruptedCoverage && (
                    <TouchableOpacity
                      style={[styles.actionButton, styles.actionButtonRed]}
                      onPress={() => {
                        appAlertCompat.alert(
                          t('endSession') || 'End session?',
                          t('endSessionDesc') || 'The paused mowing session will be ended. The mower stays on the dock; you can start a new session afterwards.',
                          [
                            { text: t('cancel') || 'Cancel', style: 'cancel' },
                            {
                              text: t('endSession') || 'End session',
                              style: 'destructive',
                              onPress: () => {
                                sendCommand(mower.sn, { stop_navigation: { cmd_num: ++cmdNumRef.current } }, 'stop');
                                setOptimisticActivity('idle');
                              },
                            },
                          ],
                        );
                      }}
                      disabled={commandLoading !== null}
                      activeOpacity={0.7}
                    >
                      {commandLoading === 'stop' ? (
                        <ActivityIndicator size="small" color={colors.white} />
                      ) : (
                        <Ionicons name="stop" size={20} color={colors.white} />
                      )}
                    </TouchableOpacity>
                  )}
                  </>
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
              {/* Stop — halt in place, end session, do NOT dock.
                  Home (right) covers stop+dock; this button is for "stop here now". */}
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonRed]}
                onPress={() => {
                  appAlertCompat.alert(
                    t('stopMowing') || 'Stop mowing?',
                    t('stopMowingDesc') || 'The mower will halt where it is, blades will stop, and the current session ends. The mower won’t return to the dock. You can start a new session afterwards.',
                    [
                      { text: t('cancel') || 'Cancel', style: 'cancel' },
                      {
                        text: t('stop') || 'Stop',
                        style: 'destructive',
                        onPress: () => {
                          sendCommand(mower.sn, { stop_navigation: { cmd_num: ++cmdNumRef.current } }, 'stop');
                          (async () => {
                            try {
                              const url = await getServerUrl();
                              if (!url) return;
                              const api = new ApiClient(url);
                              await api.sendExtended(mower.sn, { stop_boundary_follow: {} });
                            } catch { /* non-fatal */ }
                          })();
                          setOptimisticActivity('idle');
                        },
                      },
                    ],
                  );
                }}
                disabled={commandLoading !== null}
                activeOpacity={0.7}
              >
                {commandLoading === 'stop' ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <Ionicons name="stop" size={20} color={colors.white} />
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonBlue]}
                onPress={() => {
                  appAlertCompat.alert(
                    t('returnHome') || 'Return Home',
                    t('returnHomeDesc') || 'How should the mower return to the charging station?',
                    [
                      {
                        text: t('endTaskReturn') || 'End task & return',
                        onPress: () => {
                          sendCommand(mower.sn, { stop_navigation: { cmd_num: ++cmdNumRef.current } }, 'stop');
                          // Idempotent: clears any lingering boundary-follow goal.
                          (async () => {
                            try {
                              const url = await getServerUrl();
                              if (!url) return;
                              const api = new ApiClient(url);
                              await api.sendExtended(mower.sn, { stop_boundary_follow: {} });
                            } catch { /* non-fatal */ }
                          })();
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

          {displayActivity === 'edge_cutting' && (
            <View style={styles.actionRow}>
              {/* Stop edge-cut + return to dock. The NTCP edge-cut
                  action does NOT respond to stop_navigation (it
                  bypasses robot_decision); we cancel via the firmware
                  extended command stop_boundary_follow which calls
                  /coverage_planner_server/cover_task_stop. After the
                  cancel, send the stock go_pile + go_to_charge sequence
                  so the mower drives itself back to the dock. */}
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonRed]}
                onPress={async () => {
                  try {
                    const url = await getServerUrl();
                    if (!url) return;
                    const api = new ApiClient(url);
                    await api.sendExtended(mower.sn, { stop_boundary_follow: {} });
                  } catch { /* non-fatal */ }
                  setOptimisticActivity('idle');
                }}
                disabled={commandLoading !== null}
                activeOpacity={0.7}
              >
                <Ionicons name="stop" size={20} color={colors.white} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonBlue]}
                onPress={async () => {
                  try {
                    const url = await getServerUrl();
                    if (!url) return;
                    const api = new ApiClient(url);
                    await api.sendExtended(mower.sn, { stop_boundary_follow: {} });
                  } catch { /* non-fatal */ }
                  setTimeout(() => { sendGoHome(mower.sn); }, 500);
                  setOptimisticActivity('returning');
                }}
                disabled={commandLoading !== null}
                activeOpacity={0.7}
              >
                <Ionicons name="home" size={20} color={colors.white} />
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
                        appAlertCompat.alert(
                          t('pausedForTitle', { label: pausedLabel }),
                          t('longPauseResumeBody'),
                          [
                            { text: t('cancel'), style: 'cancel' },
                            {
                              text: t('resumeAnyway'), style: 'destructive',
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
                onPress={() => {
                  // `stop_to_charge` cancels the auto_recharge action
                  // (ROS service /robot_decision/cancel_recharge). Without
                  // it, stop_navigation alone does NOT stop a return-to-dock
                  // because the recharge goal lives in auto_recharge_server,
                  // not coverage_planner_server.
                  sendCommand(mower.sn, { stop_to_charge: {} }, 'stop');
                  sendCommand(mower.sn, { stop_navigation: { cmd_num: ++cmdNumRef.current } }, 'stop');
                  // Also cancel any in-flight boundary-follow goal — a
                  // lingering server-side goal handle can otherwise keep
                  // driving the mower autonomously even after stop_navigation.
                  (async () => {
                    try {
                      const url = await getServerUrl();
                      if (!url) return;
                      const api = new ApiClient(url);
                      await api.sendExtended(mower.sn, { stop_boundary_follow: {} });
                    } catch { /* non-fatal */ }
                  })();
                  setOptimisticActivity('idle');
                }}
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

      {/* Post-restore re-anchor wizard: opened on demand from the banner (not
          auto-blocking, so the app + other mowers stay usable). One button runs
          the server-orchestrated auto flow (reanchor_pos -> drive back -> re-lock
          -> ArUco dock -> self-verify), with a manual joystick + verify backup.
          The server clears frame_unvalidated only when the docked position lands
          back on the origin. */}
      <ReanchorWizard
        visible={showReanchor}
        sn={mower.sn}
        sensors={devices.get(mower.sn)?.sensors}
        onClose={() => setShowReanchor(false)}
      />

      {/* History modal */}
      <Modal visible={showHistory} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modalHeader, { paddingTop: insets.top + 12 }]}>
          <TouchableOpacity onPress={() => setShowHistory(false)} style={styles.modalClose}>
            <Ionicons name="arrow-back" size={28} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.modalTitle}>{t('mowingHistory') || 'Mowing History'}</Text>
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
                // Stock `start_patrol` MQTT handler is a stub. Stock `start_run`
                // also can't reach cov_mode=2 (BOUNDARY_COV). We instead send the
                // extended command `start_edge_cut`, which makes a service call
                // to `/robot_decision/start_cov_task` so robot_decision loads
                // the map, validates the working zone, and dispatches the
                // `/boundary_follow` action with a populated context.
                // `wire = heightCm - 2` is the stock level encoding used by
                // StartCoverageTask.blade_heights (mm = (level + 2) * 10).
                await api.sendExtended(mower.sn, {
                  start_edge_cut: {
                    mapName: 'map0',
                    // heightCm → mm (NTCP goal's blade_height is mm, clamped 20..90)
                    bladeHeight: heightCm * 10,
                    // Stock start_cov_task drives ~1m off the dock as preamble.
                    // NTCP path bypasses robot_decision so we tell the handler
                    // to do the same back-off when the mower is on the charger.
                    departFromDock: mower.activity === 'charging',
                  },
                }).catch(() => { /* non-fatal, optimistic UI still set */ });
                setOptimisticActivity('edge_cutting');
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
                setOptimisticActivity('mowing');
              }
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
          onStarted={(settings) => {
            setCommandLoading(null);
            setOptimisticActivity('mowing');
            setMowSettings(settings);
            setStartedMapIds(settings.mapIds);
            setMowingTrail([]);
            setPlannedPaths([]);
            // Hide the previous session's coverage until the mower reports fresh
            // data — it keeps echoing the old finished_area while it drives to
            // the start point. Cleared by the freshSession effect (fingerprint
            // change / left mowing) or this safety timeout.
            const s = devices.get(mower.sn)?.sensors;
            freshSessionFingerprint.current = `${s?.finished_area ?? ''}|${s?.cover_map_id ?? ''}`;
            setFreshSession(true);
            if (freshSessionTimer.current) clearTimeout(freshSessionTimer.current);
            freshSessionTimer.current = setTimeout(() => setFreshSession(false), 180000);
          }}
          onPreviewPaths={(paths) => setPlannedPaths(paths)}
          initialSelectedMapId={startMowInitialMapId}
          forceZonePicker={startMowForceZone}
          battery={mower.battery}
          isWorking={displayActivity === 'mowing' || displayActivity === 'edge_cutting' || displayActivity === 'mapping'}
          currentCuttingHeight={(() => {
            // Prefer the user's saved Mower Settings value (defaultCuttingHeight,
            // mm 20-90 from set_para_info) over the live target_height echo.
            // target_height only updates after the firmware actually accepts a
            // mowing command — so a user who just set 40mm in Mower Settings and
            // never mowed yet would otherwise see the StartMowSheet snap to 5cm.
            const s = devices.get(mower.sn)?.sensors;
            const dft = parseInt(s?.defaultCuttingHeight ?? '', 10);
            if (Number.isFinite(dft) && dft > 0) return dft;
            const tgt = parseInt(s?.target_height ?? '', 10);
            return Number.isFinite(tgt) && tgt > 0 ? tgt : undefined;
          })()}
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

        // Edge mowing requires the `start_edge_cut` extended command,
        // which only exists in OpenNova custom firmware. On stock firmware
        // the equivalent stock MQTT (start_patrol) is a no-op stub, so we
        // disable the menu item and explain why instead of letting the
        // tap silently do nothing.
        const edgeNeedsCustomFw = !isOpenNovaFirmware(mower?.firmwareVersion);
        items.push({
          label: 'Edges only',
          subtitle: edgeNeedsCustomFw
            ? 'Requires OpenNova custom firmware'
            : 'Drive along the boundary once (boundary follow)',
          icon: 'ellipse-outline',
          disabled: edgeNeedsCustomFw,
          onPress: () => {
            if (edgeNeedsCustomFw) return;
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
        <View style={[styles.modalHeader, { paddingTop: insets.top + 12 }]}>
          <TouchableOpacity onPress={() => setShowAlerts(false)} style={styles.modalClose}>
            <Ionicons name="arrow-back" size={28} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.modalTitle}>{t('messages') || 'Messages'}</Text>
        </View>
        <MessagesScreen />
      </Modal>

      {/* Return-reason modal — explains WHY the mower is back on the dock. */}
      <ReturnReasonModal
        visible={reasonModalVisible}
        reason={returnReason}
        online={mower.online}
        loading={commandLoading !== null}
        onDismiss={() => setReasonModalVisible(false)}
        onResume={() => { setReasonModalVisible(false); resumeCoverage(mower.sn); }}
      />
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.bg,
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
    backgroundColor: c.red,
    borderWidth: 1.5,
    borderColor: c.bg,
  },
  modalHeader: {
    backgroundColor: c.card,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
  },
  modalClose: {
    padding: 4,
  },
  modalTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: c.text,
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
    color: c.textDim,
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
    backgroundColor: c.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.cardBorder,
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
    color: c.red,
    marginBottom: 2,
  },
  offlineMowerSn: {
    fontSize: 11,
    color: c.textDim,
    fontFamily: 'monospace',
    marginBottom: 6,
  },
  offlineMowerHint: {
    fontSize: 12,
    color: c.textMuted,
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
    color: c.text,
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 15,
    color: c.textDim,
    textAlign: 'center',
    lineHeight: 22,
  },
  setCard: {
    backgroundColor: c.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.cardBorder,
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
    color: c.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  setLora: {
    fontSize: 10,
    color: c.textMuted,
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
    color: c.emerald,
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
    color: c.text,
  },
  deviceSn: {
    fontSize: 11,
    color: c.textDim,
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
    color: c.textMuted,
    lineHeight: 18,
  },
  chargerCard: {
    width: '100%',
    backgroundColor: c.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.cardBorder,
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
    color: c.text,
  },
  chargerSn: {
    fontSize: 11,
    color: c.textDim,
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
    backgroundColor: c.emerald,
    borderRadius: 12,
  },
  addMowerText: {
    fontSize: 16,
    fontWeight: '600',
    color: c.text,
  },
  statusCard: {
    backgroundColor: c.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.cardBorder,
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
  mapMismatchBanner: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    zIndex: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(30, 21, 8, 0.92)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.55)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  mapMismatchText: {
    flex: 1,
    color: '#fbbf24',
    fontSize: 12,
    fontWeight: '700',
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
    color: c.text,
  },
  batteryPercSign: {
    fontSize: 12,
    fontWeight: '600',
    color: c.textDim,
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
  bladeStuckBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: 'rgba(239,68,68,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.45)',
    borderRadius: 6,
    alignSelf: 'stretch',
  },
  bladeStuckBannerText: {
    fontSize: 12,
    color: c.red,
    fontWeight: '600',
    flex: 1,
  },
  unicomTransitBox: {
    alignItems: 'center',
    marginTop: 8,
    gap: 6,
  },
  unicomTransitText: {
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
  },
  returnReasonChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: 6,
    alignSelf: 'stretch',
  },
  returnReasonChipText: {
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
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
  chipHighlight: {
    backgroundColor: 'rgba(34,197,94,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.45)',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipHighlightText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#4ade80',
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
    color: c.textDim,
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
    color: c.red,
    marginBottom: 4,
  },
  errorMessage: {
    fontSize: 13,
    color: 'rgba(239,68,68,0.8)',
    lineHeight: 18,
  },
  actionsCard: {
    backgroundColor: c.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.cardBorder,
    padding: 16,
    marginBottom: 12,
  },
  actionsTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: c.textDim,
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
    backgroundColor: c.green,
  },
  actionButtonAmber: {
    backgroundColor: c.amber,
  },
  actionButtonBlue: {
    backgroundColor: c.blue,
  },
  actionButtonRed: {
    backgroundColor: c.red,
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
    // Action buttons (Start Mowing, Go Home) sit on emerald/blue backgrounds
    // — keep text white in both modes for contrast. The bulk c.white→c.text
    // sweep was wrong here.
    color: c.white,
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
    color: c.textMuted,
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
    color: c.red,
  },
  snText: {
    fontSize: 12,
    color: c.textMuted,
    textAlign: 'center',
    fontFamily: 'monospace',
  },
});
