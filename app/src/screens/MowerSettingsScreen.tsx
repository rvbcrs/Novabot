/**
 * Mower settings — cutting height, mow direction, obstacle avoidance, rain,
 * border, light & sound, recovery.
 *
 * VALUE SOURCE (KRITIEK): the mower firmware does NOT persist set_para_info over
 * a reconnect — it reverts to provisioning defaults (e.g. 7cm / 0°). So the LIVE
 * sensor frame cannot be trusted to show what the user actually chose. We load
 * the user's SAVED values from GET /api/dashboard/device-settings/:sn (the
 * device_settings table the sensor-override POST writes) and display THOSE. The
 * live sensors are still read, but ONLY to drive the header sync chip: green
 * "in sync" when the mower currently matches the saved intent, amber "reset,
 * will be applied at the next mow" when the firmware has reverted (the server
 * re-applies the saved para before every mow — scheduled via mowingService and
 * manual via StartMowSheet).
 */
import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  RefreshControl,
  Modal,
  FlatList,
} from 'react-native';
import { appAlertCompat } from '../context/AppAlertContext';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStyles, useTheme, type Colors } from '../theme';
import { MowingDirectionPreview } from '../components/MowingDirectionPreview';
import { SimpleSlider } from '../components/SimpleSlider';
import { useActiveMower } from '../hooks/useActiveMower';
import { useHeadlightBrightness } from '../hooks/useHeadlightBrightness';
import { useI18n } from '../i18n';
import * as Localization from 'expo-localization';
import { getSocket } from '../services/socket';
import { ApiClient, isUnsupportedFirmwareError } from '../services/api';
import { getServerUrl } from '../services/auth';
import { isOpenNovaFirmware } from '../utils/firmwareCapability';

// Cutting height: 20-90 in steps of 10 (displayed as 2-9 cm, matches Flutter slider)
const HEIGHT_VALUES = [20, 30, 40, 50, 60, 70, 80, 90];

// obstacle_avoidance_sensitivity maps to the mower's stock perception_level 1:1.
// The redesign exposes only 1/2/3 (Low/Med/High) with plain-language descriptions.
// perception_level: 1=detection, 2=segmentation, 3=segmentation high-sensitivity.
const SENSITIVITY_LEVELS = [
  { value: 1, labelKey: 'msObstacleLow', descKey: 'msObstacleLowDesc' },
  { value: 2, labelKey: 'msObstacleMed', descKey: 'msObstacleMedDesc' },
  { value: 3, labelKey: 'msObstacleHigh', descKey: 'msObstacleHighDesc' },
];

const COMMON_TIMEZONES = [
  'Europe/Amsterdam', 'Europe/Berlin', 'Europe/Brussels', 'Europe/Paris',
  'Europe/London', 'Europe/Madrid', 'Europe/Rome', 'Europe/Vienna',
  'Europe/Warsaw', 'Europe/Stockholm', 'Europe/Helsinki', 'Europe/Athens',
  'Europe/Lisbon', 'Europe/Zurich', 'Europe/Prague', 'Europe/Dublin',
  'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/Toronto', 'America/Vancouver',
  'America/Sao_Paulo', 'America/Mexico_City',
  'Australia/Sydney', 'Australia/Melbourne', 'Australia/Perth',
  'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Dubai',
];

function detectDeviceTimezone(): string {
  try {
    const cals = Localization.getCalendars?.();
    if (cals && cals.length > 0 && cals[0].timeZone) return cals[0].timeZone;
  } catch { /* ignore */ }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return tz;
  } catch { /* ignore */ }
  return 'Europe/Amsterdam';
}

/** Normalise a stored defaultCuttingHeight value (mm 20..90, wire 0..7, or user
 *  cm 2..9) to display mm (20..90). Returns undefined if unparseable. */
function heightToMm(raw: string | undefined): number | undefined {
  const h = parseInt(raw ?? '', 10);
  if (!Number.isFinite(h)) return undefined;
  if (h >= 20 && h <= 90) return h;
  if (h >= 0 && h <= 7) return (h + 2) * 10;   // wire enum (cm-2)
  if (h >= 2 && h <= 9) return h * 10;          // user cm
  return undefined;
}

export default function MowerSettingsScreen() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();

  // Editable state — initialised from the SAVED settings (device_settings),
  // never from the live sensor frame (which reverts after reconnect).
  const [cuttingHeight, setCuttingHeight] = useState(50);
  const [sensitivity, setSensitivity] = useState(2);
  const [pathDirection, setPathDirection] = useState(0);
  const [joystickSpeed, setJoystickSpeed] = useState(300);
  const [joystickHandling, setJoystickHandling] = useState(300);
  const [headlight, setHeadlight] = useState(false);
  const [sound, setSound] = useState(false);
  const [timezone, setTimezone] = useState<string>(() => detectDeviceTimezone());
  const [tzPickerOpen, setTzPickerOpen] = useState(false);
  const { brightness: headlightBrightness, setBrightness: setHeadlightBrightness } = useHeadlightBrightness();
  const [sending, setSending] = useState('');

  // Saved baseline — drives the dirty indicator AND the sync chip. Set from the
  // device-settings load and refreshed on every successful Save.
  const [savedSnapshot, setSavedSnapshot] = useState(() => ({
    sensitivity: 2,
    pathDirection: 0,
    joystickSpeed: 300,
    joystickHandling: 300,
    headlight: false,
    headlightBrightness: 255,
    sound: false,
    cuttingHeight: 50,
    timezone: detectDeviceTimezone(),
  }));

  // Rain auto-pause — loaded from /api/dashboard/rain-settings/:sn, per-mower.
  const [rainEnabled, setRainEnabled] = useState(true);
  const [rainMm, setRainMm] = useState(0.1);
  const [rainProb, setRainProb] = useState(50);
  const [rainHours, setRainHours] = useState(0.5);
  // Border seam-fix — loaded from /api/dashboard/seam-fix/:sn, per-mower (opt-in).
  const [seamFixEnabled, setSeamFixEnabled] = useState(false);
  const [seamFixMargin, setSeamFixMargin] = useState(15);

  const { activeMower: mower, activeMowerSn } = useActiveMower();
  const mowerSn = activeMowerSn ?? '';
  const mowerOnline = mower?.online ?? false;
  // Seam-fix, recalibrate charging pose and frame invalidate all go through
  // extended_commands.py (OpenNova custom firmware only); the server answers
  // 409 unsupported_firmware on stock, so disable them up front and explain.
  const stockFw = !isOpenNovaFirmware(mower?.firmwareVersion);

  // Request a fresh para frame so the sync chip can compare against live values.
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

  // Load the user's SAVED values from the server (device_settings). This is the
  // source of truth for what we DISPLAY — NOT the live sensor frame. Falls back
  // to sensible defaults when a key is absent.
  useEffect(() => {
    if (!mowerSn) return;
    let active = true;
    (async () => {
      try {
        const url = await getServerUrl();
        if (!url) return;
        const api = new ApiClient(url);
        const { settings } = await api.getDeviceSettings(mowerSn);
        if (!active) return;

        const next = {
          sensitivity: 2,
          pathDirection: 0,
          joystickSpeed: 300,
          joystickHandling: 300,
          headlight: false,
          headlightBrightness,
          sound: false,
          cuttingHeight: 50,
          timezone,
        };

        const mm = heightToMm(settings.defaultCuttingHeight);
        if (mm !== undefined) next.cuttingHeight = mm;

        const o = parseInt(settings.obstacle_avoidance_sensitivity ?? '', 10);
        if (o >= 1 && o <= 3) next.sensitivity = o;

        const p = parseInt(settings.path_direction ?? '', 10);
        if (Number.isFinite(p) && p >= 0 && p <= 180) next.pathDirection = p;

        const v = parseInt(settings.manual_controller_v ?? '', 10);
        if (v >= 100 && v <= 300) next.joystickSpeed = v;

        const w = parseInt(settings.manual_controller_w ?? '', 10);
        if (w >= 100 && w <= 300) next.joystickHandling = w;

        // headlight stored as the brightness it was saved at (0 = off).
        const hl = parseInt(settings.headlight ?? '', 10);
        if (Number.isFinite(hl)) next.headlight = hl > 0;
        if (settings.sound != null) next.sound = settings.sound === '2' || settings.sound === '1';

        setCuttingHeight(next.cuttingHeight);
        setSensitivity(next.sensitivity);
        setPathDirection(next.pathDirection);
        setJoystickSpeed(next.joystickSpeed);
        setJoystickHandling(next.joystickHandling);
        setHeadlight(next.headlight);
        setSound(next.sound);
        setSavedSnapshot(next);
      } catch { /* ignore — keep defaults */ }
    })();
    return () => { active = false; };
    // Intentionally only re-load on a mower change — not on every brightness/tz
    // tweak (those are local edits we don't want to clobber).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mowerSn]);

  // useHeadlightBrightness hydrates the brightness from SecureStore async, so
  // mirror it into the baseline once so isDirty doesn't stick true and pop the
  // "Unsaved changes" dialog on every back-press.
  useEffect(() => {
    setSavedSnapshot(prev => prev.headlightBrightness === headlightBrightness
      ? prev
      : { ...prev, headlightBrightness });
  }, [headlightBrightness]);

  // ── Sync chip ────────────────────────────────────────────────────────
  // Compare the SAVED/intended values against the mower's LIVE sensor frame.
  // Honest: when the mower has reverted to defaults we show amber, not green.
  const live = mower?.sensors;
  const inSync = useMemo(() => {
    if (!mowerOnline || !live) return true; // can't compare → don't alarm
    const checks: boolean[] = [];
    const liveMm = heightToMm(live.defaultCuttingHeight ?? live.target_height);
    if (liveMm !== undefined) checks.push(liveMm === savedSnapshot.cuttingHeight);
    const lo = parseInt(live.obstacle_avoidance_sensitivity ?? '', 10);
    if (Number.isFinite(lo)) checks.push(lo === savedSnapshot.sensitivity);
    const lp = parseInt(live.path_direction ?? '', 10);
    if (Number.isFinite(lp)) checks.push(lp === savedSnapshot.pathDirection);
    if (checks.length === 0) return true;
    return checks.every(Boolean);
  }, [mowerOnline, live, savedSnapshot.cuttingHeight, savedSnapshot.sensitivity, savedSnapshot.pathDirection]);

  const isDirty = sensitivity !== savedSnapshot.sensitivity
    || pathDirection !== savedSnapshot.pathDirection
    || joystickSpeed !== savedSnapshot.joystickSpeed
    || joystickHandling !== savedSnapshot.joystickHandling
    || headlight !== savedSnapshot.headlight
    || headlightBrightness !== savedSnapshot.headlightBrightness
    || sound !== savedSnapshot.sound
    || cuttingHeight !== savedSnapshot.cuttingHeight
    || timezone !== savedSnapshot.timezone;

  // Count pending changes for the save bar label.
  const pendingCount = useMemo(() => {
    let n = 0;
    if (sensitivity !== savedSnapshot.sensitivity) n++;
    if (pathDirection !== savedSnapshot.pathDirection) n++;
    if (joystickSpeed !== savedSnapshot.joystickSpeed) n++;
    if (joystickHandling !== savedSnapshot.joystickHandling) n++;
    if (headlight !== savedSnapshot.headlight) n++;
    if (headlightBrightness !== savedSnapshot.headlightBrightness) n++;
    if (sound !== savedSnapshot.sound) n++;
    if (cuttingHeight !== savedSnapshot.cuttingHeight) n++;
    if (timezone !== savedSnapshot.timezone) n++;
    return n;
  }, [sensitivity, pathDirection, joystickSpeed, joystickHandling, headlight, headlightBrightness, sound, cuttingHeight, timezone, savedSnapshot]);

  const handleSaveAll = useCallback(async () => {
    if (!mowerSn || !mowerOnline) return;
    setSending('save');
    try {
      const url = await getServerUrl();
      if (!url) return;
      const api = new ApiClient(url);
      const params = {
        sound: sound ? 2 : 0,
        headlight: headlight ? headlightBrightness : 0,
        path_direction: pathDirection,
        obstacle_avoidance_sensitivity: sensitivity,
        manual_controller_v: joystickSpeed,
        manual_controller_w: joystickHandling,
      };
      // Single MQTT command carrying every para field — mqtt_node overwrites
      // para.value as one block so omitting a field resets it to 0; sending
      // them together preserves every slider in one shot.
      await api.sendCommand(mowerSn, { set_para_info: params });
      // Push the operator-selected timezone via set_cfg_info only when changed.
      if (timezone && timezone !== savedSnapshot.timezone) {
        await api.sendCommand(mowerSn, { set_cfg_info: { cfg_value: 1, tz: timezone } });
      }
      // Mirror to the server's device_settings cache so values survive a re-open
      // AND so the server can re-apply them before every mow.
      await fetch(`${url}/api/dashboard/sensor-override/${encodeURIComponent(mowerSn)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
        ),
      });
      // Cutting height takes its own path (not in set_para_info).
      await fetch(`${url}/api/dashboard/sensor-override/${encodeURIComponent(mowerSn)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultCuttingHeight: String(cuttingHeight) }),
      });
      // Refresh the saved baseline so isDirty resets AND the sync chip re-evaluates.
      setSavedSnapshot({
        sensitivity, pathDirection, joystickSpeed, joystickHandling,
        headlight, headlightBrightness, sound, cuttingHeight, timezone,
      });
      setTimeout(() => { navigation.goBack(); }, 700);
    } catch { /* swallow — UI keeps dirty state so user can retry */ }
    finally { setSending(''); }
  }, [mowerSn, mowerOnline, sound, headlight, headlightBrightness, pathDirection, sensitivity, joystickSpeed, joystickHandling, cuttingHeight, timezone, savedSnapshot.timezone, navigation]);

  // Back guard — intercept hardware-back / swipe-back / nav.pop when dirty.
  const allowLeaveRef = useRef(false);
  useEffect(() => {
    const unsubscribe = (navigation as unknown as {
      addListener: (event: string, cb: (e: { preventDefault: () => void; data: { action: unknown } }) => void) => () => void;
    }).addListener('beforeRemove', (e) => {
      if (!isDirty || allowLeaveRef.current) return;
      e.preventDefault();
      appAlertCompat.alert(
        t('msUnsavedTitle'),
        t('msUnsavedBody'),
        [
          { text: t('cancel') || 'Cancel', style: 'cancel' },
          {
            text: t('msDiscard'),
            style: 'destructive',
            onPress: () => {
              allowLeaveRef.current = true;
              (navigation as unknown as { dispatch: (a: unknown) => void }).dispatch(e.data.action);
            },
          },
          {
            text: t('msSave'),
            onPress: async () => {
              await handleSaveAll();
              allowLeaveRef.current = true;
            },
          },
        ],
      );
    });
    return unsubscribe;
  }, [navigation, isDirty, handleSaveAll, t]);

  // Load rain auto-pause settings (server-side)
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

  // Load border seam-fix config (server-side, per-mower)
  useEffect(() => {
    if (!mowerSn) return;
    (async () => {
      try {
        const url = await getServerUrl();
        if (!url) return;
        const res = await fetch(`${url}/api/dashboard/seam-fix/${encodeURIComponent(mowerSn)}`);
        const data = await res.json() as { enabled: boolean; edgeMarginCm: number };
        setSeamFixEnabled(data.enabled);
        setSeamFixMargin(data.edgeMarginCm);
      } catch { /* ignore */ }
    })();
  }, [mowerSn]);

  const saveSeamFix = useCallback(async (patch: Partial<{ enabled: boolean; edgeMarginCm: number }>) => {
    if (!mowerSn) return;
    if (stockFw) {
      appAlertCompat.alert(t('msBorderTitle'), t('requiresOpenNovaFirmware'));
      return;
    }
    const prev = { enabled: seamFixEnabled, edgeMarginCm: seamFixMargin };
    if (patch.enabled !== undefined) setSeamFixEnabled(patch.enabled);
    if (patch.edgeMarginCm !== undefined) setSeamFixMargin(patch.edgeMarginCm);
    try {
      const url = await getServerUrl();
      if (!url) return;
      const res = await fetch(`${url}/api/dashboard/seam-fix/${encodeURIComponent(mowerSn)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.status === 409) {
        // Server firmware gate: undo the optimistic toggle, no fake success.
        const body = await res.json().catch(() => null) as { reason?: string } | null;
        if (body?.reason === 'unsupported_firmware') {
          setSeamFixEnabled(prev.enabled);
          setSeamFixMargin(prev.edgeMarginCm);
          appAlertCompat.alert(t('msBorderTitle'), t('requiresOpenNovaFirmware'));
        }
      }
    } catch { /* ignore */ }
  }, [mowerSn, stockFw, seamFixEnabled, seamFixMargin, t]);

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

  const handleRecalibrateChargingPose = useCallback(async () => {
    if (!mowerSn) return;
    if (stockFw) {
      appAlertCompat.alert(t('msRecalTitle'), t('requiresOpenNovaFirmware'));
      return;
    }
    appAlertCompat.alert(
      'Recalibrate Charging Pose?',
      'This overwrites map_info.json (charger x/y/θ) on the mower with the CURRENT pose. The mower MUST be physically on its dock and charging, otherwise the mower will place the charger at the wrong spot and future coverage tasks will drift.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Recalibrate',
          style: 'destructive',
          onPress: async () => {
            const url = await getServerUrl();
            if (!url) return;
            const api = new ApiClient(url);
            try {
              let resp = await api.recalibrateChargingPose(mowerSn);
              if (!resp.ok && (resp.batteryState ?? '').toUpperCase() !== 'CHARGING') {
                appAlertCompat.alert(
                  'Mower not charging',
                  `Battery state is "${resp.batteryState ?? 'unknown'}" — expected CHARGING. Put the mower on its dock and try again, or override the safety check?`,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Override',
                      style: 'destructive',
                      onPress: async () => {
                        const forced = await api.recalibrateChargingPose(mowerSn, { force: true });
                        if (forced.ok && forced.pose) {
                          appAlertCompat.alert(
                            'Recalibrated',
                            `New charging pose:\nx=${forced.pose.x.toFixed(3)} y=${forced.pose.y.toFixed(3)} θ=${forced.pose.theta.toFixed(3)}`,
                          );
                        } else {
                          appAlertCompat.alert('Recalibrate failed', forced.error ?? 'unknown error');
                        }
                      },
                    },
                  ],
                );
                return;
              }
              if (resp.ok && resp.pose) {
                appAlertCompat.alert(
                  'Recalibrated',
                  `New charging pose:\nx=${resp.pose.x.toFixed(3)} y=${resp.pose.y.toFixed(3)} θ=${resp.pose.theta.toFixed(3)}`,
                );
              } else {
                appAlertCompat.alert('Recalibrate failed', resp.error ?? 'unknown error');
              }
            } catch (e) {
              appAlertCompat.alert(
                'Recalibrate failed',
                isUnsupportedFirmwareError(e) ? t('requiresOpenNovaFirmware') : e instanceof Error ? e.message : String(e),
              );
            }
          },
        },
      ],
    );
  }, [mowerSn, stockFw, t]);

  const handleSoftRestart = useCallback(async () => {
    if (!mowerSn) return;
    appAlertCompat.alert(
      'Restart mower?',
      'Restarts the mower software (not a full reboot). It clears stuck states such as Error 140 and comes back online in about a minute. Only allowed when the mower is idle or charging, not while mowing.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restart',
          style: 'destructive',
          onPress: async () => {
            const url = await getServerUrl();
            if (!url) return;
            try {
              const res = await fetch(`${url}/api/dashboard/soft-restart/${encodeURIComponent(mowerSn)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              });
              const body = await res.json().catch(() => ({} as { ok?: boolean; error?: string }));
              if (res.ok && body.ok) {
                appAlertCompat.alert('Restarting', 'The mower is restarting and will be back online in about a minute.');
              } else if (res.status === 409) {
                appAlertCompat.alert('Cannot restart now', body.error ?? 'The mower is busy. Try again when it is idle or charging.');
              } else {
                appAlertCompat.alert('Restart failed', body.error ?? `HTTP ${res.status}`);
              }
            } catch (e) {
              appAlertCompat.alert('Restart failed', e instanceof Error ? e.message : String(e));
            }
          },
        },
      ],
    );
  }, [mowerSn]);

  const handleReanchorInvalidate = useCallback(() => {
    if (!mowerSn) return;
    if (stockFw) {
      appAlertCompat.alert(t('msReanchorTitle'), t('requiresOpenNovaFirmware'));
      return;
    }
    appAlertCompat.alert(
      'Re-anchor frame?',
      'Marks the localization frame as INVALID so you can re-anchor it. Use only when the mower is mis-localized (its position drifts off the dock). After confirming, open the Home screen and tap the re-anchor prompt to run the wizard.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Invalidate',
          style: 'destructive',
          onPress: async () => {
            const url = await getServerUrl();
            if (!url) return;
            try {
              const r = await new ApiClient(url).reanchor(mowerSn, 'invalidate');
              if (r.ok) {
                appAlertCompat.alert('Frame invalidated', 'Open the Home screen and tap the re-anchor prompt to re-anchor.');
              } else {
                appAlertCompat.alert('Failed', r.error ?? 'unknown error');
              }
            } catch (e) {
              appAlertCompat.alert(
                'Failed',
                isUnsupportedFirmwareError(e) ? t('requiresOpenNovaFirmware') : e instanceof Error ? e.message : String(e),
              );
            }
          },
        },
      ],
    );
  }, [mowerSn, stockFw, t]);

  if (!mowerSn) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.emptyState}>
          <Ionicons name="cog-outline" size={48} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>{t('msNoMower')}</Text>
        </View>
      </View>
    );
  }

  const saveLabel = sending === 'save'
    ? t('msSaving')
    : pendingCount === 0
      ? t('msSave')
      : pendingCount === 1
        ? t('msSaveOneChange')
        : t('msSaveChanges', { count: pendingCount });

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 96 }]}
        refreshControl={
          <RefreshControl refreshing={false} tintColor={colors.purple} onRefresh={() => {
            const socket = getSocket();
            if (socket) socket.emit('request:snapshot');
          }} />
        }
      >
        {/* Header with sync chip */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.backBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>{t('msTitle')}</Text>
        </View>

        {mowerOnline && (
          <View style={[styles.syncChip, inSync ? styles.syncChipOk : styles.syncChipWarn]}>
            <Ionicons
              name={inSync ? 'checkmark-circle' : 'alert-circle'}
              size={16}
              color={inSync ? colors.emerald : colors.amber}
            />
            <Text style={[styles.syncChipText, { color: inSync ? colors.emerald : colors.amber }]}>
              {inSync ? t('msInSync') : t('msResetPending')}
            </Text>
          </View>
        )}

        {!mowerOnline && (
          <View style={styles.offlineBanner}>
            <Ionicons name="cloud-offline" size={16} color={colors.amber} />
            <Text style={styles.offlineText}>{t('msOffline')}</Text>
          </View>
        )}

        {/* ── MAAIEN: cutting height + mow direction ── */}
        <View style={[styles.section, !mowerOnline && styles.sectionDisabled]} pointerEvents={mowerOnline ? 'auto' : 'none'}>
          <Text style={styles.sectionTitle}>{t('msSectionMowing')}</Text>
          <View style={styles.card}>
            <Text style={styles.fieldLabel}>{t('msCuttingHeight')}</Text>
            <Text style={styles.currentValue}>{cuttingHeight / 10} cm</Text>
            <View style={styles.chipGrid}>
              {HEIGHT_VALUES.map((h) => (
                <TouchableOpacity
                  key={h}
                  style={[styles.chip, cuttingHeight === h && styles.chipActive]}
                  onPress={() => setCuttingHeight(h)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.chipText, cuttingHeight === h && styles.chipTextActive]}>
                    {h / 10}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.divider} />

            <Text style={styles.fieldLabel}>{t('msMowDirection')}</Text>
            <View style={styles.previewRow}>
              <MowingDirectionPreview direction={pathDirection} size={100} />
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text style={styles.currentValue}>{pathDirection}°</Text>
                <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
                  <TouchableOpacity style={styles.stepBtn} onPress={() => setPathDirection(Math.max(0, pathDirection - 15))}>
                    <Ionicons name="remove" size={20} color={colors.white} />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.stepBtn} onPress={() => setPathDirection(Math.min(180, pathDirection + 15))}>
                    <Ionicons name="add" size={20} color={colors.white} />
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </View>
        </View>

        {/* ── OBSTAKEL-ONTWIJKING ── */}
        <View style={[styles.section, !mowerOnline && styles.sectionDisabled]} pointerEvents={mowerOnline ? 'auto' : 'none'}>
          <Text style={styles.sectionTitle}>{t('msSectionObstacle')}</Text>
          <View style={styles.card}>
            {SENSITIVITY_LEVELS.map((s) => (
              <TouchableOpacity
                key={s.value}
                style={[styles.optionRow, sensitivity === s.value && styles.optionRowActive]}
                onPress={() => setSensitivity(s.value)}
                activeOpacity={0.7}
              >
                <View style={[styles.radio, sensitivity === s.value && styles.radioActive]}>
                  {sensitivity === s.value && <View style={styles.radioInner} />}
                </View>
                <View style={styles.optionInfo}>
                  <Text style={[styles.optionLabel, sensitivity === s.value && styles.optionLabelActive]}>
                    {t(s.labelKey)}
                  </Text>
                  <Text style={styles.optionDesc}>{t(s.descKey)}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* ── REGEN: rain auto-pause ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('msSectionRain')}</Text>
          <View style={styles.card}>
            <TouchableOpacity
              style={styles.optionRow}
              onPress={() => void handleRainEnabled(!rainEnabled)}
              activeOpacity={0.7}
            >
              <Ionicons name="rainy-outline" size={20} color={rainEnabled ? colors.emerald : colors.textMuted} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.optionLabel}>{t('msRainTitle')}</Text>
                <Text style={styles.optionSub}>
                  {rainEnabled
                    ? t('msRainOnSub', { mm: rainMm.toFixed(1), prob: rainProb, min: (rainHours * 60) | 0 })
                    : t('msRainOffSub')}
                </Text>
              </View>
              <View style={[styles.toggle, rainEnabled && styles.toggleActive]}>
                <View style={[styles.toggleThumb, rainEnabled && styles.toggleThumbActive]} />
              </View>
            </TouchableOpacity>
            {rainEnabled && (
              <>
                <View style={styles.sliderRow}>
                  <Text style={styles.sliderLabel}>{t('msRainMinRain')}</Text>
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
                  <Text style={styles.sliderLabel}>{t('msRainMinProb')}</Text>
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
                  <Text style={styles.sliderLabel}>{t('msRainLookAhead')}</Text>
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

        {/* ── RAND: border seam-fix ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('msSectionBorder')}</Text>
          <View style={styles.card}>
            <TouchableOpacity
              style={[styles.optionRow, stockFw && { opacity: 0.5 }]}
              onPress={() => void saveSeamFix({ enabled: !seamFixEnabled })}
              activeOpacity={0.7}
              disabled={stockFw}
            >
              <Ionicons name="grid-outline" size={20} color={seamFixEnabled ? colors.emerald : colors.textMuted} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.optionLabel}>{t('msBorderTitle')}</Text>
                <Text style={styles.optionSub}>
                  {stockFw
                    ? t('requiresOpenNovaFirmware')
                    : seamFixEnabled
                      ? t('msBorderOnSub', { cm: seamFixMargin | 0 })
                      : t('msBorderOffSub')}
                </Text>
              </View>
              <View style={[styles.toggle, seamFixEnabled && styles.toggleActive]}>
                <View style={[styles.toggleThumb, seamFixEnabled && styles.toggleThumbActive]} />
              </View>
            </TouchableOpacity>
            {seamFixEnabled && !stockFw && (
              <>
                <View style={styles.sliderRow}>
                  <Text style={styles.sliderLabel}>{t('msBorderEdgeMargin')}</Text>
                  <Text style={styles.sliderValue}>{seamFixMargin | 0} cm</Text>
                </View>
                <View style={styles.chipGrid}>
                  {[0, 5, 10, 15, 20, 25].map(v => (
                    <TouchableOpacity
                      key={v}
                      style={[styles.chip, seamFixMargin === v && styles.chipActive]}
                      onPress={() => void saveSeamFix({ edgeMarginCm: v })}
                    >
                      <Text style={[styles.chipText, seamFixMargin === v && styles.chipTextActive]}>{v}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
          </View>
        </View>

        {/* ── LICHT & GELUID ── */}
        <View style={[styles.section, !mowerOnline && styles.sectionDisabled]} pointerEvents={mowerOnline ? 'auto' : 'none'}>
          <Text style={styles.sectionTitle}>{t('msSectionLightSound')}</Text>
          <View style={styles.card}>
            <TouchableOpacity style={styles.optionRow} onPress={() => setHeadlight(!headlight)} activeOpacity={0.7}>
              <Ionicons name={headlight ? 'flashlight' : 'flashlight-outline'} size={20} color={headlight ? colors.amber : colors.textMuted} />
              <Text style={[styles.optionLabel, { flex: 1, marginLeft: 12 }]}>{t('msHeadlight')}</Text>
              <View style={[styles.toggle, headlight && styles.toggleActive]}>
                <View style={[styles.toggleThumb, headlight && styles.toggleThumbActive]} />
              </View>
            </TouchableOpacity>
            <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
              <SimpleSlider
                label={t('msBrightness')}
                valueSuffix=""
                min={0}
                max={255}
                step={1}
                value={headlightBrightness}
                fillColor={headlight ? colors.amber : 'rgba(245,158,11,0.4)'}
                onChange={setHeadlightBrightness}
                onCommit={setHeadlightBrightness}
              />
            </View>
            <TouchableOpacity style={styles.optionRow} onPress={() => setSound(!sound)} activeOpacity={0.7}>
              <Ionicons name={sound ? 'volume-high' : 'volume-mute'} size={20} color={sound ? colors.emerald : colors.textMuted} />
              <Text style={[styles.optionLabel, { flex: 1, marginLeft: 12 }]}>{t('msSpeaker')}</Text>
              <View style={[styles.toggle, sound && styles.toggleActive]}>
                <View style={[styles.toggleThumb, sound && styles.toggleThumbActive]} />
              </View>
            </TouchableOpacity>
            <TouchableOpacity style={styles.optionRow} onPress={() => setTzPickerOpen(true)} activeOpacity={0.7}>
              <Ionicons name="time-outline" size={20} color={colors.textMuted} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.optionLabel}>{t('msTimezone')}</Text>
                <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                  {timezone}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        </View>

        {/* ── HERSTEL (danger zone) ── */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, styles.sectionTitleDanger]}>{t('msSectionRecovery')}</Text>
          <View style={[styles.card, styles.cardDanger]}>
            <TouchableOpacity
              style={[styles.optionRow, stockFw && { opacity: 0.5 }]}
              onPress={() => handleRecalibrateChargingPose()}
              activeOpacity={0.7}
              disabled={stockFw}
            >
              <Ionicons name="compass-outline" size={20} color={colors.red} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.optionLabel}>{t('msRecalTitle')}</Text>
                <Text style={styles.optionSub}>{stockFw ? t('requiresOpenNovaFirmware') : t('msRecalSub')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.optionRow}
              onPress={() => handleSoftRestart()}
              activeOpacity={0.7}
            >
              <Ionicons name="refresh-outline" size={20} color={colors.purple} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.optionLabel}>{t('msRestartTitle')}</Text>
                <Text style={styles.optionSub}>{t('msRestartSub')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.optionRow, stockFw && { opacity: 0.5 }]}
              onPress={() => handleReanchorInvalidate()}
              activeOpacity={0.7}
              disabled={stockFw}
            >
              <Ionicons name="navigate-circle-outline" size={20} color={colors.red} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.optionLabel}>{t('msReanchorTitle')}</Text>
                <Text style={styles.optionSub}>{stockFw ? t('requiresOpenNovaFirmware') : t('msReanchorSub')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>

      {/* Timezone picker modal */}
      <Modal
        visible={tzPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setTzPickerOpen(false)}
      >
        <TouchableOpacity
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 }}
          activeOpacity={1}
          onPress={() => setTzPickerOpen(false)}
        >
          <TouchableOpacity
            activeOpacity={1}
            onPress={(e) => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 420, maxHeight: '80%', backgroundColor: colors.card, borderRadius: 16, padding: 16 }}
          >
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 12 }}>{t('msSelectTimezone')}</Text>
            <FlatList
              data={(() => {
                const detected = detectDeviceTimezone();
                return [detected, ...COMMON_TIMEZONES.filter(tz => tz !== detected)];
              })()}
              keyExtractor={(item) => item}
              renderItem={({ item, index }) => (
                <TouchableOpacity
                  onPress={() => { setTimezone(item); setTzPickerOpen(false); }}
                  style={{
                    paddingVertical: 12, paddingHorizontal: 12,
                    borderRadius: 8,
                    backgroundColor: item === timezone ? 'rgba(16,185,129,0.15)' : 'transparent',
                  }}
                  activeOpacity={0.7}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {index === 0 && (
                      <Ionicons name="locate" size={14} color={colors.emerald} style={{ marginRight: 6 }} />
                    )}
                    <Text style={{ color: item === timezone ? colors.emerald : colors.text, fontSize: 14, flex: 1 }}>
                      {item}
                    </Text>
                    {item === timezone && (
                      <Ionicons name="checkmark" size={18} color={colors.emerald} />
                    )}
                  </View>
                  {index === 0 && (
                    <Text style={{ color: colors.textMuted, fontSize: 11, marginLeft: 20, marginTop: 2 }}>
                      {t('msTimezoneAutoDetected')}
                    </Text>
                  )}
                </TouchableOpacity>
              )}
              style={{ maxHeight: 480 }}
            />
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ── STICKY SAVE BAR — always visible, outside the ScrollView ── */}
      <View style={[styles.saveBar, { paddingBottom: insets.bottom + 12 }]} pointerEvents="box-none">
        <TouchableOpacity
          onPress={handleSaveAll}
          disabled={!mowerOnline || !isDirty || sending === 'save'}
          style={[
            styles.saveButton,
            (!mowerOnline || !isDirty || sending === 'save') && styles.saveButtonDisabled,
          ]}
          activeOpacity={0.85}
        >
          <Ionicons
            name={sending === 'save' ? 'sync' : 'save-outline'}
            size={18}
            color={colors.white}
          />
          <Text style={styles.saveButtonText}>{saveLabel}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  scroll: { padding: 24 },
  title: { fontSize: 28, fontWeight: '700', color: c.text },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  syncChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    borderWidth: 1, marginBottom: 20,
  },
  syncChipOk: {
    backgroundColor: 'rgba(0,212,170,0.10)',
    borderColor: 'rgba(0,212,170,0.4)',
  },
  syncChipWarn: {
    backgroundColor: 'rgba(245,158,11,0.10)',
    borderColor: 'rgba(245,158,11,0.4)',
  },
  syncChipText: { fontSize: 12, fontWeight: '600' },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 22, fontWeight: '700', color: c.text, marginTop: 16 },
  offlineBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(245,158,11,0.1)', borderRadius: 12, padding: 12, marginBottom: 20,
  },
  offlineText: { flex: 1, fontSize: 13, color: c.amber, lineHeight: 18 },
  section: { marginBottom: 20 },
  sectionDisabled: { opacity: 0.3 },
  sectionTitle: {
    fontSize: 13, fontWeight: '600', color: c.textDim,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginLeft: 4,
  },
  sectionTitleDanger: { color: c.red },
  card: {
    backgroundColor: c.card, borderRadius: 16,
    borderWidth: 1, borderColor: c.cardBorder, padding: 16,
  },
  cardDanger: {
    borderColor: 'rgba(239,68,68,0.35)',
  },
  divider: {
    height: 1, backgroundColor: 'rgba(255,255,255,0.06)',
    marginVertical: 16,
  },
  fieldLabel: {
    fontSize: 13, fontWeight: '600', color: c.textDim,
    marginBottom: 8, marginLeft: 2,
  },
  currentValue: {
    fontSize: 32, fontWeight: '700', color: c.emerald,
    textAlign: 'center', marginBottom: 16, fontVariant: ['tabular-nums'],
  },
  chipGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center',
    marginBottom: 8,
  },
  optionSub: {
    fontSize: 12, color: c.textMuted, marginTop: 2,
  },
  sliderRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 12, marginBottom: 6, paddingHorizontal: 4,
  },
  sliderLabel: { fontSize: 13, color: c.textDim, fontWeight: '500' },
  sliderValue: { fontSize: 13, color: c.text, fontWeight: '600', fontVariant: ['tabular-nums'] },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  chipActive: { backgroundColor: c.emerald },
  chipText: { fontSize: 14, fontWeight: '600', color: c.textDim },
  chipTextActive: { color: c.text },
  optionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14,
    borderRadius: 12, marginBottom: 6,
  },
  optionRowActive: { backgroundColor: 'rgba(0,212,170,0.08)' },
  radio: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 2,
    borderColor: c.textMuted, alignItems: 'center', justifyContent: 'center',
  },
  radioActive: { borderColor: c.emerald },
  radioInner: {
    width: 12, height: 12, borderRadius: 6, backgroundColor: c.emerald,
  },
  optionInfo: { flex: 1 },
  optionLabel: { fontSize: 16, fontWeight: '600', color: c.text },
  optionLabelActive: { color: c.emerald },
  optionDesc: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  previewRow: {
    alignItems: 'center',
    marginBottom: 8,
    gap: 8,
  },
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
    backgroundColor: c.emerald,
  },
  toggleThumb: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: c.textMuted,
  },
  toggleThumbActive: {
    backgroundColor: c.white,
    alignSelf: 'flex-end',
  },
  saveBar: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    paddingHorizontal: 24,
    paddingTop: 12,
    backgroundColor: c.bg,
    borderTopWidth: 1,
    borderTopColor: c.cardBorder,
  },
  saveButton: {
    backgroundColor: c.emerald,
    paddingVertical: 14,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  saveButtonDisabled: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  saveButtonText: {
    color: c.white,
    fontSize: 15,
    fontWeight: '600',
  },
});
