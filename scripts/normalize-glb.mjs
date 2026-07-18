#!/usr/bin/env node
// Task 8 (object-recognition-glb): genereert de gebundelde low-poly GLB-set voor
// de terrein-viewers (dashboard React-viewer + app react-three-fiber viewer).
//
// Run met (vanuit repo root):
//   node scripts/normalize-glb.mjs
//
// Waarom procedureel i.p.v. gedownload: CC0-bronnen (poly.pizza, Kenney, Quaternius)
// zijn client-side SPA's zonder scriptbare directe download-URL's (poly.pizza's
// zoek-API vereist een API-key, Kenney's pack-pagina's renderen zip-links via JS).
// Geprobeerd; niet betrouwbaar binnen een script. In plaats daarvan bouwt dit
// script elk model uit three.js-primitieven (torus, cilinder, icosahedron, lathe,
// box) — herkenbaar gestileerd low-poly "kaart-icoon in 3D", geen licentierisico,
// gegarandeerd klein (<10 KB per stuk) en exact reproduceerbaar. Zie SOURCES.md.
//
// Contract (met de viewers, Task 9/10): elk model wordt genormaliseerd naar een
// unit-bbox in Z-up lokale ruimte — X en Y elk [-0.5, 0.5] (gecentreerd), Z [0, 1]
// (voet op z=0, top op z=1) — zodat een viewer het model puur met de gemeten
// cluster-voetafdruk (x,y) en -hoogte (z) mag schalen (non-uniforme scale), zonder
// verdere kennis van de modelgeometrie.
//
// three.js wordt hergebruikt uit dashboard/node_modules (geen aparte install nodig).
// De modellen worden natuurlijk in three's eigen Y-up conventie opgebouwd (cilinder-
// as = Y, grondvlak = X/Z) en daarna in een wrapper-node naar Z-up gedraaid
// (rotation.x = +90°) vóór de bbox-normalisatie — zie `toZUpUnitBox()`.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const THREE_DIR = path.join(REPO_ROOT, 'dashboard/node_modules/three');

if (!fs.existsSync(THREE_DIR)) {
  console.error(`three niet gevonden op ${THREE_DIR} — draai eerst 'npm install' in dashboard/`);
  process.exit(1);
}

const THREE = await import(path.join(THREE_DIR, 'build/three.module.js'));
const { GLTFExporter } = await import(
  path.join(THREE_DIR, 'examples/jsm/exporters/GLTFExporter.js')
);

// GLTFExporter (binary mode) gebruikt browser-`FileReader` om de merged Blob terug
// naar een ArrayBuffer te lezen. Node heeft `Blob` globaal (undici) maar geen
// `FileReader` — minimale polyfill op basis van `Blob.arrayBuffer()`.
class NodeFileReader {
  readAsArrayBuffer(blob) {
    blob
      .arrayBuffer()
      .then((buf) => {
        this.result = buf;
        if (this.onload) this.onload();
        if (this.onloadend) this.onloadend();
      })
      .catch((err) => {
        if (this.onerror) this.onerror(err);
      });
  }
}
globalThis.FileReader = NodeFileReader;

const OUT_DIRS = [
  path.join(REPO_ROOT, 'dashboard/public/models'),
  path.join(REPO_ROOT, 'app/assets/models'),
];
for (const d of OUT_DIRS) fs.mkdirSync(d, { recursive: true });

const EPS = 1e-3;

// ---------------------------------------------------------------------------
// Kleine bouw-helpers (Y-up, natuurlijke three-conventie)
// ---------------------------------------------------------------------------

function mat(color) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, metalness: 0.05 });
}

function meshAt(geo, color, pos = [0, 0, 0], rot = [0, 0, 0]) {
  const m = new THREE.Mesh(geo, mat(color));
  m.position.set(...pos);
  m.rotation.set(...rot);
  return m;
}

function grp(...children) {
  const g = new THREE.Group();
  for (const c of children) g.add(c);
  return g;
}

// ---------------------------------------------------------------------------
// Model-bouwers — elk retourneert een THREE.Group in Y-up, grond op y=0
// ---------------------------------------------------------------------------

const BROWN_TRUNK = 0x6b4a2f;
const GREEN_CANOPY = 0x4c7a3d;
const GREEN_CANOPY_LIGHT = 0x5f9450;
const WOOD = 0x8a5a34;
const WOOD_DARK = 0x5c3a20;
const TERRACOTTA = 0xb4552f;
const METAL_DARK = 0x3a3d40;
const FABRIC_RED = 0xa8362c;
const PLASTIC_TEAL = 0x2f6f6a;

function buildTrampoline() {
  const legs = new THREE.Group();
  const legCount = 6;
  const ringR = 0.95;
  for (let i = 0; i < legCount; i++) {
    const a = (i / legCount) * Math.PI * 2;
    const leg = meshAt(
      new THREE.CylinderGeometry(0.03, 0.03, 0.5, 6),
      METAL_DARK,
      [Math.cos(a) * ringR * 0.92, 0.25, Math.sin(a) * ringR * 0.92],
    );
    legs.add(leg);
  }
  const frame = meshAt(
    new THREE.TorusGeometry(ringR, 0.05, 6, 16),
    METAL_DARK,
    [0, 0.5, 0],
    [Math.PI / 2, 0, 0],
  );
  const mat_ = meshAt(
    new THREE.CylinderGeometry(ringR - 0.08, ringR - 0.08, 0.03, 16),
    0x111214,
    [0, 0.5, 0],
  );
  return grp(legs, frame, mat_);
}

function buildTree() {
  const trunk = meshAt(new THREE.CylinderGeometry(0.05, 0.08, 0.5, 7), BROWN_TRUNK, [0, 0.25, 0]);
  const canopyLow = meshAt(new THREE.IcosahedronGeometry(0.42, 0), GREEN_CANOPY, [0, 0.65, 0]);
  const canopyTop = meshAt(new THREE.IcosahedronGeometry(0.3, 0), GREEN_CANOPY_LIGHT, [0, 0.95, 0]);
  return grp(trunk, canopyLow, canopyTop);
}

function buildBush() {
  const lumps = [
    [0.28, [0, 0.28, 0]],
    [0.22, [0.22, 0.22, 0.05]],
    [0.2, [-0.2, 0.2, -0.08]],
    [0.18, [0.02, 0.2, 0.22]],
  ];
  const children = lumps.map(([r, pos]) =>
    meshAt(new THREE.IcosahedronGeometry(r, 0), GREEN_CANOPY, pos),
  );
  return grp(...children);
}

function buildChair() {
  const seat = meshAt(new THREE.BoxGeometry(0.42, 0.04, 0.42), PLASTIC_TEAL, [0, 0.42, 0]);
  const back = meshAt(new THREE.BoxGeometry(0.42, 0.4, 0.04), PLASTIC_TEAL, [0, 0.62, -0.19]);
  const legPositions = [
    [0.18, 0.19],
    [-0.18, 0.19],
    [0.18, -0.19],
    [-0.18, -0.19],
  ];
  const legs = legPositions.map(([x, z]) =>
    meshAt(new THREE.CylinderGeometry(0.02, 0.02, 0.42, 6), METAL_DARK, [x, 0.21, z]),
  );
  return grp(seat, back, ...legs);
}

function buildTable() {
  const top = meshAt(new THREE.BoxGeometry(0.9, 0.04, 0.55), WOOD, [0, 0.5, 0]);
  const legPositions = [
    [0.38, 0.22],
    [-0.38, 0.22],
    [0.38, -0.22],
    [-0.38, -0.22],
  ];
  const legs = legPositions.map(([x, z]) =>
    meshAt(new THREE.CylinderGeometry(0.03, 0.03, 0.48, 6), WOOD_DARK, [x, 0.24, z]),
  );
  return grp(top, ...legs);
}

function buildFlowerpot() {
  const pot = meshAt(new THREE.CylinderGeometry(0.32, 0.22, 0.4, 10), TERRACOTTA, [0, 0.2, 0]);
  const rim = meshAt(new THREE.CylinderGeometry(0.34, 0.34, 0.05, 10), 0x9c4527, [0, 0.4, 0]);
  const stems = [0, 1, 2].map((i) => {
    const a = (i / 3) * Math.PI * 2;
    return meshAt(
      new THREE.CylinderGeometry(0.015, 0.015, 0.28, 5),
      GREEN_CANOPY,
      [Math.cos(a) * 0.08, 0.55, Math.sin(a) * 0.08],
      [0, 0, Math.cos(a) * 0.15],
    );
  });
  const foliage = [
    meshAt(new THREE.IcosahedronGeometry(0.2, 0), GREEN_CANOPY_LIGHT, [0, 0.75, 0]),
    meshAt(new THREE.IcosahedronGeometry(0.14, 0), GREEN_CANOPY, [0.14, 0.68, 0.05]),
    meshAt(new THREE.IcosahedronGeometry(0.13, 0), GREEN_CANOPY, [-0.13, 0.66, -0.06]),
  ];
  return grp(pot, rim, ...stems, ...foliage);
}

function buildBarrel() {
  // Lathe-profiel: lichte tonvorm (breder in het midden), gemeten in (radius, y)
  const profile = [
    [0.28, 0.0],
    [0.34, 0.06],
    [0.38, 0.25],
    [0.38, 0.55],
    [0.34, 0.74],
    [0.28, 0.8],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const body = meshAt(new THREE.LatheGeometry(profile, 10), WOOD, [0, 0, 0]);
  const hoopTop = meshAt(new THREE.TorusGeometry(0.345, 0.02, 5, 12), METAL_DARK, [0, 0.68, 0], [Math.PI / 2, 0, 0]);
  const hoopBottom = meshAt(new THREE.TorusGeometry(0.3, 0.02, 5, 12), METAL_DARK, [0, 0.12, 0], [Math.PI / 2, 0, 0]);
  return grp(body, hoopTop, hoopBottom);
}

function buildParasol() {
  const pole = meshAt(new THREE.CylinderGeometry(0.025, 0.025, 0.9, 6), METAL_DARK, [0, 0.45, 0]);
  const canopy = meshAt(new THREE.ConeGeometry(0.85, 0.28, 8), FABRIC_RED, [0, 0.95, 0]);
  const finial = meshAt(new THREE.IcosahedronGeometry(0.04, 0), METAL_DARK, [0, 1.1, 0]);
  const baseCross1 = meshAt(new THREE.BoxGeometry(0.5, 0.03, 0.12), METAL_DARK, [0, 0.02, 0]);
  const baseCross2 = meshAt(new THREE.BoxGeometry(0.12, 0.03, 0.5), METAL_DARK, [0, 0.02, 0]);
  return grp(pole, canopy, finial, baseCross1, baseCross2);
}

function buildPlayset() {
  // Simpel schommelstel: A-frames aan weerszijden + horizontale bovenbalk + 2 schommels.
  const frameHalfSpan = 0.5;
  const legAngle = Math.PI / 8;
  const legLength = 0.85;
  const topY = Math.cos(legAngle) * legLength;

  function aFrame(z) {
    const legA = meshAt(
      new THREE.CylinderGeometry(0.03, 0.03, legLength, 6),
      METAL_DARK,
      [frameHalfSpan * 0.35, topY / 2, z],
      [0, 0, legAngle],
    );
    const legB = meshAt(
      new THREE.CylinderGeometry(0.03, 0.03, legLength, 6),
      METAL_DARK,
      [-frameHalfSpan * 0.35, topY / 2, z],
      [0, 0, -legAngle],
    );
    return grp(legA, legB);
  }

  const frameFront = aFrame(0.45);
  const frameBack = aFrame(-0.45);
  const topBar = meshAt(new THREE.CylinderGeometry(0.03, 0.03, 1.0, 6), METAL_DARK, [0, topY, 0], [0, 0, Math.PI / 2]);

  function swing(x) {
    const chainL = meshAt(new THREE.CylinderGeometry(0.008, 0.008, topY - 0.18, 4), METAL_DARK, [x - 0.06, (topY - 0.18) / 2 + 0.18, 0.2]);
    const chainR = meshAt(new THREE.CylinderGeometry(0.008, 0.008, topY - 0.18, 4), METAL_DARK, [x + 0.06, (topY - 0.18) / 2 + 0.18, -0.2]);
    const seat = meshAt(new THREE.BoxGeometry(0.16, 0.02, 0.45), WOOD, [x, 0.18, 0]);
    return grp(chainL, chainR, seat);
  }

  const swings = grp(swing(-0.28), swing(0.28));

  return grp(frameFront, frameBack, topBar, swings);
}

const MODELS = {
  'trampoline.glb': buildTrampoline,
  'tree.glb': buildTree,
  'bush.glb': buildBush,
  'chair.glb': buildChair,
  'table.glb': buildTable,
  'flowerpot.glb': buildFlowerpot,
  'barrel.glb': buildBarrel,
  'parasol.glb': buildParasol,
  'playset.glb': buildPlayset,
};

// ---------------------------------------------------------------------------
// Normalisatie: Y-up model -> Z-up unit-bbox (X,Y in [-0.5,0.5], Z in [0,1])
// ---------------------------------------------------------------------------

function toZUpUnitBox(yUpModel) {
  const zUpWrapper = new THREE.Group();
  zUpWrapper.rotation.x = Math.PI / 2; // Y-up -> Z-up, up-vector (0,1,0) -> (0,0,1)
  zUpWrapper.add(yUpModel);
  zUpWrapper.updateMatrixWorld(true);

  const rawBox = new THREE.Box3().setFromObject(zUpWrapper);
  const center = rawBox.getCenter(new THREE.Vector3());
  const size = rawBox.getSize(new THREE.Vector3());

  const offsetGroup = new THREE.Group();
  offsetGroup.position.set(-center.x, -center.y, -rawBox.min.z);
  offsetGroup.add(zUpWrapper);

  const root = new THREE.Group();
  root.scale.set(1 / size.x, 1 / size.y, 1 / size.z);
  root.add(offsetGroup);
  root.updateMatrixWorld(true);

  const finalBox = new THREE.Box3().setFromObject(root);
  return { root, finalBox };
}

function assertUnitBox(name, box) {
  const checks = [
    ['min.x', box.min.x, -0.5],
    ['max.x', box.max.x, 0.5],
    ['min.y', box.min.y, -0.5],
    ['max.y', box.max.y, 0.5],
    ['min.z', box.min.z, 0],
    ['max.z', box.max.z, 1],
  ];
  const failures = checks.filter(([, actual, expected]) => Math.abs(actual - expected) > EPS);
  if (failures.length > 0) {
    const detail = failures.map(([k, a, e]) => `${k}=${a.toFixed(4)} (verwacht ${e})`).join(', ');
    throw new Error(`${name}: bbox-normalisatie klopt niet — ${detail}`);
  }
}

function exportGlb(root, absPath) {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      root,
      (result) => {
        if (result instanceof ArrayBuffer) {
          fs.writeFileSync(absPath, Buffer.from(result));
          resolve();
        } else {
          reject(new Error('GLTFExporter gaf geen ArrayBuffer terug (binary:true verwacht)'));
        }
      },
      (err) => reject(err),
      { binary: true },
    );
  });
}

async function main() {
  const report = [];
  for (const [fileName, builder] of Object.entries(MODELS)) {
    const yUpModel = builder();
    const { root, finalBox } = toZUpUnitBox(yUpModel);
    assertUnitBox(fileName, finalBox);

    const tmpPath = path.join(OUT_DIRS[0], fileName);
    await exportGlb(root, tmpPath);
    const bytes = fs.statSync(tmpPath).size;

    // Kopieer identiek naar de tweede outputmap (app).
    for (const d of OUT_DIRS.slice(1)) {
      fs.copyFileSync(tmpPath, path.join(d, fileName));
    }

    const size = finalBox.getSize(new THREE.Vector3());
    console.log(
      `${fileName.padEnd(16)} bbox=[${finalBox.min.x.toFixed(3)},${finalBox.min.y.toFixed(3)},${finalBox.min.z.toFixed(3)}]..` +
        `[${finalBox.max.x.toFixed(3)},${finalBox.max.y.toFixed(3)},${finalBox.max.z.toFixed(3)}] ` +
        `size=[${size.x.toFixed(3)},${size.y.toFixed(3)},${size.z.toFixed(3)}] ${bytes} bytes`,
    );
    report.push({ fileName, bytes });
  }

  console.log(`\n${report.length} modellen genormaliseerd naar unit-bbox en weggeschreven naar:`);
  for (const d of OUT_DIRS) console.log(`  ${d}`);
}

main().catch((err) => {
  console.error('normalize-glb.mjs FAILED:', err);
  process.exit(1);
});
