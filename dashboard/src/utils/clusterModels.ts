/**
 * Klasse→GLB-model + i18n-koppeling voor herkende terrein-object-clusters
 * (object-recognition-glb, Task 9). Dashboard importeert niet uit server/,
 * dus deze lijst spiegelt bewust `LABELS` in
 * `server/src/services/terrainClassifier.ts` — bij wijziging daar, hier ook
 * bijwerken. `prompt` is exact de string die de server als `className`
 * teruggeeft via GET /api/dashboard/terrain-clusters/:sn (override of
 * model-classificatie).
 */
export interface ClusterClass {
  /** className zoals de server 'm teruggeeft (LABELS[].prompt server-side) */
  prompt: string;
  /** i18n-key (onder "terrain") voor de gelokaliseerde naam */
  i18nKey: string;
  /** bestandsnaam in dashboard/public/models/<naam>.glb, of null = geen 3D-model (blijft voxels) */
  glb: string | null;
  /**
   * Typische hoogte in meters voor het 3D-model. De ToF-camera kapt af op
   * 1,5 m en ziet van een boom alleen de stamvoet (gemeten 0,6 m), waardoor
   * een op de meting geschaald model als bonsai naast een haag van 0,7 m
   * staat. Voor zulke klassen is de typische hoogte eerlijker dan de meting;
   * het model wordt geschaald op max(gemeten, typisch). Weglaten = puur op
   * de meting schalen (voor objecten die de maaier wél helemaal ziet).
   */
  typicalH?: number;
}

export const CLUSTER_CLASSES: ClusterClass[] = [
  { prompt: 'trampoline', i18nKey: 'terrain.classTrampoline', glb: 'trampoline.glb' },
  { prompt: 'tree', i18nKey: 'terrain.classTree', glb: 'tree.glb', typicalH: 3 },
  { prompt: 'bush', i18nKey: 'terrain.classBush', glb: 'bush.glb' },
  { prompt: 'hydrangea', i18nKey: 'terrain.classHydrangea', glb: 'bush.glb' },
  { prompt: 'garden chair', i18nKey: 'terrain.classChair', glb: 'chair.glb' },
  { prompt: 'garden table', i18nKey: 'terrain.classTable', glb: 'table.glb' },
  { prompt: 'flower pot with plant', i18nKey: 'terrain.classFlowerpot', glb: 'flowerpot.glb' },
  { prompt: 'wooden barrel', i18nKey: 'terrain.classBarrel', glb: 'barrel.glb' },
  { prompt: 'parasol', i18nKey: 'terrain.classParasol', glb: 'parasol.glb', typicalH: 2.2 },
  { prompt: 'playground equipment', i18nKey: 'terrain.classPlayset', glb: 'playset.glb', typicalH: 2 },
  { prompt: 'fence', i18nKey: 'terrain.classFence', glb: null },
  { prompt: 'charging station', i18nKey: 'terrain.classChargingStation', glb: null },
  { prompt: 'swimming pool', i18nKey: 'terrain.classPool', glb: 'pool.glb', typicalH: 0.9 },
  { prompt: 'ball', i18nKey: 'terrain.classBall', glb: 'ball.glb' },
];

export function findClusterClass(prompt: string | null | undefined): ClusterClass | undefined {
  return prompt ? CLUSTER_CLASSES.find((c) => c.prompt === prompt) : undefined;
}

/** GLB-bestandsnaam voor een className, of null als er geen model is (→ voxels). */
export function glbForClass(prompt: string | null | undefined): string | null {
  return findClusterClass(prompt)?.glb ?? null;
}
