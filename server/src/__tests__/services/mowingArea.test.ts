/**
 * The zone selection is a decimal positional bitmask (map0 = 1, map1 = 10, ...).
 * robot_decision swaps any value above 60000, or exactly 255, for a leftover
 * test task before decoding it, and the planner then reports error 125 (GH #114).
 *
 * Our own mow_zone orchestrator sends map file names instead from the build in
 * MAP_NAMES_SELECTION_BUILD on, which is decoded after that check. Those mowers
 * must not be blocked. The stock commands stay blocked: their handler in
 * mqtt_node has no field for names.
 */
import { describe, it, expect } from 'vitest';
import { getMowingAreaError } from '../../services/mowingArea.js';
import { supportsMapNamesSelection } from '../../services/mowingArea.js';

describe('getMowingAreaError', () => {
  it('laat de vijf bereikbare zones door', () => {
    for (const area of [1, 10, 100, 1000, 10000, 11111]) {
      expect(getMowingAreaError({ start_navigation: { area } }), `area=${area}`).toBeNull();
    }
  });

  it('blokkeert slot 5 en hoger op het stock-commando', () => {
    expect(getMowingAreaError({ start_navigation: { area: 100000 } })).toMatch(/map0–map4/);
    expect(getMowingAreaError({ start_navigation: { area: 255 } })).toMatch(/map0–map4/);
  });

  it('blokkeert mow_zone nog steeds op firmware zonder namenselectie', () => {
    expect(getMowingAreaError({ mow_zone: { area: 100000 } })).toMatch(/map0–map4/);
    expect(getMowingAreaError({ mow_zone: { map: 'map5' } })).toMatch(/map0–map4/);
  });

  it('laat mow_zone door zodra de maaier op namen kan selecteren', () => {
    const opts = { swVersion: 'v6.0.2-custom-38' };
    expect(getMowingAreaError({ mow_zone: { area: 100000 } }, opts)).toBeNull();
    expect(getMowingAreaError({ mow_zone: { map: 'map6' } }, opts)).toBeNull();
  });

  it('houdt het stock-commando geblokkeerd, ook op zo een maaier', () => {
    // mqtt_node's start-handler leest alleen hoogte en zonegetal; namen kunnen
    // daar niet in, dus deze weg blijft op error 125 uitkomen.
    expect(getMowingAreaError({ start_navigation: { area: 100000 } }, { swVersion: 'v6.0.2-custom-38' }))
      .toMatch(/map0–map4/);
  });

  it('weigert onzin-waarden', () => {
    expect(getMowingAreaError({ start_navigation: { area: -1 } })).toMatch(/Invalid/);
    expect(getMowingAreaError({ start_navigation: { area: '0x1' } })).toMatch(/Invalid/);
  });
});

describe('supportsMapNamesSelection', () => {
  it('herkent de build die op namen selecteert', () => {
    expect(supportsMapNamesSelection('v6.0.2-custom-38')).toBe(true);
    expect(supportsMapNamesSelection('v6.0.2-custom-41')).toBe(true);
  });

  it('wijst oudere builds en stock af', () => {
    expect(supportsMapNamesSelection('v6.0.2-custom-37')).toBe(false);
    expect(supportsMapNamesSelection('v6.0.2')).toBe(false);
    expect(supportsMapNamesSelection('5.7.1')).toBe(false);
    expect(supportsMapNamesSelection(null)).toBe(false);
    expect(supportsMapNamesSelection(undefined)).toBe(false);
  });
});
