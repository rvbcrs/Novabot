/**
 * Event detector — turns deviceCache state transitions into MowerEvent
 * objects and forwards to the dispatcher.
 *
 * Tracks the previous values of the fields that drive transitions so the
 * very first sensor frame after server restart never produces spurious
 * events (we can't tell a transition from "first seen").
 */
import { dispatchEvent } from './dispatcher.js';
import { lookupError } from './errorMap.js';
import { MowerEvent, EventType } from './types.js';
import { isPatrolDriving, patrolDockingUnderWay, patrolDockedRecently, patrolDockingFailed, DOCK_FAILED_ERROR_CODES } from '../services/patrolRuns.js';

const LOW_BATTERY_THRESHOLD = parseInt(process.env.LOW_BATTERY_THRESHOLD ?? '20', 10);

// Friendlier titles per category — keeps notification banners short
// while the body carries the firmware-translated message.
const TITLE_BY_TYPE: Record<EventType, string> = {
  error:                'Mower error',
  error_cleared:        'Mower error cleared',
  mowing_started:       'Mowing started',
  mowing_finished:      'Mowing finished',
  docked:               'Mower docked',
  low_battery:          'Low battery',
  stuck:                'Mower stuck',
  safety:               'Mower safety stop',
  pin_locked:           'PIN required',
  connection_lost:      'Mower connection lost',
  gps_weak:             'GPS issue',
  map_error:            'Mapping issue',
  initialization_error: 'Mower starting up',
  hardware_fault:       'Hardware fault',
  dock_failed:          'Mower could not dock',
  dock_drift:           'Charging station may have moved',
  firmware_required:    'Firmware update required',
  blade_maintenance:    'Time to check the blades',
  patrol_detection:     'Patrol alert',
  patrol_failed:        'Patrol stopped',
};

interface SnapshotState {
  errorStatus: string;
  msg: string;
  rechargeStatus: string;
  batteryPower: number;
  batteryState: string;
  initialised: boolean;        // false until first frame seen — suppresses startup events
}

/**
 * Error codes that fire so often / self-recover so quickly that pushing a
 * notification for each one drowns the user in noise. The HomeScreen
 * banner already hides them via NON_BLOCKING_ERRORS — we mirror that for
 * push notifications. Operationally meaningful warnings (124 out-of-area,
 * 122/123 coverage failures) still notify.
 */
const SUPPRESSED_ERROR_CODES = new Set([
  2,    // "Already in running task" — geweigerde dubbele start; verwacht
        // bijproduct van de mow_zone→start_navigation fallback in de app.
        // De taak draait gewoon, dus een push zou vals alarm zijn.
  8,    // LoRa flicker — happens every few minutes on a noisy site
  113,  // transient sensor/perception warning, auto-recovers
  132,  // data transmission loss, auto-recovers within seconds
]);

const stateBySn = new Map<string, SnapshotState>();

function readSnapshot(snValues: Map<string, string>): SnapshotState {
  return {
    errorStatus: snValues.get('error_status') ?? '0',
    msg: snValues.get('msg') ?? '',
    rechargeStatus: snValues.get('recharge_status') ?? '0',
    batteryPower: parseInt(snValues.get('battery_power') ?? '0', 10) || 0,
    batteryState: (snValues.get('battery_state') ?? '').toUpperCase(),
    initialised: true,
  };
}

function isMowing(msg: string): boolean {
  return msg.includes('Work:RUNNING')
      || msg.includes('Work:COVERING')
      || msg.includes('Work:NAVIGATING')
      || msg.includes('Work:BOUNDARY_COVERING')
      || msg.includes('Work:AVOIDING')
      || msg.includes('Work:MOVING');     // active path-following between zones
}

function isFinished(msg: string): boolean {
  return msg.includes('Work:FINISHED');
}

function makeEvent(sn: string, type: EventType, title: string, message: string,
                   data: Record<string, unknown>): MowerEvent {
  return { sn, type, ts: Date.now(), title, message, data };
}

/**
 * Inspect the latest sensor state for `sn` and emit any events triggered
 * by the transition. Idempotent — only state TRANSITIONS produce events,
 * so calling on every sensor tick is safe.
 */
export function detectAndDispatch(sn: string, snValues: Map<string, string>): void {
  const next = readSnapshot(snValues);
  const prev = stateBySn.get(sn);
  stateBySn.set(sn, next);

  // No prior snapshot → can't compute a transition. Suppress.
  if (!prev) return;

  // ── Error transitions ───────────────────────────────────────
  if (prev.errorStatus !== next.errorStatus) {
    if (next.errorStatus !== '0') {
      const errMsg = snValues.get('error_msg') ?? `error_status=${next.errorStatus}`;
      const code = parseInt(next.errorStatus, 10) || 0;
      // Suppress notifications for codes the firmware self-recovers from
      // (LoRa flicker, transient coverage retries, etc.) AND additionally
      // suppress *any* error while the mower is on the dock — error
      // notifications while charging are almost always stale state from
      // the previous session and just pollute the user's lockscreen.
      const onDock = next.batteryState === 'CHARGING' || next.batteryState === 'FINISHED';
      if (SUPPRESSED_ERROR_CODES.has(code) || onDock) {
        // Skip dispatch — we still mutate stateBySn above so the next
        // genuine transition is detected.
      } else {
        const entry = lookupError(code, errMsg);
        // Body prefers the curated message text from the stock app's
        // translation table; fall back to firmware error_msg if unmapped.
        const body = entry.type === 'error' ? errMsg : entry.message;
        dispatchEvent(makeEvent(
          sn,
          entry.type,
          TITLE_BY_TYPE[entry.type] ?? 'Mower event',
          body,
          { error_status: next.errorStatus, error_msg: errMsg, msg: next.msg },
        ));
      }
    } else {
      // Mirror the suppression on clear-events so we don't emit a "Mower
      // error cleared" ping for codes that never produced a notification
      // in the first place.
      const prevCode = parseInt(prev.errorStatus, 10) || 0;
      const wasOnDock = prev.batteryState === 'CHARGING' || prev.batteryState === 'FINISHED';
      if (!SUPPRESSED_ERROR_CODES.has(prevCode) && !wasOnDock) {
        dispatchEvent(makeEvent(
          sn,
          'error_cleared',
          TITLE_BY_TYPE.error_cleared,
          `Earlier error (code ${prev.errorStatus}) is gone.`,
          { previous_error_status: prev.errorStatus, msg: next.msg },
        ));
      }
    }
  }

  // ── Mowing started / finished ───────────────────────────────
  // Only act when BOTH sides have a non-empty msg — an empty prev/next
  // msg means the cache was just re-populated after a reconnect and we
  // can't trust the transition. Without this guard every mower
  // disconnect/reconnect cycle (which is frequent — mqtt_node
  // makes short-lived connections) would emit a bogus
  // mowing_started → mowing_finished pair.
  // A night patrol leaves the dock through the firmware's own departure, a
  // coverage task that reports Work:MOVING, and after it the server's go home
  // reports Work:MOVING again until the mower docks: no mowing started or
  // finished for either. The snapshot still moves on, so a move seen then is
  // not reported afterwards either. Docked as isDockedByValues (sensorData.ts)
  // has it, which this module cannot import.
  const rechargeStatus = snValues.get('recharge_status') ?? '';
  const docked = rechargeStatus === '9' || rechargeStatus.startsWith('Charging')
    || next.batteryState === 'CHARGING' || next.batteryState === 'FULL';
  const patrolMoves = isPatrolDriving(sn, snValues.get('patrol_phase')) || patrolDockingUnderWay(sn, docked);
  if (prev.msg && next.msg && !patrolMoves) {
    const wasMowing = isMowing(prev.msg);
    const nowMowing = isMowing(next.msg);
    if (!wasMowing && nowMowing) {
      dispatchEvent(makeEvent(
        sn,
        'mowing_started',
        'Mowing started',
        `Started mowing — battery ${next.batteryPower}%.`,
        { msg: next.msg, battery_power: next.batteryPower },
      ));
    } else if (wasMowing && !nowMowing && isFinished(next.msg) && next.errorStatus === '0') {
      dispatchEvent(makeEvent(
        sn,
        'mowing_finished',
        'Mowing finished',
        `Mowing complete — battery ${next.batteryPower}%.`,
        { msg: next.msg, battery_power: next.batteryPower },
      ));
    }
  }

  // ── Docked ──────────────────────────────────────────────────
  // Not for the docking after a night patrol: its run says how it went
  // (patrol_failed, dock_failed), and a window of rounds would otherwise ring
  // the phone every half hour. The 9 can come a tick after the first docked
  // report, which already ended the docking: patrolDockedRecently covers that.
  if (prev.rechargeStatus !== next.rechargeStatus && next.rechargeStatus === '9' && !patrolMoves && !patrolDockedRecently(sn)) {
    dispatchEvent(makeEvent(
      sn,
      'docked',
      'Mower docked',
      `Back on the dock and charged — battery ${next.batteryPower}%.`,
      { recharge_status: next.rechargeStatus, battery_power: next.batteryPower },
    ));
  }

  // ── Dock failed ─────────────────────────────────────────────
  // Issue #30: ntfy never fired when the mower returned to the dock but
  // couldn't actually park (typically dark / ArUco-not-detected). The app
  // popup picked it up but the lockscreen ping never came. Edge-detect
  // the transition into 'Recharge: FAILED' so a single dock attempt only
  // produces one notification, not one per report tick.
  const wasDockFailed = prev.msg.includes('Recharge: FAILED');
  const nowDockFailed = next.msg.includes('Recharge: FAILED');
  const rechargeFailed = !wasDockFailed && nowDockFailed;
  // Novabot-bqzs: the drive home the server sends after a night patrol can fail
  // without the msg saying so (live 2026-10-15: error 126, nav2 refusing the goal
  // at the pile pose, and the mower stood 17 m out for six hours), so an error
  // 126 that comes up counts there as well. Not 113: it auto-recovers.
  const dockErrorCame = prev.errorStatus !== next.errorStatus
    && DOCK_FAILED_ERROR_CODES.has(parseInt(next.errorStatus, 10) || 0);
  const patrolDock = rechargeFailed || dockErrorCame ? patrolDockingFailed(sn, docked) : null;
  if (patrolDock) {
    // That go home is watched: its failure is ONE dock_failed, whichever signal
    // came first, and it carries the patrol's context instead of the generic text.
    if (patrolDock.first) {
      dispatchPatrolDockFailedEvent(sn, {
        run: patrolDock.run, msg: next.msg, errorStatus: next.errorStatus, batteryPower: next.batteryPower,
      });
    }
  } else if (rechargeFailed) {
    dispatchEvent(makeEvent(
      sn,
      'dock_failed',
      'Mower could not dock',
      'Mower returned to the charger but failed to dock — typically ArUco not detected (dark / dirty / misaligned). Manually move the mower onto the dock or retry.',
      { msg: next.msg, battery_power: next.batteryPower },
    ));
  }

  // ── Low battery (one-shot per dip below threshold) ──────────
  if (prev.batteryPower > LOW_BATTERY_THRESHOLD && next.batteryPower <= LOW_BATTERY_THRESHOLD) {
    dispatchEvent(makeEvent(
      sn,
      'low_battery',
      `Battery low (${next.batteryPower}%)`,
      `Battery dropped to ${next.batteryPower}% — heading back to the dock soon.`,
      { battery_power: next.batteryPower, threshold: LOW_BATTERY_THRESHOLD },
    ));
  }
}

/**
 * Reset the cached snapshot for `sn`. Called when a device is unbound /
 * factory-reset so the next frame doesn't fire spurious clear events.
 */
/**
 * The docked position drifted past the warning threshold (dock-drift
 * check). Not a transition in the sensor stream, so it is raised from the
 * place that records dock samples; that caller keeps it to once a day.
 */
export function dispatchDockDriftEvent(sn: string, driftCm: number, sinceIso: string): void {
  dispatchEvent(makeEvent(
    sn,
    'dock_drift',
    TITLE_BY_TYPE.dock_drift,
    `The mower stands ${driftCm} cm from where it stood on the dock on ${sinceIso.slice(0, 10)}, measured by RTK. The charging station or its antenna has probably moved; check it, and re-anchor if it stands right.`,
    { drift_cm: driftCm, since: sinceIso },
  ));
}

/** The night patrol saw a person or an animal (patrolService.onPatrolFrame). */
export function dispatchPatrolDetectionEvent(
  sn: string,
  d: { run: string; seq: number; kind: 'person' | 'animal'; points: number; image: boolean },
): void {
  dispatchEvent(makeEvent(
    sn,
    'patrol_detection',
    TITLE_BY_TYPE.patrol_detection,
    `The patrol saw ${d.kind === 'person' ? 'a person' : 'an animal'} at checkpoint ${d.seq}.`
      + (d.image ? ' The photo is in the patrol overview.' : ' No photo was taken there.'),
    { run: d.run, seq: d.seq, kind: d.kind, points: d.points, image: d.image },
  ));
}

/** The mower's reason for ending a patrol (mow_zone_drive.py / the chassis
 *  watcher), in words. A code nobody reads ("checkpoints_unreachable") was
 *  all the push said. An unknown code stays visible for the bug report. */
export function patrolStopReason(reason: string): string {
  const known: Record<string, string> = {
    checkpoints_unreachable: 'it could not reach five checkpoints in a row; something blocked them, or its position was off',
    frame_not_settled: 'its position did not line up with GPS after it left the dock',
    not_localized: 'it could not find its position after it left the dock',
    no_dock_zone: 'no zone is recorded around the charging station',
    no_route: 'no recorded channel leads to a chosen zone',
    no_route_home: "no recorded channel leads back to the dock's zone",
    busy_mowing: 'it was already on a task',
    push_button: 'the STOP button was pressed',
    no_pin_code: 'the PIN lock engaged',
    upraise: 'it was lifted',
    tile: 'it tilted',
    turn_over: 'it turned over',
    stopped: 'it was stopped',
  };
  // The chassis watcher's codes read error_<cause>_stop.
  const code = reason.replace(/^error_/, '').replace(/_stop$/, '');
  return known[code] ?? `reason: ${reason}`;
}

/** The night patrol stopped with an error, or on the mower itself (the STOP
 *  button, a lift or a tilt: `stoppedOnMower`), patrolService.onPatrolStatus. */
export function dispatchPatrolFailedEvent(sn: string, reason: string, wentHome: boolean, stoppedOnMower = false): void {
  dispatchEvent(makeEvent(
    sn,
    'patrol_failed',
    TITLE_BY_TYPE.patrol_failed,
    `The night patrol stopped: ${patrolStopReason(reason)}.`
      + (wentHome ? ' The mower is being sent to its dock.'
        : stoppedOnMower ? ' The mower stays where it stopped.' : ' The mower did not leave its dock.'),
    { reason, went_home: wentHome },
  ));
}

/**
 * The drive home the server sent after a night patrol did not end on the dock:
 * the recharge failed, or error 126 came up (patrolRuns.patrolDockingFailed;
 * Novabot-bqzs). It is the dock_failed event: the generic text says the mower
 * reached the charger and could not park, here it may stand anywhere, so it says
 * where it is. The data carries `patrol` and the run.
 */
export function dispatchPatrolDockFailedEvent(
  sn: string,
  d: { run: string | null; msg: string; errorStatus: string; batteryPower: number },
): void {
  dispatchEvent(makeEvent(
    sn,
    'dock_failed',
    TITLE_BY_TYPE.dock_failed,
    'Docking after the patrol failed; the mower is standing still in the garden.',
    { msg: d.msg, battery_power: d.batteryPower, error_status: d.errorStatus, patrol: true, run: d.run },
  ));
}

/** The custom build the mower runs was withdrawn (firmware advisory). */
export function dispatchFirmwareRequiredEvent(sn: string, current: string, target: string, reason: string, name?: string | null): void {
  dispatchEvent(makeEvent(
    sn,
    'firmware_required',
    TITLE_BY_TYPE.firmware_required,
    `${name || sn} runs ${current}, which was withdrawn: ${reason}. Update to ${target}; it is on your server, one tap from the dashboard or the app.`,
    { current, target, reason },
  ));
}

/** Maai-uren sinds de laatste meswissel zijn over het interval; één keer per wissel. */
export function dispatchBladeMaintenanceEvent(sn: string, hoursSince: number, intervalHours: number): void {
  dispatchEvent(makeEvent(
    sn,
    'blade_maintenance',
    TITLE_BY_TYPE.blade_maintenance,
    `${Math.round(hoursSince)} mowing hours since the last blade change (reminder set at ${intervalHours} h). Check or replace the blades, then mark them as replaced in the app under History.`,
    { hours_since: hoursSince, interval_hours: intervalHours },
  ));
}

export function resetEventState(sn: string): void {
  stateBySn.delete(sn);
}
