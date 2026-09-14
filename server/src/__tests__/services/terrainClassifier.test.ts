import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  classifyCrop,
  unloadClassifier,
  initClassifier,
  availableMemoryMb,
  _setPipelineForTest,
  IDLE_UNLOAD_MS,
  memoryAllowsLoad,
  MIN_FREE_MB,
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

describe('terrainClassifier geheugenpoort', () => {
  afterEach(() => {
    _setPipelineForTest(null);
    delete process.env.TERRAIN_MIN_FREE_MB;
  });

  it('leest MemAvailable uit /proc/meminfo, niet MemFree', () => {
    const meminfo = [
      'MemTotal:        7853568 kB',
      'MemFree:          140416 kB',
      'MemAvailable:    2226176 kB',
      'Buffers:           12345 kB',
    ].join('\n');
    expect(availableMemoryMb(meminfo)).toBe(2174);   // 2226176 / 1024, afgerond
  });

  it('geeft null als /proc/meminfo geen MemAvailable heeft', () => {
    expect(availableMemoryMb('MemTotal: 7853568 kB\nMemFree: 140416 kB')).toBeNull();
  });

  it('houdt de poort dicht onder de ondergrens en open erboven', () => {
    expect(memoryAllowsLoad(137, 700)).toBe(false);    // .247 op 2026-09-14
    expect(memoryAllowsLoad(699, 700)).toBe(false);
    expect(memoryAllowsLoad(700, 700)).toBe(true);
    expect(memoryAllowsLoad(2174, 700)).toBe(true);
  });

  it('zonder meting blijft de poort open (geen meting is geen reden om uit te zetten)', () => {
    expect(memoryAllowsLoad(null, 700)).toBe(true);
  });

  it('de standaard-ondergrens laat ruimte voor het q8-model', () => {
    expect(MIN_FREE_MB).toBeGreaterThanOrEqual(400);
  });

  it('een al geladen model gaat niet opnieuw door de poort', async () => {
    _setPipelineForTest(async () => scoresWith({ bush: 0.31 }));
    await expect(initClassifier()).resolves.toBe(true);
  });
});

describe('drempels volgen de modelprecisie', () => {
  afterEach(() => {
    delete process.env.TERRAIN_MODEL_DTYPE;
    vi.resetModules();
  });

  async function load(dtype?: string) {
    if (dtype) process.env.TERRAIN_MODEL_DTYPE = dtype;
    else delete process.env.TERRAIN_MODEL_DTYPE;
    vi.resetModules();
    return import('../../services/terrainClassifier.js');
  }

  it('q8 scoort lager, dus lagere drempels dan fp32', async () => {
    const q8 = await load('q8');
    const fp32 = await load('fp32');
    expect(q8.CONFIDENCE_MIN).toBeLessThan(fp32.CONFIDENCE_MIN);
    expect(q8.MARGIN_RATIO).toBeLessThan(fp32.MARGIN_RATIO);
    // Nagemeten op 86 crops van LFIN2230700238 (2026-09-14): dit is het
    // laatste punt zonder vals positief.
    expect([q8.CONFIDENCE_MIN, q8.MARGIN_RATIO]).toEqual([0.10, 2]);
    expect([fp32.CONFIDENCE_MIN, fp32.MARGIN_RATIO]).toEqual([0.12, 4]);
  });

  it('standaard is q8, en een onbekende precisie valt terug op fp32', async () => {
    expect((await load()).MODEL_DTYPE).toBe('q8');
    const raar = await load('q3');
    expect([raar.CONFIDENCE_MIN, raar.MARGIN_RATIO]).toEqual([0.12, 4]);
  });
});
