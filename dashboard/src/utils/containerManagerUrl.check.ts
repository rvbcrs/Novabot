// Zelfcheck voor normalizeManagerUrl — deze waarde wordt door de gebruiker
// getypt en belandt rechtstreeks in een href, dus de protocol-guard moet blijven.
// Draaien: node --experimental-strip-types dashboard/src/utils/containerManagerUrl.check.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManagerUrl } from './containerManagerUrl.ts';

test('accepteert http en https', () => {
  assert.equal(normalizeManagerUrl('http://192.168.1.10:9000'), 'http://192.168.1.10:9000/');
  assert.equal(normalizeManagerUrl('https://portainer.lan/#/containers'), 'https://portainer.lan/#/containers');
  assert.equal(normalizeManagerUrl('  http://nas:9443  '), 'http://nas:9443/');
});

test('weigert alles wat geen http(s) is', () => {
  // Dit is de eigenlijke reden dat deze functie bestaat.
  assert.equal(normalizeManagerUrl('javascript:alert(1)'), null);
  assert.equal(normalizeManagerUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(normalizeManagerUrl('file:///etc/passwd'), null);
  assert.equal(normalizeManagerUrl('JavaScript:alert(1)'), null);
});

test('leeg of onzin telt als niet ingesteld', () => {
  assert.equal(normalizeManagerUrl(''), null);
  assert.equal(normalizeManagerUrl('   '), null);
  assert.equal(normalizeManagerUrl('portainer.lan:9000'), null); // geen schema
  assert.equal(normalizeManagerUrl('zomaar tekst'), null);
});
