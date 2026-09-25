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
    await withMowerMapOperation('A', async operation => {
      const write = operation.command('write_map_files', {}, 1000);
      await vi.waitFor(() => expect(mqtt.sent).toHaveLength(1));
      expect(isMapOperationCommandBlocked('A', mqtt.sent[0].body)).toBe(false);
      expect(isMapOperationCommandBlocked('A', { write_map_files: {} })).toBe(true);
      expect(isMapOperationCommandBlocked('A', { start_navigation: {} })).toBe(true);
      reply('A', mqtt.sent[0].body.write_map_files.operation_id);
      await write;
      expect(isMapOperationCommandBlocked('A', mqtt.sent[0].body)).toBe(true);
    });
  });
});
