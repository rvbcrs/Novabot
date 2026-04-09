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
import { colors } from '../theme/colors';
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
  battery?: number;       // mower battery percentage
  isWorking?: boolean;     // mower currently mowing/navigating
}

export function StartMowSheet({ visible, onClose, sn, onStarted, battery, isWorking }: Props) {
  const navigation = useNavigation();
  const pattern = usePattern();
  const { t } = useI18n();
  const [maps, setMaps] = useState<MapData[]>([]);
  const [allMaps, setAllMaps] = useState<MapData[]>([]);
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  // cutterhigh = height in mm (20-90, steps of 10). Flutter slider: min=20, max=90, divisions=7.
  // Values: 20, 30, 40, 50, 60, 70, 80, 90 (mm)
  const [cuttingHeight, setCuttingHeight] = useState(50);
  const [pathDirection, setPathDirection] = useState(0);
  const [starting, setStarting] = useState(false);
  const [patternId, setPatternId] = useState<number | null>(null);
  const [patternSize, setPatternSize] = useState(15); // meters
  const [patternRotation, setPatternRotation] = useState(0);
  const [patternCenter, setPatternCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [edgeOffset, setEdgeOffset] = useState(0); // meters: negative=shrink, positive=expand
  const [previewing, setPreviewing] = useState(false);

  // Load maps when sheet opens
  useEffect(() => {
    if (!visible || !sn) return;
    setCuttingHeight(50);
    setPathDirection(0);
    setSelectedMapId(null);
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
        if (workMaps.length === 1) setSelectedMapId(workMaps[0].mapId);
      } catch { /* ignore */ }
    })();
  }, [visible, sn]);

  // Check if a unicom (channel) exists for the selected map
  const hasUnicom = allMaps.some(m => m.mapType === 'unicom' && m.mapArea?.length >= 2);

  // Send set_para_info when user changes path direction (matches Flutter Advanced Settings flow)
  const sendPathDirection = async (deg: number) => {
    try {
      const url = await getServerUrl();
      if (!url || !sn) return;
      const api = new ApiClient(url);
      await api.sendCommand(sn, {
        set_para_info: {
          sound: 0,
          headlight: 0,
          path_direction: deg,
          obstacle_avoidance_sensitivity: 1,
          manual_controller_v: 300,
          manual_controller_w: 300,
        },
      });
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
            onPress: () => { onClose(); (navigation as any).navigate('AppSettings', { screen: 'Mapping' }); },
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
            onPress: () => { onClose(); (navigation as any).navigate('AppSettings', { screen: 'Mapping', params: { mode: 'channel' } }); },
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

    doStart();
  };

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

      // Start mowing — try new protocol first, then old
      // Flutter decompilation (LawnPageLogic::startMowing, 0x92cf0c):
      // New: {start_navigation: {mapName: "test", cutterhigh, area, cmd_num}}
      // Old: {start_run: {mapName: null, area, cutterhigh}, targetIsMower: false}
      const cmdNum = Date.now() % 100000;
      const navCmd = {
        start_navigation: {
          mapName: 'test',
          cutterhigh: cuttingHeight,
          area: areaParam,
          cmd_num: cmdNum,
        },
      };
      console.log('[StartMow] Sending start_navigation:', JSON.stringify(navCmd));
      const navResult = await api.sendCommand(sn, navCmd);

      // If start_navigation fails or device is offline, try old protocol
      if (!navResult.ok) {
        console.log('[StartMow] start_navigation failed, trying start_run');
        const runCmd = {
          start_run: { mapName: null, area: areaParam, cutterhigh: cuttingHeight },
          targetIsMower: false,
        };
        console.log('[StartMow] Sending start_run:', JSON.stringify(runCmd));
        await api.sendCommand(sn, runCmd);
      }

      onStarted({ cuttingHeight, pathDirection });
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

            {/* Cutting height */}
            <View style={styles.section}>
              <View style={styles.labelRow}>
                <Text style={styles.label}>{t('cuttingHeight')}</Text>
                <Text style={styles.labelValue}>{cuttingHeight / 10} cm</Text>
              </View>
              <View style={styles.stepperRow}>
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => setCuttingHeight(Math.max(20, cuttingHeight - 10))}
                  activeOpacity={0.7}
                >
                  <Ionicons name="remove" size={20} color={colors.white} />
                </TouchableOpacity>
                <View style={styles.stepperValue}>
                  <Text style={styles.stepperText}>{cuttingHeight / 10} cm</Text>
                </View>
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => setCuttingHeight(Math.min(90, cuttingHeight + 10))}
                  activeOpacity={0.7}
                >
                  <Ionicons name="add" size={20} color={colors.white} />
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
                  <Ionicons name="remove" size={20} color={colors.white} />
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
                  <Ionicons name="add" size={20} color={colors.white} />
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

              // Pattern contours for overlay (TODO: convert pattern to local coords)
              const patternSvgPolys: string[] = [];

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
                    style={{ alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 12, padding: 8 }}
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
                      style={{ padding: 6, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 6 }}
                      onPress={() => setPatternSize(Math.max(1, patternSize - 1))}
                    >
                      <Ionicons name="remove" size={14} color={colors.white} />
                    </TouchableOpacity>
                    <Text style={{ color: colors.white, fontWeight: '700', fontSize: 14, width: 36, textAlign: 'center' }}>{patternSize}m</Text>
                    <TouchableOpacity
                      style={{ padding: 6, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 6 }}
                      onPress={() => setPatternSize(Math.min(50, patternSize + 1))}
                    >
                      <Ionicons name="add" size={14} color={colors.white} />
                    </TouchableOpacity>

                    <Text style={{ color: colors.textMuted, fontSize: 12, marginLeft: 8 }}>{t('patternRotation')}:</Text>
                    <TouchableOpacity
                      style={{ padding: 6, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 6 }}
                      onPress={() => setPatternRotation((patternRotation + 345) % 360)}
                    >
                      <Ionicons name="return-up-back" size={14} color={colors.white} />
                    </TouchableOpacity>
                    <Text style={{ color: colors.white, fontWeight: '700', fontSize: 14, width: 36, textAlign: 'center' }}>{patternRotation}°</Text>
                    <TouchableOpacity
                      style={{ padding: 6, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 6 }}
                      onPress={() => setPatternRotation((patternRotation + 15) % 360)}
                    >
                      <Ionicons name="return-up-forward" size={14} color={colors.white} />
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

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderBottomWidth: 0,
  },
  handleBar: { alignItems: 'center', paddingVertical: 12 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)' },
  content: { paddingHorizontal: 20, paddingBottom: Platform.OS === 'ios' ? 40 : 20, gap: 20 },
  title: { fontSize: 20, fontWeight: '700', color: colors.white },
  section: { gap: 8 },
  label: { fontSize: 13, fontWeight: '700', color: '#a0a0b0', textTransform: 'uppercase', letterSpacing: 0.5 },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  labelValue: { fontSize: 14, fontWeight: '700', color: colors.white },
  mapGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  mapBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  mapBtnActive: { backgroundColor: 'rgba(16,185,129,0.2)', borderColor: colors.emerald },
  mapBtnText: { fontSize: 13, fontWeight: '600', color: '#a0a0b0' },
  mapBtnTextActive: { color: colors.emerald },
  noMaps: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 10 },
  noMapsText: { fontSize: 13, color: '#a0a0b0', flex: 1 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepperBtn: {
    width: 40, height: 40, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center', alignItems: 'center',
  },
  stepperValue: { flex: 1, alignItems: 'center' },
  stepperText: { fontSize: 24, fontWeight: '700', color: colors.white },
  compassGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  compassBtn: {
    width: '22%',
    height: 36,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.06)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  compassBtnActive: { backgroundColor: colors.emerald },
  compassText: { fontSize: 13, fontWeight: '700', color: '#a0a0b0' },
  compassTextActive: { color: colors.white },
  actionRow: { flexDirection: 'row', gap: 12, paddingTop: 4 },
  cancelBtn: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  cancelText: { fontSize: 14, fontWeight: '600', color: colors.textDim },
  startBtn: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.emerald,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  startText: { fontSize: 14, fontWeight: '700', color: colors.white },
  previewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
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
  placeOnMapText: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.purple },
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
  placedText: { fontSize: 12, color: colors.emerald, fontFamily: 'monospace' },
});
