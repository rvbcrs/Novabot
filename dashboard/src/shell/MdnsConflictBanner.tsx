import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchMdnsConflict, type MdnsConflict } from '../api/client';

const POLL_MS = 30_000;

/**
 * Warns when a SECOND OpenNova server is advertising the same opennovabot.local
 * on the LAN (e.g. a local `npm run dev` box, or a stray `docker compose up`).
 * Mowers resolve mDNS before DNS (mqtt.lfibot.com), so a competitor can silently
 * steal them and they go offline on this dashboard. Behaviour is NOT changed —
 * this is just a loud, visible heads-up. See server/src/services/mdnsAdvertiser.ts.
 */
export function MdnsConflictBanner() {
  const { t } = useTranslation();
  const [conflict, setConflict] = useState<MdnsConflict | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchMdnsConflict()
        .then((c) => { if (alive) setConflict(c); })
        .catch(() => { /* endpoint missing / offline — ignore */ });
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const competitors = conflict?.competitors ?? [];
  if (competitors.length === 0) return null;

  const ips = competitors.map((c) => c.ip).join(', ');

  return (
    <div className="px-4 py-2 bg-red-900/40 border-b border-red-700/60 text-red-100 text-sm flex items-center gap-2">
      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
      <span className="flex-1">
        {t('mower.mdnsConflict.banner', {
          ips,
          self: conflict?.self ?? '?',
          defaultValue:
            'A second OpenNova server was detected at {{ips}} advertising opennovabot.local. ' +
            'Mowers can (accidentally) connect to it instead of this server ({{self}}). ' +
            'Running npm run dev or docker locally? Stop it, or the mowers will follow that server.',
        })}
      </span>
    </div>
  );
}
