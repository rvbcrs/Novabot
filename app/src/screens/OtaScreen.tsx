/**
 * OTA screen — view firmware versions, trigger updates.
 * Ported from dashboard OtaManager.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { useMowerState } from '../hooks/useMowerState';
import { ApiClient, type OtaVersion } from '../services/api';
import { getServerUrl } from '../services/auth';

export default function OtaScreen() {
  const insets = useSafeAreaInsets();
  const { devices } = useMowerState();
  const [versions, setVersions] = useState<OtaVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggeringSn, setTriggeringSn] = useState<string | null>(null);
  const [triggerResult, setTriggerResult] = useState<Record<string, string>>({});

  const mower = useMemo(() => {
    return [...devices.values()].find((d) => d.deviceType === 'mower') ?? null;
  }, [devices]);

  const charger = useMemo(() => {
    return [...devices.values()].find((d) => d.deviceType === 'charger') ?? null;
  }, [devices]);

  const fetchVersions = useCallback(async () => {
    setLoading(true);
    try {
      const url = await getServerUrl();
      if (!url) return;
      const api = new ApiClient(url);
      const data = await api.getOtaVersions();
      setVersions(Array.isArray(data) ? data : []);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  const handleTrigger = (version: OtaVersion, sn: string, deviceLabel: string) => {
    const currentVersion = sn === mower?.sn
      ? mower?.sensors.sw_version ?? mower?.sensors.mower_version ?? '?'
      : charger?.sensors.charger_version ?? charger?.sensors.sw_version ?? '?';

    Alert.alert(
      'Firmware Update',
      `Update ${deviceLabel} from v${currentVersion} to ${version.version}?\n\nThis will restart the device.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Update',
          onPress: async () => {
            setTriggeringSn(sn);
            setTriggerResult((prev) => ({ ...prev, [sn]: 'sending' }));
            try {
              const url = await getServerUrl();
              if (!url) return;
              const api = new ApiClient(url);
              const res = await api.triggerOta(sn, version.id);
              setTriggerResult((prev) => ({
                ...prev,
                [sn]: res.ok ? 'Command sent' : 'Failed',
              }));
            } catch (e) {
              setTriggerResult((prev) => ({
                ...prev,
                [sn]: e instanceof Error ? e.message : 'Error',
              }));
            } finally {
              setTriggeringSn(null);
            }
          },
        },
      ],
    );
  };

  // Group versions by device type
  const mowerVersions = versions.filter((v) => v.device_type === 'mower');
  const chargerVersions = versions.filter((v) => v.device_type === 'charger');

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Firmware Updates</Text>

        {/* Current device versions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>CURRENT VERSIONS</Text>
          <View style={styles.card}>
            {mower && (
              <DeviceVersionRow
                icon="construct-outline"
                label="Mower"
                sn={mower.sn}
                version={mower.sensors.sw_version ?? mower.sensors.mower_version ?? 'Unknown'}
                online={mower.online}
              />
            )}
            {charger && (
              <DeviceVersionRow
                icon="flash-outline"
                label="Charger"
                sn={charger.sn}
                version={charger.sensors.charger_version ?? charger.sensors.sw_version ?? 'Unknown'}
                online={charger.online}
              />
            )}
            {!mower && !charger && (
              <Text style={styles.emptyText}>No devices connected</Text>
            )}
          </View>
        </View>

        {loading && (
          <ActivityIndicator size="small" color={colors.emerald} style={{ marginTop: 16 }} />
        )}

        {/* Available firmware versions */}
        {mowerVersions.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>MOWER FIRMWARE</Text>
            {mowerVersions.map((v) => (
              <VersionCard
                key={v.id}
                version={v}
                device={mower}
                deviceLabel="Mower"
                onTrigger={handleTrigger}
                triggering={triggeringSn === mower?.sn}
                result={mower ? triggerResult[mower.sn] : undefined}
              />
            ))}
          </View>
        )}

        {chargerVersions.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>CHARGER FIRMWARE</Text>
            {chargerVersions.map((v) => (
              <VersionCard
                key={v.id}
                version={v}
                device={charger}
                deviceLabel="Charger"
                onTrigger={handleTrigger}
                triggering={triggeringSn === charger?.sn}
                result={charger ? triggerResult[charger.sn] : undefined}
              />
            ))}
          </View>
        )}

        {!loading && versions.length === 0 && (
          <View style={styles.emptyCard}>
            <Ionicons name="cloud-download-outline" size={32} color={colors.textMuted} />
            <Text style={styles.emptyCardText}>No firmware versions registered</Text>
            <Text style={styles.emptyCardSubtext}>
              Upload firmware files to the server's firmware/ directory.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function DeviceVersionRow({
  icon,
  label,
  sn,
  version,
  online,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  sn: string;
  version: string;
  online: boolean;
}) {
  return (
    <View style={rowStyles.container}>
      <Ionicons name={icon} size={20} color={label === 'Mower' ? colors.emerald : colors.amber} />
      <View style={rowStyles.info}>
        <Text style={rowStyles.label}>{label}</Text>
        <Text style={rowStyles.sn}>{sn}</Text>
      </View>
      <Text style={rowStyles.version}>v{version}</Text>
      <View style={[rowStyles.dot, { backgroundColor: online ? colors.green : colors.red }]} />
    </View>
  );
}

function VersionCard({
  version,
  device,
  deviceLabel,
  onTrigger,
  triggering,
  result,
}: {
  version: OtaVersion;
  device: { sn: string; online: boolean; sensors: Record<string, string> } | null;
  deviceLabel: string;
  onTrigger: (v: OtaVersion, sn: string, label: string) => void;
  triggering: boolean;
  result?: string;
}) {
  return (
    <View style={versionStyles.card}>
      <View style={versionStyles.header}>
        <Text style={versionStyles.versionText}>{version.version}</Text>
        <Text style={versionStyles.date}>
          {new Date(version.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
        </Text>
      </View>

      {version.release_notes && (
        <Text style={versionStyles.notes}>{version.release_notes}</Text>
      )}

      {device && device.online && (
        <TouchableOpacity
          style={[versionStyles.triggerButton, triggering && { opacity: 0.5 }]}
          onPress={() => onTrigger(version, device.sn, deviceLabel)}
          disabled={triggering}
          activeOpacity={0.7}
        >
          {triggering ? (
            <ActivityIndicator size="small" color={colors.white} />
          ) : (
            <>
              <Ionicons name="cloud-download-outline" size={16} color={colors.white} />
              <Text style={versionStyles.triggerText}>
                Update {deviceLabel}
              </Text>
            </>
          )}
        </TouchableOpacity>
      )}

      {device && !device.online && (
        <Text style={versionStyles.offlineNote}>{deviceLabel} is offline</Text>
      )}

      {result && result !== 'sending' && (
        <Text style={[versionStyles.result, { color: result === 'Command sent' ? colors.green : colors.red }]}>
          {result}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 24, paddingBottom: 32 },
  title: { fontSize: 28, fontWeight: '700', color: colors.white, marginBottom: 24 },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 13, fontWeight: '600', color: colors.textDim,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginLeft: 4,
  },
  card: {
    backgroundColor: colors.card, borderRadius: 16,
    borderWidth: 1, borderColor: colors.cardBorder, overflow: 'hidden',
  },
  emptyText: { fontSize: 14, color: colors.textMuted, padding: 16, textAlign: 'center' },
  emptyCard: {
    alignItems: 'center', padding: 40,
    backgroundColor: colors.card, borderRadius: 16,
    borderWidth: 1, borderColor: colors.cardBorder,
  },
  emptyCardText: { fontSize: 16, fontWeight: '600', color: colors.textDim, marginTop: 12 },
  emptyCardSubtext: { fontSize: 13, color: colors.textMuted, marginTop: 4, textAlign: 'center' },
});

const rowStyles = StyleSheet.create({
  container: {
    flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  info: { flex: 1 },
  label: { fontSize: 15, fontWeight: '600', color: colors.white },
  sn: { fontSize: 11, color: colors.textDim, fontFamily: 'monospace', marginTop: 2 },
  version: { fontSize: 14, fontWeight: '600', color: colors.emerald, fontFamily: 'monospace' },
  dot: { width: 8, height: 8, borderRadius: 4 },
});

const versionStyles = StyleSheet.create({
  card: {
    backgroundColor: colors.card, borderRadius: 14,
    borderWidth: 1, borderColor: colors.cardBorder,
    padding: 16, marginBottom: 10,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  versionText: { fontSize: 18, fontWeight: '700', color: colors.white, fontFamily: 'monospace' },
  date: { fontSize: 12, color: colors.textMuted },
  notes: { fontSize: 13, color: colors.textDim, marginBottom: 12, lineHeight: 18 },
  triggerButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, height: 40, borderRadius: 10, backgroundColor: colors.blue,
  },
  triggerText: { fontSize: 14, fontWeight: '600', color: colors.white },
  offlineNote: { fontSize: 13, color: colors.textMuted, textAlign: 'center', marginTop: 4 },
  result: { fontSize: 13, fontWeight: '600', marginTop: 8, textAlign: 'center' },
});
