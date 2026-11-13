import { createPortal } from 'react-dom';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cancelOtaSession } from '../../api/client';
import { useDialog } from '../common/Dialog';
import { otaFinished, type OtaProgress } from '../../hooks/useDevices';
import { useNow, otaElapsed, useOtaPhaseLabel } from '../../utils/otaPhase';

const WAITING = new Set(['awaiting-reboot', 'rebooting', 'back']);

/**
 * A firmware update in progress, as the app shows it (OtaScreen): title,
 * phase, percentage or time since the reboot started, and a bar. Closing it
 * only hides it: a mower cannot cancel an update it has accepted, and the
 * banner keeps the progress.
 */
export function OtaProgressModal({ sn, from, target, progress, onClose }: {
  sn: string;
  from: string;
  target: string;
  progress: OtaProgress | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useDialog();
  const session = progress?.session;
  const phase = session?.phase;
  const phaseLabel = useOtaPhaseLabel(session);
  const now = useNow(true);

  const isDone = phase ? phase === 'done' : progress?.status === 'success';
  const isFail = phase ? otaFinished(progress) && phase !== 'done' : progress?.status === 'failed' || progress?.status === 'error';
  const isActive = !isDone && !isFail;
  const waiting = !!phase && WAITING.has(phase);
  // Before the reboot: what the server handed out of the file is the download;
  // the mower's own counter restarts on every resume (stock 5.7.1).
  const fetching = phase === 'downloading' || phase === 'suspended';
  const served = session?.served;
  const pct = fetching && served ? (served.bytes / served.size) * 100 : progress?.percentage ?? null;
  // Accepted but never fetched: off the charger, or the server unreachable.
  const notFetched = fetching && !served;

  const title = isDone ? t('otaModal.done')
    : phase === 'rolled-back' ? t('otaModal.rolledBack')
    : phase === 'stalled' ? t('otaModal.stalled')
    : isFail ? t('otaModal.failed')
    : waiting ? t('otaModal.restarting') : t('otaModal.updating');
  const label = phaseLabel || (isDone ? t('ota.updateDone') : isFail ? t('ota.updateFailed')
    : pct == null ? t('otaModal.preparing')
    : pct < 62 ? t('otaPhase.downloading') : pct < 68 ? t('otaPhase.unpacking') : t('otaPhase.installing'));
  const right = waiting && session ? otaElapsed(now, session.since)
    : (isDone || isFail) && phase ? ''
    : pct != null ? `${pct.toFixed(0)}%` : '';
  const width = waiting ? 100 : Math.max(0, Math.min(100, pct ?? (isActive ? 4 : 100)));
  const tone = isDone ? 'emerald' : isFail ? 'red' : 'amber';
  const text = { emerald: 'text-emerald-400', red: 'text-red-400', amber: 'text-amber-400' }[tone];
  const bar = { emerald: 'bg-emerald-500', red: 'bg-red-500', amber: 'bg-amber-500' }[tone];

  const stopFollowing = async () => {
    if (await dialog.confirm({ title: t('ota.stopTitle'), message: t('ota.stopBody'), confirmLabel: t('ota.stopFollowing') })) {
      await cancelOtaSession(sn).catch(() => {});
      onClose();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm grid place-items-center p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ota-modal-title"
        className="w-full max-w-sm rounded-2xl border border-gray-700/70 bg-gray-900 shadow-2xl p-6 flex flex-col items-center text-center"
        onClick={(e) => e.stopPropagation()}
      >
        {isActive && <Loader2 className="w-10 h-10 text-amber-400 animate-spin" />}
        {isDone && <CheckCircle2 className="w-10 h-10 text-emerald-400" />}
        {isFail && <XCircle className="w-10 h-10 text-red-400" />}
        <h2 id="ota-modal-title" className="mt-3 text-base font-semibold text-zinc-100">{title}</h2>
        <p className="mt-1 text-sm text-zinc-400 font-mono">{from} → {target}</p>

        <div className="mt-5 w-full">
          <div className="flex items-center justify-between text-xs mb-1.5" aria-live="polite">
            <span className={text}>{label}</span>
            {right && <span className={`${text} tabular-nums`}>{right}</span>}
          </div>
          <div
            className="w-full bg-gray-800 rounded-full h-2 overflow-hidden"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={waiting ? undefined : Math.round(width)}
          >
            <div className={`h-2 rounded-full transition-all duration-500 ${bar} ${waiting ? 'animate-pulse' : ''}`} style={{ width: `${width}%` }} />
          </div>
        </div>

        {isActive && !waiting && <p className="mt-4 text-xs text-zinc-500">{t('otaModal.closeHint')}</p>}
        {waiting && <p className="mt-4 text-xs text-zinc-500">{t('otaModal.waitingHint')}</p>}
        {notFetched && session && now - session.startedAt > 90_000 && (
          <p className="mt-3 text-xs text-amber-300">{t('ota.noFetchHint')}</p>
        )}
        {phase === 'stalled' && session?.lastState != null && (
          <p className="mt-3 text-[11px] text-zinc-500 font-mono break-all">{JSON.stringify(session.lastState)}</p>
        )}

        <div className="mt-5 flex gap-2">
          {notFetched && (
            <button onClick={() => void stopFollowing()} className="px-3 py-1.5 rounded-lg border border-gray-700 text-xs text-zinc-300 hover:bg-gray-800 transition-colors">
              {t('ota.stopFollowing')}
            </button>
          )}
          <button
            onClick={onClose}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium text-white transition-colors ${
              isDone ? 'bg-emerald-600 hover:bg-emerald-500' : isFail ? 'bg-red-600 hover:bg-red-500' : 'bg-gray-700 hover:bg-gray-600'
            }`}
          >
            {isActive ? t('otaModal.hide') : t('common.close', 'Close')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
