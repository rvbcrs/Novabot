import type { BleRespond } from './bleFrameAssembler';

/** Explicit firmware rejection: this recording cannot be saved unchanged. */
export class MapSaveRejectedError extends Error {
  constructor(code: number) {
    const reasons: Record<number, string> = {
      1: 'the recorded boundary overlaps an existing work area. Record the area again without overlapping other work areas.',
      2: 'the recorded boundary overlaps an existing channel. Record the area again without overlapping the channel.',
      3: 'the recorded channel crosses more than two work areas. Record a channel connecting only two areas.',
    };
    super(`Map not saved: ${reasons[code] ?? 'the mower rejected this recording.'} (Error ${code})`);
  }
}

/** Subscribe before writing: a BLE response can arrive before the write resolves. */
export function sendMappingCommand(
  response: string,
  send: () => Promise<void>,
  subscribe: (listener: (reply: BleRespond) => void) => () => void,
  timeoutMs: number,
  expected: { type?: unknown; cmd_num?: unknown } = {},
): Promise<BleRespond> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let settled = false;
    let written = false;
    let acknowledged: BleRespond | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else if (acknowledged) resolve(acknowledged);
    };
    const timer = setTimeout(() => finish(new Error(
      `No confirmation from mower (${response}). Check Bluetooth before continuing; saving has not been confirmed.`,
    )), timeoutMs);
    unsubscribe = subscribe(reply => {
      if (reply.command !== response) return;
      const data = reply.data as { result?: unknown; value?: unknown; type?: unknown; cmd_num?: unknown } | null;
      // Some firmware echoes these fields; reject explicit mismatches.
      if (data?.type !== undefined && expected.type !== undefined && data.type !== expected.type) return;
      if (data?.cmd_num !== undefined && expected.cmd_num !== undefined && data.cmd_num !== expected.cmd_num) return;
      if (typeof data?.result !== 'number') {
        finish(new Error(`Invalid mower confirmation (${response}).`));
      } else if (response === 'save_map_respond' && data.value !== 0) {
        finish(typeof data.value === 'number' && Number.isFinite(data.value)
          ? new MapSaveRejectedError(data.value)
          : new Error('Map save not confirmed: invalid save result.'));
      } else if (data.result !== 0 || (typeof data.value === 'number' && data.value !== 0)) {
        finish(new Error(`Mower rejected ${response}: error ${data.result || data.value}.`));
      } else {
        acknowledged = reply;
        if (written) finish();
      }
    });
    Promise.resolve().then(send).then(() => {
      written = true;
      if (acknowledged) finish();
    }).catch(error => finish(error instanceof Error ? error : new Error(String(error))));
  });
}
