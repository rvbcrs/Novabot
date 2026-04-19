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
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { MowingDirectionPreview } from '../components/MowingDirectionPreview';
import { useMowerState } from '../hooks/useMowerState';
import { getSocket } from '../services/socket';
import { ApiClient } from '../services/api';
import { getServerUrl } from '../services/auth';

// Cutting height: 20-90 in steps of 10 (displayed as 2-9 cm, matches Flutter slider)
const HEIGHT_VALUES = [20, 30, 40, 50, 60, 70, 80, 90];

// Obstacle sensitivity: 1=low, 2=medium, 3=high (Flutter slider: min=1, max=3, divisions=2)
const SENSITIVITY_LEVELS = [
  { value: 1, label: 'Low', desc: 'Less avoidance, more coverage' },
  { value: 2, label: 'Medium', desc: 'Balanced (recommended)' },
  { value: 3, label: 'High', desc: 'Maximum obstacle avoidance' },
];

// Joystick speed/handling: 1=low, 2=medium, 3=high (sent as ×100: 100/200/300)
const CONTROLLER_LEVELS = [
  { value: 100, label: 'Low' },
  { value: 200, label: 'Medium' },
  { value: 300, label: 'High' },
];

export default function MowerSettingsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { devices } = useMowerState();
  const [cuttingHeight, setCuttingHeight] = useState(50);
  const [sensitivity, setSensitivity] = useState(2);
  const [pathDirection, setPathDirection] = useState(0);
  const [joystickSpeed, setJoystickSpeed] = useState(300);
  const [joystickHandling, setJoystickHandling] = useState(300);
  const [headlight, setHeadlight] = useState(false);
  const [sound, setSound] = useState(false);
  const [sending, setSending] = useState('');

  // Rain auto-pause — loaded from /api/dashboard/rain-settings/:sn, per-mower.
  const [rainEnabled, setRainEnabled] = useState(true);
  const [rainMm, setRainMm] = useState(0.1);
  const [rainProb, setRainProb] = useState(50);
  const [rainHours, setRainHours] = useState(0.5);

  const mowerSn = useMemo(() => {
    return [...devices.values()].find((d) => d.deviceType === 'mower')?.sn ?? '';
  }, [devices]);

  const mower = useMemo(() => {
    return [...devices.values()].find((d) => d.deviceType === 'mower') ?? null;
  }, [devices]);

  const mowerOnline = mower?.online ?? false;

  // Request current settings from mower via get_para_info
  useEffect(() => {
    if (!mowerSn || !mowerOnline) return;
    (async () => {
      try {
        const url = await getServerUrl();
        if (!url) return;
        const api = new ApiClient(url);
        await api.sendCommand(mowerSn, { get_para_info: {} });
      } catch { /* ignore */ }
    })();
  }, [mowerSn, mowerOnline]);

  // Load current values from sensor data (updated via socket + sensor cache)
  const sensorJson = mower ? JSON.stringify({
    h: mower.sensors.defaultCuttingHeight,
    o: mower.sensors.obstacle_avoidance_sensitivity,
    p: mower.sensors.path_direction,
    v: mower.sensors.manual_controller_v,
    w: mower.sensors.manual_controller_w,
    l: mower.sensors.headlight,
    s: mower.sensors.sound,
  }) : '';

  useEffect(() => {
    if (!mower) return;
    const s = mower.sensors;
    if (s.defaultCuttingHeight) {
      const h = parseInt(s.defaultCuttingHeight, 10);
      if (h >= 20 && h <= 90) setCuttingHeight(h);
    }
    if (s.obstacle_avoidance_sensitivity) {
      const v = parseInt(s.obstacle_avoidance_sensitivity, 10);
      if (v >= 1 && v <= 3) setSensitivity(v);
    }
    if (s.path_direction) {
      const a = parseInt(s.path_direction, 10);
      if (a >= 0 && a <= 180) setPathDirection(a);
    }
    if (s.manual_controller_v) {
      const v = parseInt(s.manual_controller_v, 10);
      if (v >= 100 && v <= 300) setJoystickSpeed(v);
    }
    if (s.manual_controller_w) {
      const v = parseInt(s.manual_controller_w, 10);
      if (v >= 100 && v <= 300) setJoystickHandling(v);
    }
    if (s.headlight) setHeadlight(s.headlight === '2');
    if (s.sound) setSound(s.sound === '2');
  }, [mower?.sn, sensorJson]);

  // Load rain auto-pause settings (server-side, not part of the mower's own sensor cache)
  useEffect(() => {
    if (!mowerSn) return;
    (async () => {
      try {
        const url = await getServerUrl();
        if (!url) return;
        const res = await fetch(`${url}/api/dashboard/rain-settings/${encodeURIComponent(mowerSn)}`);
        const data = await res.json() as {
          enabled: boolean; thresholdMm: number; thresholdProbability: number; lookaheadHours: number;
        };
        setRainEnabled(data.enabled);
        setRainMm(data.thresholdMm);
        setRainProb(data.thresholdProbability);
        setRainHours(data.lookaheadHours);
      } catch { /* ignore */ }
    })();
  }, [mowerSn]);

  const saveRain = useCallback(async (patch: Partial<{
    enabled: boolean; thresholdMm: number; thresholdProbability: number; lookaheadHours: number;
  }>) => {
    if (!mowerSn) return;
    if (patch.enabled !== undefined) setRainEnabled(patch.enabled);
    if (patch.thresholdMm !== undefined) setRainMm(patch.thresholdMm);
    if (patch.thresholdProbability !== undefined) setRainProb(patch.thresholdProbability);
    if (patch.lookaheadHours !== undefined) setRainHours(patch.lookaheadHours);
    try {
      const url = await getServerUrl();
      if (!url) return;
      await fetch(`${url}/api/dashboard/rain-settings/${encodeURIComponent(mowerSn)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    } catch { /* ignore */ }
  }, [mowerSn]);

  const handleRainEnabled = (value: boolean) => saveRain({ enabled: value });

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

  // Send full set_para_info with all current values (matches Flutter Advanced Settings Confirm)
  // Also persists to server sensor cache so values survive app restart.
  const sendAllSettings = (overrides: Record<string, unknown> = {}) => {
    const params = {
      sound: sound ? 2 : 0,
      headlight: headlight ? 2 : 0,
      path_direction: pathDirection,
      obstacle_avoidance_sensitivity: sensitivity,
      manual_controller_v: joystickSpeed,
      manual_controller_w: joystickHandling,
      ...overrides,
    };
    sendSetting('all', async (api) => {
      // 1. Stuur naar maaier via MQTT
      await api.sendCommand(mowerSn, { set_para_info: params });
      // 2. Persist in server sensor cache zodat settings bewaard blijven
      const url = await getServerUrl();
      if (url) {
        await fetch(`${url}/api/dashboard/sensor-override/${encodeURIComponent(mowerSn)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
          ),
        });
      }
    });
  };

  const handleCuttingHeight = (height: number) => {
    setCuttingHeight(height);
    // Cutting height is NOT in set_para_info — only in cutterhigh within start_navigation.
    // We update the sensor cache on the server so StartMowSheet can read it.
    sendSetting('height', async (api) => {
      await fetch(`${(await getServerUrl())}/api/dashboard/sensor-override/${encodeURIComponent(mowerSn)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultCuttingHeight: String(height) }),
      });
    });
  };

  // Send ONLY the field the user changed. Sending the whole bundle every time
  // (the previous behaviour) quietly overrode the other settings — e.g. every
  // path_direction slider event carried `headlight: 0`, which resets the dock
  // LED from 255 back to dim via the server's led_bridge translation
  // (dashboard.ts:1508-1510). Novabot sends individual fields per change and
  // only emits a full bundle on the Advanced Settings "Confirm" button.
  const sendSingle = (params: Record<string, unknown>) => sendSetting('single', async (api) => {
    await api.sendCommand(mowerSn, { set_para_info: params });
    const url = await getServerUrl();
    if (url) {
      await fetch(`${url}/api/dashboard/sensor-override/${encodeURIComponent(mowerSn)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
        ),
      });
    }
  });

  const handleSensitivity = (level: number) => {
    setSensitivity(level);
    sendSingle({ obstacle_avoidance_sensitivity: level });
  };

  const handlePathDirection = (angle: number) => {
    setPathDirection(angle);
    sendSingle({ path_direction: angle });
  };

  const handleJoystickSpeed = (val: number) => {
    setJoystickSpeed(val);
    sendSingle({ manual_controller_v: val });
  };

  const handleJoystickHandling = (val: number) => {
    setJoystickHandling(val);
    sendSingle({ manual_controller_w: val });
  };

  const handleHeadlight = (on: boolean) => {
    setHeadlight(on);
    sendSingle({ headlight: on ? 2 : 0 });
  };

  const handleSound = (on: boolean) => {
    setSound(on);
    sendSingle({ sound: on ? 2 : 0 });
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
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.backBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-back" size={24} color={colors.white} />
          </TouchableOpacity>
          <Text style={styles.title}>Mower Settings</Text>
        </View>

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
            <Text style={styles.currentValue}>{cuttingHeight / 10} cm</Text>
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
                    {h / 10}
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
              <MowingDirectionPreview direction={pathDirection} size={100} />
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text style={styles.currentValue}>{pathDirection}°</Text>
                <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
                  <TouchableOpacity style={styles.stepBtn} onPress={() => handlePathDirection(Math.max(0, pathDirection - 15))}>
                    <Ionicons name="remove" size={20} color={colors.white} />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.stepBtn} onPress={() => handlePathDirection(Math.min(180, pathDirection + 15))}>
                    <Ionicons name="add" size={20} color={colors.white} />
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </View>
        </View>

        {/* Joystick Speed */}
        <View style={[styles.section, !mowerOnline && styles.sectionDisabled]} pointerEvents={mowerOnline ? 'auto' : 'none'}>
          <Text style={styles.sectionTitle}>JOYSTICK MAX SPEED</Text>
          <View style={styles.card}>
            <View style={styles.chipGrid}>
              {CONTROLLER_LEVELS.map((l) => (
                <TouchableOpacity
                  key={l.value}
                  style={[styles.chip, joystickSpeed === l.value && styles.chipActive]}
                  onPress={() => handleJoystickSpeed(l.value)}
                  disabled={sending === 'all'}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.chipText, joystickSpeed === l.value && styles.chipTextActive]}>
                    {l.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        {/* Joystick Handling */}
        <View style={[styles.section, !mowerOnline && styles.sectionDisabled]} pointerEvents={mowerOnline ? 'auto' : 'none'}>
          <Text style={styles.sectionTitle}>JOYSTICK HANDLING</Text>
          <View style={styles.card}>
            <View style={styles.chipGrid}>
              {CONTROLLER_LEVELS.map((l) => (
                <TouchableOpacity
                  key={l.value}
                  style={[styles.chip, joystickHandling === l.value && styles.chipActive]}
                  onPress={() => handleJoystickHandling(l.value)}
                  disabled={sending === 'all'}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.chipText, joystickHandling === l.value && styles.chipTextActive]}>
                    {l.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        {/* Rain auto-pause */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>RAIN AUTO-PAUSE</Text>
          <View style={styles.card}>
            <TouchableOpacity
              style={styles.optionRow}
              onPress={() => void handleRainEnabled(!rainEnabled)}
              activeOpacity={0.7}
            >
              <Ionicons name="rainy-outline" size={20} color={rainEnabled ? colors.emerald : colors.textMuted} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.optionLabel}>Pause when raining</Text>
                <Text style={styles.optionSub}>
                  {rainEnabled
                    ? `≥ ${rainMm.toFixed(1)} mm or ≥ ${rainProb}% within ${(rainHours * 60) | 0} min`
                    : 'Mower will keep mowing in the rain'}
                </Text>
              </View>
              <View style={[styles.toggle, rainEnabled && styles.toggleActive]}>
                <View style={[styles.toggleThumb, rainEnabled && styles.toggleThumbActive]} />
              </View>
            </TouchableOpacity>
            {rainEnabled && (
              <>
                <View style={styles.sliderRow}>
                  <Text style={styles.sliderLabel}>Min rainfall</Text>
                  <Text style={styles.sliderValue}>{rainMm.toFixed(1)} mm</Text>
                </View>
                <View style={styles.chipGrid}>
                  {[0.1, 0.2, 0.5, 1.0, 2.0].map(v => (
                    <TouchableOpacity
                      key={v}
                      style={[styles.chip, Math.abs(rainMm - v) < 0.05 && styles.chipActive]}
                      onPress={() => void saveRain({ thresholdMm: v })}
                    >
                      <Text style={[styles.chipText, Math.abs(rainMm - v) < 0.05 && styles.chipTextActive]}>
                        {v.toFixed(1)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={styles.sliderRow}>
                  <Text style={styles.sliderLabel}>Min probability</Text>
                  <Text style={styles.sliderValue}>{rainProb}%</Text>
                </View>
                <View style={styles.chipGrid}>
                  {[30, 50, 70, 90].map(v => (
                    <TouchableOpacity
                      key={v}
                      style={[styles.chip, rainProb === v && styles.chipActive]}
                      onPress={() => void saveRain({ thresholdProbability: v })}
                    >
                      <Text style={[styles.chipText, rainProb === v && styles.chipTextActive]}>{v}%</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={styles.sliderRow}>
                  <Text style={styles.sliderLabel}>Look ahead</Text>
                  <Text style={styles.sliderValue}>{(rainHours * 60) | 0} min</Text>
                </View>
                <View style={styles.chipGrid}>
                  {[0.5, 1, 2, 3].map(v => (
                    <TouchableOpacity
                      key={v}
                      style={[styles.chip, Math.abs(rainHours - v) < 0.05 && styles.chipActive]}
                      onPress={() => void saveRain({ lookaheadHours: v })}
                    >
                      <Text style={[styles.chipText, Math.abs(rainHours - v) < 0.05 && styles.chipTextActive]}>
                        {v < 1 ? `${(v * 60) | 0}m` : `${v}h`}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
          </View>
        </View>

        {/* Headlight & Sound */}
        <View style={[styles.section, !mowerOnline && styles.sectionDisabled]} pointerEvents={mowerOnline ? 'auto' : 'none'}>
          <Text style={styles.sectionTitle}>OTHER</Text>
          <View style={styles.card}>
            <TouchableOpacity style={styles.optionRow} onPress={() => handleHeadlight(!headlight)} activeOpacity={0.7}>
              <Ionicons name={headlight ? 'flashlight' : 'flashlight-outline'} size={20} color={headlight ? colors.amber : colors.textMuted} />
              <Text style={[styles.optionLabel, { flex: 1, marginLeft: 12 }]}>Headlight</Text>
              <View style={[styles.toggle, headlight && styles.toggleActive]}>
                <View style={[styles.toggleThumb, headlight && styles.toggleThumbActive]} />
              </View>
            </TouchableOpacity>
            <TouchableOpacity style={styles.optionRow} onPress={() => handleSound(!sound)} activeOpacity={0.7}>
              <Ionicons name={sound ? 'volume-high' : 'volume-mute'} size={20} color={sound ? colors.emerald : colors.textMuted} />
              <Text style={[styles.optionLabel, { flex: 1, marginLeft: 12 }]}>Speaker</Text>
              <View style={[styles.toggle, sound && styles.toggleActive]}>
                <View style={[styles.toggleThumb, sound && styles.toggleThumbActive]} />
              </View>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 24, paddingBottom: 32 },
  title: { fontSize: 28, fontWeight: '700', color: colors.white },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 24,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
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
    marginBottom: 8,
  },
  optionSub: {
    fontSize: 12, color: colors.textMuted, marginTop: 2,
  },
  sliderRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 12, marginBottom: 6, paddingHorizontal: 4,
  },
  sliderLabel: { fontSize: 13, color: colors.textDim, fontWeight: '500' },
  sliderValue: { fontSize: 13, color: colors.white, fontWeight: '600', fontVariant: ['tabular-nums'] },
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
  stepBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center', justifyContent: 'center',
  },
  toggle: {
    width: 44, height: 24, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center', paddingHorizontal: 2,
  },
  toggleActive: {
    backgroundColor: colors.emerald,
  },
  toggleThumb: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: colors.textMuted,
  },
  toggleThumbActive: {
    backgroundColor: colors.white,
    alignSelf: 'flex-end',
  },
});
