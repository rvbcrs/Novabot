import { useEffect, useState } from 'react';
import { ArrowUpCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getServerUpdate, type ServerUpdateInfo } from '../api/client';

const POLL_MS = 10 * 60 * 1000; // match the admin panel; server caches 5 min
const DISMISS_KEY = 'novabot.update.dismissed';

/**
 * Mirrors the admin panel's "Server update available" banner: polls Docker Hub
 * (via the server) for a newer rvbcrs/opennova image and shows a dismissible
 * heads-up with the update command. Dismiss is remembered per version, so a
 * NEWER release shows the banner again. Stays silent on any fetch error.
 */
export function UpdateBanner() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<ServerUpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState<string>(() => {
    try { return localStorage.getItem(DISMISS_KEY) || ''; } catch { return ''; }
  });
  const [showHow, setShowHow] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      getServerUpdate()
        .then(i => { if (alive) setInfo(i); })
        .catch(() => { /* offline / hub fetch failed — keep quiet */ });
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!info || !info.updateAvailable || !info.latest) return null;
  if (info.latest === dismissed) return null;

  const dismiss = () => {
    setDismissed(info.latest!);
    try { localStorage.setItem(DISMISS_KEY, info.latest!); } catch { /* private mode */ }
  };

  const pushed = info.lastUpdatedAt
    ? t('update.pushed', { when: new Date(info.lastUpdatedAt).toLocaleString() })
    : '';
  const detail = t('update.detail', { current: info.current, latest: info.latest }) + pushed;

  return (
    <div className="px-4 py-2 bg-violet-900/40 border-b border-violet-700/60 text-violet-100 text-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <ArrowUpCircle className="w-4 h-4 flex-shrink-0" />
        <span className="font-semibold">{t('update.title')}</span>
        <span className="text-violet-200/80">{detail}</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setShowHow(v => !v)}
            className="px-2.5 py-1 rounded-md bg-violet-500/40 hover:bg-violet-500/60 text-white text-xs font-medium transition-colors"
          >
            {t('update.howTo')}
          </button>
          <button
            onClick={dismiss}
            title={t('update.dismiss')}
            aria-label={t('update.dismiss')}
            className="p-1 rounded-md text-violet-200/70 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      {showHow && (
        <div className="mt-2 pl-6">
          <p className="text-xs text-violet-200/80 mb-1">{t('update.instructions')}</p>
          <pre className="text-[11px] font-mono bg-black/40 border border-violet-700/40 rounded-md px-3 py-2 text-emerald-300 overflow-x-auto">docker compose pull
docker compose up -d</pre>
        </div>
      )}
    </div>
  );
}
