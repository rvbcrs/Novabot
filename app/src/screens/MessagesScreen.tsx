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
import { useStyles, useTheme, type Colors } from '../theme';
import { useMowerState } from '../hooks/useMowerState';
import { useActiveMower } from '../hooks/useActiveMower';
import { useI18n } from '../i18n';

// Error code → i18n key (texts from Novabot app mower_error_text.dart)
const ERROR_MESSAGE_KEYS: Record<string, string> = {
  '1': 'stErr1',
  '2': 'stErr2',
  '3': 'stErr3',
  '4': 'stErr4',
  '5': 'stErr5',
  '6': 'stErr6',
  '7': 'stErr7',
  '8': 'stErr8',
  '10': 'stErr10',
  '11': 'stErr11',
  '12': 'stErr12',
  '13': 'stErr13',
  '20': 'stErr20',
  '21': 'stErr21',
  '30': 'stErr30',
  '31': 'stErr31',
  '40': 'stErr40',
  '41': 'stErr41',
  '50': 'stErr50',
  '51': 'stErr51',
  '100': 'stErr100',
  '101': 'stErr101',
  '150': 'stErr150',
  '151': 'stErr151',
  '155': 'stErr155',
  '200': 'stErr200',
};

type TFn = (key: string, params?: Record<string, string | number>) => string;

function getErrorMessage(code: string, t: TFn): string {
  const key = ERROR_MESSAGE_KEYS[code];
  return key ? t(key) : t('stErrorCode', { code });
}

function getErrorSeverity(code: string): 'critical' | 'warning' | 'info' {
  const n = parseInt(code, 10);
  if (n >= 1 && n <= 13) return 'critical'; // motor/physical
  if (n >= 20 && n <= 31) return 'warning'; // sensor
  if (n >= 40 && n <= 51) return 'warning'; // battery/gps
  if (n >= 100 && n <= 101) return 'info'; // network
  return 'warning';
}

function getSeverityColors(c: Colors) {
  return {
    critical: c.red,
    warning: c.amber,
    info: c.blue,
  };
}

const SEVERITY_ICONS: Record<string, React.ComponentProps<typeof Ionicons>['name']> = {
  critical: 'alert-circle',
  warning: 'warning',
  info: 'information-circle',
};

export default function MessagesScreen() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const SEVERITY_COLORS = getSeverityColors(colors);
  const insets = useSafeAreaInsets();
  const { devices, connected } = useMowerState();
  const { t } = useI18n();

  const { activeMower: mower } = useActiveMower();

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
          title: getErrorMessage(errStatus, t),
          detail: mower.sensors.error_msg || t('stStatusCode', { code: errStatus }),
          device: t('mower'),
        });
      }

      // Error code (separate field)
      const errCode = mower.sensors.error_code;
      if (errCode && errCode !== '0' && errCode !== 'None' && errCode !== errStatus) {
        const severity = getErrorSeverity(errCode);
        items.push({
          id: `mower-code-${errCode}`,
          severity,
          title: getErrorMessage(errCode, t),
          detail: t('stErrorCode', { code: errCode }),
          device: t('mower'),
        });
      }

      // Low battery warning
      const battery = parseInt(mower.sensors.battery_power ?? '100', 10);
      if (battery > 0 && battery < 15 && mower.online) {
        items.push({
          id: 'mower-low-battery',
          severity: 'warning',
          title: t('stLowBattery'),
          detail: t('stLowBatteryDetail', { pct: battery }),
          device: t('mower'),
        });
      }

      // Offline warning
      if (!mower.online) {
        items.push({
          id: 'mower-offline',
          severity: 'info',
          title: t('stMowerOffline'),
          detail: t('stMowerOfflineDetail'),
          device: t('mower'),
        });
      }

      // WiFi signal warning
      const rssi = parseInt(mower.sensors.wifi_rssi ?? '0', 10);
      if (rssi < 35 && rssi !== 0 && mower.online) {
        items.push({
          id: 'mower-weak-wifi',
          severity: 'info',
          title: t('stWeakWifi'),
          detail: t('stWeakWifiDetail', { pct: rssi }),
          device: t('mower'),
        });
      }
    }

    if (charger && !charger.online) {
      items.push({
        id: 'charger-offline',
        severity: 'info',
        title: t('stChargerOffline'),
        detail: t('stChargerOfflineDetail'),
        device: t('charger'),
      });
    }

    // Sort: critical first, then warning, then info
    const order = { critical: 0, warning: 1, info: 2 };
    items.sort((a, b) => order[a.severity] - order[b.severity]);

    return items;
  }, [mower, charger, t]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {!connected && (
          <View style={styles.disconnectedBanner}>
            <Ionicons name="cloud-offline" size={16} color={colors.red} />
            <Text style={styles.disconnectedText}>{t('stNotConnectedServer')}</Text>
          </View>
        )}

        {alerts.length === 0 && connected && (
          <View style={styles.allClear}>
            <View style={styles.allClearIcon}>
              <Ionicons name="checkmark-circle" size={48} color={colors.green} />
            </View>
            <Text style={styles.allClearTitle}>{t('stAllClear')}</Text>
            <Text style={styles.allClearSubtitle}>{t('stAllClearSub')}</Text>
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

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  scroll: { padding: 24, paddingBottom: 32 },
  title: { fontSize: 28, fontWeight: '700', color: c.text, marginBottom: 24 },
  disconnectedBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 12, padding: 12, marginBottom: 20,
  },
  disconnectedText: { fontSize: 14, color: c.red },
  allClear: { alignItems: 'center', paddingVertical: 60 },
  allClearIcon: { marginBottom: 16 },
  allClearTitle: { fontSize: 22, fontWeight: '700', color: c.text, marginBottom: 8 },
  allClearSubtitle: { fontSize: 15, color: c.textDim },
  alertCard: {
    backgroundColor: c.card, borderRadius: 14,
    borderWidth: 1, borderColor: c.cardBorder,
    borderLeftWidth: 4, padding: 16, marginBottom: 12,
  },
  alertHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  alertTitle: { flex: 1, fontSize: 15, fontWeight: '600' },
  deviceBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  deviceBadgeText: { fontSize: 11, fontWeight: '600' },
  alertDetail: { fontSize: 13, color: c.textDim, lineHeight: 18, marginLeft: 28 },
});
