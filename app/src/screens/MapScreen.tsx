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
} from 'react-native-svg';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { colors } from '../theme/colors';
import { useMowerState } from '../hooks/useMowerState';
import { ApiClient, type MapData, type TrailPoint } from '../services/api';
import { getServerUrl } from '../services/auth';
import { DemoBanner } from '../components/DemoBanner';
import { useDemo } from '../context/DemoContext';
import { usePattern } from '../context/PatternContext';
import { contourToSvgPath, transformToGps } from '../utils/patternUtils';
import { useI18n } from '../i18n';

const { width: SCREEN_W } = Dimensions.get('window');
const MAP_PADDING = 24;
const MAP_SIZE = SCREEN_W - MAP_PADDING * 2;
const INNER_PADDING = 20;

// ── GPS → SVG coordinate conversion ─────────────────────────────────

interface GpsPoint { lat: number; lng: number }

interface Bounds {
  minLat: number; maxLat: number; minLng: number; maxLng: number;
}

function computeBounds(points: GpsPoint[]): Bounds | null {
  if (points.length === 0) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

function expandBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minLat: Math.min(a.minLat, b.minLat), maxLat: Math.max(a.maxLat, b.maxLat),
    minLng: Math.min(a.minLng, b.minLng), maxLng: Math.max(a.maxLng, b.maxLng),
  };
}

function gpsToSvg(point: GpsPoint, bounds: Bounds, size: number, padding: number) {
  const drawSize = size - padding * 2;
  const latRange = bounds.maxLat - bounds.minLat || 0.0001;
  const lngRange = bounds.maxLng - bounds.minLng || 0.0001;
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const effectiveLngRange = lngRange * cosLat;
  const scale = Math.min(drawSize / effectiveLngRange, drawSize / latRange);
  const x = padding + (point.lng - bounds.minLng) * cosLat * scale + (drawSize - effectiveLngRange * scale) / 2;
  const y = padding + (bounds.maxLat - point.lat) * scale + (drawSize - latRange * scale) / 2;
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

  const rad = ((direction + 90) * Math.PI) / 180;
  const perpRad = (direction * Math.PI) / 180;
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

const DEMO_MAPS: MapData[] = [
  { mapId: 'demo-front', mapName: 'Front Yard', mapType: 'work', mapArea: [
    { lat: 52.0912, lng: 5.1208 }, { lat: 52.0916, lng: 5.1210 },
    { lat: 52.0917, lng: 5.1218 }, { lat: 52.0914, lng: 5.1222 },
    { lat: 52.0910, lng: 5.1220 }, { lat: 52.0909, lng: 5.1212 },
  ]},
  { mapId: 'demo-back', mapName: 'Back Garden', mapType: 'work', mapArea: [
    { lat: 52.0904, lng: 5.1210 }, { lat: 52.0907, lng: 5.1208 },
    { lat: 52.0908, lng: 5.1216 }, { lat: 52.0905, lng: 5.1220 },
    { lat: 52.0902, lng: 5.1215 },
  ]},
  { mapId: 'demo-obstacle', mapName: 'Tree', mapType: 'obstacle', mapArea: [
    { lat: 52.0913, lng: 5.1214 }, { lat: 52.0914, lng: 5.1215 },
    { lat: 52.0913, lng: 5.1216 }, { lat: 52.0912, lng: 5.1215 },
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
  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

  const mower = useMemo(() => [...devices.values()].find((d) => d.deviceType === 'mower') ?? null, [devices]);
  const charger = useMemo(() => [...devices.values()].find((d) => d.deviceType === 'charger') ?? null, [devices]);

  const mowerGps: GpsPoint | null = useMemo(() => {
    if (!mower?.sensors.latitude || !mower?.sensors.longitude) return null;
    const lat = parseFloat(mower.sensors.latitude);
    const lng = parseFloat(mower.sensors.longitude);
    if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) return null;
    return { lat, lng };
  }, [mower?.sensors.latitude, mower?.sensors.longitude]);

  const chargerGps: GpsPoint | null = useMemo(() => {
    if (!charger?.sensors.latitude || !charger?.sensors.longitude) return null;
    const lat = parseFloat(charger.sensors.latitude);
    const lng = parseFloat(charger.sensors.longitude);
    if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) return null;
    return { lat, lng };
  }, [charger?.sensors.latitude, charger?.sensors.longitude]);

  const heading = parseFloat(mower?.sensors.heading ?? '0') || 0;
  const isMowing = mower?.sensors.work_status === '1';
  const mowingProgress = parseInt(mower?.sensors.mowing_progress ?? '0', 10) || 0;
  const pathDir = parseInt(mower?.sensors.path_direction ?? '0', 10) || 0;

  // Auto-calibrate once: if no calibration exists, try charger GPS from live sensor data
  const calibrationChecked = useRef(false);
  useEffect(() => {
    if (demo.enabled || !mower?.sn || calibrationChecked.current) return;
    calibrationChecked.current = true;
    (async () => {
      try {
        const url = await getServerUrl();
        if (!url) return;
        const api = new ApiClient(url);
        const cal = await api.fetchCalibration(mower.sn);
        if (cal?.chargerLat && cal?.chargerLng) return; // Already calibrated
        const charger = [...devices.values()].find(d => d.deviceType === 'charger' && d.online);
        const lat = parseFloat(charger?.sensors?.latitude ?? '');
        const lng = parseFloat(charger?.sensors?.longitude ?? '');
        if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
          console.log(`[Map] Auto-calibrating: charger GPS ${lat}, ${lng}`);
          await api.saveCalibration(mower.sn, {
            offsetLat: 0, offsetLng: 0, rotation: 0, scale: 1,
            chargerLat: lat, chargerLng: lng,
          });
        }
      } catch { /* ignore */ }
    })();
  }, [mower?.sn]);

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
      const [mapsRes, trailRes] = await Promise.all([
        api.fetchMaps(sn).catch(() => ({ maps: [] })),
        api.getTrail(sn).catch(() => []),
      ]);
      setMaps(mapsRes.maps ?? []);
      setTrail(Array.isArray(trailRes) ? trailRes : (trailRes as any).trail ?? []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [mower?.sn, demo.enabled]);

  useEffect(() => { fetchData(); }, [fetchData]);

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

  const composedGesture = Gesture.Simultaneous(pinchGesture, panGesture, doubleTapGesture);

  // Pattern placement: convert tap position to GPS
  const handleMapTap = useCallback((evt: { nativeEvent: { locationX: number; locationY: number } }) => {
    if (!patternCtx.isPlacing || !bounds) return;
    const x = evt.nativeEvent.locationX;
    const y = evt.nativeEvent.locationY;
    const drawSize = MAP_SIZE - INNER_PADDING * 2;
    const latRange = bounds.maxLat - bounds.minLat || 0.0001;
    const lngRange = bounds.maxLng - bounds.minLng || 0.0001;
    const midLat = (bounds.minLat + bounds.maxLat) / 2;
    const cosLat = Math.cos((midLat * Math.PI) / 180);
    const effectiveLngRange = lngRange * cosLat;
    const mapScale = Math.min(drawSize / effectiveLngRange, drawSize / latRange);
    const xOffset = (drawSize - effectiveLngRange * mapScale) / 2;
    const yOffset = (drawSize - latRange * mapScale) / 2;
    const lng = bounds.minLng + (x - INNER_PADDING - xOffset) / (cosLat * mapScale);
    const lat = bounds.maxLat - (y - INNER_PADDING - yOffset) / mapScale;
    patternCtx.setCenter(lat, lng);
  }, [patternCtx, bounds]);

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
      // Trigger server-side ZIP generation, then open download URL
      const downloadUrl = `${serverUrl}/api/dashboard/maps/${encodeURIComponent(mower.sn)}/download-zip`;
      Alert.alert(t('export'), `Download your map ZIP from:\n\n${downloadUrl}`, [
        { text: t('ok') },
      ]);
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
            { lat: 52.0900, lng: 5.1200 }, { lat: 52.0906, lng: 5.1198 },
            { lat: 52.0910, lng: 5.1205 }, { lat: 52.0908, lng: 5.1215 },
            { lat: 52.0903, lng: 5.1218 }, { lat: 52.0898, lng: 5.1210 },
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
  const bounds = useMemo(() => {
    let b: Bounds | null = null;
    for (const m of maps) b = expandBounds(b, computeBounds(m.mapArea));
    if (trail.length > 0) b = expandBounds(b, computeBounds(trail));
    if (mowerGps) b = expandBounds(b, computeBounds([mowerGps]));
    if (chargerGps) b = expandBounds(b, computeBounds([chargerGps]));
    if (b) {
      const latPad = (b.maxLat - b.minLat) * 0.15 || 0.0002;
      const lngPad = (b.maxLng - b.minLng) * 0.15 || 0.0002;
      b = { minLat: b.minLat - latPad, maxLat: b.maxLat + latPad, minLng: b.minLng - lngPad, maxLng: b.maxLng + lngPad };
    }
    return b;
  }, [maps, trail, mowerGps, chargerGps]);

  const hasData = maps.length > 0 || trail.length > 0 || mowerGps || chargerGps;

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
            {/* Tap overlay for pattern placement */}
            {patternCtx.isPlacing && (
              <View
                style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10 }}
                onStartShouldSetResponder={() => true}
                onResponderRelease={handleMapTap}
              />
            )}
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
                        const svgPts = m.mapArea.map((p) => gpsToSvg(p, bounds, MAP_SIZE, INNER_PADDING));
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
                    const c = MAP_COLORS[m.mapType] ?? MAP_COLORS.work;
                    const svgPts = m.mapArea.map((p) => gpsToSvg(p, bounds, MAP_SIZE, INNER_PADDING));
                    const pts = svgPts.map((p) => `${p.x},${p.y}`).join(' ');
                    return (
                      <G key={m.mapId}>
                        <SvgPolygon points={pts} fill={c.fill} stroke={c.stroke} strokeWidth={2} strokeLinejoin="round" />
                        {/* Coverage stripes on work polygons during mowing */}
                        {isMowing && mowingProgress > 0 && m.mapType === 'work' && (
                          <G clipPath={`url(#clip-${m.mapId})`}>
                            {generateCoverageStripes(svgPts, pathDir, mowingProgress, 6).map((l, i) => (
                              <Line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="rgba(34,197,94,0.4)" strokeWidth={4} />
                            ))}
                          </G>
                        )}
                      </G>
                    );
                  })}

                  {/* Trail */}
                  {trail.length > 1 && (
                    <Polyline
                      points={trail.map((p) => gpsToSvg(p, bounds, MAP_SIZE, INNER_PADDING)).map((p) => `${p.x},${p.y}`).join(' ')}
                      fill="none" stroke="rgba(52,211,153,0.5)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
                    />
                  )}

                  {/* Charger */}
                  {chargerGps && (() => {
                    const cp = gpsToSvg(chargerGps, bounds, MAP_SIZE, INNER_PADDING);
                    return (
                      <G>
                        <Circle cx={cp.x} cy={cp.y} r={10} fill="rgba(245,158,11,0.2)" stroke="#f59e0b" strokeWidth={2} />
                        <Path d={`M${cp.x - 2.5} ${cp.y - 4} L${cp.x + 2.5} ${cp.y - 4} L${cp.x + 1} ${cp.y} L${cp.x + 3} ${cp.y} L${cp.x - 1} ${cp.y + 5} L${cp.x} ${cp.y + 1} L${cp.x - 2} ${cp.y + 1} Z`} fill="#f59e0b" />
                      </G>
                    );
                  })()}

                  {/* Mower + heading */}
                  {mowerGps && (() => {
                    const mp = gpsToSvg(mowerGps, bounds, MAP_SIZE, INNER_PADDING);
                    const rad = ((heading - 90) * Math.PI) / 180;
                    const ax = mp.x + Math.cos(rad) * 14;
                    const ay = mp.y + Math.sin(rad) * 14;
                    return (
                      <G>
                        <Line x1={mp.x} y1={mp.y} x2={ax} y2={ay} stroke={colors.emerald} strokeWidth={2} strokeLinecap="round" />
                        <Circle cx={mp.x} cy={mp.y} r={8} fill={colors.emerald} />
                        <Circle cx={mp.x} cy={mp.y} r={4} fill={colors.white} />
                      </G>
                    );
                  })()}

                  {/* Pattern overlay (only during placement mode) */}
                  {patternCtx.isPlacing && patternCtx.placement?.center && patternCtx.placement.contours.length > 0 && bounds && (() => {
                    const p = patternCtx.placement!;
                    const gpsPolys = p.contours.map(c => transformToGps(c, p.center!, p.sizeMeter, p.rotation));
                    return gpsPolys.map((poly, i) => {
                      const svgPts = poly.map(pt => gpsToSvg(pt, bounds, MAP_SIZE, INNER_PADDING));
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
            {maps.map((m) => {
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
            {chargerGps && (
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: '#f59e0b' }]} />
                <Text style={styles.legendText}>Charger</Text>
              </View>
            )}
            {mowerGps && (
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
            {mowerGps && (
              <View style={styles.chip}>
                <Ionicons name="location" size={14} color={colors.emerald} />
                <Text style={styles.chipText}>{mowerGps.lat.toFixed(5)}, {mowerGps.lng.toFixed(5)}</Text>
              </View>
            )}
            {mower.sensors.heading && (
              <View style={styles.chip}>
                <Ionicons name="compass" size={14} color={colors.textDim} />
                <Text style={styles.chipText}>{Math.round(heading)}°</Text>
              </View>
            )}
            {mower.sensors.loc_quality && (
              <View style={styles.chip}>
                <Ionicons name="navigate" size={14} color={colors.textDim} />
                <Text style={styles.chipText}>Loc: {mower.sensors.loc_quality}%</Text>
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
