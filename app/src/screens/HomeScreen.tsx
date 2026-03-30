/**
 * Home screen — real-time mower status and action buttons.
 */
import React, { useMemo, useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Animated,
  Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { BatteryRing } from '../components/BatteryRing';
import { MowerScene } from '../components/mower/MowerScene';
import { useMowerState } from '../hooks/useMowerState';
import { ApiClient } from '../services/api';
import { getServerUrl } from '../services/auth';
import { DemoBanner } from '../components/DemoBanner';
import type { DeviceState, MowerActivity } from '../types';

// ── Derive mower status ──────────────────────────────────────────────

interface MowerDerived {
  sn: string;
  online: boolean;
  activity: MowerActivity;
  battery: number;
  batteryCharging: boolean;
  wifiRssi: string | undefined;
  rtkSat: string | undefined;
  errorStatus: string | undefined;
  errorCode: string | undefined;
  errorMsg: string | undefined;
  hasError: boolean;
}

function deriveMower(devices: Map<string, DeviceState>): MowerDerived | null {
  const mower = [...devices.values()].find((d) => d.deviceType === 'mower');
  if (!mower) return null;

  const s = mower.sensors;
  const workStatus = s.work_status ?? '0';
  const isOffline = !mower.online;
  const hasError = Boolean(
    (s.error_status && s.error_status !== 'OK' && s.error_status !== '0') ||
      (s.error_code && s.error_code !== 'None' && s.error_code !== '0'),
  );

  let activity: MowerActivity = 'idle';
  if (isOffline) activity = 'idle';
  else if (hasError && workStatus !== '0') activity = 'error';
  else if (s.start_edit_or_assistant_map_flag === '1') activity = 'mapping';
  else if (
    workStatus === '2' ||
    s.battery_state?.toUpperCase() === 'CHARGING'
  )
    activity = 'charging';
  else if (workStatus === '3') activity = 'returning';
  else if (workStatus === '4') activity = 'paused';
  else if (workStatus === '1') activity = 'mowing';

  return {
    sn: mower.sn,
    online: mower.online,
    activity,
    battery:
      parseInt(s.battery_power ?? s.battery_capacity ?? '0', 10) || 0,
    batteryCharging: activity === 'charging',
    wifiRssi: s.wifi_rssi,
    rtkSat: s.rtk_sat,
    errorStatus: s.error_status,
    errorCode: s.error_code,
    errorMsg: s.error_msg,
    hasError,
  };
}

// ── Activity display helpers ─────────────────────────────────────────

function getActivityLabel(activity: MowerActivity): string {
  switch (activity) {
    case 'mowing':
      return 'Mowing';
    case 'charging':
      return 'Charging';
    case 'returning':
      return 'Returning Home';
    case 'paused':
      return 'Paused';
    case 'error':
      return 'Error';
    case 'mapping':
      return 'Mapping';
    case 'idle':
    default:
      return 'Idle';
  }
}

function getActivityColor(activity: MowerActivity): string {
  switch (activity) {
    case 'mowing':
      return colors.green;
    case 'charging':
      return colors.blue;
    case 'returning':
      return colors.blue;
    case 'paused':
      return colors.amber;
    case 'error':
      return colors.red;
    case 'mapping':
      return colors.purple;
    case 'idle':
    default:
      return colors.textDim;
  }
}

function getActivityIcon(
  activity: MowerActivity,
): React.ComponentProps<typeof Ionicons>['name'] {
  switch (activity) {
    case 'mowing':
      return 'leaf';
    case 'charging':
      return 'battery-charging';
    case 'returning':
      return 'home';
    case 'paused':
      return 'pause-circle';
    case 'error':
      return 'alert-circle';
    case 'mapping':
      return 'map';
    case 'idle':
    default:
      return 'moon';
  }
}

// ── Glow colors per activity (matching dashboard StatusHeroCard) ────

const GLOW_COLOR: Record<MowerActivity, string> = {
  idle:      'transparent',
  mowing:    'rgba(16, 185, 129, 0.20)',
  charging:  'rgba(59, 130, 246, 0.20)',
  returning: 'rgba(245, 158, 11, 0.15)',
  paused:    'rgba(234, 179, 8, 0.12)',
  mapping:   'rgba(168, 85, 247, 0.15)',
  error:     'rgba(239, 68, 68, 0.20)',
};

// ── Component ────────────────────────────────────────────────────────

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { devices, connected } = useMowerState();
  const mower = useMemo(() => deriveMower(devices), [devices]);
  const [commandLoading, setCommandLoading] = useState<string | null>(null);
  const [commandError, setCommandError] = useState('');

  // Mower bounce animation (subtle bob when active)
  const bounceAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!mower) return;
    const isMoving = mower.activity === 'mowing' || mower.activity === 'returning' || mower.activity === 'mapping';
    if (isMoving) {
      // Continuous bounce
      Animated.loop(
        Animated.sequence([
          Animated.timing(bounceAnim, { toValue: -4, duration: 400, useNativeDriver: true }),
          Animated.timing(bounceAnim, { toValue: 0, duration: 400, useNativeDriver: true }),
        ])
      ).start();
    } else if (mower.activity === 'charging') {
      // Gentle pulse
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.05, duration: 1000, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
        ])
      ).start();
    } else {
      bounceAnim.setValue(0);
      pulseAnim.setValue(1);
    }
  }, [mower?.activity]);

  const sendCommand = async (
    sn: string,
    command: Record<string, unknown>,
    label: string,
  ) => {
    setCommandLoading(label);
    setCommandError('');
    try {
      const url = await getServerUrl();
      if (!url) {
        setCommandError('No server configured');
        return;
      }
      const api = new ApiClient(url);
      const result = await api.sendCommand(sn, command);
      if (!result.ok) {
        setCommandError(result.error ?? 'Command failed');
      }
    } catch (e) {
      setCommandError(e instanceof Error ? e.message : 'Command failed');
    } finally {
      setCommandLoading(null);
    }
  };

  // ── No devices state ────────────────────────────────────────────
  if (!mower) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.emptyState}>
          <View style={styles.emptyIconCircle}>
            <Ionicons name="leaf-outline" size={48} color={colors.textMuted} />
          </View>
          <Text style={styles.emptyTitle}>No Mower Found</Text>
          <Text style={styles.emptySubtitle}>
            {connected
              ? 'No devices are connected to the server. Go to the Provision tab to set up your mower.'
              : 'Connecting to server...'}
          </Text>
          {!connected && (
            <ActivityIndicator
              size="small"
              color={colors.emerald}
              style={{ marginTop: 16 }}
            />
          )}
          <View style={{ width: '100%', marginTop: 24 }}>
            <DemoBanner />
          </View>
        </View>
      </View>
    );
  }

  const activityColor = getActivityColor(mower.activity);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Global demo toggle */}
        <DemoBanner />

        {/* Connection indicator */}
        <View style={styles.connectionRow}>
          <View
            style={[
              styles.connectionDot,
              { backgroundColor: connected ? colors.green : colors.red },
            ]}
          />
          <Text style={styles.connectionText}>
            {connected ? 'Connected' : 'Disconnected'}
          </Text>
          {mower.online && (
            <>
              <View style={styles.connectionSpacer} />
              <View
                style={[
                  styles.connectionDot,
                  { backgroundColor: colors.green },
                ]}
              />
              <Text style={styles.connectionText}>Mower Online</Text>
            </>
          )}
        </View>

        {/* Mower animation scene */}
        <MowerScene activity={mower.activity} battery={mower.battery} />

        {/* Status card */}
        <View style={styles.statusCard}>
          {/* Activity header */}
          <View style={styles.activityRow}>
            <Ionicons
              name={getActivityIcon(mower.activity)}
              size={24}
              color={activityColor}
            />
            <Text style={[styles.activityLabel, { color: activityColor }]}>
              {getActivityLabel(mower.activity)}
            </Text>
          </View>

          {/* Battery ring + mower image (like dashboard StatusHeroCard) */}
          <View style={[styles.batteryContainer, { shadowColor: GLOW_COLOR[mower.activity], shadowRadius: 30, shadowOpacity: 1 }]}>
            <BatteryRing
              percentage={mower.battery}
              size={160}
              strokeWidth={10}
              color={mower.activity === 'idle' ? undefined : getActivityColor(mower.activity)}
            />
            <Animated.View style={[styles.batteryTextOverlay, { transform: [{ translateY: bounceAnim }, { scale: pulseAnim }] }]}>
              <Image
                source={mower.online ? require('../../assets/mower.png') : require('../../assets/mower_offline.png')}
                style={styles.mowerImage}
              />
              <View style={styles.batteryRow}>
                <Text style={styles.batteryPercentage}>{mower.battery}</Text>
                <Text style={styles.batteryPercSign}>%</Text>
                {mower.batteryCharging && (
                  <Ionicons name="flash" size={14} color={colors.blue} style={{ marginLeft: 2 }} />
                )}
              </View>
            </Animated.View>
          </View>

          {/* Signal chips */}
          <View style={styles.chipsRow}>
            {mower.wifiRssi != null && (
              <View style={styles.chip}>
                <Ionicons name="wifi" size={14} color={colors.textDim} />
                <Text style={styles.chipText}>{mower.wifiRssi} dBm</Text>
              </View>
            )}
            {mower.rtkSat != null && (
              <View style={styles.chip}>
                <Ionicons name="navigate" size={14} color={colors.textDim} />
                <Text style={styles.chipText}>{mower.rtkSat} sats</Text>
              </View>
            )}
            {!mower.online && (
              <View style={[styles.chip, styles.chipOffline]}>
                <Ionicons
                  name="cloud-offline"
                  size={14}
                  color={colors.red}
                />
                <Text style={[styles.chipText, { color: colors.red }]}>
                  Offline
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* Error display */}
        {mower.hasError && (
          <View style={styles.errorCard}>
            <Ionicons name="alert-circle" size={22} color={colors.red} />
            <View style={styles.errorContent}>
              <Text style={styles.errorTitle}>
                Error {mower.errorStatus ?? mower.errorCode ?? ''}
              </Text>
              {mower.errorMsg && (
                <Text style={styles.errorMessage}>{mower.errorMsg}</Text>
              )}
            </View>
          </View>
        )}

        {/* Action buttons */}
        <View style={styles.actionsCard}>
          <Text style={styles.actionsTitle}>ACTIONS</Text>

          {(mower.activity === 'idle' || mower.activity === 'charging') && (
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonGreen]}
                onPress={() =>
                  sendCommand(mower.sn, { start_run: {} }, 'start')
                }
                disabled={commandLoading !== null || !mower.online}
                activeOpacity={0.7}
              >
                {commandLoading === 'start' ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <>
                    <Ionicons name="play" size={20} color={colors.white} />
                    <Text style={styles.actionButtonText}>Start Mowing</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}

          {mower.activity === 'mowing' && (
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonAmber]}
                onPress={() =>
                  sendCommand(mower.sn, { stop_run: {} }, 'pause')
                }
                disabled={commandLoading !== null}
                activeOpacity={0.7}
              >
                {commandLoading === 'pause' ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <>
                    <Ionicons name="pause" size={20} color={colors.white} />
                    <Text style={styles.actionButtonText}>Stop</Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonBlue]}
                onPress={() =>
                  sendCommand(mower.sn, { go_to_charge: {} }, 'home')
                }
                disabled={commandLoading !== null}
                activeOpacity={0.7}
              >
                {commandLoading === 'home' ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <>
                    <Ionicons name="home" size={20} color={colors.white} />
                    <Text style={styles.actionButtonText}>Go Home</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}

          {mower.activity === 'paused' && (
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonGreen]}
                onPress={() =>
                  sendCommand(mower.sn, { start_run: {} }, 'resume')
                }
                disabled={commandLoading !== null}
                activeOpacity={0.7}
              >
                {commandLoading === 'resume' ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <>
                    <Ionicons name="play" size={20} color={colors.white} />
                    <Text style={styles.actionButtonText}>Resume</Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonBlue]}
                onPress={() =>
                  sendCommand(mower.sn, { go_to_charge: {} }, 'home')
                }
                disabled={commandLoading !== null}
                activeOpacity={0.7}
              >
                {commandLoading === 'home' ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <>
                    <Ionicons name="home" size={20} color={colors.white} />
                    <Text style={styles.actionButtonText}>Go Home</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}

          {mower.activity === 'error' && (
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonBlue]}
                onPress={() =>
                  sendCommand(mower.sn, { go_to_charge: {} }, 'home')
                }
                disabled={commandLoading !== null}
                activeOpacity={0.7}
              >
                {commandLoading === 'home' ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <>
                    <Ionicons name="home" size={20} color={colors.white} />
                    <Text style={styles.actionButtonText}>Go Home</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}

          {mower.activity === 'returning' && (
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonAmber]}
                onPress={() =>
                  sendCommand(mower.sn, { stop_run: {} }, 'stop')
                }
                disabled={commandLoading !== null}
                activeOpacity={0.7}
              >
                {commandLoading === 'stop' ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <>
                    <Ionicons name="stop" size={20} color={colors.white} />
                    <Text style={styles.actionButtonText}>Stop</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}

          {!mower.online && (
            <Text style={styles.offlineNote}>
              Mower is offline. Commands cannot be sent.
            </Text>
          )}
        </View>

        {/* Command error */}
        {commandError !== '' && (
          <View style={styles.commandError}>
            <Ionicons name="alert-circle" size={16} color={colors.red} />
            <Text style={styles.commandErrorText}>{commandError}</Text>
          </View>
        )}

        {/* Serial number */}
        <Text style={styles.snText}>SN: {mower.sn}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    padding: 24,
    paddingBottom: 32,
  },
  connectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  connectionText: {
    fontSize: 13,
    color: colors.textDim,
  },
  connectionSpacer: {
    width: 16,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyIconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: 'rgba(255,255,255,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.white,
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 15,
    color: colors.textDim,
    textAlign: 'center',
    lineHeight: 22,
  },
  statusCard: {
    backgroundColor: colors.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 24,
    alignItems: 'center',
    marginBottom: 16,
  },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 20,
  },
  activityLabel: {
    fontSize: 22,
    fontWeight: '700',
  },
  batteryContainer: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  batteryTextOverlay: {
    position: 'absolute',
    alignItems: 'center',
  },
  mowerImage: {
    width: 56,
    height: 56,
    resizeMode: 'contain',
    marginBottom: 2,
  },
  batteryRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  batteryPercentage: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.white,
  },
  batteryPercSign: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textDim,
    marginLeft: 1,
  },
  chipsRow: {
    flexDirection: 'row',
    gap: 10,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 20,
  },
  chipOffline: {
    backgroundColor: 'rgba(239,68,68,0.1)',
  },
  chipText: {
    fontSize: 13,
    color: colors.textDim,
  },
  errorCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.2)',
    padding: 16,
    marginBottom: 16,
    gap: 12,
  },
  errorContent: {
    flex: 1,
  },
  errorTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.red,
    marginBottom: 4,
  },
  errorMessage: {
    fontSize: 13,
    color: 'rgba(239,68,68,0.8)',
    lineHeight: 18,
  },
  actionsCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 20,
    marginBottom: 16,
  },
  actionsTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 16,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: 12,
    gap: 8,
  },
  actionButtonGreen: {
    backgroundColor: colors.green,
  },
  actionButtonAmber: {
    backgroundColor: colors.amber,
  },
  actionButtonBlue: {
    backgroundColor: colors.blue,
  },
  actionButtonGray: {
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  actionButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.white,
  },
  offlineNote: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 8,
  },
  commandError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 16,
  },
  commandErrorText: {
    fontSize: 13,
    color: colors.red,
  },
  snText: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    fontFamily: 'monospace',
  },
});
