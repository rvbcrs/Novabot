// TimeWheel — iOS-style scroll-wheel time picker. Replaces the raw
// <input type="time"> in the schedule form: you spin the columns instead of
// typing. Native overflow scroll + CSS scroll-snap drive it, so touch /
// trackpad / wheel / drag all work and it snaps to whole rows.
//
// The value/onChange contract is ALWAYS 24h "HH:MM" (what the DB stores). The
// time-format setting only changes the wheel's rendering: 24h shows a 0–23 hour
// column; 12h shows a 1–12 hour column plus an AM/PM column.
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useTimeFormat, to12Hour, to24Hour } from '../../utils/timeFormat';

const ROW_H = 34;        // px per row
const VISIBLE = 3;       // rows shown (center = selection, 1 peeking each side)
const PAD_ROWS = (VISIBLE - 1) / 2;

const pad2 = (n: number) => String(n).padStart(2, '0');

interface Option { key: string; label: string }

interface ColumnProps {
  options: Option[];
  selectedKey: string;
  onSelect: (key: string) => void;
  ariaLabel: string;
}

function WheelColumn({ options, selectedKey, onSelect, ariaLabel }: ColumnProps) {
  const ref = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedIndex = Math.max(0, options.findIndex(o => o.key === selectedKey));

  const scrollToIndex = useCallback((i: number, smooth: boolean) => {
    const el = ref.current;
    if (!el) return;
    programmatic.current = true;
    el.scrollTo({ top: i * ROW_H, behavior: smooth ? 'smooth' : 'auto' });
    window.setTimeout(() => { programmatic.current = false; }, smooth ? 320 : 60);
  }, []);

  // Position to the selected value on mount and whenever it changes from the
  // outside — but don't fight an in-progress user scroll.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (Math.round(el.scrollTop / ROW_H) !== selectedIndex) {
      scrollToIndex(selectedIndex, false);
    }
  }, [selectedIndex, scrollToIndex]);

  const handleScroll = useCallback(() => {
    if (programmatic.current) return;
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const idx = Math.max(0, Math.min(options.length - 1, Math.round(el.scrollTop / ROW_H)));
      const next = options[idx]?.key;
      if (next != null && next !== selectedKey) onSelect(next);
    }, 90);
  }, [options, selectedKey, onSelect]);

  useEffect(() => () => { if (settle.current) clearTimeout(settle.current); }, []);

  return (
    <div
      ref={ref}
      onScroll={handleScroll}
      role="listbox"
      aria-label={ariaLabel}
      className="tw-wheel-scroll relative overflow-y-scroll snap-y snap-mandatory"
      style={{ height: VISIBLE * ROW_H, scrollSnapType: 'y mandatory', WebkitOverflowScrolling: 'touch' }}
    >
      <div style={{ height: PAD_ROWS * ROW_H }} />
      {options.map((o, i) => {
        const dist = Math.abs(i - selectedIndex);
        const cls = dist === 0 ? 'text-white' : dist === 1 ? 'text-gray-400' : 'text-gray-600';
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => { scrollToIndex(i, true); onSelect(o.key); }}
            className={`flex w-full items-center justify-center font-mono font-semibold tabular-nums transition-colors ${cls}`}
            style={{ height: ROW_H, scrollSnapAlign: 'center', fontSize: dist === 0 ? 21 : 17 }}
          >
            {o.label}
          </button>
        );
      })}
      <div style={{ height: PAD_ROWS * ROW_H }} />
    </div>
  );
}

interface Props {
  /** "HH:MM" (24h). */
  value: string;
  onChange: (value: string) => void;
  /** Minute granularity (default 5). */
  minuteStep?: number;
}

export function TimeWheel({ value, onChange, minuteStep = 5 }: Props) {
  const { t } = useTranslation();
  const tf = useTimeFormat();

  const [hStr = '0', mStr = '0'] = (value || '0:0').split(':');
  const hour = Math.max(0, Math.min(23, parseInt(hStr, 10) || 0));
  const rawMin = Math.max(0, Math.min(59, parseInt(mStr, 10) || 0));
  const minute = Math.round(rawMin / minuteStep) * minuteStep % 60;

  const minuteOpts: Option[] = Array.from(
    { length: Math.ceil(60 / minuteStep) },
    (_, i) => { const m = i * minuteStep; return { key: pad2(m), label: pad2(m) }; },
  );
  const setMinute = (key: string) => onChange(`${pad2(hour)}:${key}`);

  if (tf === '24h') {
    const hourOpts: Option[] = Array.from({ length: 24 }, (_, i) => ({ key: pad2(i), label: pad2(i) }));
    const setHour = (key: string) => onChange(`${key}:${pad2(minute)}`);
    return (
      <Frame>
        <Col><WheelColumn options={hourOpts} selectedKey={pad2(hour)} onSelect={setHour} ariaLabel={t('schedule.timeWheel.hour')} /></Col>
        <Sep>:</Sep>
        <Col><WheelColumn options={minuteOpts} selectedKey={pad2(minute)} onSelect={setMinute} ariaLabel={t('schedule.timeWheel.minute')} /></Col>
      </Frame>
    );
  }

  // 12h mode: 1–12 hour column + AM/PM column.
  const h12 = to12Hour(hour);
  const period: 'AM' | 'PM' = hour >= 12 ? 'PM' : 'AM';
  const hourOpts: Option[] = Array.from({ length: 12 }, (_, i) => ({ key: String(i + 1), label: String(i + 1) }));
  const periodOpts: Option[] = [{ key: 'AM', label: 'AM' }, { key: 'PM', label: 'PM' }];

  const setHour12 = (key: string) => {
    const h = to24Hour(parseInt(key, 10), period);
    onChange(`${pad2(h)}:${pad2(minute)}`);
  };
  const setPeriod = (key: string) => {
    const h = to24Hour(h12, key as 'AM' | 'PM');
    onChange(`${pad2(h)}:${pad2(minute)}`);
  };

  return (
    <Frame>
      <Col><WheelColumn options={hourOpts} selectedKey={String(h12)} onSelect={setHour12} ariaLabel={t('schedule.timeWheel.hour')} /></Col>
      <Sep>:</Sep>
      <Col><WheelColumn options={minuteOpts} selectedKey={pad2(minute)} onSelect={setMinute} ariaLabel={t('schedule.timeWheel.minute')} /></Col>
      <Col><WheelColumn options={periodOpts} selectedKey={period} onSelect={setPeriod} ariaLabel={t('schedule.timeWheel.period')} /></Col>
    </Frame>
  );
}

// ── Shared chrome ────────────────────────────────────────────────────────────

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative flex items-stretch justify-center gap-1 rounded-xl border border-gray-700 bg-gray-900/60 overflow-hidden px-1"
      style={{ height: VISIBLE * ROW_H }}
    >
      {/* Selection band */}
      <div className="pointer-events-none absolute inset-x-2 top-1/2 -translate-y-1/2 rounded-lg border border-emerald-500/30 bg-emerald-400/10 z-0" style={{ height: ROW_H }} />
      {/* Fade top/bottom */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20" style={{ height: ROW_H, background: 'linear-gradient(180deg,rgba(13,17,23,.96),transparent)' }} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20" style={{ height: ROW_H, background: 'linear-gradient(0deg,rgba(13,17,23,.96),transparent)' }} />
      {children}
    </div>
  );
}

function Col({ children }: { children: React.ReactNode }) {
  return <div className="relative z-10 w-11">{children}</div>;
}

function Sep({ children }: { children: React.ReactNode }) {
  return <div className="relative z-10 flex items-center font-mono text-xl font-bold text-gray-500" style={{ paddingBottom: 2 }}>{children}</div>;
}
