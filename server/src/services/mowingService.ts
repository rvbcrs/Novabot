/**
 * Mowing Service — centrale module voor het starten/stoppen van maaisessies.
 *
 * Gebruikt EXACT dezelfde code path als de dashboard command handler
 * (encrypt + publishRawToDevice) — bewezen werkend vanuit het HomeScreen.
 *
 * Gebruikt door:
 * - Schedule runner (automatisch op schema)
 * - Dashboard API (handmatige start via browser)
 * - App API (start via OpenNova/Novabot app)
 */

import { publishToDevice } from '../mqtt/mapSync.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { deviceCache } from '../mqtt/sensorData.js';
import { deviceSettingsRepo } from '../db/repositories/deviceSettings.js';
import { selectParaRepush } from '../mqtt/paraRepush.js';

/** Settle time (ms) between re-applying the saved para and start_navigation, so
 *  the mower has processed set_para_info before it captures perception_level /
 *  path_direction at task start. */
export const MOW_PARA_SETTLE_MS = 1500;

/**
 * Returns true when the mower is already executing a task (mowing, edge,
 * mapping, returning, init/startup transitions). Accepting another
 * start_navigation during an active task triggers Error 2 "Already in running
 * task" on the firmware (issue #13), so the scheduler skips those.
 *
 * deviceCache holds the RAW numeric work_status (the dashboard translates only
 * at display time), so we compare raw codes here.
 *
 * IDLE/TERMINAL codes (NOT busy — a fresh start is allowed): WAIT(0), FAILED(1),
 * CANCELLED(2), FAILED_ONCE(7), FINISHED(8/9) and the stop codes USER_STOP(10),
 * USER_RECHARGE_STOP(11), LOWER_POWER_STOP(12), ERROR_STOP(13),
 * TIME_LIMIT_STOP(14), RECOVER_ERROR_STOP(15).
 *
 * CRITICAL FIX: the old set was only {0,2,9}, so FAILED(1) and the stop codes
 * counted as "busy". After ONE aborted scheduled mow the mower parked at
 * work_status=1 (FAILED) and EVERY later scheduled startMowing was silently
 * rejected with "mower busy" — forever — until a manual app-start (which does
 * NOT go through this guard) reset the state. That is exactly the "schedule
 * stopped firing for days while manual still works" symptom.
 */
const IDLE_WORK_STATUS = new Set([
  '', '0', '1', '2', '7', '8', '9', '10', '11', '12', '13', '14', '15',
]);

export function isMowerBusy(sn: string): boolean {
  const raw = deviceCache.get(sn);
  if (!raw) return false;
  const ws = raw.get('work_status') ?? '';
  if (!IDLE_WORK_STATUS.has(ws)) return true;
  const msg = raw.get('msg') ?? '';
  return /Work:(MOVING|COVERING|REQUEST_START|INIT_|RUNNING|MAPPING)/.test(msg)
    || /Recharge:(MOVING|RUNNING|GOING)/.test(msg);
}

export interface MowingParams {
  sn: string;
  /**
   * User-facing cutting height in cm (2-9). Wire value sent to mqtt_node is `cm - 2`.
   * Verified 2026-04-19 via live Novabot-app capture on LFIN1231000211
   * (mqtt_node_20260419_163617_821948.log @ 18:18:09):
   *   user picks 4cm → MQTT cutterhigh:2 → physical blade 40mm ✓
   *   user picks 6cm → MQTT cutterhigh:4 → physical blade 60mm
   * Firmware formula: physical_mm = (cutterhigh + 2) * 10.
   *
   * Auto-normalisation accepts multiple encodings from legacy callers.
   */
  cuttingHeight?: number;
  pathDirection?: number;   // degrees (0-359), default 120
  // Decimal positional bitmask: map0=1, map1=10, map2=100; sum for multi-map
  // (11=map0+map1, 111=all three). The firmware mows every set map in one task.
  // Passed verbatim to start_navigation. See research/documents/multi-map-area-bitmask-decode.md.
  area?: number;
}

export interface MowingResult {
  ok: boolean;
  error?: string;
}

/**
 * Normalise a schedule's stored cutting height to the firmware wire enum
 * (`cutterhigh = cm − 2`, range 0..7). `dashboard_schedules.cutting_height` is
 * stored in DIFFERENT units by the two schedule editors, but in DISJOINT
 * ranges, so we can tell them apart unambiguously:
 *   - app ScheduleScreen  → user cm  (2..9)
 *   - dashboard Scheduler → mm       (20..90)
 * So: ≥ 20 is mm (÷10), anything below is already user cm. Clamp to 2..9 cm.
 *
 * This replaces an older value-range heuristic whose "3..11 → legacy cm+2 wire,
 * subtract 2" branch mis-read app cm values: a 9 cm schedule became 7 cm
 * (9 − 2). The wire (0..2) and legacy-cm+2 branches are dropped — the only
 * caller (scheduleRunner) always passes cm or mm, never a wire value.
 */
export function cuttingHeightToWire(input: number): number {
  const displayCm = input >= 20 ? Math.round(input / 10) : input;
  const clampedCm = Math.max(2, Math.min(9, Math.round(displayCm)));
  return Math.max(0, clampedCm - 2);
}

/** Randmaai bladehoogte in mm voor start_edge_cut. cutting_height komt als mm
 *  (dashboard, >=20) of user-cm (app) binnen — zelfde heuristiek als
 *  cuttingHeightToWire. extended_commands.py clamt óók 20..90 op de maaier;
 *  we clampen hier alvast zodat de payload nooit buiten bereik valt. */
export function edgeBladeHeightMm(cuttingHeight: number): number {
  const mm = cuttingHeight >= 20 ? Math.round(cuttingHeight) : Math.round(cuttingHeight * 10);
  return Math.max(20, Math.min(90, mm));
}

/** Publish a command to the mower. Delegates to publishToDevice which
 *  checks isAesCapable() and falls back to plain JSON for stock v5.x
 *  mowers and charger v0.3.x — both silently drop AES payloads, so
 *  the schedule runner + start_navigation flow previously failed
 *  invisibly on those firmwares (issues #45 / #49). */
function sendCommand(sn: string, command: Record<string, unknown>): void {
  publishToDevice(sn, command);
  console.log(`[MowingService] Sent ${Object.keys(command)[0]} to ${sn}`);
}

/**
 * Start een maaisessie op de maaier.
 * Stuurt start_navigation, exact als de Novabot app en het HomeScreen.
 */
export function startMowing(params: MowingParams): MowingResult {
  const { sn, cuttingHeight = 5, area = 1 } = params;
  const pathDirection = params.pathDirection;

  if (!sn) return { ok: false, error: 'sn required' };
  if (!isDeviceOnline(sn)) return { ok: false, error: 'mower offline' };
  if (isMowerBusy(sn)) {
    console.log(`[MowingService] Reject start: ${sn} already busy (work_status/msg active)`);
    return { ok: false, error: 'mower busy — already in a task' };
  }

  // Normalise the stored cutting height (cm from the app, mm from the dashboard)
  // to the firmware wire enum. See cuttingHeightToWire.
  const cutterhigh = cuttingHeightToWire(cuttingHeight);
  const cmdNum = Date.now() % 100000;

  // Re-apply the user's saved para (mow direction + obstacle avoidance + lights/
  // sound/joystick) RIGHT BEFORE the mow. The mower does NOT persist set_para_info
  // over a reconnect, so without this a task can start with reset defaults: most
  // critically perception_level 0 = camera obstacle-avoidance OFF, and direction
  // 0°. Both perception_level and path_direction are captured at task START, so we
  // send the FULL saved block first (selectParaRepush — partial would reset the
  // omitted fields to 0), let it settle, then start_navigation. Only when there
  // are saved settings; otherwise mow as-is (never send a partial block).
  const para = selectParaRepush(deviceSettingsRepo.findBySn(sn));
  if (para) {
    if (typeof pathDirection === 'number') para.path_direction = pathDirection;
    sendCommand(sn, { set_para_info: para });
  }

  const fireStart = (): void => {
    sendCommand(sn, {
      start_navigation: { mapName: 'test', cutterhigh, area, cmd_num: cmdNum },
    });
    console.log(`[MowingService] Started: sn=${sn} cutterhigh=${cutterhigh} (=${cutterhigh + 2}cm) dir=${pathDirection ?? '(saved)'}° area=${area} reapplied_para=${para ? 'yes' : 'none'}`);
  };
  if (para) setTimeout(fireStart, MOW_PARA_SETTLE_MS);
  else fireStart();

  return { ok: true };
}

/**
 * Stop een actieve maaisessie.
 */
export function stopMowing(sn: string): MowingResult {
  if (!sn) return { ok: false, error: 'sn required' };

  const cmdNum = Date.now() % 100000;
  sendCommand(sn, {
    stop_navigation: { cmd_num: cmdNum },
  });

  console.log(`[MowingService] Stopped: sn=${sn}`);
  return { ok: true };
}

/**
 * Stuur de maaier naar het laadstation.
 */
export function goHome(sn: string): MowingResult {
  if (!sn) return { ok: false, error: 'sn required' };

  const cmdNum = Date.now() % 100000;
  sendCommand(sn, { go_pile: {} });
  setTimeout(() => {
    sendCommand(sn, {
      go_to_charge: {
        cmd_num: cmdNum,
        chargerpile: { latitude: 200, longitude: 200 },
      },
    });
  }, 500);

  console.log(`[MowingService] Go home: sn=${sn}`);
  return { ok: true };
}
