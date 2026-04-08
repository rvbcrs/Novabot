/**
 * Mapping screen — create new maps by driving the mower around boundaries.
 *
 * Two modes:
 * 1. Manual: user controls via integrated joystick (start_scan_map)
 * 2. Autonomous: mower drives itself (start_assistant_build_map) [experimental]
 *
 * Flow: Check GPS/Loc → Choose mode → Map in progress (joystick + live stats)
 *       → Stop & Save → Charger positioning → Done
 *
 * State machine: idle → mapping → stopping → chargerPosition → done
 *                           ↘ cancelled (discard)
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Dimensions,
  Platform,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import {
  GestureDetector,
  Gesture,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { colors } from '../theme/colors';
import { LiveMapView } from '../components/LiveMapView';
import { useMowerState } from '../hooks/useMowerState';
import { getSocket } from '../services/socket';
import { ApiClient } from '../services/api';
import { getServerUrl } from '../services/auth';
import { useExperimental } from '../context/ExperimentalContext';
import { useI18n } from '../i18n';
import {
  bleJoystickConnect, bleJoystickDisconnect,
  bleJoystickStart, bleJoystickMove, bleJoystickStop,
  isBleJoystickConnected, scanForDevices, type ScannedDevice,
} from '../services/ble';

// ── Joystick constants (smaller than JoystickScreen) ──
const { width: SCREEN_W } = Dimensions.get('window');
const JOYSTICK_SIZE = Math.min(SCREEN_W * 0.50, 200);
const THUMB_SIZE = 52;
const DEAD_ZONE = 0.05;
const THROTTLE_MS = 80;

const SPEED_LEVELS = [
  { labelKey: 'slow', linear: 0.15, angular: 0.3 },
  { labelKey: 'normal', linear: 0.3, angular: 0.5 },
  { labelKey: 'fast', linear: 0.5, angular: 0.8 },
];

function getHoldType(x: number, y: number): number {
  if (Math.abs(y) >= Math.abs(x)) {
    return y < 0 ? 3 : 4; // up = forward(3), down = backward(4)
  }
  return x < 0 ? 1 : 2; // left(1), right(2)
}

type MappingState = 'idle' | 'preMapping' | 'mapping' | 'stopping' | 'chargerPosition' | 'done' | 'cancelled';
type MappingMode = 'autonomous' | 'manual';

export default function MappingScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { devices } = useMowerState();
  const experimental = useExperimental();
  const { t } = useI18n();

  const mower = [...devices.values()].find(d => d.deviceType === 'mower' && d.online);
  const sn = mower?.sn ?? '';
  const sensors = mower?.sensors ?? {};

  // ── State machine ──
  const [mappingState, setMappingState] = useState<MappingState>('idle');
  const [mappingMode, setMappingMode] = useState<MappingMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Joystick state ──
  const [joystickActive, setJoystickActive] = useState(false);
  const [thumbX, setThumbX] = useState(0);
  const [thumbY, setThumbY] = useState(0);
  const [speedLevel, setSpeedLevel] = useState(1);
  const joystickActiveRef = useRef(false);
  const lastSendRef = useRef(0);
  const speedRef = useRef(1);

  // ── Command counter (official app uses incrementing cmd_num in all mapping commands) ──
  const cmdNumRef = useRef(1);

  // ── BLE joystick state ──
  const [bleConnected, setBleConnected] = useState(false);
  const [bleConnecting, setBleConnecting] = useState(false);
  const bleIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentMstRef = useRef({ x_w: 0, y_v: 0, z_g: 0 });
  const currentHoldTypeRef = useRef(3);

  // ── Closed cycle detection ──
  const [closedCycleSeen, setClosedCycleSeen] = useState(false);
  const closedCycleDismissedRef = useRef(false);

  // ── Trail points for LiveMapView ──
  const [trailPoints, setTrailPoints] = useState<Array<{x: number; y: number}>>([]);
  const lastTrailRef = useRef<{x: number; y: number} | null>(null);

  // ── Sensor readiness ──
  const gpsValid = sensors.gps_valid === '1'
    || sensors.gps_satellites !== undefined
    || sensors.gps_state === 'ENABLE'
    || (sensors.latitude !== undefined && parseFloat(sensors.latitude) !== 0);
  const locQuality = parseInt(sensors.loc_quality ?? '0', 10);
  const locReady = locQuality >= 80;
  const mappingReady = gpsValid && locReady;
  const battery = parseInt(sensors.battery_power ?? sensors.battery_capacity ?? '0', 10) || 0;

  // ── Detect closed cycle: mower sensor OR proximity of last point to first point ──
  const ifClosedCycle = sensors.if_closed_cycle === '1';

  useEffect(() => {
    if (mappingState !== 'mapping' || closedCycleSeen) return;

    // Method 1: mower reports if_closed_cycle
    if (ifClosedCycle) {
      setClosedCycleSeen(true);
      return;
    }

    // Method 2: detect if trail end is close to trail start (within 1.5m, min 10 points)
    if (trailPoints.length >= 10) {
      const first = trailPoints[0];
      const last = trailPoints[trailPoints.length - 1];
      const dx = last.x - first.x;
      const dy = last.y - first.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1.5) {
        setClosedCycleSeen(true);
      }
    }
  }, [ifClosedCycle, mappingState, closedCycleSeen, trailPoints]);

  // ── Collect trail points from map_position sensor data ──
  const mapPosX = sensors.map_position_x;
  const mapPosY = sensors.map_position_y;
  const mapOrientation = parseFloat(sensors.map_position_orientation ?? '0') || 0;

  useEffect(() => {
    if (mappingState !== 'mapping') return;
    if (mapPosX === undefined || mapPosY === undefined) return;

    const x = parseFloat(mapPosX);
    const y = parseFloat(mapPosY);
    if (isNaN(x) || isNaN(y)) return;

    // Skip duplicate points (same position)
    const last = lastTrailRef.current;
    if (last && Math.abs(last.x - x) < 0.01 && Math.abs(last.y - y) < 0.01) return;

    lastTrailRef.current = { x, y };
    setTrailPoints(prev => [...prev, { x, y }]);
  }, [mappingState, mapPosX, mapPosY]);

  // Reset trail when starting fresh or returning to idle
  useEffect(() => {
    if (mappingState === 'idle' || mappingState === 'preMapping') {
      setTrailPoints([]);
      lastTrailRef.current = null;
    }
  }, [mappingState]);

  // ── Detect if already mapping (from sensor data on screen open) ──
  const isMappingActive = sensors.start_edit_or_assistant_map_flag === '1' ||
    sensors.task_mode === '3';

  useEffect(() => {
    if (isMappingActive && mappingState === 'idle') {
      setMappingState('mapping');
    }
  }, [isMappingActive, mappingState]);

  // ── Elapsed timer ──
  useEffect(() => {
    if (mappingState === 'mapping') {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [mappingState]);

  // ── Keep speedRef in sync ──
  useEffect(() => { speedRef.current = speedLevel; }, [speedLevel]);

  // ── Cleanup BLE joystick on unmount ──
  useEffect(() => {
    return () => {
      if (bleIntervalRef.current) { clearInterval(bleIntervalRef.current); bleIntervalRef.current = null; }
      bleJoystickStop().catch(() => {});
      bleJoystickDisconnect().catch(() => {});
    };
  }, []);

  // ── MQTT command helper ──
  const sendCommand = useCallback((command: Record<string, unknown>, label: string) => {
    const socket = getSocket();
    if (!socket || !sn) return;
    setBusy(true);
    socket.emit('joystick:cmd', { sn, command });
    console.log(`[Mapping] Sent: ${label}`);
    setTimeout(() => setBusy(false), 1500);
  }, [sn]);

  // ── BLE joystick: connect to mower ──
  const connectBleJoystick = useCallback(async () => {
    if (bleConnected || bleConnecting) return;
    setBleConnecting(true);

    // Scan for mower BLE device
    let mowerDeviceId: string | null = null;
    await new Promise<void>((resolve) => {
      const cancel = scanForDevices(8000, (dev: ScannedDevice) => {
        if (dev.type === 'mower') {
          mowerDeviceId = dev.id;
          cancel();
          resolve();
        }
      }, () => resolve());
    });

    if (!mowerDeviceId) {
      Alert.alert('BLE', 'Mower not found via BLE. Make sure Bluetooth is enabled and mower is nearby.');
      setBleConnecting(false);
      return;
    }

    const ok = await bleJoystickConnect(mowerDeviceId);
    setBleConnected(ok);
    setBleConnecting(false);
    if (!ok) Alert.alert('BLE', 'Failed to connect to mower via BLE.');
  }, [bleConnected, bleConnecting]);

  // ── BLE joystick move (updates ref, interval sends) ──
  // x_w = forward/backward speed (from Y axis), y_v = turn speed (from X axis)
  // holdType: 3=forward, 4=backward — determines motor direction
  // mst provides BOTH linear + angular simultaneously for smooth curves
  const sendMove = useCallback((dx: number, dy: number) => {
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < DEAD_ZONE) {
      currentMstRef.current = { x_w: 0, y_v: 0, z_g: 0 };
      return;
    }
    const lvl = SPEED_LEVELS[speedRef.current];
    // holdType based on dominant Y direction (forward/backward)
    // Pure left/right uses holdType 1/2, but with forward component use 3/4
    const holdType = Math.abs(dy) >= Math.abs(dx) * 0.3
      ? (dy < 0 ? 3 : 4)   // forward (3) or backward (4) when Y is dominant
      : (dx < 0 ? 1 : 2);  // left (1) or right (2) when pure sideways
    currentHoldTypeRef.current = holdType;
    // x_w = forward/backward magnitude from Y axis
    // y_v = turning magnitude from X axis
    // Both can be non-zero simultaneously → smooth curves!
    currentMstRef.current = {
      x_w: Math.round(Math.abs(dy) * lvl.linear * 100) / 100,
      y_v: Math.round(Math.abs(dx) * lvl.angular * 100) / 100,
      z_g: 0,
    };
  }, []);

  const stopJoystick = useCallback(() => {
    joystickActiveRef.current = false;
    setJoystickActive(false);
    setThumbX(0);
    setThumbY(0);
    // Stop BLE interval
    if (bleIntervalRef.current) { clearInterval(bleIntervalRef.current); bleIntervalRef.current = null; }
    // Send stop via BLE
    bleJoystickStop().catch(() => {});
  }, []);

  // ── Joystick gesture ──
  const radius = JOYSTICK_SIZE / 2;

  const handleGestureStart = useCallback((x: number, y: number) => {
    joystickActiveRef.current = true;
    setJoystickActive(true);
    let dx = x - radius;
    let dy = y - radius;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > radius) { dx = dx / dist * radius; dy = dy / dist * radius; }
    const nx = dx / radius;
    const ny = dy / radius;
    setThumbX(dx);
    setThumbY(dy);

    const holdType = getHoldType(nx, ny) || 3;
    currentHoldTypeRef.current = holdType;
    sendMove(nx, ny);

    // Official app sends BOTH start_move AND mst every 300ms (Timer.periodic)
    // Both commands are awaited sequentially (queued writes)
    if (!bleIntervalRef.current) {
      // Send immediately on first touch
      bleJoystickStart(holdType).then(() => bleJoystickMove(currentMstRef.current));

      bleIntervalRef.current = setInterval(async () => {
        if (!joystickActiveRef.current) return;
        // Every 300ms: start_move then mst (sequential, queued)
        await bleJoystickStart(currentHoldTypeRef.current);
        await bleJoystickMove(currentMstRef.current);
      }, 300);
    }
  }, [radius, sendMove]);

  const handleGestureUpdate = useCallback((x: number, y: number) => {
    if (!joystickActiveRef.current) return;
    let dx = x - radius;
    let dy = y - radius;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > radius) { dx = dx / dist * radius; dy = dy / dist * radius; }
    setThumbX(dx);
    setThumbY(dy);
    sendMove(dx / radius, dy / radius);
  }, [radius, sendMove]);

  // Memoize gesture to prevent re-creation on every render (sensor updates cause re-renders).
  // Without this, each re-render resets the gesture handler → choppy joystick.
  const panGesture = React.useMemo(() => Gesture.Pan()
    .onStart((e) => { runOnJS(handleGestureStart)(e.x, e.y); })
    .onUpdate((e) => { runOnJS(handleGestureUpdate)(e.x, e.y); })
    .onEnd(() => { runOnJS(stopJoystick)(); })
    .onFinalize(() => { runOnJS(stopJoystick)(); }),
  [handleGestureStart, handleGestureUpdate, stopJoystick]);

  // ── Start mapping ──
  const handleStartManual = () => {
    Alert.alert(
      t('manualMapping', undefined) || 'Manual Mapping',
      'Step 1: Drive OFF the charger to the starting point of your boundary.\n\nStep 2: Drive along the entire perimeter of your garden until you return to the start.\n\nStep 3: Tap "Stop & Save" when done. The mower will return to the charger automatically.',
      [
        { text: t('cancel', undefined) || 'Cancel', style: 'cancel' },
        {
          text: 'Start',
          onPress: async () => {
            // Connect BLE joystick first
            setBleConnecting(true);
            await connectBleJoystick();
            setBleConnecting(false);

            const bleOk = isBleJoystickConnected();
            console.log(`[Mapping] BLE connected: ${bleOk}`);
            if (!bleOk) {
              Alert.alert('BLE', 'BLE not connected — check Bluetooth and proximity.');
            }

            // Go to pre-mapping: joystick active, drive to start point, NOT recording yet
            setMappingMode('manual');
            setMappingState('preMapping');
          },
        },
      ],
    );
  };

  const handleStartAutonomous = () => {
    Alert.alert(
      t('autoMapping', undefined) || 'Autonomous Mapping',
      'The mower will drive around autonomously to create a map of your garden. Make sure the area is clear of obstacles.',
      [
        { text: t('cancel', undefined) || 'Cancel', style: 'cancel' },
        {
          text: 'Start',
          onPress: () => {
            sendCommand({ start_assistant_build_map: { cmd_num: cmdNumRef.current++ } }, 'start_assistant_build_map');
            setMappingMode('autonomous');
            setMappingState('mapping');
            setClosedCycleSeen(false);
            closedCycleDismissedRef.current = false;
          },
        },
      ],
    );
  };

  // ── Begin Recording: user reached start point, now start actual recording ──
  const handleBeginRecording = async () => {
    // Clear server-side GPS trail before starting new recording
    try {
      const url = await getServerUrl();
      if (url && sn) {
        await fetch(`${url}/api/dashboard/trail/${encodeURIComponent(sn)}`, { method: 'DELETE' });
        console.log('[Mapping] Server trail cleared');
      }
    } catch {}

    // Exact payload from official Novabot app (Flutter decompilation):
    // Blutter: model="border"|"obstacle", manual=true|false, mapName, map0, type=0
    sendCommand({ start_scan_map: { model: 'border', manual: true, mapName: 'map0', map0: '', type: 0, cmd_num: cmdNumRef.current++ } }, 'start_scan_map');
    setMappingState('mapping');
    setClosedCycleSeen(false);
    closedCycleDismissedRef.current = false;
    console.log('[Mapping] Recording started!');
  };

  // ── Stop & Save (exact flow from official Novabot app) ──
  // Flutter: stop_scan_map → delay → save_map → uploadMapToServer
  //          → auto_recharge (mower drives itself to charger!)
  //          → wait for mower to dock → save_recharge_pos → DONE
  const handleStop = () => {
    Alert.alert(
      t('stopMapping', undefined) || 'Stop Mapping',
      closedCycleSeen
        ? 'Boundary is closed. Stop mapping and save?'
        : 'The boundary may not be fully closed yet. Stop anyway?',
      [
        { text: t('continueMapping', undefined) || 'Continue', style: 'cancel' },
        {
          text: t('stopAndSave', undefined) || 'Stop & Save',
          onPress: async () => {
            if (joystickActiveRef.current) stopJoystick();
            const socket = getSocket();

            // Helper: wait for a specific _respond via Socket.io (with timeout)
            const waitForRespond = (cmd: string, timeoutMs: number): Promise<boolean> => {
              return new Promise((resolve) => {
                const timer = setTimeout(() => { resolve(false); }, timeoutMs);
                const handler = (e: { sn: string; command: string; data: unknown }) => {
                  if (e.sn === sn && e.command === cmd) {
                    clearTimeout(timer);
                    socket?.off('command:respond', handler);
                    resolve(true);
                  }
                };
                socket?.on('command:respond', handler);
              });
            };

            // Step 1: stop_scan_map → wait for stop_scan_map_respond
            // Exact payload: {"stop_scan_map": {"value": true, "cmd_num": N}}
            setMappingState('stopping');
            sendCommand({ stop_scan_map: { value: true, cmd_num: cmdNumRef.current++ } }, 'stop_scan_map');
            console.log('[Mapping] Step 1: stop_scan_map sent, waiting for respond...');
            const stopOk = await waitForRespond('stop_scan_map_respond', 10000);
            console.log(`[Mapping] Step 1: stop_scan_map_respond ${stopOk ? 'OK' : 'TIMEOUT'}`);

            // Step 2: save_map → wait for save_map_respond
            // Exact payload: {"save_map": {"mapName": "map0", "type": 0, "cmd_num": N}}
            await new Promise(r => setTimeout(r, 1000));
            sendCommand({ save_map: { mapName: 'map0', type: 0, cmd_num: cmdNumRef.current++ } }, 'save_map');
            console.log('[Mapping] Step 2: save_map sent, waiting for respond...');
            const saveOk = await waitForRespond('save_map_respond', 30000);
            console.log(`[Mapping] Step 2: save_map_respond ${saveOk ? 'OK' : 'TIMEOUT'}`);

            // Step 3: go to charger positioning screen
            // User drives mower to ~50cm from charger, then presses Auto Dock
            setMappingState('chargerPosition');
            console.log('[Mapping] Step 3: drive to charger → user controls via joystick');
          },
        },
      ],
    );
  };

  // ── Monitor recharge_status: when mower docks, save charger position ──
  // Flutter app: waits for recharge_status > 0 → save_recharge_pos → save_recharge_pos_respond → done
  const rechargeStatus = parseInt(sensors.recharge_status ?? '0', 10);
  const prevRechargeRef = useRef(0);
  const savingChargerPosRef = useRef(false);
  useEffect(() => {
    if (mappingState === 'chargerPosition' && rechargeStatus > 0 && prevRechargeRef.current === 0 && !savingChargerPosRef.current) {
      savingChargerPosRef.current = true;
      console.log('[Mapping] Step 5: Mower docked! Sending save_recharge_pos...');
      sendCommand({ save_recharge_pos: { mapName: 'map0', map0: '', cmd_num: cmdNumRef.current++ } }, 'save_recharge_pos');

      // Wait for save_recharge_pos_respond
      const socket = getSocket();
      const timer = setTimeout(() => {
        console.log('[Mapping] save_recharge_pos_respond TIMEOUT — marking done anyway');
        setMappingState('done');
      }, 15000);
      const handler = (e: { sn: string; command: string }) => {
        if (e.sn === sn && e.command === 'save_recharge_pos_respond') {
          clearTimeout(timer);
          socket?.off('command:respond', handler);
          console.log('[Mapping] Step 5: save_recharge_pos_respond OK — DONE!');
          setMappingState('done');
        }
      };
      socket?.on('command:respond', handler);
    }
    prevRechargeRef.current = rechargeStatus;
  }, [rechargeStatus, mappingState, sendCommand, sn]);

  // ── Cancel / Discard ──
  const handleCancel = () => {
    Alert.alert(
      t('cancelMapping', undefined) || 'Cancel Mapping',
      t('discardConfirm', undefined) || 'Discard the current map? This cannot be undone.',
      [
        { text: t('continueMapping', undefined) || 'Continue', style: 'cancel' },
        {
          text: t('discardMapping', undefined) || 'Discard',
          style: 'destructive',
          onPress: () => {
            if (joystickActiveRef.current) stopJoystick();
            sendCommand({ stop_scan_map: { value: true, cmd_num: cmdNumRef.current++ } }, 'stop_scan_map (cancel)');
            sendCommand({ quit_mapping_mode: { value: 1, cmd_num: cmdNumRef.current++ } }, 'quit_mapping_mode');
            setMappingState('cancelled');
            setTimeout(() => navigation.goBack(), 500);
          },
        },
      ],
    );
  };

  // ── Manual charger position save (fallback if auto_recharge doesn't dock) ──
  const handleSaveChargerPos = async () => {
    sendCommand({ save_recharge_pos: { mapName: 'map0', map0: '', cmd_num: cmdNumRef.current++ } }, 'save_recharge_pos');
    const socket = getSocket();
    const responded = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10000);
      const handler = (e: { sn: string; command: string }) => {
        if (e.sn === sn && e.command === 'save_recharge_pos_respond') {
          clearTimeout(timer);
          socket?.off('command:respond', handler);
          resolve(true);
        }
      };
      socket?.on('command:respond', handler);
    });
    console.log(`[Mapping] Manual save_recharge_pos_respond: ${responded ? 'OK' : 'TIMEOUT'}`);
    setMappingState('done');
  };

  // ── Helpers ──
  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const joystickDist = Math.sqrt(thumbX * thumbX + thumbY * thumbY) / radius;
  const speedMs = (joystickDist * SPEED_LEVELS[speedLevel].linear).toFixed(2);

  // ── Render ──
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.white} />
          </TouchableOpacity>
          <Text style={styles.title}>{t('createMap', undefined) || 'Create Map'}</Text>
        </View>

        {/* ── Mower offline ── */}
        {!mower?.online ? (
          <View style={styles.centerBox}>
            <Ionicons name="alert-circle" size={48} color={colors.red} />
            <Text style={styles.centerTitle}>{t('mowerOffline', undefined) || 'Mower Offline'}</Text>
            <Text style={styles.centerSub}>{t('connectMowerToMap', undefined) || 'Connect your mower to create a map.'}</Text>
          </View>

        /* ── Idle: readiness + mode selection ── */
        ) : mappingState === 'idle' ? (
          <ScrollView style={styles.content} contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
            {/* Readiness check */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{t('readinessCheck', undefined) || 'READINESS CHECK'}</Text>
              <View style={styles.checkRow}>
                <View style={[styles.checkDot, { backgroundColor: gpsValid ? colors.green : colors.red }]} />
                <Text style={styles.checkText}>
                  {t('gps', undefined) || 'GPS'}: {gpsValid ? `${t('gpsOk', undefined) || 'OK'}${sensors.gps_satellites ? ` (${sensors.gps_satellites} sats)` : ''}` : (t('noSignal', undefined) || 'No signal')}
                </Text>
              </View>
              <View style={styles.checkRow}>
                <View style={[styles.checkDot, { backgroundColor: locReady ? colors.green : colors.amber }]} />
                <Text style={styles.checkText}>
                  {t('localization', undefined) || 'Localization'}: {locQuality}%{locReady ? ` (${t('ready', undefined) || 'Ready'})` : ` (${t('initializing', undefined) || 'Initializing...'})`}
                </Text>
              </View>
              <View style={styles.checkRow}>
                <View style={[styles.checkDot, { backgroundColor: mower.online ? colors.green : colors.red }]} />
                <Text style={styles.checkText}>{t('mqtt', undefined) || 'MQTT'}: {t('connected', undefined) || 'Connected'}</Text>
              </View>
              <View style={styles.checkRow}>
                <View style={[styles.checkDot, { backgroundColor: battery > 20 ? colors.green : colors.red }]} />
                <Text style={styles.checkText}>Battery: {battery}%</Text>
              </View>
              {!mappingReady && (
                <Text style={styles.warning}>
                  {t('waitForGps', undefined) || 'Waiting for GPS fix and localization. Drive the mower a few meters to help alignment.'}
                </Text>
              )}
            </View>

            {/* Mode selection */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{t('mappingMode', undefined) || 'MAPPING MODE'}</Text>

              <TouchableOpacity
                style={[styles.modeBtn, !mappingReady && styles.modeBtnDisabled]}
                onPress={handleStartManual}
                disabled={!mappingReady || busy}
                activeOpacity={0.7}
              >
                <View style={styles.modeBtnIcon}>
                  <Ionicons name="game-controller" size={24} color={mappingReady ? colors.emerald : colors.textMuted} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.modeBtnTitle, !mappingReady && { color: colors.textMuted }]}>
                    {t('manualMapping', undefined) || 'Manual Mapping'}
                  </Text>
                  <Text style={styles.modeBtnSub}>
                    {t('manualMappingSub', undefined) || 'Drive along the boundary with the joystick'}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.textDim} />
              </TouchableOpacity>

              {experimental.enabled && (
                <TouchableOpacity
                  style={[styles.modeBtn, !mappingReady && styles.modeBtnDisabled]}
                  onPress={handleStartAutonomous}
                  disabled={!mappingReady || busy}
                  activeOpacity={0.7}
                >
                  <View style={styles.modeBtnIcon}>
                    <Ionicons name="navigate" size={24} color={mappingReady ? colors.purple : colors.textMuted} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={[styles.modeBtnTitle, !mappingReady && { color: colors.textMuted }]}>
                        {t('autoMapping', undefined) || 'Autonomous Mapping'}
                      </Text>
                      <View style={{ backgroundColor: 'rgba(168,85,247,0.2)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                        <Text style={{ color: '#a855f7', fontSize: 9, fontWeight: '700' }}>
                          {t('beta', undefined) || 'BETA'}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.modeBtnSub}>
                      {t('autoMappingSub', undefined) || 'Mower drives itself around the perimeter'}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={colors.textDim} />
                </TouchableOpacity>
              )}
            </View>
          </ScrollView>

        /* ── Pre-mapping: drive to start point, NOT recording yet ── */
        ) : mappingState === 'preMapping' ? (
          <View style={styles.mappingContent}>
            <View style={[styles.card, { alignItems: 'center', paddingVertical: 20 }]}>
              <Ionicons name="navigate-outline" size={40} color={colors.amber} />
              <Text style={{ color: colors.white, fontSize: 18, fontWeight: '700', marginTop: 12 }}>
                Drive to Start Point
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: 14, textAlign: 'center', marginTop: 8, lineHeight: 20 }}>
                Use the joystick to drive the mower from the charger to where you want to start mapping the boundary.{'\n\n'}
                Press "Begin Recording" when you're at the start point.
              </Text>
            </View>

            {/* Joystick */}
            <View style={styles.joystickArea}>
              <View style={styles.speedInfo}>
                {joystickActive ? (
                  <Text style={styles.speedText}>{(joystickDist * SPEED_LEVELS[speedLevel].linear).toFixed(2)} m/s</Text>
                ) : (
                  <Text style={[styles.speedText, { color: colors.textMuted }]}>Drag to drive</Text>
                )}
              </View>
              <View style={styles.joystickContainer}>
                <GestureDetector gesture={panGesture}>
                  <View style={[styles.joystickBase, { width: JOYSTICK_SIZE, height: JOYSTICK_SIZE }]}>
                    <View style={styles.crossV} />
                    <View style={styles.crossH} />
                    <Text style={[styles.dirLabel, styles.dirTop]}>F</Text>
                    <Text style={[styles.dirLabel, styles.dirBottom]}>B</Text>
                    <Text style={[styles.dirLabel, styles.dirLeft]}>L</Text>
                    <Text style={[styles.dirLabel, styles.dirRight]}>R</Text>
                    <View style={[styles.thumb, joystickActive && styles.thumbActive,
                      { transform: [{ translateX: thumbX }, { translateY: thumbY }] }]} />
                  </View>
                </GestureDetector>
              </View>
              <View style={styles.speedRow}>
                {SPEED_LEVELS.map((lvl, i) => (
                  <TouchableOpacity key={i}
                    style={[styles.speedBtn, speedLevel === i && styles.speedBtnActive]}
                    onPress={() => setSpeedLevel(i)} activeOpacity={0.7}>
                    <Text style={[styles.speedBtnText, speedLevel === i && { color: colors.white }]}>
                      {t(lvl.labelKey, undefined) || lvl.labelKey}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Begin Recording button */}
            <View style={styles.actionRow}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => {
                if (joystickActiveRef.current) stopJoystick();
                setMappingState('idle');
                setMappingMode(null);
              }} activeOpacity={0.7}>
                <Ionicons name="close-circle" size={20} color={colors.red} />
                <Text style={[styles.actionText, { color: colors.red }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.stopMapBtn, { backgroundColor: colors.emerald }]}
                onPress={handleBeginRecording} activeOpacity={0.7}>
                <Ionicons name="radio-button-on" size={20} color={colors.white} />
                <Text style={styles.actionText}>Begin Recording</Text>
              </TouchableOpacity>
            </View>
          </View>

        /* ── Mapping in progress (recording) ── */
        ) : mappingState === 'mapping' ? (
          <View style={styles.mappingContent}>
            {/* Closed cycle banner */}
            {closedCycleSeen && !closedCycleDismissedRef.current && (
              <View style={styles.closedBanner}>
                <Ionicons name="checkmark-circle" size={18} color={colors.green} />
                <Text style={styles.closedBannerText}>Boundary closed! You can stop mapping.</Text>
                <TouchableOpacity
                  onPress={() => { closedCycleDismissedRef.current = true; setClosedCycleSeen(false); }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Ionicons name="close" size={16} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
            )}

            {/* Stats bar */}
            <View style={styles.statsBar}>
              <View style={styles.statItem}>
                <View style={styles.pulseContainer}>
                  <View style={styles.pulseOuter}>
                    <View style={styles.pulseInner} />
                  </View>
                </View>
                <Text style={styles.timerText}>{formatTime(elapsed)}</Text>
              </View>
              <View style={styles.statsChips}>
                <Text style={[styles.sensorChip, { backgroundColor: bleConnected ? 'rgba(0,212,170,0.15)' : 'rgba(239,68,68,0.15)', color: bleConnected ? colors.emerald : colors.red }]}>
                  BLE: {bleConnected ? 'OK' : bleConnecting ? '...' : 'OFF'}
                </Text>
                <Text style={styles.sensorChip}>
                  GPS: {sensors.gps_satellites ?? '?'}
                </Text>
                <Text style={styles.sensorChip}>
                  Loc: {locQuality}%
                </Text>
                <Text style={styles.sensorChip}>
                  Bat: {battery}%
                </Text>
                {ifClosedCycle && (
                  <Text style={[styles.sensorChip, styles.closedChip]}>
                    Closed
                  </Text>
                )}
              </View>
            </View>

            {/* Live trail map */}
            <LiveMapView
              points={trailPoints}
              orientation={mapOrientation}
              closed={ifClosedCycle}
              height={150}
            />

            {/* Mode-specific content */}
            {mappingMode === 'manual' ? (
              /* ── Manual: integrated joystick ── */
              <View style={styles.joystickArea}>
                {/* Speed indicator */}
                <View style={styles.speedInfo}>
                  {joystickActive ? (
                    <Text style={styles.speedText}>{speedMs} m/s</Text>
                  ) : (
                    <Text style={[styles.speedText, { color: colors.textMuted }]}>
                      Drag to drive
                    </Text>
                  )}
                </View>

                {/* Joystick */}
                <View style={styles.joystickContainer}>
                  <GestureDetector gesture={panGesture}>
                    <View style={[styles.joystickBase, { width: JOYSTICK_SIZE, height: JOYSTICK_SIZE }]}>
                      <View style={styles.crossV} />
                      <View style={styles.crossH} />
                      <Text style={[styles.dirLabel, styles.dirTop]}>F</Text>
                      <Text style={[styles.dirLabel, styles.dirBottom]}>B</Text>
                      <Text style={[styles.dirLabel, styles.dirLeft]}>L</Text>
                      <Text style={[styles.dirLabel, styles.dirRight]}>R</Text>
                      <View
                        style={[
                          styles.thumb,
                          joystickActive && styles.thumbActive,
                          { transform: [{ translateX: thumbX }, { translateY: thumbY }] },
                        ]}
                      />
                    </View>
                  </GestureDetector>
                </View>

                {/* Speed level toggle */}
                <View style={styles.speedRow}>
                  {SPEED_LEVELS.map((lvl, i) => (
                    <TouchableOpacity
                      key={i}
                      style={[styles.speedBtn, speedLevel === i && styles.speedBtnActive]}
                      onPress={() => setSpeedLevel(i)}
                      activeOpacity={0.7}
                    >
                      <Ionicons
                        name={i === 0 ? 'speedometer-outline' : i === 1 ? 'speedometer' : 'flash'}
                        size={14}
                        color={speedLevel === i ? colors.white : colors.textMuted}
                      />
                      <Text style={[styles.speedBtnText, speedLevel === i && { color: colors.white }]}>
                        {t(lvl.labelKey, undefined) || lvl.labelKey}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ) : (
              /* ── Autonomous: status only ── */
              <View style={styles.autonomousArea}>
                <Ionicons name="navigate" size={48} color={colors.purple} />
                <Text style={styles.autonomousTitle}>
                  {t('autoMapping', undefined) || 'Autonomous Mapping'}
                </Text>
                <Text style={styles.autonomousSub}>
                  The mower is driving autonomously. It will trace the boundary of your garden. You can stop at any time.
                </Text>
                <ActivityIndicator size="small" color={colors.purple} style={{ marginTop: 12 }} />
              </View>
            )}

            {/* Action buttons */}
            <View style={styles.actionRow}>
              <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel} activeOpacity={0.7}>
                <Ionicons name="close-circle" size={20} color={colors.red} />
                <Text style={[styles.actionText, { color: colors.red }]}>
                  {t('discardMapping', undefined) || 'Discard'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.stopMapBtn, closedCycleSeen && styles.stopMapBtnReady]}
                onPress={handleStop}
                activeOpacity={0.7}
              >
                <Ionicons name="checkmark-circle" size={20} color={colors.white} />
                <Text style={styles.actionText}>
                  {t('stopAndSave', undefined) || 'Stop & Save'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

        /* ── Stopping: saving in progress ── */
        ) : mappingState === 'stopping' ? (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color={colors.purple} />
            <Text style={styles.centerTitle}>
              {t('savingMap', undefined) || 'Saving Map...'}
            </Text>
            <Text style={styles.centerSub}>
              {t('processingBoundary', undefined) || 'Processing boundary data...'}
            </Text>
          </View>

        /* ── Charger positioning: drive to ~50cm, then auto-dock ── */
        ) : mappingState === 'chargerPosition' ? (
          <View style={styles.chargerContent}>
            <View style={styles.chargerCard}>
              <View style={styles.chargerIconContainer}>
                <Ionicons name="battery-charging" size={56} color={colors.emerald} />
              </View>
              <Text style={styles.chargerTitle}>
                {rechargeStatus > 0 ? 'Docked!' : 'Drive to Charger'}
              </Text>
              <Text style={styles.chargerDesc}>
                {rechargeStatus > 0
                  ? 'Mower is on the charger. Saving charger position...'
                  : 'Drive the mower to approximately 50cm in front of the charger, facing it directly.\n\nThen tap "Auto Dock" to let the mower park itself.'}
              </Text>

              {/* Status */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
                <View style={{ width: 12, height: 12, borderRadius: 6,
                  backgroundColor: rechargeStatus > 0 ? colors.emerald : colors.amber }} />
                <Text style={{ color: rechargeStatus > 0 ? colors.emerald : colors.textMuted, fontSize: 14 }}>
                  {rechargeStatus > 0 ? 'Docked — saving position...' : 'Position the mower near the charger'}
                </Text>
              </View>
            </View>

            {/* Joystick — always visible */}
            <View style={styles.joystickArea}>
              <View style={styles.joystickContainer}>
                <GestureDetector gesture={panGesture}>
                  <View style={[styles.joystickBase, { width: JOYSTICK_SIZE * 0.8, height: JOYSTICK_SIZE * 0.8 }]}>
                    <View style={styles.crossV} />
                    <View style={styles.crossH} />
                    <View style={[styles.thumb, joystickActive && styles.thumbActive,
                      { transform: [{ translateX: thumbX * 0.8 }, { translateY: thumbY * 0.8 }] }]} />
                  </View>
                </GestureDetector>
              </View>
              <View style={styles.speedRow}>
                {SPEED_LEVELS.slice(0, 2).map((lvl, i) => (
                  <TouchableOpacity key={i}
                    style={[styles.speedBtn, speedLevel === i && styles.speedBtnActive]}
                    onPress={() => setSpeedLevel(i)} activeOpacity={0.7}>
                    <Text style={[styles.speedBtnText, speedLevel === i && { color: colors.white }]}>
                      {t(lvl.labelKey, undefined) || lvl.labelKey}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Two buttons: Auto Dock + Manual Save */}
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.stopMapBtn, { backgroundColor: colors.emerald, flex: 1 }]}
                onPress={() => {
                  if (joystickActiveRef.current) stopJoystick();
                  sendCommand({ auto_recharge: { cmd_num: cmdNumRef.current++ } }, 'auto_recharge');
                  console.log('[Mapping] auto_recharge sent');
                }}
                activeOpacity={0.7}
              >
                <Ionicons name="navigate" size={20} color={colors.white} />
                <Text style={styles.actionText}>Auto Dock</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.cancelBtn, { flex: 1 }]}
                onPress={handleSaveChargerPos}
                activeOpacity={0.7}
              >
                <Ionicons name="checkmark-circle" size={20} color={colors.emerald} />
                <Text style={[styles.actionText, { color: colors.emerald }]}>Save Position Here</Text>
              </TouchableOpacity>
            </View>
          </View>

        /* ── Done ── */
        ) : mappingState === 'done' ? (
          <View style={styles.centerBox}>
            <Ionicons name="checkmark-circle" size={64} color={colors.green} />
            <Text style={styles.centerTitle}>Map Saved</Text>
            <Text style={styles.centerSub}>
              Your garden map and charger position have been saved successfully.
            </Text>
            <TouchableOpacity
              style={styles.doneBtn}
              onPress={() => navigation.goBack()}
              activeOpacity={0.7}
            >
              <Text style={styles.doneBtnText}>{t('ok', undefined) || 'Done'}</Text>
            </TouchableOpacity>
          </View>

        /* ── Cancelled (brief, auto-navigates back) ── */
        ) : (
          <View style={styles.centerBox}>
            <Ionicons name="close-circle" size={48} color={colors.red} />
            <Text style={styles.centerTitle}>Mapping Cancelled</Text>
          </View>
        )}
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  backBtn: { padding: 4 },
  title: { fontSize: 24, fontWeight: '800', color: colors.white },
  content: { flex: 1, paddingHorizontal: 16 },
  mappingContent: { flex: 1, paddingHorizontal: 16, gap: 8 },
  centerBox: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, paddingHorizontal: 32 },
  centerTitle: { fontSize: 20, fontWeight: '700', color: colors.white, textAlign: 'center' },
  centerSub: { fontSize: 14, color: colors.textMuted, textAlign: 'center' },

  // ── Card styles ──
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    gap: 12,
  },
  cardTitle: { fontSize: 15, fontWeight: '700', color: colors.white, textTransform: 'uppercase', letterSpacing: 1 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkDot: { width: 8, height: 8, borderRadius: 4 },
  checkText: { fontSize: 14, color: colors.textDim },
  warning: {
    fontSize: 12,
    color: colors.amber,
    backgroundColor: 'rgba(245,158,11,0.1)',
    borderRadius: 8,
    padding: 10,
    marginTop: 4,
  },

  // ── Mode selection ──
  modeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  modeBtnDisabled: { opacity: 0.4 },
  modeBtnIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modeBtnTitle: { fontSize: 15, fontWeight: '600', color: colors.white },
  modeBtnSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },

  // ── Closed cycle banner ──
  closedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(34,197,94,0.12)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.25)',
  },
  closedBannerText: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.green },

  // ── Stats bar ──
  statsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.card,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pulseContainer: { justifyContent: 'center', alignItems: 'center' },
  pulseOuter: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: 'rgba(239,68,68,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pulseInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.red,
  },
  timerText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.white,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  statsChips: { flexDirection: 'row', gap: 6 },
  sensorChip: {
    fontSize: 10,
    color: colors.textDim,
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  closedChip: {
    backgroundColor: 'rgba(34,197,94,0.15)',
    color: colors.green,
  },

  // ── Joystick area ──
  joystickArea: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  speedInfo: { height: 20 },
  speedText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.emerald,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  joystickContainer: { alignItems: 'center' },
  joystickBase: {
    borderRadius: JOYSTICK_SIZE / 2,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  crossV: {
    position: 'absolute',
    width: 1,
    height: '100%',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  crossH: {
    position: 'absolute',
    height: 1,
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  dirLabel: {
    position: 'absolute',
    fontSize: 10,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.2)',
  },
  dirTop: { top: 6, alignSelf: 'center' },
  dirBottom: { bottom: 6, alignSelf: 'center' },
  dirLeft: { left: 8, top: '50%', marginTop: -6 },
  dirRight: { right: 8, top: '50%', marginTop: -6 },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  thumbSmall: {
    width: THUMB_SIZE * 0.75,
    height: THUMB_SIZE * 0.75,
    borderRadius: (THUMB_SIZE * 0.75) / 2,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  thumbActive: {
    backgroundColor: colors.emerald,
    borderColor: colors.white,
    shadowColor: colors.emerald,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 8,
  },
  speedRow: {
    flexDirection: 'row',
    gap: 10,
  },
  speedBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  speedBtnActive: {
    backgroundColor: 'rgba(16,185,129,0.2)',
    borderColor: colors.emerald,
  },
  speedBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
  },

  // ── Autonomous area ──
  autonomousArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 24,
  },
  autonomousTitle: { fontSize: 18, fontWeight: '700', color: colors.purple },
  autonomousSub: { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },

  // ── Action buttons ──
  actionRow: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
  },
  cancelBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.2)',
  },
  stopMapBtn: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: colors.purple,
  },
  stopMapBtnReady: {
    backgroundColor: colors.green,
  },
  actionText: { fontSize: 15, fontWeight: '700', color: colors.white },

  // ── Charger positioning ──
  chargerContent: { flex: 1, paddingHorizontal: 16, justifyContent: 'space-between' },
  chargerCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: 'center',
    gap: 12,
    marginTop: 16,
  },
  chargerIconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(0,212,170,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
  },
  chargerTitle: { fontSize: 20, fontWeight: '700', color: colors.white },
  chargerDesc: { fontSize: 14, color: colors.textDim, textAlign: 'center', lineHeight: 20 },
  chargerHint: {
    fontSize: 12,
    color: colors.amber,
    textAlign: 'center',
    marginTop: 4,
    fontStyle: 'italic',
  },
  chargerActions: { paddingBottom: 32, gap: 12 },
  chargerSaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 16,
    borderRadius: 14,
    backgroundColor: colors.emerald,
  },
  chargerSaveBtnText: { fontSize: 16, fontWeight: '700', color: colors.white },

  // ── Done ──
  doneBtn: {
    marginTop: 24,
    paddingHorizontal: 40,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: colors.emerald,
  },
  doneBtnText: { fontSize: 16, fontWeight: '700', color: colors.white },
});
