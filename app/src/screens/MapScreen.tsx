/**
 * Map screen — lightweight SVG-based map with pan + pinch-zoom.
 * Shows mower position, charger, map polygons, GPS trail.
 * Supports importing Novabot ZIP map files.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
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
} from 'react-native-svg';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { useMowerState } from '../hooks/useMowerState';
import { ApiClient, type MapData, type TrailPoint } from '../services/api';
import { getServerUrl } from '../services/auth';
import { DemoBanner } from '../components/DemoBanner';
import { useDemo } from '../context/DemoContext';

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
  const { devices, connected } = useMowerState();
  const demo = useDemo();
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
      Alert.alert('Export Map', `Download your map ZIP from:\n\n${downloadUrl}`, [
        { text: 'OK' },
      ]);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Export failed');
    }
  };

  // ── Import ZIP ───────────────────────────────────────────────────
  const handleImport = async () => {
    if (!mower?.sn) {
      Alert.alert('No Mower', 'Connect a mower first to import maps.');
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
        Alert.alert('Import Successful', `${json.imported} map area(s) imported.`);
        fetchData(); // refresh map
      } else {
        Alert.alert('Import Failed', json.error ?? 'Unknown error');
      }
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Import failed');
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
        <DemoBanner />

        <View style={styles.header}>
          <Text style={styles.title}>Map</Text>
          <View style={styles.headerButtons}>
            <TouchableOpacity onPress={handleExport} style={styles.actionBtn} activeOpacity={0.7} disabled={maps.length === 0}>
              <Ionicons name="download-outline" size={16} color={maps.length > 0 ? colors.white : colors.textMuted} />
              <Text style={[styles.actionBtnText, maps.length === 0 && { color: colors.textMuted }]}>Export</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleImport} style={[styles.actionBtn, styles.actionBtnGreen]} activeOpacity={0.7} disabled={importing}>
              {importing ? (
                <ActivityIndicator size="small" color={colors.white} />
              ) : (
                <>
                  <Ionicons name="cloud-upload-outline" size={16} color={colors.white} />
                  <Text style={styles.actionBtnText}>Import</Text>
                </>
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={fetchData} style={styles.headerBtn} activeOpacity={0.7}>
              <Ionicons name="refresh" size={20} color={colors.textDim} />
            </TouchableOpacity>
          </View>
        </View>

        {loading && <ActivityIndicator size="small" color={colors.emerald} style={{ marginTop: 32 }} />}

        {!loading && !hasData && !bounds && (
          <View style={styles.emptyState}>
            <View style={styles.emptyIcon}>
              <Ionicons name="map-outline" size={48} color={colors.textMuted} />
            </View>
            <Text style={styles.emptyTitle}>No Map Data</Text>
            <Text style={styles.emptySubtitle}>
              {connected ? 'Import a map ZIP or create one from the mower.' : 'Connecting to server...'}
            </Text>
            <TouchableOpacity style={styles.importButton} onPress={handleImport} activeOpacity={0.7}>
              <Ionicons name="cloud-upload-outline" size={18} color={colors.white} />
              <Text style={styles.importButtonText}>Import Map ZIP</Text>
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

                  {/* Polygons */}
                  {maps.map((m) => {
                    if (!m.mapArea || m.mapArea.length < 3) return null;
                    const c = MAP_COLORS[m.mapType] ?? MAP_COLORS.work;
                    const pts = m.mapArea.map((p) => gpsToSvg(p, bounds, MAP_SIZE, INNER_PADDING)).map((p) => `${p.x},${p.y}`).join(' ');
                    return <SvgPolygon key={m.mapId} points={pts} fill={c.fill} stroke={c.stroke} strokeWidth={2} strokeLinejoin="round" />;
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
                </Svg>
              </Animated.View>
            </GestureDetector>

            {/* Zoom hint */}
            <Text style={styles.zoomHint}>Pinch to zoom · Double-tap to reset</Text>
          </View>
        )}

        {/* Legend */}
        {maps.length > 0 && (
          <View style={styles.legend}>
            {maps.map((m) => {
              const c = MAP_COLORS[m.mapType] ?? MAP_COLORS.work;
              return (
                <View key={m.mapId} style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: c.stroke }]} />
                  <Text style={styles.legendText}>{m.mapName || m.mapType}</Text>
                </View>
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
