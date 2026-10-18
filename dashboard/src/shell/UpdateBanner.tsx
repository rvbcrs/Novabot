import { useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getServerUpdate, applyServerUpdate, type ServerUpdateInfo } from '../api/client';
import { useDialog } from '../components/common/Dialog';

const POLL_MS = 10 * 60 * 1000; // match the admin panel; server caches 5 min
const DISMISS_KEY = 'novabot.update.dismissed';

// channel and latestBuiltAt come from the server for a :beta install; ServerUpdateInfo
// (api/client.ts) does not list them yet.
type BannerInfo = ServerUpdateInfo & { channel?: 'beta' | 'release'; latestBuiltAt?: string | null };

/**
 * Mirrors the admin panel's "Server update available" banner: polls Docker Hub
 * (via the server) for a newer rvbcrs/opennova image and shows a dismissible
 * heads-up with the update command. Dismiss is remembered per version, so a
 * NEWER release shows the banner again. Stays silent on any fetch error.
 * On the :beta channel the version number stays the same between builds, so the
 * line names the build date of the newer beta, and dismiss follows its label.
 */
export function UpdateBanner() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<BannerInfo | null>(null);
  const [dismissed, setDismissed] = useState<string>(() => {
    try { return localStorage.getItem(DISMISS_KEY) || ''; } catch { return ''; }
  });
  const [showHow, setShowHow] = useState(false);
  const dialog = useDialog();
  // 'updating' = the helper runs; the page reloads once the new version answers.
  const [phase, setPhase] = useState<'idle' | 'updating' | 'slow' | 'failed'>('idle');
  const [failure, setFailure] = useState('');
  const fromVersion = useRef('');

  useEffect(() => {
    if (phase !== 'updating') return;
    const started = Date.now();
    let wentDown = false;
    const id = setInterval(() => {
      // While the container is replaced the request fails; that is expected.
      // Back after being away counts too: a pinned tag or :beta restarts on
      // the same version number.
      getServerUpdate().then(i => {
        if (wentDown || (i.current && i.current !== fromVersion.current)) window.location.reload();
      }).catch(() => { wentDown = true; });
      if (Date.now() - started > 5 * 60_000) { setPhase('slow'); clearInterval(id); }
    }, 5000);
    return () => clearInterval(id);
  }, [phase]);

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

  const beta = info.channel === 'beta';

  const updateNow = async () => {
    const mowing = info.mowing ?? [];
    const ok = await dialog.confirm({
      title: t(beta ? 'update.confirmTitleBeta' : 'update.confirmTitle', { latest: info.latest }),
      message: mowing.length
        ? `${t('update.confirmMowing', { count: mowing.length })}\n\n${t('update.confirmBody')}`
        : t('update.confirmBody'),
      confirmLabel: t('update.updateNow'),
      variant: mowing.length ? 'warning' : 'info',
    });
    if (!ok) return;
    fromVersion.current = info.current;
    const result = await applyServerUpdate().catch(() => ({ ok: false, error: '' }));
    if (result.ok) { setPhase('updating'); return; }
    setFailure(result.error ?? '');
    setPhase('failed');
  };

  const dismiss = () => {
    setDismissed(info.latest!);
    try { localStorage.setItem(DISMISS_KEY, info.latest!); } catch { /* private mode */ }
  };

  const pushed = info.lastUpdatedAt
    ? t('update.pushed', { when: new Date(info.lastUpdatedAt).toLocaleString() })
    : '';
  const built = info.latestBuiltAt
    ? t('update.betaBuilt', { when: new Date(info.latestBuiltAt).toLocaleString() })
    : '';
  const detail = beta
    ? t('update.betaDetail') + built
    : t('update.detail', { current: info.current, latest: info.latest }) + pushed;

  return (
    <div className="px-4 py-2 bg-violet-900/40 border-b border-violet-700/60 text-violet-100 text-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <ArrowUpCircle className="w-4 h-4 flex-shrink-0" />
        <span className="font-semibold">{t('update.title')}</span>
        <span className="text-violet-200/80">{detail}</span>
        <div className="ml-auto flex items-center gap-2">
          {info.selfUpdate?.available && phase !== 'updating' && (
            <button
              onClick={updateNow}
              className="px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
            >
              {t('update.updateNow')}
            </button>
          )}
          {/* The terminal route only where the button cannot do it. */}
          {!info.selfUpdate?.available && (
            <button
              onClick={() => setShowHow(v => !v)}
              className="px-2.5 py-1 rounded-md bg-violet-500/40 hover:bg-violet-500/60 text-white text-xs font-medium transition-colors"
            >
              {t('update.howTo')}
            </button>
          )}
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
      {phase !== 'idle' && (
        <p className={`mt-1 pl-6 text-xs ${phase === 'failed' ? 'text-red-300' : 'text-violet-200/90'}`}>
          {phase === 'updating' ? t('update.updating') : phase === 'slow' ? t('update.slow') : `${t('update.failed')}${failure ? `: ${failure}` : ''}`}
        </p>
      )}
      {showHow && (
        <div className="mt-2 pl-6">
          <p className="text-xs text-violet-200/80 mb-1">{t('update.instructions')}</p>
          {!info.selfUpdate?.available && (
            <p className="text-xs text-violet-200/70 mb-1">{t('update.enableButton')}</p>
          )}
          <pre className="text-[11px] font-mono bg-black/40 border border-violet-700/40 rounded-md px-3 py-2 text-emerald-300 overflow-x-auto">docker compose pull
docker compose up -d</pre>
        </div>
      )}
    </div>
  );
}
