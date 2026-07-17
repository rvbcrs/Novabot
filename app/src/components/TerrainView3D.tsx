/**
 * Native 3D-terreinviewer: heightmap + object-voxels + live maaier-marker.
 * Data via de raw=1-endpoints (geen gzip-afhankelijkheid in RN-fetch).
 * Gedeelde byte-parsers met het dashboard; mesh-bouw = zelfde expliciete
 * vertex-aanpak als daar (Y-flip-les: nooit op PlaneGeometry's as-conventie
 * leunen).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, PanResponder, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { Canvas, useFrame, useThree } from '@react-three/fiber/native';
import * as THREE from 'three';
import { parseTerrain, parseObjects, LABEL_COLORS, LABEL_DEFAULT_COLOR, type TerrainData, type ObjectData } from '../utils/terrainParser';
import { getServerUrl } from '../services/auth';
import { ApiClient } from '../services/api';
import { useMowerState } from '../hooks/useMowerState';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';

const POLL_MS = 20_000;

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

/** Eén-vinger slepen = orbit, twee-vinger pinch = zoom. */
function useOrbitGestures(camState: React.MutableRefObject<{ theta: number; phi: number; dist: number }>) {
  const last = useRef<{ x: number; y: number; d: number | null }>({ x: 0, y: 0, d: null });
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
    },
    onPanResponderMove: (e) => {
      const t = e.nativeEvent.touches;
      if (t.length >= 2) {
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
      }
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

/** Zelfde logica als dashboard's buildObjectVoxels (TerrainPage.tsx) — één InstancedMesh, kleur per instance. */
// NB: cam_to_base clipt op HEIGHT_MAX 1.5 m — objecten hoger dan 1.5 m tonen tot die hoogte (bewuste v1-keuze).
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

function disposeInstancedMesh(mesh: THREE.InstancedMesh | null): void {
  if (!mesh) return;
  mesh.geometry.dispose();
  const mat = mesh.material;
  if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose()); else mat.dispose();
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

  const terrainRef = useRef<TerrainScene | null>(null);
  const voxelRef = useRef<THREE.InstancedMesh | null>(null);
  const mountedRef = useRef(true);
  const cameraInitialized = useRef(false);

  const camState = useRef({ theta: 0.7, phi: 0.65, dist: 12 });
  const panResponder = useOrbitGestures(camState);

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

  const load = useCallback(async () => {
    try {
      const base = await getServerUrl();
      if (!base) {
        if (mountedRef.current) setStatus('error');
        return;
      }

      const terrainRes = await fetch(`${base}/api/dashboard/terrain/${encodeURIComponent(sn)}?raw=1`);
      if (terrainRes.status === 404) {
        if (!mountedRef.current) return;
        disposeTerrain();
        disposeVoxels();
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

      // Objecten zijn optioneel — 404 of een netwerkfout betekent gewoon
      // "geen objecten", nooit een reden om het hele terrein af te keuren.
      let newVoxelMesh: THREE.InstancedMesh | null = null;
      try {
        const objRes = await fetch(`${base}/api/dashboard/terrain-objects/${encodeURIComponent(sn)}?raw=1`);
        if (objRes.ok) {
          const objData = parseObjects(await objRes.arrayBuffer());
          if (objData.ix.length > 0) newVoxelMesh = buildObjectVoxels(objData, built.groundAt);
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
      setStatus('ready');
    } catch {
      if (mountedRef.current) setStatus('error');
    }
  }, [sn, disposeTerrain, disposeVoxels]);

  useEffect(() => {
    mountedRef.current = true;
    cameraInitialized.current = false;
    setStatus('loading');
    setTerrain(null);
    setVoxelMesh(null);

    void load();
    const interval = setInterval(() => { void load(); }, POLL_MS);

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      disposeTerrain();
      disposeVoxels();
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

  return (
    <View style={styles.container} {...panResponder.panHandlers}>
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
          <mesh geometry={terrain.geo}>
            <meshStandardMaterial vertexColors />
          </mesh>
          {voxelMesh && <primitive object={voxelMesh} />}
          {polyLines.map((l, i) => <primitive key={i} object={l} />)}
          {markerPos && (
            <mesh position={[markerPos.x, markerPos.y, markerPos.z]} rotation={[Math.PI / 2, 0, 0]}>
              <coneGeometry args={[0.15, 0.3, 12]} />
              <meshStandardMaterial color="#facc15" />
            </mesh>
          )}
        </Canvas>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  canvas: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  statusText: { fontSize: 15, textAlign: 'center' },
});
