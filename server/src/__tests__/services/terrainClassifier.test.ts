import { describe, it, expect } from 'vitest';
import { classifyCrop, _setPipelineForTest, LABELS } from '../../services/terrainClassifier.js';

/** Stub-scores: alles 0.001 behalve de opgegeven uitschieters. */
function scoresWith(overrides: Record<string, number>) {
  const base = LABELS.map((l) => ({ label: l.prompt, score: overrides[l.prompt] ?? 0.001 }));
  base.push({ label: 'lawn', score: overrides['lawn'] ?? 0.001 });
  return base;
}

describe('terrainClassifier', () => {
  it('kiest top-1 met voldoende score en marge, mapt naar NL-naam', async () => {
    _setPipelineForTest(async () => scoresWith({ bush: 0.31 }));
    const r = await classifyCrop(Buffer.from([0xff, 0xd8]));
    expect(r).toEqual({ className: 'bush', nl: 'Struik', confidence: expect.closeTo(0.31, 5) });
  });
  it('onder CONFIDENCE_MIN → null', async () => {
    _setPipelineForTest(async () => scoresWith({ bush: 0.08 }));
    expect(await classifyCrop(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
  it('onvoldoende marge boven nummer 2 → null', async () => {
    _setPipelineForTest(async () => scoresWith({ bush: 0.2, tree: 0.15 }));
    expect(await classifyCrop(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
  it('achtergrond-vanger (lawn) als top-1 → null', async () => {
    _setPipelineForTest(async () => scoresWith({ lawn: 0.5 }));
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
