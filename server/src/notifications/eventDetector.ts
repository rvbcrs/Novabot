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
  if (prev.msg && next.msg) {
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
  if (prev.rechargeStatus !== next.rechargeStatus && next.rechargeStatus === '9') {
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
  if (!wasDockFailed && nowDockFailed) {
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
export function resetEventState(sn: string): void {
  stateBySn.delete(sn);
}
