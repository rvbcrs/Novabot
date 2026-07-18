import { describe, it, expect } from 'vitest';
import { classifyCrop, _setPipelineForTest, LABELS } from '../../services/terrainClassifier.js';

describe('terrainClassifier', () => {
  it('kiest topscore boven drempel en mapt naar NL-naam', async () => {
    _setPipelineForTest(async () => LABELS.map((l, i) => ({ label: l.prompt, score: l.prompt === 'trampoline' ? 0.62 : 0.01 * i })));
    const r = await classifyCrop(Buffer.from([0xff, 0xd8]));
    expect(r).toEqual({ className: 'trampoline', nl: 'Trampoline', confidence: expect.closeTo(0.62, 5) });
  });
  it('onder drempel → null', async () => {
    _setPipelineForTest(async () => LABELS.map(l => ({ label: l.prompt, score: 0.1 })));
    expect(await classifyCrop(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
  it('zonder pipeline → null (model niet beschikbaar)', async () => {
    _setPipelineForTest(null);
    expect(await classifyCrop(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
  it('pipeline-throw wordt null, geen rejection', async () => {
    _setPipelineForTest(async () => { throw new Error('decode boom'); });
    await expect(classifyCrop(Buffer.from([0x00]))).resolves.toBeNull();
  });
});
