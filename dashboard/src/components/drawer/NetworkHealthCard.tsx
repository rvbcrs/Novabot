import { useEffect, useState } from 'react';
import { Activity, Wifi, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchSystemHealth, type SystemHealth } from '../../api/client';

// Suppress unused import warning — Activity is available for future use
void Activity;

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

export function NetworkHealthCard() {
  const { t } = useTranslation();
  const [data, setData] = useState<SystemHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const fresh = await fetchSystemHealth();
        if (!cancelled) {
          setData(fresh);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    load();
    const id = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (error) {
    return (
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 mb-3">
        <h3 className="text-xs font-semibold text-zinc-300 mb-2">{t('drawer.network.title')}</h3>
        <p className="text-xs text-red-400">{t('common.failedToLoad')}: {error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 mb-3">
        <h3 className="text-xs font-semibold text-zinc-300 mb-2">{t('drawer.network.title')}</h3>
        <p className="text-xs text-zinc-500">{t('common.loading')}</p>
      </div>
    );
  }

  return (
    <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 mb-3">
      <h3 className="text-xs font-semibold text-zinc-300 mb-2">{t('drawer.network.title')}</h3>

      <div className="space-y-1.5 text-xs">
        <Row icon={Wifi} label={t('drawer.network.mdns')}
             value={data.mdns.running ? t('drawer.network.running') : t('drawer.network.stopped')}
             ok={data.mdns.running} />
        <Row icon={Server} label={t('drawer.network.serverUptime')}
             value={fmtUptime(data.server.uptimeSec)}
             ok={true} />
        <div className="pt-1 border-t border-zinc-800">
          <p className="text-[10px] text-zinc-500 mb-1">{t('drawer.network.mowers')}</p>
          {data.mowers.length === 0 ? (
            <p className="text-zinc-500">{t('drawer.network.noneRegistered')}</p>
          ) : data.mowers.map(m => (
            <div key={m.sn} className="flex items-center justify-between text-[11px] py-0.5">
              <span className="font-mono text-zinc-400">{m.sn}</span>
              <span className={m.online ? 'text-emerald-400' : 'text-zinc-600'}>
                {m.online ? `${m.sensorKeys} sensors` : t('common.offline')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ icon: Icon, label, value, ok }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="inline-flex items-center gap-1.5 text-zinc-400">
        <Icon className="w-3 h-3" />
        {label}
      </span>
      <span className={ok ? 'text-emerald-400' : 'text-red-400'}>{value}</span>
    </div>
  );
}
