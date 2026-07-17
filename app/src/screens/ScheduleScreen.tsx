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
} from 'react-native';
import { appAlertCompat } from '../context/AppAlertContext';
import { Ionicons } from '@expo/vector-icons';
import { Swipeable } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { useStyles, useTheme, type Colors } from '../theme';
import { useActiveMower } from '../hooks/useActiveMower';
import { useMowerState } from '../hooks/useMowerState';
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
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
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
  // Issue #23: pre-fill new schedules with the mower's current
  // cuttingHeight + pathDirection from the live sensor cache so the
  // user doesn't get a hard-coded 5cm / 120° default that overrides
  // whatever they set in Mower Settings or Start Full Mow.
  const { devices } = useMowerState();
  const liveSensors = devices.get(mowerSn)?.sensors;
  const liveDefaultHeightRaw = parseInt(liveSensors?.defaultCuttingHeight ?? '', 10);
  const liveCuttingHeightCm = (() => {
    if (!Number.isFinite(liveDefaultHeightRaw) || liveDefaultHeightRaw <= 0) return undefined;
    if (liveDefaultHeightRaw >= 20 && liveDefaultHeightRaw <= 90) return Math.round(liveDefaultHeightRaw / 10);  // mm
    if (liveDefaultHeightRaw >= 0 && liveDefaultHeightRaw <= 7) return liveDefaultHeightRaw + 2;                   // wire (cm-2)
    if (liveDefaultHeightRaw >= 2 && liveDefaultHeightRaw <= 9) return liveDefaultHeightRaw;                       // user cm
    return undefined;
  })();
  const livePathDirRaw = parseInt(liveSensors?.path_direction ?? '', 10);
  const livePathDirection = Number.isFinite(livePathDirRaw) && livePathDirRaw >= 0 && livePathDirRaw <= 360
    ? livePathDirRaw
    : undefined;

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

  const dayKeyOf = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // Datum (YYYY-MM-DD) van de gegeven weekdag in DEZE week (ma t/m zo).
  // Het scherm is een week-overzicht: maandag blijft déze maandag, ook als
  // die al geweest is — er schuift niets stilletjes naar volgende week door.
  const thisWeekDateForWeekday = (weekday: number): string => {
    const now = new Date();
    const isoNow = now.getDay() === 0 ? 7 : now.getDay();
    const isoTarget = weekday === 0 ? 7 : weekday;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (isoTarget - isoNow));
    return dayKeyOf(d);
  };

  // Is de occurrence op deze datum al gepasseerd?
  const occurrencePassed = (dateKey: string, startTime: string): boolean => {
    const now = new Date();
    const todayKey = dayKeyOf(now);
    if (dateKey < todayKey) return true;
    if (dateKey > todayKey) return false;
    const [h = 0, m = 0] = startTime.split(':').map(Number);
    return now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m);
  };

  // Eerstvolgende occurrence-datum van het schema (over alle weekdagen) —
  // het anker waar nextPathDirection van de server bij hoort.
  const nextRunKey = (s: Schedule): string => {
    const weekdays: number[] = (s as any).weekdays ?? [];
    const [h = 0, m = 0] = ((s as any).startTime ?? '0:0').split(':').map(Number);
    const now = new Date();
    for (let i = 0; i < 8; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      if (i === 0 && (now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m))) continue;
      if (weekdays.length === 0 || weekdays.includes(d.getDay())) return dayKeyOf(d);
    }
    return '';
  };

  // Eerstvolgende occurrence-datum voor interval-schema's (elke N dagen
  // vanaf anchor).
  const nextDateForInterval = (schedule: Schedule): string => {
    const interval = schedule.intervalDays ?? 0;
    const anchor = schedule.intervalAnchorDate;
    if (!interval || !anchor) return '';
    const [ay = 0, am = 1, ad = 1] = anchor.split('-').map(Number);
    const anchorMs = new Date(ay, am - 1, ad).getTime();
    const now = new Date();
    const [h = 0, m = 0] = (schedule.startTime ?? '0:0').split(':').map(Number);
    for (let i = 0; i < interval + 1; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const daysSince = Math.round((d.getTime() - anchorMs) / 86_400_000);
      if (daysSince < 0 || daysSince % interval !== 0) continue;
      if (i === 0 && (now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m))) continue;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return '';
  };

  // Richting van de occurrence op targetDate, teken-bewust geprojecteerd
  // vanaf de eerstvolgende run (waar nextPathDirection van de server bij
  // hoort). Voor dagen eerder in de week rekent hij dus TERUG: wat draaide
  // die dag. Modulo 180: maairichting is een lijn-oriëntatie (240° == 60°).
  // ponytail: projectie neemt aan dat elke run echt startte — een regen- of
  // dag-skip roteert de teller niet door; display-only, geen stuurlogica.
  const directionForDate = (s: Schedule, targetDate: string): number | null => {
    const base = s.nextPathDirection ?? s.pathDirection ?? s.path_direction;
    if (base == null) return null;
    if (!s.alternateDirection || !targetDate) return base;
    const step = s.alternateStep ?? 90;
    const anchor = nextRunKey(s);
    if (!anchor || anchor === targetDate) return base;
    const weekdays: number[] = (s as any).weekdays ?? [];
    const [ay = 0, am = 1, ad = 1] = anchor.split('-').map(Number);
    const dir = targetDate > anchor ? 1 : -1;
    let k = 0;
    const d = new Date(ay, am - 1, ad);
    for (let guard = 0; guard < 15; guard++) {
      d.setDate(d.getDate() + dir);
      if (weekdays.length === 0 || weekdays.includes(d.getDay())) k += dir;
      if (dayKeyOf(d) === targetDate) break;
    }
    return ((base + k * step) % 180 + 180) % 180;
  };

  // "Sla deze dag over" — datum-gericht: alleen de gedrukte dag wordt
  // geskipt. Nogmaals tikken op de gemarkeerde dag annuleert de skip.
  const handleSkipDate = async (schedule: Schedule, date: string) => {
    if (!date) return;
    const next = schedule.skipDate === date ? null : date;
    try {
      const url = await getServerUrl();
      if (!url) return;
      const api = new ApiClient(url);
      await api.updateSchedule(mowerSn, schedule.id, { skipDate: next });
      setSchedules((prev) =>
        prev.map((s) => (s.id === schedule.id ? { ...s, skipDate: next } : s)),
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
      appAlertCompat.alert(
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

    appAlertCompat.alert(
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

  // Group schedules by day — a schedule with weekdays [1,3,5] appears under
  // each day. Interval-mode schedules (intervalDays > 0) carry an empty
  // weekdays array and instead get their own section below, so we skip
  // them here.
  const byDay = useMemo(() => {
    const grouped: Record<number, Schedule[]> = {};
    for (const s of schedules) {
      if ((s.intervalDays ?? 0) > 0) continue;
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

  // Interval schedules — sorted by intervalDays then startTime.
  const intervalSchedules = useMemo(() => {
    return schedules
      .filter((s) => (s.intervalDays ?? 0) > 0)
      .sort((a, b) => {
        const dA = a.intervalDays ?? 0;
        const dB = b.intervalDays ?? 0;
        if (dA !== dB) return dA - dB;
        const aTime = (a as any).startTime ?? '00:00';
        const bTime = (b as any).startTime ?? '00:00';
        return aTime.localeCompare(bTime);
      });
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
          <TouchableOpacity testID="schedule-add" style={styles.addButton} onPress={() => handleAdd()} activeOpacity={0.7}>
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

        {/* Schedule list grouped by day. Maandag eerst (EU-weekconventie;
            JS getDay() 0=zondag blijft intern ongewijzigd). */}
        {[1, 2, 3, 4, 5, 6, 0].map((dayIdx) => {
          const daySchedules = byDay[dayIdx];
          if (!daySchedules || daySchedules.length === 0) return null;
          return (
            <View key={dayIdx} style={styles.dayGroup}>
              <Text style={styles.dayLabel}>{DAYS_FULL[dayIdx]}</Text>
              {daySchedules.map((s) => {
                // Week-overzicht: de kaart hoort bij de kalenderdag van DEZE
                // week; een gepasseerde dag dimt en toont wat er toen draaide.
                const cardDate = thisWeekDateForWeekday(dayIdx);
                const cardPassed = occurrencePassed(cardDate, (s as any).startTime ?? '0:0');
                return (
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
                    cardPassed && !s.currentlyRunning && { opacity: 0.45 },
                  ]}
                  onPress={() => handleEdit(s)}
                  activeOpacity={0.7}
                >
                  <View style={styles.scheduleLeft}>
                    <View style={styles.scheduleHeaderRow}>
                      <Text style={[styles.scheduleTime, !s.enabled && styles.textDisabled]}>
                        {(s as any).startTime ?? `${pad(s.start_hour ?? 0)}:${pad(s.start_minute ?? 0)}`}
                      </Text>
                      <Text style={styles.scheduleDateHint}>
                        {(() => {
                          const [y = 0, m = 1, d = 1] = cardDate.split('-').map(Number);
                          return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
                        })()}
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
                      {!s.currentlyRunning && !s.rainPausedAt && s.skipDate === cardDate && (
                        <View style={styles.statusBadgeRain}>
                          <Ionicons name="pause-circle" size={11} color="#fbbf24" />
                          <Text style={styles.statusBadgeRainText}>
                            {t('scheduleSkipNextBadge', undefined) || 'Skipped'}
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
                      {(() => {
                        const deg = directionForDate(s, cardDate);
                        if (deg == null) return null;
                        return (
                          <Text style={styles.scheduleChip}>
                            {deg}°{s.alternateDirection ? ' ↻' : ''}
                          </Text>
                        );
                      })()}
                      <Text style={styles.scheduleChip}>
                        {(s.mapName ?? s.map_name) || t('allAreas')}
                      </Text>
                      {(s.rainPause ?? s.rain_pause) && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                          <Ionicons name="rainy" size={12} color="#60a5fa" />
                        </View>
                      )}
                    </View>
                  </View>
                  {s.enabled && !cardPassed && (
                    <TouchableOpacity
                      onPress={() => handleSkipDate(s, cardDate)}
                      style={{ padding: 6, marginRight: 2 }}
                      activeOpacity={0.7}
                      accessibilityLabel={t('scheduleSkipNext', undefined) || 'Skip this day'}
                    >
                      <Ionicons
                        name={s.skipDate === cardDate ? 'pause-circle' : 'pause-circle-outline'}
                        size={22}
                        color={s.skipDate === cardDate ? '#fbbf24' : '#6b7280'}
                      />
                    </TouchableOpacity>
                  )}
                  <Switch
                    value={s.enabled}
                    onValueChange={() => handleToggle(s)}
                    trackColor={{ false: '#374151', true: 'rgba(0,212,170,0.3)' }}
                    thumbColor={s.enabled ? colors.emerald : '#6b7280'}
                  />
                </TouchableOpacity>
                </Swipeable>
                );
              })}
            </View>
          );
        })}

        {/* Interval-mode schedules — issue #51. These don't fit under any
            weekday header so they get their own group beneath the weekday
            list. Header reads "Every N days from <anchor>" for each row. */}
        {intervalSchedules.length > 0 && (
          <View style={styles.dayGroup}>
            <Text style={styles.dayLabel}>
              {t('intervalSchedules', undefined) || 'Every N days'}
            </Text>
            {intervalSchedules.map((s) => (
              <Swipeable
                key={`interval-${s.id ?? (s as any).scheduleId}`}
                renderRightActions={() => (
                  <TouchableOpacity
                    style={styles.swipeDelete}
                    onPress={() => handleDelete(s)}
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
                      <Text style={styles.scheduleDateHint}>
                        {(() => {
                          const cd = nextDateForInterval(s);
                          if (!cd) return '';
                          const [y = 0, m = 1, d = 1] = cd.split('-').map(Number);
                          return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
                        })()}
                      </Text>
                      {s.currentlyRunning && (
                        <View style={styles.statusBadgeRunning}>
                          <View style={styles.statusDot} />
                          <Text style={styles.statusBadgeRunningText}>
                            {t('scheduleRunning', undefined) || 'Running now'}
                          </Text>
                        </View>
                      )}
                      {!s.currentlyRunning && !!s.skipDate && (
                        <View style={styles.statusBadgeRain}>
                          <Ionicons name="pause-circle" size={11} color="#fbbf24" />
                          <Text style={styles.statusBadgeRainText}>
                            {(t('scheduleSkipNextBadge', undefined) || 'Skipped')} {s.skipDate}
                          </Text>
                        </View>
                      )}
                    </View>
                    <View style={styles.scheduleChips}>
                      <Text style={styles.scheduleChip}>
                        Every {s.intervalDays} day{s.intervalDays === 1 ? '' : 's'}
                      </Text>
                      {s.intervalAnchorDate && (
                        <Text style={styles.scheduleChip}>from {s.intervalAnchorDate}</Text>
                      )}
                      {(s.cuttingHeight ?? s.cutting_height) != null && (
                        <Text style={styles.scheduleChip}>
                          {s.cuttingHeight ?? s.cutting_height} cm
                        </Text>
                      )}
                      <Text style={styles.scheduleChip}>
                        {(s.mapName ?? s.map_name) || t('allAreas')}
                      </Text>
                      {(s.rainPause ?? s.rain_pause) && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                          <Ionicons name="rainy" size={12} color="#60a5fa" />
                        </View>
                      )}
                    </View>
                  </View>
                  {s.enabled && (() => {
                    const cardDate = nextDateForInterval(s);
                    const active = !!s.skipDate && s.skipDate === cardDate;
                    return (
                      <TouchableOpacity
                        onPress={() => handleSkipDate(s, cardDate)}
                        style={{ padding: 6, marginRight: 2 }}
                        activeOpacity={0.7}
                        accessibilityLabel={t('scheduleSkipNext', undefined) || 'Skip this day'}
                      >
                        <Ionicons
                          name={active ? 'pause-circle' : 'pause-circle-outline'}
                          size={22}
                          color={active ? '#fbbf24' : '#6b7280'}
                        />
                      </TouchableOpacity>
                    );
                  })()}
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
        )}
      </ScrollView>

      {/* Schedule Editor Modal */}
      {showEditor && (
        <ScheduleEditor
          mowerSn={mowerSn}
          schedule={editingSchedule}
          initialMapId={editorPrefill?.mapId ?? null}
          initialMapName={editorPrefill?.mapName ?? null}
          defaultCuttingHeight={liveCuttingHeightCm}
          defaultPathDirection={livePathDirection}
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
  defaultCuttingHeight,
  defaultPathDirection,
  onClose,
  onSaved,
}: {
  mowerSn: string;
  schedule: Schedule | null;
  initialMapId?: string | null;
  initialMapName?: string | null;
  /** Live mower-settings defaults (sensor cache) for NEW schedules only.
   *  Edit-mode keeps the saved schedule's own values. Issue #23. */
  defaultCuttingHeight?: number;
  defaultPathDirection?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const editorStyles = useStyles(makeEditorStyles);
  const { colors } = useTheme();
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

  // Issue #51: "every N days" alternative to weekday-of-week scheduling.
  // mode='interval' makes the server-side runner fire on dates spaced by
  // intervalDays starting from intervalAnchorDate (YYYY-MM-DD). Weekday
  // mode stays the default for backwards compatibility.
  const initialIntervalDays = isEdit ? (schedule!.intervalDays ?? 0) : 0;
  const [mode, setMode] = useState<'weekly' | 'interval'>(initialIntervalDays > 0 ? 'interval' : 'weekly');
  const [intervalDays, setIntervalDays] = useState<string>(
    String(initialIntervalDays > 0 ? initialIntervalDays : 2),
  );
  const todayLocalIso = (() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  })();
  const [intervalAnchorDate, setIntervalAnchorDate] = useState<string>(
    isEdit ? (schedule!.intervalAnchorDate ?? todayLocalIso) : todayLocalIso,
  );
  const [hour, setHour] = useState(initialHour);
  const [minute, setMinute] = useState(initialMinute);
  const [duration, setDuration] = useState(String(schedule?.duration_minutes ?? 60));
  const [cuttingHeight, setCuttingHeight] = useState(
    schedule?.cuttingHeight ?? schedule?.cutting_height ?? defaultCuttingHeight ?? 5,
  );
  const [pathDir, setPathDir] = useState(
    schedule?.pathDirection ?? schedule?.path_direction ?? defaultPathDirection ?? 120,
  );
  const [rainPause, setRainPause] = useState(schedule?.rainPause ?? schedule?.rain_pause ?? true);
  // #51 follow-up: rotate path_direction by step° each fire.
  const [alternateDirection, setAlternateDirection] = useState(schedule?.alternateDirection ?? false);
  const [alternateStep, setAlternateStep] = useState<number>(schedule?.alternateStep ?? 90);
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
        alternateDirection,
        alternateStep,
      };

      // Decide between weekday mode and interval mode. In interval mode
      // intervalDays must be ≥ 1 and the anchor date must be a valid
      // YYYY-MM-DD; we send empty weekdays so the server uses the
      // interval rule. Weekday mode requires at least one selected day.
      let extra: Record<string, unknown> = {};
      if (mode === 'interval') {
        const n = parseInt(intervalDays, 10);
        if (!Number.isFinite(n) || n < 1) {
          appAlertCompat.alert('Error', 'Interval must be at least 1 day');
          return;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(intervalAnchorDate)) {
          appAlertCompat.alert('Error', 'Start date must look like YYYY-MM-DD');
          return;
        }
        extra = {
          weekdays: [],
          intervalDays: n,
          intervalAnchorDate,
        };
      } else {
        if (selectedDays.length === 0) {
          appAlertCompat.alert('Error', 'Select at least one day');
          return;
        }
        const sortedDays = [...selectedDays].sort((a, b) => a - b);
        extra = { weekdays: sortedDays, intervalDays: 0, intervalAnchorDate: null };
      }

      if (isEdit) {
        await api.updateSchedule(mowerSn, schedule!.id, { ...base, ...extra });
      } else {
        await api.createSchedule(mowerSn, { ...base, ...extra });
      }
      onSaved();
    } catch (e) {
      console.error('[Schedule] Save failed:', e);
      appAlertCompat.alert('Error', e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible animationType="slide" transparent>
      <View style={editorStyles.overlay}>
        <View style={editorStyles.sheet}>
          <View style={editorStyles.header}>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={editorStyles.backBtn}>
              <Ionicons name="arrow-back" size={24} color={colors.text} />
            </TouchableOpacity>
            <Text style={editorStyles.title}>{isEdit ? t('editSchedule') : t('newSchedule')}</Text>
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

          <Text style={editorStyles.label}>Repeat</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
            <TouchableOpacity
              style={[editorStyles.dayChip, mode === 'weekly' && editorStyles.dayChipActive, { flex: 1, alignItems: 'center' }]}
              onPress={() => setMode('weekly')}
            >
              <Text style={[editorStyles.dayChipText, mode === 'weekly' && editorStyles.dayChipTextActive]}>
                Weekdays
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[editorStyles.dayChip, mode === 'interval' && editorStyles.dayChipActive, { flex: 1, alignItems: 'center' }]}
              onPress={() => setMode('interval')}
            >
              <Text style={[editorStyles.dayChipText, mode === 'interval' && editorStyles.dayChipTextActive]}>
                Every N days
              </Text>
            </TouchableOpacity>
          </View>

          {mode === 'weekly' ? (
            <>
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
            </>
          ) : (
            <>
              <Text style={editorStyles.label}>Every</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <TextInput
                  style={[editorStyles.input, { flex: 1 }]}
                  value={intervalDays}
                  onChangeText={(v) => setIntervalDays(v.replace(/[^0-9]/g, ''))}
                  keyboardType="number-pad"
                  placeholder="2"
                  placeholderTextColor={colors.textMuted}
                />
                <Text style={{ color: colors.text, fontSize: 14 }}>days</Text>
              </View>
              <Text style={editorStyles.label}>Starting from</Text>
              <TextInput
                style={editorStyles.input}
                value={intervalAnchorDate}
                onChangeText={setIntervalAnchorDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </>
          )}

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
            {/* 15° step + 0–180 range matches StartMowSheet (issue #23). */}
            <TouchableOpacity style={editorStyles.stepperBtn} onPress={() => setPathDir(Math.max(0, pathDir - 15))}>
              <Ionicons name="remove" size={18} color={colors.white} />
            </TouchableOpacity>
            <Text style={editorStyles.stepperValue}>{pathDir}°</Text>
            <TouchableOpacity style={editorStyles.stepperBtn} onPress={() => setPathDir(Math.min(180, pathDir + 15))}>
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

          {/* #51 follow-up: rotate path_direction by alternateStep° each
              time the schedule fires. Server-side runner counts triggers
              + adds (count × step) mod 360 to the base path_direction. */}
          <View style={editorStyles.rainRow}>
            <View style={{ flex: 1 }}>
              <Text style={editorStyles.rainTitle}>Rotate direction each run</Text>
              <Text style={editorStyles.rainSub}>
                Adds {alternateStep}° to the path direction every time this schedule fires
              </Text>
            </View>
            <Switch
              value={alternateDirection}
              onValueChange={setAlternateDirection}
              trackColor={{ false: 'rgba(255,255,255,0.1)', true: 'rgba(167,139,250,0.4)' }}
              thumbColor={alternateDirection ? colors.purple : '#666'}
            />
          </View>
          {alternateDirection && (
            <View style={editorStyles.stepperRow}>
              <Text style={[editorStyles.label, { flex: 1, marginBottom: 0 }]}>Rotation step</Text>
              <TouchableOpacity style={editorStyles.stepperBtn} onPress={() => setAlternateStep(Math.max(15, alternateStep - 15))}>
                <Ionicons name="remove" size={18} color={colors.white} />
              </TouchableOpacity>
              <Text style={editorStyles.stepperValue}>{alternateStep}°</Text>
              <TouchableOpacity style={editorStyles.stepperBtn} onPress={() => setAlternateStep(Math.min(180, alternateStep + 15))}>
                <Ionicons name="add" size={18} color={colors.white} />
              </TouchableOpacity>
            </View>
          )}

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

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  scroll: { padding: 24, paddingBottom: 32 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  title: { fontSize: 28, fontWeight: '700', color: c.text },
  addButton: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: c.emerald,
    alignItems: 'center', justifyContent: 'center',
  },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 12, padding: 12, marginBottom: 16,
  },
  errorText: { flex: 1, fontSize: 14, color: c.red },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 22, fontWeight: '700', color: c.text, marginTop: 16 },
  emptySubtitle: { fontSize: 15, color: c.textDim, textAlign: 'center', marginTop: 8 },
  emptyCard: {
    alignItems: 'center', padding: 40,
    backgroundColor: c.card, borderRadius: 16,
    borderWidth: 1, borderColor: c.cardBorder,
  },
  emptyCardText: { fontSize: 16, fontWeight: '600', color: c.textDim, marginTop: 12 },
  emptyCardSubtext: { fontSize: 13, color: c.textMuted, marginTop: 4 },
  dayGroup: { marginBottom: 20 },
  dayLabel: { fontSize: 14, fontWeight: '600', color: c.textDim, marginBottom: 8, marginLeft: 4 },
  swipeDelete: {
    backgroundColor: '#ef4444', justifyContent: 'center', alignItems: 'center',
    width: 70, borderRadius: 14, marginBottom: 8, marginLeft: 8,
  },
  scheduleCard: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: c.card, borderRadius: 14,
    borderWidth: 1, borderColor: c.cardBorder,
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
    flex: 1, fontSize: 14, fontWeight: '600', color: c.emerald,
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
    borderColor: c.emerald,
    backgroundColor: 'rgba(0,212,170,0.10)',
    shadowColor: c.emerald,
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
  scheduleTime: { fontSize: 24, fontWeight: '700', color: c.text, fontVariant: ['tabular-nums'] },
  scheduleDateHint: { fontSize: 12, color: c.textDim, marginLeft: 8 },
  scheduleChips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 2 },
  scheduleDuration: { fontSize: 13, color: c.textDim },
  scheduleChip: { fontSize: 11, color: c.textMuted, backgroundColor: 'rgba(255,255,255,0.06)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  statusBadgeRunning: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
    backgroundColor: 'rgba(0,212,170,0.18)',
    borderWidth: 1, borderColor: 'rgba(0,212,170,0.45)',
  },
  statusBadgeRunningText: {
    fontSize: 11, fontWeight: '700', color: c.emerald, letterSpacing: 0.3,
  },
  statusDot: {
    width: 7, height: 7, borderRadius: 4, backgroundColor: c.emerald,
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
  textDisabled: { color: c.textMuted },
});

const makeEditorStyles = (c: Colors) => StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: c.card, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderTopWidth: 1, borderColor: c.cardBorder,
    padding: 24, paddingBottom: 40, maxHeight: '90%',
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 24 },
  backBtn: { padding: 4 },
  title: { fontSize: 20, fontWeight: '700', color: c.text },
  label: { fontSize: 13, fontWeight: '600', color: c.textDim, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 16 },
  dayRow: { flexDirection: 'row', marginBottom: 8 },
  dayChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
    backgroundColor: c.inputBg, borderWidth: 1, borderColor: c.cardBorder, marginRight: 8,
  },
  dayChipActive: { backgroundColor: c.emerald },
  dayChipText: { fontSize: 14, fontWeight: '600', color: c.textDim },
  dayChipTextActive: { color: c.white },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  timeInput: {
    width: 60, height: 48, backgroundColor: c.inputBg,
    borderRadius: 12, borderWidth: 1, borderColor: c.inputBorder,
    textAlign: 'center', fontSize: 20, fontWeight: '700', color: c.text,
  },
  timeSeparator: { fontSize: 24, fontWeight: '700', color: c.textDim },
  input: {
    height: 48, backgroundColor: c.inputBg,
    borderRadius: 12, borderWidth: 1, borderColor: c.inputBorder,
    paddingHorizontal: 16, fontSize: 16, color: c.text,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10,
    backgroundColor: c.inputBg, borderWidth: 1, borderColor: c.cardBorder,
  },
  chipActive: { backgroundColor: c.emerald },
  chipText: { fontSize: 14, fontWeight: '600', color: c.textDim },
  chipTextActive: { color: c.white },
  dirChip: {
    width: 44, paddingVertical: 8, borderRadius: 10, alignItems: 'center' as const,
    backgroundColor: c.inputBg, borderWidth: 1, borderColor: c.cardBorder,
  },
  dirChipActive: { backgroundColor: c.purple },
  dirText: { fontSize: 14, fontWeight: '700', color: c.textDim },
  dirTextActive: { color: c.white },
  saveButton: {
    height: 48, borderRadius: 12, backgroundColor: c.emerald,
    alignItems: 'center', justifyContent: 'center', marginTop: 24,
  },
  saveButtonText: { fontSize: 16, fontWeight: '600', color: c.white },
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
  stepperValue: { fontSize: 18, fontWeight: '700', color: c.white, minWidth: 60, textAlign: 'center' },
  rainTitle: { fontSize: 14, fontWeight: '600', color: c.white },
  rainSub: { fontSize: 11, color: c.textMuted, marginTop: 2 },
});
