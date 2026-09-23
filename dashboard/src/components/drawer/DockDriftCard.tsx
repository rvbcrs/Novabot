import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchDockDrift, type DockDriftDto } from '../../api/client';

/**
 * Where the mower parks on the charger, day by day. The station does not
 * move, so with RTK Fixed this must repeat; a walk means the station's
 * antenna or the map frame moved and the zones no longer lie where they
 * were driven. Same numbers as the "position on the dock" diagnosis step.
 */
const WARN_CM = 5;
const FAIL_CM = 15;

const COLOR = { ok: '#34d399', warn: '#fbbf24', fail: '#f87171', unknown: '#71717a' } as const;

export function DockDriftCard({ sn }: { sn: string | null }) {
  const { t } = useTranslation();
  const [data, setData] = useState<DockDriftDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sn) return;
    let cancelled = false;
    async function load() {
      try {
        const fresh = await fetchDockDrift(sn as string);
        if (!cancelled) { setData(fresh); setError(null); }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [sn]);

  const title = <h3 className="text-xs font-semibold text-zinc-300 mb-2">{t('drawer.dockDrift.title')}</h3>;
  if (!sn) return null;
  if (error) {
    return <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 mb-3">{title}<p className="text-xs text-red-400">{t('common.failedToLoad')}: {error}</p></div>;
  }
  if (!data) {
    return <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 mb-3">{title}<p className="text-xs text-zinc-500">{t('common.loading')}</p></div>;
  }
  if (data.status === 'unknown' || !data.latest || !data.referenceAt) {
    return (
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 mb-3">
        {title}
        <p className="text-xs text-zinc-500">{t('drawer.dockDrift.tooFew')}</p>
      </div>
    );
  }

  const cm = (m: number) => Math.round(m * 100);
  const latestCm = cm(data.latest.dist);
  const color = COLOR[data.status];
  const days = data.daily;
  const maxCm = Math.max(FAIL_CM + 5, ...days.map(d => cm(d.dist)));

  // One bar per day; the two thresholds as faint lines behind them.
  const W = 240, H = 48;
  const barW = Math.max(2, Math.min(10, (W / Math.max(days.length, 1)) - 1));
  const gap = days.length > 1 ? (W - barW) / (days.length - 1) : 0;
  const yOf = (c: number) => H - (c / maxCm) * H;

  return (
    <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 mb-3">
      <div className="flex items-center justify-between">
        {title}
        <span className="text-xs font-mono mb-2" style={{ color }}>{latestCm} cm</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-12" preserveAspectRatio="none" aria-hidden>
        <line x1={0} x2={W} y1={yOf(WARN_CM)} y2={yOf(WARN_CM)} stroke={COLOR.warn} strokeWidth="0.5" opacity="0.5" vectorEffect="non-scaling-stroke" />
        <line x1={0} x2={W} y1={yOf(FAIL_CM)} y2={yOf(FAIL_CM)} stroke={COLOR.fail} strokeWidth="0.5" opacity="0.5" vectorEffect="non-scaling-stroke" />
        {days.map((d, i) => {
          const c = cm(d.dist);
          const fill = c >= FAIL_CM ? COLOR.fail : c >= WARN_CM ? COLOR.warn : COLOR.ok;
          return <rect key={d.ts} x={i * gap} y={yOf(c)} width={barW} height={H - yOf(c)} fill={fill} opacity="0.9"><title>{`${d.ts}: ${c} cm`}</title></rect>;
        })}
      </svg>
      <div className="flex items-center justify-between mt-1 text-[10px] text-zinc-500">
        <span>{t('drawer.dockDrift.since', { date: data.referenceAt.slice(0, 10) })}</span>
        <span>{days[0]?.ts} … {days[days.length - 1]?.ts}</span>
      </div>
      <p className="text-[11px] mt-1.5" style={{ color }}>
        {data.status === 'ok' ? t('drawer.dockDrift.ok') : t('drawer.dockDrift.moved', { cm: latestCm })}
        {data.latest.gpsDist != null && data.status !== 'ok' && ` ${t('drawer.dockDrift.gps', { cm: cm(data.latest.gpsDist) })}`}
      </p>
    </div>
  );
}
