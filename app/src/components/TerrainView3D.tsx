/**
 * Native 3D-terreinviewer: heightmap + object-voxels + live maaier-marker.
 * Data via de raw=1-endpoints (geen gzip-afhankelijkheid in RN-fetch).
 * Gedeelde byte-parsers met het dashboard; mesh-bouw = zelfde expliciete
 * vertex-aanpak als daar (Y-flip-les: nooit op PlaneGeometry's as-conventie
 * leunen).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, PanResponder, Text, Image, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Canvas, useFrame, useThree } from '@react-three/fiber/native';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import { parseTerrain, parseObjects, LABEL_COLORS, LABEL_DEFAULT_COLOR, type TerrainData, type ObjectData } from '../utils/terrainParser';
import { glbModuleForClass } from '../utils/clusterModels';
import { getServerUrl } from '../services/auth';
import { ApiClient } from '../services/api';
import { useMowerState } from '../hooks/useMowerState';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';

const POLL_MS = 20_000;
// Boven deze verplaatsing (px) is het een orbit-drag, geen tik; boven deze
// duur (ms) tellen we een lange-houd niet meer als tik. Puur additief op de
// bestaande orbit-PanResponder — camera-gedrag verandert niet.
const TAP_MOVE_THRESHOLD = 10;
const TAP_MAX_DURATION_MS = 500;

/** Eén rij van GET /api/dashboard/terrain-clusters/:sn (Task 7/9, hier read-only). */
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
}

function buildTerrainGeometry(t: TerrainData): { geo: THREE.BufferGeometry; groundAt: (x: number, y: number) => number; center: THREE.Vector3 } {
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
  const span = Math.max(hMax - hMin, 0.05);
  const geo = new THREE.PlaneGeometry(1, 1, W - 1, H - 1); // alleen topologie; alle vertices expliciet
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [0.13, 0.40, 0.18]], [0.4, [0.45, 0.65, 0.25]],
    [0.7, [0.85, 0.75, 0.35]], [1.0, [0.55, 0.38, 0.22]],
  ];
  const colAt = (tt: number): [number, number, number] => {
    for (let i = 1; i < stops.length; i++) {
      if (tt <= stops[i][0]) {
        const [t0, c0] = stops[i - 1]; const [t1, c1] = stops[i];
        const f = (tt - t0) / (t1 - t0);
        return [c0[0] + f * (c1[0] - c0[0]), c0[1] + f * (c1[1] - c0[1]), c0[2] + f * (c1[2] - c0[2])];
      }
    }
    return stops[stops.length - 1][1];
  };
  for (let vy = 0; vy < H; vy++) {
    for (let vx = 0; vx < W; vx++) {
      const vi = vy * W + vx;
      const hVal = grid[vi];
      const z = Number.isNaN(hVal) ? hMin : hVal;
      pos.setXYZ(vi, (minX + vx) * t.cellSize + t.cellSize / 2, (minY + vy) * t.cellSize + t.cellSize / 2, z);
      const [r, g, b] = Number.isNaN(hVal) ? [0.08, 0.09, 0.12] : colAt((z - hMin) / span);
      colors[vi * 3] = r; colors[vi * 3 + 1] = g; colors[vi * 3 + 2] = b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const groundAt = (x: number, y: number): number => {
    const gx = Math.floor(x / t.cellSize) - minX, gy = Math.floor(y / t.cellSize) - minY;
    if (gx < 0 || gy < 0 || gx >= W || gy >= H) return 0;
    const v = grid[gy * W + gx];
    return Number.isNaN(v) ? 0 : v;
  };
  const center = new THREE.Vector3(((minX + maxX) / 2) * t.cellSize, ((minY + maxY) / 2) * t.cellSize, 0);
  return { geo, groundAt, center };
}

/**
 * Eén-vinger slepen = orbit, twee-vinger pinch = zoom, korte tik (weinig
 * verplaatsing, kort vastgehouden, één vinger) = info-tik op een object.
 *
 * De omliggende View wint de touch al in de capture-fase (zie hieronder) —
 * dat betekent dat r3f's eigen onPointerDown/onPointerUp-events op de
 * Canvas-primitives NOOIT de kans krijgen om te vuren (de GLView onder
 * Canvas wordt nooit zelf responder). Tik-detectie gebeurt daarom hier, in
 * dezelfde PanResponder die de camera al bestuurt, via een verplaatsings-
 * en tijdsdrempel — niet via r3f's eigen event-systeem.
 */
function useOrbitGestures(
  camState: React.MutableRefObject<{ theta: number; phi: number; dist: number }>,
  onTap: (pageX: number, pageY: number) => void,
) {
  const last = useRef<{ x: number; y: number; d: number | null }>({ x: 0, y: 0, d: null });
  const tap = useRef({ startX: 0, startY: 0, startT: 0, moved: false, multitouch: false });
  return useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    // Capture-fase: win de touch VOOR een omliggende ScrollView hem claimt —
    // zonder dit werken orbit/pinch niet binnen het Map-scherm.
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponderCapture: () => true,
    onPanResponderTerminationRequest: () => false, // orbit-drag mag niet gestolen worden door een omliggende ScrollView
    onPanResponderGrant: (e) => {
      const t = e.nativeEvent.touches;
      last.current = { x: t[0].pageX, y: t[0].pageY, d: null };
      tap.current = { startX: t[0].pageX, startY: t[0].pageY, startT: Date.now(), moved: false, multitouch: t.length > 1 };
    },
    onPanResponderMove: (e) => {
      const t = e.nativeEvent.touches;
      if (t.length >= 2) {
        tap.current.multitouch = true;
        const d = Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
        if (last.current.d != null) {
          camState.current.dist = Math.min(60, Math.max(3, camState.current.dist * (last.current.d / d)));
        }
        last.current.d = d;
      } else {
        const dx = t[0].pageX - last.current.x, dy = t[0].pageY - last.current.y;
        camState.current.theta -= dx * 0.01;
        camState.current.phi = Math.min(1.45, Math.max(0.15, camState.current.phi - dy * 0.01));
        last.current = { x: t[0].pageX, y: t[0].pageY, d: null };
        if (Math.hypot(t[0].pageX - tap.current.startX, t[0].pageY - tap.current.startY) > TAP_MOVE_THRESHOLD) {
          tap.current.moved = true;
        }
      }
    },
    onPanResponderRelease: (e) => {
      const g = tap.current;
      if (g.multitouch || g.moved || Date.now() - g.startT > TAP_MAX_DURATION_MS) return;
      const touch = e.nativeEvent.changedTouches?.[0] ?? e.nativeEvent.touches?.[0];
      if (touch) onTap(touch.pageX, touch.pageY);
    },
  })).current;
}

function OrbitCamera({ target, camState }: { target: THREE.Vector3; camState: React.MutableRefObject<{ theta: number; phi: number; dist: number }> }) {
  const { camera } = useThree();
  useFrame(() => {
    const { theta, phi, dist } = camState.current;
    camera.position.set(
      target.x + dist * Math.cos(phi) * Math.sin(theta),
      target.y - dist * Math.cos(phi) * Math.cos(theta),
      target.z + dist * Math.sin(phi),
    );
    camera.up.set(0, 0, 1);
    camera.lookAt(target);
  });
  return null;
}

/**
 * Tilt r3f's camera-object door naar een ref buiten de Canvas-boundary — de
 * outer RN-tik-handler (handleTap) heeft de actuele camera nodig om zelf een
 * THREE.Raycaster op te zetten (r3f's eigen pointer-events bereiken de
 * primitives hier niet, zie useOrbitGestures-comment).
 */
function CameraCapture({ cameraRef }: { cameraRef: React.MutableRefObject<THREE.Camera | null> }) {
  const { camera } = useThree();
  useEffect(() => {
    cameraRef.current = camera;
    return () => { cameraRef.current = null; };
  }, [camera, cameraRef]);
  return null;
}

/** Bbox van een cluster (uit terrain-clusters) + of die als GLB-model getekend wordt. */
interface ClusterBBox {
  key: string;
  minX: number; minY: number; maxX: number; maxY: number;
  hasModel: boolean;
}

function clusterBBoxesFrom(clusters: TerrainCluster[]): ClusterBBox[] {
  return clusters.map((c) => ({
    key: c.key, minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY,
    hasModel: glbModuleForClass(c.className) !== null,
  }));
}

function findClusterAt(bboxes: ClusterBBox[], x: number, y: number): ClusterBBox | null {
  for (const b of bboxes) {
    if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return b;
  }
  return null;
}

/**
 * Zelfde logica als dashboard's buildObjectVoxels (TerrainPage.tsx) — één
 * InstancedMesh, kleur per instance. Cellen die binnen de bbox van een
 * cluster mét GLB-model vallen worden overgeslagen (die tekenen we als
 * 3D-model, niet als voxel — zie buildClusterModels hieronder). Voor
 * overgebleven cellen onthouden we per instance welke cluster (indien van
 * toepassing) ze raken, zodat een tik op die voxel ook het info-paneel kan
 * openen (bv. fence/charging station, die bewust geen GLB krijgen).
 * Retourneert null als er na filtering niets overblijft.
 */
// NB: cam_to_base clipt op HEIGHT_MAX 1.5 m — objecten hoger dan 1.5 m tonen tot die hoogte (bewuste v1-keuze).
function buildObjectVoxels(objs: ObjectData, groundAt: (x: number, y: number) => number, bboxes: ClusterBBox[]): THREE.InstancedMesh | null {
  const keep: number[] = [];
  const clusterKeys: Array<string | null> = [];
  for (let i = 0; i < objs.ix.length; i++) {
    const x = objs.ix[i] * objs.cellSize + objs.cellSize / 2;
    const y = objs.iy[i] * objs.cellSize + objs.cellSize / 2;
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
  mesh.userData.clusterKeys = clusterKeys;
  return mesh;
}

function disposeInstancedMesh(mesh: THREE.InstancedMesh | null): void {
  if (!mesh) return;
  mesh.geometry.dispose();
  const mat = mesh.material;
  if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose()); else mat.dispose();
}

// GLTFLoader-cache op moduleniveau: één keer laden per klasse (require()
// geeft een stabiel numeriek asset-module-id per bestand), daarna alleen
// nog `.clone(true)` per cluster-instantie. Blijft warm voor de levensduur
// van de app.
const gltfLoader = new GLTFLoader();
const modelLoadCache = new Map<number, Promise<THREE.Object3D>>();

/** Node-Buffer (base64) → een schone ArrayBuffer (geen gedeelde pool-offset). */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const buf = Buffer.from(base64, 'base64');
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Laadt een gebundeld GLB-asset (require-module-id uit clusterModels.ts) en
 * geeft de geparste three.js-scene terug. RN's fetch ondersteunt file://
 * URI's niet betrouwbaar (bekende beperking op Android) — daarom lezen we
 * het gedownloade lokale bestand zelf als base64 (expo-file-system, zelfde
 * patroon als appUpdate.ts) en geven we `gltfLoader.parse()` een echte
 * ArrayBuffer, i.p.v. `gltfLoader.load(uri, ...)` te vertrouwen op fetch.
 */
function loadClusterModel(glbModule: number): Promise<THREE.Object3D> {
  let p = modelLoadCache.get(glbModule);
  if (!p) {
    p = (async () => {
      const asset = Asset.fromModule(glbModule);
      await asset.downloadAsync();
      const uri = asset.localUri ?? asset.uri;
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const buffer = base64ToArrayBuffer(base64);
      return new Promise<THREE.Object3D>((resolve, reject) => {
        gltfLoader.parse(buffer, '', (gltf) => resolve(gltf.scene), reject);
      });
    })();
    modelLoadCache.set(glbModule, p);
  }
  return p;
}

interface TerrainScene {
  geo: THREE.BufferGeometry;
  groundAt: (x: number, y: number) => number;
  center: THREE.Vector3;
}

type ViewStatus = 'loading' | 'empty' | 'error' | 'ready';

/**
 * Zelfstandig 3D-terreinscherm voor één maaier. Fetcht + parset de raw
 * heightmap/object-grids, pollt elke 20s zolang gemount, en toont de live
 * maaier-positie als gele conus bovenop het terrein.
 */
export default function TerrainView3D({ sn }: { sn: string }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const { devices } = useMowerState();

  const [status, setStatus] = useState<ViewStatus>('loading');
  const [terrain, setTerrain] = useState<TerrainScene | null>(null);
  const [voxelMesh, setVoxelMesh] = useState<THREE.InstancedMesh | null>(null);
  // Werk- (groen) en obstakel- (rood) contouren uit de 2D-kaart; eenmalig
  // geladen (veranderen niet tijdens het kijken).
  const [polyLines, setPolyLines] = useState<THREE.Line[]>([]);
  const polyLoadedRef = useRef(false);

  // Herkende object-clusters (Task 7/9/10) — GLB-model-instanties + de
  // laatst bekende cluster-data (voor het alleen-lezen info-paneel).
  const [clusters, setClusters] = useState<TerrainCluster[]>([]);
  const [modelInstances, setModelInstances] = useState<Array<{ key: string; object: THREE.Object3D }>>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const modelInstancesRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const modelEpochRef = useRef(0);
  const baseUrlRef = useRef<string | null>(null);
  const cameraRef = useRef<THREE.Camera | null>(null);
  const layoutRef = useRef({ pageX: 0, pageY: 0, width: 0, height: 0 });
  const raycasterRef = useRef(new THREE.Raycaster());
  const containerRef = useRef<View>(null);

  const terrainRef = useRef<TerrainScene | null>(null);
  const voxelRef = useRef<THREE.InstancedMesh | null>(null);
  const mountedRef = useRef(true);
  const cameraInitialized = useRef(false);

  const camState = useRef({ theta: 0.7, phi: 0.65, dist: 12 });

  // Raycast tegen zowel de GLB-model-instanties (userData.clusterKey op elke
  // descendant, zie buildClusterModelsAsync) als de voxel-InstancedMesh
  // (userData.clusterKeys[instanceId], zie buildObjectVoxels). Puur
  // ref-gedreven zodat de closure die de PanResponder bij eerste render
  // vastlegt altijd de actuele state leest (zie useOrbitGestures-comment).
  const handleTap = useCallback((pageX: number, pageY: number) => {
    const camera = cameraRef.current;
    const { pageX: originX, pageY: originY, width, height } = layoutRef.current;
    if (!camera || width === 0 || height === 0) return;
    const ndcX = ((pageX - originX) / width) * 2 - 1;
    const ndcY = -((pageY - originY) / height) * 2 + 1;
    const targets: THREE.Object3D[] = [...modelInstancesRef.current.values()];
    if (voxelRef.current) targets.push(voxelRef.current);
    if (targets.length === 0) return;
    raycasterRef.current.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const hits = raycasterRef.current.intersectObjects(targets, true);
    for (const hit of hits) {
      const obj = hit.object as THREE.Object3D & { isInstancedMesh?: boolean };
      let key: string | null = null;
      if (obj.isInstancedMesh) {
        const keys = obj.userData.clusterKeys as Array<string | null> | undefined;
        key = keys && hit.instanceId != null ? (keys[hit.instanceId] ?? null) : null;
      } else {
        key = (obj.userData.clusterKey as string | undefined) ?? null;
      }
      if (key) { setSelectedKey(key); return; }
    }
  }, []);

  const panResponder = useOrbitGestures(camState, handleTap);

  const disposeTerrain = useCallback(() => {
    if (terrainRef.current) {
      terrainRef.current.geo.dispose();
      terrainRef.current = null;
    }
  }, []);

  const disposeVoxels = useCallback(() => {
    disposeInstancedMesh(voxelRef.current);
    voxelRef.current = null;
  }, []);

  // Plaatst voor elke cluster met een className+GLB een genormaliseerd
  // model (zie dashboard/public/models/SOURCES.md): geschaald naar de
  // gemeten voetafdruk/hoogte, positie op bbox-midden (niet cx/cy — zie
  // dezelfde reviewer-fix als TerrainPage.tsx). Laden is async+gecached
  // (modelLoadCache) — een epoch-check voorkomt dat een trage load na een
  // ondertussen alwéér gestarte rebuild alsnog een stale model toevoegt.
  const rebuildClusterModels = useCallback((clusterList: TerrainCluster[], groundAt: (x: number, y: number) => number) => {
    modelEpochRef.current += 1;
    const epoch = modelEpochRef.current;
    modelInstancesRef.current.clear();
    setModelInstances([]);
    for (const cl of clusterList) {
      const glbModule = glbModuleForClass(cl.className);
      if (glbModule == null) continue;
      loadClusterModel(glbModule).then((orig) => {
        if (!mountedRef.current || epoch !== modelEpochRef.current) return; // stale: nieuwe rebuild al bezig
        const clone = orig.clone(true);
        clone.traverse((o) => { o.userData.clusterKey = cl.key; });
        const bboxCx = (cl.minX + cl.maxX) / 2;
        const bboxCy = (cl.minY + cl.maxY) / 2;
        const g = groundAt(bboxCx, bboxCy);
        const sx = Math.max(cl.maxX - cl.minX, 0.15);
        const sy = Math.max(cl.maxY - cl.minY, 0.15);
        const sz = Math.max(cl.maxH - g, 0.1);
        clone.scale.set(sx, sy, sz);
        clone.position.set(bboxCx, bboxCy, g);
        modelInstancesRef.current.set(cl.key, clone);
        setModelInstances(Array.from(modelInstancesRef.current.entries()).map(([key, object]) => ({ key, object })));
      }).catch((err) => console.warn(`terrain3d: model laden mislukt (className=${cl.className})`, err));
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const base = await getServerUrl();
      if (!base) {
        if (mountedRef.current) setStatus('error');
        return;
      }
      baseUrlRef.current = base;

      const terrainRes = await fetch(`${base}/api/dashboard/terrain/${encodeURIComponent(sn)}?raw=1`);
      if (terrainRes.status === 404) {
        if (!mountedRef.current) return;
        disposeTerrain();
        disposeVoxels();
        modelInstancesRef.current.clear();
        setModelInstances([]);
        setClusters([]);
        setTerrain(null);
        setVoxelMesh(null);
        setStatus('empty');
        return;
      }
      if (!terrainRes.ok) {
        if (mountedRef.current) setStatus('error');
        return;
      }

      const terrainData = parseTerrain(await terrainRes.arrayBuffer());
      if (terrainData.ix.length === 0) {
        if (!mountedRef.current) return;
        disposeTerrain();
        disposeVoxels();
        modelInstancesRef.current.clear();
        setModelInstances([]);
        setClusters([]);
        setTerrain(null);
        setVoxelMesh(null);
        setStatus('empty');
        return;
      }

      if (!polyLoadedRef.current) {
        polyLoadedRef.current = true;
        try {
          const { maps } = await new ApiClient(base).fetchMaps(sn);
          const lines: THREE.Line[] = [];
          for (const m of maps) {
            const pts = (m.mapArea ?? []).map((pt) => new THREE.Vector3(pt.x, pt.y, m.mapType === 'obstacle' ? 0.08 : 0.05));
            if (pts.length < 3 || (m.mapType !== 'work' && m.mapType !== 'obstacle')) continue;
            pts.push(pts[0].clone());
            lines.push(new THREE.Line(
              new THREE.BufferGeometry().setFromPoints(pts),
              new THREE.LineBasicMaterial({ color: m.mapType === 'obstacle' ? 0xef4444 : 0x34d399 })));
          }
          if (mountedRef.current) setPolyLines(lines);
        } catch { /* contouren zijn nice-to-have; terrein rendert ook zonder */ }
      }

      const built = buildTerrainGeometry(terrainData);
      built.geo.computeBoundingSphere();
      if (!cameraInitialized.current) {
        const radius = built.geo.boundingSphere?.radius ?? 10;
        camState.current.dist = Math.min(60, Math.max(3, radius * 2.2));
        cameraInitialized.current = true;
      }

      // Objecten en clusters zijn optioneel — 404 of een netwerkfout
      // betekent gewoon "geen objecten/clusters", nooit een reden om het
      // hele terrein af te keuren.
      let clusterList: TerrainCluster[] = [];
      try {
        const clusterRes = await fetch(`${base}/api/dashboard/terrain-clusters/${encodeURIComponent(sn)}`);
        if (clusterRes.ok) {
          const body = await clusterRes.json() as { clusters?: TerrainCluster[] };
          clusterList = body.clusters ?? [];
        }
      } catch {
        clusterList = [];
      }
      const bboxes = clusterBBoxesFrom(clusterList);

      let newVoxelMesh: THREE.InstancedMesh | null = null;
      try {
        const objRes = await fetch(`${base}/api/dashboard/terrain-objects/${encodeURIComponent(sn)}?raw=1`);
        if (objRes.ok) {
          const objData = parseObjects(await objRes.arrayBuffer());
          if (objData.ix.length > 0) newVoxelMesh = buildObjectVoxels(objData, built.groundAt, bboxes);
        }
      } catch {
        newVoxelMesh = null;
      }

      if (!mountedRef.current) {
        built.geo.dispose();
        disposeInstancedMesh(newVoxelMesh);
        return;
      }

      disposeTerrain();
      disposeVoxels();
      terrainRef.current = { geo: built.geo, groundAt: built.groundAt, center: built.center };
      voxelRef.current = newVoxelMesh;
      setTerrain(terrainRef.current);
      setVoxelMesh(newVoxelMesh);
      setClusters(clusterList);
      rebuildClusterModels(clusterList, built.groundAt);
      setStatus('ready');
    } catch {
      if (mountedRef.current) setStatus('error');
    }
  }, [sn, disposeTerrain, disposeVoxels, rebuildClusterModels]);

  useEffect(() => {
    mountedRef.current = true;
    cameraInitialized.current = false;
    setStatus('loading');
    setTerrain(null);
    setVoxelMesh(null);
    setClusters([]);
    setSelectedKey(null);
    modelInstancesRef.current.clear();
    setModelInstances([]);

    void load();
    const interval = setInterval(() => { void load(); }, POLL_MS);

    return () => {
      mountedRef.current = false;
      modelEpochRef.current += 1; // discardt eventuele nog-lopende model-loads
      clearInterval(interval);
      disposeTerrain();
      disposeVoxels();
      modelInstancesRef.current.clear(); // geen dispose — clone(true) deelt geometry/material met de gecachete originele GLTF
      setPolyLines((lines) => {
        for (const l of lines) {
          l.geometry.dispose();
          (l.material as THREE.Material).dispose();
        }
        return [];
      });
    };
  }, [load, disposeTerrain, disposeVoxels]);

  // Live maaier-positie: zelfde velden als HomeScreen's mowerPosX/mowerPosY
  // afleiding (sensors.map_position_x/y, string → float).
  const sensors = devices.get(sn)?.sensors;
  const markerPos = useMemo(() => {
    if (!terrain || !sensors) return null;
    const x = parseFloat(sensors.map_position_x ?? '');
    const y = parseFloat(sensors.map_position_y ?? '');
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, z: terrain.groundAt(x, y) + 0.15 };
  }, [terrain, sensors]);

  const selectedCluster = selectedKey ? clusters.find((c) => c.key === selectedKey) ?? null : null;
  const photoUri = selectedCluster?.photoUrl && baseUrlRef.current ? `${baseUrlRef.current}${selectedCluster.photoUrl}` : null;

  return (
    <View
      ref={containerRef}
      style={styles.container}
      onLayout={() => {
        containerRef.current?.measureInWindow((x, y, width, height) => {
          layoutRef.current = { pageX: x, pageY: y, width, height };
        });
      }}
      {...panResponder.panHandlers}
    >
      {status === 'loading' && (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.emerald} />
        </View>
      )}
      {status === 'error' && (
        <View style={styles.center}>
          <Text style={[styles.statusText, { color: colors.red }]}>{t('error', undefined) || 'Fout'}</Text>
        </View>
      )}
      {status === 'empty' && (
        <View style={styles.center}>
          <Text style={[styles.statusText, { color: colors.textMuted }]}>
            {t('terrain3dEmpty', undefined) || 'De kaart groeit tijdens het maaien…'}
          </Text>
        </View>
      )}
      {status === 'ready' && terrain && (
        <Canvas style={styles.canvas}>
          <color attach="background" args={['#0b1020']} />
          <ambientLight intensity={0.55} />
          <directionalLight position={[30, 20, 50]} intensity={0.9} />
          <OrbitCamera target={terrain.center} camState={camState} />
          <CameraCapture cameraRef={cameraRef} />
          <mesh geometry={terrain.geo}>
            <meshStandardMaterial vertexColors />
          </mesh>
          {voxelMesh && <primitive object={voxelMesh} />}
          {modelInstances.map(({ key, object }) => <primitive key={key} object={object} />)}
          {polyLines.map((l, i) => <primitive key={i} object={l} />)}
          {markerPos && (
            <mesh position={[markerPos.x, markerPos.y, markerPos.z]} rotation={[Math.PI / 2, 0, 0]}>
              <coneGeometry args={[0.15, 0.3, 12]} />
              <meshStandardMaterial color="#facc15" />
            </mesh>
          )}
        </Canvas>
      )}
      {selectedCluster && (
        <View style={styles.infoPanel}>
          <View style={styles.infoPanelHeader}>
            <Text style={styles.infoPanelTitle} numberOfLines={1}>
              {selectedCluster.nl ?? selectedCluster.className ?? 'Onbekend object'}
            </Text>
            <TouchableOpacity onPress={() => setSelectedKey(null)} hitSlop={8}>
              <Text style={styles.infoPanelClose}>{t('close', undefined) || 'Sluiten'}</Text>
            </TouchableOpacity>
          </View>
          {photoUri && (
            <Image source={{ uri: photoUri }} style={styles.infoPanelPhoto} resizeMode="cover" />
          )}
          {selectedCluster.confidence != null && (
            <Text style={styles.infoPanelMeta}>{Math.round(selectedCluster.confidence * 100)}%</Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  canvas: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  statusText: { fontSize: 15, textAlign: 'center' },
  infoPanel: {
    position: 'absolute',
    left: 12,
    bottom: 12,
    right: 12,
    maxWidth: 320,
    backgroundColor: 'rgba(10,14,26,0.88)',
    borderRadius: 12,
    padding: 12,
  },
  infoPanelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  infoPanelTitle: { flex: 1, color: '#e5e7eb', fontSize: 15, fontWeight: '600' },
  infoPanelClose: { color: '#9ca3af', fontSize: 13 },
  infoPanelPhoto: { width: '100%', height: 120, borderRadius: 8, marginTop: 8, backgroundColor: '#1f2937' },
  infoPanelMeta: { color: '#9ca3af', fontSize: 12, marginTop: 6 },
});
