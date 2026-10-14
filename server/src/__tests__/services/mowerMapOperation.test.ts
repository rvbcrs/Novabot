import { beforeEach, describe, expect, it, vi } from 'vitest';

const mqtt = vi.hoisted(() => ({
  sent: [] as Array<{ sn: string; body: Record<string, Record<string, unknown>> }>,
  handlers: new Map<string, Set<(data: Record<string, unknown>) => void>>(),
}));
vi.mock('../../mqtt/mapSync.js', () => ({
  publishToExtended: (sn: string, body: Record<string, Record<string, unknown>>) => mqtt.sent.push({ sn, body }),
  onExtendedResponse: (sn: string, handler: (data: Record<string, unknown>) => void) => {
    if (!mqtt.handlers.has(sn)) mqtt.handlers.set(sn, new Set());
    mqtt.handlers.get(sn)!.add(handler);
  },
  offExtendedResponse: (sn: string, handler: (data: Record<string, unknown>) => void) => mqtt.handlers.get(sn)?.delete(handler),
}));
import { awaitExtended, withMowerMapOperation, isMowerMapOperationBusy, assertMowerMapOperation, isMapOperationCommandBlocked, type MowerMapOperation } from '../../services/mowerMapOperation.js';

function reply(sn: string, operationId?: unknown) {
  for (const handler of mqtt.handlers.get(sn) ?? []) handler({ write_map_files_respond: { result: 0, operation_id: operationId } });
}

describe('mower map operations', () => {
  beforeEach(() => { mqtt.sent.length = 0; mqtt.handlers.clear(); });

  it('keeps one mower lease through the caller commit, releases after exceptions, and allows another mower', async () => {
    let expired: MowerMapOperation | undefined;
    await expect(withMowerMapOperation('A', async operation => {
      expired = operation;
      expect(isMowerMapOperationBusy('A')).toBe(true);
      await expect(withMowerMapOperation('A', async () => {})).rejects.toMatchObject({ code: 'map_operation_busy' });
      await withMowerMapOperation('B', async () => {});
      assertMowerMapOperation('A', operation);
      throw new Error('DB commit failed');
    })).rejects.toThrow('DB commit failed');
    expect(isMowerMapOperationBusy('A')).toBe(false);
    expect(() => assertMowerMapOperation('A', expired!)).toThrow();
  });

  it('ignores legacy responses, wrong mower, and late responses from a timed-out command', async () => {
    const first = awaitExtended('A', 'write_map_files', {}, 30);
    await vi.waitFor(() => expect(mqtt.sent).toHaveLength(1));
    const oldId = mqtt.sent[0].body.write_map_files.operation_id;
    reply('A');
    reply('B', oldId);
    expect(await first).toBeNull();
    const second = awaitExtended('A', 'write_map_files', {}, 1000);
    await vi.waitFor(() => expect(mqtt.sent).toHaveLength(2));
    const newId = mqtt.sent[1].body.write_map_files.operation_id;
    expect(newId).not.toBe(oldId);
    reply('A', oldId);
    expect(mqtt.handlers.get('A')?.size).toBe(1);
    reply('A', newId);
    expect(await second).toMatchObject({ result: 0, operation_id: newId });
    expect(mqtt.handlers.get('A')?.size).toBe(0);
  });

  it('allows only the lease owner to publish a map mutation while blocking autonomous navigation', async () => {
    expect(isMapOperationCommandBlocked('A', { write_map_files: {} })).toBe(true);
    expect(isMapOperationCommandBlocked('A', { sync_map: {} })).toBe(true);
    expect(isMapOperationCommandBlocked('A', { save_map: {} })).toBe(false);
    await withMowerMapOperation('A', async operation => {
      const write = operation.command('write_map_files', {}, 1000);
      await vi.waitFor(() => expect(mqtt.sent).toHaveLength(1));
      expect(isMapOperationCommandBlocked('A', mqtt.sent[0].body)).toBe(false);
      expect(isMapOperationCommandBlocked('A', { write_map_files: {} })).toBe(true);
      expect(isMapOperationCommandBlocked('A', { start_navigation: {} })).toBe(true);
      expect(isMapOperationCommandBlocked('A', { measure_dock_marker: {} })).toBe(true);
      reply('A', mqtt.sent[0].body.write_map_files.operation_id);
      await write;
      const measure = operation.command('measure_dock_marker', {}, 1000);
      await vi.waitFor(() => expect(mqtt.sent).toHaveLength(2));
      expect(isMapOperationCommandBlocked('A', mqtt.sent[1].body)).toBe(false);
      for (const handler of mqtt.handlers.get('A') ?? []) handler({ measure_dock_marker_respond: { result: 0, operation_id: mqtt.sent[1].body.measure_dock_marker.operation_id } });
      await measure;
      expect(isMapOperationCommandBlocked('A', mqtt.sent[0].body)).toBe(true);
    });
  });
});

it('owns measurement motion and arm commands, while stop/manual control interrupts its cycle', async () => {
  expect(isMapOperationCommandBlocked('A', { dock_measurement_move: {} })).toBe(true);
  expect(isMapOperationCommandBlocked('A', { dock_measurement_control: { action: 'arm' } })).toBe(true);
  await withMowerMapOperation('A', async operation => {
    const interrupted = vi.fn(); operation.onManualControl = interrupted;
    for (const cmd of ['dock_measurement_move', 'dock_measurement_control']) {
      const count = mqtt.sent.length;
      const pending = operation.command(cmd, { action: cmd === 'dock_measurement_control' ? 'arm' : 'reverse' }, 1000);
      await vi.waitFor(() => expect(mqtt.sent).toHaveLength(count + 1));
      const body = mqtt.sent.at(-1)!.body;
      expect(isMapOperationCommandBlocked('A', body)).toBe(false);
      for (const handler of mqtt.handlers.get('A') ?? []) handler({ [`${cmd}_respond`]: { result: 0, operation_id: body[cmd].operation_id } });
      await pending;
      expect(isMapOperationCommandBlocked('A', body)).toBe(true);
    }
    for (const command of ['start_move', 'stop_move', 'mst', 'stop_navigation', 'stop_task', 'stop_run', 'pause_navigation', 'pause_run', 'stop_to_charge', 'stop_mow_zone', 'stop_boundary_follow']) {
      interrupted.mockClear();
      expect(isMapOperationCommandBlocked('A', { [command]: {} })).toBe(false);
      expect(interrupted).toHaveBeenCalledOnce();
    }
    expect(isMapOperationCommandBlocked('A', { dock_measurement_control: { action: 'stop' } })).toBe(false);
    expect(isMapOperationCommandBlocked('A', { go_to_charge: {} })).toBe(true);
    expect(isMapOperationCommandBlocked('A', { patrol: {} })).toBe(true);
  });
});

it('permits only a correlated recovery motion through the frame guard and never a legacy dock write', async () => {
  const { isFrameNavBlocked, markFrameUnvalidated, clearFrameUnvalidated, markMapInstallPending, clearMapInstallPending } = await import('../../services/frameValidation.js');
  const sn = 'LFIN_RECOVERY_GUARD';
  markFrameUnvalidated(sn);
  for (const recovery of [false, true]) {
    await withMowerMapOperation(sn, async operation => {
      const pending = operation.command('dock_measurement_move', { action: 'reverse', recovery }, 1000);
      await vi.waitFor(() => expect(mqtt.sent.at(-1)?.sn).toBe(sn));
      const body = mqtt.sent.at(-1)!.body;
      expect(isFrameNavBlocked(sn, body)).toBe(!recovery);
      expect(isFrameNavBlocked(sn, { dock_measurement_move: { ...body.dock_measurement_move, operation_id: 'forged' } })).toBe(true);
      expect(isFrameNavBlocked(sn, { ...body, start_navigation: {} })).toBe(true);
      markMapInstallPending(sn);
      expect(isFrameNavBlocked(sn, body)).toBe(true); clearMapInstallPending(sn);
      expect(isMapOperationCommandBlocked(sn, { recalibrate_charging_pose: body.dock_measurement_move })).toBe(true);
      for (const handler of mqtt.handlers.get(sn) ?? []) handler({ dock_measurement_move_respond: { result: 0, operation_id: body.dock_measurement_move.operation_id } });
      await pending;
      expect(isFrameNavBlocked(sn, body)).toBe(true);
    }, recovery);
    mqtt.sent.length = 0;
  }
  clearFrameUnvalidated(sn);
  expect(isMapOperationCommandBlocked(sn, { recalibrate_charging_pose: { force: true } })).toBe(true);
});
