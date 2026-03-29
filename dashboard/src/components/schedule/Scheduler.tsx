import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Clock, Plus, Trash2, Send, X, ChevronRight, Calendar,
  Compass, ArrowUp, AlertTriangle, CloudRain, RefreshCw, Ruler,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Schedule, MapData } from '../../types';
import type { RainSession } from '../../api/client';
import { fetchSchedules, createSchedule, updateSchedule, deleteSchedule, sendSchedule, fetchMaps, fetchRainSessions } from '../../api/client';

const DIR_DEGREES = [0, 45, 90, 135, 180, 225, 270, 315];

/** Check of twee tijdranges overlappen (HH:MM format) */
function timesOverlap(s1: string, e1: string | null, s2: string, e2: string | null): boolean {
  const start1 = s1;
  const end1 = e1 || '23:59';
  const start2 = s2;
  const end2 = e2 || '23:59';
  return start1 < end2 && start2 < end1;
}

/** Vind conflicterende schedules */
function findConflicts(
  startTime: string, endTime: string | null, weekdays: number[],
  schedules: Schedule[], excludeId?: string,
): Schedule[] {
  return schedules.filter(s => {
    if (!s.enabled) return false;
    if (s.scheduleId === excludeId) return false;
    // Check weekday overlap
    const dayOverlap = weekdays.some(d => s.weekdays.includes(d));
    if (!dayOverlap) return false;
    // Check time overlap
    return timesOverlap(startTime, endTime, s.startTime, s.endTime);
  });
}

interface Props {
  sn: string;
  online: boolean;
  /** Called when the user changes the mowing direction (or null on close) */
  onPathDirectionChange?: (deg: number | null) => void;
}

interface ScheduleForm {
  scheduleName: string;
  startTime: string;
  endTime: string;
  weekdays: number[];
  mapId: string;
  mapName: string;
  cuttingHeight: number;
  pathDirection: number;
  alternateDirection: boolean;
  alternateStep: number;
  edgeOffset: number;
  rainPause: boolean;
  rainThresholdMm: number;
  rainThresholdProbability: number;
  rainCheckHours: number;
}

const defaultForm: ScheduleForm = {
  scheduleName: '',
  startTime: '09:00',
  endTime: '12:00',
  weekdays: [1, 2, 3, 4, 5],
  mapId: '',
  mapName: '',
  cuttingHeight: 40,
  pathDirection: 0,
  alternateDirection: false,
  alternateStep: 90,
  edgeOffset: 0,
  rainPause: false,
  rainThresholdMm: 0.5,
  rainThresholdProbability: 50,
  rainCheckHours: 2,
};

export function Scheduler({ sn, online, onPathDirectionChange }: Props) {
  const { t } = useTranslation();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [maps, setMaps] = useState<MapData[]>([]);
  const [rainSessions, setRainSessions] = useState<RainSession[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ScheduleForm>(defaultForm);
  const [saving, setSaving] = useState(false);

  const weekdayLabels = t('schedule.weekdays', { returnObjects: true }) as string[];
  const compassLabels = t('schedule.compass', { returnObjects: true }) as string[];

  // Conflict detection: form vs existing schedules
  const formConflicts = useMemo(() => {
    if (!showForm || !form.startTime || form.weekdays.length === 0) return [];
    return findConflicts(form.startTime, form.endTime || null, form.weekdays, schedules);
  }, [showForm, form.startTime, form.endTime, form.weekdays, schedules]);

  // Conflict map for existing schedules (schedule_id → conflicting schedule names)
  const scheduleConflictMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of schedules) {
      if (!s.enabled) continue;
      const conflicts = findConflicts(s.startTime, s.endTime, s.weekdays, schedules, s.scheduleId);
      if (conflicts.length > 0) {
        map.set(s.scheduleId, conflicts.map(c => c.scheduleName || c.startTime));
      }
    }
    return map;
  }, [schedules]);

  useEffect(() => {
    fetchSchedules(sn).then(setSchedules).catch(() => {});
    fetchMaps(sn).then(m => setMaps(m.filter(x => x.mapArea.length >= 3))).catch(() => {});
    fetchRainSessions(sn).then(setRainSessions).catch(() => {});
  }, [sn]);

  // Poll rain sessions elke 30s (ze veranderen door achtergrond weather checks)
  useEffect(() => {
    const id = setInterval(() => {
      fetchRainSessions(sn).then(setRainSessions).catch(() => {});
    }, 30_000);
    return () => clearInterval(id);
  }, [sn]);

  const handleCreate = useCallback(async () => {
    if (!form.startTime) return;
    setSaving(true);
    try {
      const s = await createSchedule(sn, {
        scheduleName: form.scheduleName || null,
        startTime: form.startTime,
        endTime: form.endTime || null,
        weekdays: form.weekdays,
        enabled: true,
        mapId: form.mapId || null,
        mapName: form.mapName || null,
        cuttingHeight: form.cuttingHeight,
        pathDirection: form.pathDirection,
        workMode: 0,
        taskMode: 0,
        alternateDirection: form.alternateDirection,
        alternateStep: form.alternateStep,
        edgeOffset: form.edgeOffset,
        rainPause: form.rainPause,
        rainThresholdMm: form.rainThresholdMm,
        rainThresholdProbability: form.rainThresholdProbability,
        rainCheckHours: form.rainCheckHours,
      });
      setSchedules(prev => [...prev, s]);
      setShowForm(false);
      setForm(defaultForm);
      onPathDirectionChange?.(null);
    } catch { /* ignore */ }
    setSaving(false);
  }, [sn, form, onPathDirectionChange]);

  const handleDelete = useCallback(async (scheduleId: string) => {
    await deleteSchedule(sn, scheduleId).catch(() => {});
    setSchedules(prev => prev.filter(s => s.scheduleId !== scheduleId));
  }, [sn]);

  const handleToggle = useCallback(async (scheduleId: string, enabled: boolean) => {
    const updated = await updateSchedule(sn, scheduleId, { enabled }).catch(() => null);
    if (updated) {
      setSchedules(prev => prev.map(s => s.scheduleId === scheduleId ? updated : s));
    }
  }, [sn]);

  const handleSend = useCallback(async (scheduleId: string) => {
    await sendSchedule(sn, scheduleId).catch(() => {});
  }, [sn]);

  const toggleWeekday = (day: number) => {
    setForm(prev => ({
      ...prev,
      weekdays: prev.weekdays.includes(day)
        ? prev.weekdays.filter(d => d !== day)
        : [...prev.weekdays, day].sort(),
    }));
  };

  return (
    <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-semibold text-white">{t('schedule.title')}</span>
          <span className="text-xs text-gray-500">{schedules.length}</span>
        </div>
        <button
          onClick={() => {
            const next = !showForm;
            setShowForm(next);
            setForm(defaultForm);
            onPathDirectionChange?.(next ? defaultForm.pathDirection : null);
          }}
          className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors"
        >
          <Plus className="w-3 h-3" />
          {t('schedule.new')}
        </button>
      </div>

      {/* New schedule form */}
      {showForm && (
        <div className="p-4 border-b border-gray-700 bg-gray-850">
          {/* Name */}
          <div className="mb-3">
            <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t('schedule.name')}</label>
            <input
              value={form.scheduleName}
              onChange={e => setForm(prev => ({ ...prev, scheduleName: e.target.value }))}
              placeholder={t('schedule.namePlaceholder')}
              className="mt-1 w-full text-sm bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Time */}
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t('schedule.start')}</label>
              <input
                type="time"
                value={form.startTime}
                onChange={e => setForm(prev => ({ ...prev, startTime: e.target.value }))}
                className="mt-1 w-full text-sm bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t('schedule.end')}</label>
              <input
                type="time"
                value={form.endTime}
                onChange={e => setForm(prev => ({ ...prev, endTime: e.target.value }))}
                className="mt-1 w-full text-sm bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* Weekdays */}
          <div className="mb-3">
            <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t('schedule.days')}</label>
            <div className="flex gap-1 mt-1">
              {weekdayLabels.map((label, idx) => (
                <button
                  key={idx}
                  onClick={() => toggleWeekday(idx)}
                  className={`flex-1 text-[11px] py-1.5 rounded transition-colors ${
                    form.weekdays.includes(idx)
                      ? 'bg-blue-600 text-white font-medium'
                      : 'bg-gray-900 text-gray-500 hover:text-gray-300 border border-gray-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Map selection */}
          {maps.length > 0 && (
            <div className="mb-3">
              <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t('schedule.workArea')}</label>
              <select
                value={form.mapId}
                onChange={e => {
                  const m = maps.find(x => x.mapId === e.target.value);
                  setForm(prev => ({ ...prev, mapId: e.target.value, mapName: m?.mapName ?? '' }));
                }}
                className="mt-1 w-full text-sm bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
              >
                <option value="">{t('schedule.allWorkAreas')}</option>
                {maps.map(m => (
                  <option key={m.mapId} value={m.mapId}>{m.mapName || m.mapId}</option>
                ))}
              </select>
            </div>
          )}

          {/* Cutting height */}
          <div className="mb-3">
            <div className="flex items-center justify-between">
              <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t('schedule.cuttingHeight')}</label>
              <span className="text-[11px] text-gray-300 font-mono">{(form.cuttingHeight / 10).toFixed(1)} cm</span>
            </div>
            <input
              type="range"
              min={20}
              max={80}
              step={5}
              value={form.cuttingHeight}
              onChange={e => setForm(prev => ({ ...prev, cuttingHeight: parseInt(e.target.value) }))}
              className="w-full h-1.5 mt-1 accent-emerald-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
            />
            <div className="flex justify-between text-[9px] text-gray-600 mt-0.5">
              <span>2 cm</span>
              <span>8 cm</span>
            </div>
          </div>

          {/* Path direction */}
          <div className="mb-3">
            <div className="flex items-center justify-between">
              <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t('schedule.pathDirection')}</label>
              <span className="text-[11px] text-gray-300 font-mono inline-flex items-center gap-1">
                <ArrowUp className="w-3 h-3 transition-transform" style={{ transform: `rotate(${form.pathDirection}deg)` }} />
                {form.pathDirection}&deg;
              </span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 mb-1">
              {DIR_DEGREES.map((deg, i) => (
                <button
                  key={deg}
                  onClick={() => { setForm(prev => ({ ...prev, pathDirection: deg })); onPathDirectionChange?.(deg); }}
                  className={`text-[9px] py-1 rounded transition-colors ${
                    form.pathDirection === deg
                      ? 'bg-blue-600 text-white font-medium'
                      : 'bg-gray-900 text-gray-500 hover:text-gray-300 border border-gray-700'
                  }`}
                >
                  {compassLabels[i] ?? `${deg}°`}
                </button>
              ))}
            </div>
            <input
              type="range"
              min={0}
              max={360}
              step={5}
              value={form.pathDirection}
              onChange={e => { const v = parseInt(e.target.value); setForm(prev => ({ ...prev, pathDirection: v })); onPathDirectionChange?.(v); }}
              className="w-full h-1.5 accent-blue-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
            />
          </div>

          {/* Alternate direction */}
          <div className="mb-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.alternateDirection}
                onChange={e => setForm(prev => ({ ...prev, alternateDirection: e.target.checked }))}
                className="w-3.5 h-3.5 rounded accent-blue-500 bg-gray-900 border-gray-700"
              />
              <span className="text-[11px] text-gray-300">{t('schedule.alternateDirection')}</span>
              <RefreshCw className="w-3 h-3 text-gray-500" />
            </label>
            {form.alternateDirection && (
              <div className="flex items-center gap-2 mt-1.5 ml-5">
                <span className="text-[10px] text-gray-500">{t('schedule.alternateStep')}</span>
                {[45, 90, 180].map(step => (
                  <button
                    key={step}
                    onClick={() => setForm(prev => ({ ...prev, alternateStep: step }))}
                    className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                      form.alternateStep === step
                        ? 'bg-blue-600 text-white font-medium'
                        : 'bg-gray-900 text-gray-500 hover:text-gray-300 border border-gray-700'
                    }`}
                  >
                    +{step}&deg;
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Edge offset */}
          <div className="mb-3">
            <div className="flex items-center justify-between">
              <label className="text-[10px] text-gray-500 uppercase tracking-wide inline-flex items-center gap-1">
                <Ruler className="w-3 h-3" />
                {t('schedule.edgeOffset')}
              </label>
              <span className="text-[11px] text-gray-300 font-mono">
                {form.edgeOffset > 0 ? '+' : ''}{form.edgeOffset.toFixed(2)} m
              </span>
            </div>
            <input
              type="range"
              min={-0.5}
              max={0.5}
              step={0.05}
              value={form.edgeOffset}
              onChange={e => setForm(prev => ({ ...prev, edgeOffset: parseFloat(e.target.value) }))}
              className="w-full h-1.5 mt-1 accent-blue-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
            />
            <div className="flex justify-between text-[9px] text-gray-600 mt-0.5">
              <span>{t('schedule.edgeOffsetShrink')}</span>
              <span>{t('schedule.edgeOffsetExpand')}</span>
            </div>
          </div>

          {/* Rain pause */}
          <div className="mb-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.rainPause}
                onChange={e => setForm(prev => ({ ...prev, rainPause: e.target.checked }))}
                className="w-3.5 h-3.5 rounded accent-blue-500 bg-gray-900 border-gray-700"
              />
              <span className="text-[11px] text-gray-300">{t('schedule.rainPause')}</span>
              <CloudRain className="w-3 h-3 text-blue-400" />
            </label>
            {form.rainPause && (
              <div className="mt-2 ml-5 space-y-2">
                {/* Rain threshold mm */}
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-gray-500">{t('schedule.rainThreshold')}</span>
                    <span className="text-[10px] text-gray-400 font-mono">{form.rainThresholdMm.toFixed(1)} mm/h</span>
                  </div>
                  <input
                    type="range"
                    min={0.1}
                    max={5}
                    step={0.1}
                    value={form.rainThresholdMm}
                    onChange={e => setForm(prev => ({ ...prev, rainThresholdMm: parseFloat(e.target.value) }))}
                    className="w-full h-1 accent-blue-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
                  />
                </div>
                {/* Rain probability */}
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-gray-500">{t('schedule.rainProbability')}</span>
                    <span className="text-[10px] text-gray-400 font-mono">{form.rainThresholdProbability}%</span>
                  </div>
                  <input
                    type="range"
                    min={10}
                    max={90}
                    step={5}
                    value={form.rainThresholdProbability}
                    onChange={e => setForm(prev => ({ ...prev, rainThresholdProbability: parseInt(e.target.value) }))}
                    className="w-full h-1 accent-blue-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
                  />
                </div>
                {/* Check hours ahead */}
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-gray-500">{t('schedule.rainCheckHours')}</span>
                    <span className="text-[10px] text-gray-400 font-mono">{form.rainCheckHours}h</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={6}
                    step={1}
                    value={form.rainCheckHours}
                    onChange={e => setForm(prev => ({ ...prev, rainCheckHours: parseInt(e.target.value) }))}
                    className="w-full h-1 accent-blue-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
                  />
                </div>
                <div className="text-[9px] text-blue-400/60 italic">{t('schedule.serverManaged')}</div>
              </div>
            )}
          </div>

          {/* Conflict warning */}
          {formConflicts.length > 0 && (
            <div className="flex items-start gap-2 p-2 rounded bg-amber-900/20 border border-amber-800/30">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="text-[10px] text-amber-400">
                <div className="font-medium">{t('schedule.conflictWarning')}</div>
                <div className="text-amber-500 mt-0.5">
                  {t('schedule.conflict', { names: formConflicts.map(c => c.scheduleName || c.startTime).join(', ') })}
                </div>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-3 border-t border-gray-700">
            <button
              onClick={() => { setShowForm(false); onPathDirectionChange?.(null); }}
              className="flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
            >
              <X className="w-3 h-3" />
              {t('common.cancel')}
            </button>
            <button
              onClick={handleCreate}
              disabled={saving || !form.startTime || form.weekdays.length === 0}
              className="flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus className="w-3 h-3" />
              {saving ? t('schedule.saving') : t('schedule.create')}
            </button>
          </div>
        </div>
      )}

      {/* Active rain sessions banner */}
      {rainSessions.length > 0 && (
        <div className="px-4 py-2.5 border-b border-blue-800/30 bg-blue-900/20">
          {rainSessions.map(rs => (
            <div key={rs.session_id} className="flex items-center gap-2 text-[11px]">
              <CloudRain className="w-4 h-4 text-blue-400 animate-pulse" />
              <span className="text-blue-300 font-medium">{t('schedule.rainPausedActive')}</span>
              <span className="text-blue-400/70">
                {new Date(rs.paused_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              {rs.map_name && (
                <span className="text-blue-400/50 truncate">• {rs.map_name}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Schedule list */}
      <div className="divide-y divide-gray-700/50">
        {schedules.length === 0 && !showForm && (
          <div className="px-4 py-6 text-center text-sm text-gray-500">
            {t('schedule.empty')}
          </div>
        )}
        {schedules.map(s => (
          <div key={s.scheduleId} className={`px-4 py-3 ${!s.enabled ? 'opacity-50' : ''}`}>
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleToggle(s.scheduleId, !s.enabled)}
                  className={`w-8 h-4 rounded-full transition-colors relative ${
                    s.enabled ? 'bg-blue-600' : 'bg-gray-700'
                  }`}
                  title={s.enabled ? t('schedule.disable') : t('schedule.enable')}
                >
                  <div className={`w-3 h-3 rounded-full bg-white absolute top-0.5 transition-transform ${
                    s.enabled ? 'translate-x-4' : 'translate-x-0.5'
                  }`} />
                </button>
                <Clock className="w-3.5 h-3.5 text-blue-400" />
                <span className="text-sm font-semibold text-white font-mono">
                  {s.startTime}{s.endTime ? ` \u2013 ${s.endTime}` : ''}
                </span>
                {scheduleConflictMap.has(s.scheduleId) && (
                  <span title={t('schedule.conflict', { names: scheduleConflictMap.get(s.scheduleId)!.join(', ') })}>
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {online && s.enabled && (
                  <button
                    onClick={() => handleSend(s.scheduleId)}
                    className="text-blue-400 hover:text-blue-300 p-1 rounded hover:bg-blue-900/30 transition-colors"
                    title={t('schedule.sendToMower')}
                  >
                    <Send className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  onClick={() => handleDelete(s.scheduleId)}
                  className="text-gray-500 hover:text-red-400 p-1 rounded hover:bg-red-900/30 transition-colors"
                  title={t('common.delete')}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-gray-400">
              {/* Weekday pills */}
              <div className="flex gap-0.5">
                {weekdayLabels.map((label, idx) => (
                  <span
                    key={idx}
                    className={`w-5 h-5 flex items-center justify-center rounded-sm text-[9px] ${
                      s.weekdays.includes(idx)
                        ? 'bg-blue-900/50 text-blue-400 font-medium'
                        : 'text-gray-600'
                    }`}
                  >
                    {label[0]}
                  </span>
                ))}
              </div>
              <span className="text-gray-600">|</span>
              <span className="inline-flex items-center gap-0.5">
                <Compass className="w-3 h-3" />
                {s.pathDirection}&deg;
                {s.alternateDirection && <RefreshCw className="w-2.5 h-2.5 text-blue-400" />}
              </span>
              <span>{(s.cuttingHeight / 10).toFixed(1)} cm</span>
              {s.edgeOffset !== 0 && (
                <span className="inline-flex items-center gap-0.5 text-emerald-400">
                  <Ruler className="w-2.5 h-2.5" />
                  {s.edgeOffset > 0 ? '+' : ''}{s.edgeOffset.toFixed(2)}m
                </span>
              )}
              {s.rainPause && (
                <span className={`inline-flex items-center gap-0.5 ${
                  rainSessions.some(rs => rs.schedule_id === s.scheduleId) ? 'text-blue-300' : 'text-blue-400'
                }`}>
                  <CloudRain className={`w-3 h-3 ${
                    rainSessions.some(rs => rs.schedule_id === s.scheduleId) ? 'animate-pulse' : ''
                  }`} />
                  {rainSessions.some(rs => rs.schedule_id === s.scheduleId) && (
                    <span className="text-[9px] text-blue-300">{t('schedule.rainPaused')}</span>
                  )}
                </span>
              )}
              {s.scheduleName && (
                <>
                  <span className="text-gray-600">|</span>
                  <span className="truncate">{s.scheduleName}</span>
                </>
              )}
              {s.mapName && (
                <>
                  <ChevronRight className="w-3 h-3 text-gray-600" />
                  <span className="truncate">{s.mapName}</span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
