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
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
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
import { useNavigation } from '@react-navigation/native';
import { colors } from '../theme/colors';
import { useMowerState } from '../hooks/useMowerState';
import { ApiClient, type MapData, type TrailPoint, type LocalPoint, type ChargerGps } from '../services/api';
import { getServerUrl } from '../services/auth';
import { DemoBanner } from '../components/DemoBanner';
import { useDemo } from '../context/DemoContext';
import { usePattern } from '../context/PatternContext';
import { contourToSvgPath, transformToGps } from '../utils/patternUtils';
import { useI18n } from '../i18n';
import { Linking } from 'react-native';

const { width: SCREEN_W } = Dimensions.get('window');
const MAP_PADDING = 24;
const MAP_SIZE = SCREEN_W - MAP_PADDING * 2;
const INNER_PADDING = 20;

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

  const composedGesture = Gesture.Simultaneous(pinchGesture, panGesture, doubleTapGesture, singleTapGesture);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
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
  const handleMapAction = (map: MapData) => {
    Alert.alert(
      map.mapName || map.mapType,
      undefined,
      [
        {
          text: t('renameMap'),
          onPress: () => {
            Alert.prompt(
              t('renameMap'),
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
          text: t('delete'),
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              t('deleteMap'),
              t('deleteMapConfirm'),
              [
                { text: t('cancel'), style: 'cancel' },
                {
                  text: t('delete'),
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      const url = await getServerUrl();
                      if (!url || !mower) return;
                      await fetch(`${url}/api/dashboard/maps/${encodeURIComponent(mower.sn)}/${encodeURIComponent(map.mapId)}`, {
                        method: 'DELETE',
                      });
                      fetchData();
                    } catch { Alert.alert(t('error'), 'Delete failed'); }
                  },
                },
              ],
            );
          },
        },
        { text: t('cancel'), style: 'cancel' },
      ],
    );
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
    for (const m of maps) {
      if (m.mapType === 'unicom') continue;
      b = expandLocalBounds(b, computeLocalBounds(m.mapArea));
    }
    if (trailLocal.length > 0) b = expandLocalBounds(b, computeLocalBounds(trailLocal));
    if (mowerLocal) b = expandLocalBounds(b, computeLocalBounds([mowerLocal]));
    // Always include charger at origin
    b = expandLocalBounds(b, computeLocalBounds([chargerLocal]));
    if (b) {
      const xPad = (b.maxX - b.minX) * 0.15 || 0.5;
      const yPad = (b.maxY - b.minY) * 0.15 || 0.5;
      b = { minX: b.minX - xPad, maxX: b.maxX + xPad, minY: b.minY - yPad, maxY: b.maxY + yPad };
    }
    return b;
  }, [maps, trailLocal, mowerLocal]);

  const hasData = maps.length > 0 || trailLocal.length > 0 || mowerLocal;

  return (
    <GestureHandlerRootView style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.content}>


        <View style={styles.header}>
          <Text style={styles.title}>{t('mapTitle')}</Text>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 20, marginBottom: 12 }}>
            <TouchableOpacity
              onPress={() => (navigation as any).navigate('AppSettings', { screen: 'Mapping' })}
              style={[styles.actionBtn, { backgroundColor: 'rgba(168,85,247,0.2)', borderColor: 'rgba(168,85,247,0.3)' }]}
              activeOpacity={0.7}
            >
              <Ionicons name="add-circle-outline" size={16} color={colors.purple} />
              <Text style={[styles.actionBtnText, { color: colors.purple }]}>{t('create')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                Alert.alert(t('importMap'), undefined, [
                  { text: t('fromFile'), onPress: handleImport },
                  { text: t('fromCloud'), onPress: handleCloudImport },
                  { text: t('cancel'), style: 'cancel' },
                ]);
              }}
              style={[styles.actionBtn, styles.actionBtnGreen]}
              activeOpacity={0.7}
              disabled={importing || cloudImporting}
            >
              {(importing || cloudImporting) ? (
                <ActivityIndicator size="small" color={colors.white} />
              ) : (
                <>
                  <Ionicons name="cloud-upload-outline" size={16} color={colors.white} />
                  <Text style={styles.actionBtnText}>{t('import')}</Text>
                </>
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={handleExport} style={styles.actionBtn} activeOpacity={0.7} disabled={maps.length === 0}>
              <Ionicons name="download-outline" size={16} color={maps.length > 0 ? colors.white : colors.textMuted} />
              <Text style={[styles.actionBtnText, maps.length === 0 && { color: colors.textMuted }]}>{t('export')}</Text>
            </TouchableOpacity>
            {maps.length > 0 && (
              <TouchableOpacity
                onPress={() => {
                  Alert.alert(
                    'Edit Map',
                    'What would you like to add?',
                    [
                      { text: 'Add Work Area', onPress: () => (navigation as any).navigate('AppSettings', { screen: 'Mapping', params: { buildType: 'work' } }) },
                      { text: 'Add Obstacle', onPress: () => (navigation as any).navigate('AppSettings', { screen: 'Mapping', params: { buildType: 'obstacle' } }) },
                      { text: 'Cancel', style: 'cancel' },
                    ]
                  );
                }}
                style={[styles.actionBtn, { backgroundColor: 'rgba(245,158,11,0.2)', borderColor: 'rgba(245,158,11,0.3)' }]}
                activeOpacity={0.7}
              >
                <Ionicons name="pencil" size={16} color="#f59e0b" />
                <Text style={[styles.actionBtnText, { color: '#f59e0b' }]}>Edit</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={fetchData} style={styles.headerBtn} activeOpacity={0.7}>
              <Ionicons name="refresh" size={20} color={colors.textDim} />
            </TouchableOpacity>
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
          <View style={styles.mapContainer}>
            <GestureDetector gesture={composedGesture}>
              <Animated.View style={[styles.mapInner, animatedStyle]}>
                <Svg width={MAP_SIZE} height={MAP_SIZE} viewBox={`0 0 ${MAP_SIZE} ${MAP_SIZE}`}>
                  {/* Grid */}
                  {Array.from({ length: 5 }, (_, i) => {
                    const pos = INNER_PADDING + ((MAP_SIZE - INNER_PADDING * 2) / 4) * i;
                    return (
                      <G key={`grid-${i}`}>
                        <Line x1={INNER_PADDING} y1={pos} x2={MAP_SIZE - INNER_PADDING} y2={pos} stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
                        <Line x1={pos} y1={INNER_PADDING} x2={pos} y2={MAP_SIZE - INNER_PADDING} stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
                      </G>
                    );
                  })}

                  {/* Polygon clip paths for coverage stripes */}
                  {isMowing && mowingProgress > 0 && (
                    <Defs>
                      {maps.filter((m) => m.mapType === 'work' && m.mapArea?.length >= 3).map((m) => {
                        const svgPts = m.mapArea.map((p) => localToSvg(p, bounds, MAP_SIZE, INNER_PADDING));
                        return (
                          <ClipPath key={`clip-${m.mapId}`} id={`clip-${m.mapId}`}>
                            <SvgPolygon points={svgPts.map((p) => `${p.x},${p.y}`).join(' ')} />
                          </ClipPath>
                        );
                      })}
                    </Defs>
                  )}

                  {/* Polygons */}
                  {maps.map((m) => {
                    if (!m.mapArea || m.mapArea.length < 3) return null;
                    if (m.mapType === 'unicom') return null;
                    const c = MAP_COLORS[m.mapType] ?? MAP_COLORS.work;
                    const svgPts = m.mapArea.map((p) => localToSvg(p, bounds, MAP_SIZE, INNER_PADDING));
                    const pts = svgPts.map((p) => `${p.x},${p.y}`).join(' ');
                    return (
                      <G key={m.mapId}>
                        <SvgPolygon points={pts} fill={c.fill} stroke={c.stroke} strokeWidth={2} strokeLinejoin="round" />
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
                    // Icon points RIGHT at 0°; flipped X-axis → negate heading; +360 offset (270+90)
                    const degHeading = -(heading * 180 / Math.PI) + 180;
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

            {/* Zoom hint / placement hint */}
            {patternCtx.isPlacing ? (
              <Text style={[styles.zoomHint, { color: colors.purple }]}>
                {patternCtx.placement?.center ? 'Tap to reposition · Adjust size below' : 'Tap on the map to place the pattern'}
              </Text>
            ) : (
              <Text style={styles.zoomHint}>{t('pinchToZoom')}</Text>
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

        {/* Legend */}
        {maps.length > 0 && (
          <View style={styles.legend}>
            {maps.filter((m) => m.mapType !== 'unicom').map((m) => {
              const c = MAP_COLORS[m.mapType] ?? MAP_COLORS.work;
              return (
                <TouchableOpacity
                  key={m.mapId}
                  style={styles.legendItem}
                  onLongPress={() => handleMapAction(m)}
                  onPress={() => handleMapAction(m)}
                  activeOpacity={0.7}
                >
                  <View style={[styles.legendDot, { backgroundColor: c.stroke }]} />
                  <Text style={styles.legendText}>{m.mapName || m.mapType}</Text>
                  <Ionicons name="ellipsis-horizontal" size={14} color={colors.textMuted} style={{ marginLeft: 4 }} />
                </TouchableOpacity>
              );
            })}
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: '#f59e0b' }]} />
              <Text style={styles.legendText}>Charger</Text>
            </View>
            {mowerLocal && (
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: colors.emerald }]} />
                <Text style={styles.legendText}>Mower</Text>
              </View>
            )}
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
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, padding: MAP_PADDING },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 28, fontWeight: '700', color: colors.white },
  headerButtons: { flexDirection: 'row', gap: 8 },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, height: 34, borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  actionBtnGreen: { backgroundColor: colors.emerald },
  actionBtnText: { fontSize: 13, fontWeight: '600', color: colors.white },
  headerBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center', justifyContent: 'center',
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
  mapContainer: {
    backgroundColor: colors.card, borderRadius: 20,
    borderWidth: 1, borderColor: colors.cardBorder,
    overflow: 'hidden', alignItems: 'center',
  },
  mapInner: { width: MAP_SIZE, height: MAP_SIZE },
  zoomHint: { fontSize: 11, color: colors.textMuted, textAlign: 'center', paddingVertical: 6 },
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
});
