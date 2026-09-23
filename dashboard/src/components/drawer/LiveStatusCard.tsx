import { useEffect, useState } from 'react';
import { Radio, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchLoraStatus, type LoraStatus } from '../../api/client';

interface Props {
  sn: string | null;
}

export function LiveStatusCard({ sn }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<LoraStatus | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sn) {
      setData(null); setMissing(false); setError(null);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const fresh = await fetchLoraStatus(sn!);
        if (!cancelled) {
          setData(fresh);
          setMissing(fresh === null);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    load();
    const id = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [sn]);

  if (!sn) return null;

  return (
    <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 mb-3">
      <h3 className="text-xs font-semibold text-zinc-300 mb-2">{t('drawer.live.title')}</h3>

      {error && <p className="text-xs text-red-400">{t('common.failed')}: {error}</p>}
      {!error && missing && <p className="text-xs text-zinc-500">{t('drawer.live.noLoraCache')}</p>}
      {!error && !missing && data && (
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-zinc-400">
              <Radio className="w-3 h-3" /> {t('drawer.live.pair')}
            </span>
            <span className="text-zinc-300 font-mono">
              {data.pair.address ?? '—'} · ch{data.pair.channel ?? '—'}
            </span>
          </div>
          {data.peer.sn && (
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-zinc-500 font-mono pl-4">{t('drawer.live.peer')}: {data.peer.sn}</span>
              <span className="text-zinc-500 font-mono">
                {data.peer.address ?? '—'} · ch{data.peer.channel ?? '—'}
              </span>
            </div>
          )}
          <div className={`flex items-center justify-between pt-1 border-t border-zinc-800 ${data.drift ? 'text-amber-400' : 'text-emerald-400'}`}>
            <span className="inline-flex items-center gap-1.5">
              {data.drift ? <AlertTriangle className="w-3 h-3" /> : <Radio className="w-3 h-3" />}
              {data.drift ? t('drawer.live.drift') : t('drawer.live.inSync')}
            </span>
            <span>{data.drift ? t('drawer.live.mismatch') : t('drawer.live.matching')}</span>
          </div>
        </div>
      )}
      {!error && !missing && !data && <p className="text-xs text-zinc-500">{t('common.loading')}</p>}
    </div>
  );
}
