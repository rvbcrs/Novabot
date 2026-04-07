/**
 * Mower settings — cutting height, obstacle sensitivity, path direction.
 * Ported from dashboard SettingsPanel + Novabot app advanced settings.
 */
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { MowingDirectionPreview } from '../components/MowingDirectionPreview';
import { useMowerState } from '../hooks/useMowerState';
import { getSocket } from '../services/socket';
import { ApiClient } from '../services/api';
import { getServerUrl } from '../services/auth';

// Cutting height: 20-80 in steps of 5 (displayed as 2.0-8.0 cm)
const HEIGHT_VALUES = [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80];

// Obstacle sensitivity: 1=low, 2=medium, 3=high
const SENSITIVITY_LEVELS = [
  { value: 1, label: 'Low', desc: 'Less avoidance, more coverage' },
  { value: 2, label: 'Medium', desc: 'Balanced (recommended)' },
  { value: 3, label: 'High', desc: 'Maximum obstacle avoidance' },
];

// Path direction: 0-315° in 45° steps
const PATH_DIRECTIONS = [
  { angle: 0, label: 'N' }, { angle: 45, label: 'NE' },
  { angle: 90, label: 'E' }, { angle: 135, label: 'SE' },
  { angle: 180, label: 'S' }, { angle: 225, label: 'SW' },
  { angle: 270, label: 'W' }, { angle: 315, label: 'NW' },
];

export default function MowerSettingsScreen() {
  const insets = useSafeAreaInsets();
  const { devices } = useMowerState();
  const [cuttingHeight, setCuttingHeight] = useState(40);
  const [sensitivity, setSensitivity] = useState(2);
  const [pathDirection, setPathDirection] = useState(0);
  const [sending, setSending] = useState('');

  const mowerSn = useMemo(() => {
    return [...devices.values()].find((d) => d.deviceType === 'mower')?.sn ?? '';
  }, [devices]);

  const mower = useMemo(() => {
    return [...devices.values()].find((d) => d.deviceType === 'mower') ?? null;
  }, [devices]);

  const mowerOnline = mower?.online ?? false;

  // Load current values from sensor data
  useEffect(() => {
    if (!mower) return;
    const s = mower.sensors;
    if (s.defaultCuttingHeight) {
      const h = parseInt(s.defaultCuttingHeight, 10);
      if (h >= 20 && h <= 80) setCuttingHeight(h);
    }
    if (s.obstacle_avoidance_sensitivity) {
      const v = parseInt(s.obstacle_avoidance_sensitivity, 10);
      if (v >= 1 && v <= 3) setSensitivity(v);
    }
    if (s.path_direction) {
      const a = parseInt(s.path_direction, 10);
      if (a >= 0 && a <= 315) setPathDirection(a);
    }
  }, [mower?.sn]);

  const sendSetting = useCallback(async (label: string, fn: (api: ApiClient) => Promise<unknown>) => {
    setSending(label);
    try {
      const url = await getServerUrl();
      if (!url) return;
      const api = new ApiClient(url);
      await fn(api);
    } catch { /* ignore */ }
    finally { setSending(''); }
  }, []);

  const handleCuttingHeight = (height: number) => {
    setCuttingHeight(height);
    sendSetting('height', (api) => api.setCuttingHeight(mowerSn, height));
  };

  const handleSensitivity = (level: number) => {
    setSensitivity(level);
    sendSetting('sensitivity', (api) => api.setObstacleSensitivity(mowerSn, level));
  };

  const handlePathDirection = (angle: number) => {
    setPathDirection(angle);
    sendSetting('direction', (api) => api.setPathDirection(mowerSn, angle));
  };

  if (!mowerSn) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.emptyState}>
          <Ionicons name="cog-outline" size={48} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>No Mower Connected</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={
        <RefreshControl refreshing={false} tintColor={colors.purple} onRefresh={() => {
          const socket = getSocket();
          if (socket) socket.emit('request:snapshot');
        }} />
      }>
        <Text style={styles.title}>Mower Settings</Text>

        {!mowerOnline && (
          <View style={styles.offlineBanner}>
            <Ionicons name="cloud-offline" size={16} color={colors.amber} />
            <Text style={styles.offlineText}>Mower is offline. Connect the mower to change settings.</Text>
          </View>
        )}

        {/* Cutting Height */}
        <View style={[styles.section, !mowerOnline && styles.sectionDisabled]} pointerEvents={mowerOnline ? 'auto' : 'none'}>
          <Text style={styles.sectionTitle}>CUTTING HEIGHT</Text>
          <View style={styles.card}>
            <Text style={styles.currentValue}>{(cuttingHeight / 10).toFixed(1)} cm</Text>
            <View style={styles.chipGrid}>
              {HEIGHT_VALUES.map((h) => (
                <TouchableOpacity
                  key={h}
                  style={[styles.chip, cuttingHeight === h && styles.chipActive]}
                  onPress={() => handleCuttingHeight(h)}
                  disabled={sending === 'height'}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.chipText, cuttingHeight === h && styles.chipTextActive]}>
                    {(h / 10).toFixed(1)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        {/* Obstacle Sensitivity */}
        <View style={[styles.section, !mowerOnline && styles.sectionDisabled]} pointerEvents={mowerOnline ? 'auto' : 'none'}>
          <Text style={styles.sectionTitle}>OBSTACLE AVOIDANCE</Text>
          <View style={styles.card}>
            {SENSITIVITY_LEVELS.map((s) => (
              <TouchableOpacity
                key={s.value}
                style={[styles.optionRow, sensitivity === s.value && styles.optionRowActive]}
                onPress={() => handleSensitivity(s.value)}
                disabled={sending === 'sensitivity'}
                activeOpacity={0.7}
              >
                <View style={[styles.radio, sensitivity === s.value && styles.radioActive]}>
                  {sensitivity === s.value && <View style={styles.radioInner} />}
                </View>
                <View style={styles.optionInfo}>
                  <Text style={[styles.optionLabel, sensitivity === s.value && styles.optionLabelActive]}>
                    {s.label}
                  </Text>
                  <Text style={styles.optionDesc}>{s.desc}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Path Direction */}
        <View style={[styles.section, !mowerOnline && styles.sectionDisabled]} pointerEvents={mowerOnline ? 'auto' : 'none'}>
          <Text style={styles.sectionTitle}>MOWING DIRECTION</Text>
          <View style={styles.card}>
            <View style={styles.previewRow}>
              <MowingDirectionPreview direction={pathDirection} size={120} />
              <Text style={styles.directionLabel}>{PATH_DIRECTIONS.find((d) => d.angle === pathDirection)?.label ?? ''} — {pathDirection}°</Text>
            </View>
            <View style={styles.compassGrid}>
              {PATH_DIRECTIONS.map((d) => (
                <TouchableOpacity
                  key={d.angle}
                  style={[styles.compassChip, pathDirection === d.angle && styles.compassChipActive]}
                  onPress={() => handlePathDirection(d.angle)}
                  disabled={sending === 'direction'}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.compassText, pathDirection === d.angle && styles.compassTextActive]}>
                    {d.label}
                  </Text>
                  <Text style={styles.compassAngle}>{d.angle}°</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 24, paddingBottom: 32 },
  title: { fontSize: 28, fontWeight: '700', color: colors.white, marginBottom: 24 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 22, fontWeight: '700', color: colors.white, marginTop: 16 },
  offlineBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(245,158,11,0.1)', borderRadius: 12, padding: 12, marginBottom: 20,
  },
  offlineText: { flex: 1, fontSize: 13, color: colors.amber, lineHeight: 18 },
  section: { marginBottom: 24 },
  sectionDisabled: { opacity: 0.3 },
  sectionTitle: {
    fontSize: 13, fontWeight: '600', color: colors.textDim,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginLeft: 4,
  },
  card: {
    backgroundColor: colors.card, borderRadius: 16,
    borderWidth: 1, borderColor: colors.cardBorder, padding: 16,
  },
  currentValue: {
    fontSize: 32, fontWeight: '700', color: colors.emerald,
    textAlign: 'center', marginBottom: 16, fontVariant: ['tabular-nums'],
  },
  chipGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center',
  },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  chipActive: { backgroundColor: colors.emerald },
  chipText: { fontSize: 14, fontWeight: '600', color: colors.textDim },
  chipTextActive: { color: colors.white },
  optionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14,
    borderRadius: 12, marginBottom: 6,
  },
  optionRowActive: { backgroundColor: 'rgba(0,212,170,0.08)' },
  radio: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 2,
    borderColor: colors.textMuted, alignItems: 'center', justifyContent: 'center',
  },
  radioActive: { borderColor: colors.emerald },
  radioInner: {
    width: 12, height: 12, borderRadius: 6, backgroundColor: colors.emerald,
  },
  optionInfo: { flex: 1 },
  optionLabel: { fontSize: 16, fontWeight: '600', color: colors.white },
  optionLabelActive: { color: colors.emerald },
  optionDesc: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  previewRow: {
    alignItems: 'center',
    marginBottom: 16,
    gap: 8,
  },
  directionLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textDim,
  },
  compassGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center',
  },
  compassChip: {
    width: 64, paddingVertical: 10, borderRadius: 12, alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  compassChipActive: { backgroundColor: colors.purple },
  compassText: { fontSize: 16, fontWeight: '700', color: colors.textDim },
  compassTextActive: { color: colors.white },
  compassAngle: { fontSize: 10, color: colors.textMuted, marginTop: 2 },
});
