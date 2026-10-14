// server/src/services/patrolService.ts
/**
 * Night patrol (OpenNova): settings, start/stop, and what the server does with
 * the mower's patrol_status stream and checkpoint reports.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
import { publishExtendedCommand } from '../mqtt/extendedCommands.js';
import { publishToTopic } from '../mqtt/mapSync.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { deviceCache } from '../mqtt/sensorData.js';
import { deviceSettingsRepo } from '../db/repositories/deviceSettings.js';
import { mapRepo } from '../db/repositories/maps.js';
import { isOpenNovaMower } from './mowerFileCapability.js';
import { isMowerBusy, goHome } from './mowingService.js';
import { isMowerMapOperationBusy } from './mowerMapOperation.js';
import { isFrameUnvalidated } from './frameValidation.js';
import { getPolygonAnchor } from './anchor.js';
import { customBuildNumber } from './firmwareAdvisory.js';
import { mowerSwVersion } from './mowingArea.js';
import { freshPositionState } from './positionTelemetry.js';
import { buildPatrolZones } from './patrolRoute.js';
import { dispatchPatrolDetectionEvent, dispatchPatrolFailedEvent } from '../notifications/eventDetector.js';
import { M, renderMsg, type Msg } from './serverText.js';

/** device_settings keys, written through POST /sensor-override/:sn. */
export const PATROL_KEYS = {
  zones: 'patrol_zones',            // JSON array of 'mapN'; empty = the dock's zone
  spacing: 'patrol_spacing_m',
  dwell: 'patrol_dwell_s',
  headlight: 'patrol_headlight',
  minPoints: 'patrol_min_points',
  photoTopic: 'patrol_photo_topic',
} as const;

export type PatrolPhotoTopic = 'front' | 'front_hd' | 'tof_gray';

export interface PatrolSettings {
  zones: string[];
  spacingM: number;
  dwellS: number;
  headlight: number;
  minPoints: number;
  photoTopic: PatrolPhotoTopic;
}

function clamp(raw: string | undefined, min: number, max: number, dflt: number): number {
  const n = Number(raw);
  return raw != null && raw !== '' && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}

export function readPatrolSettings(sn: string): PatrolSettings {
  const s = new Map(deviceSettingsRepo.findBySn(sn).map(r => [r.key, r.value] as const));
  let zones: string[] = [];
  try {
    const parsed: unknown = JSON.parse(s.get(PATROL_KEYS.zones) ?? '[]');
    if (Array.isArray(parsed)) zones = parsed.filter((z): z is string => typeof z === 'string' && /^map\d+$/.test(z));
  } catch { /* unreadable: no explicit choice */ }
  const topic = s.get(PATROL_KEYS.photoTopic);
  return {
    zones,
    spacingM: clamp(s.get(PATROL_KEYS.spacing), 3, 15, 6),
    dwellS: clamp(s.get(PATROL_KEYS.dwell), 3, 20, 6),
    headlight: Math.round(clamp(s.get(PATROL_KEYS.headlight), 0, 100, 100)),
    // Default from the Phase-0 night test (spec, "Phase 0 result").
    minPoints: Math.round(clamp(s.get(PATROL_KEYS.minPoints), 5, 2000, 40)),
    photoTopic: topic === 'front_hd' || topic === 'tof_gray' ? topic : 'front',
  };
}

/** First custom build whose extended_commands.py knows `patrol`. */
export const PATROL_MIN_BUILD = 50;
export const PATROL_MIN_BATTERY = 50;

export interface PatrolResult { ok: boolean; run?: string; error?: string; errorMsg?: Msg }

function refuse(msg: Msg): PatrolResult {
  return { ok: false, error: renderMsg('en', msg), errorMsg: msg };
}

// Mowers that left the dock for the current patrol (PHASE patrolling seen).
const outOnPatrol = new Set<string>();

/**
 * After an `error` the firmware cleans up asynchronously and cancels every
 * nav2 goal. A go_to_charge sent in the same breath could be one of the goals
 * it cancels, so the docking after an error waits this long.
 */
export const PATROL_HOME_DELAY_MS = 5000;
// The dockings that are waiting out PATROL_HOME_DELAY_MS, per mower.
const pendingHome = new Map<string, ReturnType<typeof setTimeout>>();

function cancelPendingHome(sn: string): void {
  clearTimeout(pendingHome.get(sn));
  pendingHome.delete(sn);
}

function goHomeAfterDelay(sn: string): void {
  cancelPendingHome(sn);   // a repeated error docks once, not twice
  pendingHome.set(sn, setTimeout(() => {
    pendingHome.delete(sn);
    goHome(sn);
  }, PATROL_HOME_DELAY_MS));
}

export function startPatrol(sn: string, now = Date.now()): PatrolResult {
  if (!isDeviceOnline(sn)) return refuse(M`maaier offline`);
  if (!isOpenNovaMower(sn, deviceCache.get(sn))) return refuse(M`vereist OpenNova custom firmware`);
  const build = customBuildNumber(mowerSwVersion(sn, deviceCache.get(sn)?.get('sw_version')));
  if (build == null || build < PATROL_MIN_BUILD) {
    return refuse(M`patrouille vereist custom firmware ${PATROL_MIN_BUILD} of nieuwer`);
  }
  if (isMowerBusy(sn)) return refuse(M`de maaier is bezig; stop de taak eerst`);
  if (isMowerMapOperationBusy(sn)) return refuse(M`er loopt een kaartbewerking; probeer het straks opnieuw`);
  // publishExtendedCommand would drop it silently in an unvalidated frame.
  if (isFrameUnvalidated(sn)) return refuse(M`het kaartframe is niet gevalideerd; her-anker eerst`);
  const battery = parseInt(deviceCache.get(sn)?.get('battery_power') ?? '', 10);
  if (Number.isFinite(battery) && battery < PATROL_MIN_BATTERY) {
    return refuse(M`accu te leeg voor een patrouille (${battery}%, minimaal ${PATROL_MIN_BATTERY}%)`);
  }
  const s = readPatrolSettings(sn);
  const zones = buildPatrolZones(mapRepo.findWorkMaps(sn), s.zones, s.spacingM, getPolygonAnchor(sn));
  if (!zones.length) return refuse(M`geen controlepunten: kies zones in de patrouille-instellingen`);
  const run = String(now);
  // The patrol that is about to start owns the mower: a docking still waiting
  // for the last one's error must not drive it home in the middle of this one,
  // and a last patrol whose end was lost (reboot, MQTT drop) must not make an
  // early error of this one count as "left the dock".
  cancelPendingHome(sn);
  outOnPatrol.delete(sn);
  publishExtendedCommand(sn, { patrol: { run, zones, dwell_s: s.dwellS, photo_topic: s.photoTopic } });
  console.log(`[Patrol] start ${sn} run=${run} ${zones.map(z => `${z.zone}:${z.points.length}`).join(',')}`);
  return { ok: true, run };
}

export function stopPatrol(sn: string): void {
  // A stop leaves the mower where it is, also when it was about to dock after an error.
  cancelPendingHome(sn);
  publishExtendedCommand(sn, { stop_mow_zone: {} });
}

/**
 * The mower's patrol_status stream (broker.ts). On `patrolling` the headlight
 * goes on. On every end it goes off FIRST, so the dock marker always sees the
 * stock light (CLAUDE.md, dock LED = stock). Then the mower is docked (goHome),
 * except after a stop, which leaves it where it is. It is docked when it left
 * the dock for this patrol (`patrolling` was seen) or when fresh telemetry says
 * it is off the dock: a departure that fails can leave it in front of the dock
 * without `patrolling` ever being reported. After `done` that happens at once,
 * after `error` it waits PATROL_HOME_DELAY_MS. A patrol that was refused before
 * anything moved never docks the mower: it is wherever its own task put it.
 */
export function onPatrolStatus(sn: string, phase: string, error?: string): void {
  const led = (level: number) => publishToTopic(`novabot/cmd/${sn}`, { led_set: level });
  if (phase === 'patrolling') {
    cancelPendingHome(sn);   // a patrol that is out owns the mower
    outOnPatrol.add(sn);
    const level = readPatrolSettings(sn).headlight;
    if (level > 0) led(level);
    return;
  }
  if (phase !== 'done' && phase !== 'error' && phase !== 'stopped') return;
  led(0);
  const wasOut = outOnPatrol.delete(sn);
  const dock = freshPositionState(sn);
  const offDock = dock.dockKnown && !dock.docked;
  // Refused before anything moved: the mower is wherever its own task put it.
  const refusedBeforeMotion = phase === 'error' && (error === 'busy_mowing' || error === 'no_dock_zone');
  const goesHome = phase !== 'stopped' && !refusedBeforeMotion && (wasOut || offDock);
  console.log(`[Patrol] ${sn} ${phase}${error ? ` (${error})` : ''}, ${goesHome ? 'sending it home' : 'leaving it'}`);
  if (goesHome) {
    if (phase === 'error') goHomeAfterDelay(sn);
    else goHome(sn);
  }
  if (phase === 'error') dispatchPatrolFailedEvent(sn, error || 'unknown', goesHome);
}

export interface PatrolFrameReport {
  run: string; seq: number; person: number; animal: number; frames: number; image: boolean;
}

/** null = no data (fewer than two perception frames), else the classes at or above the threshold. */
export function alertKinds(f: { person: number; animal: number; frames: number }, minPoints: number): Array<'person' | 'animal'> | null {
  if (f.frames < 2) return null;
  return (['person', 'animal'] as const).filter(k => f[k] >= minPoints);
}

export const PATROL_ALERT_GAP_MS = 120_000;
// ponytail: grows by a few keys per patrol night; prune when patrols run hourly.
const lastAlert = new Map<string, number>();

/** A checkpoint report: an alert per class, at most once per class per run per gap. */
export function onPatrolFrame(sn: string, f: PatrolFrameReport, now = Date.now()): Array<'person' | 'animal'> {
  const kinds = alertKinds(f, readPatrolSettings(sn).minPoints) ?? [];
  const out: Array<'person' | 'animal'> = [];
  for (const kind of kinds) {
    const key = `${sn}:${f.run}:${kind}`;
    if (now - (lastAlert.get(key) ?? -Infinity) < PATROL_ALERT_GAP_MS) continue;
    lastAlert.set(key, now);
    out.push(kind);
    dispatchPatrolDetectionEvent(sn, { run: f.run, seq: f.seq, kind, points: f[kind], image: f.image });
  }
  return out;
}

/** Tests only. */
export function _resetPatrolState(): void {
  outOnPatrol.clear();
  lastAlert.clear();
  for (const timer of pendingHome.values()) clearTimeout(timer);
  pendingHome.clear();
}
