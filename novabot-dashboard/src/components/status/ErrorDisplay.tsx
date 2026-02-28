import { useState } from 'react';
import { AlertTriangle, Info, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Benign error codes that are normal during idle (LoRa timeout, etc.)
const BENIGN_CODES = new Set(['132']);

interface Props {
  errorCode?: string;
  errorMsg?: string;
  errorStatus?: string;
  workStatus?: string;
}

export function ErrorDisplay({ errorCode, errorMsg, errorStatus, workStatus }: Props) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState<string | null>(null);

  // Raw error_status number (before translation)
  const rawStatus = errorStatus?.match(/\d+/)?.[0] ?? errorStatus;
  const rawCode = errorCode?.match(/\d+/)?.[0] ?? errorCode;

  const hasError = (errorStatus && errorStatus !== 'OK') ||
                   (errorCode && errorCode !== 'None' && errorCode !== '0');

  if (!hasError) return null;

  // Allow dismissing by error code — reappears if code changes
  const dismissKey = `${rawStatus}-${rawCode}`;
  if (dismissed === dismissKey) return null;

  // Benign errors (e.g. LoRa timeout 132) when mower is idle → show as subtle info, not alarm
  const isIdle = !workStatus || workStatus === '0';
  const isBenign = isIdle && (BENIGN_CODES.has(rawStatus ?? '') || BENIGN_CODES.has(rawCode ?? ''));

  if (isBenign) {
    return (
      <div className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 flex items-center gap-2">
        <Info className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
        <span className="text-xs text-gray-300 flex-1 min-w-0">
          {errorMsg || errorStatus}
        </span>
        <button
          onClick={() => setDismissed(dismissKey)}
          className="text-gray-500 hover:text-gray-300 transition-colors flex-shrink-0 p-0.5"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="bg-red-900/30 border border-red-800 rounded-xl p-4 relative">
      <button
        onClick={() => setDismissed(dismissKey)}
        className="absolute top-2 right-2 text-red-400/60 hover:text-red-300 transition-colors p-0.5"
      >
        <X className="w-4 h-4" />
      </button>
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className="w-4 h-4 text-red-400" />
        <span className="text-red-400 text-sm font-semibold">{t('status.error')}</span>
        {errorCode && errorCode !== 'None' && (
          <span className="text-xs bg-red-800/50 text-red-300 px-2 py-0.5 rounded">
            {t('status.errorCode', { code: errorCode })}
          </span>
        )}
      </div>
      {errorMsg && <p className="text-sm text-red-300">{errorMsg}</p>}
      {errorStatus && errorStatus !== 'OK' && (
        <p className="text-xs text-red-400 mt-1">{errorStatus}</p>
      )}
    </div>
  );
}
