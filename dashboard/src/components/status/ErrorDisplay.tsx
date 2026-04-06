import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

// Benign error codes that are normal during idle (LoRa timeout, etc.)
// 151 = PIN lock — handled by PinKeypad overlay, no modal needed
const BENIGN_CODES = new Set(['132', '151']);

interface Props {
  errorCode?: string;
  errorMsg?: string;
  errorStatus?: string;
  workStatus?: string;
}

/**
 * Shows a centered modal overlay when device errors appear.
 * Benign errors (LoRa timeout, PIN lock) are silently ignored.
 */
export function ErrorDisplay({ errorCode, errorMsg, errorStatus, workStatus }: Props) {
  const [activeError, setActiveError] = useState<{ code: string; message: string } | null>(null);
  const lastErrorRef = useRef<string | null>(null);

  const rawStatus = errorStatus?.match(/\d+/)?.[0] ?? errorStatus;
  const rawCode = errorCode?.match(/\d+/)?.[0] ?? errorCode;

  const hasError = (errorStatus && errorStatus !== 'OK') ||
                   (errorCode && errorCode !== 'None' && errorCode !== '0');

  const isIdle = !workStatus || workStatus === '0';
  // PIN-related errors are handled by PinKeypad overlay, not this modal
  const isPinRelated = errorMsg?.toLowerCase().includes('input pin');
  const isBenign = isPinRelated ||
    (isIdle && (BENIGN_CODES.has(rawStatus ?? '') || BENIGN_CODES.has(rawCode ?? '')));

  useEffect(() => {
    if (!hasError || isBenign) {
      lastErrorRef.current = null;
      return;
    }

    const errorKey = `${rawCode}-${rawStatus}`;
    if (errorKey === lastErrorRef.current) return;
    lastErrorRef.current = errorKey;

    const code = rawCode || rawStatus || '?';
    const message = errorMsg || errorStatus || 'Unknown error';

    setActiveError({ code, message });
  }, [hasError, isBenign, rawCode, rawStatus, errorCode, errorMsg, errorStatus]);

  if (!activeError) return null;

  return (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4">
      {/* Blurred backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setActiveError(null)}
      />

      {/* Modal */}
      <div className="relative bg-gray-900 border border-red-500/30 rounded-2xl shadow-2xl shadow-red-500/10 max-w-sm w-full p-6 animate-in">
        {/* Close button */}
        <button
          onClick={() => setActiveError(null)}
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
          Error {activeError.code}
        </p>

        {/* Error message */}
        <p className="text-center text-white font-medium text-lg leading-snug mb-6">
          {activeError.message}
        </p>

        {/* Dismiss button */}
        <button
          onClick={() => setActiveError(null)}
          className="w-full py-2.5 bg-white/10 hover:bg-white/15 text-gray-300 text-sm font-medium rounded-xl transition-colors"
        >
          OK
        </button>
      </div>
    </div>
  );
}
