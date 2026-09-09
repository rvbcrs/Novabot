import { describe, it, expect } from 'vitest';
import { BleFrameAssembler, parseBleRespond, parseBleTelemetry } from '../bleFrameAssembler';

const b = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

function collect() {
  const frames: string[] = [];
  const a = new BleFrameAssembler((f) => frames.push(f));
  return { a, frames };
}

describe('BleFrameAssembler', () => {
  it('accepts the NUL-terminated markers sent by stock firmware for stop/save acknowledgements', () => {
    const { a, frames } = collect();
    // Extracted start_tag/end_tag ELF symbols, v6.0.0/v6.0.2/v6.0.3.
    const start = new Uint8Array(Buffer.from('626c655f737461727400', 'hex'));
    const end = new Uint8Array(Buffer.from('626c655f656e6400', 'hex'));
    for (const command of ['stop_scan_map_respond', 'save_map_respond']) {
      const json = JSON.stringify({ type: command, message: { result: 0, value: command === 'save_map_respond' ? 0 : null } });
      a.feed(start);
      for (let i = 0; i < json.length; i += 20) a.feed(b(json.slice(i, i + 20)));
      a.feed(end);
      expect(parseBleRespond(frames[frames.length - 1])).toEqual({
        command, data: { result: 0, value: command === 'save_map_respond' ? 0 : null },
      });
    }
    expect(frames).toHaveLength(2);
  });

  it('plakt chunks tussen ble_start en ble_end aan elkaar', () => {
    const { a, frames } = collect();
    a.feed(b('ble_start'));
    a.feed(b('{"type":"save_map_'));
    a.feed(b('respond","message":'));
    a.feed(b('{"result":0,"value":0}}'));
    a.feed(b('ble_end'));
    expect(frames).toEqual(['{"type":"save_map_respond","message":{"result":0,"value":0}}']);
  });

  it('negeert bb/cc-telemetrie, ook midden in een frame', () => {
    const { a, frames } = collect();
    a.feed(b('ble_start'));
    a.feed(b('{"type":"x_respond",'));
    a.feed(new Uint8Array([0x62, 0x62, 1, 2, 3]));
    a.feed(new Uint8Array([0x63, 0x63, 9]));
    a.feed(b('"message":null}'));
    a.feed(b('ble_end'));
    expect(frames).toEqual(['{"type":"x_respond","message":null}']);
  });

  it('data buiten een frame wordt weggegooid; ble_end zonder start doet niets', () => {
    const { a, frames } = collect();
    a.feed(b('rommel'));
    a.feed(b('ble_end'));
    a.feed(b('ble_start'));
    a.feed(b('A'));
    a.feed(b('ble_end'));
    expect(frames).toEqual(['A']);
  });

  it('een nieuwe ble_start reset een half frame', () => {
    const { a, frames } = collect();
    a.feed(b('ble_start'));
    a.feed(b('oud'));
    a.feed(b('ble_start'));
    a.feed(b('nieuw'));
    a.feed(b('ble_end'));
    expect(frames).toEqual(['nieuw']);
  });
});

describe('parseBleRespond', () => {
  it('geeft command + message terug in de vorm van het socket-event', () => {
    const r = parseBleRespond('{"type":"save_recharge_pos_respond","message":{"result":0,"value":{"dis":0.47}}}');
    expect(r).toEqual({ command: 'save_recharge_pos_respond', data: { result: 0, value: { dis: 0.47 } } });
  });

  it('null voor niet-responds en kapotte JSON', () => {
    expect(parseBleRespond('{"type":"report_state_robot","message":{}}')).toBeNull();
    expect(parseBleRespond('{"foo":1}')).toBeNull();
    expect(parseBleRespond('{niet json')).toBeNull();
  });
});

describe('parseBleTelemetry', () => {
  it('decodes stock bb positions in all quadrants and distinguishes work/channel closure', () => {
    const raw = new Uint8Array(20);
    raw.set([0x62, 0x62]);
    raw.set([12, 34, 0, 56], 16);
    for (const [sign, x, y] of [[0, 12.34, 0.56], [0x10, -12.34, 0.56], [1, 12.34, -0.56], [0x11, -12.34, -0.56]]) {
      raw[15] = sign;
      raw[8] = 0x10; // channel closed alone does not close a work polygon
      expect(parseBleTelemetry(raw)).toMatchObject({ position: { x, y }, closedCycle: false });
      raw[8] = 0x11;
      expect(parseBleTelemetry(raw)?.closedCycle).toBe(true);
    }
  });

  it('decodes live bb status at the firmware offsets without inventing RTK quality', () => {
    const raw = new Uint8Array(20);
    raw.set([0x62, 0x62, 9, 1, 28, 9, 9, 1, 0, 9, 76]);
    expect(parseBleTelemetry(raw)).toEqual({
      position: { x: 0, y: 0 }, closedCycle: false,
      satellites: 28, localized: true, batteryPercent: 76,
    });
    raw[7] = 0;
    raw[10] = 0;
    expect(parseBleTelemetry(raw)).toMatchObject({ localized: false, batteryPercent: 0 });
    raw[7] = 2;
    raw[10] = 255;
    expect(parseBleTelemetry(raw)).toMatchObject({
      position: { x: 0, y: 0 }, localized: undefined, batteryPercent: undefined,
    });
  });

  it('decodes cc heading in radians, without inventing a position', () => {
    const raw = new Uint8Array(20);
    raw.set([0x63, 0x63, 1, 3, 14]);
    expect(parseBleTelemetry(raw)).toEqual({ orientation: -3.14 });
    raw[2] = 0;
    expect(parseBleTelemetry(raw)).toEqual({ orientation: 3.14 });
  });

  it('rejects truncated, malformed and non-telemetry packets', () => {
    expect(parseBleTelemetry(new Uint8Array([0x62, 0x62]))).toBeNull();
    expect(parseBleTelemetry(b('ble_start'))).toBeNull();
    const raw = new Uint8Array(20);
    raw.set([0x62, 0x62]);
    raw[17] = 100;
    expect(parseBleTelemetry(raw)).toBeNull();
    raw[17] = 0;
    raw[15] = 0x02;
    expect(parseBleTelemetry(raw)).toBeNull();
    raw.set([0x63, 0x63, 0, 3, 15]);
    expect(parseBleTelemetry(raw)).toBeNull();
  });
});
