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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { useMowerState } from '../hooks/useMowerState';
import { ApiClient, type WorkRecord } from '../services/api';
import { getServerUrl } from '../services/auth';
import { useDemo } from '../context/DemoContext';
import { DemoBanner } from '../components/DemoBanner';

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const { devices } = useMowerState();
  const [records, setRecords] = useState<WorkRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const mowerSn = useMemo(() => {
    return [...devices.values()].find((d) => d.deviceType === 'mower')?.sn ?? '';
  }, [devices]);

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

        <Text style={styles.title}>Mowing History</Text>

        {loading && (
          <ActivityIndicator size="small" color={colors.emerald} style={{ marginTop: 32 }} />
        )}

        {error !== '' && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={18} color={colors.red} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {!loading && records.length === 0 && (
          <View style={styles.emptyCard}>
            <Ionicons name="leaf-outline" size={32} color={colors.textMuted} />
            <Text style={styles.emptyCardText}>No mowing sessions yet</Text>
          </View>
        )}

        {records.map((r) => (
          <View key={r.id} style={styles.recordCard}>
            <View style={styles.recordHeader}>
              <View style={[styles.statusDot, { backgroundColor: statusColor(r.status) }]} />
              <Text style={styles.recordDate}>{formatDate(r.start_time)}</Text>
              <Text style={[styles.recordStatus, { color: statusColor(r.status) }]}>
                {r.status}
              </Text>
            </View>

            <View style={styles.recordStats}>
              <StatChip icon="time-outline" value={formatDuration(r.duration_seconds)} />
              <StatChip icon="resize-outline" value={`${r.area_m2.toFixed(0)} m²`} />
              {r.map_name && (
                <StatChip icon="map-outline" value={r.map_name} />
              )}
            </View>

            {r.end_time && (
              <Text style={styles.recordTimeRange}>
                {formatTime(r.start_time)} — {formatTime(r.end_time)}
              </Text>
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function StatChip({ icon, value }: { icon: React.ComponentProps<typeof Ionicons>['name']; value: string }) {
  return (
    <View style={chipStyles.container}>
      <Ionicons name={icon} size={14} color={colors.textDim} />
      <Text style={chipStyles.text}>{value}</Text>
    </View>
  );
}

function statusColor(status: string): string {
  switch (status.toLowerCase()) {
    case 'completed': return colors.green;
    case 'interrupted': return colors.amber;
    case 'error': return colors.red;
    default: return colors.textDim;
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}h ${rem}m`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 24, paddingBottom: 32 },
  title: { fontSize: 28, fontWeight: '700', color: colors.white, marginBottom: 20 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 22, fontWeight: '700', color: colors.white, marginTop: 16 },
  emptySubtitle: { fontSize: 15, color: colors.textDim, textAlign: 'center', marginTop: 8 },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 12, padding: 12, marginBottom: 16,
  },
  errorText: { flex: 1, fontSize: 14, color: colors.red },
  emptyCard: {
    alignItems: 'center', padding: 40,
    backgroundColor: colors.card, borderRadius: 16,
    borderWidth: 1, borderColor: colors.cardBorder,
  },
  emptyCardText: { fontSize: 16, fontWeight: '600', color: colors.textDim, marginTop: 12 },
  recordCard: {
    backgroundColor: colors.card, borderRadius: 16,
    borderWidth: 1, borderColor: colors.cardBorder,
    padding: 16, marginBottom: 12,
  },
  recordHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  recordDate: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.white },
  recordStatus: { fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  recordStats: { flexDirection: 'row', gap: 10, flexWrap: 'wrap', marginBottom: 8 },
  recordTimeRange: { fontSize: 12, color: colors.textMuted, fontVariant: ['tabular-nums'] },
});

const chipStyles = StyleSheet.create({
  container: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 4,
    backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 12,
  },
  text: { fontSize: 12, color: colors.textDim },
});
