import { useState, useEffect } from 'react';
import { CalendarClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Schedule } from '../../types';
import { fetchSchedules } from '../../api/client';

interface Props {
  sn: string;
}

/** Find the next occurrence of this schedule */
function getNextRun(schedule: Schedule): Date | null {
  if (!schedule.enabled) return null;

  const days = schedule.weekdays;
  if (!days || days.length === 0) return null;

  const [hh, mm] = schedule.startTime.split(':').map(Number);
  const now = new Date();
  const today = now.getDay(); // 0=Sun

  // Check each of the next 7 days
  for (let offset = 0; offset < 7; offset++) {
    const candidateDay = (today + offset) % 7;
    if (!days.includes(candidateDay)) continue;

    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(hh, mm, 0, 0);

    // Skip if this time has already passed today
    if (candidate > now) return candidate;
  }
  return null;
}

function formatNextRun(date: Date, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (diffDays === 0) return `${t('time.today')} ${time}`;
  if (diffDays === 1) return `${t('time.tomorrow')} ${time}`;

  const weekday = (t('schedule.weekdays', { returnObjects: true }) as unknown as string[])?.[date.getDay()] ?? '';
  return `${weekday} ${time}`;
}

export function NextScheduleCard({ sn }: Props) {
  const { t } = useTranslation();
  const [schedules, setSchedules] = useState<Schedule[]>([]);

  useEffect(() => {
    if (!sn) return;
    fetchSchedules(sn).then(setSchedules).catch(() => {});
  }, [sn]);

  // Find the next upcoming schedule
  let nextSchedule: Schedule | null = null;
  let nextRun: Date | null = null;

  for (const s of schedules) {
    if (!s.enabled) continue;
    const run = getNextRun(s);
    if (run && (!nextRun || run < nextRun)) {
      nextSchedule = s;
      nextRun = run;
    }
  }

  if (!nextSchedule || !nextRun) {
    return (
      <div className="flex items-center gap-3 bg-gray-900 rounded-xl border border-gray-800 px-4 py-3">
        <CalendarClock className="w-5 h-5 text-gray-600 flex-shrink-0" />
        <span className="text-sm text-gray-500">{t('mobile.noSchedules')}</span>
      </div>
    );
  }

  const label = formatNextRun(nextRun, t);

  return (
    <div className="flex items-center gap-3 bg-gray-900 rounded-xl border border-gray-800 px-4 py-3">
      <CalendarClock className="w-5 h-5 text-emerald-400 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-white font-medium truncate">
          {nextSchedule.scheduleName || label}
        </p>
        <p className="text-xs text-gray-400 truncate">
          {t('mobile.nextSchedule')}: {label}
          {nextSchedule.mapName ? ` — ${nextSchedule.mapName}` : ''}
        </p>
      </div>
    </div>
  );
}
