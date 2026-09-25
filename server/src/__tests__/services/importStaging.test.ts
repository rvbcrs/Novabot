// server/src/__tests__/services/importStaging.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ImportStagingStore, IllegalStateTransitionError } from '../../services/importStaging.js';

describe('ImportStagingStore', () => {
  let dir: string;
  let store: ImportStagingStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-'));
    store = new ImportStagingStore(dir);
  });

  it('rejects second active session for the same SN', () => {
    store.create('SN1', { polygonAreaM2: 100, sourceSn: 'SN1' });
    expect(() => store.create('SN1', { polygonAreaM2: 100, sourceSn: 'SN1' })).toThrow(/active session/);
  });

  it('returns null for getActive when none exists', () => {
    expect(store.getActive('SN1')).toBeNull();
  });

  it('legal transition UPLOADED -> ANCHOR_SET', () => {
    const s = store.create('SN1', { polygonAreaM2: 100, sourceSn: 'SN1' });
    store.transition(s.stagingId, 'ANCHOR_SET', { newCharger: { lat: 1, lng: 2 } });
    expect(store.get(s.stagingId)!.state).toBe('ANCHOR_SET');
  });

  it('legal transition UPLOADED -> APPLIED (exact-restore one-click path)', () => {
    const s = store.create('SN1', { polygonAreaM2: 100, sourceSn: 'SN1' });
    store.transition(s.stagingId, 'APPLIED', {});
    expect(store.get(s.stagingId)!.state).toBe('APPLIED');
  });

  it('illegal transition UPLOADED -> PREVIEW_SHOWN throws', () => {
    const s = store.create('SN1', { polygonAreaM2: 100, sourceSn: 'SN1' });
    expect(() => store.transition(s.stagingId, 'PREVIEW_SHOWN', {})).toThrow(IllegalStateTransitionError);
  });

  it('persists state.json + reloads on new instance', () => {
    const s = store.create('SN1', { polygonAreaM2: 100, sourceSn: 'SN1' });
    store.transition(s.stagingId, 'ANCHOR_SET', { newCharger: { lat: 1, lng: 2 } });
    const reloaded = new ImportStagingStore(dir);
    const got = reloaded.get(s.stagingId);
    expect(got?.state).toBe('ANCHOR_SET');
    expect(got?.context.newCharger).toEqual({ lat: 1, lng: 2 });
  });

  it('cancel deletes state.json', () => {
    const s = store.create('SN1', { polygonAreaM2: 100, sourceSn: 'SN1' });
    store.cancel(s.stagingId, 'user reject');
    expect(fs.existsSync(path.join(dir, 'SN1', s.stagingId))).toBe(false);
  });

  it('preserves an interrupted restore for readback reconciliation', () => {
    const s = store.create('SN1', { polygonAreaM2: 100, sourceSn: 'SN1' });
    store.transition(s.stagingId, 'APPLYING', { applyResult: { operationId: 'op', bundleHash: 'hash' } });
    const reloaded = new ImportStagingStore(dir);
    expect(reloaded.get(s.stagingId)?.state).toBe('RECONCILE_REQUIRED');
    expect(reloaded.get(s.stagingId)?.context.applyResult?.bundleHash).toBe('hash');
    expect(() => reloaded.cancel(s.stagingId, 'cancel')).toThrow('reconciled');
    expect(() => reloaded.transition(s.stagingId, 'APPLIED', {})).toThrow(IllegalStateTransitionError);
    reloaded.transition(s.stagingId, 'APPLYING', {});
    reloaded.transition(s.stagingId, 'APPLIED', { applyResult: { mowerVerified: true } });
  });
});
