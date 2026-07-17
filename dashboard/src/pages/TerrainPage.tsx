/**
 * 3D-terreinviewer: heightmap-mesh uit het TGR1 display-grid, hoogte-
 * shading, orbit-controls, werk-polygonen als overlay-lijnen, object-voxels
 * uit het TGO1-objectgrid (met kleurgroep-legenda), live maaier-marker +
 * trail, en een 20s-poll die beide grids her-fetcht zonder geheugengroei.
 * Lazy-loaded — three.js blijft buiten de hoofdbundle.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  parseTerrain, parseObjects, LABEL_COLORS, LABEL_DEFAULT_COLOR,
  type TerrainData, type ObjectData,
} from '../utils/terrainParser';
import { apiFetch, fetchMaps, fetchDevices } from '../api/client';
import { getSocket } from '../api/socket';
import type { DeviceUpdateEvent } from '../types';

const POLL_INTERVAL_MS = 20_000;
const TRAIL_MAX_POINTS = 50;

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
const DEFAULT_LEGEND_VISIBLE: Record<string, boolean> = Object.fromEntries(COLOR_GROUPS.map(g => [g.id, true]));

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

function buildTerrainMesh(t: TerrainData): THREE.Mesh {
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

function buildObjectVoxels(objs: ObjectData, groundAt: (x: number, y: number) => number): THREE.InstancedMesh {
  const geo = new THREE.BoxGeometry(objs.cellSize, objs.cellSize, 1);
  geo.translate(0, 0, 0.5); // schalen vanaf de voet
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), objs.ix.length);
  const m = new THREE.Matrix4(); const c = new THREE.Color();
  for (let i = 0; i < objs.ix.length; i++) {
    const x = objs.ix[i] * objs.cellSize + objs.cellSize / 2;
    const y = objs.iy[i] * objs.cellSize + objs.cellSize / 2;
    const g = groundAt(x, y);
    const height = Math.max(objs.h[i] - g, 0.05);
    m.identity(); m.setPosition(x, y, g); m.scale(new THREE.Vector3(1, 1, height));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.set(LABEL_COLORS[objs.label[i]] ?? LABEL_DEFAULT_COLOR));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

function disposeMesh(obj: THREE.Mesh | THREE.Line | THREE.InstancedMesh | null | undefined): void {
  if (!obj) return;
  obj.geometry.dispose();
  const mat = obj.material;
  if (Array.isArray(mat)) mat.forEach(mm => mm.dispose()); else mat.dispose();
}

export default function TerrainPage({ sn }: { sn: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'empty' | 'ready' | 'error'>('loading');
  const [hasObjects, setHasObjects] = useState(false);
  const [legendVisible, setLegendVisible] = useState<Record<string, boolean>>(DEFAULT_LEGEND_VISIBLE);
  const [livePos, setLivePos] = useState<LivePos | null>(null);

  const legendVisibleRef = useRef<Record<string, boolean>>(DEFAULT_LEGEND_VISIBLE);
  const livePosRef = useRef<LivePos | null>(null);
  livePosRef.current = livePos;

  const terrainMeshRef = useRef<THREE.Mesh | null>(null);
  const voxelMeshesRef = useRef<Map<string, THREE.InstancedMesh>>(new Map());
  const groundAtRef = useRef<(x: number, y: number) => number>(() => 0);
  const markerRef = useRef<THREE.Mesh | null>(null);
  const trailLineRef = useRef<THREE.Line | null>(null);
  const trailPointsRef = useRef<THREE.Vector3[]>([]);
  const updateMarkerFnRef = useRef<(pos: LivePos | null) => void>(() => {});

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

    const applyToLivePos = () => {
      const x = parseFloat(sensors.map_position_x ?? '');
      const y = parseFloat(sensors.map_position_y ?? '');
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

    // Vervangt terrein- en voxel-meshes in de scene; dispose't de oude
    // geometrieën/materialen eerst zodat uren openstaan geen geheugen lekt.
    function rebuild(scene: THREE.Scene, terrain: TerrainData, objects: ObjectData | null): THREE.Mesh {
      if (terrainMeshRef.current) { scene.remove(terrainMeshRef.current); disposeMesh(terrainMeshRef.current); }
      const mesh = buildTerrainMesh(terrain);
      scene.add(mesh);
      terrainMeshRef.current = mesh;
      groundAtRef.current = makeGroundLookup(terrain);

      for (const vm of voxelMeshesRef.current.values()) { scene.remove(vm); disposeMesh(vm); }
      voxelMeshesRef.current.clear();

      let anyObjects = false;
      if (objects && objects.ix.length > 0) {
        for (const group of COLOR_GROUPS) {
          const filtered = filterObjectsByLabels(objects, group.labels);
          if (filtered.ix.length === 0) continue;
          anyObjects = true;
          const vm = buildObjectVoxels(filtered, groundAtRef.current);
          vm.visible = legendVisibleRef.current[group.id] ?? true;
          scene.add(vm);
          voxelMeshesRef.current.set(group.id, vm);
        }
      }
      setHasObjects(anyObjects);
      return mesh;
    }

    (async () => {
      const res = await apiFetch(`/api/dashboard/terrain/${encodeURIComponent(sn)}`);
      if (res.status === 404) { setStatus('empty'); return; }
      if (!res.ok) { setStatus('error'); return; }
      const terrain = parseTerrain(await res.arrayBuffer());
      const [mapsResponse, objects] = await Promise.all([
        fetchMaps(sn).catch(() => null),
        loadObjects(),
      ]);
      const maps = mapsResponse?.maps ?? [];
      if (disposed || !mountRef.current) return;

      const el = mountRef.current;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0b1020);
      const camera = new THREE.PerspectiveCamera(55, el.clientWidth / el.clientHeight, 0.1, 500);
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(el.clientWidth, el.clientHeight);
      el.appendChild(renderer.domElement);

      const mesh = rebuild(scene, terrain, objects);
      scene.add(new THREE.AmbientLight(0xffffff, 0.55));
      const sun = new THREE.DirectionalLight(0xffffff, 0.9);
      sun.position.set(30, 20, 50);
      scene.add(sun);

      // werk-polygonen als overlay-lijnen 5 cm boven het terrein — statisch,
      // niet meegenomen in de 20s-poll (verandert niet tijdens het kijken)
      for (const m of maps.filter(m => m.mapType === 'work' && m.mapArea?.length)) {
        const pts = m.mapArea.map(p => new THREE.Vector3(p.x, p.y, 0.05));
        pts.push(pts[0].clone());
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: 0x34d399 }));
        scene.add(line);
        polygonLines.push(line);
      }

      // maaier-marker (gele cone) + trail van de laatste 50 posities
      const marker = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.3, 12), new THREE.MeshBasicMaterial({ color: 0xfbbf24 }));
      marker.visible = false;
      scene.add(marker);
      markerRef.current = marker;
      const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xfbbf24 }));
      scene.add(trail);
      trailLineRef.current = trail;

      updateMarkerFnRef.current = (pos: LivePos | null) => {
        if (!markerRef.current || !trailLineRef.current) return;
        if (!pos) { markerRef.current.visible = false; return; }
        const g = groundAtRef.current(pos.x, pos.y);
        markerRef.current.position.set(pos.x, pos.y, g + 0.15);
        markerRef.current.quaternion.identity();
        markerRef.current.rotateX(Math.PI / 2); // cone-as (lokaal Y) → wereld-Z (omhoog)
        markerRef.current.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), pos.theta);
        markerRef.current.visible = true;

        const pts = trailPointsRef.current;
        pts.push(new THREE.Vector3(pos.x, pos.y, g + 0.02));
        while (pts.length > TRAIL_MAX_POINTS) pts.shift();
        trailLineRef.current.geometry.dispose();
        trailLineRef.current.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      };
      updateMarkerFnRef.current(livePosRef.current); // direct syncen met wat er al binnen is

      const box = new THREE.Box3().setFromObject(mesh);
      const center = box.getCenter(new THREE.Vector3());
      camera.position.set(center.x, center.y - 15, 18);
      camera.up.set(0, 0, 1);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.copy(center);

      const animate = () => {
        frameId = requestAnimationFrame(animate);
        controls.update();
        renderer!.render(scene, camera);
      };
      animate();
      setStatus('ready');

      // 20s-poll zolang de pagina gemount is: beide grids her-fetchen en de
      // scene-inhoud vervangen (rebuild dispose't de oude meshes zelf).
      intervalId = setInterval(async () => {
        if (disposed) return;
        const [terrainRes, freshObjects] = await Promise.all([
          apiFetch(`/api/dashboard/terrain/${encodeURIComponent(sn)}`),
          loadObjects(),
        ]);
        if (disposed || !terrainRes.ok) return;
        const freshTerrain = parseTerrain(await terrainRes.arrayBuffer());
        if (disposed) return;
        rebuild(scene, freshTerrain, freshObjects);
        updateMarkerFnRef.current(livePosRef.current);
      }, POLL_INTERVAL_MS);
    })().catch(() => setStatus('error'));

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      if (intervalId !== undefined) clearInterval(intervalId);
      updateMarkerFnRef.current = () => {};

      disposeMesh(terrainMeshRef.current);
      terrainMeshRef.current = null;
      for (const vm of voxelMeshesRef.current.values()) disposeMesh(vm);
      voxelMeshesRef.current.clear();
      disposeMesh(markerRef.current);
      markerRef.current = null;
      disposeMesh(trailLineRef.current);
      trailLineRef.current = null;
      for (const line of polygonLines) disposeMesh(line);

      renderer?.dispose();
      if (renderer?.domElement.parentElement) renderer.domElement.parentElement.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sn]);

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
        </div>
      )}
      <div ref={mountRef} className="h-full w-full" />
    </div>
  );
}
