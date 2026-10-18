import { useEffect, useState } from 'react';
import { getSocket } from '../api/socket';

/** A work area the night patrol could not reach and left out (mow_zone_drive.py `SKIPPED`). */
export interface PatrolSkip { zone: string; reason: string }

/** One checkpoint the patrol could not reach and drove past. `seq` counts over the whole run. */
export interface PatrolSkippedPoint { zone: string; seq: number; reason: string }

/** What the mower reported during the patrol that no sensor carries. */
export interface PatrolReports {
  /** The run the reports below belong to; null until one reports. */
  run: string | null;
  skipped: PatrolSkip[];
  skippedPoints: PatrolSkippedPoint[];
  /** Checkpoints the mower reached (each `patrol_checkpoint` report), by number. */
  reached: number[];
  /** Checkpoint reports seen: it changes when a photo has landed on the server. */
  checkpoints: number;
}

interface ExtendedResponse {
  sn: string;
  command: string;
  data?: { run?: unknown; zone?: unknown; reason?: unknown; seq?: unknown };
}

interface Stored extends PatrolReports { sn: string | null }

const NONE: Stored = { sn: null, run: null, skipped: [], skippedPoints: [], reached: [], checkpoints: 0 };

/**
 * What the mower says during a patrol that no sensor carries: the areas it
 * skipped and the checkpoints it could not reach (both `patrol_skipped`, the
 * checkpoints with their `seq`) and every checkpoint it did reach
 * (`patrol_checkpoint`). All reach the page only as `extended:response` socket
 * events, which the server does not store, so this knows what came in while the
 * page was open. It lives in the shell, not in the patrol panel, so the panel
 * can be closed, or another tab open, meanwhile.
 *
 * `phase` is the mower's patrol_phase: a new patrol (`starting`) wipes the
 * reports of the one before.
 */
export function usePatrolReports(sn: string | null, phase: string | undefined): PatrolReports {
  const [reports, setReports] = useState<Stored>(NONE);

  // Adjusted while rendering, as React documents for state that follows a prop.
  const [seenPhase, setSeenPhase] = useState(phase);
  if (phase !== seenPhase) {
    setSeenPhase(phase);
    if (phase === 'starting') setReports(prev => ({ ...prev, run: null, skipped: [], skippedPoints: [], reached: [] }));
  }

  useEffect(() => {
    if (!sn) return;
    const socket = getSocket();
    const onResponse = (e: ExtendedResponse) => {
      if (e.sn !== sn || (e.command !== 'patrol_skipped' && e.command !== 'patrol_checkpoint')) return;
      const run = typeof e.data?.run === 'string' ? e.data.run : null;
      setReports(prev => {
        const mine = prev.sn === sn ? prev : { ...NONE, sn };
        // A report of another run than the one on screen starts fresh lists.
        const fresh = run !== null && mine.run !== null && run !== mine.run;
        const base = fresh ? { ...mine, skipped: [], skippedPoints: [], reached: [] } : mine;
        const next = { ...base, run: run ?? base.run };
        const seq = e.data?.seq;
        const hasSeq = typeof seq === 'number' && Number.isFinite(seq);
        if (e.command === 'patrol_checkpoint') {
          const reached = hasSeq && !next.reached.includes(seq) ? [...next.reached, seq] : next.reached;
          return { ...next, reached, checkpoints: next.checkpoints + 1 };
        }
        const zone = e.data?.zone;
        const reason = typeof e.data?.reason === 'string' ? e.data.reason : 'unknown';
        if (hasSeq) {
          // It carries its checkpoint number: one checkpoint skipped, not the whole zone.
          const at = typeof zone === 'string' ? zone : '';
          if (next.skippedPoints.some(p => p.zone === at && p.seq === seq)) return next;
          return { ...next, skippedPoints: [...next.skippedPoints, { zone: at, seq, reason }] };
        }
        if (typeof zone !== 'string' || next.skipped.some(s => s.zone === zone)) return next;
        return { ...next, skipped: [...next.skipped, { zone, reason }] };
      });
    };
    socket.on('extended:response', onResponse);
    return () => { socket.off('extended:response', onResponse); };
  }, [sn]);

  return reports.sn === sn ? reports : NONE;
}
