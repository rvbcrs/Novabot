/**
 * 3D-terreinviewer: heightmap-mesh uit het TGR1 display-grid, hoogte-
 * shading, orbit-controls, werk-polygonen als overlay-lijnen, object-voxels
 * uit het TGO1-objectgrid (met kleurgroep-legenda), herkende object-clusters
 * als GLB-modellen met klik-correctie-UI (object-recognition-glb Task 9),
 * live maaier-marker + trail, en een 20s-poll die alles her-fetcht zonder
 * geheugengroei. Lazy-loaded — three.js blijft buiten de hoofdbundle.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CropThumb } from '../components/CropThumb';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  parseTerrain, parseObjects, LABEL_COLORS, LABEL_DEFAULT_COLOR,
  type TerrainData, type ObjectData,
} from '../utils/terrainParser';
import { CLUSTER_CLASSES, findClusterClass, glbForClass } from '../utils/clusterModels';
import { apiFetch, fetchMaps, fetchDevices, fetchTrail, getPlanPath, type CoveragePathEntry } from '../api/client';
import { parseFinishedAreas, prefixedAreaId } from '../utils/coverPathProgress';
import { CameraTile } from '../components/map/CameraTile';
import { getSocket } from '../api/socket';
import type { DeviceUpdateEvent } from '../types';

/** Eén rij van GET /api/dashboard/terrain-clusters/:sn (Task 7/9). */
interface TerrainCluster {
  key: string;
  cx: number; cy: number;
  minX: number; minY: number; maxX: number; maxY: number;
  cells: number; maxH: number;
  className: string | null;
  nl: string | null;
  confidence: number | null;
  userOverride: string | null;
  photoUrl: string | null;
  keys?: string[];
  modelFile?: string | null;
  sizeOverride?: number | null;
  heightOverride?: number | null;
  zOffset?: number | null;
  xOffset?: number | null;
  yOffset?: number | null;
}

// GLTFLoader-cache op moduleniveau: één keer laden per klasse, daarna alleen
// nog klonen. Blijft warm voor de levensduur van de app (ook na wisselen van
// pagina/maaier) — de modellen zijn <10KB en het bespaart herhaald laden.
const gltfLoader = new GLTFLoader();
const modelLoadCache = new Map<string, Promise<THREE.Object3D>>();

// Bestandsnamen waarvan het laden mislukt is (netwerk/parse-fout) — zelfde
// levensduur als modelLoadCache (die de REJECTED promise blijft cachen, dus
// een retry zou toch weer meteen falen). Een gefaalde klasse telt hierna als
// "geen model" voor de voxel-bbox-exclusie: zonder dit filter zou een
// cluster stil verdwijnen (voxels al uitgesloten omdat we een model
// verwachtten, maar dat model komt er nooit — zie clusterBBoxesFrom).
const failedGlbModels = new Set<string>();

function loadClusterModel(glb: string): Promise<THREE.Object3D> {
  let p = modelLoadCache.get(glb);
  if (!p) {
    p = new Promise<THREE.Object3D>((resolve, reject) => {
      gltfLoader.load(`/models/${glb}`, (gltf) => resolve(gltf.scene), undefined, reject);
    });
    modelLoadCache.set(glb, p);
  }
  return p;
}

/**
 * Custom (geüploade) GLB: via fetch mét auth-token (zelfde reden als
 * CropThumb — de route zit achter de auth-gate), daarna runtime genormaliseerd
 * naar dezelfde unit-bbox als de gebundelde set (X/Y ±0.5, voet op Z=0, Z-up)
 * zodat de bestaande schaal-logica ongewijzigd werkt. Cache-key 'custom:...'.
 */
function loadCustomModel(file: string): Promise<THREE.Object3D> {
  const cacheKey = `custom:${file}`;
  let p = modelLoadCache.get(cacheKey);
  if (!p) {
    p = (async () => {
      const res = await apiFetch(`/api/dashboard/terrain-models/${encodeURIComponent(file)}`);
      if (!res.ok) throw new Error(`model ${file}: HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const gltf = await new Promise<{ scene: THREE.Object3D }>((resolve, reject) =>
        gltfLoader.parse(buf, '', resolve, reject));
      // normaliseren: meeste downloads zijn Y-up en willekeurig geschaald
      const zUp = new THREE.Group();
      zUp.rotation.x = Math.PI / 2; // Y-up → Z-up
      zUp.add(gltf.scene);
      const holder = new THREE.Group();
      holder.add(zUp);
      const box = new THREE.Box3().setFromObject(holder);
      const size = new THREE.Vector3(); box.getSize(size);
      // Per as naar de eenheidskubus (zoals de gebundelde set): een breed-plat
      // model werd bij uniforme schaling maar 0,2 'hoog' in het eenheidsblok,
      // waardoor de hoogte-schuif van de gebruiker geen echte meters was
      // (les 2026-07-22: zwembad op 1 m werd een flinterdunne plank).
      holder.scale.set(
        1 / Math.max(size.x, 1e-6),
        1 / Math.max(size.y, 1e-6),
        1 / Math.max(size.z, 1e-6),
      );
      holder.updateMatrixWorld(true);
      const box2 = new THREE.Box3().setFromObject(holder);
      const centrum = new THREE.Vector3(); box2.getCenter(centrum);
      const wrap = new THREE.Group();
      holder.position.set(-centrum.x, -centrum.y, -box2.min.z);
      wrap.add(holder);
      return wrap as THREE.Object3D;
    })();
    modelLoadCache.set(cacheKey, p);
  }
  return p;
}

const POLL_INTERVAL_MS = 20_000;
const TRAIL_MAX_POINTS = 50;
// Vooruit-as-correctie voor het Novabot-model: theta=0 is kaart-oosten; als
// het model met de neus de verkeerde kant op rijdt, hier ±PI/2 of PI bijstellen.
const MOWER_YAW_OFFSET = Math.PI; // model-neus wees naar -X (reed 'achteruit')
// dropdown-waarde voor "geen override" — POST {className:null} wist de
// user_override server-side, waarna de model-classificatie (indien boven de
// confidence-drempel) weer effectief wordt.
const AUTO_OVERRIDE_VALUE = '__auto__';
// door de gebruiker afgewezen detectie — server filtert deze uit de lijst
const NONE_OVERRIDE_VALUE = '__none__';

// Kleurgroepen voor de legenda — labels per groep uit LABEL_COLORS (Global
// Constraints): blauw=laadstation, groen=struik, oranje=obstakel,
// neutraal=alle overige (niet-getagde) objecten.
const COLOR_GROUPS: Array<{ id: string; label: string; color: string; labels: number[] | null }> = [
  { id: 'charger', label: 'Laadstation', color: LABEL_COLORS[10], labels: [10] },
  { id: 'bush', label: 'Struik', color: LABEL_COLORS[8], labels: [8] },
  { id: 'obstacle', label: 'Obstakel', color: LABEL_COLORS[5], labels: [5, 6] },
  { id: 'object', label: 'Object', color: LABEL_DEFAULT_COLOR, labels: null },
];
const KNOWN_LABELS = new Set(COLOR_GROUPS.flatMap(g => g.labels ?? []));
// 'Object' (label 1 e.a.) staat standaard UIT: de firmware-segmentatie
// markeert ~35% van de tuin als generiek object (hoogte t.o.v. wielvlak
// vertekent op hellingen), wat het gazon onder groene voxel-soup bedelft.
// De herkende 3D-modellen + omrandingen staan los van deze laag en blijven
// gewoon zichtbaar; wie de ruwe detectie wil zien vinkt hem aan.
const DEFAULT_LEGEND_VISIBLE: Record<string, boolean> = Object.fromEntries(
  COLOR_GROUPS.map(g => [g.id, g.id !== 'object']));

interface LivePos { x: number; y: number; theta: number }

// hoogte → kleur (topografisch: diepgroen → geel → bruin)
function heightColor(t: number): [number, number, number] {
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [0.13, 0.40, 0.18]], [0.4, [0.45, 0.65, 0.25]],
    [0.7, [0.85, 0.75, 0.35]], [1.0, [0.55, 0.38, 0.22]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1]; const [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0);
      return [c0[0] + f * (c1[0] - c0[0]), c0[1] + f * (c1[1] - c0[1]), c0[2] + f * (c1[2] - c0[2])];
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * Terrein onder gemodelleerde objecten vlaktrekken naar het mediaan-niveau
 * van de rand eromheen: de ToF meet de trampolinemat/potranden als 'grond',
 * waardoor het terrein dwars door het 3D-model heen prikte.
 */
function flattenUnderModels(grid: Float32Array, W: number, H: number,
                            minX: number, minY: number, cellSize: number,
                            bboxes: ClusterBBox[]): void {
  for (const b of bboxes) {
    if (!b.hasModel) continue;
    const x0 = Math.floor(b.minX / cellSize) - minX, x1 = Math.ceil(b.maxX / cellSize) - minX;
    const y0 = Math.floor(b.minY / cellSize) - minY, y1 = Math.ceil(b.maxY / cellSize) - minY;
    // randring net buiten de bbox
    const ring: number[] = [];
    for (let vx = x0 - 2; vx <= x1 + 2; vx++) {
      for (const vy of [y0 - 2, y1 + 2]) {
        if (vx >= 0 && vx < W && vy >= 0 && vy < H) {
          const h = grid[vy * W + vx];
          if (!Number.isNaN(h)) ring.push(h);
        }
      }
    }
    for (let vy = y0 - 1; vy <= y1 + 1; vy++) {
      for (const vx of [x0 - 2, x1 + 2]) {
        if (vx >= 0 && vx < W && vy >= 0 && vy < H) {
          const h = grid[vy * W + vx];
          if (!Number.isNaN(h)) ring.push(h);
        }
      }
    }
    if (!ring.length) continue;
    ring.sort((a, b2) => a - b2);
    const vloer = ring[Math.floor(ring.length / 2)];
    for (let vy = Math.max(y0, 0); vy <= Math.min(y1, H - 1); vy++) {
      for (let vx = Math.max(x0, 0); vx <= Math.min(x1, W - 1); vx++) {
        const i = vy * W + vx;
        if (!Number.isNaN(grid[i]) && grid[i] > vloer) grid[i] = vloer;
      }
    }
  }
}

function buildTerrainMesh(t: TerrainData, modelBBoxes: ClusterBBox[] = []): THREE.Mesh {
  // sparse cellen → dense bbox-grid met NaN-gaten
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < t.ix.length; i++) {
    if (t.ix[i] < minX) minX = t.ix[i]; if (t.ix[i] > maxX) maxX = t.ix[i];
    if (t.iy[i] < minY) minY = t.iy[i]; if (t.iy[i] > maxY) maxY = t.iy[i];
  }
  const W = maxX - minX + 1, H = maxY - minY + 1;
  const grid = new Float32Array(W * H).fill(NaN);
  let hMin = Infinity, hMax = -Infinity;
  for (let i = 0; i < t.ix.length; i++) {
    grid[(t.iy[i] - minY) * W + (t.ix[i] - minX)] = t.h[i];
    if (t.h[i] < hMin) hMin = t.h[i]; if (t.h[i] > hMax) hMax = t.h[i];
  }
  flattenUnderModels(grid, W, H, minX, minY, t.cellSize, modelBBoxes);
  const span = Math.max(hMax - hMin, 0.05);

  // Afmetingen (1,1) zijn irrelevant: we overschrijven zo meteen alle vertex-
  // posities expliciet met kaartcoördinaten. PlaneGeometry's eigen assenstelsel
  // bouwt vertices als (x, −y) — daar tegenin vechten met een geo.translate()
  // levert een verticaal gespiegeld terrein t.o.v. de polygon-overlay (die
  // p.y ongeflipt gebruikt). Door zelf (wx, wy, z) te zetten valt dat weg.
  const geo = new THREE.PlaneGeometry(1, 1, W - 1, H - 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  for (let vy = 0; vy < H; vy++) {
    for (let vx = 0; vx < W; vx++) {
      const vi = vy * W + vx;
      const hVal = grid[vi];
      const z = Number.isNaN(hVal) ? hMin : hVal;
      const wx = (minX + vx) * t.cellSize + t.cellSize / 2; // celcentrum, kaartframe
      const wy = (minY + vy) * t.cellSize + t.cellSize / 2;
      pos.setXYZ(vi, wx, wy, z);
      const [r, g, b] = Number.isNaN(hVal) ? [0.10, 0.12, 0.16] : heightColor((z - hMin) / span);
      colors[vi * 3] = r; colors[vi * 3 + 1] = g; colors[vi * 3 + 2] = b;
    }
  }
  // GEEN geo.translate meer — vertices staan al op kaartcoördinaten. De
  // vertexvolgorde (vi = vy*W+vx) blijft gelijk aan PlaneGeometry's row-major
  // topologie, dus de triangulatie blijft geldig; het materiaal is DoubleSide
  // dus een eventuele winding-inversie door de handmatige Y is onschadelijk.
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
}

/** Cell-lookup terug naar terreinhoogte; valt terug op 0 buiten het grid. */
function makeGroundLookup(t: TerrainData): (x: number, y: number) => number {
  const map = new Map<string, number>();
  for (let i = 0; i < t.ix.length; i++) map.set(`${t.ix[i]},${t.iy[i]}`, t.h[i]);
  const { cellSize } = t;
  return (x: number, y: number) => map.get(`${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`) ?? 0;
}

/** Subset van ObjectData tot alleen de gegeven labels (null = alles buiten KNOWN_LABELS). */
function filterObjectsByLabels(objs: ObjectData, labels: number[] | null): ObjectData {
  const idxs: number[] = [];
  for (let i = 0; i < objs.label.length; i++) {
    const lbl = objs.label[i];
    if (labels ? labels.includes(lbl) : !KNOWN_LABELS.has(lbl)) idxs.push(i);
  }
  const n = idxs.length;
  const ix = new Int32Array(n), iy = new Int32Array(n);
  const label = new Uint8Array(n); const h = new Float32Array(n); const cnt = new Uint32Array(n);
  for (let j = 0; j < n; j++) {
    const i = idxs[j];
    ix[j] = objs.ix[i]; iy[j] = objs.iy[i]; label[j] = objs.label[i]; h[j] = objs.h[i]; cnt[j] = objs.cnt[i];
  }
  return { cellSize: objs.cellSize, ix, iy, label, h, cnt };
}

/** Bbox van een cluster (uit terrain-clusters) + of die als GLB-model getekend wordt. */
interface ClusterBBox {
  key: string;
  minX: number; minY: number; maxX: number; maxY: number;
  hasModel: boolean;
}

function clusterBBoxesFrom(clusters: TerrainCluster[]): ClusterBBox[] {
  return clusters.map((c) => {
    const glb = glbForClass(c.className);
    const bron = c.modelFile ? `custom:${c.modelFile}` : glb;
    return {
      key: c.key, minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY,
      hasModel: bron !== null && !failedGlbModels.has(bron),
    };
  });
}

function findClusterAt(bboxes: ClusterBBox[], x: number, y: number): ClusterBBox | null {
  for (const b of bboxes) {
    if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return b;
  }
  return null;
}

/**
 * Bouwt de voxel-InstancedMesh voor één kleurgroep. Cellen die binnen de bbox
 * van een cluster mét GLB-model vallen worden overgeslagen (die tekenen we
 * als 3D-model, niet als voxel — zie buildClusterModels). Voor overgebleven
 * cellen onthouden we per instance welke cluster (indien van toepassing) ze
 * raken, zodat een klik op die voxel ook het correctie-paneel kan openen.
 * Retourneert null als er na filtering niets overblijft.
 */
function buildObjectVoxels(
  objs: ObjectData,
  groundAt: (x: number, y: number) => number,
  bboxes: ClusterBBox[],
  minH: number,
  minCnt: number,
): THREE.InstancedMesh | null {
  const keep: number[] = [];
  const clusterKeys: Array<string | null> = [];
  for (let i = 0; i < objs.ix.length; i++) {
    const x = objs.ix[i] * objs.cellSize + objs.cellSize / 2;
    const y = objs.iy[i] * objs.cellSize + objs.cellSize / 2;
    // Ruisfilter: een cel die maar een paar keer als object gezien is, is
    // meestal een losse fout-detectie van de segmentatie (per frame maar ~3%
    // niet-gazon; over een hele beurt smeren losse fouten uit). Instelbaar.
    if (objs.cnt[i] < minCnt) continue;
    // Lage cellen (tot minH boven de grond) zijn meestal hoog gras/onkruid bij
    // de randen — die maakten de bossages veel te dik. Instelbaar via de UI.
    if (objs.h[i] - groundAt(x, y) < minH) continue;
    const hit = findClusterAt(bboxes, x, y);
    if (hit?.hasModel) continue; // wordt als GLB-model getekend
    keep.push(i);
    clusterKeys.push(hit ? hit.key : null);
  }
  if (keep.length === 0) return null;

  const geo = new THREE.BoxGeometry(objs.cellSize, objs.cellSize, 1);
  geo.translate(0, 0, 0.5); // schalen vanaf de voet
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), keep.length);
  const m = new THREE.Matrix4(); const c = new THREE.Color();
  for (let j = 0; j < keep.length; j++) {
    const i = keep[j];
    const x = objs.ix[i] * objs.cellSize + objs.cellSize / 2;
    const y = objs.iy[i] * objs.cellSize + objs.cellSize / 2;
    const g = groundAt(x, y);
    const height = Math.max(objs.h[i] - g, 0.05);
    m.identity(); m.setPosition(x, y, g); m.scale(new THREE.Vector3(1, 1, height));
    mesh.setMatrixAt(j, m);
    mesh.setColorAt(j, c.set(LABEL_COLORS[objs.label[i]] ?? LABEL_DEFAULT_COLOR));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  // Klik-lookup: userData i.p.v. een aparte ref-map, zodat de mesh zelf
  // volstaat als raycast-target (zie click-handler verderop).
  mesh.userData.clusterKeys = clusterKeys;
  return mesh;
}

function disposeMesh(obj: THREE.Mesh | THREE.Line | THREE.InstancedMesh | null | undefined): void {
  if (!obj) return;
  obj.geometry.dispose();
  const mat = obj.material;
  if (Array.isArray(mat)) mat.forEach(mm => mm.dispose()); else mat.dispose();
}

/**
 * Verwijdert alle actieve model-instanties uit de scene. Bewust GEEN
 * geometry/material .dispose() hier: Object3D.clone(true) deelt de
 * onderliggende BufferGeometry/Material van de gecachete originele GLTF
 * (modelLoadCache hierboven) — disposen zou die cache stukmaken voor elke
 * volgende kloon van dezelfde klasse, ook op andere clusters/pagina's.
 */
function removeClusterModels(scene: THREE.Scene, instances: Map<string, THREE.Object3D>): void {
  for (const inst of instances.values()) scene.remove(inst);
  instances.clear();
}

export default function TerrainPage({ sn }: { sn: string }) {
  const { t } = useTranslation();
  const mountRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'empty' | 'ready' | 'error'>('loading');
  const [hasObjects, setHasObjects] = useState(false);
  const [legendVisible, setLegendVisible] = useState<Record<string, boolean>>(DEFAULT_LEGEND_VISIBLE);
  const [livePos, setLivePos] = useState<LivePos | null>(null);
  const [clusters, setClusters] = useState<TerrainCluster[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [savingOverride, setSavingOverride] = useState(false);
  const [minObjHeight, setMinObjHeight] = useState(0.1);
  const minObjHeightRef = useRef(0.1);
  const [minObjCnt, setMinObjCnt] = useState(3);
  const minObjCntRef = useRef(3);
  // klik op leeg terrein → voorstel om daar handmatig een object toe te voegen
  const [addAt, setAddAt] = useState<{ x: number; y: number } | null>(null);
  const [addClass, setAddClass] = useState('tree');
  const [addSize, setAddSize] = useState(1);
  const [addHeight, setAddHeight] = useState(0.5);
  const [addModel, setAddModel] = useState('__default__');
  const [customModels, setCustomModels] = useState<string[]>([]);
  // maten-bewerking van een geplaatst handmatig object (m-sleutel)
  const [editSize, setEditSize] = useState(1);
  const [editHeight, setEditHeight] = useState(0.5);
  const [editZ, setEditZ] = useState(0);
  const [moveKey, setMoveKey] = useState<string | null>(null);
  const moveKeyRef = useRef<string | null>(null);
  // lopende verschuiving tijdens pijltjes-verplaatsen + debounce-timer
  const nudgeRef = useRef<{ x: number; y: number } | null>(null);
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const legendVisibleRef = useRef<Record<string, boolean>>(DEFAULT_LEGEND_VISIBLE);
  const livePosRef = useRef<LivePos | null>(null);
  livePosRef.current = livePos;

  const terrainMeshRef = useRef<THREE.Mesh | null>(null);
  const voxelMeshesRef = useRef<Map<string, THREE.InstancedMesh>>(new Map());
  const modelInstancesRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const outlinesRef = useRef<Map<string, THREE.Object3D>>(new Map());
  // standaard uit (2026-07-22, op verzoek): de gele kaders zijn vooral
  // debug-hulp; via het vinkje 'Markeringen' weer aan te zetten
  const outlinesVisibleRef = useRef(false);
  const [outlinesVisible, setOutlinesVisible] = useState(false);
  const followRef = useRef(false);
  const [followMower, setFollowMower] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const doneTrailRef = useRef<THREE.Line | null>(null);
  const plannedPathsRef = useRef<CoveragePathEntry[]>([]);
  const plannedLinesRef = useRef<THREE.Line[]>([]);
  const progressRef = useRef<{ finished: string[] | undefined; activeId: string | undefined }>({ finished: undefined, activeId: undefined });
  const redrawPlannedRef = useRef<(() => void) | null>(null);
  const groundAtRef = useRef<(x: number, y: number) => number>(() => 0);
  const markerRef = useRef<THREE.Object3D | null>(null);
  const trailLineRef = useRef<THREE.Line | null>(null);
  const trailPointsRef = useRef<THREE.Vector3[]>([]);
  const updateMarkerFnRef = useRef<(pos: LivePos | null) => void>(() => {});

  // Laatst bekende terrein/objecten/clusters, buiten de 20s-poll bereikbaar
  // (o.a. voor de override-handler die na een POST alleen de clusters
  // her-fetcht en de scene lokaal herbouwt via rebuildAllRef, zonder een
  // volledige terrain-refetch nodig te hebben).
  const terrainDataRef = useRef<TerrainData | null>(null);
  // Camera + controls bewaren zodat de objectenlijst naar een object kan vliegen.
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const objectsDataRef = useRef<ObjectData | null>(null);
  const clustersRef = useRef<TerrainCluster[]>([]);
  const rebuildEpochRef = useRef(0);
  const rebuildAllRef = useRef<(() => void) | null>(null);

  // Live maaier-positie: zelfde bron als MapTab (sensors.map_position_x/y +
  // theta), maar hier rechtstreeks op de gedeelde socket (getSocket()) i.p.v.
  // via de useDevices/useSocket hook — die hook doet `socket.off(event)`
  // zonder specifieke listener-referentie bij unmount, wat bij een tweede
  // hook-instantie (deze pagina) ALLE listeners van dat event zou slopen,
  // ook die van de rest van het dashboard. Met expliciete handler-referenties
  // hieronder blijft de cleanup instance-scoped.
  useEffect(() => {
    let disposed = false;
    const sensors: Record<string, string> = {};
    setLivePos(null);

    let progressSig = '';
    const applyToLivePos = () => {
      const x = parseFloat(sensors.map_position_x ?? '');
      const y = parseFloat(sensors.map_position_y ?? '');
      // voortgang van het geplande pad (zelfde bron als de 2D-kaart)
      const fin = parseFinishedAreas(sensors.finished_area, sensors.cover_map_id);
      const act = prefixedAreaId(sensors.covering_area_id, sensors.cover_map_id);
      progressRef.current = { finished: fin, activeId: act };
      const sig = `${(fin ?? []).join(',')}|${act ?? ''}`;
      if (sig !== progressSig) { progressSig = sig; redrawPlannedRef.current?.(); }
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const thetaRaw = parseFloat(sensors.theta ?? '0');
      setLivePos({ x, y, theta: Number.isFinite(thetaRaw) ? thetaRaw : 0 });
    };

    const handleSnapshot = (devices: Array<{ sn: string; sensors: Record<string, string> }>) => {
      const d = devices.find(dev => dev.sn === sn);
      if (!d) return;
      Object.assign(sensors, d.sensors);
      applyToLivePos();
    };
    const handleUpdate = (e: DeviceUpdateEvent) => {
      if (e.sn !== sn) return;
      Object.assign(sensors, e.fields);
      applyToLivePos();
    };

    const socket = getSocket();
    socket.on('state:snapshot', handleSnapshot);
    socket.on('device:update', handleUpdate);

    fetchDevices().then(devices => {
      if (disposed) return;
      const d = devices.find(dev => dev.sn === sn);
      if (d) { Object.assign(sensors, d.sensors); applyToLivePos(); }
    }).catch(() => {});

    return () => {
      disposed = true;
      socket.off('state:snapshot', handleSnapshot);
      socket.off('device:update', handleUpdate);
    };
  }, [sn]);

  // Marker/trail volgen de live-positie zodra de three.js-scene bestaat.
  useEffect(() => {
    updateMarkerFnRef.current(livePos);
  }, [livePos]);

  useEffect(() => {
    let disposed = false;
    let renderer: THREE.WebGLRenderer | null = null;
    let frameId = 0;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let onPointerDown: ((e: PointerEvent) => void) | null = null;
    let onPointerUp: ((e: PointerEvent) => void) | null = null;
    const polygonLines: THREE.Line[] = [];

    trailPointsRef.current = [];
    updateMarkerFnRef.current = () => {};
    legendVisibleRef.current = DEFAULT_LEGEND_VISIBLE;
    setLegendVisible(DEFAULT_LEGEND_VISIBLE);
    setHasObjects(false);

    async function loadObjects(): Promise<ObjectData | null> {
      try {
        const res = await apiFetch(`/api/dashboard/terrain-objects/${encodeURIComponent(sn)}`);
        if (res.status === 404 || !res.ok) return null; // geen objecten is OK, geen fout
        return parseObjects(await res.arrayBuffer());
      } catch {
        return null;
      }
    }

    /** Historische 'al gedaan'-trail van de server (zelfde bron als de
     *  2D-kaart), gedrapeerd boven het terrein. */
    async function loadDoneTrail(): Promise<Array<{ x: number; y: number }>> {
      try {
        // zelfde cast als MowerMap: de API levert lokale x/y-meters, het
        // TrailPoint-type (lat/lng) is legacy
        return (await fetchTrail(sn)) as unknown as Array<{ x: number; y: number }>;
      } catch {
        return [];
      }
    }

    function applyDoneTrail(scene: THREE.Scene, pts: Array<{ x: number; y: number }>): void {
      if (!doneTrailRef.current) {
        const lijn = new THREE.Line(
          new THREE.BufferGeometry(),
          new THREE.LineBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.8 }));
        scene.add(lijn);
        doneTrailRef.current = lijn;
      }
      const v = pts.map((p2) => new THREE.Vector3(p2.x, p2.y, groundAtRef.current(p2.x, p2.y) + 0.15));
      doneTrailRef.current.geometry.dispose();
      doneTrailRef.current.geometry = new THREE.BufferGeometry().setFromPoints(v);
    }

    /** Gepland maaipad + voortgang: gemaaid=groen, actief=oranje, rest=hint. */
    function applyPlannedPath(scene: THREE.Scene): void {
      for (const l of plannedLinesRef.current) { scene.remove(l); l.geometry.dispose(); (l.material as THREE.Material).dispose(); }
      plannedLinesRef.current = [];
      const { finished, activeId } = progressRef.current;
      for (const entry of plannedPathsRef.current) {
        if (!entry.points?.length) continue;
        const klaar = finished?.includes(entry.id) ?? false;
        const actief = entry.id === activeId;
        // resterend donker (leisteen): lichtgrijs op 30% viel volledig weg
        // tegen het lichte terrein (les 2026-07-22)
        const kleur = klaar ? 0x34d399 : actief ? 0xf59e0b : 0x334155;
        const lijn = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(
            entry.points.map((p2) => new THREE.Vector3(p2.x, p2.y, groundAtRef.current(p2.x, p2.y) + 0.12))),
          new THREE.LineBasicMaterial({ color: kleur, transparent: true, opacity: klaar ? 0.9 : actief ? 0.95 : 0.65 }));
        scene.add(lijn);
        plannedLinesRef.current.push(lijn);
      }
    }

    async function loadPlannedPaths(): Promise<void> {
      try {
        plannedPathsRef.current = await getPlanPath(sn);
      } catch {
        /* geen plan gecachet is prima */
      }
    }

    async function loadClusters(): Promise<TerrainCluster[]> {
      try {
        const res = await apiFetch(`/api/dashboard/terrain-clusters/${encodeURIComponent(sn)}`);
        if (!res.ok) return [];
        const body = await res.json() as { clusters?: TerrainCluster[] };
        return body.clusters ?? [];
      } catch {
        return [];
      }
    }

    // Plaatst voor elke cluster met een className+GLB een genormaliseerd
    // model (zie dashboard/public/models/SOURCES.md): geschaald naar de
    // gemeten voetafdruk/hoogte, positie op (cx, cy, terreinhoogte). Laden is
    // async+gecached (modelLoadCache) — een `epoch`-check voorkomt dat een
    // trage load na een ondertussen alwéér gestarte rebuild alsnog een stale
    // model toevoegt.
    /**
     * Markeert herkende objecten met een dunne omranding op hun bbox, zodat
     * je op de kaart ziet WAAR iets herkend is — zonder die rand is een
     * herkend zwembad niet te onderscheiden van willekeurige voxels.
     */
    function buildClusterOutlines(scene: THREE.Scene, clusterList: TerrainCluster[]): void {
      for (const [, obj] of outlinesRef.current) {
        scene.remove(obj);
        (obj as THREE.LineSegments).geometry.dispose();
      }
      outlinesRef.current.clear();
      for (const cl of clusterList) {
        if (!cl.className) continue;
        const cx = (cl.minX + cl.maxX) / 2;
        const cy = (cl.minY + cl.maxY) / 2;
        const g = groundAtRef.current(cx, cy);
        const h = Math.max(cl.maxH - g, 0.2);
        const geo = new THREE.BoxGeometry(
          Math.max(cl.maxX - cl.minX, 0.2),
          Math.max(cl.maxY - cl.minY, 0.2),
          h,
        );
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          new THREE.LineBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.85 }),
        );
        geo.dispose();
        edges.position.set(cx, cy, g + h / 2);
        edges.userData.clusterKey = cl.key;
        edges.visible = outlinesVisibleRef.current;
        scene.add(edges);
        outlinesRef.current.set(cl.key, edges);
      }
    }

    function buildClusterModels(scene: THREE.Scene, clusterList: TerrainCluster[], epoch: number): void {
      removeClusterModels(scene, modelInstancesRef.current);
      buildClusterOutlines(scene, clusterList);
      for (const cl of clusterList) {
        const glb = glbForClass(cl.className);
        if (!glb && !cl.modelFile) continue;
        const klasse = findClusterClass(cl.className);
        const laden = cl.modelFile
          ? loadCustomModel(cl.modelFile)
          : loadClusterModel(glb!);
        laden.then((orig) => {
          if (disposed || epoch !== rebuildEpochRef.current) return; // stale: nieuwe rebuild al bezig
          const clone = orig.clone(true);
          clone.traverse((o) => { o.userData.clusterKey = cl.key; });
          // Bbox-midden i.p.v. centroid (cx,cy): de voxel-exclusiezone in
          // buildObjectVoxels() filtert op [minX,maxX]×[minY,maxY], niet op de
          // centroid. Bij een asymmetrisch cluster (L-vorm, half gescand
          // object) valt de centroid niet samen met het bbox-midden — het
          // model zou dan aan één kant buiten de exclusiezone steken
          // (overlapt echte voxels) en aan de andere kant een leeg gat laten.
          const bboxCx = (cl.minX + cl.maxX) / 2;
          const bboxCy = (cl.minY + cl.maxY) / 2;
          const g = groundAtRef.current(bboxCx, bboxCy);
          // Gebruikers-overrides winnen van de meting (maat aanpasbaar voor
          // ALLE objecten, ook gedetecteerde zoals de trampoline).
          const sx = cl.sizeOverride ?? Math.max(cl.maxX - cl.minX, 0.15);
          const sy = cl.sizeOverride ?? Math.max(cl.maxY - cl.minY, 0.15);
          // Hoogte: gemeten, maar minstens de typische hoogte van de klasse —
          // de ToF ziet niet hoger dan 1,5 m, dus een boom meet 0,6 m.
          const gemeten = Math.max(cl.maxH - g, 0.1);
          const sz = cl.heightOverride ?? Math.max(gemeten, klasse?.typicalH ?? 0);
          clone.scale.set(sx, sy, sz);
          clone.position.set(bboxCx, bboxCy, g + (cl.zOffset ?? 0));
          scene.add(clone);
          modelInstancesRef.current.set(cl.key, clone);
        }).catch((err) => {
          const bron = cl.modelFile ? `custom:${cl.modelFile}` : glb!;
          console.warn(`terrain: model laden mislukt (${bron}) — toont object als voxels`, err);
          if (disposed || epoch !== rebuildEpochRef.current) return;
          if (failedGlbModels.has(bron)) return; // al gemarkeerd — voorkomt een rebuild-loop
          failedGlbModels.add(bron);
          // Forceert een volledige rebuild: clusterBBoxesFrom() ziet nu
          // hasModel:false voor deze klasse, dus buildObjectVoxels() laat de
          // cellen van dit cluster weer als voxels verschijnen i.p.v. stil
          // te verdwijnen (ze waren al uitgesloten toen we nog een model
          // verwachtten).
          rebuildAllRef.current?.();
        });
      }
    }

    // Vervangt terrein-, voxel- en model-meshes in de scene; dispose't de
    // oude geometrieën/materialen eerst zodat uren openstaan geen geheugen
    // lekt (model-instanties zijn een uitzondering, zie removeClusterModels).
    function rebuild(scene: THREE.Scene, terrain: TerrainData, objects: ObjectData | null, clusterList: TerrainCluster[]): THREE.Mesh {
      rebuildEpochRef.current += 1;
      const epoch = rebuildEpochRef.current;

      if (terrainMeshRef.current) { scene.remove(terrainMeshRef.current); disposeMesh(terrainMeshRef.current); }
      const mesh = buildTerrainMesh(terrain, clusterBBoxesFrom(clusterList));
      scene.add(mesh);
      terrainMeshRef.current = mesh;
      groundAtRef.current = makeGroundLookup(terrain);

      for (const vm of voxelMeshesRef.current.values()) { scene.remove(vm); disposeMesh(vm); }
      voxelMeshesRef.current.clear();

      const bboxes = clusterBBoxesFrom(clusterList);
      let anyObjects = false;
      if (objects && objects.ix.length > 0) {
        for (const group of COLOR_GROUPS) {
          const filtered = filterObjectsByLabels(objects, group.labels);
          if (filtered.ix.length === 0) continue;
          const vm = buildObjectVoxels(filtered, groundAtRef.current, bboxes, minObjHeightRef.current, minObjCntRef.current);
          if (!vm) continue; // alle cellen van deze groep vielen onder een gemodelleerd cluster
          anyObjects = true;
          vm.visible = legendVisibleRef.current[group.id] ?? true;
          scene.add(vm);
          voxelMeshesRef.current.set(group.id, vm);
        }
      }
      buildClusterModels(scene, clusterList, epoch);
      if (clusterList.some((c) => glbForClass(c.className))) anyObjects = true;
      setHasObjects(anyObjects);
      return mesh;
    }

    (async () => {
      const res = await apiFetch(`/api/dashboard/terrain/${encodeURIComponent(sn)}`);
      if (res.status === 404) { setStatus('empty'); return; }
      if (!res.ok) { setStatus('error'); return; }
      const terrain = parseTerrain(await res.arrayBuffer());
      const [mapsResponse, objects, clusterList, doneTrail] = await Promise.all([
        fetchMaps(sn).catch(() => null),
        loadObjects(),
        loadClusters(),
        loadDoneTrail(),
      ]);
      const maps = mapsResponse?.maps ?? [];
      if (disposed || !mountRef.current) return;

      terrainDataRef.current = terrain;
      objectsDataRef.current = objects;
      clustersRef.current = clusterList;
      setClusters(clusterList);

      const el = mountRef.current;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0b1020);
      const camera = new THREE.PerspectiveCamera(55, el.clientWidth / el.clientHeight, 0.1, 500);
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(el.clientWidth, el.clientHeight);
      el.appendChild(renderer.domElement);

      const mesh = rebuild(scene, terrain, objects, clusterList);
      applyDoneTrail(scene, doneTrail);
      await loadPlannedPaths();
      applyPlannedPath(scene);
      redrawPlannedRef.current = () => applyPlannedPath(scene);
      scene.add(new THREE.AmbientLight(0xffffff, 0.55));
      const sun = new THREE.DirectionalLight(0xffffff, 0.9);
      sun.position.set(30, 20, 50);
      scene.add(sun);

      // werk-polygonen als overlay-lijnen 5 cm boven het terrein — statisch,
      // niet meegenomen in de 20s-poll (verandert niet tijdens het kijken)
      // Obstacle-polygonen als rood muurtje (ribbon) op het terrein: een
      // 1px-lijn was op de 3D-kaart nauwelijks te zien.
      for (const m of maps.filter(m => m.mapType === 'obstacle' && m.mapArea?.length)) {
        const H = 0.35;
        const ring = [...m.mapArea, m.mapArea[0]];
        const pos: number[] = [];
        for (let i = 0; i < ring.length - 1; i++) {
          const a = ring[i], b = ring[i + 1];
          const ga = groundAtRef.current(a.x, a.y);
          const gb = groundAtRef.current(b.x, b.y);
          // twee driehoeken per segment: (a-onder, b-onder, a-boven) + (a-boven, b-onder, b-boven)
          pos.push(a.x, a.y, ga, b.x, b.y, gb, a.x, a.y, ga + H);
          pos.push(a.x, a.y, ga + H, b.x, b.y, gb, b.x, b.y, gb + H);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        const wall = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          color: 0xef4444, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false,
        }));
        scene.add(wall);
      }
      for (const m of maps.filter(m => m.mapType === 'work' && m.mapArea?.length)) {
        const pts = m.mapArea.map(p => new THREE.Vector3(p.x, p.y, 0.05));
        pts.push(pts[0].clone());
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: 0x34d399 }));
        scene.add(line);
        polygonLines.push(line);
      }

      // Maaier-marker: het echte Novabot-model (geoptimaliseerd, 3.8MB) met
      // heading; gele cone als fallback tot het model geladen is (of faalt).
      const markerGroep = new THREE.Group();
      const fallbackCone = new THREE.Mesh(
        new THREE.ConeGeometry(0.15, 0.3, 12),
        new THREE.MeshBasicMaterial({ color: 0xfbbf24 }));
      fallbackCone.rotation.x = Math.PI / 2; // cone-as (lokaal Y) → wereld-Z
      markerGroep.add(fallbackCone);
      markerGroep.visible = false;
      scene.add(markerGroep);
      markerRef.current = markerGroep;
      loadClusterModel('novabot.glb').then((orig) => {
        if (disposed) return;
        const m = orig.clone(true);
        // GLB is Y-up: X=lengte (1.90), Y=hoogte (0.91), Z=breedte (1.24).
        // → Z-up draaien, uniform schalen naar echte maaierlengte 0.66 m,
        //   wielen op z=0. MOWER_YAW_OFFSET corrigeert de vooruit-as.
        const zUp = new THREE.Group();
        zUp.rotation.x = Math.PI / 2;
        zUp.add(m);
        const houder = new THREE.Group();
        houder.add(zUp);
        const box = new THREE.Box3().setFromObject(houder);
        const size = new THREE.Vector3(); box.getSize(size);
        const schaal = 0.66 / Math.max(size.x, 1e-6);
        houder.scale.setScalar(schaal);
        houder.updateMatrixWorld(true);
        const box2 = new THREE.Box3().setFromObject(houder);
        const c = new THREE.Vector3(); box2.getCenter(c);
        houder.position.set(-c.x, -c.y, -box2.min.z);
        markerGroep.remove(fallbackCone);
        fallbackCone.geometry.dispose();
        markerGroep.add(houder);
      }).catch(() => { /* cone blijft de fallback */ });

      // Trail: dun buisje i.p.v. 1px-lijn, en ruim boven het gras zodat hij
      // niet in het terrein wegvalt.
      const TRAIL_Z = 0.18;
      const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.9 }));
      scene.add(trail);
      trailLineRef.current = trail;

      updateMarkerFnRef.current = (pos: LivePos | null) => {
        if (!markerRef.current || !trailLineRef.current) return;
        if (!pos) { markerRef.current.visible = false; return; }
        const g = groundAtRef.current(pos.x, pos.y);
        markerRef.current.position.set(pos.x, pos.y, g + 0.02);
        markerRef.current.rotation.set(0, 0, pos.theta + MOWER_YAW_OFFSET);
        markerRef.current.visible = true;

        // Volg-modus: camera schuift mee (zelfde kijkhoek, doel = maaier).
        if (followRef.current && cameraRef.current && controlsRef.current) {
          const ctr = controlsRef.current;
          const dx = pos.x - ctr.target.x;
          const dy = pos.y - ctr.target.y;
          const dz = (g + 0.02) - ctr.target.z;
          ctr.target.set(pos.x, pos.y, g + 0.02);
          cameraRef.current.position.x += dx;
          cameraRef.current.position.y += dy;
          cameraRef.current.position.z += dz;
          ctr.update();
        }

        const pts = trailPointsRef.current;
        const last = pts[pts.length - 1];
        const moved = !last || Math.hypot(pos.x - last.x, pos.y - last.y) > 0.01;
        if (moved) {
          pts.push(new THREE.Vector3(pos.x, pos.y, g + TRAIL_Z));
          while (pts.length > TRAIL_MAX_POINTS) pts.shift();
          trailLineRef.current.geometry.dispose();
          trailLineRef.current.geometry = new THREE.BufferGeometry().setFromPoints(pts);
        }
      };
      updateMarkerFnRef.current(livePosRef.current); // direct syncen met wat er al binnen is

      const box = new THREE.Box3().setFromObject(mesh);
      const center = box.getCenter(new THREE.Vector3());
      camera.position.set(center.x, center.y - 15, 18);
      camera.up.set(0, 0, 1);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.copy(center);
      cameraRef.current = camera;
      controlsRef.current = controls;

      const animate = () => {
        frameId = requestAnimationFrame(animate);
        controls.update();
        renderer!.render(scene, camera);
      };
      animate();
      setStatus('ready');

      // Klik-op-object: raycast tegen zowel de GLB-model-instanties (userData.
      // clusterKey op elke descendant, zie buildClusterModels) als de voxel-
      // InstancedMeshes (userData.clusterKeys[instanceId], zie
      // buildObjectVoxels). Een pointerdown/pointerup-afstandscheck onderscheidt
      // een klik van een OrbitControls-drag (die anders per ongeluk een cluster
      // zou selecteren).
      const raycaster = new THREE.Raycaster();
      let pointerDownAt: { x: number; y: number } | null = null;
      onPointerDown = (e: PointerEvent) => { pointerDownAt = { x: e.clientX, y: e.clientY }; };
      onPointerUp = (e: PointerEvent) => {
        const start = pointerDownAt;
        pointerDownAt = null;
        if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return;
        const rect = renderer!.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        );
        raycaster.setFromCamera(ndc, camera);
        const targets: THREE.Object3D[] = [
          ...modelInstancesRef.current.values(),
          ...voxelMeshesRef.current.values(),
        ];
        const hits = raycaster.intersectObjects(targets, true);
        for (const hit of hits) {
          const obj = hit.object as THREE.Object3D & { isInstancedMesh?: boolean };
          let key: string | null = null;
          if (obj.isInstancedMesh) {
            const keys = obj.userData.clusterKeys as Array<string | null> | undefined;
            key = keys && hit.instanceId != null ? (keys[hit.instanceId] ?? null) : null;
          } else {
            key = (obj.userData.clusterKey as string | undefined) ?? null;
          }
          if (key) { setSelectedKey(key); setAddAt(null); return; }
        }
        // Geen object geraakt: klik op het terrein zelf = plek om handmatig
        // een object toe te voegen (bomen/potten zonder bruikbare foto).
        if (terrainMeshRef.current) {
          const grond = raycaster.intersectObject(terrainMeshRef.current, false);
          if (grond.length) {
            setSelectedKey(null);
            setAddAt({ x: grond[0].point.x, y: grond[0].point.y });
            return;
          }
        }
        setAddAt(null);
      };
      renderer.domElement.addEventListener('pointerdown', onPointerDown);
      renderer.domElement.addEventListener('pointerup', onPointerUp);

      // Herbruikbaar voor de override-handler (React-event, buiten deze IIFE):
      // her-tekent puur uit de laatst bekende refs, zonder terrain-refetch.
      rebuildAllRef.current = () => {
        if (!terrainDataRef.current) return;
        rebuild(scene, terrainDataRef.current, objectsDataRef.current, clustersRef.current);
        updateMarkerFnRef.current(livePosRef.current);
      };

      // 20s-poll zolang de pagina gemount is: grids + clusters her-fetchen en
      // de scene-inhoud vervangen (rebuild dispose't de oude meshes zelf).
      intervalId = setInterval(async () => {
        if (disposed) return;
        try {
          const [terrainRes, freshObjects, freshClusters, freshTrail] = await Promise.all([
            apiFetch(`/api/dashboard/terrain/${encodeURIComponent(sn)}`),
            loadObjects(),
            loadClusters(),
            loadDoneTrail(),
          ]);
          if (disposed || !terrainRes.ok) return;
          const freshTerrain = parseTerrain(await terrainRes.arrayBuffer());
          if (disposed) return;
          terrainDataRef.current = freshTerrain;
          objectsDataRef.current = freshObjects;
          clustersRef.current = freshClusters;
          setClusters(freshClusters);
          rebuild(scene, freshTerrain, freshObjects, freshClusters);
          applyDoneTrail(scene, freshTrail);
          await loadPlannedPaths();
          applyPlannedPath(scene);
          updateMarkerFnRef.current(livePosRef.current);
        } catch (err) {
          console.warn('terrain: 20s-poll refresh mislukt', err);
        }
      }, POLL_INTERVAL_MS);
    })().catch(() => setStatus('error'));

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      if (intervalId !== undefined) clearInterval(intervalId);
      updateMarkerFnRef.current = () => {};
      rebuildAllRef.current = null;

      if (renderer && onPointerDown) renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      if (renderer && onPointerUp) renderer.domElement.removeEventListener('pointerup', onPointerUp);

      disposeMesh(terrainMeshRef.current);
      terrainMeshRef.current = null;
      for (const vm of voxelMeshesRef.current.values()) disposeMesh(vm);
      voxelMeshesRef.current.clear();
      modelInstancesRef.current.clear(); // geen dispose — zie removeClusterModels
      // marker is een Group (Novabot-model, gedeeld via modelLoadCache) —
      // alleen de fallback-cone is eigen geometry en die is al opgeruimd
      markerRef.current = null;
      disposeMesh(trailLineRef.current);
      trailLineRef.current = null;
      disposeMesh(doneTrailRef.current);
      doneTrailRef.current = null;
      for (const l of plannedLinesRef.current) disposeMesh(l);
      plannedLinesRef.current = [];
      redrawPlannedRef.current = null;
      for (const line of polygonLines) disposeMesh(line);

      renderer?.dispose();
      if (renderer?.domElement.parentElement) renderer.domElement.parentElement.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sn]);

  // Klik-correctie: POST de override, her-fetch de clusters en herbouw de
  // scene lokaal (rebuildAllRef, zie hierboven) i.p.v. te wachten op de
  // volgende 20s-poll.
  async function handleModelChange(key: string, file: string): Promise<void> {
    setSavingOverride(true);
    try {
      await apiFetch(`/api/dashboard/terrain-clusters/${encodeURIComponent(sn)}/${encodeURIComponent(key)}/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: file === '__default__' ? null : file }),
      });
      // cache voor dit object leeghalen zodat het nieuwe model echt laadt
      const res = await apiFetch(`/api/dashboard/terrain-clusters/${encodeURIComponent(sn)}`);
      if (res.ok) {
        const body = await res.json() as { clusters?: TerrainCluster[] };
        clustersRef.current = body.clusters ?? [];
        setClusters(body.clusters ?? []);
      }
      rebuildAllRef.current?.();
    } catch (err) {
      console.warn('terrain: model kiezen mislukt', err);
    } finally {
      setSavingOverride(false);
    }
  }

  async function handleModelUpload(file: File): Promise<string | null> {
    setSavingOverride(true);
    try {
      const naam = file.name.replace(/\.glb$/i, '');
      const res = await apiFetch(`/api/dashboard/terrain-models/upload?name=${encodeURIComponent(naam)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: await file.arrayBuffer(),
      });
      if (!res.ok) return null;
      const uploaded = (await res.json() as { file?: string }).file ?? null;
      const lijst = await apiFetch('/api/dashboard/terrain-models');
      if (lijst.ok) {
        const b = await lijst.json() as { models?: string[] };
        setCustomModels(b.models ?? []);
      }
      return uploaded;
    } catch (err) {
      console.warn('terrain: model uploaden mislukt', err);
      return null;
    } finally {
      setSavingOverride(false);
    }
  }

  async function handleAddObject(): Promise<void> {
    if (!addAt) return;
    setSavingOverride(true);
    try {
      const addRes = await apiFetch(`/api/dashboard/terrain-clusters/${encodeURIComponent(sn)}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: addAt.x, y: addAt.y, className: addClass, size: addSize, height: addHeight }),
      });
      if (addRes.ok && addModel !== '__default__') {
        const nieuweKey = (await addRes.json() as { key?: string }).key;
        if (nieuweKey) {
          await apiFetch(`/api/dashboard/terrain-clusters/${encodeURIComponent(sn)}/${encodeURIComponent(nieuweKey)}/model`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: addModel }),
          });
        }
      }
      setAddAt(null);
      const res = await apiFetch(`/api/dashboard/terrain-clusters/${encodeURIComponent(sn)}`);
      if (res.ok) {
        const body = await res.json() as { clusters?: TerrainCluster[] };
        const fresh = body.clusters ?? [];
        clustersRef.current = fresh;
        setClusters(fresh);
      }
      rebuildAllRef.current?.();
    } catch (err) {
      console.warn('terrain: object toevoegen mislukt', err);
    } finally {
      setSavingOverride(false);
    }
  }

  async function handleModelRename(file: string, nieuweNaam: string): Promise<void> {
    setSavingOverride(true);
    try {
      await apiFetch(`/api/dashboard/terrain-models/${encodeURIComponent(file)}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nieuweNaam }),
      });
      const lijst = await apiFetch('/api/dashboard/terrain-models');
      if (lijst.ok) {
        const b = await lijst.json() as { models?: string[] };
        setCustomModels(b.models ?? []);
      }
      const res = await apiFetch(`/api/dashboard/terrain-clusters/${encodeURIComponent(sn)}`);
      if (res.ok) {
        const body = await res.json() as { clusters?: TerrainCluster[] };
        clustersRef.current = body.clusters ?? [];
        setClusters(body.clusters ?? []);
      }
      rebuildAllRef.current?.();
    } catch (err) {
      console.warn('terrain: model hernoemen mislukt', err);
    } finally {
      setSavingOverride(false);
    }
  }

  async function commitMove(c: TerrainCluster, xOff: number, yOff: number): Promise<void> {
    setSavingOverride(true);
    try {
      await apiFetch(`/api/dashboard/terrain-clusters/${encodeURIComponent(sn)}/${encodeURIComponent(c.key)}/display`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          size: c.sizeOverride ?? null, height: c.heightOverride ?? null,
          zOffset: c.zOffset ?? null, xOffset: xOff, yOffset: yOff,
        }),
      });
      const res = await apiFetch(`/api/dashboard/terrain-clusters/${encodeURIComponent(sn)}`);
      if (res.ok) {
        const body = await res.json() as { clusters?: TerrainCluster[] };
        clustersRef.current = body.clusters ?? [];
        setClusters(body.clusters ?? []);
      }
      rebuildAllRef.current?.();
    } catch (err) {
      console.warn('terrain: verplaatsen mislukt', err);
    } finally {
      setSavingOverride(false);
    }
  }

  async function handleDisplayCommit(): Promise<void> {
    const c = selectedCluster;
    if (!c) return;
    setSavingOverride(true);
    try {
      await apiFetch(`/api/dashboard/terrain-clusters/${encodeURIComponent(sn)}/${encodeURIComponent(c.key)}/display`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          size: editSize, height: editHeight, zOffset: editZ,
          xOffset: c.xOffset ?? null, yOffset: c.yOffset ?? null,
        }),
      });
      const res = await apiFetch(`/api/dashboard/terrain-clusters/${encodeURIComponent(sn)}`);
      if (res.ok) {
        const body = await res.json() as { clusters?: TerrainCluster[] };
        clustersRef.current = body.clusters ?? [];
        setClusters(body.clusters ?? []);
      }
      rebuildAllRef.current?.();
    } catch (err) {
      console.warn('terrain: weergave aanpassen mislukt', err);
    } finally {
      setSavingOverride(false);
    }
  }

  async function handleOverrideChange(key: string, value: string): Promise<void> {
    if (value === NONE_OVERRIDE_VALUE) setSelectedKey(null);
    setSavingOverride(true);
    try {
      await apiFetch(`/api/dashboard/terrain-clusters/${encodeURIComponent(sn)}/${encodeURIComponent(key)}/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ className: value === AUTO_OVERRIDE_VALUE ? null : value }),
      });
    } catch (err) {
      console.warn('terrain: override opslaan mislukt', err);
    } finally {
      setSavingOverride(false);
    }
    try {
      const res = await apiFetch(`/api/dashboard/terrain-clusters/${encodeURIComponent(sn)}`);
      if (res.ok) {
        const body = await res.json() as { clusters?: TerrainCluster[] };
        const fresh = body.clusters ?? [];
        clustersRef.current = fresh;
        setClusters(fresh);
      }
    } catch { /* volgende 20s-poll haalt het alsnog in */ }
    rebuildAllRef.current?.();
  }

  // Verplaatsen met de pijltjestoetsen: elke druk schuift het object 10 cm
  // (met Shift 50 cm) over de kaart; het model beweegt direct mee en de
  // verschuiving wordt 600 ms na de laatste druk opgeslagen.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const key = moveKeyRef.current;
      if (!key) return;
      const richting: Record<string, [number, number]> = {
        ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
      };
      if (e.key === 'Escape') { moveKeyRef.current = null; setMoveKey(null); return; }
      const r = richting[e.key];
      if (!r) return;
      e.preventDefault();
      const c = clustersRef.current.find((cl) => cl.key === key);
      if (!c) return;
      const stap = e.shiftKey ? 0.5 : 0.1;
      const huidig = nudgeRef.current ?? { x: c.xOffset ?? 0, y: c.yOffset ?? 0 };
      huidig.x += r[0] * stap;
      huidig.y += r[1] * stap;
      nudgeRef.current = huidig;
      // direct visueel: model + omranding meeschuiven
      const inst = modelInstancesRef.current.get(key);
      if (inst) { inst.position.x += r[0] * stap; inst.position.y += r[1] * stap; }
      const rand = outlinesRef.current.get(key);
      if (rand) { rand.position.x += r[0] * stap; rand.position.y += r[1] * stap; }
      if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
      nudgeTimerRef.current = setTimeout(() => {
        const eind = nudgeRef.current;
        nudgeRef.current = null;
        const c2 = clustersRef.current.find((cl) => cl.key === key);
        if (c2 && eind) void commitMove(c2, eind.x, eind.y);
      }, 600);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    apiFetch('/api/dashboard/terrain-models')
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((b: { models?: string[] }) => setCustomModels(b.models ?? []))
      .catch(() => { /* lijst is optioneel */ });
  }, []);

  const selectedCluster = selectedKey ? clusters.find((c) => c.key === selectedKey) ?? null : null;
  const selectedClusterClass = selectedCluster ? findClusterClass(selectedCluster.className) : undefined;

  useEffect(() => {
    if (selectedCluster) {
      setEditSize(selectedCluster.sizeOverride
        ?? Math.max(selectedCluster.maxX - selectedCluster.minX, 0.3));
      setEditHeight(selectedCluster.heightOverride
        ?? Math.max(selectedCluster.maxH, 0.2));
      setEditZ(selectedCluster.zOffset ?? 0);
    }
  }, [selectedCluster?.key]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Alleen herkende objecten in de lijst: onbekende clusters zijn voxels
  // zonder naam en zouden de lijst met honderden regels vullen.
  const namedClusters = clusters
    .filter((c) => c.className)
    .sort((a, b) => b.cells - a.cells);

  /** Camera naar een object toe bewegen en het selecteren. */
  function focusCluster(c: TerrainCluster): void {
    setSelectedKey(c.key);
    const cam = cameraRef.current;
    const ctr = controlsRef.current;
    if (!cam || !ctr) return;
    const cx = (c.minX + c.maxX) / 2;
    const cy = (c.minY + c.maxY) / 2;
    const cz = groundAtRef.current(cx, cy);
    // Afstand meeschalen met de objectgrootte, met een ondergrens zodat een
    // klein object niet tot in de voxels wordt ingezoomd.
    const span = Math.max(c.maxX - c.minX, c.maxY - c.minY, 1);
    const dist = Math.max(span * 3, 6);
    ctr.target.set(cx, cy, cz);
    cam.position.set(cx, cy - dist, cz + dist * 0.7);
    ctr.update();
  }

  return (
    <div className="h-full w-full relative">
      {status === 'loading' && <div className="absolute inset-0 flex items-center justify-center text-gray-400">Terrein laden…</div>}
      {status === 'empty' && <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-center px-8">Nog geen terreindata — de kaart groeit vanzelf tijdens het maaien.</div>}
      {status === 'error' && <div className="absolute inset-0 flex items-center justify-center text-red-400">Terrein laden mislukt</div>}
      {status === 'ready' && hasObjects && (
        <div className="absolute top-3 right-3 bg-black/60 text-xs text-gray-200 rounded-lg p-3 space-y-1.5 backdrop-blur pointer-events-auto">
          <div className="font-medium text-gray-300 mb-1">Objecten</div>
          {COLOR_GROUPS.map(group => (
            <label key={group.id} className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={legendVisible[group.id] ?? true}
                onChange={(e) => {
                  const checked = e.target.checked;
                  const next = { ...legendVisibleRef.current, [group.id]: checked };
                  legendVisibleRef.current = next;
                  setLegendVisible(next);
                  const mesh = voxelMeshesRef.current.get(group.id);
                  if (mesh) mesh.visible = checked;
                }}
              />
              <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: group.color }} />
              {group.label}
            </label>
          ))}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={outlinesVisible}
              onChange={(e) => {
                outlinesVisibleRef.current = e.target.checked;
                setOutlinesVisible(e.target.checked);
                for (const o of outlinesRef.current.values()) o.visible = e.target.checked;
              }}
            />
            <span className="inline-block w-3 h-3 rounded-sm border border-yellow-400" />
            {t('terrain.outlinesLabel')}
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={followMower}
              onChange={(e) => {
                followRef.current = e.target.checked;
                setFollowMower(e.target.checked);
                if (e.target.checked) updateMarkerFnRef.current(livePosRef.current);
              }}
            />
            <span className="inline-block w-3 h-3 rounded-sm bg-amber-400" />
            {t('terrain.followLabel')}
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showCamera}
              onChange={(e) => setShowCamera(e.target.checked)}
            />
            <span className="inline-block w-3 h-3 rounded-sm bg-emerald-400" />
            {t('terrain.cameraLabel')}
          </label>
          <div className="pt-2 mt-1 border-t border-white/10">
            <div className="text-gray-400 mb-1">{t('terrain.minHeightLabel')}: {Math.round(minObjHeight * 100)} cm</div>
            <input
              type="range" min={0.1} max={0.5} step={0.05} value={minObjHeight}
              className="w-full"
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setMinObjHeight(v);
                minObjHeightRef.current = v;
                rebuildAllRef.current?.();
              }}
            />
            <div className="text-gray-400 mt-2 mb-1">{t('terrain.minCntLabel')}: {minObjCnt}x</div>
            <input
              type="range" min={1} max={8} step={1} value={minObjCnt}
              className="w-full"
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                setMinObjCnt(v);
                minObjCntRef.current = v;
                rebuildAllRef.current?.();
              }}
            />
          </div>
        </div>
      )}
      {status === 'ready' && namedClusters.length > 0 && (
        <div className="absolute top-3 left-3 bg-black/60 text-xs text-gray-200 rounded-lg p-2 backdrop-blur pointer-events-auto w-56 max-h-[45vh] overflow-y-auto">
          <div className="font-medium text-gray-300 px-1 pb-1.5">
            {t('terrain.objectListTitle')} ({namedClusters.length})
          </div>
          {namedClusters.map((c) => {
            const klasse = findClusterClass(c.className);
            const actief = c.key === selectedKey;
            return (
              <button
                key={c.key}
                onClick={() => focusCluster(c)}
                className={`w-full text-left px-1.5 py-1 rounded flex items-center gap-2 hover:bg-white/10 ${actief ? 'bg-white/15' : ''}`}
              >
                <CropThumb url={c.photoUrl} className="w-7 h-7 rounded object-cover shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate">
                    {klasse ? t(klasse.i18nKey) : t('terrain.objectUnknown')}
                  </span>
                  <span className="block text-[10px] text-gray-400">
                    {(c.maxX - c.minX).toFixed(1)}×{(c.maxY - c.minY).toFixed(1)} m
                    {c.userOverride ? ` · ${t('terrain.objectCorrected')}` : ''}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {addAt && !selectedCluster && (
        <div className="absolute bottom-3 left-3 bg-black/70 text-xs text-gray-200 rounded-lg p-3 space-y-2 backdrop-blur pointer-events-auto w-72">
          <div className="flex items-center justify-between">
            <div className="font-medium text-gray-300">{t('terrain.addObjectTitle')}</div>
            <button onClick={() => setAddAt(null)} className="text-gray-400 hover:text-white">✕</button>
          </div>
          <div className="text-gray-400">x={addAt.x.toFixed(1)} m, y={addAt.y.toFixed(1)} m</div>
          <select
            value={addClass}
            className="mt-1 w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
            onChange={(e) => setAddClass(e.target.value)}
          >
            {CLUSTER_CLASSES.map((c) => (
              <option key={c.prompt} value={c.prompt}>{t(c.i18nKey)}</option>
            ))}
          </select>
          <div className="text-[10px] uppercase tracking-wide text-gray-500 mt-1">{t('terrain.modelLabel')}</div>
          <select
            value={addModel}
            className="mt-1 w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
            onChange={(e) => setAddModel(e.target.value)}
          >
            <option value="__default__">{t('terrain.modelDefault')}</option>
            {customModels.map((m) => (
              <option key={m} value={m}>{m.replace(/\.glb$/, '')}</option>
            ))}
          </select>
          <label className="block text-center text-[11px] text-blue-400 hover:text-blue-300 cursor-pointer">
            {t('terrain.modelUpload')}
            <input type="file" accept=".glb" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleModelUpload(f).then((up) => { if (up) setAddModel(up); });
                e.target.value = '';
              }} />
          </label>
          <div className="text-gray-400 mt-1">{t('terrain.addSizeLabel')}: {addSize.toFixed(1)} m</div>
          <input type="range" min={0.3} max={6} step={0.1} value={addSize} className="w-full"
            onChange={(e) => setAddSize(parseFloat(e.target.value))} />
          <div className="text-gray-400">{t('terrain.addHeightLabel')}: {addHeight.toFixed(1)} m</div>
          <input type="range" min={0.2} max={4} step={0.1} value={addHeight} className="w-full"
            onChange={(e) => setAddHeight(parseFloat(e.target.value))} />
          <button
            onClick={() => { void handleAddObject(); }}
            disabled={savingOverride}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded px-2 py-1.5"
          >
            {t('terrain.addObjectButton')}
          </button>
        </div>
      )}
      {selectedCluster && (
        <div className="absolute bottom-3 left-3 bg-black/70 text-xs text-gray-200 rounded-lg p-3 space-y-2 backdrop-blur pointer-events-auto w-72">
          <div className="flex items-center justify-between">
            <div className="font-medium text-gray-300">{t('terrain.objectPanelTitle')}</div>
            <button
              onClick={() => setSelectedKey(null)}
              className="text-gray-400 hover:text-gray-200 leading-none"
              aria-label={t('terrain.objectClose')}
            >
              ✕
            </button>
          </div>
          {selectedCluster.photoUrl && (
            <CropThumb url={selectedCluster.photoUrl} className="w-full rounded max-h-32 object-cover" />
          )}
          <div className="text-gray-200">
            {selectedClusterClass ? t(selectedClusterClass.i18nKey) : t('terrain.objectUnknown')}
          </div>
          {selectedCluster.confidence != null && (
            <div className="text-gray-400">
              {t('terrain.objectConfidence')}: {Math.round(selectedCluster.confidence * 100)}%
            </div>
          )}
          {selectedCluster.userOverride && (
            <div className="text-amber-400">{t('terrain.objectManualOverride')}</div>
          )}
          <div>
            <label className="text-[9px] text-gray-500 uppercase tracking-wide">{t('terrain.objectCorrectLabel')}</label>
            <select
              value={selectedCluster.userOverride ?? AUTO_OVERRIDE_VALUE}
              disabled={savingOverride}
              onChange={(e) => { void handleOverrideChange(selectedCluster.key, e.target.value); }}
              className="mt-1 w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
            >
              <option value={AUTO_OVERRIDE_VALUE}>{t('terrain.objectAuto')}</option>
              {CLUSTER_CLASSES.map((c) => (
                <option key={c.prompt} value={c.prompt}>{t(c.i18nKey)}</option>
              ))}
              <option value={NONE_OVERRIDE_VALUE}>{t('terrain.objectNone')}</option>
            </select>
            <div className="text-[10px] uppercase tracking-wide text-gray-500 mt-2">{t('terrain.modelLabel')}</div>
            <select
              value={selectedCluster.modelFile ?? '__default__'}
              className="mt-1 w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
              onChange={(e) => { void handleModelChange(selectedCluster.key, e.target.value); }}
            >
              <option value="__default__">{t('terrain.modelDefault')}</option>
              {customModels.map((m) => (
                <option key={m} value={m}>{m.replace(/\.glb$/, '')}</option>
              ))}
            </select>
            <div className="flex items-center justify-between mt-1.5">
              <label className="text-[11px] text-blue-400 hover:text-blue-300 cursor-pointer">
                {t('terrain.modelUpload')}
                <input type="file" accept=".glb" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleModelUpload(f); e.target.value = ''; }} />
              </label>
              {selectedCluster.modelFile && (
                <button
                  className="text-[11px] text-blue-400 hover:text-blue-300"
                  onClick={() => {
                    const naam = window.prompt(t('terrain.modelRenamePrompt'), selectedCluster.modelFile!.replace(/\.glb$/, ''));
                    if (naam) void handleModelRename(selectedCluster.modelFile!, naam);
                  }}
                >
                  {t('terrain.modelRename')}
                </button>
              )}
            </div>
            <div className="text-gray-400 mt-1">{t('terrain.addSizeLabel')}: {editSize.toFixed(1)} m</div>
            <input type="range" min={0.3} max={10} step={0.1} value={editSize} className="w-full"
              onChange={(e) => setEditSize(parseFloat(e.target.value))}
              onPointerUp={() => { void handleDisplayCommit(); }} />
            <div className="text-gray-400">{t('terrain.addHeightLabel')}: {editHeight.toFixed(1)} m</div>
            <input type="range" min={0.2} max={5} step={0.1} value={editHeight} className="w-full"
              onChange={(e) => setEditHeight(parseFloat(e.target.value))}
              onPointerUp={() => { void handleDisplayCommit(); }} />
            <div className="text-gray-400">{t('terrain.zOffsetLabel')}: {editZ >= 0 ? '+' : ''}{editZ.toFixed(2)} m</div>
            <input type="range" min={-1.5} max={1.5} step={0.05} value={editZ} className="w-full"
              onChange={(e) => setEditZ(parseFloat(e.target.value))}
              onPointerUp={() => { void handleDisplayCommit(); }} />
            <button
              onClick={() => {
                const actief = moveKey === selectedCluster.key;
                moveKeyRef.current = actief ? null : selectedCluster.key;
                setMoveKey(actief ? null : selectedCluster.key);
              }}
              className={`w-full mt-1 rounded px-2 py-1.5 ${moveKey === selectedCluster.key
                ? 'bg-amber-600 hover:bg-amber-500 text-white'
                : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`}
            >
              {moveKey === selectedCluster.key ? t('terrain.moveActive') : t('terrain.moveButton')}
            </button>
          </div>
        </div>
      )}
      {showCamera && (
        <div className="absolute bottom-3 right-3 z-[1000] max-w-[calc(100vw-1.5rem)] pointer-events-auto">
          <CameraTile sn={sn} onClose={() => setShowCamera(false)} />
        </div>
      )}
      <div ref={mountRef} className="h-full w-full" />
    </div>
  );
}
