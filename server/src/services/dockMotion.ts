import { randomUUID } from 'node:crypto';
import { publishToExtended } from '../mqtt/mapSync.js';
import type { MowerMapOperation } from './mowerMapOperation.js';
import { freshPositionState, stablePosition } from './positionTelemetry.js';
import { M, TextError, type Msg } from './serverText.js';

/** A stop on the mower, in words a user can act on; `raw` keeps the firmware's own reason for logs. */
export class DockMotionError extends TextError {
  constructor(msg: Msg, readonly raw = '') { super(msg); }
}

/**
 * The firmware's reason (extended_commands.py dock_measurement_move) as a
 * sentence with a next step. The raw reason, e.g. "motion telemetry stale:
 * /robot_combination_localization/combination_status", went straight to the
 * screen and meant nothing to anyone (Aaron, Oct 2026). The wizard adds its
 * own "return it to the dock and restart" hint underneath.
 */
export function readableDockMotionError(raw: string): Msg {
  const r = raw.toLowerCase();
  // Every movement needs RTK Fixed with fresh corrections; waiting does not
  // help when it stays without (Aaron: "RTK: ?" on the dock, Oct 2026).
  if (r.includes('rtk corrections')) {
    return M`De maaier verloor RTK-Fixed of zijn RTK-correcties tijdens de controle, daarom stopte hij voor de veiligheid. Start pas opnieuw als hier "RTK: Fixed" staat terwijl hij op het dock staat. Blijft dat uit, controleer dan of het laadstation stroom heeft en de antenne vrij zicht op de lucht heeft.`;
  }
  if (/telemetry stale|stamp stale|localization lost|localization jump|frame changed/.test(r)) {
    return M`De positiegegevens van de maaier vielen even weg, daarom stopte hij voor de veiligheid. Dat gebeurt soms vlak na het opstarten of bij een zwak RTK-signaal: wacht een minuut voordat je opnieuw begint.`;
  }
  if (r.includes('busy, low on battery')) return M`De maaier is bezig, heeft minder dan 30% accu of meldt een fout. Laat hem eerst opladen of los de fout op.`;
  if (r.includes('chassis stop')) return M`De STOP-knop, de pincodevergrendeling of een opgetilde of gekantelde maaier hield de controle tegen.`;
  if (r.includes('manual control')) return M`De joystick werd gebruikt tijdens de controle, daarom stopte die.`;
  if (r.includes('left the bounded dock approach')) return M`De maaier kwam buiten het veilige gebied vóór het laadstation en stopte.`;
  if (/dock pattern/.test(r)) return M`De camera zag het patroon op het laadstation niet goed. Maak de camera en het patroon schoon en zorg dat niets het zicht blokkeert.`;
  if (r.includes('without charging contact')) return M`De maaier reed naar het laadstation maar maakte geen laadcontact. Controleer of de laadcontacten schoon zijn en niets de maaier tegenhoudt.`;
  if (r.includes('reverse distance')) return M`De maaier kwam niet ver genoeg achteruit. Misschien slipten de wielen of stond er iets achter hem.`;
  if (r.includes('not stationary') || r.includes('dock contact at movement start')) return M`De maaier stond niet stil of niet op de verwachte plek toen de beweging moest beginnen.`;
  if (/not confirmed|stop button/.test(r)) return M`De maaier bevestigde niet dat hij gestopt is. Druk voor de zekerheid op de STOP-knop van de maaier.`;
  if (/unavailable|rejected|did not confirm/.test(r)) return M`Een onderdeel van de maaiersoftware reageerde niet. Herstart de maaier en probeer het opnieuw.`;
  if (/lease expired|heartbeat expired/.test(r)) return M`De verbinding met de server viel even weg tijdens de beweging, daarom stopte de maaier. Houd deze pagina open tijdens de controle.`;
  return M`De controle stopte op de maaier (${raw}).`;
}
/** A pose in the mower's current map frame (metres, radians). */
export type DockPose = { x: number; y: number; yaw: number };
/**
 * v4: a departure reports the pose the mower left from, and docking drives the
 * native visual action from a given charge pose. auto_recharge_server then
 * starts its camera approach directly (0.87..1.47 m in front, within 0.51 rad)
 * instead of the step-back search or nav2 (research/documents/auto-recharge-server-decompile.md).
 */
export const DOCK_MOTION_PROTOCOL = 'dock-measurement-motion-v4';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const isPose = (value: unknown): value is DockPose =>
  !!value && typeof value === 'object' && ['x', 'y', 'yaw'].every(k => Number.isFinite((value as Record<string, unknown>)[k]));

// The pose a mower last left its dock from, valid for one map frame revision.
// ponytail: in memory only; after a server restart the operator uses the joystick.
const departures = new Map<string, { pose: DockPose; revision: number }>();
export function rememberDockedPose(sn: string, pose: DockPose, revision: number): void { departures.set(sn, { pose, revision }); }
export function recallDockedPose(sn: string, revision: number): DockPose | undefined {
  const entry = departures.get(sn);
  return entry && entry.revision === revision ? entry.pose : undefined;
}

/**
 * The charge pose to dock back at after a departure. The mower reports its yaw
 * on the dock before the departure initializes its heading, so that yaw can
 * miss the docking axis (GH #158). Its x/y are in the current frame; saved dock
 * x/y may be shifted against it, but a re-anchor only shifts the origin, so the
 * saved dock heading holds in every frame. Without one, the departure pose stays.
 */
export function returnChargePose(departure: DockPose, savedOrientation: number | undefined): DockPose {
  return Number.isFinite(savedOrientation) ? { x: departure.x, y: departure.y, yaw: savedOrientation! } : departure;
}

/** Shared by source measurement, own-dock reanchoring and camera return. Native watchdog owns the actual stop. */
export async function guardedDockMove(sn: string, operation: MowerMapOperation,
  input: { action: 'reverse' | 'dock'; distance: number; fromDock: boolean; signature: string; chargePose?: DockPose },
  check: () => void, setMotion: (id?: string) => void = () => {},
  beforeMove: () => void = () => {},
): Promise<{ startPose?: DockPose }> {
  if (input.action === 'dock' && !isPose(input.chargePose)) throw new Error('Docking needs the measured dock pose the mower left from.');
  check();
  const id = randomUUID();
  const control = (action: 'keepalive' | 'stop') => publishToExtended(sn, { dock_measurement_control: { motion_id: id, action } });
  setMotion(id);
  let stopped: unknown;
  const timer = setInterval(() => {
    try { if (stopped) return; check(); control('keepalive'); }
    catch (error) { stopped = error; control('stop'); }
  }, 500);
  try {
    const armed = await operation.command('dock_measurement_control', { action: 'arm', motion_id: id }, 5_000);
    check();
    if (stopped) throw stopped;
    if (armed?.result !== 0 || armed?.protocol !== DOCK_MOTION_PROTOCOL) throw new TextError(M`Deze controle heeft nieuwere maaierfirmware nodig. Werk de firmware van de maaier bij en probeer het opnieuw.`);
    beforeMove();
    // A visual dock took 35 s live; the native lease allows 120 s.
    const result = await operation.command('dock_measurement_move', { action: input.action, distance_m: input.distance,
      from_dock: input.fromDock, recovery: operation.reanchor === true, motion_id: id, frame_fingerprint: input.signature,
      ...(input.chargePose ? { charge_pose: input.chargePose } : {}) }, input.action === 'dock' ? 100_000 : 60_000);
    if (result?.result !== 0 || result.protocol !== armed.protocol || result.frame_fingerprint !== input.signature ||
        (input.action === 'dock' && result.docked !== true)) {
      const raw = typeof result?.error === 'string' ? result.error : 'stop not confirmed';
      console.warn(`[DOCK-MOTION] ${sn}: ${input.action} stopped on the mower: ${raw}`);
      throw new DockMotionError(readableDockMotionError(raw), raw);
    }
    if (input.fromDock && !isPose(result.start_pose)) throw new DockMotionError(M`Deze controle heeft nieuwere maaierfirmware nodig. Werk de firmware van de maaier bij en probeer het opnieuw.`, 'no start_pose');
    if (stopped) throw stopped;
    check();
    return input.fromDock ? { startPose: result.start_pose as DockPose } : {};
  } finally { clearInterval(timer); control('stop'); setMotion(); }
}

/** All samples must follow the completed movement; cached dock poses cannot satisfy this. */
export async function settleDockMotion(sn: string, docked: boolean, check: () => void) {
  const after = Date.now(), deadline = performance.now() + 25_000;
  while (performance.now() < deadline) {
    check();
    const sample = stablePosition(sn, { after, docked });
    if (sample && (docked || !freshPositionState(sn).docked)) return sample;
    await sleep(250);
  }
  throw new TextError(M`De maaier kreeg na de beweging geen stabiele RTK Fixed-positie. Wacht tot RTK Fixed stabiel is voordat je opnieuw begint.`);
}
