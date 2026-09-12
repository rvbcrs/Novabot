import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  classifyCrop,
  unloadClassifier,
  _setPipelineForTest,
  IDLE_UNLOAD_MS,
  LABELS,
} from '../../services/terrainClassifier.js';

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

describe('terrainClassifier idle-unload', () => {
  afterEach(() => {
    vi.useRealTimers();
    _setPipelineForTest(null);
  });

  it('geeft het model vrij als er IDLE_UNLOAD_MS niets meer geclassificeerd is', async () => {
    vi.useFakeTimers();
    const dispose = vi.fn(async () => {});
    _setPipelineForTest(async () => scoresWith({ bush: 0.31 }), dispose);

    expect(await classifyCrop(Buffer.from([0xff, 0xd8]))).not.toBeNull();
    await vi.advanceTimersByTimeAsync(IDLE_UNLOAD_MS - 1);
    expect(dispose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    // model weg → classifyCrop levert null tot initClassifier hem herlaadt
    expect(await classifyCrop(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it('elke crop zet de klok terug, dus tijdens werk gaat het model niet weg', async () => {
    vi.useFakeTimers();
    const dispose = vi.fn(async () => {});
    _setPipelineForTest(async () => scoresWith({ bush: 0.31 }), dispose);

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(IDLE_UNLOAD_MS - 10);
      await classifyCrop(Buffer.from([0xff, 0xd8]));
    }
    expect(dispose).not.toHaveBeenCalled();
  });

  it('lost het model niet terwijl er nog een crop in het model zit', async () => {
    const dispose = vi.fn(async () => {});
    let release!: (v: Array<{ label: string; score: number }>) => void;
    _setPipelineForTest(
      () => new Promise((resolve) => { release = resolve; }),
      dispose,
    );

    const pending = classifyCrop(Buffer.from([0xff, 0xd8]));
    await unloadClassifier();
    expect(dispose).not.toHaveBeenCalled();

    release(scoresWith({ bush: 0.31 }));
    expect(await pending).not.toBeNull();

    await unloadClassifier();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
