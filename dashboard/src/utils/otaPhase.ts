import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { OtaSession } from '../api/client';

/** Wall clock that re-renders once a second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** "1:07" since the phase started. */
export function otaElapsed(now: number, since: number | undefined): string {
  if (since == null) return '';
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function useOtaPhaseLabel(session: OtaSession | undefined): string {
  const { t } = useTranslation();
  if (!session) return '';
  const version = session.phase === 'done' ? session.target : session.reported ?? session.from ?? '';
  return t(`otaPhase.${session.phase}`, { version });
}
