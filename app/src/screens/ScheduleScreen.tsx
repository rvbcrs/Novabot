/**
 * Schedule screen — view, create, edit, and delete mowing schedules.
 * Ported from dashboard SchedulesTab.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Switch,
  Modal,
  TextInput,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { useMowerState } from '../hooks/useMowerState';
import { ApiClient, type Schedule } from '../services/api';
import { getServerUrl } from '../services/auth';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function ScheduleScreen() {
  const insets = useSafeAreaInsets();
  const { devices } = useMowerState();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showEditor, setShowEditor] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);

  const mowerSn = useMemo(() => {
    return [...devices.values()].find((d) => d.deviceType === 'mower')?.sn ?? '';
  }, [devices]);

  const fetchSchedules = useCallback(async () => {
    if (!mowerSn) return;
    setLoading(true);
    setError('');
    try {
      const url = await getServerUrl();
      if (!url) return;
      const api = new ApiClient(url);
      const data = await api.getSchedules(mowerSn);
      setSchedules(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load schedules');
    } finally {
      setLoading(false);
    }
  }, [mowerSn]);

  useEffect(() => {
    fetchSchedules();
  }, [fetchSchedules]);

  const handleToggle = async (schedule: Schedule) => {
    try {
      const url = await getServerUrl();
      if (!url) return;
      const api = new ApiClient(url);
      await api.updateSchedule(mowerSn, schedule.id, { enabled: !schedule.enabled });
      setSchedules((prev) =>
        prev.map((s) => (s.id === schedule.id ? { ...s, enabled: !s.enabled } : s)),
      );
    } catch {
      // Silently fail, could add toast
    }
  };

  const handleDelete = (schedule: Schedule) => {
    Alert.alert(
      'Delete Schedule',
      `Delete ${DAYS_FULL[schedule.day_of_week]} ${pad(schedule.start_hour)}:${pad(schedule.start_minute)} schedule?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const url = await getServerUrl();
              if (!url) return;
              const api = new ApiClient(url);
              await api.deleteSchedule(mowerSn, schedule.id);
              setSchedules((prev) => prev.filter((s) => s.id !== schedule.id));
            } catch {
              // Silently fail
            }
          },
        },
      ],
    );
  };

  const handleAdd = () => {
    setEditingSchedule(null);
    setShowEditor(true);
  };

  const handleEdit = (schedule: Schedule) => {
    setEditingSchedule(schedule);
    setShowEditor(true);
  };

  // Group schedules by day
  const byDay = useMemo(() => {
    const grouped: Record<number, Schedule[]> = {};
    for (const s of schedules) {
      if (!grouped[s.day_of_week]) grouped[s.day_of_week] = [];
      grouped[s.day_of_week].push(s);
    }
    // Sort each day's schedules by time
    for (const day of Object.keys(grouped)) {
      grouped[Number(day)].sort(
        (a, b) => a.start_hour * 60 + a.start_minute - (b.start_hour * 60 + b.start_minute),
      );
    }
    return grouped;
  }, [schedules]);

  if (!mowerSn) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.emptyState}>
          <Ionicons name="calendar-outline" size={48} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>No Mower Connected</Text>
          <Text style={styles.emptySubtitle}>Connect a mower to manage schedules.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Schedules</Text>
          <TouchableOpacity style={styles.addButton} onPress={handleAdd} activeOpacity={0.7}>
            <Ionicons name="add" size={22} color={colors.white} />
          </TouchableOpacity>
        </View>

        {loading && (
          <ActivityIndicator size="small" color={colors.emerald} style={{ marginTop: 32 }} />
        )}

        {error !== '' && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={18} color={colors.red} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {!loading && schedules.length === 0 && (
          <View style={styles.emptyCard}>
            <Ionicons name="calendar-outline" size={32} color={colors.textMuted} />
            <Text style={styles.emptyCardText}>No schedules yet</Text>
            <Text style={styles.emptyCardSubtext}>
              Tap + to create a mowing schedule.
            </Text>
          </View>
        )}

        {/* Schedule list grouped by day */}
        {DAYS.map((dayName, dayIdx) => {
          const daySchedules = byDay[dayIdx];
          if (!daySchedules || daySchedules.length === 0) return null;
          return (
            <View key={dayIdx} style={styles.dayGroup}>
              <Text style={styles.dayLabel}>{DAYS_FULL[dayIdx]}</Text>
              {daySchedules.map((s) => (
                <TouchableOpacity
                  key={s.id}
                  style={[styles.scheduleCard, !s.enabled && styles.scheduleCardDisabled]}
                  onPress={() => handleEdit(s)}
                  onLongPress={() => handleDelete(s)}
                  activeOpacity={0.7}
                >
                  <View style={styles.scheduleLeft}>
                    <Text style={[styles.scheduleTime, !s.enabled && styles.textDisabled]}>
                      {pad(s.start_hour)}:{pad(s.start_minute)}
                    </Text>
                    <Text style={styles.scheduleDuration}>
                      {s.duration_minutes} min
                    </Text>
                  </View>
                  <Switch
                    value={s.enabled}
                    onValueChange={() => handleToggle(s)}
                    trackColor={{ false: '#374151', true: 'rgba(0,212,170,0.3)' }}
                    thumbColor={s.enabled ? colors.emerald : '#6b7280'}
                  />
                </TouchableOpacity>
              ))}
            </View>
          );
        })}
      </ScrollView>

      {/* Schedule Editor Modal */}
      {showEditor && (
        <ScheduleEditor
          mowerSn={mowerSn}
          schedule={editingSchedule}
          onClose={() => setShowEditor(false)}
          onSaved={() => {
            setShowEditor(false);
            fetchSchedules();
          }}
        />
      )}
    </View>
  );
}

// ── Schedule Editor ──────────────────────────────────────────────────

function ScheduleEditor({
  mowerSn,
  schedule,
  onClose,
  onSaved,
}: {
  mowerSn: string;
  schedule: Schedule | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = schedule != null;
  const [day, setDay] = useState(schedule?.day_of_week ?? 1);
  const [hour, setHour] = useState(String(schedule?.start_hour ?? 9));
  const [minute, setMinute] = useState(pad(schedule?.start_minute ?? 0));
  const [duration, setDuration] = useState(String(schedule?.duration_minutes ?? 60));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const url = await getServerUrl();
      if (!url) return;
      const api = new ApiClient(url);
      const payload = {
        day_of_week: day,
        start_hour: parseInt(hour, 10) || 0,
        start_minute: parseInt(minute, 10) || 0,
        duration_minutes: parseInt(duration, 10) || 60,
        enabled: true,
      };

      if (isEdit) {
        await api.updateSchedule(mowerSn, schedule!.id, payload);
      } else {
        await api.createSchedule(mowerSn, payload);
      }
      onSaved();
    } catch {
      // Silently fail
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible animationType="slide" transparent>
      <View style={editorStyles.overlay}>
        <View style={editorStyles.sheet}>
          <View style={editorStyles.header}>
            <Text style={editorStyles.title}>{isEdit ? 'Edit Schedule' : 'New Schedule'}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={24} color={colors.textDim} />
            </TouchableOpacity>
          </View>

          {/* Day selector */}
          <Text style={editorStyles.label}>DAY</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={editorStyles.dayRow}>
            {DAYS.map((d, i) => (
              <TouchableOpacity
                key={i}
                style={[editorStyles.dayChip, day === i && editorStyles.dayChipActive]}
                onPress={() => setDay(i)}
              >
                <Text style={[editorStyles.dayChipText, day === i && editorStyles.dayChipTextActive]}>
                  {d}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Time */}
          <Text style={editorStyles.label}>START TIME</Text>
          <View style={editorStyles.timeRow}>
            <TextInput
              style={editorStyles.timeInput}
              value={hour}
              onChangeText={setHour}
              keyboardType="number-pad"
              maxLength={2}
              placeholder="HH"
              placeholderTextColor={colors.textMuted}
            />
            <Text style={editorStyles.timeSeparator}>:</Text>
            <TextInput
              style={editorStyles.timeInput}
              value={minute}
              onChangeText={setMinute}
              keyboardType="number-pad"
              maxLength={2}
              placeholder="MM"
              placeholderTextColor={colors.textMuted}
            />
          </View>

          {/* Duration */}
          <Text style={editorStyles.label}>DURATION (MINUTES)</Text>
          <TextInput
            style={editorStyles.input}
            value={duration}
            onChangeText={setDuration}
            keyboardType="number-pad"
            placeholder="60"
            placeholderTextColor={colors.textMuted}
          />

          {/* Save button */}
          <TouchableOpacity
            style={[editorStyles.saveButton, saving && { opacity: 0.6 }]}
            onPress={handleSave}
            disabled={saving}
            activeOpacity={0.7}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.white} />
            ) : (
              <Text style={editorStyles.saveButtonText}>{isEdit ? 'Update' : 'Create'}</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 24, paddingBottom: 32 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  title: { fontSize: 28, fontWeight: '700', color: colors.white },
  addButton: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.emerald,
    alignItems: 'center', justifyContent: 'center',
  },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 12, padding: 12, marginBottom: 16,
  },
  errorText: { flex: 1, fontSize: 14, color: colors.red },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 22, fontWeight: '700', color: colors.white, marginTop: 16 },
  emptySubtitle: { fontSize: 15, color: colors.textDim, textAlign: 'center', marginTop: 8 },
  emptyCard: {
    alignItems: 'center', padding: 40,
    backgroundColor: colors.card, borderRadius: 16,
    borderWidth: 1, borderColor: colors.cardBorder,
  },
  emptyCardText: { fontSize: 16, fontWeight: '600', color: colors.textDim, marginTop: 12 },
  emptyCardSubtext: { fontSize: 13, color: colors.textMuted, marginTop: 4 },
  dayGroup: { marginBottom: 20 },
  dayLabel: { fontSize: 14, fontWeight: '600', color: colors.textDim, marginBottom: 8, marginLeft: 4 },
  scheduleCard: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.card, borderRadius: 14,
    borderWidth: 1, borderColor: colors.cardBorder,
    padding: 16, marginBottom: 8,
  },
  scheduleCardDisabled: { opacity: 0.5 },
  scheduleLeft: { gap: 4 },
  scheduleTime: { fontSize: 24, fontWeight: '700', color: colors.white, fontVariant: ['tabular-nums'] },
  scheduleDuration: { fontSize: 13, color: colors.textDim },
  textDisabled: { color: colors.textMuted },
});

const editorStyles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: colors.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, paddingBottom: 40,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
  title: { fontSize: 20, fontWeight: '700', color: colors.white },
  label: { fontSize: 13, fontWeight: '600', color: colors.textDim, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 16 },
  dayRow: { flexDirection: 'row', marginBottom: 8 },
  dayChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.06)', marginRight: 8,
  },
  dayChipActive: { backgroundColor: colors.emerald },
  dayChipText: { fontSize: 14, fontWeight: '600', color: colors.textDim },
  dayChipTextActive: { color: colors.white },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  timeInput: {
    width: 60, height: 48, backgroundColor: colors.inputBg,
    borderRadius: 12, borderWidth: 1, borderColor: colors.inputBorder,
    textAlign: 'center', fontSize: 20, fontWeight: '700', color: colors.white,
  },
  timeSeparator: { fontSize: 24, fontWeight: '700', color: colors.textDim },
  input: {
    height: 48, backgroundColor: colors.inputBg,
    borderRadius: 12, borderWidth: 1, borderColor: colors.inputBorder,
    paddingHorizontal: 16, fontSize: 16, color: colors.white,
  },
  saveButton: {
    height: 48, borderRadius: 12, backgroundColor: colors.emerald,
    alignItems: 'center', justifyContent: 'center', marginTop: 24,
  },
  saveButtonText: { fontSize: 16, fontWeight: '600', color: colors.white },
});
