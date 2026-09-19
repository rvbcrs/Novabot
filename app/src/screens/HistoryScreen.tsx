/**
 * History screen — view past mowing sessions / work records.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStyles, useTheme, type Colors } from '../theme';
import { useI18n } from '../i18n';
import { useActiveMower } from '../hooks/useActiveMower';
import { ApiClient, type WorkRecord, type WorkSummary } from '../services/api';
import { getServerUrl } from '../services/auth';
import { useDemo } from '../context/DemoContext';
import { DemoBanner } from '../components/DemoBanner';
import { formatTime as fmtTime, formatDate as fmtDate } from '../lib/format';

export default function HistoryScreen() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [records, setRecords] = useState<WorkRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<WorkSummary | null>(null);

  const { activeMowerSn } = useActiveMower();
  const mowerSn = activeMowerSn ?? '';

  const demo = useDemo();

  const fetchRecords = useCallback(async (isRefresh = false) => {
    if (!mowerSn) return;
    if (demo.enabled) {
      setRecords(demo.demoHistory);
      setLoading(false);
      return;
    }
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const url = await getServerUrl();
      if (!url) return;
      const api = new ApiClient(url);
      const data = await api.getWorkRecords(mowerSn);
      setRecords(Array.isArray(data) ? data : []);
      api.getWorkSummary(mowerSn).then(setSummary).catch(() => setSummary(null));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load history');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [mowerSn, demo.enabled]);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  const setBlade = useCallback(async (body: { bladeReplaced?: boolean; bladeIntervalHours?: number }) => {
    if (!mowerSn) return;
    try {
      const url = await getServerUrl();
      if (!url) return;
      const blade = await new ApiClient(url).setBladeMaintenance(mowerSn, body);
      setSummary(prev => (prev ? { ...prev, blade } : prev));
    } catch { /* ignore */ }
  }, [mowerSn]);

  if (!mowerSn) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.emptyState}>
          <Ionicons name="time-outline" size={48} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>No Mower Connected</Text>
          <Text style={styles.emptySubtitle}>Connect a mower to view history.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => fetchRecords(true)}
            tintColor={colors.emerald}
          />
        }
      >

        {loading && (
          <ActivityIndicator size="small" color={colors.emerald} style={{ marginTop: 32 }} />
        )}

        {error !== '' && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={18} color={colors.red} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {summary && (
          <>
            {/* Totalen per periode (server-side som over ALLE records) */}
            <View style={styles.statsRow}>
              {([['week', t('wsWeek')], ['month', t('wsMonth')], ['year', t('wsYear')]] as const).map(([k, label]) => (
                <View key={k} style={styles.statTile}>
                  <Text style={styles.statLabel}>{label}</Text>
                  <Text style={styles.statValue}>{summary[k].runs}×</Text>
                  <Text style={styles.statSub}>{(summary[k].minutes / 60).toFixed(1)} h · {Math.round(summary[k].m2)} m²</Text>
                </View>
              ))}
            </View>
            {/* Mes-onderhoud: maai-uren sinds laatste wissel t.o.v. interval */}
            <View style={[styles.bladeCard, summary.blade.due && styles.bladeCardDue]}>
              <View style={styles.bladeHeader}>
                <Ionicons name="cut-outline" size={18} color={summary.blade.due ? colors.amber : colors.textDim} />
                <Text style={styles.bladeTitle}>{t('wsBlades')}</Text>
                <Text style={[styles.bladeHours, summary.blade.due && { color: colors.amber }]}>
                  {Math.round(summary.blade.hoursSince)} / {summary.blade.intervalHours} h
                </Text>
              </View>
              <View style={styles.bladeBar}>
                <View style={[styles.bladeBarFill, summary.blade.due && { backgroundColor: colors.amber },
                  { width: `${Math.min(100, (summary.blade.hoursSince / summary.blade.intervalHours) * 100)}%` }]} />
              </View>
              <Text style={styles.bladeSub}>
                {summary.blade.replacedAt
                  ? t('wsBladesSince', { date: fmtDate(summary.blade.replacedAt) })
                  : t('wsBladesNever')}
              </Text>
              <View style={styles.bladeActions}>
                {[30, 60, 90, 120].map(h => (
                  <TouchableOpacity key={h} style={[styles.chip, summary.blade.intervalHours === h && styles.chipActive]}
                    onPress={() => void setBlade({ bladeIntervalHours: h })}>
                    <Text style={[styles.chipText, summary.blade.intervalHours === h && styles.chipTextActive]}>{h} h</Text>
                  </TouchableOpacity>
                ))}
                <View style={{ flex: 1 }} />
                <TouchableOpacity style={styles.replacedBtn} onPress={() => void setBlade({ bladeReplaced: true })}>
                  <Text style={styles.replacedText}>{t('wsBladesReplaced')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}

        {!loading && records.length === 0 && (
          <View style={styles.emptyCard}>
            <Ionicons name="leaf-outline" size={32} color={colors.textMuted} />
            <Text style={styles.emptyCardText}>No mowing sessions yet</Text>
          </View>
        )}

        {records.map((r) => {
          // Mower POSTs dateTime as 'MM/DD HH:MM' (no year), server stores
          // workRecordDate as 'YYYY-MM-DD HH:MM:SS' wall-clock. Prefer the
          // server timestamp because Date() parses it deterministically; fall
          // back to mower-supplied dateTime for legacy rows.
          const tsRaw = r.workRecordDate ?? r.dateTime ?? '';
          const minutes = r.workTime ?? 0;
          const areaM2 = r.workArea ?? 0;
          const status = r.workStatus ?? '';
          // cutGrassHeight is the wire enum (cutterhigh 0-7) → display + 2 cm.
          // Guard legacy rows that stored mm (>= 20) by dividing instead.
          const wireH = r.cutGrassHeight;
          const heightCm = wireH == null || wireH <= 0
            ? null
            : (wireH >= 20 ? Math.round(wireH / 10) : wireH + 2);
          const dir = r.pathDirection;
          return (
            <View key={r.recordId} style={styles.recordCard}>
              <View style={styles.recordHeader}>
                <View style={[styles.statusDot, { backgroundColor: statusColor(status, colors) }]} />
                <Text style={styles.recordDate}>{formatDate(tsRaw)}</Text>
                <Text style={[styles.recordStatus, { color: statusColor(status, colors) }]}>
                  {statusLabel(t, status, areaM2)}
                </Text>
              </View>

              <View style={styles.recordStats}>
                <StatChip icon="time-outline" value={`${minutes} min`} />
                <StatChip icon="resize-outline" value={`${areaM2.toFixed(2)} m²`} />
                {heightCm != null && (
                  <StatChip icon="cut-outline" value={`${heightCm} cm`} />
                )}
                {dir != null && (
                  <StatChip icon="compass-outline" value={`${dir}°`} />
                )}
                {r.mapNames && (
                  <StatChip icon="map-outline" value={r.mapNames} />
                )}
              </View>

              <Text style={styles.recordTimeRange}>
                {formatTime(tsRaw)}
              </Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function StatChip({ icon, value }: { icon: React.ComponentProps<typeof Ionicons>['name']; value: string }) {
  const chipStyles = useStyles(makeChipStyles);
  const { colors } = useTheme();
  return (
    <View style={chipStyles.container}>
      <Ionicons name={icon} size={14} color={colors.textDim} />
      <Text style={chipStyles.text}>{value}</Text>
    </View>
  );
}

// Map the mower's raw work-record status into a human-readable, translated
// reason. The firmware only reports three outcomes: "finished",
// "interrupted artificially" (an intentional stop — user pressed stop, schedule
// end-time, or a rain go_to_charge) and "interrupted abnormally" (an error).
// We refine "abnormally" by progress: 0 m² means it failed at/just-after the
// start, any coverage means it aborted mid-mow. The rain-vs-manual distinction
// for "artificially" needs server data (the mower can't tell them apart), so it
// defaults to "stopped manually" here; the server can override via reason='rain'.
function statusLabel(t: (k: string) => string, status: string | null | undefined, areaM2: number): string {
  switch ((status ?? '').toLowerCase()) {
    case 'completed':
    case 'finished':
      return t('wrCompleted');
    case 'interrupted artificially':
      return t('wrStoppedManually');
    case 'interrupted abnormally':
      return areaM2 > 0 ? t('wrMidway') : t('wrError');
    case 'interrupted':
      return t('wrInterrupted');
    default:
      return status || '—';
  }
}

function statusColor(status: string | null | undefined, c: Colors): string {
  switch ((status ?? '').toLowerCase()) {
    case 'completed':
    case 'finished':
      return c.green;
    case 'interrupted abnormally':
    case 'error':
      return c.red;
    case 'interrupted':
    case 'interrupted artificially':
      return c.amber;
    default:
      return c.textDim;
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return fmtDate(d);
}

function formatTime(iso: string): string {
  return fmtTime(iso);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}h ${rem}m`;
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  scroll: { padding: 24, paddingBottom: 32 },
  title: { fontSize: 28, fontWeight: '700', color: c.text, marginBottom: 20 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 22, fontWeight: '700', color: c.text, marginTop: 16 },
  emptySubtitle: { fontSize: 15, color: c.textDim, textAlign: 'center', marginTop: 8 },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 12, padding: 12, marginBottom: 16,
  },
  errorText: { flex: 1, fontSize: 14, color: c.red },
  emptyCard: {
    alignItems: 'center', padding: 40,
    backgroundColor: c.card, borderRadius: 16,
    borderWidth: 1, borderColor: c.cardBorder,
  },
  emptyCardText: { fontSize: 16, fontWeight: '600', color: c.textDim, marginTop: 12 },
  recordCard: {
    backgroundColor: c.card, borderRadius: 16,
    borderWidth: 1, borderColor: c.cardBorder,
    padding: 16, marginBottom: 12,
  },
  recordHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  recordDate: { flex: 1, fontSize: 15, fontWeight: '600', color: c.text },
  recordStatus: { fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  recordStats: { flexDirection: 'row', gap: 10, flexWrap: 'wrap', marginBottom: 8 },
  recordTimeRange: { fontSize: 12, color: c.textMuted, fontVariant: ['tabular-nums'] },
  // Totalen + mes-onderhoud
  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  statTile: {
    flex: 1, backgroundColor: c.card, borderRadius: 16, borderWidth: 1, borderColor: c.cardBorder, padding: 12,
  },
  statLabel: { fontSize: 11, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  statValue: { fontSize: 20, fontWeight: '700', color: c.text, marginTop: 4 },
  statSub: { fontSize: 11, color: c.textDim, marginTop: 2 },
  bladeCard: {
    backgroundColor: c.card, borderRadius: 16, borderWidth: 1, borderColor: c.cardBorder, padding: 14, marginBottom: 16,
  },
  bladeCardDue: { borderColor: c.amber },
  bladeHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bladeTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: c.text },
  bladeHours: { fontSize: 13, fontWeight: '600', color: c.textDim, fontVariant: ['tabular-nums'] },
  bladeBar: { height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.08)', marginTop: 10, overflow: 'hidden' },
  bladeBarFill: { height: 6, borderRadius: 3, backgroundColor: c.emerald },
  bladeSub: { fontSize: 12, color: c.textMuted, marginTop: 8 },
  bladeActions: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  chip: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.05)' },
  chipActive: { backgroundColor: 'rgba(0,212,170,0.15)' },
  chipText: { fontSize: 12, color: c.textDim },
  chipTextActive: { color: c.emerald, fontWeight: '600' },
  replacedBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: 'rgba(0,212,170,0.15)' },
  replacedText: { fontSize: 12, fontWeight: '600', color: c.emerald },
});

const makeChipStyles = (c: Colors) => StyleSheet.create({
  container: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 4,
    backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 12,
  },
  text: { fontSize: 12, color: c.textDim },
});
