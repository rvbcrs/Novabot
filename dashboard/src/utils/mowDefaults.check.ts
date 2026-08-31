// Zelfcheck voor configuredHeightMm — de eenheid-heuristiek achter GH #105.
// Draaien: node --experimental-strip-types dashboard/src/utils/mowDefaults.check.ts
//
// ponytail: geen vitest in het dashboard en daar voegen we er geen toe voor
// één pure functie. node:test zit in de runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredHeightMm } from './mowDefaults.ts';

test('defaultCuttingHeight in mm blijft mm', () => {
  assert.equal(configuredHeightMm({ defaultCuttingHeight: '30' }), 30);
  assert.equal(configuredHeightMm({ defaultCuttingHeight: '90' }), 90);
});

test('defaultCuttingHeight als wire-enum wordt (n+2)*10', () => {
  assert.equal(configuredHeightMm({ defaultCuttingHeight: '0' }), 20);
  assert.equal(configuredHeightMm({ defaultCuttingHeight: '7' }), 90);
});

test('defaultCuttingHeight als user-cm wordt n*10', () => {
  assert.equal(configuredHeightMm({ defaultCuttingHeight: '8' }), 80);
  assert.equal(configuredHeightMm({ defaultCuttingHeight: '9' }), 90);
});

test('valt terug op target_height (wire-enum)', () => {
  assert.equal(configuredHeightMm({ target_height: '1' }), 30);
  assert.equal(configuredHeightMm({ defaultCuttingHeight: '', target_height: '2' }), 40);
});

test('null zolang er niets bruikbaars binnen is', () => {
  assert.equal(configuredHeightMm({}), null);
  assert.equal(configuredHeightMm({ defaultCuttingHeight: 'onzin' }), null);
  assert.equal(configuredHeightMm({ target_height: '99' }), null);
});

test('de bug uit GH #105: 3 cm ingesteld geeft geen 4 cm meer', () => {
  // Settings schrijft 30 mm naar de maaier; de Start-sheet moet 30 tonen,
  // niet de localStorage-default van 40.
  assert.equal(configuredHeightMm({ defaultCuttingHeight: '30' }), 30);
});
