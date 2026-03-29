import { useRef, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Schedule } from '../../../types';
import { getScheduleColor } from './scheduleColors';

const ROW_H = 44;
const START_HOUR = 6;
const END_HOUR = 22;
const HOURS = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i);
const TIME_COL_W = 32;

// Grid column index (0=Mon) → weekdays value (0=Sun, 1=Mon, ..., 6=Sat)
const COL_TO_WEEKDAY = [1, 2, 3, 4, 5, 6, 0];

interface Props {
  schedules: Schedule[];
  onEdit: (schedule: Schedule) => void;
  onCreateAt: (weekday: number, hour: number) => void;
}

function parseHour(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h + (m || 0) / 60;
}

export function CalendarGrid({ schedules, onEdit, onCreateAt }: Props) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(new Date());

  const weekdayLabels = t('schedule.weekdays', { returnObjects: true }) as unknown as string[];
  // Reorder: Mon-Sun display order
  const dayHeaders = [1, 2, 3, 4, 5, 6, 0].map(i => weekdayLabels[i]?.slice(0, 2) ?? '');

  // Auto-scroll to 08:00 on mount
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = (8 - START_HOUR) * ROW_H;
    }
  }, []);

  // Update current time line every minute
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Current time indicator position
  const nowHour = now.getHours() + now.getMinutes() / 60;
  const nowDay = now.getDay(); // 0=Sun
  const nowColIndex = nowDay === 0 ? 6 : nowDay - 1; // Mon=0 ... Sun=6
  const showTimeLine = nowHour >= START_HOUR && nowHour < END_HOUR;
  const timeLineTop = (nowHour - START_HOUR) * ROW_H;

  const handleColumnClick = (colIndex: number, e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const hour = Math.floor(y / ROW_H) + START_HOUR;
    if (hour >= START_HOUR && hour < END_HOUR) {
      onCreateAt(COL_TO_WEEKDAY[colIndex], hour);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Day headers */}
      <div className="flex border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div style={{ width: TIME_COL_W, minWidth: TIME_COL_W }} />
        {dayHeaders.map((label, i) => (
          <div
            key={i}
            className={`flex-1 text-center py-2 text-[10px] font-semibold uppercase tracking-wide
              ${i === nowColIndex
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-gray-400 dark:text-gray-500'
              }`}
          >
            {label}
          </div>
        ))}
      </div>

      {/* Scrollable grid */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="flex relative" style={{ height: HOURS.length * ROW_H }}>
          {/* Time labels column */}
          <div style={{ width: TIME_COL_W, minWidth: TIME_COL_W }} className="relative">
            {HOURS.map(h => (
              <div
                key={h}
                className="absolute right-1 text-[9px] text-gray-400 dark:text-gray-600 tabular-nums"
                style={{ top: (h - START_HOUR) * ROW_H - 5 }}
              >
                {String(h).padStart(2, '0')}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {Array.from({ length: 7 }, (_, colIndex) => {
            const weekday = COL_TO_WEEKDAY[colIndex];
            // Find schedules active on this weekday
            const daySchedules = schedules.filter(s => s.weekdays?.includes(weekday));

            return (
              <div
                key={colIndex}
                className="flex-1 relative border-l border-gray-100 dark:border-gray-800/60"
                onClick={(e) => handleColumnClick(colIndex, e)}
              >
                {/* Hour grid lines */}
                {HOURS.map(h => (
                  <div
                    key={h}
                    className="absolute left-0 right-0 border-t border-gray-100 dark:border-gray-800/60"
                    style={{ top: (h - START_HOUR) * ROW_H }}
                  />
                ))}

                {/* Schedule blocks */}
                {daySchedules.map((s) => {
                  const startH = parseHour(s.startTime);
                  const endH = s.endTime ? parseHour(s.endTime) : startH + 1;
                  const top = (startH - START_HOUR) * ROW_H;
                  const height = Math.max((endH - startH) * ROW_H, ROW_H * 0.5);
                  const globalIdx = schedules.indexOf(s);
                  const color = getScheduleColor(globalIdx);

                  return (
                    <div
                      key={s.scheduleId}
                      className={`absolute left-0.5 right-0.5 rounded-md px-1 py-0.5 cursor-pointer
                        overflow-hidden transition-opacity
                        ${color.bg} ${color.text}
                        ${!s.enabled ? 'opacity-40' : ''}
                        active:brightness-90`}
                      style={{ top, height }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEdit(s);
                      }}
                    >
                      <span className="block text-[8px] leading-tight opacity-80">
                        {s.startTime}
                      </span>
                      {height > ROW_H * 0.8 && (
                        <span className="block text-[9px] leading-tight font-medium truncate mt-0.5">
                          {s.scheduleName || s.mapName || ''}
                        </span>
                      )}
                    </div>
                  );
                })}

                {/* Current time line (only on today's column) */}
                {showTimeLine && colIndex === nowColIndex && (
                  <div
                    className="absolute left-0 right-0 h-px bg-red-500 z-10 pointer-events-none"
                    style={{ top: timeLineTop }}
                  >
                    <div className="absolute -left-1 -top-[3px] w-[7px] h-[7px] rounded-full bg-red-500" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
