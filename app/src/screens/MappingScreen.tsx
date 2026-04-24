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
import { useNavigation, useRoute } from '@react-navigation/native';
import {
  GestureDetector,
  Gesture,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useStyles, useTheme, type Colors } from '../theme';
import { LiveMapView } from '../components/LiveMapView';
import { useMowerState } from '../hooks/useMowerState';
import { useActiveMower } from '../hooks/useActiveMower';
import { getSocket } from '../services/socket';
import { ApiClient } from '../services/api';
import { getServerUrl } from '../services/auth';
import { useExperimental } from '../context/ExperimentalContext';
import { useI18n } from '../i18n';
import {
  bleJoystickConnect, bleJoystickDisconnect,
  bleJoystickStart, bleJoystickMove, bleJoystickStop,
  isBleJoystickConnected, onBleJoystickDisconnect, scanForDevices, sendBleCommand, type ScannedDevice,
} from '../services/ble';

// ── Joystick constants (smaller than JoystickScreen) ──
const { width: SCREEN_W } = Dimensions.get('window');
const JOYSTICK_SIZE = Math.min(SCREEN_W * 0.50, 200);
const THUMB_SIZE = 52;
const DEAD_ZONE = 0.15;
const THROTTLE_MS = 80;

// Flutter app sends raw integer values directly (no float scaling).
// BLE bleJoystickMove multiplies by 100, so these values × 100 = mst values.
// Novabot app has no speed selector — joystick position = speed directly.
// These values are tuned for comfortable mapping speed.
const SPEED_LEVELS = [
  { labelKey: 'slow', linear: 0.5, angular: 0.4 },
  { labelKey: 'normal', linear: 1.0, angular: 0.8 },
  { labelKey: 'fast', linear: 2.0, angular: 1.5 },
];

function getHoldType(x: number, y: number): number {
  if (Math.abs(y) >= Math.abs(x)) {
    return y < 0 ? 3 : 4; // up = forward(3), down = backward(4)
  }
  return x < 0 ? 1 : 2; // left(1), right(2)
}

type MappingState = 'idle' | 'calibrating' | 'preMapping' | 'mapping' | 'stopping' | 'chargerPosition' | 'done' | 'cancelled';
type MappingMode = 'autonomous' | 'manual';
// Verified against Flutter v2.4.0 clickStart branches (BuildMapPageLogic L12873):
//   work          → add_scan_map type:null  (creates map0/map1/map2)
//   obstacle      → add_scan_map type:2     (obstacle inside an existing work map)
//   unicom        → add_scan_map type:4     (channel between two work maps, e.g. map0tomap1_0_unicom)
//   charge_unicom → add_scan_map type:8     (channel from a work map to the charger, e.g. map0tocharge_unicom)
// The mower firmware generates the canonical CSV filename based on start/end position at scan time.
type MapBuildType = 'work' | 'obstacle' | 'unicom' | 'charge_unicom';

function buildTypeToScanType(t: MapBuildType): number {
  // Verified against a successful Novabot-app session that produced
  // map0tomap1_0_unicom.csv + map1tomap2_0_unicom.csv on 2026-04-17
  // (mqtt_node_20260416_075337_2699.log, 11:51-12:06):
  //   add_scan_map {mapName:"map1", type:0, ...}   → work area
  //   add_scan_map {mapName:"map1", type:2, ...}   → map-to-map unicom
  // The earlier Flutter decompilation assigned type:4 to unicom because I
  // matched the wrong BuildMapType enum (a4b901 vs a4b921). The firmware
  // actually interprets type:4 as MAPPING_EDIT_MODE, which is why our
  // previous unicom attempts merged into the work polygon instead of
  // writing a separate CSV.
  switch (t) {
    case 'work': return 0;
    case 'obstacle': return 1;      // VERIFIED 2026-04-19 via live Novabot-app
                                    // capture on LFIN1231000211 mqtt_node log:
                                    //   add_scan_map {mapName:"map", type:1}
                                    //   → generate_map_file_name = map0_0_obstacle.csv
    case 'unicom': return 2;        // verified: map-to-map channel
    case 'charge_unicom': return 8; // NOT verified — Novabot generates charge
                                    // unicom implicitly via save_recharge_pos
  }
}

// NOTE: buildTypeToSaveMapType / buildTypeToStopScanValue were removed —
// the save/stop flow now follows the verified Novabot two-save protocol
// inline in handleStop (sub + total for work, single total for unicom).

export default function MappingScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { devices } = useMowerState();
  const experimental = useExperimental();
  const { t } = useI18n();
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();

  // Maaier mqtt_node maakt korte verbindingen (connect → rapport → disconnect).
  // Gebruik lastUpdate timestamp i.p.v. online flag — als recent bericht binnen 60s, beschouw als online.
  const { activeMower: mower } = useActiveMower();
  const mowerRecentlyActive = mower ? (Date.now() - (mower.lastUpdate ?? 0)) < 60_000 : false;
  const mowerOnline = mower?.online || mowerRecentlyActive;
  const sn = mower?.sn ?? '';
  const sensors = mower?.sensors ?? {};

  // ── Route params (from MapScreen Edit button) ──
  const route = useRoute();
  const initialBuildType = (route.params as any)?.buildType as MapBuildType | undefined;

  // ── State machine ──
  const [mappingState, setMappingState] = useState<MappingState>('idle');

  // Reset state when screen regains focus (e.g. after goBack + re-navigate)
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      if (mappingState === 'cancelled' || mappingState === 'done') {
        setMappingState('idle');
        setMappingMode(null);
        setBusy(false);
        setElapsed(0);
      }
    });
    return unsubscribe;
  }, [navigation, mappingState]);
  const [mapBuildType, setMapBuildType] = useState<MapBuildType>(initialBuildType ?? 'work');
  const [mappingMode, setMappingMode] = useState<MappingMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [activeMapName, setActiveMapName] = useState('map0');
  const [chargerAction, setChargerAction] = useState<'autoDock' | 'savePosition' | null>(null);
  const chargerFailureHandledRef = useRef(false);
  const autoDockRequestedRef = useRef(false);
  const prevAutoDockFailedRef = useRef(false);
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

  // ── Existing maps (shown greyed-out during mapping) ──
  const [existingMaps, setExistingMaps] = useState<Array<{ mapId: string; mapType: string; mapName?: string; fileName?: string; points: Array<{x: number; y: number}> }>>([]);

  // ── Track last saved map to inform the post-save "create channel" CTA ──
  const [lastSaved, setLastSaved] = useState<{ mapName: string; buildType: MapBuildType } | null>(null);
  // When the user taps "Create Channel" we capture which map the scan must
  // start in, so the follow-up add_scan_map gets the right mapName even if
  // `lastSaved` / `existingMaps` are cleared or stale. Use a ref to avoid
  // re-renders and keep the value available inside handleStart closures.
  const pendingChannelFromRef = useRef<string | null>(null);
  // Track which work maps the mower has visited during the current unicom
  // scan. The firmware fails the save with "pass_areas < 2" unless the
  // trajectory actually touches two separate work polygons, so we show a
  // live counter and only signal "ready" once the set hits 2.
  const unicomVisitedMapsRef = useRef<Set<string>>(new Set());

  // Missing unicom channels that the user must draw before leaving the
  // mapping flow. A mower cannot traverse between work maps without the
  // explicit mapXtomapY_N_unicom path, so OpenNova enforces creation —
  // Novabot doesn't block it, it just offers the option via a separate
  // ChooseMapType screen; we decided a mandatory flow is safer.
  //
  // We derive this in two ways and prefer whichever produces a missing pair:
  //   1. From `lastSaved`: if the user just saved mapN (N>0) as a work map,
  //      we immediately know a channel between map(N-1) and mapN is required.
  //      This avoids waiting for the mower ZIP upload + DB round-trip before
  //      the blocker appears.
  //   2. From `existingMaps`: scan the live DB for any consecutive work-map
  //      pair without a unicom between them (catches historic gaps).
  const missingMapChannels = (() => {
    const missing: Array<{ from: string; to: string }> = [];
    // Novabot's channel-drawing convention is to start in the NEWER map
    // (the one the user just added) and drive back into the older one. The
    // mower firmware uses the position at add_scan_map time as the "from"
    // side. So we list `from` = newer map, `to` = older map — the UI tells
    // the user "drive from mapN to mapN-1".

    // 1. Immediate derivation from the just-saved map name.
    if (lastSaved?.buildType === 'work') {
      const m = lastSaved.mapName.match(/^map(\d+)/);
      if (m) {
        const idx = parseInt(m[1], 10);
        if (idx > 0) {
          const from = `map${idx}`;       // new map (start here)
          const to = `map${idx - 1}`;     // older map (end here)
          const hasIt = existingMaps.some(row =>
            row.mapType === 'unicom' &&
            (row.mapName?.includes(`${from}to${to}`) ||
             row.fileName?.includes(`${from}to${to}`) ||
             row.mapName?.includes(`${to}to${from}`) ||
             row.fileName?.includes(`${to}to${from}`))
          );
          if (!hasIt) missing.push({ from, to });
        }
      }
    }
    // 2. Scan DB for older gaps (any pair of adjacent work maps).
    const hasUnicom = (a: string, b: string) => existingMaps.some(row =>
      row.mapType === 'unicom' &&
      (row.mapName?.includes(`${a}to${b}`) || row.fileName?.includes(`${a}to${b}`))
    );
    const canonicalNames = existingMaps
      .filter(m => m.mapType === 'work')
      .map(m => (m.fileName?.match(/^(map\d+)/)?.[1]) ?? (m.mapName?.match(/^(map\d+)/)?.[1]))
      .filter((v): v is string => !!v)
      .sort();
    for (let i = canonicalNames.length - 1; i > 0; i--) {
      const from = canonicalNames[i];         // newer
      const to = canonicalNames[i - 1];       // older
      if (!hasUnicom(from, to) && !hasUnicom(to, from)
        && !missing.some(p => p.from === from && p.to === to)) {
        missing.push({ from, to });
      }
    }
    return missing;
  })();
  const mustCreateChannel = missingMapChannels.length > 0
    && mappingState === 'done'
    && lastSaved?.buildType !== 'unicom';

  // ── Sensor readiness ──
  const gpsValid = sensors.gps_valid === '1'
    || sensors.gps_satellites !== undefined
    || sensors.gps_state === 'ENABLE'
    || (sensors.latitude !== undefined && parseFloat(sensors.latitude) !== 0);
  const locQuality = parseInt(sensors.loc_quality ?? '0', 10);
  const locState = sensors.localization_state ?? '';
  const locReady = locQuality >= 80 && locState !== 'NOT_INITIALIZED';
  const mappingReady = gpsValid && locReady;
  const battery = parseInt(sensors.battery_power ?? sensors.battery_capacity ?? '0', 10) || 0;

  // ── Load existing maps (shown as grey overlay during mapping + used to enable/disable mode options) ──
  const refreshExistingMaps = useCallback(async () => {
    if (!sn) return;
    try {
      const url = await getServerUrl();
      if (!url) return;
      const api = new ApiClient(url);
      const res = await api.fetchMaps(sn);
      const loaded = (res.maps ?? [])
        .filter((m: any) => m.mapArea?.length >= 3)
        .map((m: any) => ({
          mapId: m.mapId,
          mapType: m.mapType ?? 'work',
          mapName: m.mapName,
          fileName: m.fileName,
          points: m.mapArea,
        }));
      setExistingMaps(loaded);
    } catch { /* ignore */ }
  }, [sn]);

  useEffect(() => { refreshExistingMaps(); }, [refreshExistingMaps]);

  // Refresh when the screen regains focus so the mode selector reflects freshly created maps.
  useEffect(() => {
    const unsub = navigation.addListener('focus', () => { refreshExistingMaps(); });
    return unsub;
  }, [navigation, refreshExistingMaps]);

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

  // ── Mower position from sensor data ──
  const mapPosX = sensors.map_position_x;
  const mapPosY = sensors.map_position_y;
  const mapOrientation = parseFloat(sensors.map_position_orientation ?? '0') || 0;
  const mowerLocal = mapPosX != null && mapPosY != null
    ? { x: parseFloat(mapPosX) || 0, y: parseFloat(mapPosY) || 0 }
    : null;

  // ── Trail: server-side collection polled every 1s ──
  // Server collects every MQTT map_position update (never misses a point).
  // App polls the complete trail — no gaps from missed socket events.
  // Fallback: if server trail is empty, collect client-side from sensor updates.
  const trailPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const serverTrailActiveRef = useRef(false);
  useEffect(() => {
    if (mappingState !== 'mapping') {
      if (trailPollRef.current) { clearInterval(trailPollRef.current); trailPollRef.current = null; }
      if (mappingState === 'idle' || mappingState === 'preMapping') {
        setTrailPoints([]);
        lastTrailRef.current = null;
        serverTrailActiveRef.current = false;
      }
      return;
    }
    const fetchTrail = async () => {
      try {
        const url = await getServerUrl();
        if (!url || !sn) return;
        const res = await fetch(`${url}/api/dashboard/trail/${encodeURIComponent(sn)}`);
        const json = await res.json();
        const trail = json.trail as Array<{x: number; y: number}> | undefined;
        if (trail && trail.length > 0) {
          serverTrailActiveRef.current = true;
          setTrailPoints(trail);
        }
      } catch { /* ignore */ }
    };
    fetchTrail();
    trailPollRef.current = setInterval(fetchTrail, 1000);
    return () => { if (trailPollRef.current) clearInterval(trailPollRef.current); };
  }, [mappingState, sn]);

  // Fallback: client-side trail collection if server trail is empty
  useEffect(() => {
    if (mappingState !== 'mapping') return;
    if (serverTrailActiveRef.current) return;
    if (mapPosX === undefined || mapPosY === undefined) return;
    const x = parseFloat(mapPosX);
    const y = parseFloat(mapPosY);
    if (isNaN(x) || isNaN(y)) return;
    const last = lastTrailRef.current;
    if (last && Math.abs(last.x - x) < 0.01 && Math.abs(last.y - y) < 0.01) return;
    lastTrailRef.current = { x, y };
    setTrailPoints(prev => [...prev, { x, y }]);
  }, [mappingState, mapPosX, mapPosY]);

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
  // Send mapping commands via BLE (exact Novabot app behavior — all mapping
  // commands go via BLE writeData with framing, NOT via MQTT)
  const sendCommand = useCallback(async (command: Record<string, unknown>, label: string) => {
    setBusy(true);
    console.log(`[Mapping] Sending via BLE: ${label}`);
    await sendBleCommand(command);
    console.log(`[Mapping] Sent: ${label}`);
    setTimeout(() => setBusy(false), 1500);
  }, []);

  const waitForRespond = useCallback((command: string, timeoutMs: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const socket = getSocket();
      if (!socket || !sn) {
        resolve(false);
        return;
      }

      const cleanup = () => {
        clearTimeout(timer);
        socket.off('command:respond', handler);
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      const handler = (e: { sn: string; command: string }) => {
        if (e.sn === sn && e.command === command) {
          cleanup();
          resolve(true);
        }
      };

      socket.on('command:respond', handler);
    });
  }, [sn]);

  const getNextWorkMapName = useCallback((maps: Array<{ mapName?: string | null; mapType?: string | null }>): string => {
    const usedNames = new Set<string>();

    for (const map of maps) {
      if (map.mapType !== 'work') continue;
      const rawName = String(map.mapName ?? '');
      const match = rawName.match(/^map(\d+)(?:$|_work$)/i);
      if (match) usedNames.add(`map${match[1]}`);
    }

    let nextIndex = 0;
    while (usedNames.has(`map${nextIndex}`)) nextIndex += 1;
    return `map${nextIndex}`;
  }, []);

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

  // ── BLE disconnect handler: update UI + auto-reconnect ──
  useEffect(() => {
    onBleJoystickDisconnect(() => {
      setBleConnected(false);
      // Stop joystick if active
      if (joystickActiveRef.current) {
        joystickActiveRef.current = false;
        setJoystickActive(false);
        if (bleIntervalRef.current) { clearInterval(bleIntervalRef.current); bleIntervalRef.current = null; }
      }
      // Auto-reconnect after 2s if still mapping
      if (mappingState === 'mapping') {
        setTimeout(() => connectBleJoystick(), 2000);
      }
    });
  }, [mappingState, connectBleJoystick]);

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
    // Mower: y_v = forward/backward, x_w = turn left/right
    const holdType = getHoldType(dx, dy) || 3;
    currentHoldTypeRef.current = holdType;
    currentMstRef.current = {
      x_w: Math.round(dx * lvl.angular * 100) / 100,
      y_v: Math.round(-dy * lvl.linear * 100) / 100,
      z_g: 0,
    };
  }, []);

  const stopJoystick = useCallback(() => {
    if (!joystickActiveRef.current) return; // already stopped, skip duplicate stop_move
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

    // Flutter protocol: start_move ONCE on touch, then mst repeated on timer
    if (!bleIntervalRef.current) {
      // Send start_move once to enter manual mode
      bleJoystickStart(holdType).then(() => bleJoystickMove(currentMstRef.current));

      // Then only send mst on interval (official app ~2s, we use 200ms for smoother control)
      bleIntervalRef.current = setInterval(async () => {
        if (!joystickActiveRef.current) return;
        await bleJoystickMove(currentMstRef.current);
      }, 200);
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

            // Clean up any stale mapping state from a previous session
            sendCommand({ quit_mapping_mode: { value: 1, cmd_num: cmdNumRef.current++ } }, 'quit_mapping_mode (cleanup)');
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
            // Flutter onAotuMappingClick (logic.dart L14653) hardcodes `type: 2` to enter
            // autonomous mode. Without this field the mower keeps the previous mode
            // setting — L14689 shows `mov x16, #2` immediately before StoreField.
            sendCommand({ start_assistant_build_map: { type: 2, cmd_num: cmdNumRef.current++ } }, 'start_assistant_build_map');
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
    let existingWorkMapCount = 0;
    let nextWorkMapName = 'map0';
    try {
      const url = await getServerUrl();
      if (url && sn) {
        await fetch(`${url}/api/dashboard/trail/${encodeURIComponent(sn)}`, { method: 'DELETE' });
        console.log('[Mapping] Server trail cleared');
        // Check how many work maps already exist — determines start_scan_map vs add_scan_map
        const mapsRes = await fetch(`${url}/api/dashboard/maps/${encodeURIComponent(sn)}`).then(r => r.json()).catch(() => ({ maps: [] }));
        const existingMaps = mapsRes.maps ?? [];
        existingWorkMapCount = existingMaps.filter((m: any) => m.mapType === 'work').length;
        nextWorkMapName = getNextWorkMapName(existingMaps);
      }
    } catch {}

    // EXACT Novabot app flow — verified against live BLE mqtt log 2026-04-17 21:45:
    // - First map EVER:  start_scan_map { model: "manual", mapName: "map0", type: 0, cmd_num }
    // - Additional:      add_scan_map   { model: "manual", mapName: <name>, type: <0|2|4|8>, cmd_num }
    // The `type` value selects what kind of area the mower is scanning:
    //   0 = work map, 2 = obstacle, 4 = map-to-map unicom, 8 = charge unicom.
    // Non-work modes require at least one existing work map.
    if (existingWorkMapCount === 0 && mapBuildType !== 'work') {
      Alert.alert(
        'First map must be a work area',
        'Create a work map first before drawing obstacles or channels.',
      );
      return;
    }

    // `mapName` tells the mower the START map for this scan. Rules:
    //   work:   the next free slot (map0/map1/map2)
    //   unicom: the newly added work map — the one the user is physically
    //           standing in when the scan begins. `pendingChannelFromRef`
    //           is set by the blocker's "Create Channel" button so we don't
    //           rely on possibly-stale existingMaps.
    //   other:  fall back to the latest work map.
    const latestWorkMap = (() => {
      const names = existingMaps
        .filter(m => m.mapType === 'work')
        .map(m => (m.fileName?.match(/^(map\d+)/)?.[1]) ?? (m.mapName?.match(/^(map\d+)/)?.[1]))
        .filter((v): v is string => !!v)
        .sort();
      return names[names.length - 1] ?? 'map0';
    })();
    const mapName = mapBuildType === 'work'
      ? nextWorkMapName
      : (pendingChannelFromRef.current ?? latestWorkMap);
    setActiveMapName(mapName);

    // Novabot app sends mapName:"map" (literal) for obstacle scans, NOT the
    // parent work-map name. Verified 2026-04-19 via live Novabot-app capture
    // on LFIN1231000211. Firmware derives the parent from the active context
    // and auto-indexes the obstacle CSV (e.g. map0_0_obstacle.csv).
    const wireMapName = mapBuildType === 'obstacle' ? 'map' : mapName;

    const scanType = buildTypeToScanType(mapBuildType);
    if (existingWorkMapCount === 0) {
      sendCommand({ start_scan_map: { model: 'manual', mapName: 'map0', type: 0, cmd_num: cmdNumRef.current++ } }, 'start_scan_map');
    } else {
      sendCommand({ add_scan_map: { model: 'manual', mapName: wireMapName, type: scanType, cmd_num: cmdNumRef.current++ } }, 'add_scan_map');
    }
    console.log(`[Mapping] Recording started (${existingWorkMapCount === 0 ? 'start' : 'add'}_scan_map, map: ${mapName}, type: ${scanType}, buildType: ${mapBuildType}, ${existingWorkMapCount} existing)`);

    setTrailPoints([]);
    lastTrailRef.current = null;
    setClosedCycleSeen(false);
    closedCycleDismissedRef.current = false;
    // Reset the unicom-visited set — this live counter is only meaningful for
    // the current scan, not accumulated across sessions.
    unicomVisitedMapsRef.current = new Set();
    // Calibrating screen: the firmware ignores joystick input for ~8s after
    // entering mapping mode (motors + sensors initialise). Show a clear
    // "please wait" state so the user doesn't yank the joystick into
    // a no-op gulf and assume the build is broken.
    setMappingState('calibrating');
    setTimeout(() => setMappingState('mapping'), 8000);
  };

  // ── Stop & Save (exact flow from official Novabot app) ──
  // Flutter: stop_scan_map → delay → save_map → uploadMapToServer
  //          → user positions mower near charger → auto_recharge
  //          → wait for MQTT dock state → save_recharge_pos → DONE
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

            // Exact sequence verified against a successful Novabot session that
            // produced map0tomap1_0_unicom.csv (mqtt_node_20260416_075337_2699.log,
            // 11:57:28 work save and 11:58:52 unicom save):
            //
            //   Work map (map1, map2):
            //     stop_scan_map {value:false}
            //     save_map      {type:0}   ← sub
            //     save_map      {type:1}   ← total, 2-3 s later
            //     get_map_outline
            //
            //   Unicom scan (after work map already saved):
            //     stop_scan_map {value:true}
            //     save_map      {type:1}   ← directly, NO type:0 step
            //     get_map_outline
            const isUnicom = mapBuildType === 'unicom' || mapBuildType === 'charge_unicom';

            setMappingState('stopping');
            sendCommand(
              { stop_scan_map: { value: isUnicom, cmd_num: cmdNumRef.current++ } },
              'stop_scan_map',
            );
            console.log(`[Mapping] Step 1: stop_scan_map {value:${isUnicom}} sent`);
            const stopOk = await waitForRespond('stop_scan_map_respond', 20000);
            console.log(`[Mapping] Step 1: stop_scan_map_respond ${stopOk ? 'OK' : 'TIMEOUT'}`);

            await new Promise(r => setTimeout(r, 1000));

            if (isUnicom) {
              // Unicom gets a single save_map {type:1}
              sendCommand(
                { save_map: { mapName: activeMapName, type: 1, cmd_num: cmdNumRef.current++ } },
                'save_map (unicom total)',
              );
              const saveOk = await waitForRespond('save_map_respond', 12000);
              console.log(`[Mapping] Step 2: unicom save_map_respond ${saveOk ? 'OK' : 'TIMEOUT'}`);
              // Channel scan complete — next scan is unrelated.
              pendingChannelFromRef.current = null;
            } else {
              // Work / obstacle: sub save FIRST, then total save.
              // Obstacle uses mapName:"map" (literal) — verified 2026-04-19 via
              // live Novabot-app capture. Work uses the real map name (map0/map1/...).
              const saveMapName = mapBuildType === 'obstacle' ? 'map' : activeMapName;
              sendCommand(
                { save_map: { mapName: saveMapName, type: 0, cmd_num: cmdNumRef.current++ } },
                'save_map (sub)',
              );
              const subOk = await waitForRespond('save_map_respond', 12000);
              console.log(`[Mapping] Step 2a: sub save_map_respond ${subOk ? 'OK' : 'TIMEOUT'}`);
              await new Promise(r => setTimeout(r, 3000));
              sendCommand(
                { save_map: { mapName: saveMapName, type: 1, cmd_num: cmdNumRef.current++ } },
                'save_map (total)',
              );
              const totalOk = await waitForRespond('save_map_respond', 12000);
              console.log(`[Mapping] Step 2b: total save_map_respond ${totalOk ? 'OK' : 'TIMEOUT'}`);
            }

            sendCommand({ get_map_outline: { map_name: 'all', cmd_num: cmdNumRef.current++ } }, 'get_map_outline');
            console.log('[Mapping] Step 3: get_map_outline sent to trigger mower ZIP upload');

            // Record what we just saved so the done-screen can suggest follow-up channels.
            setLastSaved({ mapName: activeMapName, buildType: mapBuildType });

            // Optimistically add the just-scanned map to existingMaps so the
            // follow-up unicom screen can render both shapes immediately. The
            // real row takes ~5–15 s to reach the server DB (mower ZIP upload
            // → parse).
            if (trailPoints.length >= 3) {
              const optimisticMap = {
                mapId: `optimistic-${activeMapName}-${Date.now()}`,
                mapType: mapBuildType === 'obstacle' ? 'obstacle'
                  : isUnicom ? 'unicom'
                  : 'work',
                mapName: activeMapName,
                fileName: `${activeMapName}_${mapBuildType === 'obstacle' ? '0_obstacle' : isUnicom ? 'unicom' : 'work'}.csv`,
                points: [...trailPoints],
              };
              setExistingMaps(prev => {
                const withoutDup = prev.filter(m =>
                  !(m.mapName === optimisticMap.mapName && m.mapType === optimisticMap.mapType),
                );
                return [...withoutDup, optimisticMap];
              });
            }

            // Delay the refresh so the mower has time to upload its ZIP + the
            // server can parse it. Firing refreshExistingMaps immediately here
            // replaced the optimistic stub with server data that hadn't caught
            // up yet, causing the new map1 to disappear from the next screen.
            // 8 s is comfortably longer than the observed ~5 s upload latency.
            setTimeout(() => { void refreshExistingMaps(); }, 8000);

            // Step 3: charger positioning — only for the FIRST work map (map0).
            // Additional work maps (map1/map2) share the charging pose saved with map0.
            // Obstacle/unicom/charge_unicom scans never trigger dock positioning.
            if (mapBuildType === 'work' && activeMapName === 'map0') {
              setChargerAction(null);
              setMappingState('chargerPosition');
              console.log('[Mapping] Step 3: drive to charger → user controls via joystick');
            } else {
              console.log(`[Mapping] Step 3: skipped charger positioning (buildType=${mapBuildType}, activeMap=${activeMapName})`);
              setMappingState('done');
            }
          },
        },
      ],
    );
  };

  // ── Monitor MQTT dock state and mirror the Flutter charger flow ──
  // The official app does not treat "auto_recharge clicked" as success.
  // It watches live mower status and only saves charger position after the
  // mower is actually docked. It also surfaces a retry state on auto-dock failure.
  const taskMode = parseInt(sensors.task_mode ?? '0', 10);
  const workStatus = parseInt(sensors.work_status ?? '0', 10);
  const rechargeStatus = parseInt(sensors.recharge_status ?? '0', 10);
  const errorStatus = parseInt(String(sensors.error_status ?? '0').match(/\d+/)?.[0] ?? '0', 10);
  const batteryState = String(sensors.battery_state ?? '').toUpperCase();
  const rawMowerMsg = String(sensors.msg ?? '');
  const mowerMsg = rawMowerMsg.toUpperCase();
  const autoDockInProgress = rechargeStatus === 1
    || mowerMsg.includes('RECHARGE: GOING')
    || mowerMsg.includes('WORK:GO_PILE')
    || mowerMsg.includes('WORK:BACK_CHARGER')
    || mowerMsg.includes('WORK:DOCKING');
  const dockedOnCharger = rechargeStatus === 9
    || batteryState === 'CHARGING'
    || mowerMsg.includes('RECHARGE: FINISHED')
    || mowerMsg.includes('WORK:CHARGING');
  const autoDockFailed = rechargeStatus === 2
    || errorStatus === 0x2e
    || mowerMsg.includes('RECHARGE: FAILED')
    || mowerMsg.includes('RETURN TO CHARGING STATION FAILED');
  const savingChargerPosRef = useRef(false);

  // Reset charger-flow tracking when entering the dock step.
  useEffect(() => {
    if (mappingState === 'chargerPosition') {
      savingChargerPosRef.current = false;
      chargerFailureHandledRef.current = false;
      autoDockRequestedRef.current = false;
      prevAutoDockFailedRef.current = false;
      setChargerAction(null);
    }
  }, [mappingState]);

  useEffect(() => {
    const failureTransitioned = autoDockFailed && !prevAutoDockFailedRef.current;
    prevAutoDockFailedRef.current = autoDockFailed;

    if (
      mappingState !== 'chargerPosition'
      || savingChargerPosRef.current
      || !autoDockRequestedRef.current
      || !failureTransitioned
      || chargerFailureHandledRef.current
    ) {
      return;
    }

    chargerFailureHandledRef.current = true;
    autoDockRequestedRef.current = false;
    setChargerAction(null);
    console.log(
      `[Mapping] Auto dock failed via MQTT ` +
      `(task_mode=${taskMode}, work_status=${workStatus}, recharge_status=${rechargeStatus}, ` +
      `error_status=${errorStatus}, battery_state=${batteryState}, msg="${rawMowerMsg}")`,
    );
    Alert.alert(
      'Auto Dock Failed',
      'Returning to the charging station failed. Retry Auto Dock or save the charger position manually.',
    );
  }, [
    autoDockFailed,
    batteryState,
    errorStatus,
    mappingState,
    rawMowerMsg,
    rechargeStatus,
    taskMode,
    workStatus,
  ]);

  useEffect(() => {
    if (mappingState !== 'chargerPosition' || !dockedOnCharger || savingChargerPosRef.current) {
      return;
    }

    savingChargerPosRef.current = true;
    chargerFailureHandledRef.current = false;
    autoDockRequestedRef.current = false;
    setChargerAction('savePosition');
    console.log(
      `[Mapping] Dock detected via MQTT ` +
      `(task_mode=${taskMode}, work_status=${workStatus}, recharge_status=${rechargeStatus}, ` +
      `battery_state=${batteryState}, msg="${rawMowerMsg}") → save_recharge_pos`,
    );
    // Flutter _saveChargePosition (logic.dart L7236) sends ONLY { mapName: "map0", cmd_num }.
// The literal "map0" is loaded from pp+0x16430 — it's never dynamic. The extra
// `map0: ''` field we used to send was NOT in the Flutter payload and the
// mower firmware silently rejected the whole command, which is why
// map0tocharge_unicom never appeared on disk.
sendCommand({ save_recharge_pos: { mapName: 'map0', cmd_num: cmdNumRef.current++ } }, 'save_recharge_pos');

    (async () => {
      // Flutter _saveChargePosition passes 0x14=20s to _writeDataToDevice (logic.dart 0x8ffa2c).
      const responded = await waitForRespond('save_recharge_pos_respond', 20000);
      console.log(`[Mapping] save_recharge_pos_respond ${responded ? 'OK' : 'TIMEOUT'}`);

      // Re-trigger save_map AFTER the charger pose is committed. Flutter's
      // _getMsgFromDevice handler for save_recharge_pos_respond (logic.dart
      // L10688) schedules `Future.delayed(Duration(milliseconds: 500))` at
      // addr 0x906744 (pp+0x4d90 = Duration(500000 µs)) and then calls
      // _writeSaveMap() at 0x906764. Without this second save_map the mower
      // never regenerates its ZIP to include map0tocharge_unicom.csv, which
      // is why charge unicom never appeared on disk earlier.
      await new Promise(r => setTimeout(r, 500));
      // type:1 = "total map" — mower generates map.pgm/map.png/map.yaml (the
      // occupancy grid the C++ robot_decision tries to load at start_navigation).
      // The first save_map after stop_scan_map is type:0 ("sub map") and only
      // writes csv_file/x3_csv_file. Confirmed via mower log line:
      //   "Save map request: 1 map0 — Saving total map!!!"
      // Sending type:0 here (what we did before) never produced map.yaml →
      // Error 107 "Load map failed" at start_navigation.
      sendCommand(
        { save_map: { mapName: 'map0', type: 1, cmd_num: cmdNumRef.current++ } },
        'save_map (post-recharge, total)',
      );
      const savedAgain = await waitForRespond('save_map_respond', 12000);
      console.log(`[Mapping] post-recharge save_map_respond ${savedAgain ? 'OK' : 'TIMEOUT'}`);

      // Ask the mower to push its refreshed ZIP (same trigger the Flutter
      // app uses via uploadMapToServce → get_map_outline request).
      sendCommand(
        { get_map_outline: { map_name: 'all', cmd_num: cmdNumRef.current++ } },
        'get_map_outline (post-recharge)',
      );

      setChargerAction(null);
      setMappingState('done');
    })();
  }, [
    activeMapName,
    batteryState,
    dockedOnCharger,
    mappingState,
    rawMowerMsg,
    rechargeStatus,
    sendCommand,
    taskMode,
    waitForRespond,
    workStatus,
  ]);

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
            sendCommand({ stop_erase_map: { cmd_num: cmdNumRef.current++ } }, 'stop_erase_map (cancel)');
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
    autoDockRequestedRef.current = false;
    savingChargerPosRef.current = true;
    setChargerAction('savePosition');
    // Flutter _saveChargePosition (logic.dart L7236) sends ONLY { mapName: "map0", cmd_num }.
// The literal "map0" is loaded from pp+0x16430 — it's never dynamic. The extra
// `map0: ''` field we used to send was NOT in the Flutter payload and the
// mower firmware silently rejected the whole command, which is why
// map0tocharge_unicom never appeared on disk.
sendCommand({ save_recharge_pos: { mapName: 'map0', cmd_num: cmdNumRef.current++ } }, 'save_recharge_pos');
    const responded = await waitForRespond('save_recharge_pos_respond', 20000);
    console.log(`[Mapping] Manual save_recharge_pos_respond: ${responded ? 'OK' : 'TIMEOUT'}`);

    // Mirror Flutter's post-response follow-up (see auto-save path above):
    // wait 500 ms, send save_map again, request outline to trigger the
    // updated ZIP upload that includes map0tocharge_unicom.
    await new Promise(r => setTimeout(r, 500));
    // type:1 = "total map" — see auto-save branch above for rationale.
    sendCommand(
      { save_map: { mapName: 'map0', type: 1, cmd_num: cmdNumRef.current++ } },
      'save_map (post-recharge manual, total)',
    );
    const savedAgain = await waitForRespond('save_map_respond', 12000);
    console.log(`[Mapping] Manual post-recharge save_map_respond: ${savedAgain ? 'OK' : 'TIMEOUT'}`);
    sendCommand(
      { get_map_outline: { map_name: 'all', cmd_num: cmdNumRef.current++ } },
      'get_map_outline (post-recharge manual)',
    );

    setChargerAction(null);
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
        {/* Header — back-button is disabled while a mandatory unicom is pending */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => {
              if (mustCreateChannel) {
                Alert.alert(
                  'Channel required',
                  `You have multiple work maps. Create the channel from ${missingMapChannels[0].from} to ${missingMapChannels[0].to} before leaving.`,
                );
                return;
              }
              navigation.goBack();
            }}
            style={[styles.backBtn, mustCreateChannel && { opacity: 0.4 }]}
          >
            <Ionicons name="arrow-back" size={24} color={colors.white} />
          </TouchableOpacity>
          <Text style={styles.title}>{t('createMap', undefined) || 'Create Map'}</Text>
        </View>

        {/* ── Mower offline ── */}
        {!mowerOnline ? (
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
                <View style={[styles.checkDot, { backgroundColor: mowerOnline ? colors.green : colors.red }]} />
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

              {/* Map type selector.
                  Obstacle and unicom require at least one existing work map.
                  Charger channel is NOT exposed — the mower creates it implicitly
                  from the map0 → charger positioning flow after the first work map save. */}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                {(
                  [
                    { key: 'work' as MapBuildType, label: 'Work Area', icon: 'map', color: colors.emerald, needsWork: false },
                    { key: 'obstacle' as MapBuildType, label: 'Obstacle', icon: 'warning', color: '#f59e0b', needsWork: true },
                    { key: 'unicom' as MapBuildType, label: 'Map Channel', icon: 'swap-horizontal', color: '#3b82f6', needsWork: true },
                  ] as const
                ).map(opt => {
                  const disabled = opt.needsWork && existingMaps.filter(m => m.mapType === 'work').length === 0;
                  const active = mapBuildType === opt.key;
                  return (
                    <TouchableOpacity
                      key={opt.key}
                      style={[
                        styles.modeBtn,
                        {
                          flex: 1,
                          flexDirection: 'column',
                          paddingVertical: 12,
                          paddingHorizontal: 6,
                          gap: 6,
                          opacity: disabled ? 0.4 : 1,
                        },
                        active && { borderColor: opt.color, borderWidth: 1.5 },
                      ]}
                      onPress={() => !disabled && setMapBuildType(opt.key)}
                      disabled={disabled}
                      activeOpacity={0.7}
                    >
                      <Ionicons name={opt.icon as any} size={22} color={active ? opt.color : colors.textDim} />
                      <Text
                        style={[
                          styles.modeBtnTitle,
                          { fontSize: 12, textAlign: 'center', lineHeight: 14 },
                          !active && { color: colors.textDim },
                        ]}
                        numberOfLines={2}
                      >
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {mapBuildType === 'unicom' && (
                <Text style={[styles.modeBtnSub, { marginBottom: 12, color: colors.textMuted }]}>
                  Drive from one work map to another. The mower records the path and names it mapXtomapY_N_unicom.
                </Text>
              )}

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

        /* ── Calibrating: mower initialising motors + sensors (~8s) ── */
        ) : mappingState === 'calibrating' ? (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16, paddingHorizontal: 32 }}>
            <ActivityIndicator size="large" color={colors.emerald} />
            <Text style={{ color: colors.white, fontSize: 20, fontWeight: '700' }}>
              {t('calibratingMotors', undefined) || 'Calibrating Motors'}
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 }}>
              {t('calibratingHint', undefined)
                || 'The mower is initialising its motors and sensors.\nThis takes about 8 seconds.'}
            </Text>
            <View style={styles.statsChips}>
              <Text style={[
                styles.sensorChip,
                {
                  backgroundColor: bleConnected ? 'rgba(0,212,170,0.15)' : 'rgba(239,68,68,0.15)',
                  color: bleConnected ? colors.emerald : colors.red,
                },
              ]}>
                BLE: {bleConnected ? 'OK' : 'OFF'}
              </Text>
              <Text style={styles.sensorChip}>Loc: {locQuality}%</Text>
              <Text style={styles.sensorChip}>Bat: {battery}%</Text>
            </View>
          </View>

        /* ── Pre-mapping: map view + joystick overlay — drive to start point ── */
        ) : mappingState === 'preMapping' ? (
          <View style={{ flex: 1 }}>
            {/* Map with existing maps + live mower position. Bounded height so
                the joystick + action buttons below have guaranteed space and
                the controls don't overlap the map's bottom edge. */}
            <View style={{ alignItems: 'center', marginBottom: 4 }}>
              <LiveMapView
                points={[]}
                orientation={mapOrientation}
                closed={false}
                height={Math.min(SCREEN_W - 32, 240)}
                width={Math.min(SCREEN_W - 32, 240)}
                existingMaps={existingMaps}
                mowerPosition={mowerLocal}
              />
            </View>

            {/* Joystick overlay — title + speed selector now stack vertically
                so the speed buttons get the full row width and don't get
                squeezed into the title (Ramon: "snelheids knoppen lopen door
                het map panel"). */}
            <View style={styles.preMappingOverlay}>
              <View style={styles.preMappingHeader}>
                <Text style={styles.preMappingTitle}>Drive to Start Point</Text>
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

            {/* Unicom scan guide — the mower firmware rejects the save with
                "pass_areas < 2" when the trajectory only touches one work map.
                Show live which work polygon the mower is currently inside so
                the user knows when they've crossed into the second map. */}
            {mapBuildType === 'unicom' && (() => {
              const workMaps = existingMaps.filter(m => m.mapType === 'work');
              const isInside = (pt: { x: number; y: number } | null, poly: Array<{ x: number; y: number }>) => {
                if (!pt || poly.length < 3) return false;
                let inside = false;
                for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                  const xi = poly[i].x, yi = poly[i].y;
                  const xj = poly[j].x, yj = poly[j].y;
                  const intersect = yi > pt.y !== yj > pt.y
                    && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
                  if (intersect) inside = !inside;
                }
                return inside;
              };
              const currentIn = mowerLocal
                ? workMaps.find(m => isInside(mowerLocal, m.points))
                : null;
              const currentMapName = currentIn
                ? (currentIn.fileName?.match(/^(map\d+)/)?.[1]) ?? currentIn.mapName ?? null
                : null;
              const visitedRef = unicomVisitedMapsRef.current;
              if (currentMapName && !visitedRef.has(currentMapName)) visitedRef.add(currentMapName);
              const visitedCount = visitedRef.size;

              return (
                <View style={[styles.closedBanner, { backgroundColor: visitedCount >= 2 ? 'rgba(0,212,170,0.12)' : 'rgba(245,158,11,0.12)' }]}>
                  <Ionicons
                    name={visitedCount >= 2 ? 'checkmark-circle' : 'navigate-outline'}
                    size={18}
                    color={visitedCount >= 2 ? colors.green : '#f59e0b'}
                  />
                  <Text style={[styles.closedBannerText, { flex: 1 }]}>
                    {visitedCount >= 2
                      ? `✓ Door beide maps gereden — je kan stoppen en opslaan`
                      : currentMapName
                        ? `In ${currentMapName}. Rij door de gap tot IN de andere map.`
                        : `Niet in een work-map. Rij tot binnen ${pendingChannelFromRef.current ?? 'map1'} om te beginnen.`}
                  </Text>
                </View>
              );
            })()}

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
              existingMaps={existingMaps}
              mowerPosition={mowerLocal}
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
            {/* Connection + error status bar */}
            <View style={styles.statsBar}>
              <View style={styles.statsChips}>
                <Text style={[styles.sensorChip, { backgroundColor: bleConnected ? 'rgba(0,212,170,0.15)' : 'rgba(239,68,68,0.15)', color: bleConnected ? colors.emerald : colors.red }]}>
                  BLE: {bleConnected ? 'OK' : bleConnecting ? '...' : 'OFF'}
                </Text>
                <Text style={[styles.sensorChip, { backgroundColor: mowerOnline ? 'rgba(0,212,170,0.15)' : 'rgba(239,68,68,0.15)', color: mowerOnline ? colors.emerald : colors.red }]}>
                  MQTT: {mowerOnline ? 'OK' : 'OFF'}
                </Text>
                <Text style={styles.sensorChip}>
                  Bat: {battery}%
                </Text>
                {parseInt(sensors.error_status ?? '0', 10) > 0 && (
                  <Text style={[styles.sensorChip, { backgroundColor: 'rgba(239,68,68,0.15)', color: colors.red }]}>
                    Error: {sensors.error_status}
                  </Text>
                )}
              </View>
            </View>

            {/* Error banner */}
            {parseInt(sensors.error_status ?? '0', 10) > 0 && (
              <View style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 12, padding: 12, marginBottom: 4, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="warning" size={18} color={colors.red} />
                <Text style={{ color: colors.red, fontSize: 13, flex: 1 }}>
                  {sensors.error_msg ?? `Error ${sensors.error_status}`}
                </Text>
              </View>
            )}

            <View style={styles.chargerCard}>
              <View style={styles.chargerIconContainer}>
                <Ionicons name="battery-charging" size={32} color={colors.emerald} />
              </View>
              <Text style={styles.chargerTitle}>
                {dockedOnCharger ? 'Docked!' : autoDockFailed ? 'Docking Failed' : 'Drive to Charger'}
              </Text>
              <Text style={styles.chargerDesc}>
                {dockedOnCharger
                  ? 'Mower is on the charger. Saving charger position...'
                  : autoDockFailed
                    ? 'NOVABOT could not finish docking. Drive it back near the charger and retry, or "Save Position Here" if it is already correctly positioned.'
                  : 'Drive the mower to ~50cm in front of the charger, facing it directly. Then tap "Auto Dock".'}
              </Text>

              {/* Dock status */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <View style={{ width: 12, height: 12, borderRadius: 6,
                  backgroundColor: dockedOnCharger ? colors.emerald : autoDockFailed ? colors.red : colors.amber }} />
                <Text style={{ color: dockedOnCharger ? colors.emerald : autoDockFailed ? colors.red : colors.text, fontSize: 14, fontWeight: '600' }}>
                  {dockedOnCharger
                    ? 'Docked — saving position...'
                    : autoDockFailed
                      ? 'Auto docking failed — retry or save manually'
                      : chargerAction === 'savePosition'
                        ? 'Saving charger position...'
                        : chargerAction === 'autoDock' || autoDockInProgress
                          ? 'Auto docking in progress...'
                          : 'Position the mower near the charger'}
                </Text>
              </View>
            </View>

            {/* Joystick — always visible. 0.7× scale + tighter gap so the
                Auto Dock + Save buttons below have room (was overlapping the
                speed selector at the bottom on iPhone-sized screens). */}
            <View style={styles.joystickArea}>
              <View style={styles.joystickContainer}>
                <GestureDetector gesture={panGesture}>
                  <View style={[styles.joystickBase, { width: JOYSTICK_SIZE * 0.7, height: JOYSTICK_SIZE * 0.7 }]}>
                    <View style={styles.crossV} />
                    <View style={styles.crossH} />
                    <View style={[styles.thumb, joystickActive && styles.thumbActive,
                      { transform: [{ translateX: thumbX * 0.7 }, { translateY: thumbY * 0.7 }] }]} />
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
                  autoDockRequestedRef.current = true;
                  chargerFailureHandledRef.current = false;
                  setChargerAction('autoDock');
                  // After a mapping session the mower's nav2 lifecycle stack
                  // needs to re-activate before FollowPath can service a dock
                  // request — this takes ~2-3 min and produces Error 122
                  // "follow path action error — software not initialized" until
                  // it finishes. Retry on 122 up to 5× with 20s spacing.
                  (async () => {
                    const maxAttempts = 6;
                    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                      sendCommand({ auto_recharge: { cmd_num: cmdNumRef.current++ } }, `auto_recharge (try ${attempt}/${maxAttempts})`);
                      console.log(`[Mapping] auto_recharge attempt ${attempt} sent`);
                      await waitForRespond('auto_recharge_respond', 10000);
                      // Watch for error_status 122 (nav2 not ready) within 6 s.
                      const started = Date.now();
                      let gotError122 = false;
                      while (Date.now() - started < 6000) {
                        const errStatus = parseInt(String(sensors.error_status ?? '0').match(/\d+/)?.[0] ?? '0', 10);
                        if (errStatus === 122) { gotError122 = true; break; }
                        // If dock progressed (recharge_status 1 or 9) we're done.
                        const rs = parseInt(String(sensors.recharge_status ?? '0'), 10);
                        if (rs === 1 || rs === 9) break;
                        await new Promise(r => setTimeout(r, 500));
                      }
                      if (!gotError122) { console.log('[Mapping] auto_recharge accepted (no 122)'); return; }
                      console.warn(`[Mapping] auto_recharge attempt ${attempt}: error 122, retry in 20s`);
                      await new Promise(r => setTimeout(r, 20000));
                    }
                    console.warn('[Mapping] auto_recharge: nav2 still not ready after retries, user can use Manual Save');
                  })();
                }}
                disabled={chargerAction === 'autoDock' || chargerAction === 'savePosition' || dockedOnCharger}
                activeOpacity={0.7}
              >
                {chargerAction === 'autoDock' && !dockedOnCharger ? (
                  <>
                    <ActivityIndicator size="small" color={colors.white} />
                    <Text style={styles.actionText}>Auto Docking...</Text>
                  </>
                ) : (
                  <>
                    <Ionicons name="navigate" size={20} color={colors.white} />
                    <Text style={styles.actionText}>Auto Dock</Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.cancelBtn, { flex: 1 }]}
                onPress={handleSaveChargerPos}
                disabled={chargerAction === 'savePosition' || dockedOnCharger}
                activeOpacity={0.7}
              >
                {chargerAction === 'savePosition' ? (
                  <>
                    <ActivityIndicator size="small" color={colors.emerald} />
                    <Text style={[styles.actionText, { color: colors.emerald }]}>Saving...</Text>
                  </>
                ) : (
                  <>
                    <Ionicons name="checkmark-circle" size={20} color={colors.emerald} />
                    <Text style={[styles.actionText, { color: colors.emerald }]}>Save Position Here</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>

        /* ── Done ── */
        ) : mappingState === 'done' ? (
          (() => {
            // Missing channel state comes from the hoisted `missingMapChannels`
            // / `mustCreateChannel` values so the header back-button can enforce
            // the same rule.
            const savedLabel = lastSaved?.buildType === 'unicom'
              ? 'Channel saved'
              : lastSaved?.buildType === 'obstacle'
                ? 'Obstacle saved'
                : 'Map saved';
            return (
              <View style={styles.centerBox}>
                <Ionicons
                  name={mustCreateChannel ? 'alert-circle' : 'checkmark-circle'}
                  size={64}
                  color={mustCreateChannel ? '#3b82f6' : colors.green}
                />
                <Text style={styles.centerTitle}>{savedLabel}</Text>
                <Text style={styles.centerSub}>
                  {mustCreateChannel
                    ? `You now have multiple work maps. Before you can leave this screen, draw a channel from ${missingMapChannels[0].from} to ${missingMapChannels[0].to} so the mower can move between them.`
                    : lastSaved?.buildType === 'work'
                      ? 'Your map has been uploaded.'
                      : 'The mower stored the path.'}
                </Text>

                {mustCreateChannel ? (
                  <TouchableOpacity
                    style={[styles.doneBtn, { marginTop: 20, backgroundColor: '#3b82f6', width: '100%' }]}
                    onPress={async () => {
                      // Capture the required start map for the upcoming unicom scan
                      // so handleStart can send the correct mapName regardless of
                      // any lastSaved / existingMaps staleness.
                      pendingChannelFromRef.current = missingMapChannels[0].from;
                      setMapBuildType('unicom');
                      setLastSaved(null);
                      // Skip the mode-selection screen — for a required channel
                      // the mode is always manual + joystick. Mirror the essential
                      // steps from handleStartManual without the confirmation alert.
                      setBleConnecting(true);
                      await connectBleJoystick();
                      setBleConnecting(false);
                      if (!isBleJoystickConnected()) {
                        Alert.alert('BLE', 'BLE not connected — check Bluetooth and proximity.');
                        setMappingState('idle');
                        return;
                      }
                      sendCommand(
                        { quit_mapping_mode: { value: 1, cmd_num: cmdNumRef.current++ } },
                        'quit_mapping_mode (cleanup)',
                      );
                      setMappingMode('manual');
                      setMappingState('preMapping');
                    }}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.doneBtnText}>
                      Create Channel {missingMapChannels[0].from} → {missingMapChannels[0].to}
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={[styles.doneBtn, { marginTop: 16 }]}
                    onPress={() => navigation.goBack()}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.doneBtnText}>{t('ok', undefined) || 'Done'}</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })()

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

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  backBtn: { padding: 4 },
  title: { fontSize: 24, fontWeight: '800', color: c.white },
  content: { flex: 1, paddingHorizontal: 16 },
  mappingContent: { flex: 1, paddingHorizontal: 16, gap: 8 },
  preMappingOverlay: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 10,
  },
  preMappingHeader: {
    alignItems: 'center',
  },
  preMappingTitle: {
    color: c.white,
    fontSize: 16,
    fontWeight: '700',
  },
  centerBox: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, paddingHorizontal: 32 },
  centerTitle: { fontSize: 20, fontWeight: '700', color: c.white, textAlign: 'center' },
  centerSub: { fontSize: 14, color: c.textMuted, textAlign: 'center' },

  // ── Card styles ──
  card: {
    backgroundColor: c.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: c.cardBorder,
    gap: 12,
  },
  cardTitle: { fontSize: 15, fontWeight: '700', color: c.white, textTransform: 'uppercase', letterSpacing: 1 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkDot: { width: 8, height: 8, borderRadius: 4 },
  checkText: { fontSize: 14, color: c.textDim },
  warning: {
    fontSize: 12,
    color: c.amber,
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
  modeBtnTitle: { fontSize: 15, fontWeight: '600', color: c.white },
  modeBtnSub: { fontSize: 12, color: c.textMuted, marginTop: 2 },

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
  closedBannerText: { flex: 1, fontSize: 13, fontWeight: '600', color: c.green },

  // ── Stats bar ──
  statsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: c.card,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: c.cardBorder,
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
    backgroundColor: c.red,
  },
  timerText: {
    fontSize: 16,
    fontWeight: '700',
    color: c.white,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  statsChips: { flexDirection: 'row', gap: 6 },
  sensorChip: {
    fontSize: 10,
    color: c.textDim,
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  closedChip: {
    backgroundColor: 'rgba(34,197,94,0.15)',
    color: c.green,
  },

  // ── Joystick area ──
  joystickArea: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  speedInfo: { height: 20 },
  speedText: {
    fontSize: 14,
    fontWeight: '700',
    color: c.emerald,
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
    backgroundColor: c.emerald,
    borderColor: c.white,
    shadowColor: c.emerald,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 8,
  },
  speedRow: {
    flexDirection: 'row',
    justifyContent: 'center',
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
    borderColor: c.emerald,
  },
  speedBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: c.textMuted,
  },

  // ── Autonomous area ──
  autonomousArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 24,
  },
  autonomousTitle: { fontSize: 18, fontWeight: '700', color: c.purple },
  autonomousSub: { fontSize: 14, color: c.textMuted, textAlign: 'center', lineHeight: 20 },

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
    backgroundColor: c.purple,
  },
  stopMapBtnReady: {
    backgroundColor: c.green,
  },
  actionText: { fontSize: 15, fontWeight: '700', color: c.white },

  // ── Charger positioning ──
  chargerContent: { flex: 1, paddingHorizontal: 16, justifyContent: 'space-between', gap: 8 },
  chargerCard: {
    backgroundColor: c.card,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: c.cardBorder,
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  chargerIconContainer: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(0,212,170,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  chargerTitle: { fontSize: 17, fontWeight: '700', color: c.white },
  chargerDesc: { fontSize: 13, color: c.text, textAlign: 'center', lineHeight: 18 },
  chargerHint: {
    fontSize: 12,
    color: c.amber,
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
    backgroundColor: c.emerald,
  },
  chargerSaveBtnText: { fontSize: 16, fontWeight: '700', color: c.white },

  // ── Done ──
  doneBtn: {
    marginTop: 24,
    paddingHorizontal: 40,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: c.emerald,
  },
  doneBtnText: { fontSize: 16, fontWeight: '700', color: c.white },
});
