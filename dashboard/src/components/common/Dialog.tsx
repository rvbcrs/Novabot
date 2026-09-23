/**
 * In-app dialogs, awaited like the browser's own: `await dialog.confirm(...)`
 * instead of `window.confirm(...)`. The browser dialogs ("192.168.0.247:8080
 * says …") are never used in this dashboard; this is what replaces them.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type Variant = 'danger' | 'warning' | 'info';

interface Base { title: string; message?: string; variant?: Variant }
export interface ConfirmOptions extends Base { confirmLabel?: string; cancelLabel?: string }
export interface PromptOptions extends Base { defaultValue?: string; confirmLabel?: string; cancelLabel?: string }

interface DialogApi {
  confirm(o: ConfirmOptions): Promise<boolean>;
  alert(o: Base & { okLabel?: string }): Promise<void>;
  prompt(o: PromptOptions): Promise<string | null>;
}

type Request =
  | { kind: 'confirm'; o: ConfirmOptions; done: (v: boolean) => void }
  | { kind: 'alert'; o: Base & { okLabel?: string }; done: () => void }
  | { kind: 'prompt'; o: PromptOptions; done: (v: string | null) => void };

const DialogContext = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const api = useContext(DialogContext);
  if (!api) throw new Error('useDialog outside DialogProvider');
  return api;
}

const TONE: Record<Variant, { ring: string; icon: string; button: string }> = {
  danger: { ring: 'bg-red-500/15', icon: 'text-red-400', button: 'bg-red-600 hover:bg-red-500' },
  warning: { ring: 'bg-amber-500/15', icon: 'text-amber-400', button: 'bg-amber-600 hover:bg-amber-500' },
  info: { ring: 'bg-emerald-500/15', icon: 'text-emerald-400', button: 'bg-emerald-600 hover:bg-emerald-500' },
};

export function DialogProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [req, setReq] = useState<Request | null>(null);
  const [text, setText] = useState('');
  const okRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ponytail: one dialog at a time; a new one cancels the open one.
  const open = useCallback((next: Request) => {
    setReq(prev => {
      if (prev) prev.kind === 'confirm' ? prev.done(false) : prev.kind === 'prompt' ? prev.done(null) : prev.done();
      return next;
    });
    if (next.kind === 'prompt') setText(next.o.defaultValue ?? '');
  }, []);

  const api = useRef<DialogApi>({
    confirm: o => new Promise(done => open({ kind: 'confirm', o, done })),
    alert: o => new Promise(done => open({ kind: 'alert', o, done })),
    prompt: o => new Promise(done => open({ kind: 'prompt', o, done })),
  }).current;

  const close = useCallback((ok: boolean) => {
    setReq(cur => {
      if (!cur) return null;
      if (cur.kind === 'confirm') cur.done(ok);
      else if (cur.kind === 'prompt') cur.done(ok ? text : null);
      else cur.done();
      return null;
    });
  }, [text]);

  useEffect(() => {
    if (!req) return;
    (req.kind === 'prompt' ? inputRef.current : okRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req, close]);

  const variant: Variant = req?.o.variant ?? (req?.kind === 'confirm' ? 'warning' : 'info');
  const tone = TONE[variant];
  const Icon = variant === 'info' ? Info : AlertTriangle;
  const okLabel = req?.kind === 'alert' ? req.o.okLabel : req?.o.confirmLabel;

  return (
    <DialogContext.Provider value={api}>
      {children}
      {req && (
        <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => close(false)} />
          <form
            className="relative bg-gray-900 border border-gray-700/50 rounded-2xl shadow-2xl max-w-sm w-full p-6"
            onSubmit={e => { e.preventDefault(); close(true); }}
          >
            <div className="flex justify-center mb-4">
              <div className={`w-14 h-14 rounded-full flex items-center justify-center ${tone.ring}`}>
                <Icon className={`w-7 h-7 ${tone.icon}`} />
              </div>
            </div>
            <p className="text-center text-white font-medium text-lg leading-snug mb-2">{req.o.title}</p>
            {req.o.message && <p className="text-center text-gray-400 text-sm whitespace-pre-line">{req.o.message}</p>}
            {req.kind === 'prompt' && (
              <input
                ref={inputRef}
                value={text}
                onChange={e => setText(e.target.value)}
                className="mt-4 w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
            )}
            <div className="flex gap-3 mt-6">
              {req.kind !== 'alert' && (
                <button type="button" onClick={() => close(false)}
                  className="flex-1 py-2.5 bg-white/10 hover:bg-white/15 text-gray-300 text-sm font-medium rounded-xl transition-colors">
                  {req.o.cancelLabel ?? t('common.cancel', 'Annuleren')}
                </button>
              )}
              <button ref={okRef} type="submit"
                className={`flex-1 py-2.5 text-white text-sm font-medium rounded-xl transition-colors ${tone.button}`}>
                {okLabel ?? 'OK'}
              </button>
            </div>
          </form>
        </div>
      )}
    </DialogContext.Provider>
  );
}
