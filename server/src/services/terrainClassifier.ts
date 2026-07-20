/**
 * Zero-shot terrain-object classifier — objectherkenning-plan Task 6.
 *
 * Classificeert een RGB-crop (JPEG) van een terrain-cluster tegen een vaste
 * labellijst via SigLIP zero-shot-image-classification (`@huggingface/
 * transformers`, v4). Het model wordt ON-DEMAND gedownload naar
 * `STORAGE_PATH/models` — GEEN model in de Docker-image of in git.
 *
 * Testbaarheid: het pipeline-object is injecteerbaar via
 * `_setPipelineForTest()` zodat de test-suite NOOIT een model downloadt.
 */
import path from 'node:path';

/** EN prompt → NL naam → GLB-bestand (null = geen model, blijft voxels). */
export const LABELS: Array<{ prompt: string; nl: string; glb: string | null }> = [
  { prompt: 'trampoline', nl: 'Trampoline', glb: 'trampoline.glb' },
  { prompt: 'tree', nl: 'Boom', glb: 'tree.glb' },
  { prompt: 'bush', nl: 'Struik', glb: 'bush.glb' },
  { prompt: 'hydrangea', nl: 'Hortensia', glb: 'bush.glb' },
  { prompt: 'garden chair', nl: 'Tuinstoel', glb: 'chair.glb' },
  { prompt: 'garden table', nl: 'Tuintafel', glb: 'table.glb' },
  { prompt: 'flower pot with plant', nl: 'Bloempot', glb: 'flowerpot.glb' },
  { prompt: 'wooden barrel', nl: 'Houten ton', glb: 'barrel.glb' },
  { prompt: 'parasol', nl: 'Parasol', glb: 'parasol.glb' },
  { prompt: 'playground equipment', nl: 'Speeltoestel', glb: 'playset.glb' },
  { prompt: 'fence', nl: 'Schutting', glb: null },
  { prompt: 'charging station', nl: 'Laadstation', glb: null },
  { prompt: 'swimming pool', nl: 'Zwembad', glb: 'pool.glb' },
  { prompt: 'ball', nl: 'Bal', glb: 'ball.glb' },
];

/**
 * Achtergrond-vangers: doen mee als kandidaat zodat "geen object" ergens
 * heen kan, maar een top-1 hierop betekent gewoon `null` (blijft voxels).
 * Staan bewust NIET in LABELS — geen override-optie, geen GLB.
 */
export const SINK_PROMPTS = ['lawn'] as const;

/**
 * SigLIP scoort met sigmoids (niet softmax): absolute scores blijven laag,
 * zelfs bij een overduidelijke winnaar (praktijkmeting 2026-07-20: struik
 * 0.31, nummer 2 op 0.003). Daarom een marge-regel i.p.v. een hoge kale
 * drempel: top-1 moet minimaal CONFIDENCE_MIN scoren ÉN MARGIN_RATIO keer
 * boven de nummer 2 zitten.
 */
export const CONFIDENCE_MIN = 0.12;
export const MARGIN_RATIO = 4;

/** SigLIP is getraind met dit prompt-sjabloon; zonder blijven scores ~3x lager. */
export const PROMPT_TEMPLATE = 'a photo of a {}';

/** Eén classificatie-run over alle LABELS voor één crop. */
type PipelineFn = (jpeg: Buffer) => Promise<Array<{ label: string; score: number }>>;

let currentPipeline: PipelineFn | null = null;

/** Test-only: injecteert (of verwijdert, met `null`) de pipeline. */
export function _setPipelineForTest(fn: PipelineFn | null): void {
  currentPipeline = fn;
}

/**
 * Laadt lazily de SigLIP zero-shot pipeline (on-demand download naar
 * `STORAGE_PATH/models`). Idempotent: eenmaal geladen wordt de pipeline
 * hergebruikt. `TERRAIN_CLASSIFY=0` schakelt de feature volledig uit.
 * Download-/laadfouten geven `false` + een warning terug — de aanroepende
 * batch slaat dan deze sessie over en probeert het de volgende sessie
 * opnieuw (er wordt niets blijvend als "mislukt" onthouden).
 */
export async function initClassifier(): Promise<boolean> {
  if (process.env.TERRAIN_CLASSIFY === '0') {
    return false;
  }
  if (currentPipeline) {
    return true;
  }
  try {
    const { pipeline, RawImage } = await import('@huggingface/transformers');
    const cacheDir = path.resolve(process.env.STORAGE_PATH ?? './storage', 'models');
    const classifier = await pipeline('zero-shot-image-classification', 'Xenova/siglip-base-patch16-224', {
      cache_dir: cacheDir,
    });
    const candidateLabels = [...LABELS.map((l) => l.prompt), ...SINK_PROMPTS];
    currentPipeline = async (jpeg: Buffer) => {
      const blob = new Blob([jpeg], { type: 'image/jpeg' });
      const image = await RawImage.fromBlob(blob);
      return classifier(image, candidateLabels, {
        hypothesis_template: PROMPT_TEMPLATE,
      }) as Promise<Array<{ label: string; score: number }>>;
    };
    return true;
  } catch (err) {
    console.warn(
      '[terrainClassifier] kon SigLIP-model niet laden/downloaden — batch wordt overgeslagen, volgende sessie opnieuw geprobeerd:',
      err instanceof Error ? err.message : err,
    );
    currentPipeline = null;
    return false;
  }
}

/**
 * Classificeert één crop. Retourneert `null` als er (nog) geen pipeline
 * beschikbaar is, als de top-1 een achtergrond-vanger is (`SINK_PROMPTS`),
 * of als de marge-regel faalt (top-1 < CONFIDENCE_MIN of niet MARGIN_RATIO
 * keer boven de nummer 2).
 */
export async function classifyCrop(
  jpeg: Buffer,
): Promise<{ className: string; nl: string; confidence: number } | null> {
  if (!currentPipeline) {
    return null;
  }
  try {
    const scores = await currentPipeline(jpeg);
    const sorted = [...scores].sort((a, b) => b.score - a.score);
    const best = sorted[0];
    const second = sorted[1];
    if (!best || best.score < CONFIDENCE_MIN) {
      return null;
    }
    if (second && best.score < MARGIN_RATIO * second.score) {
      return null;
    }
    if ((SINK_PROMPTS as readonly string[]).includes(best.label)) {
      return null;
    }
    const label = LABELS.find((l) => l.prompt === best.label);
    if (!label) {
      return null;
    }
    return { className: label.prompt, nl: label.nl, confidence: best.score };
  } catch (err) {
    console.warn('[CLASSIFY] crop-classificatie faalde (corrupte jpeg?):', err);
    return null;
  }
}
