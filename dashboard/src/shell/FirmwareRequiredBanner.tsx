import { useEffect, useState } from 'react';
import { ArrowUpCircle, ShieldAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchFirmwareAdvisory, fetchFirmwareUpdate, triggerOta, type FirmwareAdvisoryDto } from '../api/client';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { betaFirmwareWarningLines } from '../utils/betaFirmware';
import { otaFinished, type OtaProgress } from '../hooks/useDevices';
import { useNow, otaElapsed, useOtaPhaseLabel } from '../utils/otaPhase';

const POLL_MS = 10 * 60_000;
const DISMISS_KEY = 'novabot.fwUpdate.dismissed.';

function dismissedVersion(sn: string): string {
  try { return localStorage.getItem(DISMISS_KEY + sn) || ''; } catch { return ''; }
}

/**
 * The custom build this mower runs was withdrawn (manifest `withdrawn`):
 * it has a bug bad enough that staying on it is not an option. One place,
 * not dismissible, and the update starts from here: the server has already
 * fetched the target build. Progress shows in the same bar, so nothing else
 * has to open. Controls stay usable throughout; a mower is never locked out
 * of Stop or Go home for an update.
 *
 * A newer build that is not a must shows in the same place as a calm,
 * dismissible notice (per version). Its build is fetched into this server
 * only when the user starts the update.
 */
export function FirmwareRequiredBanner({ sn, charging, otaProgress }: {
  sn: string | null;
  charging: boolean;
  otaProgress: OtaProgress | undefined;
}) {
  const { t } = useTranslation();
  const [adv, setAdv] = useState<FirmwareAdvisoryDto | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [state, setState] = useState<'idle' | 'fetching' | 'sending' | 'started' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [, setDismissTick] = useState(0);

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
  useEffect(() => { setState('idle'); setError(null); }, [sn]);
  const session = otaProgress?.session;
  const phaseLabel = useOtaPhaseLabel(session);
  const elapsed = otaElapsed(useNow(!!session), session?.since);

  if (!sn || !adv?.target) return null;
  const target = adv.target;
  const required = adv.required;
  if (!required && (!adv.updateAvailable || (state === 'idle' && dismissedVersion(sn) === target.version))) return null;
  const pct = otaProgress?.percentage ?? null;
  const flashing = session
    ? !otaFinished(otaProgress)
    : state === 'started' || (otaProgress != null && pct != null && pct < 100);
  const pulse = session && (session.phase === 'awaiting-reboot' || session.phase === 'rebooting' || session.phase === 'back');

  const start = async () => {
    setConfirm(false);
    let versionId = target.versionId;
    if (versionId == null) {
      setState('fetching');
      const f = await fetchFirmwareUpdate(sn).catch(() => null);
      versionId = f?.target?.versionId ?? null;
      if (!f || versionId == null) { setState('error'); setError(t('firmwareUpdate.fetchFailed')); return; }
      setAdv(f);
    }
    setState('sending');
    const r = await triggerOta(sn, versionId, true).catch(() => ({ ok: false, error: 'network' } as { ok: boolean; error?: string; detail?: string }));
    if (r.ok) { setState('started'); setError(null); }
    else { setState('error'); setError(r.detail || r.error || 'failed'); }
  };

  const progressText = <>
    {session && ` ${phaseLabel}${pulse ? ` ${elapsed}` : ''}`}
    {!session && flashing && pct != null && ` ${t('firmwareRequired.progress', { pct: Math.round(pct) })}`}
    {!session && flashing && pct == null && ` ${t('firmwareRequired.started')}`}
  </>;
  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY + sn, target.version); } catch { /* private mode */ }
    setDismissTick(n => n + 1);
  };

  return (
    <>
      {!required ? (
        <div className="px-4 py-2 bg-violet-900/40 border-b border-violet-700/60 text-violet-100 text-sm flex items-start gap-2">
          <ArrowUpCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span className="flex-1 min-w-0">
            <span className="font-semibold">{t('firmwareUpdate.title', { target: target.version })}</span>{' '}
            <span className="text-violet-200/80">{t('firmwareUpdate.detail', { current: adv.current })}</span>
            {progressText}
            {state === 'fetching' && <span className="block text-violet-200/90 text-xs mt-0.5">{t('firmwareUpdate.fetching')}</span>}
            {state === 'error' && error && <span className="block text-red-300 text-xs mt-0.5">{error}</span>}
          </span>
          {!flashing && (
            <button
              onClick={() => setConfirm(true)}
              disabled={state === 'fetching' || state === 'sending'}
              className="px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-medium whitespace-nowrap transition-colors"
            >
              {state === 'fetching' || state === 'sending' ? '…' : t('firmwareUpdate.action')}
            </button>
          )}
          {!flashing && state !== 'fetching' && state !== 'sending' && (
            <button
              onClick={dismiss}
              title={t('update.dismiss')}
              aria-label={t('update.dismiss')}
              className="p-1 rounded-md text-violet-200/70 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      ) : (
      <div className="px-4 py-2 bg-red-900/50 border-b border-red-700/70 text-red-100 text-sm flex items-start gap-3">
        <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span className="flex-1 min-w-0">
          <strong>{t('firmwareRequired.title', { current: adv.current })}</strong>{' '}
          {t('firmwareRequired.body', { reason: adv.reason, target: target.version })}
          {progressText}
          {state === 'error' && error && <span className="block text-red-300 text-xs mt-0.5">{error}</span>}
          {!target.downloaded && <span className="block text-red-300 text-xs mt-0.5">{t('firmwareRequired.downloading')}</span>}
        </span>
        {!flashing && (
          <button
            onClick={() => setConfirm(true)}
            disabled={!target.downloaded || target.versionId == null || state === 'sending'}
            className="px-3 py-1 rounded bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-medium whitespace-nowrap"
          >
            {state === 'sending' || state === 'fetching' ? '…' : t('firmwareRequired.action')}
          </button>
        )}
      </div>
      )}
      <ConfirmDialog
        open={confirm}
        title={t('firmwareRequired.confirmTitle', { target: target.version })}
        message={[
          ...betaFirmwareWarningLines(),
          '',
          t('firmwareRequired.confirmBody'),
          charging ? '' : t('firmwareRequired.confirmDock'),
        ].filter(Boolean).join('\n')}
        confirmLabel={t('firmwareRequired.confirmLabel')}
        variant="warning"
        onConfirm={start}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}
