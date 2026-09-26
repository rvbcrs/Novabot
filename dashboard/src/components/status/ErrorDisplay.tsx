import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { clearMowerError } from '../../api/client';
import { errorKind } from '../../utils/mowerActivity';

// Codes the stock Novabot app NEVER surfaces and we hide here too. They
// fire often, self-recover within seconds, and showing a full-screen
// modal each time turns the dashboard into noise. Same set as the
// server-side SUPPRESSED_ERROR_CODES (eventDetector.ts) and the OpenNova
// app's HIDDEN_TRANSIENT_ERRORS:
//   8   = LoRa flicker
//   113 = transient sensor/perception warning, auto-recovers
//   132 = data transmission loss, auto-recovers
//   151 = PIN lock — handled by PinKeypad overlay, no modal needed
const HIDDEN_CODES = new Set(['8', '113', '132', '151']);

// Codes that are normal for a few seconds and alarming only if they persist.
// After saving a map the server restarts the mower's mapping node so it reloads
// the fresh CSVs. robot_decision notices the missing process within 5 s and
// reports 140 ("Process crashed") or 120, then clears it by itself once the
// node is back, roughly 10 to 20 s later. Showing a full-screen modal for that
// window made a routine save look like a crash. A real crash keeps the error
// set, so the modal still appears, just later.
const DEFERRED_CODES = new Set(['140', '120']);
const DEFERRED_DELAY_MS = 30_000;

interface Props {
  errorCode?: string;
  errorMsg?: string;
  errorStatus?: string;
  /** Kept for callsite compatibility; no longer consulted by the filter. */
  workStatus?: string;
  /** The mower's serial: with it the modal offers to clear the error. */
  sn?: string;
  /** error_ack from the sensors: the code the user already cleared. */
  errorAck?: string;
}

/**
 * Shows a centered modal overlay when device errors appear.
 * Hidden transient codes (LoRa flicker, perception/data loss, PIN) skipped.
 */
export function ErrorDisplay({ errorCode, errorMsg, errorStatus, sn, errorAck }: Props) {
  const { t } = useTranslation();
  const [clearing, setClearing] = useState(false);
  // Keyed to the error it belongs to, so a new error never shows an old note.
  const [clearNote, setClearNote] = useState<{ code: string; text: string } | null>(null);

  const rawStatus = errorStatus?.match(/\d+/)?.[0] ?? errorStatus;
  const rawCode = errorCode?.match(/\d+/)?.[0] ?? errorCode;

  const hasError = (errorStatus && errorStatus !== 'OK') ||
                   (errorCode && errorCode !== 'None' && errorCode !== '0');

  // PIN-related errors are handled by PinKeypad overlay, not this modal
  const isPinRelated = errorMsg?.toLowerCase().includes('input pin');
  // Hide transient noise regardless of work_status — codes 8/113/132 fire
  // mid-mowing too and the modal would interrupt every coverage cycle.
  const isHidden = HIDDEN_CODES.has(rawStatus ?? '') || HIDDEN_CODES.has(rawCode ?? '');
  // Cleared by the user (here or in the app): the mower keeps the code until
  // its next action, the server's error_ack hides it meanwhile.
  const isAcked = !!errorAck && errorAck === rawStatus;
  const isBenign = isPinRelated || isHidden || isAcked;

  const code = rawStatus || rawCode || '?';
  const key = `${rawCode}-${rawStatus}`;
  const deferred = DEFERRED_CODES.has(code);

  // Which error the user closed. Forgotten as soon as it goes away, so the
  // same error coming back later opens the modal again (derived state, set
  // during render as React documents, instead of in an effect).
  const [closedKey, setClosedKey] = useState<string | null>(null);
  const [deferredKey, setDeferredKey] = useState<string | null>(null);
  if (!hasError && (closedKey !== null || deferredKey !== null)) {
    setClosedKey(null);
    setDeferredKey(null);
  }

  // Deferred codes only show when they outlast the window; the timer's
  // callback is the only state change and it is asynchronous.
  useEffect(() => {
    if (!hasError || isBenign || !deferred) return;
    const timer = setTimeout(() => setDeferredKey(key), DEFERRED_DELAY_MS);
    return () => clearTimeout(timer);
  }, [hasError, isBenign, deferred, key]);

  const visible = !!hasError && !isBenign && closedKey !== key && (!deferred || deferredKey === key);
  const activeError = visible ? { code, message: errorMsg || errorStatus || t('status.unknownError') } : null;
  const close = () => setClosedKey(key);

  if (!activeError) return null;
  const note = clearNote?.code === activeError.code ? clearNote.text : null;

  const kind = errorKind(parseInt(activeError.code, 10));
  const canClear = !!sn && (kind === 'task' || kind === 'restart');
  const clear = async () => {
    if (!sn) return;
    setClearing(true);
    const r = await clearMowerError(sn).catch(() => ({ ok: false as const, error: undefined }));
    setClearing(false);
    if (r.ok && r.action === 'restarting') { setClearNote({ code: activeError.code, text: t('status.clearRestarting') }); return; }
    if (r.ok) { close(); return; }
    setClearNote({ code: activeError.code, text: r.error ?? t('status.clearFailed') });
  };

  return (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4">
      {/* Blurred backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => close()}
      />

      {/* Modal */}
      <div className="relative bg-gray-900 border border-red-500/30 rounded-2xl shadow-2xl shadow-red-500/10 max-w-sm w-full p-6 animate-in">
        {/* Close button */}
        <button
          onClick={() => close()}
          className="absolute top-3 right-3 text-gray-500 hover:text-gray-300 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Icon */}
        <div className="flex justify-center mb-4">
          <div className="w-14 h-14 rounded-full bg-red-500/15 flex items-center justify-center">
            <AlertTriangle className="w-7 h-7 text-red-400" />
          </div>
        </div>

        {/* Error code */}
        <p className="text-center text-xs font-mono text-red-400/70 mb-1">
          {t('status.error')} {activeError.code}
        </p>

        {/* Error message */}
        <p className="text-center text-white font-medium text-lg leading-snug mb-6">
          {activeError.message}
        </p>

        {kind === 'task' && sn && (
          <p className="text-center text-xs text-gray-400 -mt-3 mb-5">{t('status.clearTaskHint')}</p>
        )}
        {kind === 'restart' && sn && (
          <p className="text-center text-xs text-gray-400 -mt-3 mb-5">{t('status.clearRestartHint')}</p>
        )}
        {kind === 'pin' && (
          <p className="text-center text-xs text-amber-300/90 -mt-3 mb-5">{t('status.clearPinHint')}</p>
        )}
        {note && <p className="text-center text-xs text-amber-300 mb-3">{note}</p>}

        <div className="flex gap-3">
          <button
            onClick={() => close()}
            className="flex-1 py-2.5 bg-white/10 hover:bg-white/15 text-gray-300 text-sm font-medium rounded-xl transition-colors"
          >
            {canClear ? t('status.later') : 'OK'}
          </button>
          {canClear && (
            <button
              onClick={() => void clear()}
              disabled={clearing}
              className="flex-1 py-2.5 bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white text-sm font-medium rounded-xl transition-colors"
            >
              {kind === 'restart' ? t('status.clearRestart') : t('status.clear')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
