/**
 * Messages screen — error alerts and robot notifications.
 * Shows current errors from live sensor data + work status history.
 */
import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { useMowerState } from '../hooks/useMowerState';

// Error code → human-readable message (from Novabot app mower_error_text.dart)
const ERROR_MESSAGES: Record<string, string> = {
  '1': 'Blade motor stalled',
  '2': 'Blade motor overcurrent',
  '3': 'Left wheel motor stalled',
  '4': 'Left wheel motor overcurrent',
  '5': 'Right wheel motor stalled',
  '6': 'Right wheel motor overcurrent',
  '7': 'Left wheel motor blocked',
  '8': 'Right wheel motor blocked',
  '10': 'Emergency button pressed',
  '11': 'Mower lifted',
  '12': 'Mower tilted',
  '13': 'Mower turned over',
  '20': 'TOF sensor malfunction',
  '21': 'Front camera malfunction',
  '30': 'Chassis communication error',
  '31': 'IMU sensor error',
  '40': 'Low battery',
  '41': 'Charging error',
  '50': 'GPS signal lost',
  '51': 'RTK signal lost',
  '100': 'WiFi connection lost',
  '101': 'MQTT connection lost',
  '150': 'Unknown error',
  '151': 'Localization error',
  '200': 'PIN lock active',
};

function getErrorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? `Error code ${code}`;
}

function getErrorSeverity(code: string): 'critical' | 'warning' | 'info' {
  const n = parseInt(code, 10);
  if (n >= 1 && n <= 13) return 'critical'; // motor/physical
  if (n >= 20 && n <= 31) return 'warning'; // sensor
  if (n >= 40 && n <= 51) return 'warning'; // battery/gps
  if (n >= 100 && n <= 101) return 'info'; // network
  return 'warning';
}

const SEVERITY_COLORS = {
  critical: colors.red,
  warning: colors.amber,
  info: colors.blue,
};

const SEVERITY_ICONS: Record<string, React.ComponentProps<typeof Ionicons>['name']> = {
  critical: 'alert-circle',
  warning: 'warning',
  info: 'information-circle',
};

export default function MessagesScreen() {
  const insets = useSafeAreaInsets();
  const { devices, connected } = useMowerState();

  const mower = useMemo(() => {
    return [...devices.values()].find((d) => d.deviceType === 'mower') ?? null;
  }, [devices]);

  const charger = useMemo(() => {
    return [...devices.values()].find((d) => d.deviceType === 'charger') ?? null;
  }, [devices]);

  // Build live alerts from sensor data
  const alerts = useMemo(() => {
    const items: Array<{
      id: string;
      severity: 'critical' | 'warning' | 'info';
      title: string;
      detail: string;
      device: string;
    }> = [];

    if (mower) {
      // Error status
      const errStatus = mower.sensors.error_status;
      if (errStatus && errStatus !== '0' && errStatus !== 'OK') {
        const severity = getErrorSeverity(errStatus);
        items.push({
          id: `mower-error-${errStatus}`,
          severity,
          title: getErrorMessage(errStatus),
          detail: mower.sensors.error_msg || `Status code: ${errStatus}`,
          device: 'Mower',
        });
      }

      // Error code (separate field)
      const errCode = mower.sensors.error_code;
      if (errCode && errCode !== '0' && errCode !== 'None' && errCode !== errStatus) {
        const severity = getErrorSeverity(errCode);
        items.push({
          id: `mower-code-${errCode}`,
          severity,
          title: getErrorMessage(errCode),
          detail: `Error code: ${errCode}`,
          device: 'Mower',
        });
      }

      // Low battery warning
      const battery = parseInt(mower.sensors.battery_power ?? '100', 10);
      if (battery > 0 && battery < 15 && mower.online) {
        items.push({
          id: 'mower-low-battery',
          severity: 'warning',
          title: 'Low battery',
          detail: `Battery at ${battery}%. Mower should return to charger.`,
          device: 'Mower',
        });
      }

      // Offline warning
      if (!mower.online) {
        items.push({
          id: 'mower-offline',
          severity: 'info',
          title: 'Mower offline',
          detail: 'Mower is not connected to the server.',
          device: 'Mower',
        });
      }

      // WiFi signal warning
      const rssi = parseInt(mower.sensors.wifi_rssi ?? '0', 10);
      if (rssi < -80 && rssi !== 0 && mower.online) {
        items.push({
          id: 'mower-weak-wifi',
          severity: 'info',
          title: 'Weak WiFi signal',
          detail: `WiFi RSSI: ${rssi} dBm. Coverage may be unreliable.`,
          device: 'Mower',
        });
      }
    }

    if (charger && !charger.online) {
      items.push({
        id: 'charger-offline',
        severity: 'info',
        title: 'Charger offline',
        detail: 'Charging station is not connected.',
        device: 'Charger',
      });
    }

    // Sort: critical first, then warning, then info
    const order = { critical: 0, warning: 1, info: 2 };
    items.sort((a, b) => order[a.severity] - order[b.severity]);

    return items;
  }, [mower, charger]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Messages</Text>

        {!connected && (
          <View style={styles.disconnectedBanner}>
            <Ionicons name="cloud-offline" size={16} color={colors.red} />
            <Text style={styles.disconnectedText}>Not connected to server</Text>
          </View>
        )}

        {alerts.length === 0 && connected && (
          <View style={styles.allClear}>
            <View style={styles.allClearIcon}>
              <Ionicons name="checkmark-circle" size={48} color={colors.green} />
            </View>
            <Text style={styles.allClearTitle}>All Clear</Text>
            <Text style={styles.allClearSubtitle}>No active alerts or warnings.</Text>
          </View>
        )}

        {alerts.map((alert) => {
          const color = SEVERITY_COLORS[alert.severity];
          const icon = SEVERITY_ICONS[alert.severity];
          return (
            <View
              key={alert.id}
              style={[styles.alertCard, { borderLeftColor: color }]}
            >
              <View style={styles.alertHeader}>
                <Ionicons name={icon} size={20} color={color} />
                <Text style={[styles.alertTitle, { color }]}>{alert.title}</Text>
                <View style={[styles.deviceBadge, { backgroundColor: `${color}20` }]}>
                  <Text style={[styles.deviceBadgeText, { color }]}>{alert.device}</Text>
                </View>
              </View>
              <Text style={styles.alertDetail}>{alert.detail}</Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 24, paddingBottom: 32 },
  title: { fontSize: 28, fontWeight: '700', color: colors.white, marginBottom: 24 },
  disconnectedBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 12, padding: 12, marginBottom: 20,
  },
  disconnectedText: { fontSize: 14, color: colors.red },
  allClear: { alignItems: 'center', paddingVertical: 60 },
  allClearIcon: { marginBottom: 16 },
  allClearTitle: { fontSize: 22, fontWeight: '700', color: colors.white, marginBottom: 8 },
  allClearSubtitle: { fontSize: 15, color: colors.textDim },
  alertCard: {
    backgroundColor: colors.card, borderRadius: 14,
    borderWidth: 1, borderColor: colors.cardBorder,
    borderLeftWidth: 4, padding: 16, marginBottom: 12,
  },
  alertHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  alertTitle: { flex: 1, fontSize: 15, fontWeight: '600' },
  deviceBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  deviceBadgeText: { fontSize: 11, fontWeight: '600' },
  alertDetail: { fontSize: 13, color: colors.textDim, lineHeight: 18, marginLeft: 28 },
});
