import { useState, useEffect, useCallback } from 'react';
import {
  Clock, Plus, Trash2, Send, X, ChevronRight, Calendar,
  Compass, ArrowUp,
} from 'lucide-react';
import type { Schedule, MapData } from '../../types';
import { fetchSchedules, createSchedule, updateSchedule, deleteSchedule, sendSchedule, fetchMaps } from '../../api/client';

const WEEKDAY_LABELS = ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'];

interface Props {
  sn: string;
  online: boolean;
  /** Wordt aangeroepen wanneer de gebruiker de maairichting aanpast (of null bij sluiten) */
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
};

export function Scheduler({ sn, online, onPathDirectionChange }: Props) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [maps, setMaps] = useState<MapData[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ScheduleForm>(defaultForm);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSchedules(sn).then(setSchedules).catch(() => {});
    fetchMaps(sn).then(m => setMaps(m.filter(x => x.mapArea.length >= 3))).catch(() => {});
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

  // Compass direction presets (maaier firmware accepteert 0-180°, 0°=N-Z lijnen, 90°=O-W lijnen)
  const DIR_PRESETS = [
    { label: 'N–Z', deg: 0 },
    { label: 'NO–ZW', deg: 45 },
    { label: 'O–W', deg: 90 },
    { label: 'ZO–NW', deg: 135 },
  ];

  return (
    <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-semibold text-white">Maaischema's</span>
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
          Nieuw
        </button>
      </div>

      {/* New schedule form */}
      {showForm && (
        <div className="p-4 border-b border-gray-700 bg-gray-850">
          {/* Name */}
          <div className="mb-3">
            <label className="text-[10px] text-gray-500 uppercase tracking-wide">Naam (optioneel)</label>
            <input
              value={form.scheduleName}
              onChange={e => setForm(prev => ({ ...prev, scheduleName: e.target.value }))}
              placeholder="Bijv. Doordeweeks ochtend"
              className="mt-1 w-full text-sm bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Time */}
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wide">Start</label>
              <input
                type="time"
                value={form.startTime}
                onChange={e => setForm(prev => ({ ...prev, startTime: e.target.value }))}
                className="mt-1 w-full text-sm bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wide">Einde</label>
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
            <label className="text-[10px] text-gray-500 uppercase tracking-wide">Dagen</label>
            <div className="flex gap-1 mt-1">
              {WEEKDAY_LABELS.map((label, idx) => (
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
              <label className="text-[10px] text-gray-500 uppercase tracking-wide">Werkgebied</label>
              <select
                value={form.mapId}
                onChange={e => {
                  const m = maps.find(x => x.mapId === e.target.value);
                  setForm(prev => ({ ...prev, mapId: e.target.value, mapName: m?.mapName ?? '' }));
                }}
                className="mt-1 w-full text-sm bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
              >
                <option value="">Alle werkgebieden</option>
                {maps.map(m => (
                  <option key={m.mapId} value={m.mapId}>{m.mapName || m.mapId}</option>
                ))}
              </select>
            </div>
          )}

          {/* Cutting height */}
          <div className="mb-3">
            <div className="flex items-center justify-between">
              <label className="text-[10px] text-gray-500 uppercase tracking-wide">Maaihoogte</label>
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
          <div className="mb-4">
            <div className="flex items-center justify-between">
              <label className="text-[10px] text-gray-500 uppercase tracking-wide">Maairichting</label>
              <span className="text-[11px] text-gray-300 font-mono inline-flex items-center gap-1">
                <ArrowUp className="w-3 h-3 transition-transform" style={{ transform: `rotate(${form.pathDirection}deg)` }} />
                {form.pathDirection}&deg;
              </span>
            </div>
            <div className="flex gap-1 mt-1 mb-1">
              {DIR_PRESETS.map(p => (
                <button
                  key={p.deg}
                  onClick={() => { setForm(prev => ({ ...prev, pathDirection: p.deg })); onPathDirectionChange?.(p.deg); }}
                  className={`flex-1 text-[10px] py-1 rounded transition-colors ${
                    form.pathDirection === p.deg
                      ? 'bg-blue-600 text-white font-medium'
                      : 'bg-gray-900 text-gray-500 hover:text-gray-300 border border-gray-700'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input
              type="range"
              min={0}
              max={180}
              step={5}
              value={form.pathDirection}
              onChange={e => { const v = parseInt(e.target.value); setForm(prev => ({ ...prev, pathDirection: v })); onPathDirectionChange?.(v); }}
              className="w-full h-1.5 accent-blue-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-3 border-t border-gray-700">
            <button
              onClick={() => { setShowForm(false); onPathDirectionChange?.(null); }}
              className="flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
            >
              <X className="w-3 h-3" />
              Annuleren
            </button>
            <button
              onClick={handleCreate}
              disabled={saving || !form.startTime || form.weekdays.length === 0}
              className="flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus className="w-3 h-3" />
              {saving ? 'Opslaan...' : 'Aanmaken'}
            </button>
          </div>
        </div>
      )}

      {/* Schedule list */}
      <div className="divide-y divide-gray-700/50">
        {schedules.length === 0 && !showForm && (
          <div className="px-4 py-6 text-center text-sm text-gray-500">
            Geen schema's ingesteld
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
                  title={s.enabled ? 'Uitschakelen' : 'Inschakelen'}
                >
                  <div className={`w-3 h-3 rounded-full bg-white absolute top-0.5 transition-transform ${
                    s.enabled ? 'translate-x-4' : 'translate-x-0.5'
                  }`} />
                </button>
                <Clock className="w-3.5 h-3.5 text-blue-400" />
                <span className="text-sm font-semibold text-white font-mono">
                  {s.startTime}{s.endTime ? ` – ${s.endTime}` : ''}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {online && s.enabled && (
                  <button
                    onClick={() => handleSend(s.scheduleId)}
                    className="text-blue-400 hover:text-blue-300 p-1 rounded hover:bg-blue-900/30 transition-colors"
                    title="Stuur naar maaier"
                  >
                    <Send className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  onClick={() => handleDelete(s.scheduleId)}
                  className="text-gray-500 hover:text-red-400 p-1 rounded hover:bg-red-900/30 transition-colors"
                  title="Verwijderen"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-gray-400">
              {/* Weekday pills */}
              <div className="flex gap-0.5">
                {WEEKDAY_LABELS.map((label, idx) => (
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
              </span>
              <span>{(s.cuttingHeight / 10).toFixed(1)} cm</span>
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
