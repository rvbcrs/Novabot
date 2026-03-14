import { useState, useEffect } from 'react';
import { CalendarDays, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Schedule } from '../../types';
import { fetchSchedules, updateSchedule } from '../../api/client';
import { useToast } from '../../components/common/Toast';

interface Props {
  sn: string;
  online: boolean;
}

function formatWeekdays(weekdays: number[], dayLabels: string[]): string {
  if (!weekdays || weekdays.length === 0) return '';
  if (weekdays.length === 7) return 'Daily';
  return weekdays.map(d => dayLabels[d]?.slice(0, 2) ?? '').join(' · ');
}

export function SchedulesTab({ sn, online }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);

  const weekdayLabels = (t('schedule.weekdays', { returnObjects: true }) as string[]) ?? [];

  useEffect(() => {
    if (!sn) return;
    fetchSchedules(sn)
      .then(data => { setSchedules(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [sn]);

  const handleToggle = async (schedule: Schedule) => {
    const newEnabled = !schedule.enabled;
    // Optimistic update
    setSchedules(prev =>
      prev.map(s => s.scheduleId === schedule.scheduleId ? { ...s, enabled: newEnabled } : s)
    );
    try {
      await updateSchedule(sn, schedule.scheduleId, { enabled: newEnabled });
    } catch {
      // Revert
      setSchedules(prev =>
        prev.map(s => s.scheduleId === schedule.scheduleId ? { ...s, enabled: schedule.enabled } : s)
      );
      toast('Update failed', 'error');
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-gray-500 text-sm">{t('devices.loading')}</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-4 pt-5 pb-3">
        <h2 className="text-lg font-semibold text-white">{t('mobile.tabs.schedules')}</h2>
      </div>

      {schedules.length === 0 ? (
        <div className="px-4 py-12 text-center">
          <CalendarDays className="w-12 h-12 text-gray-700 mx-auto mb-3" />
          <p className="text-sm text-gray-500">{t('mobile.noSchedules')}</p>
        </div>
      ) : (
        <div className="px-4 space-y-2 pb-6">
          {schedules.map(s => (
            <div
              key={s.scheduleId}
              className={`bg-gray-900 rounded-xl border border-gray-800 px-4 py-3 flex items-center gap-3 transition-opacity ${
                !s.enabled ? 'opacity-50' : ''
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white truncate">
                  {s.scheduleName || formatWeekdays(s.weekdays, weekdayLabels) || t('schedule.title')}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <Clock className="w-3 h-3 text-gray-500" />
                  <span className="text-xs text-gray-400 tabular-nums">
                    {s.startTime}{s.endTime ? ` — ${s.endTime}` : ''}
                  </span>
                  {s.mapName && (
                    <span className="text-xs text-gray-500 truncate">· {s.mapName}</span>
                  )}
                </div>
              </div>

              {/* Toggle switch */}
              <button
                onClick={() => handleToggle(s)}
                disabled={!online}
                className={`w-11 h-6 rounded-full relative flex-shrink-0 transition-colors disabled:opacity-50 ${
                  s.enabled ? 'bg-emerald-500' : 'bg-gray-600'
                }`}
                role="switch"
                aria-checked={s.enabled}
              >
                <span
                  className={`block w-5 h-5 bg-white rounded-full shadow absolute top-0.5 transition-transform ${
                    s.enabled ? 'translate-x-[22px]' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
