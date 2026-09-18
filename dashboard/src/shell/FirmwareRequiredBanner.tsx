import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchFirmwareAdvisory, triggerOta, type FirmwareAdvisoryDto } from '../api/client';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { BETA_FIRMWARE_WARNING_LINES } from '../utils/betaFirmware';
import { otaFinished, type OtaProgress } from '../hooks/useDevices';
import { useNow, otaElapsed, useOtaPhaseLabel } from '../utils/otaPhase';

const POLL_MS = 10 * 60_000;

/**
 * The custom build this mower runs was withdrawn (manifest `withdrawn`):
 * it has a bug bad enough that staying on it is not an option. One place,
 * not dismissible, and the update starts from here: the server has already
 * fetched the target build. Progress shows in the same bar, so nothing else
 * has to open. Controls stay usable throughout; a mower is never locked out
 * of Stop or Go home for an update.
 */
export function FirmwareRequiredBanner({ sn, charging, otaProgress }: {
  sn: string | null;
  charging: boolean;
  otaProgress: OtaProgress | undefined;
}) {
  const { t } = useTranslation();
  const [adv, setAdv] = useState<FirmwareAdvisoryDto | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [state, setState] = useState<'idle' | 'sending' | 'started' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

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

  if (!sn || !adv?.required || !adv.target) return null;
  const target = adv.target;
  const pct = otaProgress?.percentage ?? null;
  const flashing = session
    ? !otaFinished(otaProgress)
    : state === 'started' || (otaProgress != null && pct != null && pct < 100);
  const pulse = session && (session.phase === 'awaiting-reboot' || session.phase === 'rebooting' || session.phase === 'back');

  const start = async () => {
    setConfirm(false);
    if (target.versionId == null) return;
    setState('sending');
    const r = await triggerOta(sn, target.versionId, true).catch(() => ({ ok: false, error: 'network' } as { ok: boolean; error?: string; detail?: string }));
    if (r.ok) { setState('started'); setError(null); }
    else { setState('error'); setError(r.detail || r.error || 'failed'); }
  };

  return (
    <>
      <div className="px-4 py-2 bg-red-900/50 border-b border-red-700/70 text-red-100 text-sm flex items-start gap-3">
        <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span className="flex-1 min-w-0">
          <strong>{t('firmwareRequired.title', { current: adv.current })}</strong>{' '}
          {t('firmwareRequired.body', { reason: adv.reason, target: target.version })}
          {session && ` ${phaseLabel}${pulse ? ` ${elapsed}` : ''}`}
          {!session && flashing && pct != null && ` ${t('firmwareRequired.progress', { pct: Math.round(pct) })}`}
          {!session && flashing && pct == null && ` ${t('firmwareRequired.started')}`}
          {state === 'error' && error && <span className="block text-red-300 text-xs mt-0.5">{error}</span>}
          {!target.downloaded && <span className="block text-red-300 text-xs mt-0.5">{t('firmwareRequired.downloading')}</span>}
        </span>
        {!flashing && (
          <button
            onClick={() => setConfirm(true)}
            disabled={!target.downloaded || target.versionId == null || state === 'sending'}
            className="px-3 py-1 rounded bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-medium whitespace-nowrap"
          >
            {state === 'sending' ? '…' : t('firmwareRequired.action')}
          </button>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        title={t('firmwareRequired.confirmTitle', { target: target.version })}
        message={[
          ...BETA_FIRMWARE_WARNING_LINES,
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
