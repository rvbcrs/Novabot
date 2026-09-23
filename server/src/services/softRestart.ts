// Soft restart = restart the mower's ROS stack via the firmware `soft_restart`
// command (systemctl restart novabot_launch.service). This is NOT an OS reboot:
// it cycles iox-roudi + all ROS nodes, which RESETS the iceoryx shared-memory
// pool — the fix for the chunk leak that crash-loops novabot_mapping and
// surfaces as Error 140 — while mqtt_node keeps running so the mower stays
// online to the app. Two callers: the user-facing dashboard endpoint and the
// auto-recovery monitor below. The safety classification + decision logic lives
// (dependency-free + unit-tested) in softRestartPolicy.ts.
import { deviceCache } from '../mqtt/sensorData.js';
import { translator, type Translate } from './serverText.js';
import { publishToDevice, getNextCmdNum } from '../mqtt/mapSync.js';
import {
  isBusyWorkStatus,
  evalAutoRecover,
  AUTO_RECOVER_INTERVAL_MS,
  type AutoRecoverState,
} from './softRestartPolicy.js';

/** Null when a soft restart is safe (idle/charging/stopped); otherwise a human
 *  reason string. The hard "never while mowing" gate, shared by the user
 *  endpoint and the auto-recovery monitor. */
export function softRestartBlockedReason(sn: string, T: Translate = translator('en')): string | null {
  const raw = deviceCache.get(sn)?.get('work_status');
  if (isBusyWorkStatus(raw)) {
    return T`de maaier is bezig (work_status ${raw}); een soft restart mag alleen als hij stilstaat of laadt`;
  }
  return null;
}

/** Dispatch the firmware soft_restart command (MQTT). The caller owns the
 *  safety gate (softRestartBlockedReason) unless an explicit force override. */
export function sendSoftRestart(sn: string): void {
  publishToDevice(sn, { soft_restart: { cmd_num: getNextCmdNum(sn) } });
}

// ── Auto-recovery monitor ───────────────────────────────────────────────────
// Error 140 ("process crashed") fires when a ROS node — most often
// novabot_mapping — dies, usually because the iceoryx shm pool leaked full
// after many node restarts; only a stack restart clears it. When a mower
// reports a SUSTAINED error 140 AND is idle/charging, auto-soft-restart it with
// no user prompt, gated by a cooldown so a genuinely-broken mower cannot loop.
const recovery = new Map<string, AutoRecoverState>();

function has140(cache: Map<string, string>): boolean {
  const code = parseInt(cache.get('error_code') ?? '', 10);
  const status = parseInt(cache.get('error_status') ?? '', 10);
  return code === 140 || status === 140;
}

/** One monitor pass. Exported for unit testing without the interval. */
export function softRestartAutoRecoverTick(now: number): void {
  for (const [sn, cache] of deviceCache.entries()) {
    const busy = isBusyWorkStatus(cache.get('work_status'));
    const { state, restart } = evalAutoRecover(recovery.get(sn), has140(cache), busy, now);
    recovery.set(sn, state);
    if (restart) {
      console.log(`[soft-restart] ${sn}: auto-recovery — sustained Error 140 + idle/charging, dispatching soft_restart`);
      sendSoftRestart(sn);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startSoftRestartMonitor(): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      softRestartAutoRecoverTick(Date.now());
    } catch (e) {
      console.error('[soft-restart] auto-recovery monitor error', e);
    }
  }, AUTO_RECOVER_INTERVAL_MS);
  console.log('[soft-restart] auto-recovery monitor started (sustained Error 140 + idle → soft restart)');
}

/** Test-only: reset the in-memory recovery state. */
export function _resetSoftRestartState(): void {
  recovery.clear();
}
