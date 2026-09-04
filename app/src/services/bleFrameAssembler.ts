/**
 * Reassembles the mower's BLE notify stream into complete JSON frames.
 *
 * The firmware chunks every notify payload into ~20-byte writes and wraps a
 * message in the literal markers `ble_start` … `ble_end`. Interleaved with
 * those come the raw "bb"/"cc" telemetry chunks (first two bytes 0x62 0x62 or
 * 0x63 0x63) which are NOT part of any frame and must be dropped.
 *
 * This is the same parser the provisioning flow has had inline since day one,
 * lifted out so the mapping session can consume `*_respond` messages over BLE
 * too — without it, MappingScreen had to wait for those responds via the
 * server socket, which quietly made "BLE mapping" depend on the mower AND the
 * phone being online (GH #114).
 *
 * Pure: no BLE dependency, unit-tested in __tests__/bleFrameAssembler.test.ts.
 */

export interface BleRespond {
  /** e.g. "save_map_respond" */
  command: string;
  /** The `message` object: `{ result, value }` */
  data: unknown;
}

export class BleFrameAssembler {
  private buffer = '';
  private collecting = false;

  constructor(private readonly onFrame: (json: string) => void) {}

  /** Feed one raw notify chunk. */
  feed(raw: Uint8Array): void {
    if (raw.length >= 2 && (
      (raw[0] === 0x62 && raw[1] === 0x62) ||   // "bb" telemetry
      (raw[0] === 0x63 && raw[1] === 0x63)      // "cc" telemetry
    )) return;

    const str = utf8(raw);
    if (str === 'ble_start') { this.collecting = true; this.buffer = ''; return; }
    if (str === 'ble_end') {
      if (this.collecting) {
        this.collecting = false;
        const frame = this.buffer;
        this.buffer = '';
        this.onFrame(frame);
      }
      return;
    }
    if (this.collecting) this.buffer += str;
  }
}

/**
 * Parse a completed frame into a respond. The firmware's shape is
 * `{"type":"<cmd>_respond","message":{"result":…,"value":…}}` — identical to
 * what the server relays on the `command:respond` socket event, so listeners
 * can treat both sources the same. Returns null for anything else.
 */
export function parseBleRespond(frame: string): BleRespond | null {
  let parsed: unknown;
  try { parsed = JSON.parse(frame); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.type !== 'string' || !o.type.endsWith('_respond')) return null;
  return { command: o.type, data: o.message };
}

function utf8(bytes: Uint8Array): string {
  // Buffer is available in the app (polyfilled) and in node for tests.
  return Buffer.from(bytes).toString('utf8');
}
