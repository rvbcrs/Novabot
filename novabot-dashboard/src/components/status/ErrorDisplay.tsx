import { useEffect, useRef } from 'react';
import { useToast } from '../common/Toast';

// Benign error codes that are normal during idle (LoRa timeout, etc.)
const BENIGN_CODES = new Set(['132']);

interface Props {
  errorCode?: string;
  errorMsg?: string;
  errorStatus?: string;
  workStatus?: string;
}

/**
 * Fires toast notifications when device errors appear.
 * Renders nothing — errors are shown via the global toast system.
 */
export function ErrorDisplay({ errorCode, errorMsg, errorStatus, workStatus }: Props) {
  const { toast } = useToast();
  const lastErrorRef = useRef<string | null>(null);

  const rawStatus = errorStatus?.match(/\d+/)?.[0] ?? errorStatus;
  const rawCode = errorCode?.match(/\d+/)?.[0] ?? errorCode;

  const hasError = (errorStatus && errorStatus !== 'OK') ||
                   (errorCode && errorCode !== 'None' && errorCode !== '0');

  const isIdle = !workStatus || workStatus === '0';
  const isBenign = isIdle && (BENIGN_CODES.has(rawStatus ?? '') || BENIGN_CODES.has(rawCode ?? ''));

  useEffect(() => {
    if (!hasError || isBenign) {
      lastErrorRef.current = null;
      return;
    }

    const errorKey = `${rawCode}-${rawStatus}`;
    if (errorKey === lastErrorRef.current) return;
    lastErrorRef.current = errorKey;

    const parts: string[] = [];
    if (errorCode && errorCode !== 'None') parts.push(`Error ${errorCode}`);
    if (errorMsg) parts.push(errorMsg);
    else if (errorStatus && errorStatus !== 'OK') parts.push(errorStatus);

    if (parts.length > 0) {
      toast(parts.join(': '), 'error');
    }
  }, [hasError, isBenign, rawCode, rawStatus, errorCode, errorMsg, errorStatus, toast]);

  return null;
}
