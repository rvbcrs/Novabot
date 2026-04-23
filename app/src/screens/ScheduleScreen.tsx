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
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { colors } from '../theme/colors';
import { useActiveMower } from '../hooks/useActiveMower';
import { ApiClient, type MapData, type Schedule } from '../services/api';
import { getServerUrl } from '../services/auth';
import { useDemo } from '../context/DemoContext';
import { DemoBanner } from '../components/DemoBanner';
import { MowingDirectionPreview } from '../components/MowingDirectionPreview';
import { useI18n } from '../i18n';
import type { MainTabParams } from '../navigation/types';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HEIGHT_OPTIONS = [2, 3, 4, 5, 6, 7, 8, 9]; // cm (matches Novabot app slider)

export default function ScheduleScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const route = useRoute<RouteProp<MainTabParams, 'Schedules'>>();
  const { t } = useI18n();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [editorPrefill, setEditorPrefill] = useState<{ mapId: string | null; mapName: string | null } | null>(null);

  const { activeMowerSn } = useActiveMower();
  const mowerSn = activeMowerSn ?? '';

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

  // Refresh schedules every 30s while the screen is mounted so the
  // "currently running" / "paused by rain" badges stay current without the
  // user having to pull-to-refresh.
  useEffect(() => {
    if (!mowerSn || demo.enabled) return;
    const interval = setInterval(fetchSchedules, 30_000);
    return () => clearInterval(interval);
  }, [mowerSn, demo.enabled, fetchSchedules]);

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

  const handleAdd = (prefill?: { mapId: string | null; mapName: string | null } | null) => {
    setEditingSchedule(null);
    setEditorPrefill(prefill ?? null);
    setShowEditor(true);
  };

  const handleEdit = (schedule: Schedule) => {
    setEditingSchedule(schedule);
    setEditorPrefill(null);
    setShowEditor(true);
  };

  useEffect(() => {
    if (!route.params?.openEditor) return;
    handleAdd({
      mapId: route.params.preselectedMapId ?? null,
      mapName: route.params.preselectedMapName ?? null,
    });
    (navigation as any).setParams({
      openEditor: false,
      preselectedMapId: null,
      preselectedMapName: null,
    });
  }, [
    navigation,
    route.params?.openEditor,
    route.params?.preselectedMapId,
    route.params?.preselectedMapName,
  ]);

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
          <TouchableOpacity style={styles.addButton} onPress={() => handleAdd()} activeOpacity={0.7}>
            <Ionicons name="add" size={22} color={colors.white} />
          </TouchableOpacity>
        </View>

        {/* Global status banner — visible at the top of the list so the user
            doesn't have to scan every row. Three states: running / rain
            paused / nothing active. Hidden while loading the first time. */}
        {!loading && (() => {
          const running = schedules.find(x => x.currentlyRunning);
          const rainPaused = !running && schedules.find(x => x.rainPausedAt);
          if (running) {
            return (
              <View style={[styles.globalBanner, styles.globalBannerRunning]}>
                <View style={styles.statusDot} />
                <Text style={styles.globalBannerRunningText}>
                  {t('scheduleActiveBanner', {
                    name: running.scheduleName ?? running.mapName ?? running.startTime,
                  })}
                </Text>
              </View>
            );
          }
          if (rainPaused) {
            return (
              <View style={[styles.globalBanner, styles.globalBannerRain]}>
                <Ionicons name="rainy" size={14} color="#fbbf24" />
                <Text style={styles.globalBannerRainText}>
                  {t('scheduleRainBanner', undefined) || 'Mowing paused due to rain'}
                </Text>
              </View>
            );
          }
          return null;
        })()}

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
                  style={[
                    styles.scheduleCard,
                    !s.enabled && styles.scheduleCardDisabled,
                    s.currentlyRunning && styles.scheduleCardRunning,
                    !!s.rainPausedAt && styles.scheduleCardRainPaused,
                  ]}
                  onPress={() => handleEdit(s)}
                  activeOpacity={0.7}
                >
                  <View style={styles.scheduleLeft}>
                    <View style={styles.scheduleHeaderRow}>
                      <Text style={[styles.scheduleTime, !s.enabled && styles.textDisabled]}>
                        {(s as any).startTime ?? `${pad(s.start_hour ?? 0)}:${pad(s.start_minute ?? 0)}`}
                      </Text>
                      {s.currentlyRunning && (
                        <View style={styles.statusBadgeRunning}>
                          <View style={styles.statusDot} />
                          <Text style={styles.statusBadgeRunningText}>
                            {t('scheduleRunning', undefined) || 'Running now'}
                          </Text>
                        </View>
                      )}
                      {!s.currentlyRunning && s.rainPausedAt && (
                        <View style={styles.statusBadgeRain}>
                          <Ionicons name="rainy" size={11} color="#fbbf24" />
                          <Text style={styles.statusBadgeRainText}>
                            {t('schedulePausedRain', undefined) || 'Paused — rain'}
                          </Text>
                        </View>
                      )}
                    </View>
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
                      {(s.mapName ?? s.map_name) && (
                        <Text style={styles.scheduleChip}>
                          {s.mapName ?? s.map_name}
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
          initialMapId={editorPrefill?.mapId ?? null}
          initialMapName={editorPrefill?.mapName ?? null}
          onClose={() => {
            setShowEditor(false);
            setEditorPrefill(null);
          }}
          onSaved={() => {
            setShowEditor(false);
            setEditorPrefill(null);
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
  initialMapId,
  initialMapName,
  onClose,
  onSaved,
}: {
  mowerSn: string;
  schedule: Schedule | null;
  initialMapId?: string | null;
  initialMapName?: string | null;
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
  const [availableMaps, setAvailableMaps] = useState<MapData[]>([]);
  const [selectedMapId, setSelectedMapId] = useState<string | null>(
    schedule?.mapId ?? schedule?.map_id ?? initialMapId ?? null,
  );
  const [selectedMapName, setSelectedMapName] = useState<string | null>(
    schedule?.mapName ?? schedule?.map_name ?? initialMapName ?? null,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const url = await getServerUrl();
        if (!url) return;
        const api = new ApiClient(url);
        const res = await api.fetchMaps(mowerSn);
        if (!active) return;
        const workMaps = (res.maps ?? []).filter((map) => map.mapType === 'work' && map.mapArea?.length >= 3);
        setAvailableMaps(workMaps);
        if (selectedMapId) {
          const matched = workMaps.find((map) => map.mapId === selectedMapId);
          if (matched) setSelectedMapName(matched.mapName ?? matched.mapId);
        }
      } catch {
        if (active) setAvailableMaps([]);
      }
    })();
    return () => { active = false; };
  }, [mowerSn, selectedMapId]);

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
        mapId: selectedMapId,
        mapName: selectedMapName,
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
          <Text style={editorStyles.label}>{t('workArea')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={editorStyles.dayRow}>
            <TouchableOpacity
              style={[editorStyles.dayChip, selectedMapId == null && editorStyles.dayChipActive]}
              onPress={() => {
                setSelectedMapId(null);
                setSelectedMapName(null);
              }}
            >
              <Text style={[editorStyles.dayChipText, selectedMapId == null && editorStyles.dayChipTextActive]}>
                {t('allAreas')}
              </Text>
            </TouchableOpacity>
            {availableMaps.map((map) => (
              <TouchableOpacity
                key={map.mapId}
                style={[editorStyles.dayChip, selectedMapId === map.mapId && editorStyles.dayChipActive]}
                onPress={() => {
                  setSelectedMapId(map.mapId);
                  setSelectedMapName(map.mapName ?? map.mapId);
                }}
              >
                <Text style={[editorStyles.dayChipText, selectedMapId === map.mapId && editorStyles.dayChipTextActive]}>
                  {map.mapName || map.mapId}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

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
  globalBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12,
    marginBottom: 16, borderWidth: 1,
  },
  globalBannerRunning: {
    backgroundColor: 'rgba(0,212,170,0.12)',
    borderColor: 'rgba(0,212,170,0.4)',
  },
  globalBannerRunningText: {
    flex: 1, fontSize: 14, fontWeight: '600', color: colors.emerald,
  },
  globalBannerRain: {
    backgroundColor: 'rgba(120,53,15,0.25)',
    borderColor: 'rgba(251,191,36,0.35)',
  },
  globalBannerRainText: {
    flex: 1, fontSize: 14, fontWeight: '600', color: '#fde68a',
  },
  scheduleCardDisabled: { opacity: 0.5 },
  scheduleCardRunning: {
    borderColor: colors.emerald,
    backgroundColor: 'rgba(0,212,170,0.10)',
    shadowColor: colors.emerald,
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 12,
    shadowOpacity: 0.4,
  },
  scheduleCardRainPaused: {
    borderColor: 'rgba(251,191,36,0.45)',
    backgroundColor: 'rgba(120,53,15,0.18)',
  },
  scheduleLeft: { gap: 4, flex: 1 },
  scheduleHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  scheduleTime: { fontSize: 24, fontWeight: '700', color: colors.white, fontVariant: ['tabular-nums'] },
  scheduleChips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 2 },
  scheduleDuration: { fontSize: 13, color: colors.textDim },
  scheduleChip: { fontSize: 11, color: colors.textMuted, backgroundColor: 'rgba(255,255,255,0.06)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  statusBadgeRunning: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
    backgroundColor: 'rgba(0,212,170,0.18)',
    borderWidth: 1, borderColor: 'rgba(0,212,170,0.45)',
  },
  statusBadgeRunningText: {
    fontSize: 11, fontWeight: '700', color: colors.emerald, letterSpacing: 0.3,
  },
  statusDot: {
    width: 7, height: 7, borderRadius: 4, backgroundColor: colors.emerald,
  },
  statusBadgeRain: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
    backgroundColor: 'rgba(251,191,36,0.15)',
    borderWidth: 1, borderColor: 'rgba(251,191,36,0.35)',
  },
  statusBadgeRainText: {
    fontSize: 11, fontWeight: '600', color: '#fbbf24', letterSpacing: 0.3,
  },
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
