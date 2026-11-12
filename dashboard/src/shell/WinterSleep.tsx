/**
 * Winter sleep in the dashboard: a quiet banner and falling snow while the
 * active mower sleeps (no schedule starts; server services/hibernation.ts).
 * The snow never takes a click and stays away with prefers-reduced-motion.
 */
import { useEffect, useMemo, useState } from 'react';
import { Snowflake, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchHibernation, saveHibernation, type Hibernation } from '../api/client';

/** The active mower's winter sleep; follows the settings card and wakes up by date. */
function useHibernation(sn: string | null): Hibernation | null {
  const [state, setState] = useState<{ sn: string; value: Hibernation } | null>(null);
  useEffect(() => {
    if (!sn) return;
    let alive = true;
    const load = () => { fetchHibernation(sn).then((v) => { if (alive) setState({ sn, value: v }); }, () => { /* keep the last */ }); };
    load();
    const onChange = (e: Event) => {
      const d = (e as CustomEvent<{ sn: string; state: Hibernation }>).detail;
      if (d?.sn === sn) setState({ sn, value: d.state });
    };
    window.addEventListener('novabot:hibernation', onChange);
    const timer = setInterval(load, 5 * 60_000); // a wake date ends it on the server
    return () => { alive = false; window.removeEventListener('novabot:hibernation', onChange); clearInterval(timer); };
  }, [sn]);
  return sn && state?.sn === sn ? state.value : null;
}

/** "1 March" style, in the dashboard's language. */
function formatWakeDate(iso: string, lang: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(lang, { day: 'numeric', month: 'long' });
}

// Deterministic so a re-render does not reshuffle the flakes. Three depths.
function flakes(): Array<React.CSSProperties> {
  const out: Array<React.CSSProperties> = [];
  const layers = [
    { n: 28, size: [2.5, 4], fall: [16, 24], alpha: 0.55, drift: 24 },
    { n: 16, size: [4, 6.5], fall: [11, 16], alpha: 0.8, drift: 40 },
    { n: 7, size: [7, 10], fall: [7, 10], alpha: 0.95, drift: 60 },
  ];
  let seed = 7;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  for (const l of layers) {
    for (let i = 0; i < l.n; i++) {
      const size = l.size[0] + rnd() * (l.size[1] - l.size[0]);
      const fall = l.fall[0] + rnd() * (l.fall[1] - l.fall[0]);
      out.push({
        left: `${rnd() * 100}%`, width: size, height: size,
        ['--fall' as string]: `${fall.toFixed(1)}s`,
        ['--delay' as string]: `${(-rnd() * fall).toFixed(1)}s`,
        ['--alpha' as string]: String(l.alpha),
        ['--drift' as string]: `${((rnd() - 0.5) * 2 * l.drift).toFixed(0)}px`,
      });
    }
  }
  return out;
}

export function WinterSleep({ sn }: { sn: string | null }) {
  const { t, i18n } = useTranslation();
  const state = useHibernation(sn);
  const styles = useMemo(flakes, []);
  const [waking, setWaking] = useState(false);
  if (!sn || !state?.enabled) return null;

  const wake = async () => {
    setWaking(true);
    try { await saveHibernation(sn, false, null); } finally { setWaking(false); }
  };

  return (
    <>
      <div className="winter-snow" aria-hidden="true">
        {styles.map((s, i) => <span key={i} className="winter-flake" style={s} />)}
      </div>
      <div className="mx-4 mt-3 flex items-center gap-3 rounded-xl border border-sky-200/20 bg-sky-950/40 px-4 py-2.5">
        <Snowflake className="w-4 h-4 text-sky-200 flex-shrink-0" />
        <p className="flex-1 text-sm text-sky-100">
          {state.until
            ? t('winterSleep.bannerUntil', 'Winter sleep until {{date}}. No schedule runs; you can still mow by hand.', { date: formatWakeDate(state.until, i18n.language) })
            : t('winterSleep.banner', 'Winter sleep. No schedule runs; you can still mow by hand.')}
        </p>
        <button
          onClick={() => void wake()}
          disabled={waking}
          className="inline-flex items-center gap-1.5 rounded-lg border border-sky-200/30 px-3 py-1.5 text-xs font-medium text-sky-100 hover:bg-sky-200/10 disabled:opacity-50 transition-colors"
        >
          {waking && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {t('winterSleep.wake', 'Wake up')}
        </button>
      </div>
    </>
  );
}
