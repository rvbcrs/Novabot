import { useState, useCallback } from 'react';
import { Lock, Delete, X, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface PinKeypadProps {
  onSubmit: (code: string) => void;
  busy: boolean;
  error?: string | null;
  onClose?: () => void;
  status?: 'locked' | 'unlocked' | null;
}

export function PinKeypad({ onSubmit, busy, error, onClose, status }: PinKeypadProps) {
  const { t } = useTranslation();
  const [digits, setDigits] = useState<string>('');

  const addDigit = useCallback((d: string) => {
    setDigits(prev => prev.length < 4 ? prev + d : prev);
  }, []);

  const removeDigit = useCallback(() => {
    setDigits(prev => prev.slice(0, -1));
  }, []);

  const clear = useCallback(() => {
    setDigits('');
  }, []);

  const handleSubmit = useCallback(() => {
    if (digits.length === 4 && !busy) {
      onSubmit(digits);
    }
  }, [digits, busy, onSubmit]);

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  return (
    <div className="absolute inset-0 z-[1002] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl p-5 w-[280px] max-w-[90vw]">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 flex-1 justify-center">
            <Lock className="w-5 h-5 text-amber-400" />
            <span className="text-white font-semibold text-sm">{t('pin.locked')}</span>
          </div>
          {onClose && (
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors p-0.5 -mr-1">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* PIN status indicator (when manually opened) */}
        {status && (
          <div className={`flex items-center justify-center gap-2 mb-3 py-1.5 rounded-lg text-xs font-medium ${
            status === 'locked'
              ? 'bg-red-900/30 text-red-400 border border-red-800/50'
              : 'bg-green-900/30 text-green-400 border border-green-800/50'
          }`}>
            {status === 'locked'
              ? <><ShieldAlert className="w-3.5 h-3.5" /> {t('pin.statusLocked')}</>
              : <><ShieldCheck className="w-3.5 h-3.5" /> {t('pin.statusUnlocked')}</>
            }
          </div>
        )}

        {/* PIN display */}
        <div className="flex justify-center gap-3 mb-4">
          {[0, 1, 2, 3].map(i => (
            <div
              key={i}
              className={`w-11 h-12 rounded-lg border-2 flex items-center justify-center text-xl font-mono font-bold transition-colors ${
                i < digits.length
                  ? 'border-amber-400 bg-amber-400/10 text-white'
                  : 'border-zinc-600 bg-zinc-800 text-zinc-600'
              }`}
            >
              {i < digits.length ? '\u2022' : ''}
            </div>
          ))}
        </div>

        {/* Error message */}
        {error && (
          <div className="text-center text-red-400 text-xs mb-3">{error}</div>
        )}

        {/* Keypad grid */}
        <div className="grid grid-cols-3 gap-2 mb-2">
          {keys.map(k => (
            <button
              key={k}
              onClick={() => addDigit(k)}
              disabled={busy || digits.length >= 4}
              className="h-12 rounded-lg bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-white text-lg font-medium transition-colors disabled:opacity-30"
            >
              {k}
            </button>
          ))}
          {/* Bottom row: clear, 0, backspace */}
          <button
            onClick={clear}
            disabled={busy || digits.length === 0}
            className="h-12 rounded-lg bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-zinc-400 text-xs font-medium transition-colors disabled:opacity-30 flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
          <button
            onClick={() => addDigit('0')}
            disabled={busy || digits.length >= 4}
            className="h-12 rounded-lg bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-white text-lg font-medium transition-colors disabled:opacity-30"
          >
            0
          </button>
          <button
            onClick={removeDigit}
            disabled={busy || digits.length === 0}
            className="h-12 rounded-lg bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-zinc-400 transition-colors disabled:opacity-30 flex items-center justify-center"
          >
            <Delete className="w-5 h-5" />
          </button>
        </div>

        {/* Submit button */}
        <button
          onClick={handleSubmit}
          disabled={busy || digits.length !== 4}
          className="w-full h-11 mt-2 rounded-lg bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-black font-bold text-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {busy ? (
            <span className="animate-pulse">{t('pin.unlocking')}</span>
          ) : (
            <>
              <Lock className="w-4 h-4" />
              {t('pin.unlock')}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
