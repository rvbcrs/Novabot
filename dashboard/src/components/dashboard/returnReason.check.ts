// Zelfcheck: wanneer de "waarom op het dock"-modal mag poppen.
// Draaien: npx tsx dashboard/src/components/dashboard/returnReason.check.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backOnDock } from './returnReason.ts';

test('terug op het dock na maaien, randmaaien of terugrijden', () => {
  for (const prev of ['mowing', 'edge_cutting', 'returning']) assert.equal(backOnDock(prev, 'charging'), true);
});

test('GH #163: een korte USER_STOP vlak na vertrek is geen terugkeer', () => {
  assert.equal(backOnDock('edge_cutting', 'paused'), false);
  assert.equal(backOnDock('mowing', 'returning'), false);
});

test('een pagina die laadt met een gedockte maaier popt niet', () => {
  assert.equal(backOnDock(null, 'charging'), false);
});
