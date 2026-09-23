/**
 * Map screen — lightweight SVG-based map with pan + pinch-zoom.
 * Shows mower position, charger, map polygons, GPS trail.
 * Supports importing Novabot ZIP map files.
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  Image as RNImage,
} from 'react-native';
import { appAlertCompat } from '../context/AppAlertContext';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  runOnJS,
} from 'react-native-reanimated';
import {
  GestureDetector,
  Gesture,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Svg, {
  Circle,
  Polygon as SvgPolygon,
  Polyline,
  G,
  Line,
  Path,
  Defs,
  ClipPath,
  Rect,
  Image as SvgImage,
  Text as SvgText,
} from 'react-native-svg';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useStyles, useTheme, type Colors } from '../theme';
import { useMowerState } from '../hooks/useMowerState';
import { useActiveMower } from '../hooks/useActiveMower';
import { ApiClient, type MapData, type TrailPoint, type LocalPoint, type ChargerGps, type GardenRenderState, type GardenRenderFraming } from '../services/api';
import { getServerUrl } from '../services/auth';
import { DemoBanner } from '../components/DemoBanner';
import { AppActionSheet, type AppActionSheetItem } from '../components/AppActionSheet';
import { useDemo } from '../context/DemoContext';
import { usePattern } from '../context/PatternContext';
import { contourToSvgPath, transformToGps } from '../utils/patternUtils';
import { findMissingChannels } from '../utils/mapChannels';
import { useI18n } from '../i18n';
import { Linking } from 'react-native';
import TerrainView3D from '../components/TerrainView3D';
import { isOpenNovaFirmware } from '../utils/firmwareCapability';

const { width: SCREEN_W } = Dimensions.get('window');
const MAP_PADDING = 24;
const MAP_SIZE = Math.min(SCREEN_W - MAP_PADDING * 2, 332);
const PANEL_PAGE_WIDTH = SCREEN_W - MAP_PADDING * 2;
const ZONE_PANEL_HEIGHT = 274;
const ZONE_PANEL_PEEK = 146;
const ZONE_PANEL_COLLAPSED_OFFSET = ZONE_PANEL_HEIGHT - ZONE_PANEL_PEEK;
const INNER_PADDING = 10;

// ── Local meters → SVG coordinate conversion ───────────────────────
// All map data is in local meters with charger at (0,0).
// Mower GPS is converted to local meters using charger GPS as origin.

interface GpsPoint { lat: number; lng: number }

interface LocalBounds {
  minX: number; maxX: number; minY: number; maxY: number;
}

/** Convert GPS point to local meters relative to charger GPS origin */
function gpsToLocal(point: GpsPoint, origin: GpsPoint): LocalPoint {
  const metersPerDegreeLat = 111320;
  const metersPerDegreeLng = 111320 * Math.cos(origin.lat * Math.PI / 180);
  return {
    x: (point.lng - origin.lng) * metersPerDegreeLng,
    y: (point.lat - origin.lat) * metersPerDegreeLat,
  };
}

function computeLocalBounds(points: LocalPoint[]): LocalBounds | null {
  if (points.length === 0) return null;
  // No rotation — bounds in raw local frame.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    const rx = p.x;
    const ry = p.y;
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry;
    if (ry > maxY) maxY = ry;
  }
  return { minX, maxX, minY, maxY };
}

function expandLocalBounds(a: LocalBounds | null, b: LocalBounds | null): LocalBounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Rotate a point around the origin by angle (radians). Used to align local frame with north. */
function rotatePoint(p: LocalPoint, angle: number): LocalPoint {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}

/** Convert local meter point to SVG coordinates.
 *  X grows left→right, Y inverted because SVG Y grows down. Matches the
 *  Novabot stock app orientation (LiveMapView.project / earlier this
 *  view rotated 180° vs Novabot — now aligned). */
function localToSvg(point: LocalPoint, bounds: LocalBounds, size: number, padding: number) {
  // No rotation — map frame is rendered as-is (ENU-aligned).
  const rx = point.x;
  const ry = point.y;
  const drawSize = size - padding * 2;
  const xRange = bounds.maxX - bounds.minX || 0.1;
  const yRange = bounds.maxY - bounds.minY || 0.1;
  const scale = Math.min(drawSize / xRange, drawSize / yRange);
  const x = padding + (rx - bounds.minX) * scale + (drawSize - xRange * scale) / 2;
  const y = padding + (bounds.maxY - ry) * scale + (drawSize - yRange * scale) / 2;
  return { x, y };
}

function polygonAreaSqMeters(points: LocalPoint[]): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const next = points[(i + 1) % points.length];
    area += points[i].x * next.y - next.x * points[i].y;
  }
  return Math.abs(area) / 2;
}

function formatAreaLabel(areaSqMeters: number): string {
  if (areaSqMeters >= 100) return `${Math.round(areaSqMeters)} m²`;
  if (areaSqMeters >= 10) return `${areaSqMeters.toFixed(1).replace(/\.0$/, '')} m²`;
  return `${areaSqMeters.toFixed(1)} m²`;
}

function formatEtaLabel(areaSqMeters: number): string {
  if (areaSqMeters <= 0) return '0.5 h';
  const estimatedHours = Math.max(0.5, areaSqMeters / 102);
  return `${estimatedHours.toFixed(1).replace(/\.0$/, '')} h`;
}

function getMapFamilyKey(map: Pick<MapData, 'mapId' | 'mapName'>): string | null {
  const candidates = [map.mapId, map.mapName].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const match = candidate.match(/^(map\d+)/i);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

// The `mapXtocharge_unicom` row is auto-generated when a map is saved
// (it's the charger connection). It shouldn't count as a user channel —
// users only care about real map-to-map unicoms (`mapXtomapY_N_unicom`).
function isChargerUnicom(map: Pick<MapData, 'mapName'> & { fileName?: string | null }): boolean {
  const candidates = [map.mapName, (map as { fileName?: string | null }).fileName].filter((v): v is string => !!v);
  return candidates.some(v => /tocharge_unicom/i.test(v));
}

// A map-to-map channel (mapXtomapY_N_unicom) belongs to BOTH endpoint zones.
// getMapFamilyKey only sees the first prefix ("map0" for "map0tomap1..."), so
// counting channels by family alone attributes each channel to one zone only —
// that undercounts every higher-index zone (map1 lost map0tomap1). Match either
// endpoint instead. Returns the obstacle + real-channel counts for one zone, the
// single source of truth shared by the hero meta and the per-zone card so they
// can never disagree (Ramon 2026-06-21).
function countZoneFeatures(
  zone: Pick<MapData, 'mapId' | 'mapName'>,
  allMaps: MapData[],
): { obstacles: number; channels: number } {
  const fam = getMapFamilyKey(zone);
  let obstacles = 0;
  let channels = 0;
  for (const m of allMaps) {
    if (m.mapId === zone.mapId || m.mapType === 'work') continue;
    if (m.mapType === 'obstacle') {
      if (fam && getMapFamilyKey(m) === fam) obstacles++;
    } else if (m.mapType === 'unicom' && !isChargerUnicom(m)) {
      const name = m.canonicalName ?? (m as { fileName?: string | null }).fileName ?? m.mapName ?? '';
      const pair = name.match(/(map\d+)to(map\d+)/i);
      if (fam && pair && (pair[1].toLowerCase() === fam || pair[2].toLowerCase() === fam)) channels++;
    }
  }
  return { obstacles, channels };
}

/**
 * Returns true if the mower-generated default obstacle name should be
 * considered "no meaningful name". Firmware's save_map generates file names
 * like map0_0_obstacle / map1_2_obstacle via generate_map_file_name; the DB
 * often stores the base (with or without .csv, with or without number
 * suffixes) as mapName. Only when the user has picked a real label via the
 * Rename sheet do we show a text overlay on the polygon.
 */
function isCustomObstacleName(name: string | null | undefined): name is string {
  if (!name) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  // map0_0_obstacle / map12_3_obstacle.csv / obstacle / obstacle_0 → all default
  if (/^map\d+_\d+_obstacle(\.csv)?$/i.test(trimmed)) return false;
  // obstacle, obstacle_0, obstacle1, obstacle 1 — LFI cloud's default alias
  // shape (issue #14: dir26738 saw "obstacle1..obstacle8" labels on the map).
  if (/^obstacle[\s_]?\d*(\.csv)?$/i.test(trimmed)) return false;
  return true;
}

// ── Map type colors ──────────────────────────────────────────────────

const MAP_COLORS: Record<string, { fill: string; stroke: string }> = {
  work:     { fill: 'rgba(34,197,94,0.2)',  stroke: '#22c55e' },
  obstacle: { fill: 'rgba(239,68,68,0.2)',  stroke: '#ef4444' },
  unicom:   { fill: 'rgba(59,130,246,0.2)', stroke: '#3b82f6' },
  channel:  { fill: 'rgba(59,130,246,0.15)', stroke: '#3b82f6' },
};

// ── Coverage stripes for mowing visualization ────────────────────────

function generateCoverageStripes(
  svgPoints: Array<{ x: number; y: number }>,
  direction: number,
  progress: number,
  spacing: number,
): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  if (svgPoints.length < 3 || progress <= 0) return [];
  const xs = svgPoints.map((p) => p.x);
  const ys = svgPoints.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const diagonal = Math.sqrt((Math.max(...xs) - Math.min(...xs)) ** 2 + (Math.max(...ys) - Math.min(...ys)) ** 2);

  // Stripes run ALONG the path direction, spacing perpendicular.
  // localToSvg now matches Novabot orientation (X normal, Y inverted) —
  // direction maps directly without 180° offset.
  const rad = (direction * Math.PI) / 180;
  const perpRad = ((direction + 90) * Math.PI) / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  const px = Math.cos(perpRad), py = Math.sin(perpRad);

  const total = Math.ceil(diagonal / spacing);
  const filled = Math.floor((total * progress) / 100);
  const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (let i = -total; i <= total; i++) {
    if (Math.abs(i) > filled) continue;
    const ox = cx + px * i * spacing;
    const oy = cy + py * i * spacing;
    lines.push({ x1: ox - dx * diagonal, y1: oy - dy * diagonal, x2: ox + dx * diagonal, y2: oy + dy * diagonal });
  }
  return lines;
}

// ── Demo data ────────────────────────────────────────────────────────

// Demo data in local meters (charger = 0,0)
const DEMO_MAPS: MapData[] = [
  { mapId: 'demo-front', mapName: 'Front Yard', mapType: 'work', mapArea: [
    { x: -3, y: 5 }, { x: 1, y: 7 }, { x: 5, y: 6 },
    { x: 6, y: 2 }, { x: 3, y: -1 }, { x: -2, y: 1 },
  ]},
  { mapId: 'demo-back', mapName: 'Back Garden', mapType: 'work', mapArea: [
    { x: -5, y: -3 }, { x: -2, y: -5 }, { x: 3, y: -4 },
    { x: 4, y: -1 }, { x: -1, y: -1 },
  ]},
  { mapId: 'demo-obstacle', mapName: 'Tree', mapType: 'obstacle', mapArea: [
    { x: 1, y: 4 }, { x: 2, y: 5 }, { x: 1, y: 6 }, { x: 0, y: 5 },
  ]},
];

const DEMO_TRAIL: TrailPoint[] = Array.from({ length: 30 }, (_, i) => ({
  lat: 52.0907 + Math.sin(i * 0.3) * 0.0004,
  lng: 5.1214 + i * 0.00015,
  ts: Date.now() - (30 - i) * 5000,
}));

// ── Component ────────────────────────────────────────────────────────

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const patternCtx = usePattern();
  const { devices, connected } = useMowerState();
  const demo = useDemo();
  const { t } = useI18n();
  const [view3d, setView3d] = useState(false);
  const styles = useStyles(makeStyles);
  const { colors, colorScheme } = useTheme();
  const [maps, setMaps] = useState<MapData[]>([]);
  const [chargerGpsOrigin, setChargerGpsOrigin] = useState<ChargerGps | null>(null);
  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const [plannedPaths, setPlannedPaths] = useState<Array<{ id: string; points: LocalPoint[] }>>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [actionsMenuVisible, setActionsMenuVisible] = useState(false);
  // Small helper used by the action-sheet items: close the sheet first, then
  // run the requested handler so the modal animates out before any dialog /
  // navigation fires.
  const runFromActionsMenu = useCallback((fn: () => void) => {
    setActionsMenuVisible(false);
    // next tick so the modal begins its close animation before work runs
    setTimeout(() => {
      try { fn(); } catch (err) { console.error('[MapScreen] actions menu handler error:', err); }
    }, 0);
  }, []);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null); // null = all zones
  const [panelExpanded, setPanelExpanded] = useState(true);
  const [sheetState, setSheetState] = useState<{
    visible: boolean;
    title: string;
    message?: string;
    actions: AppActionSheetItem[];
  }>({ visible: false, title: '', actions: [] });
  const zoneCarouselRef = useRef<ScrollView | null>(null);
  const panelOffsetY = useSharedValue(0);
  const panelStartY = useSharedValue(0);

  const workMaps = useMemo(() => maps.filter(m => m.mapType === 'work'), [maps]);
  const selectedWorkMap = useMemo(
    () => workMaps.find(m => m.mapId === selectedZoneId) ?? workMaps[0] ?? null,
    [selectedZoneId, workMaps],
  );
  const selectedWorkIndex = useMemo(
    () => (selectedWorkMap ? workMaps.findIndex(m => m.mapId === selectedWorkMap.mapId) : -1),
    [selectedWorkMap, workMaps],
  );
  const selectedFamilyKey = useMemo(
    () => (selectedWorkMap ? getMapFamilyKey(selectedWorkMap) : null),
    [selectedWorkMap],
  );

  // Show ALL maps always — selected work map is green, others are greyed out
  const visibleMaps = useMemo(() => maps, [maps]);

  const { activeMower: mower } = useActiveMower();
  // Mapping preflight + 3D terrain both need extended_commands.py (OpenNova
  // custom firmware only). On stock: skip the preflight call (no 8 s stall)
  // and hide the 3D view.
  const stockFw = !!mower && !isOpenNovaFirmware(mower.firmwareVersion);
  const show3d = view3d && !stockFw;

  // Which picture of the garden is on screen: the drawn map (default), the
  // drone photo, or the 3D render. A 'flat' render kept the aerial's framing,
  // so it knows its own extent in local metres and goes under the map's own
  // layers, with the mower and its lanes still on top. An 'iso' render is a
  // picture from an unknown camera, so nothing can be drawn on it and it
  // replaces the map. Day or evening is chosen by the server from sunrise and
  // sunset at the mower.
  type BaseView = 'map' | 'drone' | 'render';
  const [baseView, setBaseView] = useState<BaseView>('map');
  const [renderState, setRenderState] = useState<GardenRenderState | null>(null);
  const [renderBusy, setRenderBusy] = useState(false);
  const [renderNonce, setRenderNonce] = useState(() => String(Date.now()));
  // Which framing is on screen; both are kept. A framing that was never made
  // is still listed, and says so when tapped, instead of silently doing nothing.
  const [renderFraming, setRenderFraming] = useState<GardenRenderFraming>('flat');
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const shownRender = renderState?.framings[renderFraming] ?? null;
  // Day or evening: automatic from sunrise/sunset at the mower, or pinned.
  const [renderLight, setRenderLight] = useState<'auto' | 'day' | 'night'>('auto');
  const renderVariant: 'day' | 'night' = renderLight === 'auto' ? (renderState?.variant ?? 'day') : renderLight;
  const [makerOpen, setMakerOpen] = useState(false);
  const [makerFraming, setMakerFraming] = useState<GardenRenderFraming>('flat');
  const [makerSource, setMakerSource] = useState<'aerial' | 'drone'>('aerial');
  const renderUrl = serverUrl && shownRender && mower?.sn
    ? new ApiClient(serverUrl).gardenRenderImageUrl(mower.sn, renderNonce, renderFraming, renderVariant) : null;

  useEffect(() => {
    const sn = mower?.sn;
    if (!sn) { setRenderState(null); return; }
    (async () => {
      try {
        const url = await getServerUrl();
        if (!url) return;
        setServerUrl(url);
        setRenderState(await new ApiClient(url).getGardenRender(sn));
      } catch { setRenderState(null); }
    })();
  }, [mower?.sn, renderNonce]);

  const runRender = useCallback(async (source: 'aerial' | 'drone', framing: GardenRenderFraming) => {
    const sn = mower?.sn;
    if (!sn || renderBusy) return;
    setRenderBusy(true);
    try {
      const url = await getServerUrl();
      if (!url) return;
      await new ApiClient(url).generateGardenRender(sn, source, framing);
      setRenderNonce(String(Date.now()));
      setRenderFraming(framing);
      setBaseView('render');
    } catch (e) {
      appAlertCompat.alert(t('error'), e instanceof Error ? e.message : String(e));
    } finally {
      setRenderBusy(false);
    }
  }, [mower?.sn, renderBusy, t]);

  const showRender = useCallback((framing: GardenRenderFraming) => {
    if (!renderState?.framings[framing]) {
      appAlertCompat.alert(t('baseViewRender'), t('baseViewRenderMissingMsg'));
      return;
    }
    setRenderFraming(framing);
    setBaseView('render');
  }, [renderState, t]);

  const openMaker = useCallback(() => {
    setMakerFraming(renderFraming); setMakerSource('aerial'); setMakerOpen(true);
  }, [renderFraming]);

  const openBaseViewMenu = useCallback(() => {
    const items: AppActionSheetItem[] = [
      { label: t('baseViewMap'), icon: 'map-outline', onPress: () => setBaseView('map') },
      {
        label: renderState?.available ? t('baseViewRender') : `${t('baseViewRender')} (${t('baseViewRenderNotMade')})`,
        icon: 'cube-outline',
        onPress: () => {
          if (!renderState?.available) { openMaker(); return; }
          showRender(renderState.framings[renderFraming] ? renderFraming : renderFraming === 'flat' ? 'iso' : 'flat');
        },
      },
      { label: `${t('renderNewTitle')}…`, icon: 'sparkles-outline', onPress: openMaker },
    ];
    setSheetState({ visible: true, title: t('baseViewTitle'), actions: items });
  }, [renderState, renderFraming, showRender, openMaker, t]);

  // Read-only mapping preflight gate. Runs BEFORE navigating into any map
  // action (create / edit-redraw / unicom) so a `block` popup shows here on
  // MapScreen and simply prevents navigation — instead of appearing behind the
  // Create-Map screen. block → stop; warn → confirm; stock fw / timeout → skip
  // (never blocks non-OpenNova mowers). Returns true when it's OK to proceed.
  const mappingPreflightGate = async (): Promise<boolean> => {
    const sn = mower?.sn;
    if (stockFw) return true; // stock firmware: nothing to check, don't stall
    let pf: { verdict: 'ok' | 'warn' | 'block'; reasons: string[] } | null = null;
    try {
      const url = await getServerUrl();
      if (!url || !sn) return true;
      pf = await new ApiClient(url).mappingPreflight(sn);
    } catch {
      return true; // stock firmware / timeout — don't block the OpenNova-only gate
    }
    if (!pf || pf.verdict === 'ok') return true;
    const reasons = (pf.reasons ?? []).map(r => `• ${r}`).join('\n');
    if (pf.verdict === 'block') {
      appAlertCompat.alert(
        t('preflightBlockTitle'),
        (t('preflightBlockBody')) + '\n\n' + reasons,
      );
      return false;
    }
    return await new Promise<boolean>((resolve) => {
      appAlertCompat.alert(
        t('preflightWarnTitle'),
        (t('preflightWarnBody')) + '\n\n' + reasons,
        [
          { text: t('cancel'), style: 'cancel', onPress: () => resolve(false) },
          { text: t('proceedAnyway'), onPress: () => resolve(true) },
        ],
      );
    });
  };

  // Run the preflight, then navigate to the mapping flow only if not blocked.
  const gateThenNavigate = async (params?: Record<string, unknown>) => {
    if (!(await mappingPreflightGate())) return;
    (navigation as any).navigate('Mapping', params);
  };

  // Mower position from ROS2 localization (map_position_x/y) — already in local meters, much more accurate than GPS
  const mowerLocal: LocalPoint | null = useMemo(() => {
    const mx = mower?.sensors.map_position_x;
    const my = mower?.sensors.map_position_y;
    if (mx == null || my == null) return null;
    const x = parseFloat(mx);
    const y = parseFloat(my);
    if (isNaN(x) || isNaN(y)) return null;
    return { x, y };
  }, [mower?.sensors.map_position_x, mower?.sensors.map_position_y]);

  // Use local map_position_orientation (radians) for heading on local map
  const heading = parseFloat(mower?.sensors.map_position_orientation ?? '0') || 0;
  const msg = mower?.sensors.msg ?? '';
  const isMowing = msg.includes('Work:RUNNING') || msg.includes('Work:NAVIGATING') || msg.includes('Work:COVERING') || msg.includes('Work:MOVING')
    || msg.includes('Work:BOUNDARY_COVERING') || msg.includes('Work:AVOIDING');
  // Mapping mode = mower is recording a new map / obstacle / channel.
  // We trust ONLY the msg + task_mode here — start_edit_or_assistant_map_flag
  // is unreliable (mqtt_node's internal mapping flag has been observed to
  // stay set after a failed save sequence even though the mower has long
  // returned to COVERAGE/WAIT state). msg is the authoritative human-
  // visible state from RobotStatus and updates immediately.
  //
  // Stock firmware lingers in `Mode:MAPPING Work:FINISHED` for tens of
  // seconds after save_map type:1 — treat the echo as NOT active so the
  // Start-Mowing button doesn't stay disabled with "Mapping in progress"
  // when the mower has actually returned to idle.
  const taskModeRaw = mower?.sensors.task_mode ?? '0';
  const isMapping = (taskModeRaw === '3' || msg.includes('Mode:MAPPING'))
    && !msg.includes('Work:FINISHED')
    && !msg.includes('Work:WAIT');
  // A coverage task parked on the dock (low-battery recharge, "pause & return")
  // is still the same session: keep its covered lanes on screen and offer
  // Resume instead of a fresh Start (GH #30). Same detection as HomeScreen:
  // docked + task_mode 1 + the current Work field says recharge/user-stop, or
  // stock 5.7.1's work_status 12 "Low power" which sets none of those.
  const interruptedSensors = mower?.sensors;
  const isInterruptedCoverage = (() => {
    if (!interruptedSensors) return false;
    const bs = (interruptedSensors.battery_state ?? '').toUpperCase();
    const onDock = bs === 'CHARGING' || bs === 'FINISHED';
    const taskMode = parseInt(interruptedSensors.task_mode ?? '0', 10);
    const cur = msg.replace(/Prev work:\S*/g, '');
    const ws = interruptedSensors.work_status ?? '';
    return onDock && taskMode === 1 && (
      /Work:(USER_RECHARGE_STOP|BATTERY_LOW_RECHARGE|USER_STOP|PAUSED)\b/.test(cur)
      || ws === '12' || ws === 'Low power');
  })();
  const showTrail = isMowing || isMapping;
  const showCoverPath = isMowing || isInterruptedCoverage;
  // Voortgangs-state uit report_state_timer_data.cover_path.covered — elke
  // MQTT tick door server geforward als sensor-velden. finished_area is een
  // space-separated lijst van voltooide planned_path sub-gebied indices,
  // covering_area_id is het gebied waar de maaier nu mee bezig is.
  const coverMapId = mower?.sensors.cover_map_id;
  const finishedAreaSet = useMemo<Set<string>>(() => {
    const raw = mower?.sensors.finished_area;
    if (!raw) return new Set();
    const ids = raw.trim().split(/\s+/).filter(Boolean);
    // plannedPaths[].id = "{map_id}_{sub_id}" — accepteer beide formats
    const out = new Set<string>(ids);
    if (coverMapId) ids.forEach(sub => out.add(`${coverMapId}_${sub}`));
    return out;
  }, [mower?.sensors.finished_area, coverMapId]);
  const activeAreaId = (() => {
    const raw = mower?.sensors.covering_area_id;
    if (!raw) return undefined;
    return coverMapId ? `${coverMapId}_${raw}` : raw;
  })();
  const activeAreaPoints = parseInt(mower?.sensors.covering_area_points ?? '0', 10) || 0;
  const covRatioRaw = parseFloat(mower?.sensors.cov_ratio ?? '0') || 0;
  const covRatio = covRatioRaw <= 1 ? Math.round(covRatioRaw * 100) : Math.round(covRatioRaw);
  const mowingProgress = parseInt(mower?.sensors.mowing_progress ?? '0', 10) || 0;
  // Issue #44: stripes appeared horizontal at 105° because we were reading
  // `path_direction` (the user-setting echo) which can lag or stay "0" while
  // a coverage task is running. The mower's live mowing angle is published
  // as `cov_direction` (Mow Direction) — read that first when available.
  const covDirRaw = mower?.sensors.cov_direction;
  const pathDirRaw = mower?.sensors.path_direction;
  const covDirNum = covDirRaw != null ? parseInt(covDirRaw, 10) : NaN;
  const pathDirNum = pathDirRaw != null ? parseInt(pathDirRaw, 10) : NaN;
  const pathDir = Number.isFinite(covDirNum) && covDirNum > 0
    ? covDirNum
    : (Number.isFinite(pathDirNum) ? pathDirNum : 0);

  const fetchData = useCallback(async () => {
    if (demo.enabled) {
      setMaps(DEMO_MAPS);
      setTrail(DEMO_TRAIL);
      setLoading(false);
      return;
    }
    const sn = mower?.sn;
    if (!sn) { setLoading(false); return; }
    setLoading(true);
    try {
      const url = await getServerUrl();
      if (!url) return;
      const api = new ApiClient(url);
      const [mapsRes, trailRes, pathsRes, previewRes] = await Promise.all([
        api.fetchMaps(sn).catch(() => ({ maps: [], chargerGps: null })),
        api.getTrail(sn).catch(() => []),
        api.getPlannedPath(sn).catch(() => []),
        api.getPreviewPath(sn).catch(() => []),
      ]);
      setMaps(mapsRes.maps ?? []);
      setChargerGpsOrigin(mapsRes.chargerGps ?? null);
      setTrail(Array.isArray(trailRes) ? trailRes : (trailRes as any).trail ?? []);
      // Prefer plan_path tijdens maaien (live refresh), anders preview_path
      // (statische berekening gebaseerd op de laatste maaisessie). Beide
      // hebben hetzelfde formaat: [{ id: "{map_id}_{sub_id}", points: [...] }].
      const plan = Array.isArray(pathsRes) ? pathsRes : [];
      const preview = Array.isArray(previewRes) ? previewRes : [];
      setPlannedPaths(plan.length > 0 ? plan : preview);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [mower?.sn, demo.enabled]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useFocusEffect(
    useCallback(() => {
      // Fetch immediately, then poll a few more times: a mapping/save triggers
      // an ASYNC mower->server upload that only lands ~15-30s later, so this
      // lets a freshly recorded map/channel (and the cleared "zones not
      // connected" banner) appear on its own, without switching tabs. Timers
      // are cleared on blur so we don't poll in the background.
      fetchData();
      const timers = [6000, 20000, 35000].map((d) => setTimeout(() => { fetchData(); }, d));
      return () => timers.forEach(clearTimeout);
    }, [fetchData]),
  );

  useEffect(() => {
    if (workMaps.length === 0) {
      setSelectedZoneId(null);
      return;
    }
    if (!selectedZoneId || !workMaps.some(m => m.mapId === selectedZoneId)) {
      setSelectedZoneId(workMaps[0].mapId);
    }
  }, [selectedZoneId, workMaps]);

  useEffect(() => {
    if (selectedWorkIndex < 0 || workMaps.length <= 1) return;
    zoneCarouselRef.current?.scrollTo({ x: selectedWorkIndex * PANEL_PAGE_WIDTH, animated: true });
  }, [selectedWorkIndex, workMaps.length]);

  useEffect(() => {
    if (workMaps.length === 0) {
      panelOffsetY.value = 0;
      setPanelExpanded(false);
    }
  }, [panelOffsetY, workMaps.length]);

  // Auto-refresh trail every 3s during mowing
  useEffect(() => {
    if (!isMowing || !mower?.sn || demo.enabled) return;
    const interval = setInterval(async () => {
      try {
        const url = await getServerUrl();
        if (!url) return;
        const api = new ApiClient(url);
        const trailRes = await api.getTrail(mower.sn).catch(() => []);
        setTrail(Array.isArray(trailRes) ? trailRes : (trailRes as any).trail ?? []);
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(interval);
  }, [isMowing, mower?.sn, demo.enabled]);

  // Tijdens maaien: haal het ECHTE coverage-pad van de maaier op. refresh-plan-path
  // populeert de server-cache via get_map_plan_path (geen Error-128 risico). Zonder
  // deze trigger blijft plannedPaths leeg en zie je alleen de decoratieve strepen.
  // Het pad zelf verandert niet tijdens het maaien (alleen welke segmenten "klaar"
  // zijn — dat komt uit finishedAreaSet/sensors), dus een rustige 20s-poll volstaat
  // om het pad te laden en bij een map-wissel actueel te houden.
  useEffect(() => {
    if (!(isMowing || isInterruptedCoverage) || !mower?.sn || demo.enabled) return;
    let cancelled = false;
    const pullPath = async () => {
      try {
        const url = await getServerUrl();
        if (!url) return;
        const api = new ApiClient(url);
        const paths = await api.refreshPlanPath(mower.sn).catch(() => []);
        if (!cancelled && Array.isArray(paths) && paths.length > 0) setPlannedPaths(paths);
      } catch { /* ignore */ }
    };
    pullPath();
    const interval = setInterval(pullPath, 20000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [isMowing, isInterruptedCoverage, mower?.sn, demo.enabled]);

  // ── Pan + Zoom state ─────────────────────────────────────────────
  const scale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedScale = useSharedValue(1);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const pinchGesture = Gesture.Pinch()
    .onStart(() => {
      savedScale.value = scale.value;
    })
    .onUpdate((e) => {
      scale.value = Math.min(Math.max(savedScale.value * e.scale, 0.5), 8);
    });

  const panGesture = Gesture.Pan()
    .onStart(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    })
    .onUpdate((e) => {
      translateX.value = savedTranslateX.value + e.translationX;
      translateY.value = savedTranslateY.value + e.translationY;
    });

  // Back to the fitted view. Double-tap has done this since the first beta and
  // the hint under the map says so, but people still zoom in and lose the
  // garden (GH #43), so it also gets a visible button.
  const resetView = useCallback(() => {
    scale.value = withTiming(1, { duration: 300 });
    translateX.value = withTiming(0, { duration: 300 });
    translateY.value = withTiming(0, { duration: 300 });
  }, [scale, translateX, translateY]);

  // Gesture callbacks run as worklets on the UI thread; resetView is a plain
  // JS function and calling it there crashes with "Tried to synchronously
  // call a non-worklet function on the UI thread" (GH #117). Write the shared
  // values directly, as MowingProgressMap does.
  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      'worklet';
      scale.value = withTiming(1, { duration: 300 });
      translateX.value = withTiming(0, { duration: 300 });
      translateY.value = withTiming(0, { duration: 300 });
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  const snapPanel = useCallback((expand: boolean) => {
    panelOffsetY.value = withSpring(expand ? 0 : ZONE_PANEL_COLLAPSED_OFFSET, {
      damping: 18,
      stiffness: 180,
      mass: 0.9,
    });
    setPanelExpanded(expand);
  }, [panelOffsetY]);

  const panelGesture = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .failOffsetX([-18, 18])
    .onStart(() => {
      panelStartY.value = panelOffsetY.value;
    })
    .onUpdate((event) => {
      const next = panelStartY.value + event.translationY;
      panelOffsetY.value = Math.min(Math.max(next, 0), ZONE_PANEL_COLLAPSED_OFFSET);
    })
    .onEnd((event) => {
      const projected = panelOffsetY.value + event.velocityY * 0.05;
      const shouldExpand = projected < ZONE_PANEL_COLLAPSED_OFFSET * 0.45;
      panelOffsetY.value = withSpring(shouldExpand ? 0 : ZONE_PANEL_COLLAPSED_OFFSET, {
        damping: 18,
        stiffness: 180,
        mass: 0.9,
      });
      runOnJS(setPanelExpanded)(shouldExpand);
    });

  const panelAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: panelOffsetY.value }],
  }));

  // ── Export ZIP ───────────────────────────────────────────────────
  const handleExport = async () => {
    if (!mower?.sn || maps.length === 0) return;

    if (demo.enabled) {
      appAlertCompat.alert(t('hmDemoMode'), t('hmExportDemoUnavailable'));
      return;
    }

    try {
      const serverUrl = await getServerUrl();
      if (!serverUrl) return;
      const downloadUrl = `${serverUrl}/api/dashboard/maps/${encodeURIComponent(mower.sn)}/download-zip`;
      await Linking.openURL(downloadUrl);
    } catch (e) {
      appAlertCompat.alert(t('error'), e instanceof Error ? e.message : t('hmExportFailed'));
    }
  };

  // ── Import ZIP ───────────────────────────────────────────────────
  const handleDeleteMap = useCallback((map: MapData) => {
    const typeLabel = map.mapType === 'obstacle' ? (t('obstacle'))
      : map.mapType === 'unicom' ? (t('channel'))
      : (t('map'));
    setSheetState({
      visible: true,
      title: t('hmDeleteTypeTitle', { type: typeLabel }),
      message: t('deleteMapConfirm'),
      actions: [
        {
          label: t('delete'),
          icon: 'trash-outline',
          destructive: true,
          onPress: async () => {
            try {
              const url = await getServerUrl();
              if (!url || !mower) return;
              const target = `${url}/api/dashboard/maps/${encodeURIComponent(mower.sn)}/${encodeURIComponent(map.mapId)}`;
              console.log(`[deleteMap] DELETE ${target}`);
              const res = await fetch(target, { method: 'DELETE' });
              const bodyText = await res.text().catch(() => '<no body>');
              console.log(`[deleteMap] HTTP ${res.status} body=${bodyText.slice(0, 200)}`);
              if (!res.ok) {
                // Server refusals carry a readable `error` (busy, dock channel, ...).
                let reason = '';
                try { reason = (JSON.parse(bodyText) as { error?: string }).error ?? ''; } catch { /* not JSON */ }
                appAlertCompat.alert(t('error'), reason || t('hmDeleteFailedHttp', { status: res.status, body: bodyText.slice(0, 200) }));
                return;
              }
              fetchData();
            } catch (e) {
              const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
              console.warn('[deleteMap] threw:', msg);
              appAlertCompat.alert(t('error'), t('hmDeleteFailedMsg', { msg }));
            }
          },
        },
      ],
    });
  }, [fetchData, mower, t]);

  const handleMapAction = (map: MapData) => {
    const typeLabel = map.mapType === 'obstacle' ? (t('obstacle'))
      : map.mapType === 'unicom' ? (t('channel'))
      : (t('map'));
    const renameLabel = t('hmRenameType', { type: typeLabel });
    setSheetState({
      visible: true,
      title: map.mapName || typeLabel,
      actions: [
        {
          label: renameLabel,
          icon: 'create-outline',
          onPress: () => {
            Alert.prompt(
              renameLabel,
              t('enterNewName'),
              async (newName) => {
                if (!newName?.trim()) return;
                try {
                  const url = await getServerUrl();
                  if (!url || !mower) return;
                  await fetch(`${url}/api/dashboard/maps/${encodeURIComponent(mower.sn)}/${encodeURIComponent(map.mapId)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mapName: newName.trim() }),
                  });
                  fetchData();
                } catch { appAlertCompat.alert(t('error'), t('hmRenameFailed')); }
              },
              'plain-text',
              map.mapName || '',
            );
          },
        },
        {
          label: t('delete'),
          icon: 'trash-outline',
          destructive: true,
          onPress: () => handleDeleteMap(map),
        },
      ],
    });
  };

  const [cloudImporting, setCloudImporting] = useState(false);
  const handleCloudImport = async () => {
    if (!mower?.sn) return;
    setCloudImporting(true);
    try {
      const serverUrl = await getServerUrl();
      const token = await (await import('../services/auth')).getToken();
      if (!serverUrl || !token) {
        appAlertCompat.alert(t('error'), t('hmNotAuthenticated'));
        setCloudImporting(false);
        return;
      }

      // Fetch maps from our server's queryEquipmentMap (which mirrors cloud API)
      const res = await fetch(
        `${serverUrl}/api/nova-file-server/map/queryEquipmentMap?sn=${encodeURIComponent(mower.sn)}`,
        { headers: { 'Authorization': token } },
      );
      const json = await res.json();
      const data = json?.value?.data;

      if (!data) {
        appAlertCompat.alert(t('cloudImport'), t('noCloudMaps'));
        setCloudImporting(false);
        return;
      }

      // data = { work: [MapEntityItem, ...], unicom: [...] }
      const workItems = data.work ?? [];
      const unicomItems = data.unicom ?? [];

      if (workItems.length === 0 && unicomItems.length === 0) {
        appAlertCompat.alert(t('cloudImport'), t('noCloudMaps'));
        setCloudImporting(false);
        return;
      }

      // Download CSV data from each map's URL and import via upload-zip or direct DB
      let imported = 0;
      const api = new ApiClient(serverUrl);

      for (const item of [...workItems, ...unicomItems]) {
        if (!item.url) continue;
        try {
          // Download CSV from the URL
          const csvRes = await fetch(item.url);
          if (!csvRes.ok) continue;
          const csvText = await csvRes.text();

          // Parse CSV (x,y per line) into local points
          const points = csvText.split('\n')
            .map((line: string) => line.trim())
            .filter((line: string) => line.length > 0)
            .map((line: string) => {
              const [x, y] = line.split(',').map(Number);
              return { x, y };
            })
            .filter((p: { x: number; y: number }) => !isNaN(p.x) && !isNaN(p.y));

          if (points.length < 3) continue;

          // Create map on our server
          const mapName = item.alias || item.fileName?.replace('.csv', '') || `Cloud map ${imported + 1}`;
          const mapType = item.type === 1 ? 'obstacle' : item.type === 2 ? 'unicom' : 'work';

          await fetch(`${serverUrl}/api/dashboard/maps/${encodeURIComponent(mower.sn)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mapName, mapArea: points, mapType }),
          });
          imported++;
        } catch { /* skip failed items */ }
      }

      if (imported > 0) {
        // Push to mower
        try {
          await fetch(`${serverUrl}/api/dashboard/maps/${encodeURIComponent(mower.sn)}/push-to-mower`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
        } catch { /* ignore push failure */ }

        appAlertCompat.alert(t('cloudImport'), t('hmCloudImportedCount', { count: imported }));
        fetchData();
      } else {
        appAlertCompat.alert(t('importFailed'), t('hmCloudImportNone'));
      }
    } catch (e) {
      appAlertCompat.alert(t('error'), e instanceof Error ? e.message : t('hmCloudImportFailed'));
    }
    setCloudImporting(false);
  };

  const handleImport = async () => {
    if (!mower?.sn) {
      appAlertCompat.alert(t('noMowerFound'), t('connectMower'));
      return;
    }

    // Demo mode: just show a success message and add a fake imported map
    if (demo.enabled) {
      appAlertCompat.alert(t('hmDemoMode'), t('hmDemoImportAdded'));
      setMaps((prev) => [
        ...prev,
        {
          mapId: `imported-demo-${Date.now()}`,
          mapName: 'Imported Garden',
          mapType: 'work',
          mapArea: [
            { x: -3, y: 2 }, { x: 1, y: 5 }, { x: 5, y: 4 },
            { x: 4, y: -1 }, { x: 0, y: -2 }, { x: -2, y: 0 },
          ],
        },
      ]);
      return;
    }

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/zip',
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.[0]) return;

      const file = result.assets[0];

      // Warn if maps already exist (prevent duplicate imports)
      if (maps.length > 0) {
        const confirmed = await new Promise<boolean>(resolve => {
          appAlertCompat.alert(
            t('mapsAlreadyExist'),
            t('mapsAlreadyExistMsg'),
            [
              { text: t('cancel'), style: 'cancel', onPress: () => resolve(false) },
              { text: t('import'), onPress: () => resolve(true) },
            ],
          );
        });
        if (!confirmed) return;
      }

      setImporting(true);

      // Read file as blob and convert to base64 via FileReader
      const response = await fetch(file.uri);
      const blob = await response.blob();
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result as string;
          resolve(dataUrl.split(',')[1]); // strip data:...;base64, prefix
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      const serverUrl = await getServerUrl();
      if (!serverUrl) return;

      const res = await fetch(`${serverUrl}/api/dashboard/maps/${encodeURIComponent(mower.sn)}/upload-zip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: base64 }),
      });

      const json = await res.json();
      if (json.ok) {
        // Ask user for map name after successful import
        Alert.prompt(
          t('nameThisMap'),
          `${json.imported} ${t('areasImported')}`,
          async (name) => {
            const mapName = name?.trim() || 'Garden';
            try {
              const api = new ApiClient(serverUrl);
              const freshMaps = await api.fetchMaps(mower.sn);
              for (const m of freshMaps.maps ?? []) {
                if (m.mapName?.startsWith('Uploaded map') && m.mapType === 'work') {
                  await fetch(`${serverUrl}/api/dashboard/maps/${encodeURIComponent(mower.sn)}/${encodeURIComponent(m.mapId)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mapName }),
                  });
                }
              }
            } catch { /* ignore */ }

            // Push maps to mower (same as dashboard autoPushMapsInBackground)
            try {
              await fetch(`${serverUrl}/api/dashboard/maps/${encodeURIComponent(mower.sn)}/push-to-mower`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              });
              console.log('[Map] Push to mower triggered');
            } catch { console.log('[Map] Push to mower failed (mower may be offline)'); }

            fetchData();
          },
          'plain-text',
          'Garden',
        );
        fetchData(); // refresh map
      } else {
        appAlertCompat.alert(t('importFailed'), json.error ?? t('hmUnknownError'));
      }
    } catch (e) {
      appAlertCompat.alert(t('error'), e instanceof Error ? e.message : t('hmImportFailedGeneric'));
    } finally {
      setImporting(false);
    }
  };

  const showImportOptions = useCallback(() => {
    appAlertCompat.alert(t('importMap'), undefined, [
      { text: t('fromFile'), onPress: handleImport },
      { text: t('fromCloud'), onPress: handleCloudImport },
      { text: t('cancel'), style: 'cancel' },
    ]);
  }, [handleCloudImport, handleImport, t]);

  const handleHeaderActionsMenu = useCallback(() => {
    setSheetState({
      visible: true,
      title: t('hmMapActions'),
      actions: [
        {
          label: t('import'),
          subtitle: t('hmMapActionsImportSub'),
          icon: 'cloud-upload-outline',
          onPress: showImportOptions,
        },
        {
          label: t('export'),
          subtitle: t('hmMapActionsExportSub'),
          icon: 'download-outline',
          disabled: maps.length === 0,
          onPress: handleExport,
        },
        {
          label: t('hmRefresh'),
          subtitle: t('hmMapActionsRefreshSub'),
          icon: 'refresh-outline',
          onPress: fetchData,
        },
      ],
    });
  }, [fetchData, handleExport, maps.length, showImportOptions, t]);

  // ── Compute bounds ───────────────────────────────────────────────
  // Trail is already in local meters from server (map_position_x/y based)
  const trailLocal: LocalPoint[] = useMemo(() => {
    if (trail.length === 0) return [];
    // Trail from server is [{x, y, ts}] — already local meters
    return trail.map(p => ({ x: (p as any).x ?? 0, y: (p as any).y ?? 0 }));
  }, [trail]);

  // Charger position. Stock heading-discovery shifts the mower's
  // localization origin away from the physical dock, so the polygon's
  // (0,0) is NOT where the dock is. The server captures the mower's
  // map_position whenever the mower reports being docked and exposes
  // it as dockPose; render the icon there. Fallback (0,0) if the
  // server has not yet seen the mower docked since startup.
  const chargerLocal: LocalPoint = mower?.dockPose
    ? { x: mower.dockPose.x, y: mower.dockPose.y }
    : { x: 0, y: 0 };

  const bounds = useMemo(() => {
    let b: LocalBounds | null = null;
    for (const m of visibleMaps) {
      if (m.mapType === 'unicom') continue;
      b = expandLocalBounds(b, computeLocalBounds(m.mapArea));
    }
    if (trailLocal.length > 0) b = expandLocalBounds(b, computeLocalBounds(trailLocal));
    if (mowerLocal) b = expandLocalBounds(b, computeLocalBounds([mowerLocal]));
    // Include charger only if no maps (otherwise charger at origin can inflate bounds)
    if (!b) b = expandLocalBounds(b, computeLocalBounds([chargerLocal]));
    if (b) {
      const xPad = (b.maxX - b.minX) * 0.08 || 0.5;
      const yPad = (b.maxY - b.minY) * 0.08 || 0.5;
      b = { minX: b.minX - xPad, maxX: b.maxX + xPad, minY: b.minY - yPad, maxY: b.maxY + yPad };
    }
    return b;
  }, [visibleMaps, trailLocal, mowerLocal]);

  /** The flat render as a rectangle on this canvas, or null when it cannot be
   *  placed (an iso render, or one made from a drone photo that may be rotated
   *  — that needs a homography, and an SVG image is a box). */
  const renderLayer = useMemo(() => {
    const box = renderFraming === 'flat' ? renderState?.framings.flat?.meta.localBox : null;
    if (baseView !== 'render' || !renderUrl || !box || !bounds) return null;
    const tl = localToSvg({ x: box.minX, y: box.maxY }, bounds, MAP_SIZE, INNER_PADDING);
    const br = localToSvg({ x: box.maxX, y: box.minY }, bounds, MAP_SIZE, INNER_PADDING);
    return { url: renderUrl, x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
  }, [baseView, renderFraming, renderUrl, renderState, bounds]);

  // Pattern placement: convert tap position to local meters, then to GPS for pattern context
  const handleMapTap = useCallback((evt: { nativeEvent: { locationX: number; locationY: number } }) => {
    if (!patternCtx.isPlacing || !bounds) return;
    const x = evt.nativeEvent.locationX;
    const y = evt.nativeEvent.locationY;
    const drawSize = MAP_SIZE - INNER_PADDING * 2;
    const xRange = bounds.maxX - bounds.minX || 0.1;
    const yRange = bounds.maxY - bounds.minY || 0.1;
    const mapScale = Math.min(drawSize / xRange, drawSize / yRange);
    const xOffset = (drawSize - xRange * mapScale) / 2;
    const yOffset = (drawSize - yRange * mapScale) / 2;
    // Inverse of localToSvg (no rotation, just Y flip).
    const localX = (x - INNER_PADDING - xOffset) / mapScale + bounds.minX;
    const localY = bounds.maxY - (y - INNER_PADDING - yOffset) / mapScale;
    // Convert to GPS if chargerGpsOrigin available, otherwise use local coords directly
    if (chargerGpsOrigin) {
      const metersPerDegreeLat = 111320;
      const metersPerDegreeLng = 111320 * Math.cos(chargerGpsOrigin.lat * Math.PI / 180);
      patternCtx.setCenter(
        chargerGpsOrigin.lat + localY / metersPerDegreeLat,
        chargerGpsOrigin.lng + localX / metersPerDegreeLng,
      );
    } else {
      // No GPS origin — use local meters as pseudo-GPS (pattern will render in local coords)
      patternCtx.setCenter(localY, localX);
    }
  }, [patternCtx, bounds, chargerGpsOrigin]);

  const handleTapGesture = (x: number, y: number) => {
    handleMapTap({ nativeEvent: { locationX: x, locationY: y } } as any);
  };

  const obstacleHitboxesRef = useRef<Array<{ map: MapData; pts: Array<{ x: number; y: number }> }>>([]);

  const pointInPolygonSvg = (x: number, y: number, pts: Array<{ x: number; y: number }>): boolean => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y;
      const xj = pts[j].x, yj = pts[j].y;
      const intersect = ((yi > y) !== (yj > y))
        && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  };

  const checkObstacleTap = (sx: number, sy: number, _rawX: number, _rawY: number) => {
    const hits = obstacleHitboxesRef.current;
    for (let i = hits.length - 1; i >= 0; i--) {
      if (pointInPolygonSvg(sx, sy, hits[i].pts)) {
        handleMapAction(hits[i].map);
        return;
      }
    }
  };

  useEffect(() => {
    if (!bounds) {
      obstacleHitboxesRef.current = [];
      return;
    }
    obstacleHitboxesRef.current = maps
      .filter(m => m.mapType === 'obstacle' && Array.isArray(m.mapArea) && m.mapArea.length >= 3)
      .map(m => ({
        map: m,
        pts: (m.mapArea as LocalPoint[]).map(p => localToSvg(p, bounds, MAP_SIZE, INNER_PADDING)),
      }));
  }, [maps, bounds]);

  const singleTapGesture = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd((e) => {
      'worklet';
      // RNGH geeft e.x/e.y in het layout-coord systeem van de Animated.View —
      // dat is vóór de transform — en dat is dezelfde ruimte waarin we de
      // SVG polygonen tekenen via localToSvg(). Dus directe hit-test: geen
      // inverse transform nodig (de gesture handler doet die al intern).
      // Bewezen via debug markers op 2026-04-20: groen bolletje (e.x,e.y)
      // landde op de vinger, gele kruis (c + (e.x-c)/s) zat naar center toe
      // geschoven — klassiek over-correctie pattern.
      if (patternCtx.isPlacing) {
        runOnJS(handleTapGesture)(e.x, e.y);
      } else {
        runOnJS(checkObstacleTap)(e.x, e.y, e.x, e.y);
      }
    });

  const composedGesture = Gesture.Simultaneous(pinchGesture, panGesture, doubleTapGesture, singleTapGesture);

  const hasData = visibleMaps.length > 0 || trailLocal.length > 0 || mowerLocal;
  const selectedAreaSqMeters = selectedWorkMap ? polygonAreaSqMeters(selectedWorkMap.mapArea) : 0;
  // Hero meta = the SELECTED zone's own obstacles + channels (either-endpoint),
  // same counter the per-zone card uses, so the two lines always agree.
  const { obstacles: relatedObstacleCount, channels: relatedChannelCount } =
    selectedWorkMap ? countZoneFeatures(selectedWorkMap, maps) : { obstacles: 0, channels: 0 };
  // Adjacent work-map pairs with no inter-zone unicom between them. The mower
  // can't drive between unconnected zones, so we surface a one-tap entry to
  // record the missing channel (the actual recording happens in MappingScreen).
  const missingChannels = useMemo(
    () => findMissingChannels(
      maps.map((m) => ({
        mapType: m.mapType,
        canonicalName: m.canonicalName,
        mapName: m.mapName,
        pointCount: m.mapArea?.length ?? 0,
      })),
    ),
    [maps],
  );

  return (
    <GestureHandlerRootView style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView style={styles.content} scrollEnabled={!show3d} contentContainerStyle={{ paddingBottom: Math.max(insets.bottom + 80, 96) }}>


        <View style={styles.header}>
          <Text style={styles.title}>{t('mapTitle')}</Text>
          <View style={styles.headerActions}>
            {!stockFw && (
              <TouchableOpacity
                onPress={() => setView3d(v => !v)}
                style={styles.toolbarMenuButton}
                activeOpacity={0.82}
                accessibilityLabel={view3d ? (t('map2dView')) : (t('map3dView'))}
              >
                <Ionicons name={view3d ? 'map-outline' : 'cube-outline'} size={16} color={colors.text} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={openBaseViewMenu}
              style={styles.toolbarMenuButton}
              activeOpacity={0.82}
              accessibilityLabel={t('baseViewTitle')}
            >
              {renderBusy
                ? <ActivityIndicator size="small" color={colors.text} />
                : <Ionicons name={baseView === 'render' ? 'cube' : 'layers-outline'} size={16} color={colors.text} />}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleHeaderActionsMenu}
              style={styles.toolbarMenuButton}
              activeOpacity={0.82}
              disabled={importing || cloudImporting}
            >
              {(importing || cloudImporting) ? (
                <ActivityIndicator size="small" color={colors.text} />
              ) : (
                <Ionicons name="ellipsis-horizontal" size={16} color={colors.text} />
              )}
            </TouchableOpacity>
            {selectedWorkMap && (
              <TouchableOpacity
                onPress={() => setSheetState({
                  visible: true,
                  title: t('editMap'),
                  actions: [
                    {
                      label: t('redrawBoundary'),
                      icon: 'navigate-outline',
                      onPress: () => gateThenNavigate({ buildType: 'modify' }),
                    },
                    {
                      label: t('advancedEdit'),
                      icon: 'create-outline',
                      onPress: () => (navigation as any).navigate('MapEdit', { sn: mower?.sn }),
                    },
                  ],
                })}
                style={styles.toolbarMenuButton}
                activeOpacity={0.82}
              >
                <Ionicons name="create-outline" size={16} color={colors.text} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              testID="map-create"
              onPress={() => gateThenNavigate()}
              style={styles.addButton}
              activeOpacity={0.7}
            >
              <Ionicons name="add" size={18} color={colors.white} />
            </TouchableOpacity>
          </View>
        </View>

        {missingChannels.length > 0 && !loading && (
          <TouchableOpacity
            onPress={() => gateThenNavigate({ buildType: 'unicom' })}
            activeOpacity={0.8}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              marginHorizontal: 16,
              marginTop: 8,
              padding: 12,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: '#3b82f6',
              backgroundColor: 'rgba(59,130,246,0.12)',
            }}
          >
            <Ionicons name="swap-horizontal" size={20} color="#3b82f6" />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13 }}>
                {t('channelMissingBanner')}
              </Text>
              <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 2 }}>
                {missingChannels.length === 1
                  ? t('channelMissingHint', {
                      from: missingChannels[0].from.replace('map', ''),
                      to: missingChannels[0].to.replace('map', ''),
                    })
                  : t('channelMissingHintMulti', { count: missingChannels.length })}
              </Text>
            </View>
            <Text style={{ color: '#3b82f6', fontWeight: '700', fontSize: 12 }}>{t('addChannel')}</Text>
          </TouchableOpacity>
        )}

        {loading && <ActivityIndicator size="small" color={colors.emerald} style={{ marginTop: 32 }} />}

        {!loading && !hasData && !bounds && (
          <View style={styles.emptyState}>
            <View style={styles.emptyIcon}>
              <Ionicons name="map-outline" size={48} color={colors.textMuted} />
            </View>
            <Text style={styles.emptyTitle}>{t('mapTitle')}</Text>
            <Text style={styles.emptySubtitle}>
              {connected ? t('noMaps') : t('connectingToServer')}
            </Text>
            <TouchableOpacity style={styles.importButton} onPress={handleImport} activeOpacity={0.7}>
              <Ionicons name="cloud-upload-outline" size={18} color={colors.white} />
              <Text style={styles.importButtonText}>{t('fromFile')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Render settings while it is on screen: two plain switches. */}
        {baseView === 'render' && renderState?.available && (
          <View style={styles.renderCtl}>
            <View style={styles.renderCtlRow}>
              <Text style={styles.renderCtlLabel}>{t('renderFraming')}</Text>
              <View style={styles.seg}>
                {(['flat', 'iso'] as const).map(f => (
                  <TouchableOpacity key={f} onPress={() => showRender(f)}
                    style={[styles.segBtn, renderFraming === f && styles.segBtnOn]}>
                    <Text style={[styles.segTxt, renderFraming === f && styles.segTxtOn, !renderState.framings[f] && styles.segTxtOff]}>
                      {f === 'flat' ? t('renderFlat') : t('renderIso')}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
            <View style={styles.renderCtlRow}>
              <Text style={styles.renderCtlLabel}>{t('renderLight')}</Text>
              <View style={styles.seg}>
                {(['auto', 'day', 'night'] as const).map(v => (
                  <TouchableOpacity key={v} onPress={() => setRenderLight(v)}
                    style={[styles.segBtn, renderLight === v && styles.segBtnOn]}>
                    <Text style={[styles.segTxt, renderLight === v && styles.segTxtOn]}>
                      {v === 'auto' ? t('renderAuto') : v === 'day' ? t('baseViewDay') : t('baseViewNight')}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>
        )}

        {/* New 3D render: one window with two plain choices. */}
        <Modal visible={makerOpen} transparent animationType="fade" onRequestClose={() => setMakerOpen(false)}>
          <View style={styles.makerBackdrop}>
            <View style={styles.makerCard}>
              <Text style={styles.makerTitle}>{t('renderNewTitle')}</Text>
              <Text style={styles.makerLabel}>{t('renderFraming')}</Text>
              <View style={styles.makerRow}>
                {(['flat', 'iso'] as const).map(f => (
                  <TouchableOpacity key={f} onPress={() => setMakerFraming(f)} style={[styles.makerChoice, makerFraming === f && styles.makerChoiceOn]}>
                    <Ionicons name={f === 'flat' ? 'navigate-outline' : 'cube-outline'} size={16} color={makerFraming === f ? colors.emerald : colors.textDim} />
                    <Text style={styles.makerChoiceTitle}>{f === 'flat' ? t('renderFlat') : t('renderIso')}</Text>
                    <Text style={styles.makerChoiceDesc}>{f === 'flat' ? t('renderFlatDesc') : t('renderIsoDesc')}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.makerLabel}>{t('renderSource')}</Text>
              <View style={styles.makerRow}>
                {(renderState?.hasDronePhoto ? (['aerial', 'drone'] as const) : (['aerial'] as const)).map(src => (
                  <TouchableOpacity key={src} onPress={() => setMakerSource(src)} style={[styles.makerChoice, makerSource === src && styles.makerChoiceOn]}>
                    <Ionicons name={src === 'aerial' ? 'earth-outline' : 'image-outline'} size={16} color={makerSource === src ? colors.emerald : colors.textDim} />
                    <Text style={styles.makerChoiceTitle}>{src === 'aerial' ? t('renderAerial') : t('renderDrone')}</Text>
                    <Text style={styles.makerChoiceDesc}>{src === 'aerial' ? t('renderAerialDesc') : t('renderDroneDesc')}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.makerNote}>{t('renderCostNote')}</Text>
              {renderState?.framings[makerFraming] && <Text style={styles.makerWarn}>{t('renderReplaceNote')}</Text>}
              <View style={styles.makerButtons}>
                <TouchableOpacity onPress={() => setMakerOpen(false)} style={[styles.makerBtn, styles.makerBtnCancel]}>
                  <Text style={styles.makerBtnCancelTxt}>{t('cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { setMakerOpen(false); void runRender(makerSource, makerFraming); }} style={[styles.makerBtn, styles.makerBtnOk]}>
                  <Text style={styles.makerBtnOkTxt}>{t('renderMake')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {renderBusy && (
          <View style={styles.renderBusyCard}>
            <ActivityIndicator size="small" color={colors.emerald} />
            <View style={{ flex: 1 }}>
              <Text style={styles.renderBusyTitle}>{t('baseViewRenderBusy')}</Text>
              <Text style={styles.renderBusySub}>{t('baseViewRenderWait')}</Text>
            </View>
          </View>
        )}

        {/* 3D garden render — a picture, not a map, so it replaces the map */}
        {baseView === 'render' && renderUrl && !renderLayer && (
          <View style={styles.renderCard}>
            <View>
              <RNImage source={{ uri: renderUrl }} style={styles.renderImage} resizeMode="contain" />
              {/* The angled render came from a camera we chose, so the ground
                  plane's place in it is known: mower and trail go through
                  that homography. Same viewBox and 'meet' fit as the image. */}
              {(() => {
                const tilt = shownRender?.meta.tilt;
                if (!tilt) return null;
                const toPx = (p: LocalPoint) => {
                  const h = tilt.localToRender;
                  const w = h[6] * p.x + h[7] * p.y + h[8];
                  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
                };
                const m = mowerLocal ? toPx(mowerLocal) : null;
                const nose = mowerLocal ? toPx({ x: mowerLocal.x + 0.9 * Math.cos(heading), y: mowerLocal.y + 0.9 * Math.sin(heading) }) : null;
                const dock = toPx(chargerLocal);
                const pts = (ps: LocalPoint[]) => ps.map(p => { const q = toPx(p); return `${q.x.toFixed(1)},${q.y.toFixed(1)}`; }).join(' ');
                return (
                  <Svg style={StyleSheet.absoluteFill} viewBox={`0 0 ${tilt.width} ${tilt.height}`} preserveAspectRatio="xMidYMid meet" pointerEvents="none">
                    {/* Planned mow path, same data and condition as the map: plan in blue, done in green. */}
                    {showCoverPath && plannedPaths.map(path => (
                      <Polyline key={`rp-${path.id}`} points={pts(path.points)} fill="none"
                        stroke={finishedAreaSet.has(path.id) ? 'rgba(34,197,94,0.85)' : 'rgba(96,165,250,0.9)'}
                        strokeWidth={finishedAreaSet.has(path.id) ? 5 : 2} strokeLinejoin="round" strokeLinecap="round" />
                    ))}
                    {trailLocal.length > 1 && (
                      <Polyline points={pts(trailLocal)}
                        fill="none" stroke="#38bdf8" strokeWidth={4} strokeOpacity={0.85} strokeLinejoin="round" strokeLinecap="round" />
                    )}
                    {/* Dock: orange charger pin with a bolt, standing on its spot. */}
                    <G transform={`translate(${dock.x} ${dock.y})`}>
                      <Path d="M0 0 L-9 -14 A14 14 0 1 1 9 -14 Z" fill="#f59e0b" stroke="#ffffff" strokeWidth={2.5} />
                      <Path d="M2 -33 L-5 -21 L0 -21 L-2 -12 L6 -25 L1 -25 Z" fill="#ffffff" />
                    </G>
                    {/* Mower: body pointing along its heading. */}
                    {m && nose && (
                      <G transform={`translate(${m.x} ${m.y}) rotate(${(Math.atan2(nose.y - m.y, nose.x - m.x) * 180) / Math.PI})`}>
                        <Rect x={-16} y={-11} width={32} height={22} rx={8} fill="#ffffff" stroke="#0f172a" strokeWidth={2.5} />
                        <Rect x={-4} y={-7} width={14} height={14} rx={3} fill="#10b981" />
                        <Path d="M16 -6 L25 0 L16 6 Z" fill="#0f172a" />
                      </G>
                    )}
                  </Svg>
                );
              })()}
            </View>
            <View style={styles.renderBadge}>
              <Ionicons name={renderVariant === 'night' ? 'moon-outline' : 'sunny-outline'} size={13} color={colors.textDim} />
              <Text style={styles.renderBadgeText}>
                {renderVariant === 'night' ? t('baseViewNight') : t('baseViewDay')}
                {shownRender ? ` · ${shownRender.meta.source === 'drone' ? t('baseViewRenderFromDrone') : shownRender.meta.attribution}` : ''}
                {shownRender?.stale ? ` · ${t('baseViewStale')}` : ''}
              </Text>
            </View>
          </View>
        )}

        {/* 3D terrain view */}
        {show3d && baseView !== 'render' && (
          <View style={{ height: 420 }}>
            <TerrainView3D sn={mower?.sn ?? ''} />
          </View>
        )}

        {/* SVG Map with pan + zoom */}
        {!show3d && (baseView !== 'render' || renderLayer) && bounds && (
          <View style={styles.mapExperience}>
            <View style={styles.mapContainer}>
              {selectedWorkMap && (
                <View pointerEvents="none" style={styles.mapHero}>
                  <View>
                    <Text style={styles.mapHeroEyebrow}>
                      {workMaps.length > 1 ? t('hmMapNofM', { n: selectedWorkIndex + 1, total: workMaps.length }) : t('hmActiveMap')}
                    </Text>
                    <Text style={styles.mapHeroTitle}>
                      {selectedWorkMap.mapName || t('hmZoneN', { n: selectedWorkIndex + 1 })}
                    </Text>
                    <Text style={styles.mapHeroMeta}>
                      {formatAreaLabel(selectedAreaSqMeters)}
                      {relatedObstacleCount > 0 ? ` · ${t(relatedObstacleCount === 1 ? 'hmObstacleCountOne' : 'hmObstacleCountOther', { count: relatedObstacleCount })}` : ''}
                      {relatedChannelCount > 0 ? ` · ${t(relatedChannelCount === 1 ? 'hmChannelCountOne' : 'hmChannelCountOther', { count: relatedChannelCount })}` : ''}
                    </Text>
                  </View>
                  {workMaps.length > 1 && (
                    <Text style={styles.mapHeroHint}>{t('hmSwipeBelow')}</Text>
                  )}
                </View>
              )}

              <GestureDetector gesture={composedGesture}>
                <Animated.View style={[styles.mapInner, animatedStyle]}>
                  <Svg width={MAP_SIZE} height={MAP_SIZE} viewBox={`0 0 ${MAP_SIZE} ${MAP_SIZE}`}>
                  {/* The 3D render, under everything else: it is the ground. */}
                  {renderLayer && (
                    <SvgImage
                      href={{ uri: renderLayer.url }}
                      x={renderLayer.x} y={renderLayer.y}
                      width={renderLayer.width} height={renderLayer.height}
                      preserveAspectRatio="none"
                    />
                  )}
                  {/* Grid */}
                  {Array.from({ length: 5 }, (_, i) => {
                    const pos = INNER_PADDING + ((MAP_SIZE - INNER_PADDING * 2) / 4) * i;
                    return (
                      <G key={`grid-${i}`}>
                        <Line x1={INNER_PADDING} y1={pos} x2={MAP_SIZE - INNER_PADDING} y2={pos} stroke="rgba(255,255,255,0.05)" strokeWidth={1} />
                        <Line x1={pos} y1={INNER_PADDING} x2={pos} y2={MAP_SIZE - INNER_PADDING} stroke="rgba(255,255,255,0.05)" strokeWidth={1} />
                      </G>
                    );
                  })}

                  {/* Polygon clip paths for coverage stripes. Must exist whenever
                      the stripes below render (which is on `isMowing`, regardless
                      of progress) — otherwise react-native-svg drops the missing
                      clipPath reference and the full-length stripes spill across
                      the whole screen, outside the mowing area. */}
                  {isMowing && (
                    <Defs>
                      {visibleMaps.filter((m) => m.mapType === 'work' && m.mapArea?.length >= 3).map((m) => {
                        const svgPts = m.mapArea.map((p) => localToSvg(p, bounds, MAP_SIZE, INNER_PADDING));
                        return (
                          <ClipPath key={`clip-${m.mapId}`} id={`clip-${m.mapId}`}>
                            <SvgPolygon points={svgPts.map((p) => `${p.x},${p.y}`).join(' ')} />
                          </ClipPath>
                        );
                      })}
                    </Defs>
                  )}

                  {/* Polygons — work first, then obstacles so red overlays stay visible
                      on top of the translucent green work fill. Unicoms are handled
                      separately below. */}
                  {[...visibleMaps]
                    .sort((a, b) => {
                      const order = (t: string) => (t === 'work' ? 0 : t === 'obstacle' ? 1 : 2);
                      return order(a.mapType) - order(b.mapType);
                    })
                    .map((m) => {
                    if (!m.mapArea || m.mapArea.length < 3) return null;
                    if (m.mapType === 'unicom') return null;
                    // Selected work map = green, other work maps = grey, obstacles = red
                    const isSelected = selectedWorkMap && m.mapId === selectedWorkMap.mapId;
                    const isUnselectedWork = m.mapType === 'work' && !isSelected;
                    // Unselected work zones are drawn dimmed. The dark-mode grey was
                    // hard-coded white-translucent, which vanished on the light-mode
                    // card (#98) — pick a dark grey-green in light mode instead.
                    const c = isUnselectedWork
                      ? (colorScheme === 'dark'
                          ? { fill: 'rgba(255,255,255,0.12)', stroke: 'rgba(255,255,255,0.4)' }
                          : { fill: 'rgba(60,80,60,0.14)', stroke: 'rgba(45,80,45,0.60)' })
                      : (MAP_COLORS[m.mapType] ?? MAP_COLORS.work);
                    const svgPts = m.mapArea.map((p) => localToSvg(p, bounds, MAP_SIZE, INNER_PADDING));
                    const pts = svgPts.map((p) => `${p.x},${p.y}`).join(' ');
                    // Obstacles are often tiny (sub-meter) against a large work polygon, so a
                    // thicker stroke keeps them legible at the default zoom level.
                    const strokeWidth = m.mapType === 'obstacle' ? 2.5 : isSelected ? 2 : 1.5;
                    // Obstacles tap-to-rename — matcht Novabot UX. Opent de
                    // zelfde action sheet die handleMapAction anders via de
                    // zone-carousel laat zien (Rename / Delete). We gebruiken
                    // Svg's onPress (react-native-svg) — werkt binnen onze
                    // GestureDetector zonder conflict met pinch/pan (die
                    // triggeren op 2 vingers / grote translatie).
                    const onObstaclePress = m.mapType === 'obstacle'
                      ? () => handleMapAction(m)
                      : undefined;
                    return (
                      <G key={m.mapId}>
                        <SvgPolygon
                          points={pts}
                          fill={c.fill}
                          stroke={c.stroke}
                          strokeWidth={strokeWidth}
                          strokeLinejoin="round"
                          onPress={onObstaclePress}
                        />
                        {/* Label: alleen tonen als de user een echte naam heeft
                            gekozen. De firmware genereert default namen volgens
                            patroon map{N}_{M}_obstacle (zie
                            generate_map_file_name in save_map service) —
                            die willen we verbergen omdat ze zero user value
                            toevoegen. User tikt dan gewoon op de polygon zelf
                            om te hernoemen. Zodra een echte naam gezet is
                            (via Rename sheet) toont hij het label. */}
                        {m.mapType === 'obstacle' && isCustomObstacleName(m.mapName) && (() => {
                          const cx = svgPts.reduce((s, p) => s + p.x, 0) / svgPts.length;
                          const cy = svgPts.reduce((s, p) => s + p.y, 0) / svgPts.length;
                          return (
                            <SvgText
                              x={cx}
                              y={cy}
                              fontSize={10}
                              fontWeight="700"
                              fill="rgba(255,255,255,0.92)"
                              stroke="rgba(0,0,0,0.5)"
                              strokeWidth={0.6}
                              textAnchor="middle"
                              alignmentBaseline="middle"
                              onPress={onObstaclePress}
                            >
                              {m.mapName}
                            </SvgText>
                          );
                        })()}
                        {/* Direction stripes — alleen als FALLBACK zolang het echte
                            coverage-pad (plannedPaths) nog niet geladen is. Zodra het
                            echte pad binnen is (refreshPlanPath tijdens maaien) tonen
                            we dat i.p.v. deze decoratieve strepen. */}
                        {isMowing && m.mapType === 'work' && plannedPaths.length === 0 && (
                          <G clipPath={`url(#clip-${m.mapId})`}>
                            {generateCoverageStripes(svgPts, pathDir, 100, 6).map((l, i) => (
                              <Line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="rgba(34,197,94,0.25)" strokeWidth={1.5} />
                            ))}
                          </G>
                        )}
                      </G>
                    );
                  })}

                  {/* Inter-zone unicom connectors (channels) — drawn as a line
                      over the polygons so the link between zones is visible. The
                      polygon loop above skips mapType==='unicom'. Charger
                      connectors (mapXtocharge) render dimmer + dashed since they
                      matter less to the user than map-to-map channels. */}
                  {visibleMaps
                    .filter((m) => m.mapType === 'unicom' && Array.isArray(m.mapArea) && m.mapArea.length >= 2)
                    .map((m) => {
                      const isCharger = isChargerUnicom(m);
                      const uSvgPts = m.mapArea.map((p) => localToSvg(p, bounds, MAP_SIZE, INNER_PADDING));
                      const ptsStr = uSvgPts.map((p) => `${p.x},${p.y}`).join(' ');
                      return (
                        <G key={m.mapId}>
                          {/* Wide invisible hit area so the thin line is easy to
                              tap. Inter-zone channels open the same rename/delete
                              sheet as obstacles (handleMapAction). The auto-managed
                              charger connector stays non-tappable so it can't be
                              deleted by accident (that would break docking). */}
                          {!isCharger && (
                            <Polyline
                              points={ptsStr}
                              fill="none"
                              stroke={MAP_COLORS.unicom.stroke}
                              strokeOpacity={0}
                              strokeWidth={18}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              onPress={() => handleMapAction(m)}
                            />
                          )}
                          <Polyline
                            points={ptsStr}
                            fill="none"
                            stroke={MAP_COLORS.unicom.stroke}
                            strokeWidth={isCharger ? 1.5 : 3}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeDasharray={isCharger ? '4 4' : undefined}
                            opacity={isCharger ? 0.5 : 0.95}
                            pointerEvents="none"
                          />
                        </G>
                      );
                    })}

                  {/* Planned mowing path — altijd zichtbaar (ook idle) zodat
                      je de preview lijntjes ziet. Gekleurd naar voortgang:
                      gedekt = emerald, bezig = stippel, nog te doen = dun wit.
                      Data komt uit plannedPathCache (mowing) of previewPathCache
                      (idle); ids matchen tegen finished_area uit de mower. */}
                  {/* Cover path lines (planned + finished sub-areas) only
                      while the mower is actually mowing — never during a
                      mapping session, where they obscure the trail being
                      drawn. */}
                  {showCoverPath && plannedPaths.length > 0 && (
                    <>
                      {/* Alle niet-voltooide sub-paths (incl. actieve) als
                          dunne witte hint-lijnen. De gedekte portie van het
                          actieve sub-path wordt hieronder in emerald overheen
                          getekend zodat je zowel het plan als de voortgang
                          tegelijk ziet. */}
                      {plannedPaths.filter(p => !finishedAreaSet.has(p.id)).map((path) => (
                        <Polyline
                          key={`plan-${path.id}`}
                          points={path.points.map((p) => localToSvg(p, bounds, MAP_SIZE, INNER_PADDING)).map((p) => `${p.x},${p.y}`).join(' ')}
                          fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
                        />
                      ))}
                      {plannedPaths.filter(p => finishedAreaSet.has(p.id)).map((path) => (
                        <Polyline
                          key={`done-${path.id}`}
                          points={path.points.map((p) => localToSvg(p, bounds, MAP_SIZE, INNER_PADDING)).map((p) => `${p.x},${p.y}`).join(' ')}
                          fill="none" stroke="rgba(34,197,94,0.85)" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round"
                        />
                      ))}
                      {activeAreaId && plannedPaths.filter(p => p.id === activeAreaId).map((path) => {
                        // Alleen gedekte portie van actieve sub-path tonen,
                        // zoals Novabot. Geen stippel/hint voor de toekomstige
                        // kant — mower icon komt vanzelf aan de frontier.
                        const splitAt = Math.max(0, Math.min(activeAreaPoints, path.points.length));
                        const done = path.points.slice(0, splitAt);
                        if (done.length < 2) return null;
                        const toStr = (pts: LocalPoint[]) =>
                          pts.map((p) => localToSvg(p, bounds, MAP_SIZE, INNER_PADDING)).map((p) => `${p.x},${p.y}`).join(' ');
                        return (
                          <Polyline
                            key={`active-${path.id}`}
                            points={toStr(done)}
                            fill="none" stroke="rgba(34,197,94,0.85)" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round"
                          />
                        );
                      })}
                    </>
                  )}

                  {/* Trail — visible while mowing AND while mapping. During
                      mapping the user must see what they're drawing
                      (work-area outline, obstacle perimeter, channel). */}
                  {showTrail && trailLocal.length > 1 && (
                    <Polyline
                      points={trailLocal.map((p) => localToSvg(p, bounds, MAP_SIZE, INNER_PADDING)).map((p) => `${p.x},${p.y}`).join(' ')}
                      fill="none" stroke="rgba(34,197,94,0.5)" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round"
                    />
                  )}

                  {/* Charger (always at origin 0,0) */}
                  {(() => {
                    const cp = localToSvg(chargerLocal, bounds, MAP_SIZE, INNER_PADDING);
                    return (
                      <G>
                        <Circle cx={cp.x} cy={cp.y} r={10} fill="rgba(245,158,11,0.2)" stroke="#f59e0b" strokeWidth={2} />
                        <Path d={`M${cp.x - 2.5} ${cp.y - 4} L${cp.x + 2.5} ${cp.y - 4} L${cp.x + 1} ${cp.y} L${cp.x + 3} ${cp.y} L${cp.x - 1} ${cp.y + 5} L${cp.x} ${cp.y + 1} L${cp.x - 2} ${cp.y + 1} Z`} fill="#f59e0b" />
                      </G>
                    );
                  })()}

                  {/* Mower icon + heading */}
                  {mowerLocal && (() => {
                    const mp = localToSvg(mowerLocal!, bounds, MAP_SIZE, INNER_PADDING);
                    // Icon points RIGHT at 0°. localToSvg inverts Y so heading
                    // rotation direction inverts — negate. Matches Novabot
                    // LiveMapView convention (`-(orientation * 180 / Math.PI)`).
                    const degHeading = -(heading * 180 / Math.PI);
                    const mowerSize = 20;
                    return (
                      <G transform={`translate(${mp.x}, ${mp.y}) rotate(${degHeading})`}>
                        <SvgImage
                          x={-mowerSize / 2}
                          y={-mowerSize * 0.35}
                          width={mowerSize}
                          height={mowerSize * 0.68}
                          href={require('../../assets/lawn_mower.png')}
                        />
                      </G>
                    );
                  })()}

                  {/* Pattern overlay (only during placement mode) */}
                  {patternCtx.isPlacing && patternCtx.placement?.center && patternCtx.placement.contours.length > 0 && bounds && chargerGpsOrigin && (() => {
                    const p = patternCtx.placement!;
                    const gpsPolys = p.contours.map(c => transformToGps(c, p.center!, p.sizeMeter, p.rotation));
                    // Convert GPS pattern points to local meters for rendering
                    return gpsPolys.map((poly, i) => {
                      const localPoly = poly.map(pt => gpsToLocal(pt, chargerGpsOrigin));
                      const svgPts = localPoly.map(pt => localToSvg(pt, bounds, MAP_SIZE, INNER_PADDING));
                      const pts = svgPts.map(pt => `${pt.x},${pt.y}`).join(' ');
                      return (
                        <SvgPolygon
                          key={`pattern-${i}`}
                          points={pts}
                          fill="rgba(168,85,247,0.2)"
                          stroke="#a855f7"
                          strokeWidth={2}
                          strokeDasharray="6 4"
                        />
                      );
                    });
                  })()}
                  </Svg>
                </Animated.View>
              </GestureDetector>

              {/* Recenter — same reset as double-tap, but findable. */}
              <TouchableOpacity
                style={styles.recenterBtn}
                onPress={resetView}
                accessibilityLabel={t('recenterMap')}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="scan-outline" size={18} color={colors.text} />
              </TouchableOpacity>

              {/* Zoom hint / placement hint */}
              {patternCtx.isPlacing ? (
                <Text style={[styles.zoomHint, { color: colors.purple }]}>
                  {patternCtx.placement?.center ? t('hmPatternRepositionHint') : t('hmPatternPlaceHint')}
                </Text>
              ) : (
                <Text style={styles.zoomHint}>{t('pinchToZoom')}</Text>
              )}
            </View>

            {selectedWorkMap && (
              <View style={styles.zonePanelShell}>
                      <ScrollView
                        ref={zoneCarouselRef}
                        horizontal
                        pagingEnabled
                        scrollEnabled={workMaps.length > 1}
                        showsHorizontalScrollIndicator={false}
                        onMomentumScrollEnd={(event) => {
                          const nextIndex = Math.round(event.nativeEvent.contentOffset.x / PANEL_PAGE_WIDTH);
                          const nextMap = workMaps[nextIndex];
                          if (nextMap && nextMap.mapId !== selectedZoneId) {
                            setSelectedZoneId(nextMap.mapId);
                          }
                        }}
                      >
                        {workMaps.map((map, index) => {
                          const areaSqMeters = polygonAreaSqMeters(map.mapArea);
                          const { obstacles: obstacleCount, channels: channelCount } = countZoneFeatures(map, maps);

                          return (
                            <View key={map.mapId} style={[styles.zonePanelPage, { width: PANEL_PAGE_WIDTH }]}>
                              <View style={styles.zonePanelCard}>
                                {/* Header: title + actions */}
                                <View style={styles.zonePanelHeader}>
                                  <View style={styles.zonePanelTitleWrap}>
                                    <Text style={styles.zonePanelTitle}>{map.mapName || t('hmZoneN', { n: index + 1 })}</Text>
                                  </View>
                                  <View style={styles.zonePanelActions}>
                                    <TouchableOpacity style={styles.zonePanelIconButton} onPress={() => handleMapAction(map)} activeOpacity={0.7}>
                                      <Ionicons name="create-outline" size={18} color={colors.text} />
                                    </TouchableOpacity>
                                    <TouchableOpacity style={styles.zonePanelIconButton} onPress={() => handleDeleteMap(map)} activeOpacity={0.7}>
                                      <Ionicons name="trash-outline" size={18} color={colors.text} />
                                    </TouchableOpacity>
                                  </View>
                                </View>

                                {/* Big tile metrics — Size + Est. mow as prominent cards.
                                    Restored from the older swipe-up panel design that read
                                    cleaner than the chip strip. Smaller indicator chips
                                    (obstacles/channels/charger/mower) sit underneath. */}
                                <View style={styles.zoneMetricRow}>
                                  <View style={styles.zoneMetricCard}>
                                    <Text style={styles.zoneMetricLabel}>{t('size')}</Text>
                                    <Text style={styles.zoneMetricValue}>{formatAreaLabel(areaSqMeters)}</Text>
                                  </View>
                                  <View style={styles.zoneMetricCard}>
                                    <Text style={styles.zoneMetricLabel}>{t('estMow')}</Text>
                                    <Text style={styles.zoneMetricValue}>{formatEtaLabel(areaSqMeters)}</Text>
                                  </View>
                                </View>

                                {/* Only show obstacle / channel chips when there's actually
                                    something to report — placeholder text ("Clean zone" /
                                    "Direct dock path") was clutter without a clear meaning.
                                    Charger / Mower legend lives in the map panel above. */}
                                {(obstacleCount > 0 || channelCount > 0) && (
                                  <View style={styles.zoneInfoRow}>
                                    {obstacleCount > 0 && (
                                      <View style={styles.zoneInfoChip}>
                                        <Ionicons name="scan-outline" size={12} color={colors.textDim} />
                                        <Text style={styles.zoneInfoText}>
                                          {t(obstacleCount === 1 ? 'hmObstacleCountOne' : 'hmObstacleCountOther', { count: obstacleCount })}
                                        </Text>
                                      </View>
                                    )}
                                    {channelCount > 0 && (
                                      <View style={styles.zoneInfoChip}>
                                        <Ionicons name="git-branch-outline" size={12} color={colors.textDim} />
                                        <Text style={styles.zoneInfoText}>
                                          {t(channelCount === 1 ? 'hmChannelCountOne' : 'hmChannelCountOther', { count: channelCount })}
                                        </Text>
                                      </View>
                                    )}
                                  </View>
                                )}

                                {/* Action buttons. De Start-knop wordt alleen uitgeschakeld
                                    wanneer we zeker weten dat starten zinloos is:
                                    - offline
                                    - blokkerende error (niet-soft, niet dock-failed)
                                    - ACTIEF aan het maaien / terug-rijden / kaart maken
                                    Bij een soft warning (bv. dock-failed) moet de user
                                    die eerst oplossen via de banner; dat is 'n aparte flow
                                    maar blokkeert de knop met 'Dock failed — fix first'.
                                    Zonder task_mode===1 alleen: de taak kan geregistreerd
                                    staan maar in Work:WAIT / FINISHED hangen — dat is
                                    "klaar", niet "al aan het maaien". */}
                                {(() => {
                                  const rechargeStatus = parseInt(mower?.sensors.recharge_status ?? '0', 10);
                                  const errorStatusRaw = parseInt(mower?.sensors.error_status?.match(/\d+/)?.[0] ?? '0', 10);
                                  const NON_BLOCKING = [8, 113, 120, 122, 123, 125, 126, 132, 139];
                                  const hasHardError = errorStatusRaw > 0 && !NON_BLOCKING.includes(errorStatusRaw);
                                  const dockFailed = msg.includes('Recharge: FAILED');
                                  const dockGoing = msg.includes('Recharge: GOING')
                                    || msg.includes('Work:GO_PILE') || msg.includes('Work:BACK_CHARGER')
                                    || msg.includes('Work:DOCKING')
                                    || (rechargeStatus === 1 && !dockFailed);
                                  // isMapping must reflect ACTIVE mapping work — not just the
                                  // post-mapping echo "Mode:MAPPING Work:FINISHED" the firmware
                                  // briefly broadcasts after Stop & Save. Use the work-state
                                  // pattern (USER_MAP / ASSISTANT_MAP) and the non-zero
                                  // start-flag bitmask (firmware reports 16, not 1).
                                  const mapFlagRaw = mower?.sensors.start_edit_or_assistant_map_flag ?? '0';
                                  // Trust task_mode + Mode:MAPPING substring only — same heuristic
                                  // as the top-level `isMapping` (line 357). The
                                  // start_edit_or_assistant_map_flag bit + the Work:USER_MAP
                                  // substring are both sticky in the firmware cache after a
                                  // failed save, so they linger long after the mower has
                                  // returned to idle and trigger a phantom 'Mapping in
                                  // progress' on the Start button.
                                  const taskModeForBtn = mower?.sensors.task_mode ?? '0';
                                  const isMapping = (taskModeForBtn === '3' || msg.includes('Mode:MAPPING'))
                                    && !msg.includes('Work:FINISHED')
                                    && !msg.includes('Work:WAIT');
                                  // Firmware zet Work:USER_STOP bij pause via app — zie HomeScreen comment.
                                  const isPaused = msg.includes('Work:PAUSED') || msg.includes('Work:USER_STOP');

                                  let disabledLabel: string | null = null;
                                  if (!mower?.online) disabledLabel = t('mowerOffline');
                                  else if (hasHardError) disabledLabel = t('clearErrorFirst');
                                  else if (dockFailed) disabledLabel = t('dockReturnFailed');
                                  else if (isMowing) disabledLabel = t('alreadyMowing');
                                  else if (isMapping) disabledLabel = t('mappingInProgress');
                                  else if (isPaused) disabledLabel = t('paused');
                                  else if (dockGoing) disabledLabel = t('dockReturnInProgress');
                                  const startDisabled = disabledLabel !== null;
                                  const primaryLabel = disabledLabel ?? (isInterruptedCoverage ? t('resume') : t('startMowing'));
                                  return (
                                    <View style={styles.zoneButtonRow}>
                                      <TouchableOpacity
                                        style={[
                                          styles.zoneActionButton,
                                          styles.zoneActionPrimary,
                                          startDisabled && styles.zoneActionDisabled,
                                        ]}
                                        onPress={() => {
                                          if (startDisabled) return;
                                          // Resume goes through Home: it owns the
                                          // rain check and the long-pause warning.
                                          (navigation as any).navigate('Home', isInterruptedCoverage
                                            ? { resumeCoverage: true }
                                            : { openStartMow: true, preselectedMapId: map.mapId });
                                        }}
                                        disabled={startDisabled}
                                        activeOpacity={0.8}
                                      >
                                        <Ionicons
                                          name="play-outline"
                                          size={16}
                                          color={startDisabled ? colors.textMuted : colors.white}
                                        />
                                        <Text
                                          style={[
                                            styles.zoneActionPrimaryText,
                                            startDisabled && { color: colors.textMuted },
                                          ]}
                                        >
                                          {primaryLabel}
                                        </Text>
                                      </TouchableOpacity>
                                      <TouchableOpacity
                                        style={styles.zoneActionButton}
                                        onPress={() => (navigation as any).navigate('Schedules', {
                                          openEditor: true,
                                          preselectedMapId: map.mapId,
                                          preselectedMapName: map.mapName ?? null,
                                        })}
                                        activeOpacity={0.8}
                                      >
                                        <Ionicons name="time-outline" size={16} color={colors.text} />
                                        <Text style={styles.zoneActionText}>{t('schedule')}</Text>
                                      </TouchableOpacity>
                                    </View>
                                  );
                                })()}
                              </View>
                            </View>
                          );
                        })}
                      </ScrollView>

                {workMaps.length > 1 && (
                  <View style={styles.zonePagerWrap}>
                    <Text style={styles.zonePagerLabel}>
                      {t('hmZonePager', { n: selectedWorkIndex + 1, total: workMaps.length })}
                    </Text>
                    <View style={styles.zonePagerDots}>
                      {workMaps.map((map, index) => (
                        <TouchableOpacity
                          key={map.mapId}
                          style={[
                            styles.zonePagerDot,
                            index === selectedWorkIndex && styles.zonePagerDotActive,
                          ]}
                          onPress={() => setSelectedZoneId(map.mapId)}
                          activeOpacity={0.8}
                        />
                      ))}
                    </View>
                  </View>
                )}
              </View>
            )}
          </View>
        )}

        {/* Pattern placement controls */}
        {patternCtx.isPlacing && patternCtx.placement && (
          <View style={{
            backgroundColor: 'rgba(168,85,247,0.1)', borderRadius: 12, padding: 12,
            borderWidth: 1, borderColor: 'rgba(168,85,247,0.3)', gap: 12,
          }}>
            <Text style={{ color: colors.purple, fontWeight: '700', fontSize: 14 }}>
              {t('hmPatternStatus', { id: patternCtx.placement.patternId, state: patternCtx.placement.center ? t('hmPatternPlaced') : t('hmPatternTapToPlace') })}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>{t('size')}:</Text>
              <TouchableOpacity
                style={{ padding: 6, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 6 }}
                onPress={() => patternCtx.setSize(Math.max(1, patternCtx.placement!.sizeMeter - 1))}
              >
                <Ionicons name="remove" size={16} color={colors.white} />
              </TouchableOpacity>
              <Text style={{ color: colors.white, fontWeight: '700', fontSize: 16, width: 50, textAlign: 'center' }}>
                {patternCtx.placement.sizeMeter}m
              </Text>
              <TouchableOpacity
                style={{ padding: 6, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 6 }}
                onPress={() => patternCtx.setSize(Math.min(100, patternCtx.placement!.sizeMeter + 1))}
              >
                <Ionicons name="add" size={16} color={colors.white} />
              </TouchableOpacity>

              <Text style={{ color: colors.textMuted, fontSize: 12, marginLeft: 12 }}>{t('hmRotation')}:</Text>
              <TouchableOpacity
                style={{ padding: 6, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 6 }}
                onPress={() => patternCtx.setRotation((patternCtx.placement!.rotation + 345) % 360)}
              >
                <Ionicons name="return-up-back" size={16} color={colors.white} />
              </TouchableOpacity>
              <Text style={{ color: colors.white, fontWeight: '700', fontSize: 14 }}>
                {patternCtx.placement.rotation}°
              </Text>
              <TouchableOpacity
                style={{ padding: 6, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 6 }}
                onPress={() => patternCtx.setRotation((patternCtx.placement!.rotation + 15) % 360)}
              >
                <Ionicons name="return-up-forward" size={16} color={colors.white} />
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                style={{ flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center' }}
                onPress={patternCtx.cancelPlacement}
              >
                <Text style={{ color: colors.textMuted, fontWeight: '600' }}>{t('cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{
                  flex: 2, paddingVertical: 10, borderRadius: 10, alignItems: 'center',
                  backgroundColor: patternCtx.placement.center ? colors.purple : 'rgba(168,85,247,0.3)',
                }}
                onPress={() => {
                  if (patternCtx.placement?.center) {
                    patternCtx.confirmPlacement();
                    // Go back to Home to open StartMowSheet
                    (navigation as any).navigate('Home');
                  }
                }}
                disabled={!patternCtx.placement.center}
              >
                <Text style={{ color: colors.white, fontWeight: '700' }}>
                  {patternCtx.placement.center ? t('confirm') : t('tapToPlacePattern')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}


        {/* Status chips */}
        {mower && (
          <View style={styles.statusRow}>
            {mowerLocal && (
              <View style={styles.chip}>
                <Ionicons name="location" size={14} color={colors.emerald} />
                <Text style={styles.chipText}>{mowerLocal.x.toFixed(1)}, {mowerLocal.y.toFixed(1)} m</Text>
              </View>
            )}
            {mower.sensors.map_position_orientation && (
              <View style={styles.chip}>
                <Ionicons name="compass" size={14} color={colors.textDim} />
                <Text style={styles.chipText}>{Math.round(heading * 180 / Math.PI)}°</Text>
              </View>
            )}
            {mower.sensors.loc_quality && (
              <View style={styles.chip}>
                <Ionicons name="navigate" size={14} color={colors.textDim} />
                <Text style={styles.chipText}>{t('hmLocQuality', { pct: mower.sensors.loc_quality })}</Text>
              </View>
            )}
            {isMowing && covRatio > 0 && (
              <View style={[styles.chip, { backgroundColor: 'rgba(34,197,94,0.15)' }]}>
                <Ionicons name="checkmark-circle" size={14} color={colors.emerald} />
                <Text style={[styles.chipText, { color: colors.emerald }]}>{t('hmPercentDone', { pct: Math.round(covRatio) })}</Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>

      <Modal visible={actionsMenuVisible} transparent animationType="fade" onRequestClose={() => setActionsMenuVisible(false)}>
        <View style={styles.actionsSheetOverlay}>
          <TouchableOpacity style={styles.actionsSheetBackdrop} activeOpacity={1} onPress={() => setActionsMenuVisible(false)} />
          <View style={styles.actionsSheet}>
            <View style={styles.actionsSheetHandle} />
            <Text style={styles.actionsSheetTitle}>{t('hmMapActions')}</Text>

            <TouchableOpacity
              style={styles.actionsSheetItem}
              onPress={() => runFromActionsMenu(showImportOptions)}
              activeOpacity={0.82}
            >
              <View style={styles.actionsSheetIconWrap}>
                <Ionicons name="cloud-upload-outline" size={18} color={colors.white} />
              </View>
              <View style={styles.actionsSheetTextWrap}>
                <Text style={styles.actionsSheetItemTitle}>{t('import')}</Text>
                <Text style={styles.actionsSheetItemSub}>{t('hmMapActionsImportSub')}</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionsSheetItem, maps.length === 0 && styles.actionsSheetItemDisabled]}
              onPress={() => maps.length > 0 && runFromActionsMenu(handleExport)}
              activeOpacity={0.82}
              disabled={maps.length === 0}
            >
              <View style={[styles.actionsSheetIconWrap, maps.length === 0 && styles.actionsSheetIconWrapDisabled]}>
                <Ionicons name="download-outline" size={18} color={maps.length > 0 ? colors.white : colors.textMuted} />
              </View>
              <View style={styles.actionsSheetTextWrap}>
                <Text style={[styles.actionsSheetItemTitle, maps.length === 0 && styles.actionsSheetItemTitleDisabled]}>{t('export')}</Text>
                <Text style={styles.actionsSheetItemSub}>{t('hmMapActionsExportSub')}</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionsSheetItem}
              onPress={() => runFromActionsMenu(fetchData)}
              activeOpacity={0.82}
            >
              <View style={styles.actionsSheetIconWrap}>
                <Ionicons name="refresh-outline" size={18} color={colors.white} />
              </View>
              <View style={styles.actionsSheetTextWrap}>
                <Text style={styles.actionsSheetItemTitle}>{t('hmRefresh')}</Text>
                <Text style={styles.actionsSheetItemSub}>{t('hmMapActionsRefreshSub')}</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionsSheetCancel}
              onPress={() => setActionsMenuVisible(false)}
              activeOpacity={0.82}
            >
              <Text style={styles.actionsSheetCancelText}>{t('cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <AppActionSheet
        visible={sheetState.visible}
        title={sheetState.title}
        message={sheetState.message}
        actions={sheetState.actions}
        onClose={() => setSheetState(prev => ({ ...prev, visible: false }))}
      />
    </GestureHandlerRootView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  content: { flex: 1, padding: MAP_PADDING },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  title: { fontSize: 22, fontWeight: '700', color: c.text },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  addButton: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: c.emerald,
    alignItems: 'center', justifyContent: 'center',
  },
  toolbarMenuButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.cardBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyState: { alignItems: 'center', paddingVertical: 60 },
  emptyIcon: {
    width: 96, height: 96, borderRadius: 48,
    backgroundColor: 'rgba(0,212,170,0.1)',
    alignItems: 'center', justifyContent: 'center', marginBottom: 24,
  },
  emptyTitle: { fontSize: 22, fontWeight: '700', color: c.text, marginBottom: 8 },
  emptySubtitle: { fontSize: 15, color: c.textDim, textAlign: 'center', marginBottom: 20 },
  importButton: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 20, paddingVertical: 12,
    backgroundColor: c.emerald, borderRadius: 12,
  },
  importButtonText: { fontSize: 15, fontWeight: '600', color: c.white },
  renderCtl: {
    backgroundColor: c.card, borderRadius: 14, borderWidth: 1, borderColor: c.cardBorder,
    padding: 10, marginBottom: 12, gap: 8,
  },
  renderCtlRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  renderCtlLabel: { width: 64, fontSize: 12, color: c.textDim },
  seg: { flex: 1, flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: 10, padding: 3, gap: 3 },
  segBtn: { flex: 1, paddingVertical: 6, borderRadius: 8, alignItems: 'center' },
  segBtnOn: { backgroundColor: '#059669' },
  segTxt: { fontSize: 12, fontWeight: '600', color: c.text },
  segTxtOn: { color: '#ffffff' },
  segTxtOff: { opacity: 0.4 },
  makerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 20 },
  makerCard: { backgroundColor: c.card, borderRadius: 20, borderWidth: 1, borderColor: c.cardBorder, padding: 20 },
  makerTitle: { fontSize: 18, fontWeight: '700', color: c.text, marginBottom: 14 },
  makerLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', color: c.textDim, marginBottom: 8 },
  makerRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  makerChoice: {
    flex: 1, borderRadius: 12, borderWidth: 1, borderColor: c.cardBorder, padding: 10, gap: 4,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  makerChoiceOn: { borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)' },
  makerChoiceTitle: { fontSize: 14, fontWeight: '700', color: c.text },
  makerChoiceDesc: { fontSize: 11, color: c.textDim, lineHeight: 15 },
  makerNote: { fontSize: 12, color: c.textDim, lineHeight: 17 },
  makerWarn: { fontSize: 12, color: '#f59e0b', marginTop: 4 },
  makerButtons: { flexDirection: 'row', gap: 10, marginTop: 18 },
  makerBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
  makerBtnCancel: { backgroundColor: 'rgba(255,255,255,0.08)' },
  makerBtnCancelTxt: { color: c.text, fontWeight: '600' },
  makerBtnOk: { backgroundColor: '#059669' },
  makerBtnOkTxt: { color: '#ffffff', fontWeight: '700' },
  renderBusyCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: c.card, borderRadius: 16, borderWidth: 1, borderColor: c.cardBorder,
    padding: 14, marginBottom: 16,
  },
  renderBusyTitle: { fontSize: 14, fontWeight: '600', color: c.text },
  renderBusySub: { fontSize: 12, color: c.textDim, marginTop: 2 },
  renderCard: {
    backgroundColor: c.card, borderRadius: 18, borderWidth: 1, borderColor: c.cardBorder,
    overflow: 'hidden', marginBottom: 16,
  },
  renderImage: { width: '100%', aspectRatio: 1.5, backgroundColor: '#0b0f14' },
  renderBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  renderBadgeText: { fontSize: 12, color: c.textDim },
  mapExperience: { marginTop: 4, marginBottom: 12 },
  mapContainer: {
    backgroundColor: c.card,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: c.cardBorder,
    overflow: 'hidden',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.24,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 14 },
    elevation: 10,
  },
  mapInner: { width: MAP_SIZE, height: MAP_SIZE },
  recenterBtn: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    zIndex: 5,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.cardBorder,
  },
  mapHero: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    zIndex: 5,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  mapHeroEyebrow: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: c.textMuted,
    marginBottom: 4,
  },
  mapHeroTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: c.text,
  },
  mapHeroMeta: {
    marginTop: 4,
    fontSize: 12,
    color: c.textDim,
    fontWeight: '600',
  },
  mapHeroHint: {
    fontSize: 12,
    fontWeight: '700',
    color: c.white,
    backgroundColor: 'rgba(3,7,18,0.68)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    overflow: 'hidden',
  },
  zoomHint: { fontSize: 11, color: c.textMuted, textAlign: 'center', paddingVertical: 8 },
  zonePanelShell: {
    marginTop: 12,
  },
  zonePanelPage: {
    paddingHorizontal: 2,
  },
  zonePanelCard: {
    backgroundColor: c.card,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    borderWidth: 1,
    borderColor: c.cardBorder,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  zoneDragHandleWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 8,
  },
  zoneDragHandle: {
    width: 54,
    height: 6,
    borderRadius: 999,
    backgroundColor: c.cardBorder,
    marginBottom: 8,
  },
  zoneDragLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: c.textMuted,
  },
  zonePanelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  zonePanelTitleWrap: { flex: 1 },
  zonePanelTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: c.text,
  },
  zonePanelActions: {
    flexDirection: 'row',
    gap: 10,
  },
  zonePanelIconButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.cardBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoneMetricRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },
  zoneMetricCard: {
    flex: 1,
    backgroundColor: c.inputBg,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: c.cardBorder,
  },
  zoneMetricLabel: {
    fontSize: 11,
    color: c.textDim,
    fontWeight: '700',
    marginBottom: 2,
  },
  zoneMetricValue: {
    fontSize: 16,
    fontWeight: '800',
    color: c.text,
    fontVariant: ['tabular-nums'],
  },
  zoneInfoRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 12,
  },
  zoneInfoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  zoneInfoText: {
    fontSize: 11,
    fontWeight: '700',
    color: c.text,
  },
  zoneButtonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },
  zoneActionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.cardBorder,
  },
  zoneActionPrimary: {
    backgroundColor: c.emerald,
    borderWidth: 0,
  },
  zoneActionDisabled: {
    backgroundColor: c.inputBg,
    opacity: 0.5,
  },
  zoneActionText: {
    fontSize: 14,
    fontWeight: '700',
    color: c.text,
  },
  zoneActionPrimaryText: {
    fontSize: 14,
    fontWeight: '700',
    color: c.white,
  },
  zonePagerWrap: {
    alignItems: 'center',
    marginTop: 12,
    gap: 6,
  },
  zonePagerLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: c.textMuted,
  },
  zonePagerDots: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  zonePagerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  zonePagerDotActive: {
    width: 20,
    backgroundColor: c.emerald,
  },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 12, paddingHorizontal: 4 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: 12, color: c.textDim },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 6,
    backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 12,
  },
  chipText: { fontSize: 12, color: c.textDim, fontVariant: ['tabular-nums'] },
  actionsSheetOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  actionsSheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  actionsSheet: {
    backgroundColor: c.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 22,
    borderTopWidth: 1,
    borderColor: c.cardBorder,
  },
  actionsSheetHandle: {
    width: 52,
    height: 5,
    borderRadius: 999,
    alignSelf: 'center',
    backgroundColor: c.cardBorder,
    marginBottom: 12,
  },
  actionsSheetTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: c.text,
    marginBottom: 14,
  },
  actionsSheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    marginBottom: 10,
  },
  actionsSheetItemDisabled: {
    opacity: 0.45,
  },
  actionsSheetIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  actionsSheetIconWrapDisabled: {
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  actionsSheetTextWrap: {
    flex: 1,
  },
  actionsSheetItemTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: c.white,
  },
  actionsSheetItemTitleDisabled: {
    color: c.textMuted,
  },
  actionsSheetItemSub: {
    marginTop: 2,
    fontSize: 12,
    color: c.textDim,
  },
  actionsSheetCancel: {
    marginTop: 6,
    paddingVertical: 14,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  actionsSheetCancelText: {
    fontSize: 15,
    fontWeight: '700',
    color: c.white,
  },
});
