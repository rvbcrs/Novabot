/**
 * ReturnReasonModal — explains WHY the mower is sitting on the dock.
 *
 * Ported from the app (app/src/components/ReturnReasonModal.tsx). The dashboard
 * showed a bare "Resume" button and nothing else, so a run that rain, a low
 * battery or the time limit had cut short looked exactly like one the user had
 * stopped by hand.
 *
 * The derivation, the per-reason metadata and the hook live in returnReason.ts:
 * a .tsx that exports a component may not export anything else, or fast refresh
 * stops working for it.
 */
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { RETURN_REASON_META, RETURN_REASON_TEXT, type ReturnReason } from './returnReason';

interface Props {
  reason: ReturnReason;
  online: boolean;
  busy: boolean;
  onResume: () => void;
  onClose: () => void;
}

export function ReturnReasonModal({ reason, online, busy, onResume, onClose }: Props) {
  const { t } = useTranslation();
  if (!reason) return null;
  const meta = RETURN_REASON_META[reason];
  const text = RETURN_REASON_TEXT[reason];
  const Icon = meta.icon;
  const showResume = meta.offersResume && online;

  return createPortal(
    <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-900 border border-gray-700/50 rounded-2xl shadow-2xl max-w-sm w-full p-6">
        <div className="flex justify-center mb-4">
          <div className={`w-14 h-14 rounded-full flex items-center justify-center ${meta.ring}`}>
            <Icon className={`w-7 h-7 ${meta.tone}`} />
          </div>
        </div>
        <p className="text-center text-white font-medium text-lg leading-snug mb-2">
          {t(text.title[0], text.title[1])}
        </p>
        <p className="text-center text-gray-400 text-sm mb-6">
          {t(text.desc[0], text.desc[1])}
        </p>
        <div className="flex flex-col gap-3">
          {showResume && (
            <button
              onClick={onResume}
              disabled={busy}
              className="py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40
                         text-white text-sm font-medium rounded-xl transition-colors"
            >
              {t(text.resume[0], text.resume[1])}
            </button>
          )}
          <button
            onClick={onClose}
            className="py-2.5 bg-white/10 hover:bg-white/15 text-gray-300 text-sm font-medium rounded-xl transition-colors"
          >
            {t('common.close', 'Sluiten')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
