import { useState, useEffect } from 'react';
import { Plus, Loader } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Schedule, MapData } from '../../types';
import { fetchSchedules, fetchMaps } from '../../api/client';
import { CalendarGrid } from './schedule/CalendarGrid';
import { ScheduleSheet } from './schedule/ScheduleSheet';

interface Props {
  sn: string;
  online: boolean;
}

export function SchedulesTab({ sn, online }: Props) {
  const { t } = useTranslation();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [maps, setMaps] = useState<MapData[]>([]);
  const [loading, setLoading] = useState(true);

  // Sheet state
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editSchedule, setEditSchedule] = useState<Schedule | null>(null);
  const [createDefaults, setCreateDefaults] = useState<{ weekday: number; hour: number } | null>(null);

  useEffect(() => {
    if (!sn) return;
    Promise.all([
      fetchSchedules(sn),
      fetchMaps(sn),
    ]).then(([s, m]) => {
      setSchedules(s);
      setMaps(m);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [sn]);

  const openCreate = (weekday?: number, hour?: number) => {
    setEditSchedule(null);
    setCreateDefaults(weekday != null && hour != null ? { weekday, hour } : null);
    setSheetOpen(true);
  };

  const openEdit = (schedule: Schedule) => {
    setEditSchedule(schedule);
    setCreateDefaults(null);
    setSheetOpen(true);
  };

  const handleSaved = (schedule: Schedule) => {
    setSchedules(prev => {
      const idx = prev.findIndex(s => s.scheduleId === schedule.scheduleId);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = schedule;
        return copy;
      }
      return [...prev, schedule];
    });
  };

  const handleDeleted = (scheduleId: string) => {
    setSchedules(prev => prev.filter(s => s.scheduleId !== scheduleId));
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader className="w-5 h-5 text-gray-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header with + button */}
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          {t('mobile.tabs.schedules')}
        </h2>
        <button
          onClick={() => openCreate()}
          disabled={!online}
          className="w-8 h-8 rounded-full bg-emerald-500 hover:bg-emerald-400
                     flex items-center justify-center text-white
                     active:scale-[0.92] disabled:opacity-40 transition-all"
        >
          <Plus className="w-5 h-5" />
        </button>
      </div>

      {/* Calendar grid */}
      <div className="flex-1 min-h-0">
        <CalendarGrid
          schedules={schedules}
          onEdit={openEdit}
          onCreateAt={(weekday, hour) => openCreate(weekday, hour)}
        />
      </div>

      {/* Schedule editor sheet */}
      <ScheduleSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        sn={sn}
        editSchedule={editSchedule}
        createDefaults={createDefaults}
        maps={maps}
        onSaved={handleSaved}
        onDeleted={handleDeleted}
      />
    </div>
  );
}
