/**
 * OTA screen — view firmware versions, trigger updates.
 * Ported from dashboard OtaManager.
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  Image,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStyles, useTheme, type Colors } from '../theme';
import { useMowerState } from '../hooks/useMowerState';
import { useActiveMower } from '../hooks/useActiveMower';
import { ApiClient, type OtaVersion } from '../services/api';
import { getServerUrl } from '../services/auth';
import { getSocket } from '../services/socket';
import { formatDate } from '../lib/format';

interface OtaProgressEntry {
  status: string;       // 'upgrade' | 'success' | 'failed' | 'error' | ...
  percentage: number | null;
  timestamp: number;
  targetVersion?: string;
  deviceLabel?: string;
}

export default function OtaScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { devices } = useMowerState();
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [versions, setVersions] = useState<OtaVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggeringSn, setTriggeringSn] = useState<string | null>(null);
  const [triggerResult, setTriggerResult] = useState<Record<string, string>>({});
  // OTA progress, keyed by SN. Populated via 'ota:event' socket broadcasts
  // from the server (broker.ts forwards raw mower ota_upgrade_state into
  // this event). Modal opens when there's an active status <2 min old.
  const [otaProgress, setOtaProgress] = useState<Map<string, OtaProgressEntry>>(new Map());
  const targetVersionRef = useRef<Record<string, { version: string; label: string }>>({});

  const { activeMower: mower } = useActiveMower();

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

  // Subscribe to 'ota:event' socket broadcasts — server emits these whenever
  // the mower reports ota_upgrade_state / ota_upgrade_cmd_respond via MQTT.
  // Payload matches the dashboard: { sn, eventType:'state', data:{status, percentage|progress}, timestamp }
  // percentage can be 0-1 (fraction) or 0-100; we normalize to 0-100.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handler = (e: { sn: string; eventType: string; data: Record<string, unknown>; timestamp: number }) => {
      if (e.eventType !== 'state') return;
      const data = e.data ?? {};
      const rawPct = (data.percentage ?? data.progress ?? data.percent) as number | string | undefined;
      let pct: number | null = null;
      if (rawPct != null) {
        const n = Number(rawPct);
        if (isFinite(n)) pct = n <= 1 ? n * 100 : n;
      }
      setOtaProgress(prev => {
        const next = new Map(prev);
        const ref = targetVersionRef.current[e.sn];
        next.set(e.sn, {
          status: String(data.status ?? data.state ?? 'updating'),
          percentage: pct,
          timestamp: e.timestamp,
          targetVersion: ref?.version,
          deviceLabel: ref?.label,
        });
        return next;
      });
    };
    socket.on('ota:event', handler);
    return () => { socket.off('ota:event', handler); };
  }, []);

  // Determine which device (if any) has an active, recent OTA session to
  // render as a modal. "Active" = status not success/failed/error AND within
  // 2 minutes; "terminal" states stay visible 10s so the user sees "OK" /
  // "FAIL" before the modal auto-closes.
  const activeOta = useMemo(() => {
    const now = Date.now();
    for (const [sn, p] of otaProgress) {
      const age = now - p.timestamp;
      const terminal = p.status === 'success' || p.status === 'failed' || p.status === 'error';
      if (terminal && age < 10_000) return { sn, progress: p };
      if (!terminal && age < 120_000) return { sn, progress: p };
    }
    return null;
  }, [otaProgress]);

  const dismissOta = useCallback((sn: string) => {
    setOtaProgress(prev => {
      const next = new Map(prev);
      next.delete(sn);
      return next;
    });
  }, []);

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
            // Remember target version + device label so the progress modal
            // can show "Updating mower to v6.0.2-custom-24" instead of a
            // naked SN. Cleared when modal dismisses.
            targetVersionRef.current[sn] = { version: version.version, label: deviceLabel };
            // Seed an immediate "pending" entry so the modal opens right away
            // even before the mower's first ota_upgrade_state arrives — this
            // mirrors the dashboard's UX where clicking Update instantly shows
            // a progress bar at 0%.
            setOtaProgress(prev => {
              const next = new Map(prev);
              next.set(sn, {
                status: 'starting',
                percentage: null,
                timestamp: Date.now(),
                targetVersion: version.version,
                deviceLabel,
              });
              return next;
            });
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
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.backBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-back" size={24} color={colors.white} />
          </TouchableOpacity>
          <Text style={styles.title}>Firmware Updates</Text>
        </View>

        {/* Current device versions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>CURRENT VERSIONS</Text>
          <View style={styles.card}>
            {mower && (
              <DeviceVersionRow
                iconAsset={require('../../assets/lawn_mower.png')}
                label="Mower"
                sn={mower.sn}
                version={mower.sensors.sw_version ?? mower.sensors.mower_version ?? mower.firmwareVersion ?? null}
                online={mower.online}
              />
            )}
            {charger && (
              <DeviceVersionRow
                icon="flash-outline"
                label="Charger"
                sn={charger.sn}
                version={charger.sensors.charger_version ?? charger.sensors.sw_version ?? charger.firmwareVersion ?? null}
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

        {/* Available firmware versions. We berekenen de currentVersion hier
            (met dezelfde fallback chain als CURRENT VERSIONS bovenin, incl.
            device.firmwareVersion) en geven hem door aan VersionCard, zodat
            de "Installed" detectie consistent is. Zonder dit matcht mower wel
            (sw_version sensor is gezet) maar charger niet — die rapporteert
            zijn version soms pas na een tweede device:update via de DB
            firmwareVersion kolom. */}
        {(() => {
          const mowerCurrent = mower?.sensors.sw_version ?? mower?.sensors.mower_version ?? mower?.firmwareVersion ?? null;
          const chargerCurrent = charger?.sensors.charger_version ?? charger?.sensors.sw_version ?? charger?.firmwareVersion ?? null;
          return (
            <>
              {mowerVersions.length > 0 && (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>MOWER FIRMWARE</Text>
                  {mowerVersions.map((v) => (
                    <VersionCard
                      key={v.id}
                      version={v}
                      device={mower}
                      deviceLabel="Mower"
                      currentVersion={mowerCurrent}
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
                      currentVersion={chargerCurrent}
                      onTrigger={handleTrigger}
                      triggering={triggeringSn === charger?.sn}
                      result={charger ? triggerResult[charger.sn] : undefined}
                    />
                  ))}
                </View>
              )}
            </>
          );
        })()}

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

      {/* OTA progress modal — matcht dashboard's OtaManager visual. Opent
          zodra we een ota:event ontvangen (of meteen na een triggerOta call
          dankzij de optimistic "starting" entry). Auto-sluit 10s na success
          /failed. Tijdens een actieve upgrade niet dismissable behalve via
          Cancel — de maaier kan niet halverwege gestopt worden. */}
      <Modal
        visible={!!activeOta}
        transparent
        animationType="fade"
        onRequestClose={() => { /* block back-gesture during active upgrade */ }}
      >
        {activeOta && (() => {
          const p = activeOta.progress;
          const isDone = p.status === 'success';
          const isFail = p.status === 'failed' || p.status === 'error';
          const isActive = !isDone && !isFail;
          const title = isDone ? 'Update complete' : isFail ? 'Update failed' : 'Updating firmware';
          const subtitle = p.deviceLabel && p.targetVersion
            ? (isDone ? `${p.deviceLabel} → ${p.targetVersion}` : `${p.deviceLabel} → ${p.targetVersion}`)
            : activeOta.sn;
          const pctLabel = p.percentage != null ? `${p.percentage.toFixed(0)}%` : (isActive ? 'Preparing…' : '');
          const phaseLabel = (() => {
            if (isDone) return 'Device will reboot and come back online shortly.';
            if (isFail) return 'The device could not apply the update. You can retry in a few minutes.';
            if (p.percentage == null) return 'Waiting for the device to start the download…';
            if (p.percentage < 62) return 'Downloading firmware…';
            if (p.percentage < 68) return 'Unpacking…';
            return 'Installing + restarting…';
          })();
          const barColor = isDone ? colors.emerald : isFail ? colors.red : colors.amber;
          return (
            <View style={styles.otaModalBackdrop}>
              <View style={styles.otaModalCard}>
                <View style={styles.otaModalIconWrap}>
                  {isActive && <ActivityIndicator size="large" color={colors.amber} />}
                  {isDone && <Ionicons name="checkmark-circle" size={42} color={colors.emerald} />}
                  {isFail && <Ionicons name="close-circle" size={42} color={colors.red} />}
                </View>
                <Text style={styles.otaModalTitle}>{title}</Text>
                <Text style={styles.otaModalSubtitle}>{subtitle}</Text>

                <View style={styles.otaModalProgressRow}>
                  <Text style={[styles.otaModalPhase, { color: barColor }]}>{phaseLabel}</Text>
                  {pctLabel !== '' && (
                    <Text style={[styles.otaModalPct, { color: barColor }]}>{pctLabel}</Text>
                  )}
                </View>
                <View style={styles.otaModalBarTrack}>
                  <View
                    style={[
                      styles.otaModalBarFill,
                      {
                        width: `${Math.max(0, Math.min(100, p.percentage ?? (isActive ? 4 : 100)))}%` as any,
                        backgroundColor: barColor,
                      },
                    ]}
                  />
                </View>

                {isActive && (
                  <Text style={styles.otaModalHint}>
                    Don't close the app or turn off the device. This can take 15-30 minutes.
                  </Text>
                )}

                {(isDone || isFail) && (
                  <TouchableOpacity
                    style={[styles.otaModalBtn, { backgroundColor: isDone ? colors.emerald : colors.red }]}
                    onPress={() => dismissOta(activeOta.sn)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.otaModalBtnText}>{isDone ? 'Close' : 'Dismiss'}</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          );
        })()}
      </Modal>
    </View>
  );
}

function DeviceVersionRow({
  icon,
  iconAsset,
  label,
  sn,
  version,
  online,
}: {
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  iconAsset?: number;
  label: string;
  sn: string;
  version: string | null;
  online: boolean;
}) {
  const rowStyles = useStyles(makeRowStyles);
  const { colors } = useTheme();
  const tint = label === 'Mower' ? colors.emerald : colors.amber;
  // Firmware strings already start with "v" (e.g. "v6.0.2-custom-21").
  // Only prepend "v" when it's a bare semver to avoid "vv..." double prefix.
  const versionLabel = version
    ? (/^v/i.test(version) ? version : `v${version}`)
    : 'Unknown';
  return (
    <View style={rowStyles.container}>
      {iconAsset ? (
        <Image source={iconAsset} style={{ width: 22, height: 22, tintColor: tint }} resizeMode="contain" />
      ) : icon ? (
        <Ionicons name={icon} size={20} color={tint} />
      ) : null}
      <View style={rowStyles.info}>
        <Text style={rowStyles.label}>{label}</Text>
        <Text style={rowStyles.sn}>{sn}</Text>
      </View>
      <Text style={rowStyles.version}>{versionLabel}</Text>
      <View style={[rowStyles.dot, { backgroundColor: online ? colors.green : colors.red }]} />
    </View>
  );
}

function VersionCard({
  version,
  device,
  deviceLabel,
  currentVersion,
  onTrigger,
  triggering,
  result,
}: {
  version: OtaVersion;
  device: { sn: string; online: boolean; sensors: Record<string, string> } | null;
  deviceLabel: string;
  currentVersion: string | null;
  onTrigger: (v: OtaVersion, sn: string, label: string) => void;
  triggering: boolean;
  result?: string;
}) {
  const versionStyles = useStyles(makeVersionStyles);
  const { colors } = useTheme();
  // Compare requested firmware version with what is actually running on the
  // device. Accepts with/without leading "v" and trims whitespace — some
  // firmware reports "6.0.2-custom-24", the DB keeps the "v" prefix. When
  // they match we show an "Installed" badge instead of an Update button.
  const normalize = (s: string | null | undefined): string =>
    (s ?? '').trim().toLowerCase().replace(/^v/, '');
  const isInstalled = normalize(version.version) === normalize(currentVersion);

  return (
    <View style={versionStyles.card}>
      <View style={versionStyles.header}>
        <Text style={versionStyles.versionText}>{version.version}</Text>
        <Text style={versionStyles.date}>
          {formatDate(version.created_at)}
        </Text>
      </View>

      {version.release_notes && (
        <Text style={versionStyles.notes}>{version.release_notes}</Text>
      )}

      {isInstalled && (
        <View style={versionStyles.installedRow}>
          <Ionicons name="checkmark-circle" size={16} color={colors.emerald} />
          <Text style={versionStyles.installedText}>Installed on {deviceLabel}</Text>
        </View>
      )}

      {!isInstalled && device && device.online && (
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

      {!isInstalled && device && !device.online && (
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

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  scroll: { padding: 24, paddingBottom: 32 },
  title: { fontSize: 28, fontWeight: '700', color: c.white },
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
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 13, fontWeight: '600', color: c.textDim,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginLeft: 4,
  },
  card: {
    backgroundColor: c.card, borderRadius: 16,
    borderWidth: 1, borderColor: c.cardBorder, overflow: 'hidden',
  },
  emptyText: { fontSize: 14, color: c.textMuted, padding: 16, textAlign: 'center' },
  emptyCard: {
    alignItems: 'center', padding: 40,
    backgroundColor: c.card, borderRadius: 16,
    borderWidth: 1, borderColor: c.cardBorder,
  },
  emptyCardText: { fontSize: 16, fontWeight: '600', color: c.textDim, marginTop: 12 },
  emptyCardSubtext: { fontSize: 13, color: c.textMuted, marginTop: 4, textAlign: 'center' },
  // OTA progress modal
  otaModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  otaModalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: c.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.cardBorder,
    padding: 24,
    alignItems: 'center',
  },
  otaModalIconWrap: {
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  otaModalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: c.white,
    marginBottom: 4,
  },
  otaModalSubtitle: {
    fontSize: 13,
    color: c.textDim,
    marginBottom: 20,
    fontVariant: ['tabular-nums'],
  },
  otaModalProgressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    alignSelf: 'stretch',
    marginBottom: 6,
  },
  otaModalPhase: {
    fontSize: 13,
    fontWeight: '600',
  },
  otaModalPct: {
    fontSize: 14,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  otaModalBarTrack: {
    alignSelf: 'stretch',
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  otaModalBarFill: {
    height: '100%',
    borderRadius: 5,
  },
  otaModalHint: {
    marginTop: 14,
    fontSize: 12,
    color: c.textMuted,
    textAlign: 'center',
    lineHeight: 18,
  },
  otaModalBtn: {
    marginTop: 18,
    alignSelf: 'stretch',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  otaModalBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: c.white,
  },
});

const makeRowStyles = (c: Colors) => StyleSheet.create({
  container: {
    flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  info: { flex: 1 },
  label: { fontSize: 15, fontWeight: '600', color: c.white },
  sn: { fontSize: 11, color: c.textDim, fontFamily: 'monospace', marginTop: 2 },
  version: { fontSize: 14, fontWeight: '600', color: c.emerald, fontFamily: 'monospace' },
  dot: { width: 8, height: 8, borderRadius: 4 },
});

const makeVersionStyles = (c: Colors) => StyleSheet.create({
  card: {
    backgroundColor: c.card, borderRadius: 14,
    borderWidth: 1, borderColor: c.cardBorder,
    padding: 16, marginBottom: 10,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  versionText: { fontSize: 18, fontWeight: '700', color: c.white, fontFamily: 'monospace' },
  date: { fontSize: 12, color: c.textMuted },
  notes: { fontSize: 13, color: c.textDim, marginBottom: 12, lineHeight: 18 },
  triggerButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, height: 40, borderRadius: 10, backgroundColor: c.blue,
  },
  triggerText: { fontSize: 14, fontWeight: '600', color: c.white },
  offlineNote: { fontSize: 13, color: c.textMuted, textAlign: 'center', marginTop: 4 },
  installedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    backgroundColor: 'rgba(34,197,94,0.08)',
    borderRadius: 10,
  },
  installedText: {
    fontSize: 13,
    fontWeight: '600',
    color: c.emerald,
  },
  result: { fontSize: 13, fontWeight: '600', marginTop: 8, textAlign: 'center' },
});
