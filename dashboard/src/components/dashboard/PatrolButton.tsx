import { useRef, useState } from 'react';
import { ChevronDown, Moon, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { startPatrol, stopPatrol } from '../../api/client';
import { patrolPhaseText, patrolStatus } from '../../utils/patrolStatus';
import { useToast } from '../common/Toast';

/**
 * The Patrol button of the control bar. Idle, a click starts the night patrol;
 * while it drives (starting, localizing, patrolling, returning) the same button
 * is a red Stop patrol. The chevron beside it opens the patrol panel (zones,
 * headlight, nightly schedule, last patrol) under the bar, like the Mapping
 * button does; it is a separate segment because the main click already acts.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */

/** After an accepted start, Start stays off at most this long while the mower's first report is on its way. */
const START_WAIT_MS = 5000;

interface Props {
  sn: string;
  sensors?: Record<string, string>;
  /** The bar's own gate: busy with another command, or the mower is offline. */
  disabled: boolean;
  offline: boolean;
  /** The panel under the bar is open. */
  expanded: boolean;
  onToggleExpanded: () => void;
  /** The bar's button classes (padding, rounding, disabled look). */
  baseClass: string;
}

export function PatrolButton({ sn, sensors, disabled, offline, expanded, onToggleExpanded, baseClass }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const status = patrolStatus(sensors);
  const { phase, active, otherDrive } = status;
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const waitTimer = useRef<number | undefined>(undefined);

  // The mower answers an accepted start with its first report; from then on the
  // phase says where things stand (adjusted while rendering, as React documents).
  const [seenPhase, setSeenPhase] = useState(phase);
  if (phase !== seenPhase) {
    setSeenPhase(phase);
    setWaiting(false);
  }
  // Stop is never held back by this: it only covers the gap before the first report.
  const startPending = waiting && !active;

  const run = async () => {
    setBusy(true);
    try {
      if (active) {
        await stopPatrol(sn);
        toast(`✓ ${t('controls.stopPatrol')}`, 'success');
      } else {
        const r = await startPatrol(sn);
        if (r.ok) {
          toast(`✓ ${t('controls.startPatrol')}`, 'success');
          // Without this Start shows again until the mower's `starting` arrives, and a
          // second press would restart the patrol that is just coming up.
          setWaiting(true);
          window.clearTimeout(waitTimer.current);
          waitTimer.current = window.setTimeout(() => setWaiting(false), START_WAIT_MS);
        } else {
          // The server's refusal, in the reader's language (busy, battery, no checkpoints, ...).
          toast(`✗ ${t('controls.startPatrol')}: ${r.error ?? t('drawer.patrol.startFailed')}`, 'error');
        }
      }
    } catch (e) {
      // Stock firmware answers 409 with the reason (ApiError); a lost login or network ends here too.
      const label = active ? t('controls.stopPatrol') : t('controls.startPatrol');
      toast(`✗ ${label}: ${e instanceof Error && e.message ? e.message : String(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const action = active ? t('controls.stopPatrol') : t('controls.startPatrol');
  // Why it is off, when it is: another drive holds the wheels, or the mower is offline.
  const reason = otherDrive ? t('drawer.patrol.otherDrive') : offline ? t('controls.mowerOffline') : null;

  return (
    <div className="inline-flex items-center">
      <button
        onClick={() => void run()}
        disabled={disabled || busy || startPending || otherDrive}
        // Icon-only below sm: while it drives, the tooltip names the action and the phase.
        title={active ? `${action}: ${patrolPhaseText(t, status)}` : reason ?? action}
        aria-label={reason && !active ? `${action}: ${reason}` : action}
        className={`${baseClass} self-stretch gap-1 sm:px-2 rounded-r-none ${
          active ? 'bg-red-700 text-white hover:bg-red-600' : 'bg-gray-700/60 text-indigo-300 hover:bg-indigo-700/40'
        }`}
      >
        {active ? <Square className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
        <span className="hidden sm:inline text-xs whitespace-nowrap">{active ? t('controls.stopPatrol') : t('controls.patrol')}</span>
      </button>
      <button
        onClick={onToggleExpanded}
        title={t('controls.patrolPanel')}
        aria-label={t('controls.patrolPanel')}
        aria-expanded={expanded}
        // At least 24x24 at every width, and a small gap: it sits next to the button that starts the robot.
        className={`inline-flex items-center justify-center self-stretch min-w-6 min-h-6 px-1.5 ml-0.5 rounded-lg rounded-l-none transition-colors ${
          expanded ? 'bg-indigo-700/40 text-indigo-200' : 'bg-gray-700/60 text-gray-400 hover:text-white'
        }`}
      >
        <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
    </div>
  );
}
