import type { BleRespond } from './bleFrameAssembler';

/** Subscribe before writing: a BLE response can arrive before the write resolves. */
export function sendMappingCommand(
  response: string,
  send: () => Promise<void>,
  subscribe: (listener: (reply: BleRespond) => void) => () => void,
  timeoutMs: number,
  expected: { type?: unknown; cmd_num?: unknown } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let settled = false;
    let written = false;
    let acknowledged = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve();
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
        finish(new Error(`Map save not confirmed: ${typeof data.value === 'number' ? `error ${data.value}` : 'invalid save result'}.`));
      } else if (data.result !== 0 || (typeof data.value === 'number' && data.value !== 0)) {
        finish(new Error(`Mower rejected ${response}: error ${data.result || data.value}.`));
      } else {
        acknowledged = true;
        if (written) finish();
      }
    });
    Promise.resolve().then(send).then(() => {
      written = true;
      if (acknowledged) finish();
    }).catch(error => finish(error instanceof Error ? error : new Error(String(error))));
  });
}
