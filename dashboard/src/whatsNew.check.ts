// Zelfcheck voor unseenWhatsNew.
// Draaien: node --experimental-strip-types dashboard/src/whatsNew.check.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unseenWhatsNew, type WhatsNewEntry } from './whatsNew.ts';

const entry = (id: string, date: string): WhatsNewEntry => ({ id, date, video: '', poster: '' });
const now = Date.parse('2026-10-01');

test('shows a recent entry that was not seen', () => {
  assert.deepEqual(unseenWhatsNew([entry('a', '2026-09-23')], [], now).map(e => e.id), ['a']);
});

test('skips what this browser has seen', () => {
  assert.deepEqual(unseenWhatsNew([entry('a', '2026-09-23')], ['a'], now), []);
});

test('keeps old news away from newcomers', () => {
  assert.deepEqual(unseenWhatsNew([entry('old', '2026-06-01'), entry('new', '2026-09-30')], [], now).map(e => e.id), ['new']);
});
