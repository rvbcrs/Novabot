/**
 * StartMowSheet — bottom sheet for starting a mowing session.
 * Matches dashboard StartMowSheet: map selection, cutting height, path direction.
 *
 * Flow: set_para_info (height+direction) → mow_zone (mower-side orchestrator:
 * undock -> follow_unicom transit if needed -> coverage via robot_decision)
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ActivityIndicator,
  ScrollView,
  Platform,
  Switch,
} from 'react-native';
import { appAlertCompat } from '../context/AppAlertContext';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Polygon, Polyline, Line, G, Defs, ClipPath } from 'react-native-svg';
import { useStyles, useTheme, type Colors } from '../theme';
import { ApiClient, type LocalPoint, type MapData } from '../services/api';
import { getServerUrl } from '../services/auth';
import { useNavigation } from '@react-navigation/native';
import { useMowerState } from '../hooks/useMowerState';
import { PatternPicker } from './PatternPicker';
import { usePattern } from '../context/PatternContext';
import { transformToGps } from '../utils/patternUtils';
import { offsetLocalPolygon } from '../utils/polygonOffset';
import { useI18n } from '../i18n';

interface Props {
  visible: boolean;
  onClose: () => void;
  sn: string;
  onStarted: (settings: {
    cuttingHeight: number;
    pathDirection: number;
    mapIds: string[];
    activeMapId: string | null;
  }) => void;
  initialSelectedMapId?: string | null;
  /** Als true: niet auto-selecteren wanneer er 1 werkzone is — forceer
   *  altijd bewuste zone-keuze. Gebruikt vanuit de "Specific zone" flow. */
  forceZonePicker?: boolean;
  battery?: number;
  isWorking?: boolean;
  currentCuttingHeight?: number;   // from sensor data (cm, 2-9)
  currentPathDirection?: number;   // from sensor data (degrees)
  onPreviewPaths?: (paths: Array<{ id: string; points: LocalPoint[] }>) => void;
}

function previewMapIdsFromMaps(maps: MapData[]): number {
  const weights = new Set<number>();
  for (const map of maps) {
    const source = map.canonicalName ?? map.mapId;
    const match = source.match(/^map(\d+)$/);
    if (!match) continue;
    const idx = Number(match[1]);
    if (idx === 0) weights.add(1);
    else if (idx === 1) weights.add(10);
    else if (idx === 2) weights.add(100);
  }
  const mask = Array.from(weights).reduce((sum, value) => sum + value, 0);
  return mask || 1;
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
  onPreviewPaths,
}: Props) {
  const navigation = useNavigation();
  const pattern = usePattern();
  const { t } = useI18n();
  // Live sensor cache — via een ref zodat de async start-flow de ACTUELE
  // waarde kan pollen (de closure zou anders de render-time snapshot zien).
  const { devices } = useMowerState();
  const devicesRef = useRef(devices);
  devicesRef.current = devices;
  const [maps, setMaps] = useState<MapData[]>([]);
  const [allMaps, setAllMaps] = useState<MapData[]>([]);
  // Multi-select. Empty = nothing chosen, button disabled. Any number of maps
  // starts with ONE start_navigation carrying a bitmask `area` — the firmware
  // mows them all in sequence (no server queue, no client loop).
  const [selectedMapIds, setSelectedMapIds] = useState<Set<string>>(new Set());
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
  const [stockPreviewPaths, setStockPreviewPaths] = useState<Array<{ id: string; points: LocalPoint[] }>>([]);
  // Rain confirmation modal — replaces the prior appAlertCompat.alert so we can host a
  // Switch ("Negeer regen deze sessie") inside the prompt itself.
  const [rainPrompt, setRainPrompt] = useState<{ mm: number; prob: number; atMs: number } | null>(null);
  const [rainIgnoreToggle, setRainIgnoreToggle] = useState(false);

  const styles = useStyles(makeStyles);
  const { colors } = useTheme();

  // Load maps when sheet opens
  // Issue #18: don't include currentCuttingHeight / currentPathDirection in
  // the deps. Those are sensor-cache values that re-flow whenever the mower
  // echoes set_para_info — including ourselves clicking the +/- buttons in
  // this very sheet. The previous deps array re-ran the effect on every
  // path-direction tap, which silently re-fetched maps and reset the
  // user's selection. We only want to seed defaults when the sheet first
  // OPENS (visible flips false→true), not on every prop nudge.
  const initialCuttingHeightRef = useRef(currentCuttingHeight);
  const initialPathDirectionRef = useRef(currentPathDirection);
  useEffect(() => {
    if (!visible || !sn) return;
    // Snapshot the live sensor values at OPEN time so subsequent prop
    // updates don't reset the form.
    initialCuttingHeightRef.current = currentCuttingHeight;
    initialPathDirectionRef.current = currentPathDirection;
    // `currentCuttingHeight` comes from sensor cache. We accept multiple encodings
    // because legacy server/app versions used different units:
    //   20-90 → legacy mm (firmware mm), cm = value / 10
    //   10-90 → legacy mm variant, same conversion
    //    3-11 → legacy `cm + 2` wire value (our earlier bug), cm = value - 2
    //    0-9  → NEW wire value post-fix = `cm + 2`... wait no, NEW wire = cm - 2
    //           so value = cm - 2 means user cm = value + 2 (for 0..7)
    //   2-9   → already user cm
    const raw = initialCuttingHeightRef.current ?? 5;
    let cm = 5;
    if (raw >= 20 && raw <= 90) cm = Math.round(raw / 10);           // mm
    else if (raw >= 10 && raw < 20) cm = Math.round(raw / 10);       // mm edge
    else if (raw >= 0 && raw <= 7) cm = raw + 2;                     // new wire
    else if (raw >= 2 && raw <= 9) cm = raw;                         // user cm
    if (cm < 2) cm = 2;
    if (cm > 9) cm = 9;
    setCuttingHeight(cm);
    setPathDirection(initialPathDirectionRef.current ?? 0);
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
        if (requestedMap) {
          setSelectedMapIds(new Set([requestedMap.mapId]));
        } else if (workMaps.length === 1 && !forceZonePicker) {
          setSelectedMapIds(new Set([workMaps[0].mapId]));
        } else {
          // Default to "all maps selected" so the common case (mow
          // everything) needs zero taps. Empty set forces the user to
          // pick something; that's only useful when forceZonePicker.
          setSelectedMapIds(forceZonePicker ? new Set() : new Set(workMaps.map(m => m.mapId)));
        }
      } catch { /* ignore */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sn, initialSelectedMapId, forceZonePicker]);

  // Check if a unicom (channel) exists for the selected map
  const hasUnicom = allMaps.some(m => m.mapType === 'unicom' && m.mapArea?.length >= 2);

  useEffect(() => {
    setStockPreviewPaths([]);
  }, [selectedMapIds, pathDirection, edgeOffset, patternId]);

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

  const handlePreview = async () => {
    if (!sn || selectedMapIds.size === 0) return;
    const selectedMaps = maps.filter(m => selectedMapIds.has(m.mapId));
    if (selectedMaps.length === 0) {
      appAlertCompat.alert(t('noMap') || 'No Map', t('previewNoArea') || 'Select a work area to preview');
      return;
    }
    setPreviewing(true);
    try {
      const url = await getServerUrl();
      if (!url) return;
      const api = new ApiClient(url);
      const paths = await api.refreshPreviewPath(sn, {
        covDirection: pathDirection,
        mapIds: previewMapIdsFromMaps(selectedMaps),
      });
      setStockPreviewPaths(paths);
      onPreviewPaths?.(paths);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      appAlertCompat.alert(t('error') || 'Error', detail || 'Could not load preview path');
    } finally {
      setPreviewing(false);
    }
  };

  const handleStart = async () => {
    // Pre-start checks (matches Flutter button_intercept.dart sequence)

    // 1. lowBatteryIntercept: battery < 20%
    if (battery != null && battery < 20) {
      appAlertCompat.alert(
        t('lowBattery') || 'Low Battery',
        `${t('lowBatteryDesc') || 'Battery is at'} ${battery}%. ${t('pleaseCharge') || 'Please wait for charging to complete.'}`,
      );
      return;
    }

    // 2. noMap0Intercept: no work map
    if (maps.length === 0) {
      appAlertCompat.alert(
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
      appAlertCompat.alert(
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
      appAlertCompat.alert(t('mowerBusy') || 'Mower Busy', t('mowerBusyDesc') || 'The mower is currently working.');
      return;
    }

    // 5. rainForecastIntercept: rain expected within ~3h.
    // Show inline modal with "Negeer regen deze sessie" toggle. Toggle off →
    // server's rain monitor will pause as soon as rain hits (current behaviour).
    // Toggle on → server records rain_ignore_session for this SN, monitor
    // skips pause until the mowing session ends.
    const rain = await fetchIncomingRain(sn);
    if (rain) {
      setRainIgnoreToggle(false);
      setRainPrompt(rain);
      return;
    }

    doStart();
  };

  /** User accepted the rain prompt. If toggle was on, set the per-session
   *  rain-ignore flag on the server before kicking off start_navigation. */
  const confirmRainStart = async () => {
    setRainPrompt(null);
    if (rainIgnoreToggle && sn) {
      try {
        const url = await getServerUrl();
        if (url) {
          const api = new ApiClient(url);
          await api.setRainIgnoreSession(sn, true);
        }
      } catch (e) {
        console.log('[StartMow] rain-ignore-session POST failed:', e);
      }
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
      if (selectedMapIds.size === 0) { console.log('[StartMow] NO MAP SELECTED'); return; }
      const url = await getServerUrl();
      if (!url) { console.log('[StartMow] NO SERVER URL!'); return; }
      const api = new ApiClient(url);

      // Re-fetch the CURRENT maps right before sending so the firmware `area`
      // enum is derived from the freshest canonical. A bundle restore can
      // re-assign map0<->map1; a stale list would send the wrong area and mow
      // the wrong zone (the "Voortuin -> Achtertuin" bug). If the refresh fails
      // or the selection no longer maps to a live work map, abort instead of
      // mowing blind.
      const freshRes = await api.fetchMaps(sn).catch(() => null);
      if (!freshRes) {
        appAlertCompat.alert(t('error') || 'Error', t('mapRefreshFailed') || 'Could not refresh the maps. Check the connection and try again.');
        return;
      }
      const freshWork = (freshRes.maps ?? []).filter(m => m.mapType === 'work' && (m.mapArea?.length ?? 0) >= 3);

      // Wire value = display cm − 2 (see cuttingHeight comment). For 4cm → 2.
      const wireHeight = Math.max(0, cuttingHeight - 2);

      // Maintain the order in which the maps appear in the FRESH work-map list
      // so the area-encoding (1=map0, 10=map1, 100=map2) is stable.
      const orderedMapIds = freshWork
        .filter(m => selectedMapIds.has(m.mapId))
        .map(m => m.mapId);
      if (orderedMapIds.length !== selectedMapIds.size) {
        // The live map list changed under us (restore / delete). Refresh the
        // picker and make the user re-confirm instead of mowing a stale slot.
        setAllMaps(freshRes.maps ?? []);
        setMaps(freshWork);
        setSelectedMapIds(new Set(orderedMapIds));
        appAlertCompat.alert(t('error') || 'Error', t('mapsChanged') || 'The map list changed (e.g. after a restore). Re-check your selection and start again.');
        return;
      }

      // Firmware `area` is a DECIMAL POSITIONAL BITMASK: each selected map's
      // canonical slot N contributes 10^N (map0=1, map1=10, map2=100). One
      // start_navigation with the summed area makes the firmware (robot_decision)
      // mow EVERY selected map in sequence, advancing between zones with NO dock
      // — proven in research/documents/multi-map-area-bitmask-decode.md. This
      // replaces the old server-side multi-zone queue: the firmware does it
      // natively, so single- and multi-map start are the exact same command.
      //
      // Slot comes from the canonical name (map0/map1/map2) so the user's pick
      // lines up with the mower's internal index — NOT the app's display order
      // (issue #14/#18: alphabetical order caused "select front, mow trampo").
      // ponytail: slots 0-9 only (10^slot must fit uint32); real setups have ≤3 maps.
      const slotOf = (mapId: string): number => {
        const m = freshWork.find(w => w.mapId === mapId);
        const canon = (m?.canonicalName ?? '').match(/^map(\d+)/);
        if (canon) return parseInt(canon[1], 10);
        const idx = freshWork.findIndex(w => w.mapId === mapId);
        return idx >= 0 ? idx : 0;
      };
      const areaParam = orderedMapIds.reduce((sum, mapId) => sum + Math.pow(10, slotOf(mapId)), 0);
      const selectedMap = freshWork.find(m => m.mapId === orderedMapIds[0]) ?? freshWork[0];

      // 0. Clear old trail from previous session
      await api.clearTrail(sn).catch(() => {});

      // Re-apply the user's saved para (mow direction + obstacle avoidance + lights/
      // sound/joystick) RIGHT BEFORE the mow. Mirrors mowingService.startMowing:
      // the mower does NOT persist set_para_info over a reconnect, so without this a
      // MANUAL start can begin with reset defaults — most critically perception_level
      // 0 (camera obstacle-avoidance OFF) and direction 0°. Both perception_level and
      // path_direction are captured at task START, so we send the FULL saved block
      // first (a partial block would reset the omitted fields to 0), let it settle
      // ~1500ms, then start_navigation. Only when the saved para is available —
      // otherwise start as before (never send a partial block).
      let paraSettled = false;
      try {
        const { settings } = await api.getDeviceSettings(sn);
        const para: Record<string, number> = {};
        const PARA_KEYS = ['headlight', 'sound', 'obstacle_avoidance_sensitivity', 'path_direction', 'manual_controller_v', 'manual_controller_w'];
        for (const k of PARA_KEYS) {
          const raw = settings[k];
          if (raw == null) continue;
          const n = Number(raw);
          if (Number.isFinite(n)) para[k] = n;
        }
        // The compass picker in this sheet is the live direction the user just chose;
        // it overrides the saved path_direction for this mow.
        if (typeof pathDirection === 'number') para.path_direction = pathDirection;
        if (Object.keys(para).length > 0) {
          await api.sendCommand(sn, { set_para_info: para });
          paraSettled = true;
        }
      } catch (e) {
        console.log('[StartMow] para re-apply skipped:', e);
      }
      if (paraSettled) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      // Start mowing — the mower-side `mow_zone` orchestrator now owns the
      // whole sequence (undock -> follow the recorded unicom transit when
      // needed -> coverage via robot_decision), streaming phase updates back
      // so HomeScreen can show the "following unicom" animation. `map` is the
      // FIRST selected zone's canonical slot; the firmware's own area
      // bitmask (areaParam) still drives multi-zone sequencing once coverage
      // starts, same as before.
      const mapSlot = selectedMap?.canonicalName ?? selectedMap?.mapName ?? 'map0';
      const mowZonePayload = {
        map: mapSlot,
        cutterhigh: wireHeight,
        area: areaParam,
        direction: pathDirection ?? null,
      };
      console.log('[StartMow] Sending mow_zone:', JSON.stringify(mowZonePayload));
      // mow_zone is fire-and-forget op de server (publishExtendedCommand):
      // ok:true betekent alleen dat het MQTT-bericht verstuurd is, NIET dat de
      // maaier het kent. Stock firmware heeft geen extended_commands.py en
      // oudere custom builds missen de mow_zone handler — dan gebeurt er stil
      // niets. Daarom: kort wachten op de eerste fase-update van de
      // orchestrator (mow_zone_phase in de sensor cache); blijft die uit, dan
      // klassiek starten. Dubbelstart kan niet: is de mow_zone tóch bezig
      // (signaal kwijt), dan wijst de firmware de tweede start af met
      // Error 2 "Already in running task".
      const phaseBefore = devicesRef.current.get(sn)?.sensors?.mow_zone_phase ?? null;
      const navResult = await api.mowZone(sn, mowZonePayload);
      let mowZoneAlive = false;
      if (navResult.ok) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const phase = devicesRef.current.get(sn)?.sensors?.mow_zone_phase ?? null;
          if (phase !== null && phase !== phaseBefore) { mowZoneAlive = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      if (!mowZoneAlive) {
        // Klassiek pad — exact de pre-mow_zone flow (incl. legacy start_run
        // fallback), zodat stock firmware en oudere custom builds blijven werken.
        console.log('[StartMow] mow_zone niet bevestigd — fallback naar start_navigation');
        const navCmd = {
          start_navigation: {
            mapName: 'test',
            cutterhigh: wireHeight,
            area: areaParam,
            cmd_num: Date.now() % 100000,
          },
        };
        const classic = await api.sendCommand(sn, navCmd);
        if (!classic.ok) {
          console.log('[StartMow] start_navigation failed, trying start_run');
          await api.sendCommand(sn, {
            start_run: { mapName: null, area: areaParam, cutterhigh: wireHeight },
            targetIsMower: false,
          });
        }
      }

      // Report back display cm so HomeScreen's mismatch check compares like-for-like
      // (target_height will equal wireHeight = cm+2, not cm).
      onStarted({
        cuttingHeight: wireHeight,
        pathDirection,
        mapIds: orderedMapIds,
        activeMapId: selectedMap?.mapId ?? null,
      });
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

            {/* Work area selection (multi-select).
                Tapping "All" toggles every map; tapping a single map
                chip toggles its membership. Two or more selected
                triggers the sequential queue when Start is pressed. */}
            {workMaps.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.label}>{t('workArea')}</Text>
                <View style={styles.mapGrid}>
                  <TouchableOpacity
                    style={[
                      styles.mapBtn,
                      selectedMapIds.size === workMaps.length && styles.mapBtnActive,
                    ]}
                    onPress={() => {
                      if (selectedMapIds.size === workMaps.length) {
                        setSelectedMapIds(new Set());
                      } else {
                        setSelectedMapIds(new Set(workMaps.map(m => m.mapId)));
                      }
                    }}
                    activeOpacity={0.7}
                  >
                    <Text style={[
                      styles.mapBtnText,
                      selectedMapIds.size === workMaps.length && styles.mapBtnTextActive,
                    ]}>
                      {t('allAreas')}
                    </Text>
                  </TouchableOpacity>
                  {workMaps.map(m => {
                    const active = selectedMapIds.has(m.mapId);
                    return (
                      <TouchableOpacity
                        key={m.mapId}
                        style={[styles.mapBtn, active && styles.mapBtnActive]}
                        onPress={() => {
                          setSelectedMapIds(prev => {
                            const next = new Set(prev);
                            if (next.has(m.mapId)) next.delete(m.mapId);
                            else next.add(m.mapId);
                            return next;
                          });
                        }}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.mapBtnText, active && styles.mapBtnTextActive]}>
                          {m.mapName || m.mapId}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
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

            {/* Inline map preview — issue #18: previously rendered ONLY
                the first selected polygon (in work-map array order), so
                changing zone selection didn't update the visible shape
                when more than one was picked. Render every selected
                polygon now so the preview always reflects the actual
                user choice. */}
            {(() => {
              const selectedPolys = maps
                .filter(m => selectedMapIds.has(m.mapId))
                .map(m => m.mapArea)
                .filter(p => p && p.length >= 3);
              // Issue #46.3: when nothing is selected we used to fall back
              // to maps[0] so the preview frame stayed visible — but that
              // showed a polygon the user hadn't picked, with stripes
              // running through it, which is confusing. Show a placeholder
              // hint instead so the user knows they need to tap a zone.
              if (selectedPolys.length === 0) {
                return (
                  <View style={styles.section}>
                    <Text style={styles.label}>{t('preview')}</Text>
                    <View
                      style={{ alignItems: 'center', justifyContent: 'center',
                        backgroundColor: colors.inputBg, borderRadius: 12,
                        padding: 24, minHeight: 120 }}
                    >
                      <Text style={{ color: colors.textMuted, fontSize: 13 }}>
                        {t('previewNoArea') ?? 'Select a work area to preview'}
                      </Text>
                    </View>
                  </View>
                );
              }
              const fallback = selectedPolys;

              // Compute edge-offset variant of each selected polygon (for
              // the dashed inner/outer ring overlay).
              const offsetPolys = edgeOffset !== 0
                ? fallback.map(p => offsetLocalPolygon(p, edgeOffset))
                : null;

              // Bounding box over EVERY selected polygon + their offsets,
              // so the preview frames the full selection (not a single
              // polygon that's then drawn off-centre).
              const allPts = fallback.flat().concat(offsetPolys ? offsetPolys.flat() : []);
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

              // Issue #46 + #18: align with MapScreen / LiveMapView /
              // MowingProgressMap so the inline preview is north-up like
              // every other map surface in the app. The previous version
              // flipped X and left Y direct, which mirrored the polygon
              // and put south at the top of the preview — exactly what
              // dir26738 reported when path-direction changes failed to
              // match the selected map.
              const toSvg = (p: { x: number; y: number }) => ({
                x: PAD + (p.x - minX) * sc + (draw - xRange * sc) / 2,
                y: PAD + (maxY - p.y) * sc + (draw - yRange * sc) / 2,
              });

              const origPolys = fallback.map(p => p.map(toSvg).map(pt => `${pt.x},${pt.y}`).join(' '));
              const offsetPolyStrings = offsetPolys
                ? offsetPolys.map(p => p.map(toSvg).map(pt => `${pt.x},${pt.y}`).join(' '))
                : null;
              const previewPolylineStrings = stockPreviewPaths
                .map(path => path.points
                  .map(toSvg)
                  .map(pt => `${pt.x},${pt.y}`)
                  .join(' '))
                .filter(points => points.split(' ').length >= 2);
              // Tap-to-place pattern still anchors on the first selected
              // polygon so the existing pattern flow keeps working.
              const poly = fallback[0];

              // Direction stripes
              // Stripes run ALONG the path direction (mower drives this way)
              // perpendicular spacing between stripes
              const rad = (pathDirection * Math.PI) / 180;
              const cx = SIZE / 2, cy = SIZE / 2;
              // Fine mowing lines (perpendicular spacing) covering the whole box.
              const STRIPE_SPACING = 8;
              const stripeHalf = Math.ceil((SIZE * 1.45) / 2 / STRIPE_SPACING);
              const stripes = Array.from({ length: stripeHalf * 2 + 1 }, (_, k) => {
                const i = k - stripeHalf;
                const offset = i * STRIPE_SPACING;
                const px = cx + Math.cos(rad + Math.PI / 2) * offset;
                const py = cy + Math.sin(rad + Math.PI / 2) * offset;
                return {
                  x1: px + Math.cos(rad) * SIZE,
                  y1: py + Math.sin(rad) * SIZE,
                  x2: px - Math.cos(rad) * SIZE,
                  y2: py - Math.sin(rad) * SIZE,
                  alt: i % 2 === 0,
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

              // Tap handler — inverse of toSvg. After the X/Y flip switch
              // the formulae are the mirror of the forward transform: X
              // goes back via (tx → minX + ...) and Y inverts again so a
              // tap near the top of the preview lands on a high local Y
              // (north), matching where the polygon actually is.
              const handlePreviewTap = (evt: { nativeEvent: { locationX: number; locationY: number } }) => {
                if (!patternId) return;
                const tx = evt.nativeEvent.locationX - 8;
                const ty = evt.nativeEvent.locationY - 8;
                const localX = minX + (tx - PAD - (draw - xRange * sc) / 2) / sc;
                const localY = maxY - (ty - PAD - (draw - yRange * sc) / 2) / sc;
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
                        {origPolys.map((pts, i) => (
                          <ClipPath key={`clip-${i}`} id={`previewClip-${i}`}>
                            <Polygon points={pts} />
                          </ClipPath>
                        ))}
                      </Defs>
                      {/* Outline + fill for every selected polygon. */}
                      {origPolys.map((pts, i) => (
                        <Polygon key={`poly-${i}`} points={pts} fill="rgba(34,197,94,0.22)"
                          stroke="#22c55e" strokeWidth={1.5} strokeLinejoin="round" />
                      ))}
                      {/* Direction stripes — drawn once per polygon so each
                          selected zone shows its own clipped pattern. */}
                      {previewPolylineStrings.length === 0 && origPolys.map((_pts, i) => (
                        <G key={`stripes-${i}`} clipPath={`url(#previewClip-${i})`}>
                          {stripes.map((s, j) => (
                            <Line key={j} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                              stroke={s.alt ? 'rgba(52,211,153,0.22)' : 'rgba(16,185,129,0.12)'}
                              strokeWidth={2.5} strokeLinecap="round" />
                          ))}
                        </G>
                      ))}
                      {previewPolylineStrings.map((pts, i) => (
                        <Polyline
                          key={`mower-preview-${i}`}
                          points={pts}
                          fill="none"
                          stroke="#e5e7eb"
                          strokeWidth={2.4}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      ))}
                      {/* Edge offset polygons. */}
                      {offsetPolyStrings && offsetPolyStrings.map((pts, i) => (
                        <Polygon key={`off-${i}`} points={pts} fill="none"
                          stroke={edgeOffset > 0 ? '#60a5fa' : '#fb923c'}
                          strokeWidth={1.5} strokeDasharray="4 3" />
                      ))}
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
                <Text style={styles.cancelText} numberOfLines={1}>{t('cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.previewBtn,
                  (previewing || starting || workMaps.length === 0 || selectedMapIds.size === 0 || patternId !== null || edgeOffset !== 0) && { opacity: 0.5 },
                ]}
                onPress={handlePreview}
                disabled={previewing || starting || workMaps.length === 0 || selectedMapIds.size === 0 || patternId !== null || edgeOffset !== 0}
                activeOpacity={0.7}
              >
                {previewing ? (
                  <ActivityIndicator size="small" color={colors.emerald} />
                ) : (
                  <>
                    <Ionicons name="eye" size={18} color={colors.emerald} />
                    <Text style={styles.previewText} numberOfLines={1}>{t('preview')}</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={[
                styles.startBtn,
                (starting || workMaps.length === 0 || selectedMapIds.size === 0) && { opacity: 0.5 },
              ]}
              onPress={handleStart}
              disabled={starting || workMaps.length === 0 || selectedMapIds.size === 0}
              activeOpacity={0.7}
            >
              {starting ? (
                <ActivityIndicator size="small" color={colors.white} />
              ) : (
                <>
                  <Ionicons name="play" size={18} color={colors.white} />
                  <Text style={styles.startText} numberOfLines={1}>{t('startMowing')}</Text>
                </>
              )}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>

      {/* Rain forecast confirmation modal — replaces the old appAlertCompat.alert so we
          can host an inline "Negeer regen deze sessie" Switch. */}
      <Modal
        visible={!!rainPrompt}
        transparent
        animationType="fade"
        onRequestClose={() => setRainPrompt(null)}
      >
        <View style={styles.rainModalBackdrop}>
          <View style={styles.rainModalCard}>
            <View style={styles.rainModalIconRow}>
              <Ionicons name="rainy" size={28} color="#60a5fa" />
              <Text style={styles.rainModalTitle}>{t('rainWarningTitle') || 'Regen voorspeld'}</Text>
            </View>

            {rainPrompt && (
              <Text style={styles.rainModalBody}>
                {(t('rainWarningDesc', {
                  time: new Date(rainPrompt.atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                  mm: rainPrompt.mm.toFixed(1),
                  prob: String(rainPrompt.prob),
                }) || `Regen voorspeld om ${new Date(rainPrompt.atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${rainPrompt.mm.toFixed(1)}mm · ${rainPrompt.prob}%). Toch maaien?`)}
              </Text>
            )}

            <View style={styles.rainModalToggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rainModalToggleLabel}>
                  {t('ignoreRainSession') || 'Negeer regen deze sessie'}
                </Text>
                <Text style={styles.rainModalToggleHint}>
                  {t('ignoreRainSessionHint') ||
                    'Aan: regen-pauze blijft uit tot deze maai-sessie eindigt. Uit: maaier pauzeert zodra regen valt.'}
                </Text>
              </View>
              <Switch
                value={rainIgnoreToggle}
                onValueChange={setRainIgnoreToggle}
                trackColor={{ false: '#374151', true: '#10b981' }}
                thumbColor={rainIgnoreToggle ? '#ecfdf5' : '#9ca3af'}
              />
            </View>

            <View style={styles.rainModalButtons}>
              <TouchableOpacity
                style={[styles.rainModalBtn, styles.rainModalBtnCancel]}
                onPress={() => setRainPrompt(null)}
              >
                <Text style={styles.rainModalBtnCancelText}>{t('cancel') || 'Annuleren'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.rainModalBtn, styles.rainModalBtnGo]}
                onPress={confirmRainStart}
              >
                <Text style={styles.rainModalBtnGoText}>{t('startMowing') || 'Start maaien'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
    height: 48,
    borderRadius: 12,
    backgroundColor: c.emerald,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  startText: { fontSize: 14, fontWeight: '700', color: c.white },
  previewBtn: {
    flex: 1,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.cardBorder,
  },
  previewText: { fontSize: 14, fontWeight: '700', color: c.emerald },
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

  // Rain confirmation modal
  rainModalBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  rainModalCard: {
    width: '100%', maxWidth: 380,
    backgroundColor: c.bg, borderRadius: 16, padding: 20,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  rainModalIconRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12,
  },
  rainModalTitle: { fontSize: 17, fontWeight: '700', color: c.text },
  rainModalBody: { fontSize: 14, color: c.text, lineHeight: 20, marginBottom: 16 },
  rainModalToggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 10, padding: 12, marginBottom: 16,
  },
  rainModalToggleLabel: { fontSize: 14, fontWeight: '600', color: c.text, marginBottom: 4 },
  rainModalToggleHint: { fontSize: 11, color: c.textDim, lineHeight: 15 },
  rainModalButtons: { flexDirection: 'row', gap: 10 },
  rainModalBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  rainModalBtnCancel: { backgroundColor: 'rgba(255,255,255,0.08)' },
  rainModalBtnCancelText: { color: c.text, fontSize: 14, fontWeight: '600' },
  rainModalBtnGo: { backgroundColor: '#10b981' },
  rainModalBtnGoText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
