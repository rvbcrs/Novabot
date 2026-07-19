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
}

export const CLUSTER_CLASSES: ClusterClass[] = [
  { prompt: 'trampoline', i18nKey: 'terrain.classTrampoline', glb: 'trampoline.glb' },
  { prompt: 'tree', i18nKey: 'terrain.classTree', glb: 'tree.glb' },
  { prompt: 'bush', i18nKey: 'terrain.classBush', glb: 'bush.glb' },
  { prompt: 'garden chair', i18nKey: 'terrain.classChair', glb: 'chair.glb' },
  { prompt: 'garden table', i18nKey: 'terrain.classTable', glb: 'table.glb' },
  { prompt: 'flower pot with plant', i18nKey: 'terrain.classFlowerpot', glb: 'flowerpot.glb' },
  { prompt: 'wooden barrel', i18nKey: 'terrain.classBarrel', glb: 'barrel.glb' },
  { prompt: 'parasol', i18nKey: 'terrain.classParasol', glb: 'parasol.glb' },
  { prompt: 'playground equipment', i18nKey: 'terrain.classPlayset', glb: 'playset.glb' },
  { prompt: 'fence', i18nKey: 'terrain.classFence', glb: null },
  { prompt: 'charging station', i18nKey: 'terrain.classChargingStation', glb: null },
  { prompt: 'swimming pool', i18nKey: 'terrain.classPool', glb: null },
];

export function findClusterClass(prompt: string | null | undefined): ClusterClass | undefined {
  return prompt ? CLUSTER_CLASSES.find((c) => c.prompt === prompt) : undefined;
}

/** GLB-bestandsnaam voor een className, of null als er geen model is (→ voxels). */
export function glbForClass(prompt: string | null | undefined): string | null {
  return findClusterClass(prompt)?.glb ?? null;
}
