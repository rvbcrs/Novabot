import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Animated,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { colors } from '../theme/colors';
import type { RootStackParams } from '../navigation/types';
import {
  provisionDevice,
  setBleLogCallback,
  bleLog,
  type ScannedDevice,
  type DeviceType,
  type ProvisionPhase,
} from '../services/ble';

type Props = NativeStackScreenProps<RootStackParams, 'Provision'>;

// Ordered steps — each step can match multiple BLE phases
const PROVISION_STEPS = [
  { key: 'connecting', phases: ['connecting'], label: 'Connecting' },
  { key: 'discovering', phases: ['discovering'], label: 'Discovering Services' },
  { key: 'wifi', phases: ['wifi'], label: 'Configuring WiFi' },
  { key: 'config', phases: ['rtk', 'lora'], label: 'Configuring Device' },
  { key: 'mqtt', phases: ['mqtt'], label: 'Setting MQTT' },
  { key: 'commit', phases: ['commit'], label: 'Saving Settings' },
];

const STEP_KEYS = PROVISION_STEPS.map(s => s.key);

type DeviceState = {
  device: ScannedDevice;
  currentPhase: ProvisionPhase | 'idle';
  message: string;
  completedPhases: Set<string>;
  success: boolean;
  error: boolean;
};

export default function ProvisionScreen({ navigation, route }: Props) {
  const { mqttAddr, mqttPort, wifiSsid, wifiPassword, devices } = route.params;
  const [deviceStates, setDeviceStates] = useState<Map<string, DeviceState>>(
    () => {
      const map = new Map<string, DeviceState>();
      for (const d of devices) {
        map.set(d.id, {
          device: d,
          currentPhase: 'idle',
          message: 'Waiting...',
          completedPhases: new Set(),
          success: false,
          error: false,
        });
      }
      return map;
    },
  );
  const [bleLogs, setBleLogs] = useState<string[]>([]);
  const [allDone, setAllDone] = useState(false);
  const [allSuccess, setAllSuccess] = useState(false);
  const [otaStatus, setOtaStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [otaMessage, setOtaMessage] = useState('');
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);
  const startedRef = useRef(false);

  // Success animation
  const successScale = useRef(new Animated.Value(0)).current;
  const successOpacity = useRef(new Animated.Value(0)).current;

  const updateDeviceState = useCallback(
    (deviceId: string, updater: (prev: DeviceState) => DeviceState) => {
      setDeviceStates((prev) => {
        const next = new Map(prev);
        const current = next.get(deviceId);
        if (current) {
          next.set(deviceId, updater(current));
        }
        return next;
      });
    },
    [],
  );

  const runProvisioning = useCallback(async () => {
    const results: boolean[] = [];

    for (const dev of devices) {
      const deviceType: DeviceType =
        dev.type === 'charger' || dev.type === 'mower' ? dev.type : 'mower';

      updateDeviceState(dev.id, (s) => ({
        ...s,
        currentPhase: 'connecting',
        message: 'Starting...',
      }));

      const ok = await provisionDevice(
        dev.id,
        deviceType,
        { wifiSsid, wifiPassword, mqttAddr, mqttPort },
        (phase, message) => {
          updateDeviceState(dev.id, (s) => {
            const completed = new Set(s.completedPhases);

            // Find which step this phase belongs to
            const activeStepIdx = PROVISION_STEPS.findIndex(st => st.phases.includes(phase));

            if (phase === 'done') {
              // Mark all steps as completed
              for (const st of PROVISION_STEPS) completed.add(st.key);
            } else if (activeStepIdx >= 0) {
              // Mark all steps BEFORE the active one as completed
              for (let i = 0; i < activeStepIdx; i++) {
                completed.add(PROVISION_STEPS[i].key);
              }
            }
            // Unknown phase → don't change anything

            return {
              ...s,
              currentPhase: phase,
              message,
              completedPhases: completed,
              success: phase === 'done',
              error: phase === 'error',
            };
          });
        },
      );

      results.push(ok);
    }

    setAllDone(true);
    setAllSuccess(results.every(Boolean));
  }, [devices, mqttAddr, mqttPort, wifiSsid, wifiPassword, updateDeviceState]);

  useEffect(() => {
    // Set up BLE log capture
    setBleLogCallback((msg) => setBleLogs(prev => [...prev.slice(-50), msg]));
    return () => setBleLogCallback(null);
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    runProvisioning();
  }, [runProvisioning]);

  // Check server reachability + device MQTT status when provisioning completes
  const [deviceOnline, setDeviceOnline] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!allDone || !allSuccess) return;

    const checkServer = async () => {
      const url = `http://${mqttAddr}:3000/api/setup/health`;
      bleLog(`[SERVER] Checking ${url}...`);
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        const body = await res.json() as Record<string, unknown>;
        const reachable = body?.server === 'running';
        bleLog(`[SERVER] Health: server=${body?.server}, mqtt=${body?.mqtt}, devices=${body?.devicesConnected}`);
        setServerReachable(reachable);

        if (reachable) {
          pollDeviceStatus();
        }
      } catch (e: any) {
        bleLog(`[SERVER] Health check failed: ${e.message}`);
        setServerReachable(false);
      }
    };

    const pollDeviceStatus = async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`http://${mqttAddr}:3000/api/setup/health`, {
          signal: controller.signal,
        });
        clearTimeout(timer);
        const body = await res.json() as Record<string, unknown>;
        const lastDevice = body?.lastDeviceOnline as Record<string, unknown> | null;
        const lastSn = lastDevice?.sn as string | null;
        const lastSeen = lastDevice?.last_seen as string | null;
        bleLog(`[MQTT-POLL] lastDevice=${lastSn}, lastSeen=${lastSeen}`);

        // Check if a device came online recently (within last 2 minutes)
        if (lastSeen) {
          const seenDate = new Date(lastSeen + 'Z'); // UTC
          const age = Date.now() - seenDate.getTime();
          if (age < 120000) { // 2 minutes
            const status: Record<string, boolean> = {};
            for (const dev of devices) status[dev.id] = true;
            setDeviceOnline(status);
            bleLog(`[MQTT-POLL] Device online! (${Math.round(age/1000)}s ago)`);
          }
        }
      } catch (e: any) {
        bleLog(`[MQTT-POLL] Failed: ${e.message}`);
      }
    };

    checkServer();

    // Poll device status every 5s for 60s
    const interval = setInterval(pollDeviceStatus, 5000);
    const stopAfter = setTimeout(() => clearInterval(interval), 60000);

    return () => {
      clearInterval(interval);
      clearTimeout(stopAfter);
    };
  }, [allDone, allSuccess, mqttAddr, devices]);

  // Animate success state
  useEffect(() => {
    if (allDone && allSuccess) {
      Animated.parallel([
        Animated.spring(successScale, {
          toValue: 1,
          friction: 4,
          tension: 40,
          useNativeDriver: true,
        }),
        Animated.timing(successOpacity, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [allDone, allSuccess, successScale, successOpacity]);

  const handleProvisionAnother = () => {
    navigation.navigate('DeviceChoice', { mqttAddr, mqttPort });
  };

  const handleOtaTrigger = async () => {
    setOtaStatus('sending');
    setOtaMessage('Checking for firmware updates...');
    try {
      // Check OTA versions available on the server
      const checkRes = await fetch(`http://${mqttAddr}:3000/api/dashboard/ota/versions`);
      if (!checkRes.ok) throw new Error('Server not reachable');
      const versions = await checkRes.json();

      if (!versions?.data?.length) {
        setOtaStatus('idle');
        setOtaMessage('No firmware updates available on server.');
        return;
      }

      // Trigger OTA for each provisioned device
      for (const dev of devices) {
        const sn = dev.name === 'CHARGER_PILE'
          ? '' // Charger SN comes from MQTT, we don't have it here
          : ''; // Same for mower

        // Try triggering with the latest version
        const latest = versions.data[0];
        setOtaMessage(`Sending firmware ${latest.version} to ${dev.name}...`);

        const triggerRes = await fetch(`http://${mqttAddr}:3000/api/dashboard/ota/trigger/${dev.name}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version_id: latest.id }),
        });

        if (triggerRes.ok) {
          setOtaMessage(`Firmware update sent to ${dev.name}!`);
        } else {
          const err = await triggerRes.json().catch(() => ({}));
          setOtaMessage(`OTA trigger failed: ${(err as any).error || 'Unknown error'}`);
        }
      }
      setOtaStatus('sent');
    } catch (err: any) {
      setOtaStatus('error');
      setOtaMessage(`Could not reach server: ${err.message}`);
    }
  };

  const handleRetry = () => {
    startedRef.current = false;
    setAllDone(false);
    setAllSuccess(false);
    const map = new Map<string, DeviceState>();
    for (const d of devices) {
      map.set(d.id, {
        device: d,
        currentPhase: 'idle',
        message: 'Waiting...',
        completedPhases: new Set(),
        success: false,
        error: false,
      });
    }
    setDeviceStates(map);
    // Re-trigger
    setTimeout(() => {
      startedRef.current = true;
      runProvisioning();
    }, 100);
  };

  const stateArray = Array.from(deviceStates.values());

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Provisioning</Text>
          <Text style={styles.subtitle}>
            {allDone
              ? allSuccess
                ? 'All devices provisioned successfully!'
                : 'Provisioning completed with errors.'
              : 'Configuring your devices via BLE...'}
          </Text>
        </View>

        {/* Success banner */}
        {allDone && allSuccess && (
          <Animated.View
            style={[
              styles.successBanner,
              {
                transform: [{ scale: successScale }],
                opacity: successOpacity,
              },
            ]}
          >
            <View style={styles.successIconCircle}>
              <Ionicons name="checkmark-circle" size={56} color={colors.green} />
            </View>
            <Text style={styles.successTitle}>Done!</Text>
            <Text style={styles.successSubtitle}>
              Your {devices.length > 1 ? 'devices are' : 'device is'} now configured
              and will reconnect to your network.
            </Text>

            {/* Device MQTT status */}
            {Object.keys(deviceOnline).length > 0 && (
              <View style={styles.onlineStatus}>
                <Ionicons name="pulse" size={16} color={colors.green} />
                <Text style={[styles.otaStatusText, { color: colors.green }]}>
                  Device connected to server via MQTT!
                </Text>
              </View>
            )}
            {serverReachable === true && Object.keys(deviceOnline).length === 0 && (
              <View style={styles.onlineStatus}>
                <ActivityIndicator size="small" color={colors.textDim} />
                <Text style={styles.otaStatusText}>
                  Waiting for device to connect to MQTT...
                </Text>
              </View>
            )}

            {/* OTA Firmware Update */}
            {otaStatus === 'idle' && serverReachable === true && (
              <TouchableOpacity
                style={styles.otaButton}
                onPress={handleOtaTrigger}
                activeOpacity={0.7}
              >
                <Ionicons name="cloud-download-outline" size={18} color={colors.white} />
                <Text style={styles.otaButtonText}>Check for Firmware Updates</Text>
              </TouchableOpacity>
            )}
            {otaStatus === 'idle' && serverReachable === false && (
              <View style={styles.otaStatus}>
                <Ionicons name="cloud-offline-outline" size={16} color={colors.textMuted} />
                <Text style={styles.otaStatusText}>Server not reachable — firmware updates unavailable</Text>
              </View>
            )}
            {otaStatus === 'idle' && serverReachable === null && (
              <View style={styles.otaStatus}>
                <Ionicons name="hourglass-outline" size={16} color={colors.textDim} />
                <Text style={styles.otaStatusText}>Checking server...</Text>
              </View>
            )}
            {otaStatus === 'sending' && (
              <View style={styles.otaStatus}>
                <Ionicons name="hourglass-outline" size={16} color={colors.amber} />
                <Text style={styles.otaStatusText}>{otaMessage}</Text>
              </View>
            )}
            {otaStatus === 'sent' && (
              <View style={styles.otaStatus}>
                <Ionicons name="checkmark-circle" size={16} color={colors.green} />
                <Text style={[styles.otaStatusText, { color: colors.green }]}>{otaMessage}</Text>
              </View>
            )}
            {otaStatus === 'error' && (
              <View style={styles.otaStatus}>
                <Ionicons name="alert-circle" size={16} color={colors.amber} />
                <Text style={[styles.otaStatusText, { color: colors.amber }]}>{otaMessage}</Text>
              </View>
            )}
          </Animated.View>
        )}

        {/* Device progress cards */}
        {stateArray.map((ds) => (
          <View key={ds.device.id} style={styles.deviceCard}>
            {/* Device header */}
            <View style={styles.deviceHeader}>
              <Ionicons
                name={ds.device.type === 'charger' ? 'flash' : 'construct'}
                size={20}
                color={ds.device.type === 'charger' ? colors.amber : colors.emerald}
              />
              <Text style={styles.deviceName}>{ds.device.name}</Text>
              {ds.success && (
                <View style={styles.successBadge}>
                  <Ionicons name="checkmark" size={14} color={colors.green} />
                  <Text style={styles.successBadgeText}>Done</Text>
                </View>
              )}
              {ds.error && (
                <View style={[styles.successBadge, { backgroundColor: 'rgba(239,68,68,0.15)' }]}>
                  <Ionicons name="close" size={14} color={colors.red} />
                  <Text style={[styles.successBadgeText, { color: colors.red }]}>Error</Text>
                </View>
              )}
            </View>

            {/* Steps */}
            <View style={styles.stepsContainer}>
              {PROVISION_STEPS.map((stepDef, i) => {
                const isCompleted = ds.completedPhases.has(stepDef.key);
                const isCurrent = stepDef.phases.includes(ds.currentPhase);
                const isError = ds.error && isCurrent;
                const isPending = !isCompleted && !isCurrent;

                return (
                  <View key={stepDef.key} style={styles.stepRow}>
                    {/* Connector line */}
                    {i > 0 && (
                      <View
                        style={[
                          styles.stepLine,
                          isCompleted || isCurrent
                            ? styles.stepLineActive
                            : styles.stepLineInactive,
                        ]}
                      />
                    )}
                    {/* Step indicator */}
                    <View style={styles.stepIndicatorRow}>
                      {isCompleted ? (
                        <View style={[styles.stepDot, styles.stepDotCompleted]}>
                          <Ionicons name="checkmark" size={12} color={colors.white} />
                        </View>
                      ) : isCurrent ? (
                        <View style={[styles.stepDot, isError ? styles.stepDotError : styles.stepDotActive]}>
                          {isError ? (
                            <Ionicons name="close" size={12} color={colors.white} />
                          ) : (
                            <View style={styles.stepPulse} />
                          )}
                        </View>
                      ) : (
                        <View style={[styles.stepDot, styles.stepDotPending]} />
                      )}
                      <Text
                        style={[
                          styles.stepLabel,
                          isCompleted && styles.stepLabelCompleted,
                          isCurrent && !isError && styles.stepLabelActive,
                          isError && styles.stepLabelError,
                          isPending && styles.stepLabelPending,
                        ]}
                      >
                        {stepDef.label}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>

            {/* Status message */}
            {ds.message && !ds.success && (
              <Text style={[styles.statusMessage, ds.error && { color: colors.red }]}>
                {ds.message}
              </Text>
            )}
          </View>
        ))}
        {/* Debug console */}
        {bleLogs.length > 0 && (
          <View style={styles.debugCard}>
            <Text style={styles.debugTitle}>BLE Debug Log</Text>
            <ScrollView style={styles.debugScroll} nestedScrollEnabled>
              {bleLogs.map((log, i) => (
                <Text key={i} style={styles.debugLine}>{log}</Text>
              ))}
            </ScrollView>
          </View>
        )}
      </ScrollView>

      {/* Bottom bar */}
      {allDone && (
        <View style={styles.bottomBar}>
          {!allSuccess && (
            <TouchableOpacity
              style={styles.retryButton}
              onPress={handleRetry}
              activeOpacity={0.7}
            >
              <Ionicons name="refresh" size={18} color={colors.text} />
              <Text style={styles.retryButtonText}>Retry</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.doneButton, !allSuccess && { flex: 1 }]}
            onPress={handleProvisionAnother}
            activeOpacity={0.7}
          >
            <Text style={styles.doneButtonText}>
              {allSuccess ? 'Provision Another' : 'Back to Devices'}
            </Text>
            <Ionicons name="arrow-forward" size={18} color={colors.white} />
          </TouchableOpacity>
        </View>
      )}
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
    paddingTop: 60,
    paddingBottom: 120,
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.white,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: colors.textDim,
    lineHeight: 22,
  },
  successBanner: {
    alignItems: 'center',
    paddingVertical: 24,
    marginBottom: 24,
  },
  successIconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(34,197,94,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  successTitle: {
    fontSize: 32,
    fontWeight: '800',
    color: colors.green,
    marginBottom: 8,
  },
  successSubtitle: {
    fontSize: 15,
    color: colors.textDim,
    textAlign: 'center',
    lineHeight: 22,
  },
  deviceCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 20,
    marginBottom: 16,
  },
  deviceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    gap: 8,
  },
  deviceName: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: colors.white,
  },
  successBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(34,197,94,0.15)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    gap: 4,
  },
  successBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.green,
  },
  stepsContainer: {
    marginLeft: 4,
  },
  stepRow: {
    position: 'relative',
  },
  stepLine: {
    position: 'absolute',
    left: 9,
    top: -8,
    width: 2,
    height: 8,
  },
  stepLineActive: {
    backgroundColor: colors.emerald,
  },
  stepLineInactive: {
    backgroundColor: colors.textMuted,
  },
  stepIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    gap: 12,
  },
  stepDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDotCompleted: {
    backgroundColor: colors.green,
  },
  stepDotActive: {
    backgroundColor: colors.emerald,
  },
  stepDotError: {
    backgroundColor: colors.red,
  },
  stepDotPending: {
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: colors.textMuted,
  },
  stepPulse: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.white,
  },
  stepLabel: {
    fontSize: 14,
  },
  stepLabelCompleted: {
    color: colors.green,
    fontWeight: '500',
  },
  stepLabelActive: {
    color: colors.emerald,
    fontWeight: '600',
  },
  stepLabelError: {
    color: colors.red,
    fontWeight: '500',
  },
  stepLabelPending: {
    color: colors.textMuted,
  },
  statusMessage: {
    marginTop: 12,
    fontSize: 13,
    color: colors.textDim,
    fontStyle: 'italic',
  },
  otaButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 16,
    paddingVertical: 12,
    paddingHorizontal: 20,
    backgroundColor: colors.purple,
    borderRadius: 12,
  },
  otaButtonText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
  },
  otaStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  debugCard: {
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 12,
    padding: 12,
    marginTop: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  debugTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.amber,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  debugScroll: {
    maxHeight: 200,
  },
  debugLine: {
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: colors.textDim,
    lineHeight: 16,
  },
  onlineStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(34,197,94,0.1)',
    borderRadius: 8,
  },
  otaStatusText: {
    color: colors.textDim,
    fontSize: 13,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    paddingHorizontal: 24,
    paddingVertical: 16,
    paddingBottom: 34,
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    backgroundColor: colors.bg,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    paddingHorizontal: 20,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    gap: 6,
  },
  retryButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  doneButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: 12,
    backgroundColor: colors.emerald,
    gap: 8,
  },
  doneButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.white,
  },
});
