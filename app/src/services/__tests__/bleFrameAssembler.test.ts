import { describe, it, expect } from 'vitest';
import { BleFrameAssembler, parseBleRespond } from '../bleFrameAssembler';

const b = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

function collect() {
  const frames: string[] = [];
  const a = new BleFrameAssembler((f) => frames.push(f));
  return { a, frames };
}

describe('BleFrameAssembler', () => {
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
