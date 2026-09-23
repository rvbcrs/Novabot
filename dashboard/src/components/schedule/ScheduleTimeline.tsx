import { useEffect, useState } from 'react';
import { CalendarClock, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Schedule } from '../../types';
import { fetchSchedules } from '../../api/client';
import { useWeekStart, weekdayOrder } from '../../utils/weekStart';
import { useTimeFormat, formatTime, formatHour } from '../../utils/timeFormat';

interface Props {
  sn: string;
  /** A block was clicked: open that schedule for editing (Scheduler above). */
  onSelect?: (scheduleId: string) => void;
}

// Stored weekday convention is 0=Sunday (JS getDay, server scheduleRunner). The
// column order is derived from the week-start setting; labels come from i18n.
const HOUR_PX = 22; // px per hour → 528px for the 24h grid
const AXIS_PX = 56; // width of the hour-label column
// Dimmed "night" bands so the active daytime stands out.
const NIGHT_END = 6;    // 00:00–06:00 dimmed
const NIGHT_START = 22; // 22:00–24:00 dimmed

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

// Curated accent palette (instead of random HSL) — stable per schedule id.
interface Accent { bar: string; bg: string; text: string; border: string }
const PALETTE: Accent[] = [
  { bar: '#34d399', bg: 'linear-gradient(180deg,rgba(52,217,154,.22),rgba(52,217,154,.10))', text: '#bff3dd', border: 'rgba(52,217,154,.35)' },
  { bar: '#38bdf8', bg: 'linear-gradient(180deg,rgba(56,189,248,.22),rgba(56,189,248,.10))', text: '#cdeafe', border: 'rgba(56,189,248,.35)' },
  { bar: '#f59e0b', bg: 'linear-gradient(180deg,rgba(245,158,11,.22),rgba(245,158,11,.10))', text: '#fde9c8', border: 'rgba(245,158,11,.35)' },
  { bar: '#a78bfa', bg: 'linear-gradient(180deg,rgba(167,139,250,.22),rgba(167,139,250,.10))', text: '#e4dbfe', border: 'rgba(167,139,250,.35)' },
  { bar: '#fb7185', bg: 'linear-gradient(180deg,rgba(251,113,133,.22),rgba(251,113,133,.10))', text: '#fecdd3', border: 'rgba(251,113,133,.35)' },
];
function accentForId(id: string): Accent {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function ScheduleTimeline({ sn, onSelect }: Props) {
  const { t } = useTranslation();
  const weekStart = useWeekStart();
  const order = weekdayOrder(weekStart);
  const weekdayLabels = t('schedule.weekdays', { returnObjects: true }) as string[];
  const timeFormat = useTimeFormat();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Re-render every 30s so the "now" line keeps moving even without edits.
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const list = await fetchSchedules(sn);
        if (!cancelled) { setSchedules(list); setError(null); }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const id = setInterval(load, 5000);
    const tickId = setInterval(() => setTick(x => x + 1), 30000);
    return () => { cancelled = true; clearInterval(id); clearInterval(tickId); };
  }, [sn]);

  if (loading) {
    return (
      <div className="rounded-2xl border border-gray-700/60 bg-gray-900/50 p-4 flex items-center gap-2 text-zinc-500 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />{t('schedule.timeline.loading')}
      </div>
    );
  }
  if (error) {
    return <div className="rounded-2xl border border-red-700/40 bg-red-900/10 p-4 text-red-400 text-sm">{t('schedule.timeline.error')}: {error}</div>;
  }

  const enabled = schedules.filter(s => s.enabled);

  // Nothing to plot → a compact empty card instead of a half-screen empty grid.
  if (enabled.length === 0) {
    return (
      <div className="rounded-2xl border border-gray-700/60 bg-gray-900/50 p-4">
        <div className="flex items-center gap-2 mb-3">
          <CalendarClock className="w-4 h-4 text-emerald-400" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400">{t('schedule.timeline.title')}</span>
        </div>
        <div className="flex flex-col items-center justify-center gap-2.5 py-8 text-center">
          <span className="grid place-items-center w-11 h-11 rounded-2xl bg-gray-800/60 border border-gray-700/60 text-gray-600">
            <CalendarClock className="w-5 h-5" />
          </span>
          <span className="text-sm text-gray-500">{t('schedule.timeline.empty')}</span>
        </div>
      </div>
    );
  }

  // Current weekday (0=Mon..6=Sun) + minutes-into-day for the "now" line.
  const now = new Date();
  const todayIdx = order.indexOf(now.getDay()); // column where "today" sits
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowTop = (nowMin / 60) * HOUR_PX;
  const nowLabel = formatTime(`${pad2(now.getHours())}:${pad2(now.getMinutes())}`, timeFormat);

  const gridCols = `${AXIS_PX}px repeat(7, minmax(0, 1fr))`;
  const bodyH = 24 * HOUR_PX;

  return (
    <div
      className="relative rounded-2xl border border-gray-700/60 p-4 overflow-hidden"
      style={{ background: 'radial-gradient(540px 220px at 8% -8%, rgba(52,217,154,.08), transparent 60%), linear-gradient(180deg, rgba(17,24,39,.7), rgba(9,12,14,.55))' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <CalendarClock className="w-4 h-4 text-emerald-400" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400">{t('schedule.timeline.title')}</span>
        </div>
        {enabled.length > 0 && (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-gray-300 px-2 py-0.5 rounded-lg bg-gray-800/50 border border-gray-700/60">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            {t('schedule.timeline.active', { count: enabled.length, defaultValue: '{{count}} active' })}
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[680px]">
          {/* Day headers */}
          <div className="grid pb-2" style={{ gridTemplateColumns: gridCols }}>
            <div />
            {order.map((stored, col) => (
              <div key={stored} className="flex flex-col items-center gap-0.5">
                <span className={`text-[11px] font-semibold ${col === todayIdx ? 'text-emerald-400' : 'text-gray-400'}`}>{weekdayLabels[stored]}</span>
                {col === todayIdx && (
                  <span className="w-1 h-1 rounded-full bg-emerald-400" style={{ boxShadow: '0 0 8px #34d399' }} />
                )}
              </div>
            ))}
          </div>

          {/* Body: hour axis + 7 day columns, one relative grid so the now-line
              can span the columns and everything aligns to the pixel. */}
          <div className="relative grid" style={{ gridTemplateColumns: gridCols, height: bodyH }}>
            {/* Hour axis */}
            <div className="relative">
              {Array.from({ length: 24 }).map((_, h) => (
                <div
                  key={h}
                  className={`absolute right-2 font-mono text-[10px] ${h >= NIGHT_END && h < NIGHT_START ? 'text-gray-400' : 'text-gray-600'}`}
                  style={{ top: h * HOUR_PX - 6 }}
                >
                  {formatHour(h, timeFormat)}
                </div>
              ))}
            </div>

            {/* Day columns */}
            {order.map((stored, dayIdx) => (
              <div
                key={stored}
                className="relative border-l border-white/[0.05]"
                style={{ background: dayIdx === todayIdx ? 'linear-gradient(180deg, rgba(52,217,154,.06), rgba(52,217,154,.02))' : undefined }}
              >
                {/* Hour lines */}
                {Array.from({ length: 24 }).map((_, h) => (
                  <div
                    key={h}
                    className="absolute left-0 right-0"
                    style={{ top: h * HOUR_PX, height: 1, background: h % 6 === 0 ? 'rgba(255,255,255,.09)' : 'rgba(255,255,255,.045)' }}
                  />
                ))}
                {/* Night dimming */}
                <div className="absolute left-0 right-0" style={{ top: 0, height: NIGHT_END * HOUR_PX, background: 'rgba(0,0,0,.28)' }} />
                <div className="absolute left-0 right-0" style={{ top: NIGHT_START * HOUR_PX, height: (24 - NIGHT_START) * HOUR_PX, background: 'rgba(0,0,0,.28)' }} />

                {/* Schedule blocks */}
                {enabled.flatMap(s => {
                  if (!s.weekdays.includes(stored)) return [];
                  const start = timeToMinutes(s.startTime);
                  const end = s.endTime ? timeToMinutes(s.endTime) : Math.min(start + 60, 24 * 60);
                  if (end <= start) return [];
                  const top = (start / 60) * HOUR_PX;
                  const height = ((end - start) / 60) * HOUR_PX;
                  const a = accentForId(s.scheduleId);
                  const compact = height < 30;
                  const timeRange = `${formatTime(s.startTime, timeFormat)}${s.endTime ? `–${formatTime(s.endTime, timeFormat)}` : ''}`;
                  const label = s.scheduleName ?? formatTime(s.startTime, timeFormat);
                  return [
                    <div
                      key={s.scheduleId}
                      role={onSelect ? 'button' : undefined}
                      onClick={onSelect ? () => onSelect(s.scheduleId) : undefined}
                      title={`${s.scheduleName ?? t('devices.schedule')} ${timeRange}${s.mapName ? ` · ${s.mapName}` : ''} · ${s.cuttingHeight >= 20 ? s.cuttingHeight / 10 : s.cuttingHeight} cm`}
                      className={`absolute rounded-lg overflow-hidden border transition-transform hover:-translate-y-px ${onSelect ? 'cursor-pointer' : ''}`}
                      style={{ top: top + 1, height: height - 2, left: 4, right: 4, background: a.bg, borderColor: a.border, color: a.text }}
                    >
                      <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg" style={{ background: a.bar }} />
                      <div className="pl-2.5 pr-1.5 py-0.5">
                        <div className="text-[11px] font-semibold leading-tight truncate">{label}</div>
                        {!compact && (
                          <div className="font-mono text-[9px] leading-tight mt-0.5 opacity-85">
                            {timeRange}
                          </div>
                        )}
                      </div>
                    </div>,
                  ];
                })}
              </div>
            ))}

            {/* Now line — spans the day columns, badge sits in the axis. */}
            <div className="absolute left-0 right-0 pointer-events-none z-10" style={{ top: nowTop }}>
              <div
                className="absolute font-mono text-[10px] font-semibold rounded px-1.5"
                style={{ left: 6, top: -8, color: '#04130d', background: '#34d399' }}
              >
                {nowLabel}
              </div>
              <div className="absolute rounded-full" style={{ left: AXIS_PX - 3, top: -3.5, width: 7, height: 7, background: '#34d399', boxShadow: '0 0 9px #34d399' }} />
              <div className="absolute" style={{ left: AXIS_PX, right: 0, height: 1.5, background: 'linear-gradient(90deg,#34d399,rgba(52,217,154,.22))' }} />
            </div>
          </div>
        </div>
      </div>

      {/* Legend / empty state */}
      {enabled.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-3 text-[11px] text-gray-400">
          {enabled.slice(0, 6).map(s => {
            const a = accentForId(s.scheduleId);
            return (
              <span key={s.scheduleId} className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: a.bar }} />
                {s.scheduleName ?? `${formatTime(s.startTime, timeFormat)}${s.endTime ? `–${formatTime(s.endTime, timeFormat)}` : ''}`}
              </span>
            );
          })}
          {enabled.length > 6 && <span className="text-gray-600">+{enabled.length - 6}</span>}
        </div>
      ) : (
        <div className="mt-3 text-zinc-500 text-xs">{t('schedule.timeline.empty')}</div>
      )}
    </div>
  );
}
