/**
 * StartMowSheet — bottom sheet for starting a mowing session.
 * Matches dashboard StartMowSheet: map selection, cutting height, path direction.
 *
 * Flow: set_para_info (height+direction) → start_run (with map + workArea)
 */
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ActivityIndicator,
  ScrollView,
  Alert,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Polygon, Line, G, Defs, ClipPath } from 'react-native-svg';
import { useStyles, useTheme, type Colors } from '../theme';
import { ApiClient, type MapData } from '../services/api';
import { getServerUrl } from '../services/auth';
import { useNavigation } from '@react-navigation/native';
import { PatternPicker } from './PatternPicker';
import { usePattern } from '../context/PatternContext';
import { transformToGps } from '../utils/patternUtils';
import { offsetLocalPolygon } from '../utils/polygonOffset';
import { useI18n } from '../i18n';

interface Props {
  visible: boolean;
  onClose: () => void;
  sn: string;
  onStarted: (settings: { cuttingHeight: number; pathDirection: number }) => void;
  initialSelectedMapId?: string | null;
  /** Als true: niet auto-selecteren wanneer er 1 werkzone is — forceer
   *  altijd bewuste zone-keuze. Gebruikt vanuit de "Specific zone" flow. */
  forceZonePicker?: boolean;
  battery?: number;
  isWorking?: boolean;
  currentCuttingHeight?: number;   // from sensor data (cm, 2-9)
  currentPathDirection?: number;   // from sensor data (degrees)
}

export function StartMowSheet({
  visible,
  onClose,
  sn,
  onStarted,
  initialSelectedMapId,
  forceZonePicker,
  battery,
  isWorking,
  currentCuttingHeight,
  currentPathDirection,
}: Props) {
  const navigation = useNavigation();
  const pattern = usePattern();
  const { t } = useI18n();
  const [maps, setMaps] = useState<MapData[]>([]);
  const [allMaps, setAllMaps] = useState<MapData[]>([]);
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  // Cutting height in user cm (2-9). Wire value is `cm - 2` (e.g. 4cm → cutterhigh:2).
  // Verified 2026-04-19 via a live Novabot-app capture on LFIN1231000211
  // (mqtt_node_20260419_163617_821948.log @ 18:18:09):
  //   User selected 4cm → MQTT {"start_navigation":{..."cutterhigh":2...}}
  //   → robot_decision "Start task ... height: 40"
  //   → coverage_planner "Setting blade height to : 40"
  //   → chassis set_blade_height_cb(5) → BLADE_HEIGHT_GET = 40 mm ✓
  // Firmware formula: physical_mm = (cutterhigh + 2) * 10.
  // Earlier debug runs grepped the WRONG mqtt_node log (PID 2828 had already crashed
  // before the Novabot test), which is why I briefly got the direction reversed.
  const [cuttingHeight, setCuttingHeight] = useState(5);
  const [pathDirection, setPathDirection] = useState(0);
  const [starting, setStarting] = useState(false);
  const [patternId, setPatternId] = useState<number | null>(null);
  const [patternSize, setPatternSize] = useState(15); // meters
  const [patternRotation, setPatternRotation] = useState(0);
  const [patternCenter, setPatternCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [edgeOffset, setEdgeOffset] = useState(0); // meters: negative=shrink, positive=expand
  const [previewing, setPreviewing] = useState(false);

  const styles = useStyles(makeStyles);
  const { colors } = useTheme();

  // Load maps when sheet opens
  useEffect(() => {
    if (!visible || !sn) return;
    // `currentCuttingHeight` comes from sensor cache. We accept multiple encodings
    // because legacy server/app versions used different units:
    //   20-90 → legacy mm (firmware mm), cm = value / 10
    //   10-90 → legacy mm variant, same conversion
    //    3-11 → legacy `cm + 2` wire value (our earlier bug), cm = value - 2
    //    0-9  → NEW wire value post-fix = `cm + 2`... wait no, NEW wire = cm - 2
    //           so value = cm - 2 means user cm = value + 2 (for 0..7)
    //   2-9   → already user cm
    const raw = currentCuttingHeight ?? 5;
    let cm = 5;
    if (raw >= 20 && raw <= 90) cm = Math.round(raw / 10);           // mm
    else if (raw >= 10 && raw < 20) cm = Math.round(raw / 10);       // mm edge
    else if (raw >= 0 && raw <= 7) cm = raw + 2;                     // new wire
    else if (raw >= 2 && raw <= 9) cm = raw;                         // user cm
    if (cm < 2) cm = 2;
    if (cm > 9) cm = 9;
    setCuttingHeight(cm);
    setPathDirection(currentPathDirection ?? 0);
    (async () => {
      try {
        const url = await getServerUrl();
        if (!url) return;
        const api = new ApiClient(url);
        const res = await api.fetchMaps(sn);
        const all = res.maps ?? [];
        setAllMaps(all);
        const workMaps = all.filter(m => m.mapType === 'work' && m.mapArea?.length >= 3);
        setMaps(workMaps);
        const requestedMap = initialSelectedMapId
          ? workMaps.find((map) => map.mapId === initialSelectedMapId)
          : null;
        if (requestedMap) setSelectedMapId(requestedMap.mapId);
        else if (workMaps.length === 1 && !forceZonePicker) setSelectedMapId(workMaps[0].mapId);
        else setSelectedMapId(null);
      } catch { /* ignore */ }
    })();
  }, [visible, sn, currentCuttingHeight, currentPathDirection, initialSelectedMapId, forceZonePicker]);

  // Check if a unicom (channel) exists for the selected map
  const hasUnicom = allMaps.some(m => m.mapType === 'unicom' && m.mapArea?.length >= 2);

  // Send set_para_info ONLY with path_direction — matching Novabot (verified via
  // mower mqtt_node log). Sending the full bundle (sound/headlight/sensitivity/
  // manual_controller_*) overrides user settings every time the compass moves:
  // specifically `headlight: 0` was flipping the dock LED from 255 back to off
  // via the server's led_bridge translation (dashboard.ts:1508-1510).
  const sendPathDirection = async (deg: number) => {
    try {
      const url = await getServerUrl();
      if (!url || !sn) return;
      const api = new ApiClient(url);
      await api.sendCommand(sn, { set_para_info: { path_direction: deg } });
      console.log(`[StartMow] set_para_info sent: path_direction=${deg}`);
    } catch { /* ignore */ }
  };

  const handleStart = async () => {
    // Pre-start checks (matches Flutter button_intercept.dart sequence)

    // 1. lowBatteryIntercept: battery < 20%
    if (battery != null && battery < 20) {
      Alert.alert(
        t('lowBattery') || 'Low Battery',
        `${t('lowBatteryDesc') || 'Battery is at'} ${battery}%. ${t('pleaseCharge') || 'Please wait for charging to complete.'}`,
      );
      return;
    }

    // 2. noMap0Intercept: no work map
    if (maps.length === 0) {
      Alert.alert(
        t('noMap') || 'No Map',
        t('noMapDesc') || 'No work area found. Please create a map first.',
        [
          {
            text: t('create') || 'Create',
            onPress: () => { onClose(); (navigation as any).navigate('Map', { screen: 'Mapping' }); },
          },
          { text: t('cancel') || 'Cancel', style: 'cancel' },
        ],
      );
      return;
    }

    // 3. noCharingUnicomIntercept: no channel (warning, not blocking)
    if (!hasUnicom) {
      Alert.alert(
        t('channelRequired') || 'Channel Required',
        t('channelRequiredDesc') || 'The distance from your charging station to the lawn exceeds 1.5m, or it is not directly facing the lawn. You need to create a channel.',
        [
          {
            text: t('create') || 'Create',
            onPress: () => { onClose(); (navigation as any).navigate('Map', { screen: 'Mapping', params: { mode: 'channel' } }); },
          },
          { text: t('cancel') || 'Cancel', style: 'cancel' },
          { text: t('startAnyway') || 'Start Anyway', style: 'destructive', onPress: () => doStart() },
        ],
      );
      return;
    }

    // 4. workingIntercept: mower already working
    if (isWorking) {
      Alert.alert(t('mowerBusy') || 'Mower Busy', t('mowerBusyDesc') || 'The mower is currently working.');
      return;
    }

    // 5. rainForecastIntercept: rain expected within ~3h (warn, not block)
    const rain = await fetchIncomingRain(sn);
    if (rain) {
      const timeLabel = new Date(rain.atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      Alert.alert(
        t('rainWarningTitle') || 'Rain Expected',
        t('rainWarningDesc', {
          time: timeLabel,
          mm: rain.mm.toFixed(1),
          prob: String(rain.prob),
        }) || `Rain is forecast around ${timeLabel} (${rain.mm.toFixed(1)}mm · ${rain.prob}%). Start mowing anyway?`,
        [
          { text: t('cancel') || 'Cancel', style: 'cancel' },
          { text: t('startAnyway') || 'Start Anyway', style: 'destructive', onPress: () => doStart() },
        ],
      );
      return;
    }

    doStart();
  };

  // Returns the first hour within the next ~3h where rain is likely, or null.
  async function fetchIncomingRain(mowerSn: string): Promise<{ atMs: number; mm: number; prob: number } | null> {
    try {
      const url = await getServerUrl();
      if (!url || !mowerSn) return null;
      const res = await fetch(`${url}/api/dashboard/rain-forecast/${encodeURIComponent(mowerSn)}`);
      const data = await res.json() as { available?: boolean; upcoming?: Array<{ time: string; mm: number; prob: number }> };
      if (!data.available || !data.upcoming?.length) return null;
      const now = Date.now();
      const horizon = 3 * 60 * 60 * 1000;
      for (const h of data.upcoming) {
        const at = new Date(h.time).getTime();
        if (at < now || at - now > horizon) continue;
        if (h.mm >= 0.1 || h.prob >= 50) return { atMs: at, mm: h.mm, prob: h.prob };
      }
      return null;
    } catch {
      return null;
    }
  }

  const doStart = async () => {
    setStarting(true);
    try {
      if (!sn) { console.log('[StartMow] NO SN!'); return; }
      const url = await getServerUrl();
      if (!url) { console.log('[StartMow] NO SERVER URL!'); return; }
      const api = new ApiClient(url);

      // Map area parameter: 1=map0, 10=map1, 200=map2 (Flutter decompilation)
      const selectedIdx = maps.findIndex(m => m.mapId === selectedMapId);
      const mapIdx = selectedIdx >= 0 ? selectedIdx : 0;
      const areaParam = mapIdx === 0 ? 1 : mapIdx === 1 ? 10 : 200;

      // 0. Clear old trail from previous session
      await api.clearTrail(sn).catch(() => {});

      // Note: set_para_info (path_direction etc.) is sent when the user CHANGES the
      // direction in the compass picker below — not here at start time.
      // This matches the official Novabot app where set_para_info is sent from
      // Advanced Settings (separate screen), not during the start mowing flow.

      // Wire value = display cm − 2 (see cuttingHeight comment). For 4cm → 2.
      const wireHeight = Math.max(0, cuttingHeight - 2);

      // Start mowing — Flutter v2.4.0 stuurt start_navigation direct
      const cmdNum = Date.now() % 100000;
      const navCmd = {
        start_navigation: {
          mapName: 'test',
          cutterhigh: wireHeight,
          area: areaParam,
          cmd_num: cmdNum,
        },
      };
      console.log('[StartMow] Sending start_navigation:', JSON.stringify(navCmd));
      const navResult = await api.sendCommand(sn, navCmd);

      // Fallback: old protocol
      if (!navResult.ok) {
        console.log('[StartMow] start_navigation failed, trying start_run');
        const runCmd = {
          start_run: { mapName: null, area: areaParam, cutterhigh: wireHeight },
          targetIsMower: false,
        };
        console.log('[StartMow] Sending start_run:', JSON.stringify(runCmd));
        await api.sendCommand(sn, runCmd);
      }

      // Report back display cm so HomeScreen's mismatch check compares like-for-like
      // (target_height will equal wireHeight = cm+2, not cm).
      onStarted({ cuttingHeight: wireHeight, pathDirection });
      onClose();
    } catch (err) { console.log('[StartMow] ERROR:', err); }
    setStarting(false);
  };

  const workMaps = maps;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity style={styles.backdrop} onPress={onClose} activeOpacity={1} />

        <View style={styles.sheet}>
          {/* Drag handle */}
          <View style={styles.handleBar}>
            <View style={styles.handle} />
          </View>

          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.title}>{t('startMowTitle')}</Text>

            {/* Work area selection */}
            {workMaps.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.label}>{t('workArea')}</Text>
                <View style={styles.mapGrid}>
                  <TouchableOpacity
                    style={[styles.mapBtn, selectedMapId === null && styles.mapBtnActive]}
                    onPress={() => setSelectedMapId(null)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.mapBtnText, selectedMapId === null && styles.mapBtnTextActive]}>
                      {t('allAreas')}
                    </Text>
                  </TouchableOpacity>
                  {workMaps.map(m => (
                    <TouchableOpacity
                      key={m.mapId}
                      style={[styles.mapBtn, selectedMapId === m.mapId && styles.mapBtnActive]}
                      onPress={() => setSelectedMapId(m.mapId)}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.mapBtnText, selectedMapId === m.mapId && styles.mapBtnTextActive]}>
                        {m.mapName || m.mapId}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {workMaps.length === 0 && (
              <View style={styles.noMaps}>
                <Ionicons name="map-outline" size={24} color={colors.textMuted} />
                <Text style={styles.noMapsText}>{t('noMaps')}</Text>
              </View>
            )}

            {/* Cutting height — user cm (2-9). Wire value is cm+2 (see doStart). */}
            <View style={styles.section}>
              <View style={styles.labelRow}>
                <Text style={styles.label}>{t('cuttingHeight')}</Text>
                <Text style={styles.labelValue}>{cuttingHeight} cm</Text>
              </View>
              <View style={styles.stepperRow}>
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => setCuttingHeight(Math.max(2, cuttingHeight - 1))}
                  activeOpacity={0.7}
                >
                  <Ionicons name="remove" size={20} color={colors.emerald} />
                </TouchableOpacity>
                <View style={styles.stepperValue}>
                  <Text style={styles.stepperText}>{cuttingHeight} cm</Text>
                </View>
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => setCuttingHeight(Math.min(9, cuttingHeight + 1))}
                  activeOpacity={0.7}
                >
                  <Ionicons name="add" size={20} color={colors.emerald} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Path direction */}
            <View style={styles.section}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={styles.label}>{t('pathDirection')}</Text>
                <Text style={styles.labelValue}>{pathDirection}°</Text>
              </View>
              <View style={styles.stepperRow}>
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => {
                    const deg = Math.max(0, pathDirection - 15);
                    setPathDirection(deg);
                    sendPathDirection(deg);
                  }}
                  activeOpacity={0.7}
                >
                  <Ionicons name="remove" size={20} color={colors.emerald} />
                </TouchableOpacity>
                <View style={styles.stepperValue}>
                  <Text style={styles.stepperText}>{pathDirection}°</Text>
                </View>
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => {
                    const deg = Math.min(180, pathDirection + 15);
                    setPathDirection(deg);
                    sendPathDirection(deg);
                  }}
                  activeOpacity={0.7}
                >
                  <Ionicons name="add" size={20} color={colors.emerald} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Edge offset */}
            <View style={styles.section}>
              <View style={styles.labelRow}>
                <Text style={styles.label}>{t('edgeOffset')}</Text>
                <Text style={[styles.labelValue, {
                  color: edgeOffset === 0 ? colors.textMuted : edgeOffset > 0 ? '#60a5fa' : '#fb923c',
                }]}>
                  {edgeOffset > 0 ? '+' : ''}{edgeOffset.toFixed(1)}m
                </Text>
              </View>
              <View style={styles.stepperRow}>
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => setEdgeOffset(Math.max(-1, +(edgeOffset - 0.1).toFixed(1)))}
                  activeOpacity={0.7}
                >
                  <Text style={{ color: '#fb923c', fontWeight: '700', fontSize: 16 }}>−</Text>
                </TouchableOpacity>
                <View style={styles.stepperValue}>
                  <Text style={[styles.stepperText, { fontSize: 16 }]}>
                    {edgeOffset === 0 ? t('noOffset') : edgeOffset > 0 ? t('expand') : t('shrink')}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => setEdgeOffset(Math.min(1, +(edgeOffset + 0.1).toFixed(1)))}
                  activeOpacity={0.7}
                >
                  <Text style={{ color: '#60a5fa', fontWeight: '700', fontSize: 16 }}>+</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Inline map preview */}
            {(() => {
              const previewMap = selectedMapId
                ? maps.find(m => m.mapId === selectedMapId)
                : maps[0];
              const poly = previewMap?.mapArea;
              if (!poly || poly.length < 3) return null;

              const finalPoly = edgeOffset !== 0 ? offsetLocalPolygon(poly, edgeOffset) : poly;
              const allPts = [...poly, ...finalPoly];
              const minX = Math.min(...allPts.map(p => p.x));
              const maxX = Math.max(...allPts.map(p => p.x));
              const minY = Math.min(...allPts.map(p => p.y));
              const maxY = Math.max(...allPts.map(p => p.y));
              const xRange = maxX - minX || 0.1;
              const yRange = maxY - minY || 0.1;
              const SIZE = 200;
              const PAD = 12;
              const draw = SIZE - PAD * 2;
              const sc = Math.min(draw / xRange, draw / yRange);

              const toSvg = (p: { x: number; y: number }) => ({
                x: PAD + (maxX - p.x) * sc + (draw - xRange * sc) / 2,
                y: PAD + (p.y - minY) * sc + (draw - yRange * sc) / 2,
              });

              const origPts = poly.map(toSvg).map(p => `${p.x},${p.y}`).join(' ');
              const offsetPts = edgeOffset !== 0
                ? finalPoly.map(toSvg).map(p => `${p.x},${p.y}`).join(' ')
                : null;

              // Direction stripes
              // Stripes run ALONG the path direction (mower drives this way)
              // perpendicular spacing between stripes
              const rad = (pathDirection * Math.PI) / 180;
              const cx = SIZE / 2, cy = SIZE / 2;
              const stripes = Array.from({ length: 12 }, (_, i) => {
                const offset = (i - 6) * 12;
                const px = cx + Math.cos(rad + Math.PI / 2) * offset;
                const py = cy + Math.sin(rad + Math.PI / 2) * offset;
                return {
                  x1: px + Math.cos(rad) * SIZE,
                  y1: py + Math.sin(rad) * SIZE,
                  x2: px - Math.cos(rad) * SIZE,
                  y2: py - Math.sin(rad) * SIZE,
                };
              });

              // Pattern contours overlay
              let patternSvgPolys: string[] = [];
              if (patternId && patternCenter) {
                const { loadPattern } = require('../utils/patternUtils');
                const contours = loadPattern(patternId);
                patternSvgPolys = contours.map((c: Array<[number, number]>) => {
                  // Pattern center is stored as {lat: localY, lng: localX}
                  const cx = patternCenter.lng; // localX
                  const cy = patternCenter.lat; // localY
                  return c.map(([nx, ny]: [number, number]) => {
                    // Pattern points are normalized -1..1, scale by patternSize
                    const rad = (patternRotation * Math.PI) / 180;
                    const rx = nx * Math.cos(rad) - ny * Math.sin(rad);
                    const ry = nx * Math.sin(rad) + ny * Math.cos(rad);
                    const localPt = { x: cx + rx * patternSize / 2, y: cy + ry * patternSize / 2 };
                    const svgPt = toSvg(localPt);
                    return `${svgPt.x},${svgPt.y}`;
                  }).join(' ');
                });
              }

              // Tap handler: convert SVG coords back to local meters for pattern placement
              const handlePreviewTap = (evt: { nativeEvent: { locationX: number; locationY: number } }) => {
                if (!patternId) return;
                const tx = evt.nativeEvent.locationX - 8;
                const ty = evt.nativeEvent.locationY - 8;
                const localX = maxX - (tx - PAD - (draw - xRange * sc) / 2) / sc;
                const localY = minY + (ty - PAD - (draw - yRange * sc) / 2) / sc;
                setPatternCenter({ lat: localY, lng: localX });
              };

              return (
                <View style={styles.section}>
                  <Text style={styles.label}>{patternId ? t('tapToPlacePattern') : t('preview')}</Text>
                  <View
                    style={{ alignItems: 'center', backgroundColor: colors.inputBg, borderRadius: 12, padding: 8 }}
                    onStartShouldSetResponder={() => !!patternId}
                    onResponderRelease={handlePreviewTap}
                  >
                    <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
                      <Defs>
                        <ClipPath id="previewClip">
                          <Polygon points={origPts} />
                        </ClipPath>
                      </Defs>
                      {/* Original polygon */}
                      <Polygon points={origPts} fill="rgba(34,197,94,0.15)" stroke="#22c55e" strokeWidth={1.5} />
                      {/* Direction stripes clipped to polygon */}
                      <G clipPath="url(#previewClip)">
                        {stripes.map((s, i) => (
                          <Line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                            stroke="rgba(34,197,94,0.2)" strokeWidth={6} />
                        ))}
                      </G>
                      {/* Edge offset polygon */}
                      {offsetPts && (
                        <Polygon points={offsetPts} fill="none"
                          stroke={edgeOffset > 0 ? '#60a5fa' : '#fb923c'}
                          strokeWidth={1.5} strokeDasharray="4 3" />
                      )}
                      {/* Pattern overlay */}
                      {patternSvgPolys.map((pts, i) => (
                        <Polygon key={`pat-${i}`} points={pts}
                          fill="rgba(168,85,247,0.25)" stroke="#a855f7"
                          strokeWidth={1.5} strokeDasharray="5 3" />
                      ))}
                    </Svg>
                  </View>
                </View>
              );
            })()}

            {/* Pattern picker */}
            <View style={styles.section}>
              <PatternPicker selected={patternId} onSelect={(id) => { setPatternId(id); setPatternCenter(null); }} />
              {patternId && (
                <View style={{ gap: 8, marginTop: 8 }}>
                  {/* Size + Rotation controls */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ color: colors.textMuted, fontSize: 12 }}>{t('patternSize')}:</Text>
                    <TouchableOpacity
                      style={{ padding: 6, backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: 6 }}
                      onPress={() => setPatternSize(Math.max(1, patternSize - 1))}
                    >
                      <Ionicons name="remove" size={14} color={colors.emerald} />
                    </TouchableOpacity>
                    <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14, width: 36, textAlign: 'center' }}>{patternSize}m</Text>
                    <TouchableOpacity
                      style={{ padding: 6, backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: 6 }}
                      onPress={() => setPatternSize(Math.min(50, patternSize + 1))}
                    >
                      <Ionicons name="add" size={14} color={colors.emerald} />
                    </TouchableOpacity>

                    <Text style={{ color: colors.textMuted, fontSize: 12, marginLeft: 8 }}>{t('patternRotation')}:</Text>
                    <TouchableOpacity
                      style={{ padding: 6, backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: 6 }}
                      onPress={() => setPatternRotation((patternRotation + 345) % 360)}
                    >
                      <Ionicons name="return-up-back" size={14} color={colors.emerald} />
                    </TouchableOpacity>
                    <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14, width: 36, textAlign: 'center' }}>{patternRotation}°</Text>
                    <TouchableOpacity
                      style={{ padding: 6, backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: 6 }}
                      onPress={() => setPatternRotation((patternRotation + 15) % 360)}
                    >
                      <Ionicons name="return-up-forward" size={14} color={colors.emerald} />
                    </TouchableOpacity>
                  </View>
                  {!patternCenter && (
                    <Text style={{ fontSize: 11, color: colors.purple, textAlign: 'center' }}>
                      {t('tapPreviewToPlace')}
                    </Text>
                  )}
                </View>
              )}
            </View>

            {/* Action buttons */}
            <View style={styles.actionRow}>
              <TouchableOpacity style={styles.cancelBtn} onPress={onClose} disabled={starting} activeOpacity={0.7}>
                <Text style={styles.cancelText}>{t('cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.startBtn, (starting || workMaps.length === 0) && { opacity: 0.5 }]}
                onPress={handleStart}
                disabled={starting || workMaps.length === 0}
                activeOpacity={0.7}
              >
                {starting ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <>
                    <Ionicons name="play" size={18} color={colors.white} />
                    <Text style={styles.startText}>{t('startMowing')}</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    backgroundColor: c.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
    borderWidth: 1,
    borderColor: c.cardBorder,
    borderBottomWidth: 0,
  },
  handleBar: { alignItems: 'center', paddingVertical: 12 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(125,125,125,0.4)' },
  content: { paddingHorizontal: 20, paddingBottom: Platform.OS === 'ios' ? 40 : 20, gap: 20 },
  title: { fontSize: 20, fontWeight: '700', color: c.text },
  section: { gap: 8 },
  label: { fontSize: 13, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  labelValue: { fontSize: 14, fontWeight: '700', color: c.text },
  mapGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  mapBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.cardBorder,
  },
  mapBtnActive: { backgroundColor: 'rgba(16,185,129,0.2)', borderColor: c.emerald },
  mapBtnText: { fontSize: 13, fontWeight: '600', color: c.textDim },
  mapBtnTextActive: { color: c.emerald },
  noMaps: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, backgroundColor: c.inputBg, borderRadius: 10 },
  noMapsText: { fontSize: 13, color: c.textDim, flex: 1 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepperBtn: {
    width: 40, height: 40, borderRadius: 10,
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.cardBorder,
    justifyContent: 'center', alignItems: 'center',
  },
  stepperValue: { flex: 1, alignItems: 'center' },
  stepperText: { fontSize: 24, fontWeight: '700', color: c.text },
  compassGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  compassBtn: {
    width: '22%',
    height: 36,
    borderRadius: 8,
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.cardBorder,
    justifyContent: 'center',
    alignItems: 'center',
  },
  compassBtnActive: { backgroundColor: c.emerald, borderColor: c.emerald },
  compassText: { fontSize: 13, fontWeight: '700', color: c.textDim },
  compassTextActive: { color: c.white },
  actionRow: { flexDirection: 'row', gap: 12, paddingTop: 4 },
  cancelBtn: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.cardBorder,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cancelText: { fontSize: 14, fontWeight: '600', color: c.textDim },
  startBtn: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    backgroundColor: c.emerald,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  startText: { fontSize: 14, fontWeight: '700', color: c.white },
  previewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.cardBorder,
  },
  placeOnMapBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: 'rgba(168,85,247,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(168,85,247,0.3)',
  },
  placeOnMapText: { flex: 1, fontSize: 14, fontWeight: '600', color: c.purple },
  placedInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: 'rgba(16,185,129,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.2)',
  },
  placedText: { fontSize: 12, color: c.emerald, fontFamily: 'monospace' },
});
