import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

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
}

/**
 * Shows a centered modal overlay when device errors appear.
 * Hidden transient codes (LoRa flicker, perception/data loss, PIN) skipped.
 */
export function ErrorDisplay({ errorCode, errorMsg, errorStatus }: Props) {
  const [activeError, setActiveError] = useState<{ code: string; message: string } | null>(null);
  const lastErrorRef = useRef<string | null>(null);

  const rawStatus = errorStatus?.match(/\d+/)?.[0] ?? errorStatus;
  const rawCode = errorCode?.match(/\d+/)?.[0] ?? errorCode;

  const hasError = (errorStatus && errorStatus !== 'OK') ||
                   (errorCode && errorCode !== 'None' && errorCode !== '0');

  // PIN-related errors are handled by PinKeypad overlay, not this modal
  const isPinRelated = errorMsg?.toLowerCase().includes('input pin');
  // Hide transient noise regardless of work_status — codes 8/113/132 fire
  // mid-mowing too and the modal would interrupt every coverage cycle.
  const isHidden = HIDDEN_CODES.has(rawStatus ?? '') || HIDDEN_CODES.has(rawCode ?? '');
  const isBenign = isPinRelated || isHidden;

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

    if (DEFERRED_CODES.has(code)) {
      const timer = setTimeout(() => setActiveError({ code, message }), DEFERRED_DELAY_MS);
      // Clears the moment the error goes away or changes: the effect re-runs
      // and this cleanup cancels the pending modal.
      return () => clearTimeout(timer);
    }

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
