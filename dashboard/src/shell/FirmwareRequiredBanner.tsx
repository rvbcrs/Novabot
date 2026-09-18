import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchFirmwareAdvisory, type FirmwareAdvisoryDto } from '../api/client';

const POLL_MS = 10 * 60_000;

/**
 * The custom build this mower runs was withdrawn (manifest `withdrawn`):
 * it has a bug bad enough that staying on it is not an option. Not
 * dismissible on purpose. The server has already fetched the target
 * build, so the admin's Firmware tab can flash it right away.
 */
export function FirmwareRequiredBanner({ sn }: { sn: string | null }) {
  const { t } = useTranslation();
  const [adv, setAdv] = useState<FirmwareAdvisoryDto | null>(null);

  useEffect(() => {
    if (!sn) { setAdv(null); return; }
    let alive = true;
    const load = () => {
      fetchFirmwareAdvisory(sn)
        .then(a => { if (alive) setAdv(a); })
        .catch(() => { /* offline or old server: stay quiet */ });
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [sn]);

  if (!adv?.required || !adv.target) return null;

  return (
    <div className="px-4 py-2 bg-red-900/50 border-b border-red-700/70 text-red-100 text-sm flex items-center gap-3">
      <ShieldAlert className="w-4 h-4 flex-shrink-0" />
      <span className="flex-1">
        <strong>{t('firmwareRequired.title', { current: adv.current })}</strong>{' '}
        {t('firmwareRequired.body', { reason: adv.reason, target: adv.target.version })}
        {!adv.target.downloaded && ` ${t('firmwareRequired.downloading')}`}
      </span>
      <a href="/admin#firmware" className="px-3 py-1 rounded bg-red-600 hover:bg-red-500 text-white text-xs font-medium whitespace-nowrap">
        {t('firmwareRequired.action')}
      </a>
    </div>
  );
}
