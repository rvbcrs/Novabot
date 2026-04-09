/**
 * Home screen — real-time mower status and action buttons.
 */
import React, { useMemo, useState, useEffect, useRef } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { colors } from '../theme/colors';
import { BatteryRing } from '../components/BatteryRing';
import { MowerScene } from '../components/mower/MowerScene';
import { useMowerState } from '../hooks/useMowerState';
import { ApiClient } from '../services/api';
import { getServerUrl } from '../services/auth';
import { DemoBanner } from '../components/DemoBanner';
import { MowingProgressMap } from '../components/MowingProgressMap';
import HistoryScreen from './HistoryScreen';
import MessagesScreen from './MessagesScreen';
import { useDemo } from '../context/DemoContext';
import { StartMowSheet } from '../components/StartMowSheet';
import { RainOverlay } from '../components/RainOverlay';
import { useI18n } from '../i18n';
import { getSocket } from '../services/socket';
import type { DeviceState, MowerActivity } from '../types';

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
  mapNum: number;
  mowerPosX: number | null;
  mowerPosY: number | null;
  mowerHeading: number | null;
}

function deriveMower(devices: Map<string, DeviceState>): MowerDerived | null {
  const mower = [...devices.values()].find((d) => d.deviceType === 'mower');
  if (!mower) return null;

  const s = mower.sensors;
  const workStatus = s.work_status ?? '0';
  const isOffline = !mower.online;
  // Error status from report_state_robot.
  // Non-blocking errors (LoRa warnings etc.) should not block the UI.
  const errorStatusRaw = parseInt(s.error_status?.match(/\d+/)?.[0] ?? '0', 10);
  const NON_BLOCKING_ERRORS = [8]; // 8 = LoRa disconnect warning, not a real fault
  const hasError = Boolean(
    errorStatusRaw > 0 && !NON_BLOCKING_ERRORS.includes(errorStatusRaw),
  );

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
  const isCoverageRunning = msg.includes('Work:RUNNING') || msg.includes('Work:NAVIGATING') || msg.includes('Work:COVERING') || msg.includes('Work:MOVING');
  const isCoveragePaused = msg.includes('Work:PAUSED');
  const isReturning = rechargeStatus === 1 || msg.includes('Recharge: GOING') || msg.includes('Work:GO_PILE')
    || msg.includes('Work:BACK_CHARGER') || msg.includes('Work:DOCKING');
  // "Sticky" mowing: off dock + coverage mode + work not explicitly stopped/finished
  // Prevents flicker during lane transitions (brief Work:WAIT between lanes)
  // But NOT sticky when returning home or explicitly cancelled/finished
  const isMowingSticky = !isOnDock && taskMode === 1 && !isReturning
    && !msg.includes('Work:FINISHED') && !msg.includes('Work:CANCELLED')
    && workStatus !== '0' && workStatus !== '9';

  let activity: MowerActivity = 'idle';
  if (isOffline) activity = 'idle';
  else if (hasError && !isOnDock) activity = 'error';
  else if (s.start_edit_or_assistant_map_flag === '1') activity = 'mapping';
  else if (isCoverageRunning) activity = 'mowing';
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

function getActivityIcon(
  activity: MowerActivity,
): React.ComponentProps<typeof Ionicons>['name'] {
  switch (activity) {
    case 'mowing':
      return 'leaf';
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
  const { devices, connected } = useMowerState();
  const { t } = useI18n();
  const mower = useMemo(() => deriveMower(devices), [devices]);
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
  const [commandError, setCommandError] = useState('');
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
  // Track mowing settings for safety check + display
  const [mowSettings, setMowSettings] = useState<{ cuttingHeight: number; pathDirection: number } | null>(null);
  const demo = useDemo();

  // Fetch device sets + map count from server
  const [serverMapCount, setServerMapCount] = useState(0);
  useEffect(() => {
    if (demo.enabled) return;
    (async () => {
      try {
        const url = await getServerUrl();
        if (!url) return;
        const api = new ApiClient(url);
        const res = await api.getDeviceSets();
        setDeviceSets(res.sets ?? []);
        // Also check if mower has maps on the server
        const mowerDev = [...devices.values()].find(d => d.deviceType === 'mower');
        if (mowerDev?.sn) {
          const mapsRes = await api.fetchMaps(mowerDev.sn).catch(() => ({ maps: [] }));
          const workMaps = (mapsRes.maps ?? []).filter((m: any) => m.mapType === 'work');
          setServerMapCount(workMaps.length);
        }
      } catch { /* ignore */ }
    })();
  }, [connected, devices.size, demo.enabled]);

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
        const workMap = res.maps?.find((m: any) => m.mapType === 'work');
        if (workMap && workMap.mapArea && workMap.mapArea.length >= 3) setActiveMapPolygon(workMap.mapArea);
      } catch { /* ignore */ }
    })();
  }, [mower?.sn, demo.enabled]);

  // Safety check: verify mower cutting height matches what we set
  // target_height from firmware = (cutterhigh + 2) * 10 (based on Flutter decompilation)
  const heightCheckDone = useRef(false);
  useEffect(() => {
    if (!mower || !mowSettings || mower.activity !== 'mowing') { heightCheckDone.current = false; return; }
    const reportedHeight = parseInt(devices.get(mower.sn)?.sensors?.target_height ?? '0', 10);
    if (reportedHeight === 0 || heightCheckDone.current) return;
    // Both target_height and cuttingHeight are in mm (20-90 range)
    // Allow 15mm tolerance for firmware rounding
    if (Math.abs(reportedHeight - mowSettings.cuttingHeight) > 15) {
      heightCheckDone.current = true;
      Alert.alert(
        'Cutting Height Mismatch!',
        `Expected ${mowSettings.cuttingHeight / 10}cm but mower reports ${(reportedHeight / 10).toFixed(1)}cm. Stop mowing for safety?`,
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

  // Auto-refresh trail every 3s during mowing
  useEffect(() => {
    if (!mower || (mower.activity !== 'mowing' && mower.activity !== 'mapping') || demo.enabled) return;
    const refresh = async () => {
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
      } catch { /* ignore */ }
    };
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [mower?.activity, mower?.sn, demo.enabled]);

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
        const mowerChannel = chargerLora.channel - 1;  // Mower is always charger channel - 1
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
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <ScrollView contentContainerStyle={styles.emptyScroll}>


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

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={
        <RefreshControl refreshing={false} tintColor={colors.purple} onRefresh={() => {
          const socket = getSocket();
          if (socket) socket.emit('request:snapshot');
        }} />
      }>
        {/* Global demo toggle */}


        {/* Top bar: connection + alert/history icons */}
        <View style={styles.topBar}>
          {/* Mower info */}
          <View style={styles.connectionRow}>
            <View
              style={[
                styles.connectionDot,
                { backgroundColor: mower.online ? colors.green : colors.red },
              ]}
            />
            <Text style={styles.connectionText}>{mower.sn}</Text>
            {mower.online && (devices.get(mower.sn)?.sensors?.sw_version || devices.get(mower.sn)?.sensors?.mower_version) && (
              <>
                <View style={styles.connectionSpacer} />
                <Text style={[styles.connectionText, { color: colors.textMuted }]}>
                  {devices.get(mower.sn)?.sensors?.sw_version ?? devices.get(mower.sn)?.sensors?.mower_version}
                </Text>
              </>
            )}
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

        {/* Mower animation scene */}
        <MowerScene activity={displayActivity} battery={mower.battery} mowingProgress={mower.mowingProgress} />

        {/* Status card */}
        <View style={styles.statusCard}>
          {/* Activity header */}
          <View style={styles.activityRow}>
            <Ionicons
              name={getActivityIcon(displayActivity)}
              size={24}
              color={activityColor}
            />
            <Text style={[styles.activityLabel, { color: activityColor }]}>
              {getActivityLabel(displayActivity, t)}
            </Text>
            {mower.mowingProgress > 0 && (displayActivity === 'mowing' || displayActivity === 'mapping') && (
              <Text style={[styles.progressText, { color: activityColor }]}>
                {mower.mowingProgress}%
              </Text>
            )}
          </View>

          {/* Progress bar */}
          {mower.mowingProgress > 0 && (displayActivity === 'mowing' || displayActivity === 'mapping') && (
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${mower.mowingProgress}%` as any, backgroundColor: activityColor }]} />
            </View>
          )}

          {/* Mowing/mapping: show progress map instead of battery ring */}
          {(displayActivity === 'mowing' || displayActivity === 'mapping') && activeMapPolygon.length >= 3 ? (
            <MowingProgressMap
              polygon={activeMapPolygon}
              progress={mower.mowingProgress}
              pathDirection={mowSettings?.pathDirection ?? mower.pathDirection}
              size={240}
              trail={mowingTrail}
              plannedPaths={plannedPaths}
              mowerPos={mower.mowerPosX != null && mower.mowerPosY != null ? { x: mower.mowerPosX, y: mower.mowerPosY } : null}
              mowerHeading={mower.mowerHeading ?? undefined}
            />
          ) : (
            /* Battery ring + mower image (default) */
            <View style={[styles.batteryContainer, { shadowColor: GLOW_COLOR[displayActivity], shadowRadius: 30, shadowOpacity: 1 }]}>
              <BatteryRing
                percentage={mower.battery}
                size={160}
                strokeWidth={10}
                color={displayActivity === 'idle' ? undefined : getActivityColor(displayActivity)}
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

          {/* Signal chips */}
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
            {devices.get(mower.sn)?.sensors?.cpu_temperature && (
              <View style={styles.chip}>
                <Ionicons name="thermometer" size={11} color={colors.textDim} />
                <Text style={styles.chipText}>{devices.get(mower.sn)?.sensors?.cpu_temperature}°</Text>
              </View>
            )}
            {!mower.online && (
              <View style={[styles.chip, styles.chipOffline]}>
                <Ionicons
                  name="cloud-offline"
                  size={11}
                  color={colors.red}
                />
                <Text style={[styles.chipText, { color: colors.red }]}>
                  {t('offline')}
                </Text>
              </View>
            )}
          </View>
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
          </View>
        )}

        {/* Rain overlay */}
        <View style={{ marginBottom: 16 }}>
          <RainOverlay mowerSn={mower.sn} />
        </View>

        {/* Action buttons */}
        <View style={styles.actionsCard}>
          <Text style={styles.actionsTitle}>{t('actions')}</Text>

          {(displayActivity === 'idle' || displayActivity === 'charging') && (
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[
                  styles.actionButton,
                  (mower.hasError || mower.mapNum === 0 && serverMapCount === 0)
                    ? styles.actionButtonDisabled
                    : styles.actionButtonGreen,
                  { flex: 1 },
                ]}
                onPress={() => mower.mapNum === 0 && serverMapCount === 0
                  ? (navigation as any).navigate('AppSettings', { screen: 'Mapping' })
                  : setShowStartMow(true)
                }
                disabled={commandLoading !== null || !mower.online || mower.hasError}
                activeOpacity={0.7}
              >
                {commandLoading === 'start' ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <>
                    <Ionicons name="play" size={20} color={mower.hasError || mower.mapNum === 0 && serverMapCount === 0 ? colors.textMuted : colors.white} />
                    <Text style={[styles.actionButtonText, (mower.hasError || mower.mapNum === 0 && serverMapCount === 0) && { color: colors.textMuted }]}>
                      {mower.mapNum === 0 && serverMapCount === 0 ? t('noMapCreateFirst') : mower.hasError ? t('clearErrorFirst') : t('startMowing')}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
              {/* Go Home button — only when mower is NOT on charger */}
              {displayActivity === 'idle' && (
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
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonRed]}
                onPress={() => {
                  sendCommand(mower.sn, { stop_navigation: { cmd_num: ++cmdNumRef.current } }, 'stop');
                  setOptimisticActivity('idle');
                }}
                disabled={commandLoading !== null}
                activeOpacity={0.7}
              >
                {commandLoading === 'stop' ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <>
                    <Ionicons name="stop-circle" size={20} color={colors.white} />
                  </>
                )}
              </TouchableOpacity>
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

          {displayActivity === 'paused' && (
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonGreen]}
                onPress={() => {
                  sendCommand(mower.sn, { resume_navigation: { cmd_num: ++cmdNumRef.current } }, 'resume');
                  setOptimisticActivity('mowing');
                }}
                disabled={commandLoading !== null}
                activeOpacity={0.7}
              >
                {commandLoading === 'resume' ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <>
                    <Ionicons name="play" size={20} color={colors.white} />
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonBlue]}
                onPress={() =>
                  { sendGoHome(mower.sn); setOptimisticActivity('returning'); }
                }
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

          {displayActivity === 'error' && (
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonBlue]}
                onPress={() =>
                  { sendGoHome(mower.sn); setOptimisticActivity('returning'); }
                }
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

      {/* Alerts modal */}
      {/* Start Mow Sheet */}
      {mower && (
        <StartMowSheet
          visible={showStartMow}
          onClose={() => setShowStartMow(false)}
          sn={mower.sn}
          onStarted={(settings) => { setCommandLoading(null); setOptimisticActivity('mowing'); setMowSettings(settings); setMowingTrail([]); }}
          battery={mower.battery}
          isWorking={displayActivity === 'mowing' || displayActivity === 'mapping'}
          currentCuttingHeight={parseInt(devices.get(mower.sn)?.sensors?.defaultCuttingHeight ?? devices.get(mower.sn)?.sensors?.target_height ?? '', 10) || undefined}
          currentPathDirection={parseInt(devices.get(mower.sn)?.sensors?.path_direction ?? '', 10) || undefined}
        />
      )}

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
    padding: 24,
    paddingBottom: 32,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
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
    padding: 24,
    alignItems: 'center',
    marginBottom: 16,
  },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 20,
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
  chipsRow: {
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
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
    padding: 20,
    marginBottom: 16,
  },
  actionsTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 16,
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
