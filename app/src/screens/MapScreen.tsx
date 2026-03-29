/**
 * Map screen — Phase 1 placeholder.
 * Will be replaced with react-native-maps in a follow-up.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { useMowerState } from '../hooks/useMowerState';
import type { DeviceState } from '../types';

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const { devices, connected } = useMowerState();

  const mower = useMemo(() => {
    return [...devices.values()].find((d) => d.deviceType === 'mower') ?? null;
  }, [devices]);

  const charger = useMemo(() => {
    return [...devices.values()].find((d) => d.deviceType === 'charger') ?? null;
  }, [devices]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.content}>
        {/* Placeholder icon */}
        <View style={styles.iconCircle}>
          <Ionicons name="map-outline" size={48} color={colors.emerald} />
        </View>

        <Text style={styles.title}>Map</Text>
        <Text style={styles.subtitle}>
          Interactive map coming soon. This will show your mower's position,
          mowing zones, and charger location.
        </Text>

        {/* Device status summary */}
        {connected && (mower || charger) && (
          <View style={styles.summaryCard}>
            <Text style={styles.summaryTitle}>DEVICE STATUS</Text>

            {mower && (
              <DeviceSummaryRow
                icon="construct"
                iconColor={colors.emerald}
                label="Mower"
                sn={mower.sn}
                online={mower.online}
                sensors={mower.sensors}
              />
            )}
            {charger && (
              <DeviceSummaryRow
                icon="flash"
                iconColor={colors.amber}
                label="Charger"
                sn={charger.sn}
                online={charger.online}
                sensors={charger.sensors}
              />
            )}
          </View>
        )}

        {!connected && (
          <Text style={styles.offlineText}>
            Not connected to server.
          </Text>
        )}
      </View>
    </View>
  );
}

function DeviceSummaryRow({
  icon,
  iconColor,
  label,
  sn,
  online,
  sensors,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  iconColor: string;
  label: string;
  sn: string;
  online: boolean;
  sensors: Record<string, string>;
}) {
  const lat = sensors.latitude;
  const lng = sensors.longitude;

  return (
    <View style={summaryStyles.row}>
      <Ionicons name={icon} size={18} color={iconColor} />
      <View style={summaryStyles.info}>
        <Text style={summaryStyles.label}>{label}</Text>
        <Text style={summaryStyles.sn}>{sn}</Text>
        {lat && lng && (
          <Text style={summaryStyles.coords}>
            {parseFloat(lat).toFixed(6)}, {parseFloat(lng).toFixed(6)}
          </Text>
        )}
      </View>
      <View
        style={[
          summaryStyles.statusDot,
          { backgroundColor: online ? colors.green : colors.red },
        ]}
      />
      <Text
        style={[
          summaryStyles.statusText,
          { color: online ? colors.green : colors.red },
        ]}
      >
        {online ? 'Online' : 'Offline'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: 'rgba(0,212,170,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.white,
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 15,
    color: colors.textDim,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },
  summaryCard: {
    width: '100%',
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 16,
  },
  summaryTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  offlineText: {
    fontSize: 14,
    color: colors.textMuted,
  },
});

const summaryStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  info: {
    flex: 1,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.white,
  },
  sn: {
    fontSize: 11,
    color: colors.textDim,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  coords: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
  },
});
