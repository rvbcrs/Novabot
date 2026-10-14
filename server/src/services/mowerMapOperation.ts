import { randomUUID } from 'node:crypto';

export class MapOperationBusyError extends Error {
  readonly code = 'map_operation_busy';
  constructor(readonly sn: string) { super(`A map operation is already running for ${sn}`); }
}

export interface MowerMapOperation {
  readonly sn: string;
  readonly id: string;
  command(cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null>;
  onManualControl?: () => void;
  readonly reanchor?: boolean;
}

const active = new Map<string, MowerMapOperation>();
const ownedCommands = new Map<string, Set<string>>();
const NAVIGATION_COMMANDS = new Set(['go_to_charge', 'start_navigation', 'start_run', 'start_edge_cut', 'mow_zone', 'auto_recharge', 'go_pile', 'nav_to_point', 'follow_unicom', 'return_to_dock', 'calibration_drive', 'patrol']);
const MANAGED_COMMANDS = new Set(['write_map_files', 'sync_map', 'regenerate_per_map_files', 'reanchor_pos', 'set_pos_origin', 'dock_measurement_move']);
export function isOwnedReanchorMotion(sn: string, params: unknown): boolean {
  const id = params && typeof params === 'object' ? (params as Record<string, unknown>).operation_id : undefined;
  return active.get(sn)?.reanchor === true && typeof id === 'string' && ownedCommands.get(sn)?.has(id) === true;
}
const MAP_COMMANDS = new Set(['measure_dock_marker', 'measure_runtime_frame', 'read_map_files', 'write_map_files', 'sync_map', 'regenerate_per_map_files', 'reanchor_pos', 'set_pos_origin', 'restart_mapping', 'set_coverage_planner_radius', 'save_map', 'delete_map', 'save_recharge_pos', 'start_mapping']);

export function isMowerMapOperationBusy(sn: string): boolean { return active.has(sn); }

/** Autonomous navigation cannot race a map install. Joystick/manual stops remain available. */
export function isMapOperationCommandBlocked(sn: string, command: Record<string, unknown>): boolean {
  if ('recalibrate_charging_pose' in command) return true; // Retired unsafe dock writer, including raw MQTT.
  return Object.entries(command).some(([cmd, params]) => {
    const busy = active.has(sn);
    if (busy && ['start_move', 'stop_move', 'mst', 'stop_navigation', 'stop_task', 'stop_run', 'pause_navigation', 'pause_run', 'stop_to_charge', 'stop_mow_zone', 'stop_boundary_follow'].includes(cmd)) active.get(sn)?.onManualControl?.();
    if (cmd === 'dock_measurement_control' && (params as { action?: string } | null)?.action === 'arm') {
      const id = (params as { operation_id?: string }).operation_id;
      return !id || !ownedCommands.get(sn)?.has(id);
    }
    if (busy && NAVIGATION_COMMANDS.has(cmd)) return true;
    if (!MANAGED_COMMANDS.has(cmd) && (!busy || !MAP_COMMANDS.has(cmd))) return false;
    const id = params && typeof params === 'object' ? (params as Record<string, unknown>).operation_id : undefined;
    return typeof id !== 'string' || !ownedCommands.get(sn)?.has(id);
  });
}

/** Keep the lease through device verification AND the caller's DB commit. */
export async function withMowerMapOperation<T>(sn: string, run: (operation: MowerMapOperation) => Promise<T>, reanchor = false): Promise<T> {
  if (active.has(sn)) throw new MapOperationBusyError(sn);
  const operation: MowerMapOperation = {
    sn, reanchor,
    id: randomUUID(),
    command: (cmd, params, timeoutMs) => awaitExtended(sn, cmd, params, timeoutMs, operation),
  };
  active.set(sn, operation);
  try { return await run(operation); }
  finally { active.delete(sn); ownedCommands.delete(sn); }
}

/** A caller-provided lease must still be held for this mower. */
export function assertMowerMapOperation(sn: string, operation: MowerMapOperation): void {
  if (operation.sn !== sn || active.get(sn) !== operation) throw new Error('Map operation lease is no longer active');
}

/** Uncorrelated/late responses never complete this command. Null means an unknown outcome. */
export async function awaitExtended(
  sn: string, cmd: string, params: Record<string, unknown>, timeoutMs: number, owner?: MowerMapOperation,
): Promise<Record<string, unknown> | null> {
  const { publishToExtended, onExtendedResponse, offExtendedResponse } = await import('../mqtt/mapSync.js');
  const operationId = randomUUID();
  if (owner) {
    assertMowerMapOperation(sn, owner);
    if (!ownedCommands.has(sn)) ownedCommands.set(sn, new Set());
    ownedCommands.get(sn)!.add(operationId);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ownedCommands.get(sn)?.delete(operationId);
      offExtendedResponse(sn, handler);
      resolve(result);
    };
    const handler = (data: Record<string, unknown>) => {
      const response = data[`${cmd}_respond`] as Record<string, unknown> | undefined;
      if (response?.operation_id === operationId) finish(response);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    onExtendedResponse(sn, handler);
    try {
      publishToExtended(sn, { [cmd]: { ...params, operation_id: operationId } });
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      ownedCommands.get(sn)?.delete(operationId);
      offExtendedResponse(sn, handler);
      reject(error);
    }
  });
}

/** Reading also holds the shared lease: it cannot race one of our map writers. */
export async function readMowerMapSnapshot(sn: string, operation?: MowerMapOperation): Promise<Record<string, unknown> | null> {
  if (!operation) return withMowerMapOperation(sn, lease => readMowerMapSnapshot(sn, lease));
  assertMowerMapOperation(sn, operation);
  return operation.command('read_map_files', {}, 30_000);
}
