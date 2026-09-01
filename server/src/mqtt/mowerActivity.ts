/**
 * mowerActivity (server-kopie) — leidt één activiteit af uit de ruwe
 * sensor-cache. LETTERLIJKE kopie van dashboard/src/utils/mowerActivity.ts,
 * dat op zijn beurt de app's deriveMower spiegelt (HomeScreen.tsx — dat
 * bestand is autoritatief). Wijzig je daar predicaten, wijzig ze dan op
 * alle drie de plekken.
 *
 * Server-gebruik: voedt de Home Assistant lawn_mower-entiteit (activity
 * mowing/paused/docked/error) in homeassistant.ts.
 */

export type MowerActivity =
  | 'idle'
  | 'charging'
  | 'mowing'
  | 'paused'
  | 'returning'
  | 'edge_cutting'
  | 'mapping'
  | 'error'
  | 'offline';

type Sensors = Record<string, string> | undefined;

/**
 * Error codes the app treats as non-blocking (dismissable popup, mow button
 * stays active). Mirrors NON_BLOCKING_ERRORS in HomeScreen.deriveMower.
 */
// 139 = "Charging station position error" — spurious [0,0,0] charging pose;
// the dock itself is fine, so treat as a non-blocking warning.
const NON_BLOCKING_ERRORS = [8, 113, 118, 120, 122, 123, 124, 125, 126, 132, 139];

/**
 * Idle-like work_status values (raw int form OR the server's translated
 * human label). Mirrors IDLE_WORK_STATES in the app.
 */
const IDLE_WORK_STATES = ['0', '9', '70', '72', 'Idle', 'Ready', 'Finished once', 'Cancelled'];

/** Recharge_status values that mean "driving back to the dock". */
// 50/53: stock 5.7.1 rapporteert de terugrit NA het afmaken met die codes
// (#31, live data waltervl); de msg matcht daar geen enkele regex. De
// numerieke match wordt onderdrukt bij "Recharge: FINISHED" in msg
// (laden-klaar is geen terugrit) als rem op blijven-hangen-waarden.
const RETURNING_RECHARGE_STATUS = new Set([1, 2, 50, 53, 191, 192, 193]);

/** recharge_status ruw ("50") of server-vertaald ("Charging (50)" / kaal
 *  "Charging" voor code 1) naar het nummer. */
export function parseRechargeStatus(value: string | undefined): number {
  if (value === 'Charging') return 1;
  return parseInt(value?.match(/\d+/)?.[0] ?? '0', 10);
}

/**
 * Derive `hasError` the same way the app does: error_status > 0 AND not one of
 * the non-blocking codes. Exported so callers that don't already have a
 * server-provided hasError can compute it identically.
 */
export function deriveHasError(sensors: Sensors): boolean {
  const errorStatusRaw = parseInt(sensors?.error_status?.match(/\d+/)?.[0] ?? '0', 10);
  return Boolean(errorStatusRaw > 0 && !NON_BLOCKING_ERRORS.includes(errorStatusRaw));
}

/**
 * Whether the current (paused / on-dock) state is a resumable, interrupted
 * coverage session — so the Start button should read "Resume" and dispatch
 * resume_navigation instead of a fresh start. Mirrors the app's
 * `isInterruptedCoverage` (HomeScreen.tsx ~2317-2338): current task_mode still
 * 1 (coverage), on dock, and the live Work msg shows a user/recharge pause.
 */
export function isInterruptedCoverage(sensors: Sensors): boolean {
  const taskMode = parseInt(sensors?.task_mode ?? '0', 10);
  const batteryState = (sensors?.battery_state ?? '').toUpperCase();
  const onDock = batteryState === 'CHARGING' || batteryState === 'FINISHED';
  const msg = sensors?.msg ?? '';
  const pausedForRecharge =
    /Work:USER_RECHARGE_STOP\b/.test(msg) || /Work:BATTERY_LOW_RECHARGE\b/.test(msg);
  const pausedByUser = /Work:USER_STOP\b/.test(msg) || /Work:PAUSED\b/.test(msg);
  // Stock 5.7.1 zet bij een accu-laadpauze midden in een beurt geen van de
  // msg-strings hierboven, maar work_status 12 ("Low power") — de sleutel uit
  // #30. Zelfde hervatbare pauze, dus zelfde Continue-gedrag.
  const ws = sensors?.work_status ?? '';
  const lowPowerPause = ws === '12' || ws === 'Low power';
  return onDock && taskMode === 1 && (pausedForRecharge || pausedByUser || lowPowerPause);
}

/**
 * `mowerBusy` — the mower is mid-task and would reject a duplicate
 * start_navigation (firmware Error 2). Mirrors the app's mowerBusy regexes
 * (HomeScreen.tsx ~2296-2299). Detected via the raw `msg` field only because
 * work_status arrives pre-translated in the socket snapshot.
 */
export function isMowerBusy(sensors: Sensors): boolean {
  const msg = sensors?.msg ?? '';
  return (
    /Work:(MOVING|COVERING|REQUEST_START|INIT_|RUNNING|MAPPING)/.test(msg) ||
    /Recharge:(MOVING|RUNNING|GOING)/.test(msg)
  );
}

/**
 * deriveMowerActivity — mirrors HomeScreen.deriveMower verbatim.
 *
 * @param sensors raw sensor cache (msg, task_mode, work_status, battery_state,
 *   recharge_status, edge_active, error_status, …)
 * @param opts.online   whether the device is online
 * @param opts.hasError whether a blocking error is present (pass the
 *   server-derived value, or omit and let it be recomputed from error_status)
 */
export function deriveMowerActivity(
  sensors: Sensors,
  opts: { online: boolean; hasError?: boolean },
): MowerActivity {
  const s = sensors ?? {};
  // The app maps offline → 'idle' (its MowerActivity has no 'offline'); the
  // dashboard wants an explicit 'offline' so it can disable the Start button.
  if (!opts.online) return 'offline';

  const hasError = opts.hasError ?? deriveHasError(sensors);

  const workStatus = s.work_status ?? '0';
  const batteryState = (s.battery_state ?? '').toUpperCase();
  const taskMode = parseInt(s.task_mode ?? '0', 10);
  // recharge_status komt ruw ("50") of vertaald ("Charging (50)", kaal
  // "Charging" voor code 1) binnen; parseInt op het label gaf NaN waardoor de
  // numerieke returning-lijst dode code was (#31). Zie parseRechargeStatus.
  const rechargeStatus = parseRechargeStatus(s.recharge_status);
  const msg = s.msg ?? '';

  // On dock = battery_state CHARGING (the app uses CHARGING here, NOT FINISHED,
  // for isOnDock — see HomeScreen.tsx:210). FINISHED is only treated as on-dock
  // for the interrupted-coverage / start-button gates, not activity priority.
  const isOnDock = batteryState === 'CHARGING';

  const isCoverageRunning =
    msg.includes('Work:RUNNING') ||
    msg.includes('Work:NAVIGATING') ||
    msg.includes('Work:COVERING') ||
    msg.includes('Work:MOVING') ||
    msg.includes('Work:QUIT_PILE_INIT') ||
    msg.includes('Work:SENSOR_INIT') ||
    msg.includes('Work:INIT_SUCCESS') ||
    msg.includes('Work:MAP_INIT') ||
    msg.includes('Work:BOUNDARY_COVERING') ||
    msg.includes('Work:AVOIDING');

  const isCoveragePaused =
    (msg.includes('Work:PAUSED') || msg.includes('Work:USER_STOP')) &&
    taskMode === 1 &&
    !isOnDock;

  const isDockFailed = msg.includes('Recharge: FAILED');

  const rechargeTerminal = /Recharge:\s*FINISHED/i.test(msg);
  const isReturning =
    ((RETURNING_RECHARGE_STATUS.has(rechargeStatus) && !rechargeTerminal) ||
      /Recharge:\s*(GOING|ALIGN_PILE|ALIGNING|MOVING|RUNNING|BACK|DOCKING)/i.test(msg) ||
      msg.includes('Work:GO_PILE') ||
      msg.includes('Work:BACK_CHARGER') ||
      msg.includes('Work:DOCKING')) &&
    !isDockFailed &&
    !isOnDock;

  const isMowingSticky =
    !isOnDock &&
    taskMode === 1 &&
    !isReturning &&
    !msg.includes('Work:FINISHED') &&
    !msg.includes('Work:CANCELLED') &&
    !IDLE_WORK_STATES.includes(workStatus);

  const isEdgeCutting = s.edge_active === '1' && !isOnDock;

  // Mapping: trust msg + task_mode; treat the post-save echo as DONE.
  const inMappingMode = taskMode === 2 || taskMode === 3 || msg.includes('Mode:MAPPING');
  const isMappingPostSave = msg.includes('Work:FINISHED') || msg.includes('Work:WAIT');
  const isMappingActive = inMappingMode && !isMappingPostSave;

  // Final priority — matches HomeScreen.tsx:276-287 exactly.
  let activity: MowerActivity = 'idle';
  if (hasError && !isOnDock) activity = 'error';
  else if (isDockFailed && !isOnDock) activity = 'error';
  else if (isEdgeCutting) activity = 'edge_cutting';
  else if (isCoverageRunning) activity = 'mowing';
  else if (isMappingActive) activity = 'mapping';
  else if (isCoveragePaused) activity = 'paused';
  else if (isReturning && !isOnDock) activity = 'returning';
  else if (isOnDock) activity = 'charging';
  else if (isMowingSticky) activity = 'mowing';

  return activity;
}
