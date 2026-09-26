import { positionTelemetry, POSITION_MAX_AGE_MS } from './positionTelemetry.js';
/**
 * Hoe ver het toepassen van een kaart op de maaier is, als virtuele sensor
 * (`map_apply_phase`, `map_apply_error`) die live naar het dashboard gaat.
 *
 * Een getekende of gekopieerde zone staat meteen in de database en dus op de
 * kaart, maar de maaier is pas klaar na sync_map (zip ophalen, novabot_mapping
 * en de coverage planner herstarten), regenerate_per_map_files (grids per
 * slot) en het terugkomen van de planner. Tijdens die herstart meldt
 * robot_decision Error 140 "Process crashed"; live gezien op LFIN2230700238
 * 2026-09-24 van 15:17:15 tot 15:17:25, zo'n 50 s na de kopie. Zonder deze
 * status leek Start zonder reden geblokkeerd ("Clear error first").
 */
import { deviceCache } from '../mqtt/sensorData.js';
import { forwardToDashboard } from '../dashboard/socketHandler.js';

export type MapApplyPhase = 'syncing' | 'regenerating' | 'settling';
export type MapApplyError = 'sync_timeout' | 'sync_failed' | 'regenerate_timeout' | 'regenerate_failed' | 'planner_timeout' | 'map_operation_busy';
export const PHASE_KEY = 'map_apply_phase';
export const ERROR_KEY = 'map_apply_error';

/** Error 140: robot_decision mist novabot_mapping of coverage_planner_server, die sync_map herstart. */
export const PROCESS_RESTART_ERROR = 140;

/**
 * ponytail: vaste wachttijden. robot_decision checkt processen elke 5 s, dus
 * 10 s na regenerate heeft een resterende 140 zich gemeld. Tests zetten ze laag.
 */
export const mapApplyTiming = { settleMinMs: 10_000, settleMaxMs: 90_000, pollMs: 1_000 };

const latest = new Map<string, number>();

function publish(sn: string, phase: string, error: string): void {
  if (!deviceCache.has(sn)) deviceCache.set(sn, new Map());
  const cache = deviceCache.get(sn)!;
  const changes = new Map<string, string>([[PHASE_KEY, phase], [ERROR_KEY, error]]);
  for (const [k, v] of changes) cache.set(k, v);
  forwardToDashboard(sn, changes);
}

export interface MapApply {
  phase(p: MapApplyPhase): void;
  fail(error: MapApplyError): void;
  done(): void;
}

/** Start een toepas-run. Alleen de nieuwste run per maaier mag de status zetten. */
export function beginMapApply(sn: string): MapApply {
  const token = (latest.get(sn) ?? 0) + 1;
  latest.set(sn, token);
  const current = () => latest.get(sn) === token;
  return {
    phase: p => { if (current()) publish(sn, p, ''); },
    fail: e => { if (current()) publish(sn, 'failed', e); },
    done: () => { if (current()) publish(sn, '', ''); },
  };
}

/** Foutcode uit een ruwe ('140') of vertaalde ('Error (140)', 'OK') error_status. */
export function errorCodeOf(raw: string | undefined): number {
  return parseInt(raw?.match(/\d+/)?.[0] ?? '0', 10) || 0;
}

/**
 * Wacht tot de door sync_map herstarte processen terug zijn: minstens
 * settleMinMs, en daarna zodra error_status geen 140 meer is. Een andere fout
 * hoort niet bij de push en houdt de status niet vast.
 */
export async function waitForPlannerBack(sn: string, t = mapApplyTiming): Promise<'settled' | 'timeout'> {
  const start = Date.now();
  for (;;) {
    const elapsed = Date.now() - start;
    const reading = positionTelemetry(sn)?.error;
    const code = reading?.value;
    if (elapsed >= t.settleMinMs && reading && reading.at >= start && Date.now() - reading.at <= POSITION_MAX_AGE_MS && Number.isFinite(code) && code !== PROCESS_RESTART_ERROR) return 'settled';
    if (elapsed >= t.settleMaxMs) return 'timeout';
    await new Promise(r => setTimeout(r, t.pollMs));
  }
}
