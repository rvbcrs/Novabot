/**
 * Mapping screen — create new maps by driving the mower around boundaries.
 *
 * Two modes:
 * 1. Autonomous: mower drives itself (start_assistant_build_map)
 * 2. Manual: user controls via joystick (start_scan_map + joystick)
 *
 * Flow: Check GPS/Loc → Choose mode → Map in progress → Stop → Save
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { colors } from '../theme/colors';
import { useMowerState } from '../hooks/useMowerState';
import { getSocket } from '../services/socket';
import { ApiClient } from '../services/api';
import { getServerUrl } from '../services/auth';
import { useExperimental } from '../context/ExperimentalContext';
import { useI18n } from '../i18n';

type MappingState = 'idle' | 'mapping' | 'saving';
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

  const [mappingState, setMappingState] = useState<MappingState>('idle');
  const [mappingMode, setMappingMode] = useState<MappingMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // GPS / Localization readiness
  const gpsValid = sensors.gps_valid === '1' || sensors.gps_satellites !== undefined;
  const locQuality = parseInt(sensors.loc_quality ?? '0', 10);
  const locReady = locQuality >= 80;
  const mappingReady = gpsValid && locReady;

  // Detect if already mapping (from sensor data)
  const isMappingActive = sensors.start_edit_or_assistant_map_flag === '1' ||
    sensors.task_mode === '3';

  useEffect(() => {
    if (isMappingActive && mappingState === 'idle') {
      setMappingState('mapping');
    }
  }, [isMappingActive]);

  // Elapsed timer
  useEffect(() => {
    if (mappingState === 'mapping') {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [mappingState]);

  const sendCommand = useCallback((command: Record<string, unknown>, label: string) => {
    const socket = getSocket();
    if (!socket || !sn) return;
    setBusy(true);
    socket.emit('joystick:cmd', { sn, command });
    console.log(`[Mapping] Sent: ${label}`);
    setTimeout(() => setBusy(false), 1500);
  }, [sn]);

  const handleStartAutonomous = () => {
    Alert.alert(
      t('autoMapping'),
      'The mower will drive around autonomously to create a map of your garden. Make sure the area is clear of obstacles.',
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: 'Start',
          onPress: () => {
            sendCommand({ start_assistant_build_map: {} }, 'start_assistant_build_map');
            setMappingMode('autonomous');
            setMappingState('mapping');
          },
        },
      ],
    );
  };

  const handleStartManual = () => {
    Alert.alert(
      t('manualMapping'),
      'Drive the mower along the boundary of your garden using the joystick. Walk the entire perimeter, then tap Stop to finish.',
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: 'Start',
          onPress: () => {
            sendCommand({ start_scan_map: { mapname: 'home0' } }, 'start_scan_map');
            setMappingMode('manual');
            setMappingState('mapping');
          },
        },
      ],
    );
  };

  const handleStop = () => {
    Alert.alert(
      t('stopMapping'),
      t('stopMappingConfirm'),
      [
        { text: t('continueMapping'), style: 'cancel' },
        {
          text: t('stopAndSave'),
          onPress: async () => {
            sendCommand({ stop_scan_map: {} }, 'stop_scan_map');
            setMappingState('saving');

            // Wait a bit for the mower to process, then save
            setTimeout(() => {
              Alert.prompt(
                t('saveMap'),
                t('enterMapName'),
                async (name) => {
                  const mapName = name?.trim() || 'Garden';
                  sendCommand({ save_map: { mapname: 'home0', resolution: 0.05 } }, 'save_map');

                  // Wait for save to complete, then refresh
                  setTimeout(async () => {
                    try {
                      const url = await getServerUrl();
                      if (url) {
                        const api = new ApiClient(url);
                        // Rename the saved map
                        const maps = await api.fetchMaps(sn);
                        for (const m of maps.maps ?? []) {
                          if (m.mapType === 'work' && (!m.mapName || m.mapName.includes('map0'))) {
                            await fetch(`${url}/api/dashboard/maps/${encodeURIComponent(sn)}/${encodeURIComponent(m.mapId)}`, {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ mapName }),
                            });
                          }
                        }
                      }
                    } catch { /* ignore */ }

                    setMappingState('idle');
                    setMappingMode(null);
                    Alert.alert(t('mapSaved'), `"${mapName}" has been saved.`, [
                      { text: t('ok'), onPress: () => navigation.goBack() },
                    ]);
                  }, 3000);
                },
                'plain-text',
                'Garden',
              );
            }, 2000);
          },
        },
      ],
    );
  };

  const handleCancel = () => {
    Alert.alert(t('cancelMapping'), t('discardConfirm'), [
      { text: t('continueMapping'), style: 'cancel' },
      {
        text: t('discardMapping'),
        style: 'destructive',
        onPress: () => {
          sendCommand({ stop_scan_map: {} }, 'stop_scan_map (cancel)');
          sendCommand({ quit_mapping_mode: {} }, 'quit_mapping_mode');
          setMappingState('idle');
          setMappingMode(null);
        },
      },
    ]);
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.white} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('createMap')}</Text>
      </View>

      {!mower?.online ? (
        <View style={styles.centerBox}>
          <Ionicons name="alert-circle" size={48} color={colors.red} />
          <Text style={styles.centerTitle}>{t('mowerOffline')}</Text>
          <Text style={styles.centerSub}>{t('connectMowerToMap')}</Text>
        </View>
      ) : mappingState === 'idle' ? (
        /* ── Idle: readiness checks + mode selection ── */
        <View style={styles.content}>
          {/* Readiness */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t('readinessCheck')}</Text>
            <View style={styles.checkRow}>
              <View style={[styles.checkDot, { backgroundColor: gpsValid ? colors.green : colors.red }]} />
              <Text style={styles.checkText}>{t('gps')}: {gpsValid ? `${t('gpsOk')} (${sensors.gps_satellites ?? '?'} ${t('sats')})` : t('noSignal')}</Text>
            </View>
            <View style={styles.checkRow}>
              <View style={[styles.checkDot, { backgroundColor: locReady ? colors.green : colors.amber }]} />
              <Text style={styles.checkText}>{t('localization')}: {locQuality}%{locReady ? ` (${t('ready')})` : ` (${t('initializing')})`}</Text>
            </View>
            <View style={styles.checkRow}>
              <View style={[styles.checkDot, { backgroundColor: mower.online ? colors.green : colors.red }]} />
              <Text style={styles.checkText}>{t('mqtt')}: {t('connected')}</Text>
            </View>
            {!mappingReady && (
              <Text style={styles.warning}>
                {t('waitForGps')}
              </Text>
            )}
          </View>

          {/* Mode selection */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t('mappingMode')}</Text>

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
                    <Text style={[styles.modeBtnTitle, !mappingReady && { color: colors.textMuted }]}>{t('autoMapping')}</Text>
                    <View style={{ backgroundColor: 'rgba(168,85,247,0.2)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                      <Text style={{ color: '#a855f7', fontSize: 9, fontWeight: '700' }}>{t('beta')}</Text>
                    </View>
                  </View>
                  <Text style={styles.modeBtnSub}>{t('autoMappingSub')}</Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.textDim} />
              </TouchableOpacity>
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
                <Text style={[styles.modeBtnTitle, !mappingReady && { color: colors.textMuted }]}>{t('manualMapping')}</Text>
                <Text style={styles.modeBtnSub}>{t('manualMappingSub')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textDim} />
            </TouchableOpacity>
          </View>
        </View>
      ) : mappingState === 'mapping' ? (
        /* ── Mapping in progress ── */
        <View style={styles.content}>
          <View style={styles.progressCard}>
            <View style={styles.progressHeader}>
              <View style={styles.pulseOuter}>
                <View style={styles.pulseInner} />
              </View>
              <Text style={styles.progressTitle}>
                {mappingMode === 'autonomous' ? t('autoMapping') : t('manualMapping')}
              </Text>
            </View>

            <Text style={styles.timer}>{formatTime(elapsed)}</Text>

            <View style={styles.sensorRow}>
              <Text style={styles.sensorChip}>GPS: {sensors.gps_satellites ?? '?'} sats</Text>
              <Text style={styles.sensorChip}>Loc: {locQuality}%</Text>
              <Text style={styles.sensorChip}>Bat: {sensors.battery_power ?? sensors.battery_capacity ?? '?'}%</Text>
            </View>

            {mappingMode === 'manual' && (
              <Text style={styles.hint}>
                {t('useControlTab')}
              </Text>
            )}
            {mappingMode === 'autonomous' && (
              <Text style={styles.hint}>
                {t('mowerExploring')}
              </Text>
            )}
          </View>

          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel} activeOpacity={0.7}>
              <Ionicons name="close-circle" size={20} color={colors.red} />
              <Text style={[styles.actionText, { color: colors.red }]}>{t('discardMapping')}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.stopMapBtn} onPress={handleStop} activeOpacity={0.7}>
              <Ionicons name="checkmark-circle" size={20} color={colors.white} />
              <Text style={styles.actionText}>{t('stopAndSave')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        /* ── Saving ── */
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={colors.purple} />
          <Text style={styles.centerTitle}>{t('savingMap')}</Text>
          <Text style={styles.centerSub}>{t('processingBoundary')}</Text>
        </View>
      )}
    </View>
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
  content: { flex: 1, paddingHorizontal: 16, gap: 16 },
  centerBox: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  centerTitle: { fontSize: 20, fontWeight: '700', color: colors.white },
  centerSub: { fontSize: 14, color: colors.textMuted, textAlign: 'center' },
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
  progressCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.purple,
    alignItems: 'center',
    gap: 12,
  },
  progressHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pulseOuter: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: 'rgba(168,85,247,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pulseInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.purple,
  },
  progressTitle: { fontSize: 16, fontWeight: '700', color: colors.purple },
  timer: {
    fontSize: 48,
    fontWeight: '200',
    color: colors.white,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  sensorRow: { flexDirection: 'row', gap: 8 },
  sensorChip: {
    fontSize: 11,
    color: colors.textDim,
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  hint: { fontSize: 13, color: colors.textMuted, textAlign: 'center' },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
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
  actionText: { fontSize: 15, fontWeight: '700', color: colors.white },
});
