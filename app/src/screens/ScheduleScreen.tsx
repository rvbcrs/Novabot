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
import { useDemo } from '../context/DemoContext';
import { DemoBanner } from '../components/DemoBanner';
import { MowingDirectionPreview } from '../components/MowingDirectionPreview';
import { useI18n } from '../i18n';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HEIGHT_OPTIONS = [20, 30, 40, 50, 60, 70, 80];
const DIRECTION_OPTIONS = [
  { angle: 0, label: 'N' }, { angle: 45, label: 'NE' }, { angle: 90, label: 'E' },
  { angle: 135, label: 'SE' }, { angle: 180, label: 'S' }, { angle: 225, label: 'SW' },
  { angle: 270, label: 'W' }, { angle: 315, label: 'NW' },
];

export default function ScheduleScreen() {
  const insets = useSafeAreaInsets();
  const { devices } = useMowerState();
  const { t } = useI18n();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
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
      setSchedules(Array.isArray(data) ? data : []);
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

  const handleDelete = (schedule: Schedule) => {
    Alert.alert(
      t('delete'),
      `Delete ${DAYS_FULL[schedule.day_of_week]} ${pad(schedule.start_hour)}:${pad(schedule.start_minute)} schedule?`,
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
          <Text style={styles.emptyTitle}>{t('noMowerFound')}</Text>
          <Text style={styles.emptySubtitle}>{t('connectMower')}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.scroll}>


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
                    <View style={styles.scheduleChips}>
                      <Text style={styles.scheduleDuration}>{s.duration_minutes} min</Text>
                      {(s.cuttingHeight ?? s.cutting_height) != null && (
                        <Text style={styles.scheduleChip}>
                          {((s.cuttingHeight ?? s.cutting_height ?? 40) / 10).toFixed(1)} cm
                        </Text>
                      )}
                      {(s.pathDirection ?? s.path_direction) != null && (
                        <Text style={styles.scheduleChip}>
                          {DIRECTION_OPTIONS.find((d) => d.angle === (s.pathDirection ?? s.path_direction))?.label ?? `${s.pathDirection ?? s.path_direction}°`}
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
  const [day, setDay] = useState(schedule?.day_of_week ?? 1);
  const [hour, setHour] = useState(String(schedule?.start_hour ?? 9));
  const [minute, setMinute] = useState(pad(schedule?.start_minute ?? 0));
  const [duration, setDuration] = useState(String(schedule?.duration_minutes ?? 60));
  const [cuttingHeight, setCuttingHeight] = useState(schedule?.cuttingHeight ?? schedule?.cutting_height ?? 40);
  const [pathDir, setPathDir] = useState(schedule?.pathDirection ?? schedule?.path_direction ?? 0);
  const [rainPause, setRainPause] = useState(schedule?.rainPause ?? schedule?.rain_pause ?? false);
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
        cuttingHeight: cuttingHeight,
        pathDirection: pathDir,
        rainPause: rainPause,
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
            <Text style={editorStyles.title}>{isEdit ? t('editSchedule') : t('newSchedule')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={24} color={colors.textDim} />
            </TouchableOpacity>
          </View>

          {/* Day selector */}
          <Text style={editorStyles.label}>{t('day')}</Text>
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
          <View style={editorStyles.chipRow}>
            {HEIGHT_OPTIONS.map((h) => (
              <TouchableOpacity
                key={h}
                style={[editorStyles.chip, cuttingHeight === h && editorStyles.chipActive]}
                onPress={() => setCuttingHeight(h)}
              >
                <Text style={[editorStyles.chipText, cuttingHeight === h && editorStyles.chipTextActive]}>
                  {(h / 10).toFixed(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Mowing Direction */}
          <Text style={editorStyles.label}>{t('pathDirection')}</Text>
          <View style={{ alignItems: 'center', marginBottom: 12 }}>
            <MowingDirectionPreview direction={pathDir} size={90} />
          </View>
          <View style={editorStyles.chipRow}>
            {DIRECTION_OPTIONS.map((d) => (
              <TouchableOpacity
                key={d.angle}
                style={[editorStyles.dirChip, pathDir === d.angle && editorStyles.dirChipActive]}
                onPress={() => setPathDir(d.angle)}
              >
                <Text style={[editorStyles.dirText, pathDir === d.angle && editorStyles.dirTextActive]}>
                  {d.label}
                </Text>
              </TouchableOpacity>
            ))}
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
  rainTitle: { fontSize: 14, fontWeight: '600', color: colors.white },
  rainSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
});
