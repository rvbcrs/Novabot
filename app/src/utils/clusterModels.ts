/**
 * Klasse (className) → GLB-model require-map voor herkende terrein-object-
 * clusters (object-recognition-glb, Task 10). Spiegelt bewust
 * `dashboard/src/utils/clusterModels.ts` (die op zijn beurt `LABELS` in
 * `server/src/services/terrainClassifier.ts` spiegelt) — bij wijziging daar,
 * hier ook bijwerken. `className` is exact de string die de server als
 * `className` teruggeeft via GET /api/dashboard/terrain-clusters/:sn
 * (override of model-classificatie).
 *
 * `require('*.glb')` i.p.v. een URL: Metro bundelt .glb als static asset
 * (`config.resolver.assetExts.push('glb')` in metro.config.js, Task 8) en
 * geeft een asset-module-terug (numeriek id) die `Asset.fromModule()`
 * (expo-asset) naar een lokale `file://`-URI kan downloaden.
 */
export const CLUSTER_MODELS: Record<string, number> = {
  trampoline: require('../../assets/models/trampoline.glb'),
  tree: require('../../assets/models/tree.glb'),
  'bush': require('../../assets/models/bush.glb'),
  'hydrangea': require('../../assets/models/bush.glb'),
  'garden chair': require('../../assets/models/chair.glb'),
  'garden table': require('../../assets/models/table.glb'),
  'flower pot with plant': require('../../assets/models/flowerpot.glb'),
  'wooden barrel': require('../../assets/models/barrel.glb'),
  parasol: require('../../assets/models/parasol.glb'),
  'playground equipment': require('../../assets/models/playset.glb'),
  // 'fence' en 'charging station' hebben bewust GEEN GLB — blijven voxels,
  // zelfde als dashboard/src/utils/clusterModels.ts.
};

/** Asset-module voor een className, of null als er geen model is (→ voxels). */
export function glbModuleForClass(className: string | null | undefined): number | null {
  return className ? CLUSTER_MODELS[className] ?? null : null;
}
