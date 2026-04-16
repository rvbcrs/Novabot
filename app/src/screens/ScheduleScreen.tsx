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
  RefreshControl,
  ActivityIndicator,
  Switch,
  Modal,
  TextInput,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Swipeable } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { useMowerState } from '../hooks/useMowerState';
import { ApiClient, type Schedule } from '../services/api';
import { getServerUrl } from '../services/auth';
import { useDemo } from '../context/DemoContext';
import { DemoBanner } from '../components/DemoBanner';
import { MowingDirectionPreview } from '../components/MowingDirectionPreview';
import { useI18n } from '../i18n';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HEIGHT_OPTIONS = [2, 3, 4, 5, 6, 7, 8, 9]; // cm (matches Novabot app slider)

export default function ScheduleScreen() {
  const insets = useSafeAreaInsets();
  const { devices } = useMowerState();
  const { t } = useI18n();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);

  const mowerSn = useMemo(() => {
    return [...devices.values()].find((d) => d.deviceType === 'mower')?.sn ?? '';
  }, [devices]);

  const demo = useDemo();

  const fetchSchedules = useCallback(async () => {
    if (!mowerSn) return;
    if (demo.enabled) {
      setSchedules(demo.demoSchedules);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const url = await getServerUrl();
      if (!url) return;
      const api = new ApiClient(url);
      const data = await api.getSchedules(mowerSn);
      const list = Array.isArray(data) ? data : (data as any)?.schedules ?? [];
      setSchedules(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load schedules');
    } finally {
      setLoading(false);
    }
  }, [mowerSn, demo.enabled]);

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

  const handleDelete = (schedule: Schedule, dayIdx?: number) => {
    const sid = schedule.id ?? (schedule as any).scheduleId;
    const weekdays: number[] = (schedule as any).weekdays ?? [];
    const time = (schedule as any).startTime ?? `${pad(schedule.start_hour ?? 0)}:${pad(schedule.start_minute ?? 0)}`;

    // Multi-day schedule: ask to remove just this day or all
    if (weekdays.length > 1 && dayIdx != null) {
      Alert.alert(
        t('delete'),
        `Delete ${time} schedule for ${DAYS_FULL[dayIdx]} only, or all days?`,
        [
          { text: t('cancel'), style: 'cancel' },
          {
            text: `${DAYS[dayIdx]} only`,
            onPress: async () => {
              try {
                const url = await getServerUrl();
                if (!url) return;
                const api = new ApiClient(url);
                const newDays = weekdays.filter(d => d !== dayIdx);
                await api.updateSchedule(mowerSn, sid, { weekdays: newDays });
                fetchSchedules();
              } catch { /* ignore */ }
            },
          },
          {
            text: 'All days',
            style: 'destructive',
            onPress: async () => {
              try {
                const url = await getServerUrl();
                if (!url) return;
                const api = new ApiClient(url);
                await api.deleteSchedule(mowerSn, sid);
                setSchedules((prev) => prev.filter((s) => (s.id ?? (s as any).scheduleId) !== sid));
              } catch { /* ignore */ }
            },
          },
        ],
      );
      return;
    }

    Alert.alert(
      t('delete'),
      `Delete ${time} schedule?`,
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              const url = await getServerUrl();
              if (!url) return;
              const api = new ApiClient(url);
              await api.deleteSchedule(mowerSn, sid);
              setSchedules((prev) => prev.filter((s) => (s.id ?? (s as any).scheduleId) !== sid));
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

  // Group schedules by day — a schedule with weekdays [1,3,5] appears under each day
  const byDay = useMemo(() => {
    const grouped: Record<number, Schedule[]> = {};
    for (const s of schedules) {
      const days: number[] = (s as any).weekdays ?? [s.day_of_week ?? 0];
      for (const d of days) {
        if (!grouped[d]) grouped[d] = [];
        grouped[d].push(s);
      }
    }
    // Sort each day's schedules by startTime
    for (const day of Object.keys(grouped)) {
      grouped[Number(day)].sort((a, b) => {
        const aTime = (a as any).startTime ?? `${pad(a.start_hour ?? 0)}:${pad(a.start_minute ?? 0)}`;
        const bTime = (b as any).startTime ?? `${pad(b.start_hour ?? 0)}:${pad(b.start_minute ?? 0)}`;
        return aTime.localeCompare(bTime);
      });
    }
    return grouped;
  }, [schedules]);

  if (!mowerSn) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.emptyState}>
          <Ionicons name="calendar-outline" size={48} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>{t('noMowerFound')}</Text>
          <Text style={styles.emptySubtitle}>{t('connectMower')}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={
        <RefreshControl refreshing={refreshing} tintColor={colors.purple} onRefresh={async () => {
          setRefreshing(true); await fetchSchedules(); setRefreshing(false);
        }} />
      }>


        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>{t('schedules')}</Text>
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
            <Text style={styles.emptyCardText}>{t('noSchedules')}</Text>
            <Text style={styles.emptyCardSubtext}>
              {t('tapToAdd')}
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
                <Swipeable
                  key={`${dayIdx}-${s.id ?? (s as any).scheduleId}`}
                  renderRightActions={() => (
                    <TouchableOpacity
                      style={styles.swipeDelete}
                      onPress={() => handleDelete(s, dayIdx)}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="trash" size={22} color={colors.white} />
                    </TouchableOpacity>
                  )}
                >
                <TouchableOpacity
                  style={[styles.scheduleCard, !s.enabled && styles.scheduleCardDisabled]}
                  onPress={() => handleEdit(s)}
                  activeOpacity={0.7}
                >
                  <View style={styles.scheduleLeft}>
                    <Text style={[styles.scheduleTime, !s.enabled && styles.textDisabled]}>
                      {(s as any).startTime ?? `${pad(s.start_hour ?? 0)}:${pad(s.start_minute ?? 0)}`}
                    </Text>
                    <View style={styles.scheduleChips}>
                      <Text style={styles.scheduleDuration}>{(() => {
                        if (s.duration_minutes) return `${s.duration_minutes} min`;
                        const st = (s as any).startTime as string | undefined;
                        const et = (s as any).endTime as string | undefined;
                        if (st && et) {
                          const [sh, sm] = st.split(':').map(Number);
                          const [eh, em] = et.split(':').map(Number);
                          return `${(eh * 60 + em) - (sh * 60 + sm)} min`;
                        }
                        return '';
                      })()}</Text>
                      {(s.cuttingHeight ?? s.cutting_height) != null && (
                        <Text style={styles.scheduleChip}>
                          {s.cuttingHeight ?? s.cutting_height} cm
                        </Text>
                      )}
                      {(s.pathDirection ?? s.path_direction) != null && (
                        <Text style={styles.scheduleChip}>
                          {s.pathDirection ?? s.path_direction}°
                        </Text>
                      )}
                      {(s.rainPause ?? s.rain_pause) && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                          <Ionicons name="rainy" size={12} color="#60a5fa" />
                        </View>
                      )}
                    </View>
                  </View>
                  <Switch
                    value={s.enabled}
                    onValueChange={() => handleToggle(s)}
                    trackColor={{ false: '#374151', true: 'rgba(0,212,170,0.3)' }}
                    thumbColor={s.enabled ? colors.emerald : '#6b7280'}
                  />
                </TouchableOpacity>
                </Swipeable>
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
  const { t } = useI18n();
  const isEdit = schedule != null;
  const initialDays = isEdit
    ? (schedule!.weekdays.length > 0 ? schedule!.weekdays : [schedule!.day_of_week])
    : [1, 2, 3, 4, 5];
  const initialStartTime = schedule?.startTime
    ?? `${pad(schedule?.start_hour ?? 9)}:${pad(schedule?.start_minute ?? 0)}`;
  const [initialHour = '09', initialMinute = '00'] = initialStartTime.split(':');
  const [selectedDays, setSelectedDays] = useState<number[]>(
    initialDays,
  );
  const toggleDay = (d: number) => {
    setSelectedDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);
  };
  const [hour, setHour] = useState(initialHour);
  const [minute, setMinute] = useState(initialMinute);
  const [duration, setDuration] = useState(String(schedule?.duration_minutes ?? 60));
  const [cuttingHeight, setCuttingHeight] = useState(schedule?.cuttingHeight ?? schedule?.cutting_height ?? 5);
  const [pathDir, setPathDir] = useState(schedule?.pathDirection ?? schedule?.path_direction ?? 120);
  const [rainPause, setRainPause] = useState(schedule?.rainPause ?? schedule?.rain_pause ?? true);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const url = await getServerUrl();
      if (!url) return;
      const api = new ApiClient(url);
      const startH = parseInt(hour, 10) || 0;
      const startM = parseInt(minute, 10) || 0;
      const durationMin = parseInt(duration, 10) || 60;
      const endH = Math.floor((startH * 60 + startM + durationMin) / 60) % 24;
      const endM = (startH * 60 + startM + durationMin) % 60;
      const base = {
        startTime: `${pad(startH)}:${pad(startM)}`,
        endTime: `${pad(endH)}:${pad(endM)}`,
        start_hour: startH,
        start_minute: startM,
        duration_minutes: durationMin,
        enabled: true,
        cuttingHeight: cuttingHeight,
        pathDirection: pathDir,
        rainPause: rainPause,
      };

      if (selectedDays.length === 0) {
        Alert.alert('Error', 'Select at least one day');
        return;
      }

      const sortedDays = [...selectedDays].sort((a, b) => a - b);

      if (isEdit) {
        await api.updateSchedule(mowerSn, schedule!.id, { ...base, weekdays: sortedDays });
      } else {
        await api.createSchedule(mowerSn, { ...base, weekdays: sortedDays });
      }
      onSaved();
    } catch (e) {
      console.error('[Schedule] Save failed:', e);
      Alert.alert('Error', e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible animationType="slide" transparent>
      <View style={editorStyles.overlay}>
        <View style={editorStyles.sheet}>
          <View style={editorStyles.header}>
            <Text style={editorStyles.title}>{isEdit ? t('editSchedule') : t('newSchedule')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={24} color={colors.textDim} />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>

          {/* Day selector (multi-select for new, single for edit) */}
          <Text style={editorStyles.label}>{isEdit ? t('day') : (t('days') || 'Days')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={editorStyles.dayRow}>
            {DAYS.map((d, i) => (
              <TouchableOpacity
                key={i}
                style={[editorStyles.dayChip, selectedDays.includes(i) && editorStyles.dayChipActive]}
                onPress={() => toggleDay(i)}
              >
                <Text style={[editorStyles.dayChipText, selectedDays.includes(i) && editorStyles.dayChipTextActive]}>
                  {d}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Time */}
          <Text style={editorStyles.label}>{t('startTime')}</Text>
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
          <Text style={editorStyles.label}>{t('duration')}</Text>
          <TextInput
            style={editorStyles.input}
            value={duration}
            onChangeText={setDuration}
            keyboardType="number-pad"
            placeholder="60"
            placeholderTextColor={colors.textMuted}
          />

          {/* Cutting Height */}
          <Text style={editorStyles.label}>{t('cuttingHeight')}</Text>
          <View style={editorStyles.stepperRow}>
            <TouchableOpacity style={editorStyles.stepperBtn} onPress={() => setCuttingHeight(Math.max(2, cuttingHeight - 1))}>
              <Ionicons name="remove" size={18} color={colors.white} />
            </TouchableOpacity>
            <Text style={editorStyles.stepperValue}>{cuttingHeight} cm</Text>
            <TouchableOpacity style={editorStyles.stepperBtn} onPress={() => setCuttingHeight(Math.min(9, cuttingHeight + 1))}>
              <Ionicons name="add" size={18} color={colors.white} />
            </TouchableOpacity>
          </View>

          {/* Mowing Direction */}
          <Text style={editorStyles.label}>{t('pathDirection')}</Text>
          <View style={{ alignItems: 'center', marginBottom: 8 }}>
            <MowingDirectionPreview direction={pathDir} size={90} />
          </View>
          <View style={editorStyles.stepperRow}>
            <TouchableOpacity style={editorStyles.stepperBtn} onPress={() => setPathDir((pathDir - 10 + 360) % 360)}>
              <Ionicons name="remove" size={18} color={colors.white} />
            </TouchableOpacity>
            <Text style={editorStyles.stepperValue}>{pathDir}°</Text>
            <TouchableOpacity style={editorStyles.stepperBtn} onPress={() => setPathDir((pathDir + 10) % 360)}>
              <Ionicons name="add" size={18} color={colors.white} />
            </TouchableOpacity>
          </View>

          {/* Rain pause toggle */}
          <View style={editorStyles.rainRow}>
            <View style={{ flex: 1 }}>
              <Text style={editorStyles.rainTitle}>{t('rainDetection')}</Text>
              <Text style={editorStyles.rainSub}>{t('rainDetectionSub')}</Text>
            </View>
            <Switch
              value={rainPause}
              onValueChange={setRainPause}
              trackColor={{ false: 'rgba(255,255,255,0.1)', true: 'rgba(96,165,250,0.4)' }}
              thumbColor={rainPause ? '#60a5fa' : '#666'}
            />
          </View>

          </ScrollView>

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
              <Text style={editorStyles.saveButtonText}>{isEdit ? t('save') : t('create')}</Text>
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
  swipeDelete: {
    backgroundColor: '#ef4444', justifyContent: 'center', alignItems: 'center',
    width: 70, borderRadius: 14, marginBottom: 8, marginLeft: 8,
  },
  scheduleCard: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.card, borderRadius: 14,
    borderWidth: 1, borderColor: colors.cardBorder,
    padding: 16, marginBottom: 8,
  },
  scheduleCardDisabled: { opacity: 0.5 },
  scheduleLeft: { gap: 4, flex: 1 },
  scheduleTime: { fontSize: 24, fontWeight: '700', color: colors.white, fontVariant: ['tabular-nums'] },
  scheduleChips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 2 },
  scheduleDuration: { fontSize: 13, color: colors.textDim },
  scheduleChip: { fontSize: 11, color: colors.textMuted, backgroundColor: 'rgba(255,255,255,0.06)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  textDisabled: { color: colors.textMuted },
});

const editorStyles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: colors.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, paddingBottom: 40, maxHeight: '90%',
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
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  chipActive: { backgroundColor: colors.emerald },
  chipText: { fontSize: 14, fontWeight: '600', color: colors.textDim },
  chipTextActive: { color: colors.white },
  dirChip: {
    width: 44, paddingVertical: 8, borderRadius: 10, alignItems: 'center' as const,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  dirChipActive: { backgroundColor: colors.purple },
  dirText: { fontSize: 14, fontWeight: '700', color: colors.textDim },
  dirTextActive: { color: colors.white },
  saveButton: {
    height: 48, borderRadius: 12, backgroundColor: colors.emerald,
    alignItems: 'center', justifyContent: 'center', marginTop: 24,
  },
  saveButtonText: { fontSize: 16, fontWeight: '600', color: colors.white },
  rainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 4,
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  stepperRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, marginBottom: 8,
  },
  stepperBtn: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center', justifyContent: 'center',
  },
  stepperValue: { fontSize: 18, fontWeight: '700', color: colors.white, minWidth: 60, textAlign: 'center' },
  rainTitle: { fontSize: 14, fontWeight: '600', color: colors.white },
  rainSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
});
