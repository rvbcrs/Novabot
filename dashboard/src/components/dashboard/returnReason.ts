/**
 * ReturnReasonModal — explains WHY the mower is sitting on the dock.
 *
 * Ported from the app (app/src/components/ReturnReasonModal.tsx). The dashboard
 * showed a bare "Resume" button and nothing else, so a run that rain, a low
 * battery or a time limit had cut short looked exactly like one the user had
 * stopped by hand.
 *
 * A rain pause sets Work:USER_STOP, the same as a manual pause, so the
 * server-provided `rain_paused` flag is the only way to tell them apart. The
 * priority order below is significant.
 */
import { useState } from 'react';
import {
  CloudRain, BatteryLow, Clock, Home, CheckCircle2, AlertTriangle, type LucideIcon,
} from 'lucide-react';

export type ReturnReason =
  | 'rain' | 'low_battery' | 'time_limit' | 'manual' | 'finished' | 'error' | null;

export function deriveReturnReason(
  sensors: Record<string, string> | undefined,
  hasError: boolean,
): ReturnReason {
  if (hasError) return 'error';
  if (sensors?.rain_paused === '1') return 'rain';
  const msg = sensors?.msg ?? '';
  if (/Work:(USER_RECHARGE_STOP|BATTERY_LOW_RECHARGE)\b/.test(msg)) return 'low_battery';
  if (/Work:TIME_LIMIT_STOP\b/.test(msg)) return 'time_limit';
  if (/Work:(FINISHED|FINISHED_ONCE)\b/.test(msg)) return 'finished';
  if (/Work:(USER_STOP|PAUSED)\b/.test(msg)) return 'manual';
  return null;
}

interface Meta { icon: LucideIcon; tone: string; ring: string; offersResume: boolean }

export const RETURN_REASON_META: Record<Exclude<ReturnReason, null>, Meta> = {
  rain: { icon: CloudRain, tone: 'text-blue-400', ring: 'bg-blue-500/15', offersResume: true },
  low_battery: { icon: BatteryLow, tone: 'text-amber-400', ring: 'bg-amber-500/15', offersResume: false },
  time_limit: { icon: Clock, tone: 'text-amber-400', ring: 'bg-amber-500/15', offersResume: true },
  manual: { icon: Home, tone: 'text-zinc-400', ring: 'bg-zinc-500/15', offersResume: true },
  finished: { icon: CheckCircle2, tone: 'text-emerald-400', ring: 'bg-emerald-500/15', offersResume: false },
  error: { icon: AlertTriangle, tone: 'text-red-400', ring: 'bg-red-500/15', offersResume: false },
};

export const RETURN_REASON_TEXT: Record<Exclude<ReturnReason, null>, { title: [string, string]; desc: [string, string]; resume: [string, string] }> = {
  rain: {
    title: ['returnReason.rainTitle', 'Teruggekeerd: regen'],
    desc: ['returnReason.rainDesc', 'De maaier is naar het laadstation gereden omdat er regen werd gedetecteerd. Hervat om de regenpauze te negeren.'],
    resume: ['returnReason.rainResume', 'Negeer regen & hervat'],
  },
  low_battery: {
    title: ['returnReason.batteryTitle', 'Opladen, lage accu'],
    desc: ['returnReason.batteryDesc', 'De maaier laadt op en hervat automatisch zodra de accu vol is.'],
    resume: ['returnReason.resume', 'Hervat'],
  },
  time_limit: {
    title: ['returnReason.timeTitle', 'Tijdslimiet bereikt'],
    desc: ['returnReason.timeDesc', 'De ingestelde maaitijd is bereikt. Je kunt het maaien hervatten.'],
    resume: ['returnReason.resume', 'Hervat'],
  },
  manual: {
    title: ['returnReason.manualTitle', 'Handmatig teruggestuurd'],
    desc: ['returnReason.manualDesc', 'De maaier is handmatig naar het laadstation gestuurd. Je kunt het maaien hervatten.'],
    resume: ['returnReason.resume', 'Hervat'],
  },
  finished: {
    title: ['returnReason.finishedTitle', 'Maaien voltooid'],
    desc: ['returnReason.finishedDesc', 'Het maaien is voltooid en de maaier staat weer op het laadstation.'],
    resume: ['returnReason.resume', 'Hervat'],
  },
  error: {
    title: ['returnReason.errorTitle', 'Teruggekeerd door storing'],
    desc: ['returnReason.errorDesc', 'De maaier is teruggekeerd door een storing. Los de storing op en probeer opnieuw.'],
    resume: ['returnReason.resume', 'Hervat'],
  },
};

/**
 * Decides when the modal pops and when the chip is offered.
 *
 * Only after we saw the mower come back from an off-dock state in THIS browser
 * session. On a page load with an already-docked mower there is no previous
 * activity, so a stale popup never ambushes the user after a refresh.
 */
export function useReturnReason(
  activity: string | null,
  sensors: Record<string, string> | undefined,
  hasError: boolean,
) {
  const reason = deriveReturnReason(sensors, hasError);
  const [visible, setVisible] = useState(false);
  const [liveReturn, setLiveReturn] = useState(false);
  const [seen, setSeen] = useState<{ activity: string | null; reason: ReturnReason }>(
    { activity, reason: null },
  );

  // Adjusted during render rather than in an effect: this is a state-follows-
  // props transition, and doing it in an effect makes React render once with
  // the stale value and then again, which the lint rule flags as a cascading
  // render.
  if (activity !== seen.activity) {
    const prev = seen.activity;
    const offDockOrIdle = activity === 'mowing' || activity === 'edge_cutting'
      || activity === 'idle' || activity === null;
    if (offDockOrIdle) {
      setSeen({ activity, reason: null });
      if (liveReturn) setLiveReturn(false);
    } else {
      // Only when the mower came back from an off-dock state in THIS browser
      // session. On a page load with an already-docked mower `prev` is null, so
      // a stale popup never ambushes the user after a refresh.
      const cameFromOffDock = prev === 'mowing' || prev === 'edge_cutting' || prev === 'returning';
      const fresh = cameFromOffDock && reason != null && reason !== seen.reason;
      setSeen({ activity, reason: fresh ? reason : seen.reason });
      if (cameFromOffDock && reason) {
        if (!liveReturn) setLiveReturn(true);
        if (fresh) setVisible(true);
      }
    }
  }

  return { reason, visible, liveReturn, open: () => setVisible(true), close: () => setVisible(false) };
}
