import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Sparkles, ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WhatsNewAction, WhatsNewEntry } from '../../whatsNew';

interface Props {
  entries: WhatsNewEntry[];
  /** Called once, with how it was left: closed, or "Try it" on an entry. */
  onClose: (action?: WhatsNewAction) => void;
}

/** "New in OpenNova": one card per feature, a looping video on top. */
export function WhatsNewModal({ entries, onClose }: Props) {
  const { t } = useTranslation();
  const [i, setI] = useState(0);
  const e = entries[i];
  const last = i === entries.length - 1;

  // Portal to body for the same reason as ReleaseNotesModal: a transformed
  // ancestor would pin position:fixed to itself.
  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm grid place-items-center p-4" onClick={() => onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        className="w-full max-w-xl rounded-2xl border border-gray-700/70 bg-gray-900 shadow-2xl overflow-hidden"
        onClick={ev => ev.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
          <Sparkles className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-semibold text-zinc-100">{t('whatsNew.heading')}</span>
          <button
            onClick={() => onClose()}
            className="ml-auto p-1 rounded-md text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <video
          key={e.id}
          src={e.video}
          poster={e.poster}
          autoPlay
          loop
          muted
          playsInline
          className="w-full aspect-video bg-black object-cover"
        />

        <div className="px-5 pt-4 pb-5">
          <h2 id="whats-new-title" className="text-lg font-semibold text-zinc-100">{t(`whatsNew.${e.id}.title`)}</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{t(`whatsNew.${e.id}.body`)}</p>

          <div className="mt-5 flex items-center gap-3">
            {entries.length > 1 && (
              <div className="flex gap-1.5" aria-hidden>
                {entries.map((x, k) => (
                  <span key={x.id} className={`w-1.5 h-1.5 rounded-full ${k === i ? 'bg-emerald-400' : 'bg-zinc-700'}`} />
                ))}
              </div>
            )}
            <div className="ml-auto flex gap-2">
              {e.action && (
                <button
                  onClick={() => onClose(e.action)}
                  className="px-3.5 py-2 rounded-lg text-sm font-semibold text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 transition-colors"
                >
                  {t('whatsNew.tryIt')}
                </button>
              )}
              <button
                onClick={() => (last ? onClose() : setI(i + 1))}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-500 transition-colors"
              >
                {last ? t('whatsNew.done') : t('whatsNew.next')}
                {!last && <ArrowRight className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
