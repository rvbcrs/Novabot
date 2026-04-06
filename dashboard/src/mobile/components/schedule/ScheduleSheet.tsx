import { useState, useEffect, useRef, type TouchEvent as ReactTouchEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Schedule, MapData } from '../../../types';
import { createSchedule, updateSchedule, deleteSchedule } from '../../../api/client';
import { useToast } from '../../../components/common/Toast';
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';

interface Props {
  open: boolean;
  onClose: () => void;
  sn: string;
  editSchedule: Schedule | null;
  createDefaults: { weekday: number; hour: number } | null;
  maps: MapData[];
  onSaved: (schedule: Schedule) => void;
  onDeleted: (scheduleId: string) => void;
}

// Mon-Sun display order → weekday values
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const DEFAULT_SCHEDULE = {
  scheduleName: '',
  startTime: '09:00',
  endTime: '12:00',
  weekdays: [1, 2, 3, 4, 5] as number[],
  enabled: true,
  mapId: null as string | null,
  mapName: null as string | null,
  cuttingHeight: 40,
  pathDirection: 0,
  workMode: 0,
  taskMode: 0,
  alternateDirection: false,
  alternateStep: 2,
  edgeOffset: 0,
  rainPause: true,
  rainThresholdMm: 1,
  rainThresholdProbability: 50,
  rainCheckHours: 2,
};

export function ScheduleSheet({ open, onClose, sn, editSchedule, createDefaults, maps, onSaved, onDeleted }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const weekdayLabels = t('schedule.weekdays', { returnObjects: true }) as unknown as string[];

  // Form state
  const [name, setName] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('12:00');
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [mapId, setMapId] = useState<string | null>(null);
  const [cuttingHeight, setCuttingHeight] = useState(40);
  const [pathDirection, setPathDirection] = useState(0);
  const [rainPause, setRainPause] = useState(true);
  const [enabled, setEnabled] = useState(true);

  // Swipe-to-dismiss
  const dragRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const currentY = useRef(0);

  // Initialize form when opening
  useEffect(() => {
    if (!open) return;

    if (editSchedule) {
      setName(editSchedule.scheduleName ?? '');
      setStartTime(editSchedule.startTime);
      setEndTime(editSchedule.endTime ?? '');
      setWeekdays([...editSchedule.weekdays]);
      setMapId(editSchedule.mapId);
      setCuttingHeight(editSchedule.cuttingHeight);
      setPathDirection(editSchedule.pathDirection);
      setRainPause(editSchedule.rainPause);
      setEnabled(editSchedule.enabled);
    } else {
      // Create mode
      const d = createDefaults;
      const h = d ? String(d.hour).padStart(2, '0') + ':00' : '09:00';
      const endH = d ? String(Math.min(d.hour + 3, 22)).padStart(2, '0') + ':00' : '12:00';
      setName('');
      setStartTime(h);
      setEndTime(endH);
      setWeekdays(d ? [d.weekday] : [...DEFAULT_SCHEDULE.weekdays]);
      setMapId(null);
      setCuttingHeight(DEFAULT_SCHEDULE.cuttingHeight);
      setPathDirection(DEFAULT_SCHEDULE.pathDirection);
      setRainPause(DEFAULT_SCHEDULE.rainPause);
      setEnabled(true);
    }
  }, [open, editSchedule, createDefaults]);

  const toggleDay = (day: number) => {
    setWeekdays(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort()
    );
  };

  const handleSave = async () => {
    if (weekdays.length === 0) return;
    setSaving(true);

    const selectedMap = maps.find(m => m.mapId === mapId);
    const payload = {
      scheduleName: name || null,
      startTime,
      endTime: endTime || null,
      weekdays,
      enabled,
      mapId,
      mapName: selectedMap?.mapName ?? null,
      cuttingHeight,
      pathDirection,
      workMode: editSchedule?.workMode ?? DEFAULT_SCHEDULE.workMode,
      taskMode: editSchedule?.taskMode ?? DEFAULT_SCHEDULE.taskMode,
      alternateDirection: editSchedule?.alternateDirection ?? DEFAULT_SCHEDULE.alternateDirection,
      alternateStep: editSchedule?.alternateStep ?? DEFAULT_SCHEDULE.alternateStep,
      edgeOffset: editSchedule?.edgeOffset ?? DEFAULT_SCHEDULE.edgeOffset,
      rainPause,
      rainThresholdMm: editSchedule?.rainThresholdMm ?? DEFAULT_SCHEDULE.rainThresholdMm,
      rainThresholdProbability: editSchedule?.rainThresholdProbability ?? DEFAULT_SCHEDULE.rainThresholdProbability,
      rainCheckHours: editSchedule?.rainCheckHours ?? DEFAULT_SCHEDULE.rainCheckHours,
    };

    try {
      let result: Schedule;
      if (editSchedule) {
        result = await updateSchedule(sn, editSchedule.scheduleId, payload);
        toast(t('schedule.saved'), 'success');
      } else {
        result = await createSchedule(sn, payload);
        toast(t('schedule.created'), 'success');
      }
      onSaved(result);
      onClose();
    } catch {
      toast(t('schedule.saveFailed'), 'error');
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!editSchedule) return;
    setConfirmDelete(false);
    setSaving(true);
    try {
      await deleteSchedule(sn, editSchedule.scheduleId);
      toast(t('schedule.deleted'), 'success');
      onDeleted(editSchedule.scheduleId);
      onClose();
    } catch {
      toast(t('schedule.deleteFailed'), 'error');
    }
    setSaving(false);
  };

  // Touch handlers for drag handle
  const onTouchStart = (e: ReactTouchEvent) => {
    startY.current = e.touches[0].clientY;
    currentY.current = 0;
  };
  const onTouchMove = (e: ReactTouchEvent) => {
    const dy = e.touches[0].clientY - startY.current;
    currentY.current = Math.max(0, dy);
    if (sheetRef.current) {
      sheetRef.current.style.transform = `translateY(${currentY.current}px)`;
    }
  };
  const onTouchEnd = () => {
    if (currentY.current > 100) {
      onClose();
    }
    if (sheetRef.current) {
      sheetRef.current.style.transform = '';
    }
  };

  if (!open) return null;

  const workMaps = maps.filter(m => m.mapType === 'work');

  return (
    <>
      <div className="fixed inset-0 z-[9998]">
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

        {/* Sheet */}
        <div
          ref={sheetRef}
          className="absolute bottom-0 left-0 right-0 bg-white dark:bg-gray-900
                     rounded-t-2xl shadow-2xl animate-slide-up max-h-[80vh] flex flex-col"
        >
          {/* Drag handle */}
          <div
            ref={dragRef}
            className="flex justify-center py-3 cursor-grab"
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          >
            <div className="w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-700" />
          </div>

          {/* Scrollable form */}
          <div className="flex-1 overflow-y-auto px-5 pb-8 space-y-5">
            {/* Header */}
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {editSchedule ? t('common.edit') : t('schedule.new')}
            </h3>

            {/* Name */}
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                {t('schedule.name')}
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('schedule.namePlaceholder')}
                className="w-full h-10 px-3 rounded-lg border border-gray-200 dark:border-gray-700
                           bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white text-sm
                           placeholder:text-gray-400 dark:placeholder:text-gray-600
                           focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
              />
            </div>

            {/* Start / End */}
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                  {t('schedule.start')}
                </label>
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-gray-200 dark:border-gray-700
                             bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white text-sm
                             focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                  {t('schedule.end')}
                </label>
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-gray-200 dark:border-gray-700
                             bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white text-sm
                             focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />
              </div>
            </div>

            {/* Weekdays */}
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-2">
                {t('schedule.days')}
              </label>
              <div className="flex gap-1.5">
                {DAY_ORDER.map(day => (
                  <button
                    key={day}
                    onClick={() => toggleDay(day)}
                    className={`flex-1 h-9 rounded-lg text-xs font-semibold transition-colors
                      ${weekdays.includes(day)
                        ? 'bg-emerald-500 text-white'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
                      }`}
                  >
                    {weekdayLabels[day]?.slice(0, 2)}
                  </button>
                ))}
              </div>
            </div>

            {/* Work area */}
            {workMaps.length > 0 && (
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                  {t('schedule.workArea')}
                </label>
                <select
                  value={mapId ?? ''}
                  onChange={(e) => setMapId(e.target.value || null)}
                  className="w-full h-10 px-3 rounded-lg border border-gray-200 dark:border-gray-700
                             bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white text-sm
                             focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                >
                  <option value="">{t('schedule.allWorkAreas')}</option>
                  {workMaps.map(m => (
                    <option key={m.mapId} value={m.mapId}>{m.mapName || m.mapId}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Cutting height */}
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                {t('schedule.cuttingHeight')} — {(cuttingHeight / 10).toFixed(0)} cm
              </label>
              <input
                type="range"
                min={20}
                max={80}
                step={5}
                value={cuttingHeight}
                onChange={(e) => setCuttingHeight(Number(e.target.value))}
                className="w-full accent-emerald-500"
              />
              <div className="flex justify-between text-[10px] text-gray-400 dark:text-gray-600 mt-0.5">
                <span>2 cm</span>
                <span>8 cm</span>
              </div>
            </div>

            {/* Path direction */}
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-2">
                {t('schedule.pathDirection')}
              </label>
              <div className="grid grid-cols-4 gap-1.5">
                {(t('schedule.compass', { returnObjects: true }) as unknown as string[]).map((label, i) => {
                  const deg = i * 45;
                  return (
                    <button
                      key={deg}
                      onClick={() => setPathDirection(deg)}
                      className={`h-9 rounded-lg text-xs font-semibold transition-colors
                        ${pathDirection === deg
                          ? 'bg-emerald-500 text-white'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
                        }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Rain pause */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-900 dark:text-white">
                {t('schedule.rainPause')}
              </span>
              <button
                onClick={() => setRainPause(!rainPause)}
                className={`w-11 h-6 rounded-full relative flex-shrink-0 transition-colors ${
                  rainPause ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'
                }`}
                role="switch"
                aria-checked={rainPause}
              >
                <span
                  className={`block w-5 h-5 bg-white rounded-full shadow absolute top-0.5 transition-transform ${
                    rainPause ? 'translate-x-[22px]' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>

            {/* Enabled toggle (edit mode only) */}
            {editSchedule && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-900 dark:text-white">
                  {t('schedule.enable')}
                </span>
                <button
                  onClick={() => setEnabled(!enabled)}
                  className={`w-11 h-6 rounded-full relative flex-shrink-0 transition-colors ${
                    enabled ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                  role="switch"
                  aria-checked={enabled}
                >
                  <span
                    className={`block w-5 h-5 bg-white rounded-full shadow absolute top-0.5 transition-transform ${
                      enabled ? 'translate-x-[22px]' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-3 pt-2">
              {editSchedule && (
                <button
                  onClick={() => setConfirmDelete(true)}
                  disabled={saving}
                  className="h-11 px-4 rounded-xl bg-red-600 hover:bg-red-500 active:scale-[0.97]
                             text-white text-sm font-semibold flex items-center gap-1.5
                             disabled:opacity-50 transition-all"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={onClose}
                disabled={saving}
                className="flex-1 h-11 rounded-xl bg-gray-100 dark:bg-gray-800
                           text-gray-700 dark:text-gray-300 text-sm font-semibold
                           active:scale-[0.97] disabled:opacity-50 transition-all"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSave}
                disabled={saving || weekdays.length === 0}
                className="flex-1 h-11 rounded-xl bg-emerald-600 hover:bg-emerald-500
                           text-white text-sm font-semibold
                           active:scale-[0.97] disabled:opacity-50 transition-all"
              >
                {saving ? t('schedule.saving') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={t('schedule.deleteConfirm')}
        confirmLabel={t('common.delete')}
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
