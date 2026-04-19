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
} from 'react-native';
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
  Image as SvgImage,
} from 'react-native-svg';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { colors } from '../theme/colors';
import { useMowerState } from '../hooks/useMowerState';
import { ApiClient, type MapData, type TrailPoint, type LocalPoint, type ChargerGps } from '../services/api';
import { getServerUrl } from '../services/auth';
import { DemoBanner } from '../components/DemoBanner';
import { AppActionSheet, type AppActionSheetItem } from '../components/AppActionSheet';
import { useDemo } from '../context/DemoContext';
import { usePattern } from '../context/PatternContext';
import { contourToSvgPath, transformToGps } from '../utils/patternUtils';
import { useI18n } from '../i18n';
import { Linking } from 'react-native';

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
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
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
 *  Both axes flipped to match real-world bird's-eye view. */
function localToSvg(point: LocalPoint, bounds: LocalBounds, size: number, padding: number) {
  const drawSize = size - padding * 2;
  const xRange = bounds.maxX - bounds.minX || 0.1;
  const yRange = bounds.maxY - bounds.minY || 0.1;
  const scale = Math.min(drawSize / xRange, drawSize / yRange);
  const x = padding + (bounds.maxX - point.x) * scale + (drawSize - xRange * scale) / 2;
  const y = padding + (point.y - bounds.minY) * scale + (drawSize - yRange * scale) / 2;
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

  // Stripes run ALONG the path direction, spacing perpendicular
  // localToSvg flips both axes, so add 180° to compensate
  const rad = ((direction + 180) * Math.PI) / 180;
  const perpRad = ((direction + 270) * Math.PI) / 180;
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
  const [maps, setMaps] = useState<MapData[]>([]);
  const [chargerGpsOrigin, setChargerGpsOrigin] = useState<ChargerGps | null>(null);
  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const [plannedPaths, setPlannedPaths] = useState<Array<{ id: string; points: LocalPoint[] }>>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [actionsMenuVisible, setActionsMenuVisible] = useState(false);
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

  // ── Polygon edit mode ─────────────────────────────────────────────
  // User taps pencil → enters edit mode on selectedWorkMap.
  //   Tap on a polygon vertex → add to anchors (max 2).
  //   With 2 anchors → segment between is "active". Drag the handle at its
  //   midpoint to translate all vertices in the segment. Live cm indicator.
  //   Save → PATCH server → auto-push to mower → refresh.
  const [editMode, setEditMode] = useState(false);
  const [editMapId, setEditMapId] = useState<string | null>(null);
  const [editVertices, setEditVertices] = useState<LocalPoint[] | null>(null);
  const [editAnchors, setEditAnchors] = useState<number[]>([]); // vertex indices
  const [editDragOffset, setEditDragOffset] = useState({ dx: 0, dy: 0 }); // meters
  const editDragStartRef = useRef({ dx: 0, dy: 0 });
  const [editSaving, setEditSaving] = useState(false);

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
  const legendMaps = useMemo(
    () => visibleMaps.filter((map) => map.mapId !== selectedWorkMap?.mapId),
    [selectedWorkMap, visibleMaps],
  );

  const mower = useMemo(() => [...devices.values()].find((d) => d.deviceType === 'mower') ?? null, [devices]);

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
  const isMowing = msg.includes('Work:RUNNING') || msg.includes('Work:NAVIGATING') || msg.includes('Work:COVERING') || msg.includes('Work:MOVING');
  const covRatioRaw = parseFloat(mower?.sensors.cov_ratio ?? '0') || 0;
  const covRatio = covRatioRaw <= 1 ? Math.round(covRatioRaw * 100) : Math.round(covRatioRaw);
  const mowingProgress = parseInt(mower?.sensors.mowing_progress ?? '0', 10) || 0;
  const pathDir = parseInt(mower?.sensors.path_direction ?? '0', 10) || 0;

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
      const [mapsRes, trailRes, pathsRes] = await Promise.all([
        api.fetchMaps(sn).catch(() => ({ maps: [], chargerGps: null })),
        api.getTrail(sn).catch(() => []),
        api.getPlannedPath(sn).catch(() => []),
      ]);
      setMaps(mapsRes.maps ?? []);
      setChargerGpsOrigin(mapsRes.chargerGps ?? null);
      setTrail(Array.isArray(trailRes) ? trailRes : (trailRes as any).trail ?? []);
      setPlannedPaths(Array.isArray(pathsRes) ? pathsRes : []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [mower?.sn, demo.enabled]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useFocusEffect(
    useCallback(() => {
      fetchData();
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

  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
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
      Alert.alert('Demo Mode', 'Export is not available in demo mode.');
      return;
    }

    try {
      const serverUrl = await getServerUrl();
      if (!serverUrl) return;
      const downloadUrl = `${serverUrl}/api/dashboard/maps/${encodeURIComponent(mower.sn)}/download-zip`;
      await Linking.openURL(downloadUrl);
    } catch (e) {
      Alert.alert(t('error'), e instanceof Error ? e.message : 'Export failed');
    }
  };

  // ── Import ZIP ───────────────────────────────────────────────────
  const handleDeleteMap = useCallback((map: MapData) => {
    setSheetState({
      visible: true,
      title: t('deleteMap'),
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
              await fetch(`${url}/api/dashboard/maps/${encodeURIComponent(mower.sn)}/${encodeURIComponent(map.mapId)}`, {
                method: 'DELETE',
              });
              fetchData();
            } catch {
              Alert.alert(t('error'), 'Delete failed');
            }
          },
        },
      ],
    });
  }, [fetchData, mower, t]);

  const handleMapAction = (map: MapData) => {
    const typeLabel = map.mapType === 'obstacle' ? (t('obstacle') || 'Obstacle')
      : map.mapType === 'unicom' ? (t('channel') || 'Channel')
      : (t('map') || 'Map');
    const renameLabel = `${t('rename') || 'Rename'} ${typeLabel}`;
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
                } catch { Alert.alert(t('error'), 'Rename failed'); }
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
        Alert.alert(t('error'), 'Not authenticated');
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
        Alert.alert(t('cloudImport'), t('noCloudMaps'));
        setCloudImporting(false);
        return;
      }

      // data = { work: [MapEntityItem, ...], unicom: [...] }
      const workItems = data.work ?? [];
      const unicomItems = data.unicom ?? [];

      if (workItems.length === 0 && unicomItems.length === 0) {
        Alert.alert(t('cloudImport'), t('noCloudMaps'));
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

        Alert.alert(t('cloudImport'), `${imported} map(s) imported from cloud.`);
        fetchData();
      } else {
        Alert.alert(t('importFailed'), 'Could not import any maps from cloud data.');
      }
    } catch (e) {
      Alert.alert(t('error'), e instanceof Error ? e.message : 'Cloud import failed');
    }
    setCloudImporting(false);
  };

  const handleImport = async () => {
    if (!mower?.sn) {
      Alert.alert(t('noMowerFound'), t('connectMower'));
      return;
    }

    // Demo mode: just show a success message and add a fake imported map
    if (demo.enabled) {
      Alert.alert('Demo Mode', 'In demo mode, a sample imported map has been added.');
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
          Alert.alert(
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
        Alert.alert(t('importFailed'), json.error ?? 'Unknown error');
      }
    } catch (e) {
      Alert.alert(t('error'), e instanceof Error ? e.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const showImportOptions = useCallback(() => {
    Alert.alert(t('importMap'), undefined, [
      { text: t('fromFile'), onPress: handleImport },
      { text: t('fromCloud'), onPress: handleCloudImport },
      { text: t('cancel'), style: 'cancel' },
    ]);
  }, [handleCloudImport, handleImport, t]);

  const handleHeaderActionsMenu = useCallback(() => {
    setSheetState({
      visible: true,
      title: 'Map actions',
      actions: [
        {
          label: t('import'),
          subtitle: 'Import from file or cloud backup',
          icon: 'cloud-upload-outline',
          onPress: showImportOptions,
        },
        {
          label: t('export'),
          subtitle: 'Download the current map package',
          icon: 'download-outline',
          disabled: maps.length === 0,
          onPress: handleExport,
        },
        {
          label: 'Refresh',
          subtitle: 'Reload zones and map overlays',
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

  // Charger is always at origin (0,0)
  const chargerLocal: LocalPoint = { x: 0, y: 0 };

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
    // Inverse of localToSvg (which flips both axes):
    // svgX = padding + (maxX - localX) * scale + xOffset → localX = maxX - (svgX - padding - xOffset) / scale
    // svgY = padding + (localY - minY) * scale + yOffset → localY = minY + (svgY - padding - yOffset) / scale
    const localX = bounds.maxX - (x - INNER_PADDING - xOffset) / mapScale;
    const localY = bounds.minY + (y - INNER_PADDING - yOffset) / mapScale;
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

  const singleTapGesture = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd((e) => {
      if (patternCtx.isPlacing) {
        runOnJS(handleTapGesture)(e.x, e.y);
      }
    });

  // Edit-mode drag: translates the active segment by the finger delta. Divides by
  // both the map's metre-to-pixel scale AND the current zoom so drag feels correct
  // when zoomed in. Runs only when 2 anchors are set.
  const editDragStartBaselineRef = useRef({ dx: 0, dy: 0 });
  const editDragEnabled = editMode && editAnchors.length === 2;

  const setEditOffsetFromPan = (px: number, py: number, zoom: number) => {
    const effectiveScale = svgScale * Math.max(zoom, 0.001);
    // SVG flips both axes (localToSvg does `(maxX - x)` and `(y - minY)`).
    // So a right-pan in screen space corresponds to a negative metre dx.
    const dxM = -px / effectiveScale;
    const dyM = py / effectiveScale;
    setEditDragOffset({
      dx: editDragStartBaselineRef.current.dx + dxM,
      dy: editDragStartBaselineRef.current.dy + dyM,
    });
  };

  const captureEditDragBaseline = () => {
    editDragStartBaselineRef.current = { ...editDragOffset };
  };

  const editPanGesture = Gesture.Pan()
    .enabled(editDragEnabled)
    .minDistance(2)
    .onBegin(() => {
      runOnJS(captureEditDragBaseline)();
    })
    .onUpdate((e) => {
      const z = scale.value;
      runOnJS(setEditOffsetFromPan)(e.translationX, e.translationY, z);
    });

  const composedGesture = editDragEnabled
    ? Gesture.Exclusive(editPanGesture, pinchGesture, doubleTapGesture, singleTapGesture)
    : Gesture.Simultaneous(pinchGesture, panGesture, doubleTapGesture, singleTapGesture);

  // ── Edit-mode helpers ─────────────────────────────────────────────
  // Returns the set of vertex indices that are "active" (between the two anchors,
  // using the shorter path around the closed polygon).
  const activeVertexIndices = useMemo<Set<number>>(() => {
    if (!editVertices || editAnchors.length !== 2) return new Set();
    const n = editVertices.length;
    const [a, b] = [...editAnchors].sort((x, y) => x - y);
    const forwardLen = b - a;
    const backwardLen = n - forwardLen;
    const set = new Set<number>();
    if (forwardLen <= backwardLen) {
      for (let i = a; i <= b; i++) set.add(i);
    } else {
      for (let i = b; i < n; i++) set.add(i);
      for (let i = 0; i <= a; i++) set.add(i);
    }
    return set;
  }, [editVertices, editAnchors]);

  // Returns the SVG-space scale (pixels per metre) used by the current render.
  // Needed to convert a finger-pan (pixels) into metre offsets.
  const svgScale = useMemo(() => {
    if (!bounds) return 1;
    const drawSize = MAP_SIZE - INNER_PADDING * 2;
    const xRange = bounds.maxX - bounds.minX || 0.1;
    const yRange = bounds.maxY - bounds.minY || 0.1;
    return Math.min(drawSize / xRange, drawSize / yRange);
  }, [bounds]);

  const editActiveSegmentLength = useMemo(() => {
    if (!editVertices || activeVertexIndices.size === 0) return 0;
    // Total length of the active segment in metres (sum of Euclidean edge lengths).
    const ordered = [...activeVertexIndices].sort((a, b) => a - b);
    let len = 0;
    for (let i = 1; i < ordered.length; i++) {
      const p = editVertices[ordered[i - 1]];
      const q = editVertices[ordered[i]];
      len += Math.sqrt((p.x - q.x) ** 2 + (p.y - q.y) ** 2);
    }
    return len;
  }, [editVertices, activeVertexIndices]);

  const enterEditMode = useCallback(() => {
    if (!selectedWorkMap?.mapArea) return;
    setEditMode(true);
    setEditMapId(selectedWorkMap.mapId);
    setEditVertices(selectedWorkMap.mapArea.map(p => ({ ...p })));
    setEditAnchors([]);
    setEditDragOffset({ dx: 0, dy: 0 });
  }, [selectedWorkMap]);

  const exitEditMode = useCallback(() => {
    setEditMode(false);
    setEditMapId(null);
    setEditVertices(null);
    setEditAnchors([]);
    setEditDragOffset({ dx: 0, dy: 0 });
  }, []);

  const toggleAnchor = useCallback((vertexIdx: number) => {
    setEditAnchors(prev => {
      if (prev.includes(vertexIdx)) return prev.filter(i => i !== vertexIdx);
      if (prev.length >= 2) return [prev[1], vertexIdx]; // drop oldest
      return [...prev, vertexIdx];
    });
    // Reset drag when anchor set changes so we don't carry offsets across segments.
    setEditDragOffset({ dx: 0, dy: 0 });
  }, []);

  const applyEditOffset = useCallback(() => {
    if (!editVertices || activeVertexIndices.size === 0) return editVertices;
    const { dx, dy } = editDragOffset;
    if (dx === 0 && dy === 0) return editVertices;
    return editVertices.map((p, i) =>
      activeVertexIndices.has(i) ? { x: p.x + dx, y: p.y + dy } : p,
    );
  }, [editVertices, activeVertexIndices, editDragOffset]);

  const saveEdit = useCallback(async () => {
    if (!editMapId || !mower?.sn) return;
    const next = applyEditOffset();
    if (!next) return;
    setEditSaving(true);
    try {
      const url = await getServerUrl();
      if (!url) return;
      await fetch(`${url}/api/dashboard/maps/${encodeURIComponent(mower.sn)}/${encodeURIComponent(editMapId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapArea: next }),
      });
      await fetchData();
      exitEditMode();
    } catch { /* ignore */ }
    finally { setEditSaving(false); }
  }, [editMapId, mower?.sn, applyEditOffset, fetchData, exitEditMode]);

  const hasData = visibleMaps.length > 0 || trailLocal.length > 0 || mowerLocal;
  const selectedAreaSqMeters = selectedWorkMap ? polygonAreaSqMeters(selectedWorkMap.mapArea) : 0;
  const relatedObstacleCount = legendMaps.filter((map) => map.mapType === 'obstacle').length;
  const relatedChannelCount = legendMaps.filter((map) => map.mapType === 'unicom' && !isChargerUnicom(map)).length;

  return (
    <GestureHandlerRootView style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView style={styles.content} contentContainerStyle={{ paddingBottom: Math.max(insets.bottom + 80, 96) }}>


        <View style={styles.header}>
          <Text style={styles.title}>{t('mapTitle')}</Text>
          <View style={styles.headerActions}>
            <TouchableOpacity
              onPress={handleHeaderActionsMenu}
              style={styles.toolbarMenuButton}
              activeOpacity={0.82}
              disabled={importing || cloudImporting}
            >
              {(importing || cloudImporting) ? (
                <ActivityIndicator size="small" color={colors.white} />
              ) : (
                <Ionicons name="ellipsis-horizontal" size={16} color={colors.white} />
              )}
            </TouchableOpacity>
            {selectedWorkMap && !editMode && (
              <TouchableOpacity
                onPress={enterEditMode}
                style={styles.toolbarMenuButton}
                activeOpacity={0.82}
              >
                <Ionicons name="create-outline" size={16} color={colors.white} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={() => (navigation as any).navigate('Mapping')}
              style={styles.addButton}
              activeOpacity={0.7}
            >
              <Ionicons name="add" size={18} color={colors.white} />
            </TouchableOpacity>
          </View>
        </View>

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

        {/* SVG Map with pan + zoom */}
        {bounds && (
          <View style={styles.mapExperience}>
            <View style={styles.mapContainer}>
              {selectedWorkMap && (
                <View pointerEvents="none" style={styles.mapHero}>
                  <View>
                    <Text style={styles.mapHeroEyebrow}>
                      {workMaps.length > 1 ? `Map ${selectedWorkIndex + 1} of ${workMaps.length}` : 'Active map'}
                    </Text>
                    <Text style={styles.mapHeroTitle}>
                      {selectedWorkMap.mapName || `Zone ${selectedWorkIndex + 1}`}
                    </Text>
                    <Text style={styles.mapHeroMeta}>
                      {formatAreaLabel(selectedAreaSqMeters)}
                      {relatedObstacleCount > 0 ? ` · ${relatedObstacleCount} obstacle${relatedObstacleCount === 1 ? '' : 's'}` : ''}
                      {relatedChannelCount > 0 ? ` · ${relatedChannelCount} channel${relatedChannelCount === 1 ? '' : 's'}` : ''}
                    </Text>
                  </View>
                  {workMaps.length > 1 && (
                    <Text style={styles.mapHeroHint}>Swipe below</Text>
                  )}
                </View>
              )}

              <GestureDetector gesture={composedGesture}>
                <Animated.View style={[styles.mapInner, animatedStyle]}>
                  <Svg width={MAP_SIZE} height={MAP_SIZE} viewBox={`0 0 ${MAP_SIZE} ${MAP_SIZE}`}>
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

                  {/* Polygon clip paths for coverage stripes */}
                  {isMowing && mowingProgress > 0 && (
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
                    const c = isUnselectedWork
                      ? { fill: 'rgba(255,255,255,0.12)', stroke: 'rgba(255,255,255,0.4)' }
                      : (MAP_COLORS[m.mapType] ?? MAP_COLORS.work);
                    const svgPts = m.mapArea.map((p) => localToSvg(p, bounds, MAP_SIZE, INNER_PADDING));
                    const pts = svgPts.map((p) => `${p.x},${p.y}`).join(' ');
                    // Obstacles are often tiny (sub-meter) against a large work polygon, so a
                    // thicker stroke keeps them legible at the default zoom level.
                    const strokeWidth = m.mapType === 'obstacle' ? 2.5 : isSelected ? 2 : 1.5;
                    return (
                      <G key={m.mapId}>
                        <SvgPolygon points={pts} fill={c.fill} stroke={c.stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
                        {/* Direction stripes (thin — planned mow direction) */}
                        {isMowing && m.mapType === 'work' && (
                          <G clipPath={`url(#clip-${m.mapId})`}>
                            {generateCoverageStripes(svgPts, pathDir, 100, 6).map((l, i) => (
                              <Line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="rgba(34,197,94,0.25)" strokeWidth={1.5} />
                            ))}
                          </G>
                        )}
                      </G>
                    );
                  })}

                  {/* Edit-mode overlay: vertex dots + active segment highlight */}
                  {editMode && editVertices && editMapId && bounds && (() => {
                    // Render the polygon as it would look WITH the current drag applied,
                    // so the user sees live feedback.
                    const shifted = applyEditOffset() ?? editVertices;
                    const svgPts = shifted.map(p => localToSvg(p, bounds, MAP_SIZE, INNER_PADDING));
                    const activePts = [...activeVertexIndices]
                      .sort((a, b) => {
                        // keep the active run in polygon order for drawing a polyline
                        const n = shifted.length;
                        const [lo, hi] = [...editAnchors].sort((x, y) => x - y);
                        const forward = hi - lo;
                        const backward = n - forward;
                        const cw = forward <= backward;
                        if (cw) return a - b;
                        // Reorder so wrap-around segment is drawn contiguously
                        return ((a - hi + n) % n) - ((b - hi + n) % n);
                      });

                    // Thin out visible dots — polygons with >200 points would drown the canvas.
                    // Always show anchors. Show every Nth vertex so the user can tap precisely
                    // without losing visibility at low zoom.
                    const step = Math.max(1, Math.round(shifted.length / 150));

                    // Midpoint of the active segment for the drag handle.
                    let midIdx: number | null = null;
                    if (activePts.length > 1) {
                      midIdx = activePts[Math.floor(activePts.length / 2)];
                    }

                    return (
                      <G>
                        {/* Active segment highlight */}
                        {activePts.length > 1 && (
                          <Polyline
                            points={activePts.map(i => `${svgPts[i].x},${svgPts[i].y}`).join(' ')}
                            fill="none"
                            stroke="#f59e0b"
                            strokeWidth={3.5}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            opacity={0.9}
                          />
                        )}

                        {/* Vertex dots — tappable anchors */}
                        {svgPts.map((p, i) => {
                          const isAnchor = editAnchors.includes(i);
                          if (!isAnchor && i % step !== 0) return null;
                          return (
                            <Circle
                              key={`edit-vx-${i}`}
                              cx={p.x}
                              cy={p.y}
                              r={isAnchor ? 5 : 2.5}
                              fill={isAnchor ? '#f59e0b' : 'rgba(255,255,255,0.5)'}
                              stroke={isAnchor ? '#000' : 'none'}
                              strokeWidth={isAnchor ? 1 : 0}
                              onPress={() => toggleAnchor(i)}
                            />
                          );
                        })}

                        {/* Drag handle on active segment midpoint */}
                        {midIdx != null && (
                          <G>
                            <Circle
                              cx={svgPts[midIdx].x}
                              cy={svgPts[midIdx].y}
                              r={14}
                              fill="rgba(245,158,11,0.2)"
                              stroke="#f59e0b"
                              strokeWidth={2}
                            />
                            <Circle
                              cx={svgPts[midIdx].x}
                              cy={svgPts[midIdx].y}
                              r={6}
                              fill="#f59e0b"
                            />
                          </G>
                        )}
                      </G>
                    );
                  })()}

                  {/* Planned mowing path (only while mowing) */}
                  {isMowing && plannedPaths.length > 0 && plannedPaths.map((path) => (
                    <Polyline
                      key={`plan-${path.id}`}
                      points={path.points.map((p) => localToSvg(p, bounds, MAP_SIZE, INNER_PADDING)).map((p) => `${p.x},${p.y}`).join(' ')}
                      fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
                    />
                  ))}

                  {/* Mowed trail (only while mowing) */}
                  {isMowing && trailLocal.length > 1 && (
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
                    // Icon asset's "front" points LEFT in the source PNG, so the
                    // previous +180 offset rotated it backwards (front and back
                    // swapped on screen). Drop the offset so 0° heading shows
                    // the mower facing the user's right (= +X local), matching
                    // the firmware's heading convention.
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

              {/* Zoom hint / placement hint / edit hint */}
              {editMode ? (
                <Text style={[styles.zoomHint, { color: '#f59e0b' }]}>
                  {editAnchors.length === 0
                    ? 'Tap two polygon points to select a segment'
                    : editAnchors.length === 1
                    ? 'Tap a second point to close the segment'
                    : 'Drag anywhere on the map to move the segment'}
                </Text>
              ) : patternCtx.isPlacing ? (
                <Text style={[styles.zoomHint, { color: colors.purple }]}>
                  {patternCtx.placement?.center ? 'Tap to reposition · Adjust size below' : 'Tap on the map to place the pattern'}
                </Text>
              ) : (
                <Text style={styles.zoomHint}>{t('pinchToZoom')}</Text>
              )}

              {/* Edit-mode footer: live distance + Save/Cancel */}
              {editMode && (() => {
                const totalMoveM = Math.sqrt(editDragOffset.dx ** 2 + editDragOffset.dy ** 2);
                const totalMoveCm = Math.round(totalMoveM * 100);
                return (
                  <View style={styles.editBar}>
                    <View style={styles.editBarInfo}>
                      <Ionicons name="move-outline" size={16} color="#f59e0b" />
                      <Text style={styles.editBarText}>
                        {editAnchors.length < 2
                          ? `${editAnchors.length}/2 anchors`
                          : totalMoveCm === 0
                          ? `Segment ready · ${editActiveSegmentLength.toFixed(2)} m`
                          : `Shifted ${totalMoveCm} cm`}
                      </Text>
                    </View>
                    <View style={styles.editBarActions}>
                      <TouchableOpacity
                        style={[styles.editBarBtn, styles.editBarBtnCancel]}
                        onPress={exitEditMode}
                        disabled={editSaving}
                        activeOpacity={0.7}
                      >
                        <Text style={styles.editBarBtnTextCancel}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.editBarBtn, styles.editBarBtnSave, (editSaving || editAnchors.length < 2 || (editDragOffset.dx === 0 && editDragOffset.dy === 0)) && { opacity: 0.5 }]}
                        onPress={saveEdit}
                        disabled={editSaving || editAnchors.length < 2 || (editDragOffset.dx === 0 && editDragOffset.dy === 0)}
                        activeOpacity={0.7}
                      >
                        {editSaving ? (
                          <ActivityIndicator size="small" color={colors.white} />
                        ) : (
                          <Text style={styles.editBarBtnTextSave}>Save</Text>
                        )}
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })()}
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
                          const familyKey = getMapFamilyKey(map);
                          const linkedMaps = maps.filter((candidate) => {
                            if (candidate.mapId === map.mapId || candidate.mapType === 'work') return false;
                            if (!familyKey) return workMaps.length === 1;
                            return getMapFamilyKey(candidate) === familyKey;
                          });
                          const obstacleCount = linkedMaps.filter((candidate) => candidate.mapType === 'obstacle').length;
                          const channelCount = linkedMaps.filter((candidate) => candidate.mapType === 'unicom' && !isChargerUnicom(candidate)).length;

                          return (
                            <View key={map.mapId} style={[styles.zonePanelPage, { width: PANEL_PAGE_WIDTH }]}>
                              <View style={styles.zonePanelCard}>
                                {/* Header: title + actions */}
                                <View style={styles.zonePanelHeader}>
                                  <View style={styles.zonePanelTitleWrap}>
                                    <Text style={styles.zonePanelTitle}>{map.mapName || `Zone ${index + 1}`}</Text>
                                  </View>
                                  <View style={styles.zonePanelActions}>
                                    <TouchableOpacity style={styles.zonePanelIconButton} onPress={() => handleMapAction(map)} activeOpacity={0.7}>
                                      <Ionicons name="create-outline" size={18} color={colors.white} />
                                    </TouchableOpacity>
                                    <TouchableOpacity style={styles.zonePanelIconButton} onPress={() => handleDeleteMap(map)} activeOpacity={0.7}>
                                      <Ionicons name="trash-outline" size={18} color={colors.white} />
                                    </TouchableOpacity>
                                  </View>
                                </View>

                                {/* Big tile metrics — Size + Est. mow as prominent cards.
                                    Restored from the older swipe-up panel design that read
                                    cleaner than the chip strip. Smaller indicator chips
                                    (obstacles/channels/charger/mower) sit underneath. */}
                                <View style={styles.zoneMetricRow}>
                                  <View style={styles.zoneMetricCard}>
                                    <Text style={styles.zoneMetricLabel}>{t('size', undefined) || 'Size'}</Text>
                                    <Text style={styles.zoneMetricValue}>{formatAreaLabel(areaSqMeters)}</Text>
                                  </View>
                                  <View style={styles.zoneMetricCard}>
                                    <Text style={styles.zoneMetricLabel}>{t('estMow', undefined) || 'Est. mow'}</Text>
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
                                          {`${obstacleCount} ${obstacleCount === 1 ? (t('obstacle', undefined) || 'obstacle') : (t('obstacles', undefined) || 'obstacles')}`}
                                        </Text>
                                      </View>
                                    )}
                                    {channelCount > 0 && (
                                      <View style={styles.zoneInfoChip}>
                                        <Ionicons name="git-branch-outline" size={12} color={colors.textDim} />
                                        <Text style={styles.zoneInfoText}>
                                          {`${channelCount} ${channelCount === 1 ? (t('channel', undefined) || 'channel') : (t('channels', undefined) || 'channels')}`}
                                        </Text>
                                      </View>
                                    )}
                                  </View>
                                )}

                                {/* Action buttons */}
                                <View style={styles.zoneButtonRow}>
                                  <TouchableOpacity
                                    style={[styles.zoneActionButton, styles.zoneActionPrimary]}
                                    onPress={() => (navigation as any).navigate('Home', {
                                      openStartMow: true,
                                      preselectedMapId: map.mapId,
                                    })}
                                    activeOpacity={0.8}
                                  >
                                    <Ionicons name="play-outline" size={16} color={colors.white} />
                                    <Text style={styles.zoneActionPrimaryText}>{t('startMowing')}</Text>
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
                              </View>
                            </View>
                          );
                        })}
                      </ScrollView>

                {workMaps.length > 1 && (
                  <View style={styles.zonePagerWrap}>
                    <Text style={styles.zonePagerLabel}>
                      {selectedWorkIndex + 1} / {workMaps.length} zones — swipe to switch
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
              Pattern {patternCtx.placement.patternId} — {patternCtx.placement.center ? 'Placed' : 'Tap map to place'}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>Size:</Text>
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

              <Text style={{ color: colors.textMuted, fontSize: 12, marginLeft: 12 }}>Rotation:</Text>
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
                <Text style={styles.chipText}>Loc: {mower.sensors.loc_quality}%</Text>
              </View>
            )}
            {isMowing && covRatio > 0 && (
              <View style={[styles.chip, { backgroundColor: 'rgba(34,197,94,0.15)' }]}>
                <Ionicons name="checkmark-circle" size={14} color={colors.emerald} />
                <Text style={[styles.chipText, { color: colors.emerald }]}>{Math.round(covRatio)}% done</Text>
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
            <Text style={styles.actionsSheetTitle}>Map actions</Text>

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
                <Text style={styles.actionsSheetItemSub}>Import from file or cloud backup</Text>
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
                <Text style={styles.actionsSheetItemSub}>Download the current map package</Text>
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
                <Text style={styles.actionsSheetItemTitle}>Refresh</Text>
                <Text style={styles.actionsSheetItemSub}>Reload zones and map overlays</Text>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, padding: MAP_PADDING },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  title: { fontSize: 22, fontWeight: '700', color: colors.white },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  addButton: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: colors.emerald,
    alignItems: 'center', justifyContent: 'center',
  },
  toolbarMenuButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyState: { alignItems: 'center', paddingVertical: 60 },
  emptyIcon: {
    width: 96, height: 96, borderRadius: 48,
    backgroundColor: 'rgba(0,212,170,0.1)',
    alignItems: 'center', justifyContent: 'center', marginBottom: 24,
  },
  emptyTitle: { fontSize: 22, fontWeight: '700', color: colors.white, marginBottom: 8 },
  emptySubtitle: { fontSize: 15, color: colors.textDim, textAlign: 'center', marginBottom: 20 },
  importButton: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 20, paddingVertical: 12,
    backgroundColor: colors.emerald, borderRadius: 12,
  },
  importButtonText: { fontSize: 15, fontWeight: '600', color: colors.white },
  mapExperience: { marginTop: 4, marginBottom: 12 },
  editBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(245,158,11,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.3)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginHorizontal: 16,
    marginTop: 8,
  },
  editBarInfo: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  editBarText: { color: '#fcd34d', fontSize: 13, fontWeight: '600' },
  editBarActions: { flexDirection: 'row', gap: 8 },
  editBarBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8 },
  editBarBtnCancel: { backgroundColor: 'rgba(255,255,255,0.08)' },
  editBarBtnSave: { backgroundColor: '#f59e0b' },
  editBarBtnTextCancel: { color: colors.text, fontSize: 13, fontWeight: '600' },
  editBarBtnTextSave: { color: colors.white, fontSize: 13, fontWeight: '700' },
  mapContainer: {
    backgroundColor: colors.card,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    overflow: 'hidden',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.24,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 14 },
    elevation: 10,
  },
  mapInner: { width: MAP_SIZE, height: MAP_SIZE },
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
    color: colors.textMuted,
    marginBottom: 4,
  },
  mapHeroTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.white,
  },
  mapHeroMeta: {
    marginTop: 4,
    fontSize: 12,
    color: colors.textDim,
    fontWeight: '600',
  },
  mapHeroHint: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.white,
    backgroundColor: 'rgba(3,7,18,0.68)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    overflow: 'hidden',
  },
  zoomHint: { fontSize: 11, color: colors.textMuted, textAlign: 'center', paddingVertical: 8 },
  zonePanelShell: {
    marginTop: 12,
  },
  zonePanelPage: {
    paddingHorizontal: 2,
  },
  zonePanelCard: {
    backgroundColor: '#1b2747',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    shadowColor: '#000',
    shadowOpacity: 0.24,
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
    backgroundColor: 'rgba(255,255,255,0.24)',
    marginBottom: 8,
  },
  zoneDragLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted,
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
    color: colors.white,
  },
  zonePanelActions: {
    flexDirection: 'row',
    gap: 10,
  },
  zonePanelIconButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
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
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  zoneMetricLabel: {
    fontSize: 11,
    color: colors.textDim,
    fontWeight: '700',
    marginBottom: 2,
  },
  zoneMetricValue: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.white,
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
    color: colors.text,
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
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  zoneActionPrimary: {
    backgroundColor: colors.emerald,
  },
  zoneActionText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text,
  },
  zoneActionPrimaryText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.white,
  },
  zonePagerWrap: {
    alignItems: 'center',
    marginTop: 12,
    gap: 6,
  },
  zonePagerLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
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
    backgroundColor: colors.emerald,
  },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 12, paddingHorizontal: 4 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: 12, color: colors.textDim },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 6,
    backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 12,
  },
  chipText: { fontSize: 12, color: colors.textDim, fontVariant: ['tabular-nums'] },
  actionsSheetOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  actionsSheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  actionsSheet: {
    backgroundColor: '#10182e',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 22,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  actionsSheetHandle: {
    width: 52,
    height: 5,
    borderRadius: 999,
    alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    marginBottom: 12,
  },
  actionsSheetTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.white,
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
    color: colors.white,
  },
  actionsSheetItemTitleDisabled: {
    color: colors.textMuted,
  },
  actionsSheetItemSub: {
    marginTop: 2,
    fontSize: 12,
    color: colors.textDim,
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
    color: colors.white,
  },
});
