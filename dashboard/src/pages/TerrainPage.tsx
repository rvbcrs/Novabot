/**
 * 3D-terreinviewer: heightmap-mesh uit het TGR1 display-grid, hoogte-
 * shading, orbit-controls, werk-polygonen als overlay-lijnen.
 * Lazy-loaded — three.js blijft buiten de hoofdbundle.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { parseTerrain, type TerrainData } from '../utils/terrainParser';
import { apiFetch, fetchMaps } from '../api/client';

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

  const geo = new THREE.PlaneGeometry(W * t.cellSize, H * t.cellSize, W - 1, H - 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  for (let vy = 0; vy < H; vy++) {
    for (let vx = 0; vx < W; vx++) {
      const vi = vy * W + vx;
      const hVal = grid[vi];
      const z = Number.isNaN(hVal) ? hMin : hVal;
      pos.setZ(vi, z);
      const [r, g, b] = Number.isNaN(hVal) ? [0.10, 0.12, 0.16] : heightColor((z - hMin) / span);
      colors[vi * 3] = r; colors[vi * 3 + 1] = g; colors[vi * 3 + 2] = b;
    }
  }
  // plaats het vlak op de juiste kaartcoördinaten (celcentra)
  geo.translate((minX + (W - 1) / 2) * t.cellSize + t.cellSize / 2,
                (minY + (H - 1) / 2) * t.cellSize + t.cellSize / 2, 0);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
}

export default function TerrainPage({ sn }: { sn: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'empty' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let disposed = false;
    let renderer: THREE.WebGLRenderer | null = null;
    let frameId = 0;
    (async () => {
      const res = await apiFetch(`/api/dashboard/terrain/${encodeURIComponent(sn)}`);
      if (res.status === 404) { setStatus('empty'); return; }
      if (!res.ok) { setStatus('error'); return; }
      const terrain = parseTerrain(await res.arrayBuffer());
      const mapsResponse = await fetchMaps(sn).catch(() => null);
      const maps = mapsResponse?.maps ?? [];
      if (disposed || !mountRef.current) return;

      const el = mountRef.current;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0b1020);
      const camera = new THREE.PerspectiveCamera(55, el.clientWidth / el.clientHeight, 0.1, 500);
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(el.clientWidth, el.clientHeight);
      el.appendChild(renderer.domElement);

      const mesh = buildTerrainMesh(terrain);
      scene.add(mesh);
      scene.add(new THREE.AmbientLight(0xffffff, 0.55));
      const sun = new THREE.DirectionalLight(0xffffff, 0.9);
      sun.position.set(30, 20, 50);
      scene.add(sun);

      // werk-polygonen als overlay-lijnen 5 cm boven het terrein
      for (const m of maps.filter(m => m.mapType === 'work' && m.mapArea?.length)) {
        const pts = m.mapArea.map(p => new THREE.Vector3(p.x, p.y, 0.05));
        pts.push(pts[0].clone());
        scene.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: 0x34d399 })));
      }

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
    })().catch(() => setStatus('error'));
    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      renderer?.dispose();
      if (renderer?.domElement.parentElement) renderer.domElement.parentElement.removeChild(renderer.domElement);
    };
  }, [sn]);

  return (
    <div className="h-full w-full relative">
      {status === 'loading' && <div className="absolute inset-0 flex items-center justify-center text-gray-400">Terrein laden…</div>}
      {status === 'empty' && <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-center px-8">Nog geen terreindata — de kaart groeit vanzelf tijdens het maaien.</div>}
      {status === 'error' && <div className="absolute inset-0 flex items-center justify-center text-red-400">Terrein laden mislukt</div>}
      <div ref={mountRef} className="h-full w-full" />
    </div>
  );
}
