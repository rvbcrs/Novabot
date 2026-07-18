# AI-objectherkenning + GLB-weergave — implementatieplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Object-clusters op de 3D-tuinkaart automatisch benoemen via RGB-crops + zero-shot classificatie, en herkende objecten als .glb-modellen tonen met voxel-vangnet en foto-met-correctie.

**Architecture:** De terrain-daemon bewaart per sessie max 20 pose-gestempelde JPEG-frames (alleen als er object-punten in beeld zijn) en uploadt ze mee. De server clustert object-cellen, kiest per cluster het best-gerichte frame, cropt ruw op kijkrichting en classificeert met een zero-shot pipeline (transformers.js + SigLIP-ONNX, on-demand naar het data-volume). Viewers vervangen confident geclassificeerde clusters door gebundelde CC0-GLB's; tik toont naam + foto + correctielijst.

**Tech Stack:** Python/rclpy (maaier), Express/TS + `@huggingface/transformers` (bundelt onnxruntime + sharp) (server), three GLTFLoader (dashboard), r3f/expo-gl + expo-asset (app).

**Spec:** `docs/superpowers/specs/2026-07-18-object-recognition-glb-design.md`

## Global Constraints

- Fase-0 feiten RGB: topic **`/camera/preposition/image_half/compressed`**, `sensor_msgs/CompressedImage`, format-string `"bgr8; jpeg compressed bgr8"`, 16–107 KB/frame @ 960px half-res, scherp rijdend, publiceert alléén tijdens het maaien.
- Frame-capture: max **20 frames/sessie**, minimaal **15 s** tussen frames, alléén als het laatste labeled-frame object-punten opleverde; pose-stempel (x, y, yaw) reist mee als query-params.
- Model: zero-shot-image-classification met **`Xenova/siglip-base-patch16-224`** via `@huggingface/transformers`; cache/download naar `STORAGE_PATH/models` (on-demand, feature-vlag `TERRAIN_CLASSIFY=1` default aan). GEEN model in de Docker-image of in git.
- Labellijst (EN prompt → NL naam → GLB): trampoline→Trampoline→trampoline.glb; tree→Boom→tree.glb; bush/hedge→Struik→bush.glb; garden chair→Tuinstoel→chair.glb; garden table→Tuintafel→table.glb; flower pot with plant→Bloempot→flowerpot.glb; wooden barrel→Houten ton→barrel.glb; parasol→Parasol→parasol.glb; playground equipment→Speeltoestel→playset.glb; fence→Schutting→(geen GLB, voxels); charging station→Laadstation→(geen GLB, voxels blauw).
- **Confidence-drempel 0.35** (SigLIP-sigmoid-scores zijn laag-genormaliseerd): daaronder blijft het cluster voxels. `user_override` wint ALTIJD van het model.
- Clustering: 8-connectivity over object-cellen (alle labels samen), minimaal **8 cellen** per cluster (kleiner = ruis, blijft voxel).
- Maaier-veiligheid en commit-hygiëne: identiek aan de vorige plannen (bracket-pkill lessen, alléén taak-bestanden stagen — werkboom bevat transit-WIP in DemoContext/extended_commands/broker.ts —, `PATH="/bin:/usr/bin:$PATH"` bij git commit, geen Co-Authored-By, cloud-api-CHANGELOG verplicht).
- Deploy-volgorde: daemon-wijzigingen pas naar de maaiers NA de server-release (frames-endpoint moet bestaan; oude server → daemon-upload faalt onschadelijk en blijft lokaal ≤20 frames bewaren).

---

### Task 1: Daemon — RGB-frame-capture + upload

**Files:**
- Modify: `research/terrain_scan.py`
- Test: `research/__tests__/test_terrain_scan.py` (uitbreiden)

**Interfaces:**
- Consumes: bestaande sessie-state `st` (pose, session, obj), `upload_url`-stijl, `_upload_bytes`.
- Produces: pure helper `should_capture_frame(now, last_frame_t, frames_count, last_obj_points) -> bool` en `frame_url(http_address, sn, session, seq, pose) -> str` (format: `http://<addr>/api/nova-file-server/terrain/uploadSessionFrame?sn=<SN>&session=<ts>&seq=<n>&x=<%.3f>&y=<%.3f>&yaw=<%.4f>`); daemon-gedrag: subscriber op het RGB-topic, frames in RAM tot flush (max 20 × ~110 KB), upload bij flush/live-lus, geen disk-writes voor frames (RAM volstaat, sessieverlies is acceptabel).

- [ ] **Step 1: Falende tests** — append vóór de slotprint:

```python
# ── RGB frame-capture helpers (objectherkenning-plan Task 1) ──
assert ts.should_capture_frame(100.0, 80.0, 0, 500) is True      # >15s, obj in beeld
assert ts.should_capture_frame(100.0, 90.0, 0, 500) is False     # te snel
assert ts.should_capture_frame(100.0, 80.0, 20, 500) is False    # vol
assert ts.should_capture_frame(100.0, 80.0, 0, 0) is False       # geen objecten in beeld
u3 = ts.frame_url("host:8080", "LFIN0001", 123, 4, (1.23456, -7.8, 0.78539))
assert u3 == "http://host:8080/api/nova-file-server/terrain/uploadSessionFrame?sn=LFIN0001&session=123&seq=4&x=1.235&y=-7.800&yaw=0.7854", u3
```

- [ ] **Step 2: Run — verwacht falen** (`AttributeError`).

- [ ] **Step 3: Implementeer.** Pure helpers in de rekenkern:

```python
FRAME_MAX_PER_SESSION = 20
FRAME_MIN_INTERVAL = 15.0   # s
FRAME_MIN_OBJ_POINTS = 50   # object-punten in het laatste labeled-frame


def should_capture_frame(now, last_frame_t, frames_count, last_obj_points):
    """RGB-frame bewaren? Alleen met objecten in beeld, gethrottled, max 20."""
    return (frames_count < FRAME_MAX_PER_SESSION
            and now - last_frame_t >= FRAME_MIN_INTERVAL
            and last_obj_points >= FRAME_MIN_OBJ_POINTS)


def frame_url(http_address, sn, session, seq, pose):
    x, y, yaw = pose
    return (f"http://{http_address}/api/nova-file-server/terrain/uploadSessionFrame"
            f"?sn={sn}&session={session}&seq={seq}&x={x:.3f}&y={y:.3f}&yaw={yaw:.4f}")
```

ROS-schil: state `"frames": []` (lijst van `(seq, pose, jpeg_bytes)`), `"last_frame_t": 0.0`, `"last_obj_points": 0`. In `on_labeled` na een geslaagde accumulatie: `st["last_obj_points"] = int(keep.sum())`-equivalent (tel de geaccepteerde punten; geef `accumulate_objects` daarvoor een return-waarde `int` = aantal geaccumuleerde punten — pas de bestaande functie aan en laat bestaande aanroepen de return negeren). Nieuwe subscriber:

```python
    def on_rgb(msg):
        now = time.time()
        if st["pose"] is None or now - st["pose_t"] > POSE_MAX_AGE:
            return
        if not should_capture_frame(now, st["last_frame_t"], len(st["frames"]), st["last_obj_points"]):
            return
        st["last_frame_t"] = now
        st["frames"].append((len(st["frames"]) + 1, st["pose"], bytes(msg.data)))
        st["last_obj_points"] = 0  # één frame per object-passage

    node.create_subscription(CompressedImage, "/camera/preposition/image_half/compressed", on_rgb, 2)
```

(import `CompressedImage` binnen main() naast de andere msg-imports.) Upload: in de live-lus én bij flush, na de grids: loop over nog-niet-geüploade frames (houd `st["frames_sent"]` set van seq's bij) en POST elk met `_upload_bytes(jpeg, http_address, frame_url(http_address, sn, st["session"], seq, pose))`; fouten zijn best-effort (log throttled, frames blijven in RAM tot flush; flush cleart frames + frames_sent in de finally).

- [ ] **Step 4: Run tests + py_compile** → `ALLES OK`, compile schoon.
- [ ] **Step 5: Commit** — `research/terrain_scan.py` + testfile: `"objects: RGB-frame-capture met pose-stempel + upload"`.

---

### Task 2: Server — frames-endpoint + opslag

**Files:**
- Modify: `server/src/cloud-api/routes/terrain.ts` + `server/src/cloud-api/CHANGELOG.md`
- Test: `server/src/cloud-api/__tests__/contract/terrain.upload.test.ts` (uitbreiden)

**Interfaces:**
- Produces: `POST /api/nova-file-server/terrain/uploadSessionFrame?sn&session&seq&x&y&yaw` — raw JPEG (max 2 MB), opgeslagen als `STORAGE_PATH/terrain/frames/<sn>/<session>_<seq>.jpg` + sidecar `<...>.json` (`{x,y,yaw}`); per (sn,session) max 20 frames, per sn max **5 sessies** aan frames (oudste sessie-map weg). Task 5 leest deze bestanden.

- [ ] **Step 1: Falende contract-test:**

```ts
  it('uploadSessionFrame bewaart jpeg + pose-sidecar en begrenst per sessie', async () => {
    const app = buildTestApp();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const res = await request(app)
      .post('/api/nova-file-server/terrain/uploadSessionFrame?sn=LFIN2230700238&session=555&seq=1&x=1.5&y=-2.25&yaw=0.7854')
      .set('Content-Type', 'application/octet-stream').send(jpeg);
    expect(res.status).toBe(200);
    const dir = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain', 'frames', 'LFIN2230700238');
    expect(fs.readFileSync(path.join(dir, '555_1.jpg')).equals(jpeg)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '555_1.json'), 'utf8'))).toEqual({ x: 1.5, y: -2.25, yaw: 0.7854 });
  });

  it('uploadSessionFrame weigert ongeldige sn/seq', async () => {
    const app = buildTestApp();
    await request(app).post('/api/nova-file-server/terrain/uploadSessionFrame?sn=../x&session=1&seq=1&x=0&y=0&yaw=0')
      .set('Content-Type', 'application/octet-stream').send(Buffer.from([0xff, 0xd8])).expect(400);
    await request(app).post('/api/nova-file-server/terrain/uploadSessionFrame?sn=LFIN2230700238&session=1&seq=99&x=0&y=0&yaw=0')
      .set('Content-Type', 'application/octet-stream').send(Buffer.from([0xff, 0xd8])).expect(400); // seq > 20
  });
```

- [ ] **Step 2: Run — falen.** 
- [ ] **Step 3: Implementeer** in terrain.ts (zelfde stijl als de grid-routes):

```ts
terrainRouter.post(
  '/uploadSessionFrame',
  express.raw({ type: 'application/octet-stream', limit: '2mb' }),
  (req: Request, res: Response) => {
    const sn = String(req.query.sn ?? '');
    const session = String(req.query.session ?? '');
    const seq = parseInt(String(req.query.seq ?? ''), 10);
    const x = Number(req.query.x), y = Number(req.query.y), yaw = Number(req.query.yaw);
    if (!/^LFI[A-Z]\d+$/.test(sn) || !/^\d+$/.test(session)
        || !Number.isInteger(seq) || seq < 1 || seq > 20
        || ![x, y, yaw].every(Number.isFinite)) {
      res.status(400).json(fail('invalid frame params', 400)); return;
    }
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) {
      res.status(400).json(fail('not a jpeg', 400)); return;
    }
    const dir = path.join(TERRAIN_DIR, 'frames', sn);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${session}_${seq}.jpg`), body);
    fs.writeFileSync(path.join(dir, `${session}_${seq}.json`), JSON.stringify({ x, y, yaw }));
    // rotatie: max 5 sessies aan frames per maaier (oudste sessie weg)
    const sessions = [...new Set(fs.readdirSync(dir).map(f => f.split('_')[0]))].sort();
    for (const old of sessions.slice(0, -5)) {
      for (const f of fs.readdirSync(dir).filter(f => f.startsWith(`${old}_`))) fs.unlinkSync(path.join(dir, f));
    }
    res.json(ok(null));
  },
);
```

CHANGELOG-entry bovenaan: `uploadSessionFrame (pose-gestempelde RGB-frames voor objectherkenning; spec 2026-07-18)`.

- [ ] **Step 4: Run** contract-tests + `npx tsc --noEmit` + volle suite groen.
- [ ] **Step 5: Commit**: `"objects: uploadSessionFrame endpoint (jpeg + pose-sidecar, rotatie)"`.

---

### Task 3: Server — clustering-service (puur)

**Files:**
- Create: `server/src/services/terrainClusters.ts`
- Test: `server/src/__tests__/services/terrainClusters.test.ts`

**Interfaces:**
- Consumes: `parseTgo1` uit `./terrainGrid.js` (display-TGO1).
- Produces: `clusterObjects(display: Tgo1): Cluster[]` met
  `Cluster = { key: string; cells: number; minX: number; minY: number; maxX: number; maxY: number; cx: number; cy: number; maxH: number; dominantLabel: number }`
  — kaartframe-meters (celindex × cellSize + halve cel), `key` = deterministisch `"cx.toFixed(2),cy.toFixed(2)"`-van-de-EERSTE-run… NEE: key moet stabiel zijn over runs terwijl clusters groeien. Keuze: `key = "<minX-cel>,<minY-cel>"` van de bounding box in CELINDEX (int), afgerond op een 10-cellen-raster zodat kleine groei de key niet verschuift: `key = Math.floor(minIx/10) + "," + Math.floor(minIy/10)`. Task 4 gebruikt deze key als stabiele identiteit.

- [ ] **Step 1: Falende tests:**

```ts
import { describe, it, expect } from 'vitest';
import { clusterObjects } from '../../services/terrainClusters.js';
import { parseTgo1 } from '../../services/terrainGrid.js';

function tgo1(cells: Array<[number, number, number, number, number]>): Buffer { /* zelfde helper als terrainGrid.test — kopieer hem hierheen */ }

describe('clusterObjects', () => {
  it('groepeert 8-connected cellen, negeert mini-clusters', () => {
    // 3x3-blok (9 cellen, cluster) + losse cel (ruis)
    const cells: Array<[number, number, number, number, number]> = [];
    for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) cells.push([x, y, 1, 0.5, 3]);
    cells.push([50, 50, 1, 0.4, 1]);
    const cl = clusterObjects(parseTgo1(tgo1(cells)));
    expect(cl.length).toBe(1);
    expect(cl[0].cells).toBe(9);
    expect(cl[0].cx).toBeCloseTo(0.075, 3);   // (0+1+2)/3 * 0.05 + 0.025
    expect(cl[0].maxH).toBeCloseTo(0.5, 5);
    expect(cl[0].dominantLabel).toBe(1);
  });

  it('diagonale verbinding telt (8-connectivity)', () => {
    const cells: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 8; i++) cells.push([i, i, 8, 0.3, 1]);   // diagonale sliert van 8
    expect(clusterObjects(parseTgo1(tgo1(cells))).length).toBe(1);
  });

  it('stabiele key op 10-cellen-raster', () => {
    const cells: Array<[number, number, number, number, number]> = [];
    for (let x = 12; x < 15; x++) for (let y = 23; y < 26; y++) cells.push([x, y, 1, 0.5, 1]);
    expect(clusterObjects(parseTgo1(tgo1(cells)))[0].key).toBe('1,2');
  });
});
```

- [ ] **Step 2: Run — falen.**
- [ ] **Step 3: Implementeer** (union-find of BFS over een Set van "ix,iy"-keys; verzamel per component: celtelling, bbox, som voor centroid, max-h, label-histogram → dominant; filter `cells >= 8`; sorteer output op celtelling aflopend):

```ts
import type { Tgo1 } from './terrainGrid.js';

export interface Cluster {
  key: string; cells: number;
  minX: number; minY: number; maxX: number; maxY: number;
  cx: number; cy: number; maxH: number; dominantLabel: number;
}

const MIN_CELLS = 8;

export function clusterObjects(display: Tgo1): Cluster[] {
  const cs = display.cellSize;
  // cel → beste (hoogste) entry over alle labels heen
  const byCell = new Map<string, { ix: number; iy: number; maxH: number; label: number; cnt: number }>();
  for (const [key, v] of display.cells) {
    const [ix, iy, label] = key.split(',').map(Number);
    const ck = `${ix},${iy}`;
    const cur = byCell.get(ck);
    if (!cur || v.maxH > cur.maxH) byCell.set(ck, { ix, iy, maxH: v.maxH, label, cnt: v.cnt });
  }
  const seen = new Set<string>();
  const out: Cluster[] = [];
  for (const [start, first] of byCell) {
    if (seen.has(start)) continue;
    const queue = [first];
    seen.add(start);
    const members: typeof first[] = [];
    while (queue.length) {
      const c = queue.pop()!;
      members.push(c);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nk = `${c.ix + dx},${c.iy + dy}`;
        const n = byCell.get(nk);
        if (n && !seen.has(nk)) { seen.add(nk); queue.push(n); }
      }
    }
    if (members.length < MIN_CELLS) continue;
    let minIx = Infinity, minIy = Infinity, maxIx = -Infinity, maxIy = -Infinity;
    let sumX = 0, sumY = 0, maxH = 0;
    const hist = new Map<number, number>();
    for (const m of members) {
      minIx = Math.min(minIx, m.ix); maxIx = Math.max(maxIx, m.ix);
      minIy = Math.min(minIy, m.iy); maxIy = Math.max(maxIy, m.iy);
      sumX += m.ix; sumY += m.iy;
      maxH = Math.max(maxH, m.maxH);
      hist.set(m.label, (hist.get(m.label) ?? 0) + m.cnt);
    }
    const dominantLabel = [...hist.entries()].sort((a, b) => b[1] - a[1])[0][0];
    out.push({
      key: `${Math.floor(minIx / 10)},${Math.floor(minIy / 10)}`,
      cells: members.length,
      minX: minIx * cs, minY: minIy * cs,
      maxX: (maxIx + 1) * cs, maxY: (maxIy + 1) * cs,
      cx: (sumX / members.length) * cs + cs / 2,
      cy: (sumY / members.length) * cs + cs / 2,
      maxH, dominantLabel,
    });
  }
  return out.sort((a, b) => b.cells - a.cells);
}
```

- [ ] **Step 4: Run — groen** + tsc.
- [ ] **Step 5: Commit**: `"objects: cluster-service (8-connectivity, min 8 cellen, stabiele raster-key)"`.

---

### Task 4: Server — terrain_clusters-tabel + repo

**Files:**
- Modify: `server/src/db/database.ts` (na het obj-kolommen-blok)
- Create: `server/src/db/repositories/terrainClusters.ts` (+ export in repositories/index.ts)
- Test: `server/src/__tests__/repositories/terrainClusters.test.ts`

**Interfaces:**
- Produces: `terrainClusterRepo.upsert(row)` (key = (mower_sn, cluster_key); model-velden alleen overschrijven als NIET user_override), `findBySn(sn): TerrainClusterRow[]`, `setOverride(sn, cluster_key, className | null)`, `TerrainClusterRow = { mower_sn, cluster_key, cx, cy, min_x, min_y, max_x, max_y, cells, max_h, class_name: string|null, confidence: number|null, crop_file: string|null, user_override: string|null, updated_at }`.

- [ ] **Step 1: Falende tests** (upsert nieuw + update; override blijft staan na nieuwe upsert; setOverride null wist):

```ts
import { describe, it, expect } from 'vitest';
import { terrainClusterRepo } from '../../db/repositories/index.js';

describe('terrainClusterRepo', () => {
  const base = { mower_sn: 'LFIN0001', cluster_key: '1,2', cx: 1.2, cy: 3.4, min_x: 1, min_y: 3, max_x: 2, max_y: 4, cells: 40, max_h: 0.6 };
  it('upsert + override-behoud', () => {
    terrainClusterRepo.upsert({ ...base, class_name: 'trampoline', confidence: 0.6, crop_file: 'a.jpg' });
    terrainClusterRepo.setOverride('LFIN0001', '1,2', 'tree');
    terrainClusterRepo.upsert({ ...base, class_name: 'bush/hedge', confidence: 0.7, crop_file: 'b.jpg' });
    const row = terrainClusterRepo.findBySn('LFIN0001')[0];
    expect(row.user_override).toBe('tree');       // override overleeft her-classificatie
    expect(row.crop_file).toBe('b.jpg');           // maar de nieuwste foto wél bijgewerkt
    terrainClusterRepo.setOverride('LFIN0001', '1,2', null);
    expect(terrainClusterRepo.findBySn('LFIN0001')[0].user_override).toBeNull();
  });
});
```

- [ ] **Step 2/3:** migratie (`CREATE TABLE IF NOT EXISTS terrain_clusters (mower_sn TEXT NOT NULL, cluster_key TEXT NOT NULL, cx REAL, cy REAL, min_x REAL, min_y REAL, max_x REAL, max_y REAL, cells INTEGER, max_h REAL, class_name TEXT, confidence REAL, crop_file TEXT, user_override TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (mower_sn, cluster_key))`) + repo met prepared statements (upsert via `ON CONFLICT(mower_sn, cluster_key) DO UPDATE` die `user_override` NIET aanraakt).
- [ ] **Step 4/5:** groen + commit `"objects: terrain_clusters tabel + repo (override wint)"`.

---

### Task 5: Server — frame-keuze + crop (puur + sharp)

**Files:**
- Create: `server/src/services/terrainCrops.ts`
- Test: `server/src/__tests__/services/terrainCrops.test.ts`

**Interfaces:**
- Consumes: `Cluster` (Task 3); frame-sidecars (Task 2-formaat).
- Produces:
  - `scoreFrame(cluster: {cx,cy}, pose: {x,y,yaw}): number|null` — null als cluster buiten blikveld (|hoek| > 0.6 rad ≈ 35°) of afstand ∉ [0.3, 4] m; anders lager=beter (`|hoek| + afstand*0.1`).
  - `cropBox(cluster: {cx,cy}, pose, imgW, imgH): {left, top, width, height}` — horizontaal centrum `u = 0.5 − hoek/1.2` (FOV ≈ 1.2 rad breed), vierkante zijde `clamp(imgW * 0.9 / afstand, imgW*0.25, imgW*0.9)`, verticaal gecentreerd op 55% hoogte, alles geclamped binnen beeld.
  - `cropFrame(jpegPath: string, box): Promise<Buffer>` — via `sharp` (komt als dependency van `@huggingface/transformers` mee; installeer in Task 6 — hier tijdelijk `devDependency sharp` als Task 6 nog niet draaide: installeer sharp gewoon expliciet in DEZE task, dat is netter).

- [ ] **Step 1: Falende tests** voor de PURE wiskunde (scoreFrame/cropBox — geen sharp in de tests):

```ts
import { describe, it, expect } from 'vitest';
import { scoreFrame, cropBox } from '../../services/terrainCrops.js';

describe('terrainCrops wiskunde', () => {
  it('recht vooruit op 1m scoort beter dan 30° opzij op 1m', () => {
    const c = { cx: 1, cy: 0 };
    const recht = scoreFrame(c, { x: 0, y: 0, yaw: 0 })!;
    const opzij = scoreFrame(c, { x: 0, y: 0, yaw: 0.5 })!;
    expect(recht).toBeLessThan(opzij);
  });
  it('achter de camera of te ver → null', () => {
    expect(scoreFrame({ cx: -1, cy: 0 }, { x: 0, y: 0, yaw: 0 })).toBeNull();
    expect(scoreFrame({ cx: 6, cy: 0 }, { x: 0, y: 0, yaw: 0 })).toBeNull();
  });
  it('cropBox centreert links van het midden bij object links', () => {
    // object 0.3 rad links van de kijkrichting
    const b = cropBox({ cx: Math.cos(0.3), cy: Math.sin(0.3) }, { x: 0, y: 0, yaw: 0 }, 960, 540);
    expect(b.left + b.width / 2).toBeLessThan(480);
    expect(b.left).toBeGreaterThanOrEqual(0);
    expect(b.left + b.width).toBeLessThanOrEqual(960);
  });
});
```

- [ ] **Step 2/3:** implementeer (hoek = `atan2(cy−y, cx−x) − yaw`, genormaliseerd naar (−π, π]); `npm install sharp` in server/; `cropFrame` = `sharp(path).extract(box).jpeg().toBuffer()`.
- [ ] **Step 4/5:** groen + tsc + commit `"objects: frame-scoring + ruwe crop (blikveld-wiskunde)"`.

---

### Task 6: Server — zero-shot classifier (on-demand model)

**Files:**
- Create: `server/src/services/terrainClassifier.ts`
- Modify: `server/package.json` (dep `@huggingface/transformers`)
- Test: `server/src/__tests__/services/terrainClassifier.test.ts`

**Interfaces:**
- Produces:
  - `LABELS: Array<{ prompt: string; nl: string; glb: string | null }>` — exact de Global-Constraints-tabel.
  - `classifyCrop(jpeg: Buffer): Promise<{ className: string; nl: string; confidence: number } | null>` — null onder drempel 0.35 of als het model (nog) niet beschikbaar is.
  - `initClassifier(): Promise<boolean>` — lazily: pipeline('zero-shot-image-classification', 'Xenova/siglip-base-patch16-224', { cache_dir: STORAGE_PATH/models }); vlag `TERRAIN_CLASSIFY!=0`; download-fouten → false + warn (batch slaat over, volgende sessie opnieuw).
- Testbaarheid: het pipeline-object is injecteerbaar (`_setPipelineForTest(fn)`); tests injecteren een stub die vaste scores retourneert — GEEN modeldownload in CI.

- [ ] **Step 1: Falende tests:**

```ts
import { describe, it, expect } from 'vitest';
import { classifyCrop, _setPipelineForTest, LABELS } from '../../services/terrainClassifier.js';

describe('terrainClassifier', () => {
  it('kiest topscore boven drempel en mapt naar NL-naam', async () => {
    _setPipelineForTest(async () => LABELS.map((l, i) => ({ label: l.prompt, score: l.prompt === 'trampoline' ? 0.62 : 0.01 * i })));
    const r = await classifyCrop(Buffer.from([0xff, 0xd8]));
    expect(r).toEqual({ className: 'trampoline', nl: 'Trampoline', confidence: expect.closeTo(0.62, 5) });
  });
  it('onder drempel → null', async () => {
    _setPipelineForTest(async () => LABELS.map(l => ({ label: l.prompt, score: 0.1 })));
    expect(await classifyCrop(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
  it('zonder pipeline → null (model niet beschikbaar)', async () => {
    _setPipelineForTest(null);
    expect(await classifyCrop(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});
```

- [ ] **Step 2/3:** `npm install @huggingface/transformers`; implementatie met RawImage.fromBlob/Buffer-pad zoals de lib voorschrijft, drempel `CONFIDENCE_MIN = 0.35`, cache-dir `path.resolve(process.env.STORAGE_PATH ?? './storage', 'models')`, `env.allowLocalModels`-instellingen conform lib-docs (raadpleeg de geïnstalleerde lib-README in node_modules — versies verschillen in API; pas exact toe wat de geïnstalleerde versie vereist en noteer de versie in je rapport).
- [ ] **Step 4/5:** groen (stub-tests) + tsc + volle suite + commit `"objects: zero-shot classifier (SigLIP on-demand, injecteerbare pipeline)"`.

---

### Task 7: Server — batch-job + cluster-API

**Files:**
- Create: `server/src/services/terrainRecognition.ts` (orchestratie)
- Modify: `server/src/cloud-api/routes/terrain.ts` (job-trigger na final-fold) + CHANGELOG
- Modify: `server/src/routes/dashboard.ts` (GET clusters + POST override + GET crop-foto)
- Test: `server/src/__tests__/services/terrainRecognition.test.ts` + `server/src/__tests__/routes/terrainClusters.route.test.ts`

**Interfaces:**
- Produces:
  - `runRecognition(sn: string): Promise<number>` — leest display-TGO1 (persistent+actief zoals de GET doet), clustert, per cluster zonder `user_override`: beste frame (scoreFrame over alle sidecars van de laatste sessies), crop, classify, `terrainClusterRepo.upsert` (crop naar `TERRAIN_DIR/crops/<sn>/<cluster_key>.jpg`, pad in `crop_file`); return aantal geclassificeerd. Fout per cluster → skip met warn (nooit de job laten crashen).
  - Fire-and-forget aanroep (`void runRecognition(sn)` met .catch-log) in de final-upload-afhandeling ná `foldActive`/merge van een OBJECT-grid.
  - `GET /api/dashboard/terrain-clusters/:sn` → `{ clusters: [{ key, cx, cy, minX, minY, maxX, maxY, cells, maxH, className, nl, confidence, userOverride, photoUrl }] }` (className = override ?? model; photoUrl = `/api/dashboard/terrain-crops/:sn/:key.jpg`).
  - `GET /api/dashboard/terrain-crops/:sn/:file` (sn-regex + bestandsnaam-whitelist `^[0-9,-]+\.jpg$`).
  - `POST /api/dashboard/terrain-clusters/:sn/:key/override` body `{ className: string | null }` (moet in LABELS voorkomen of null).
- Tests: recognition-orchestratie met gestubde classifier + neppe frames/sidecars in de test-storage; route-tests voor GET/POST incl. sn-guard.

- [ ] Steps: falende tests → implementatie → volle suite groen → commit `"objects: recognition-batch + cluster-API (override, foto's)"`.

---

### Task 8: GLB-assets bundelen (dashboard + app)

**Files:**
- Create: `dashboard/public/models/*.glb` + `app/assets/models/*.glb` (identieke set)
- Create: `scripts/normalize-glb.mjs` (eenmalig hulpscript, three in dashboard/node_modules gebruiken)
- Modify: `app/metro.config.js` (glb als asset-extensie)

**Stappen:**
- [ ] Download CC0 low-poly modellen (bronnen: Quaternius "Ultimate Nature" / "Furniture" packs via quaternius.com, Kenney "Nature Kit" via kenney.nl — beide CC0, geen attributie vereist) voor: trampoline (zit zelden in packs — alternatief: poly.pizza CC0-zoekresultaat "trampoline"; als er GEEN bruikbare CC0-trampoline is: bouw hem programmatisch in het normalisatie-script uit primitieven — torus + cilinderpoten — en exporteer als GLB via three's GLTFExporter), tree, bush, chair, table, flowerpot, barrel, parasol, playset.
- [ ] Normaliseer elk model met `scripts/normalize-glb.mjs`: centreer op oorsprong, voet op z=0, schaal naar unit-bounding-box (1×1×1) zodat de viewers puur met cluster-afmetingen kunnen schalen; schrijf naar beide asset-dirs. Script-kern: GLTFLoader → bbox → translate/scale → GLTFExporter (node met `three` uit dashboard/node_modules; draai met `node --experimental-...` indien nodig; documenteer het exacte commando in het script zelf).
- [ ] `app/metro.config.js`: voeg `'glb'` toe aan `resolver.assetExts` (maak het bestand op basis van expo/metro-config default als het nog niet bestaat).
- [ ] Verifieer: `npx tsc --noEmit` app + dashboard `npm run build` (assets in public/ komen in dist).
- [ ] Commit (assets + script + metro-config): `"objects: CC0 GLB-set (genormaliseerd, unit-bbox) + metro glb-support"`.

---

### Task 9: Dashboard — GLB-rendering + correctie-UI

**Files:**
- Modify: `dashboard/src/pages/TerrainPage.tsx`
- Create: `dashboard/src/utils/clusterModels.ts` (klasse→GLB-pad + kleurtabel-koppeling)
- Modify: `dashboard/src/i18n/locales/*.json` (labels NL/EN/DE/FR voor de klassen + "Corrigeer object")

**Gedrag:**
- [ ] Fetch `terrain-clusters` naast de grids (zelfde 20s-poll). Voor elk cluster met className (override of model, confidence ≥ drempel is al server-side toegepast) en een GLB in de mapping: laad het model (GLTFLoader, cache per klasse, kloon per instantie), schaal naar `(maxX−minX, maxY−minY, maxH)`, positioneer op (cx, cy, terreinhoogte); **verberg de voxels binnen die cluster-bbox** (filter bij het bouwen van de voxel-InstancedMesh: cel binnen een gemodelleerde cluster-bbox → overslaan). Cluster zonder className/GLB → voxels zoals nu.
- [ ] Klik op model of voxel-cluster (raycast op de mesh, userData.clusterKey) → paneel: NL-naam, confidence, de foto (photoUrl), dropdown met alle LABELS + "(voxels)" → POST override → herfetch.
- [ ] Verifieer: tsc + build; handmatig met de bestaande .100-data zodra de server draait.
- [ ] Commit: `"objects: dashboard GLB-modellen + klik-correctie met foto"`.

---

### Task 10: App — GLB-rendering

**Files:**
- Modify: `app/src/components/TerrainView3D.tsx`
- Create: `app/src/utils/clusterModels.ts` (require-map: `{ trampoline: require('../../assets/models/trampoline.glb'), ... }`)

**Gedrag:**
- [ ] Fetch clusters naast de grids (zelfde poll, `?raw` niet nodig — het is JSON). GLB laden via `expo-asset` (`Asset.fromModule(...).downloadAsync()` → localUri) + three GLTFLoader; zelfde schaal/positie-logica en voxel-verberging als dashboard. Correctie-UI is hier v1 NIET (dashboard only, spec-fasering) — wél het naam-label: `<Text>`-overlay of drei-native Text is te zwaar; kies: klik-detectie via r3f `onPointerDown` op de primitive → toon RN-overlay (View) met naam + foto (Image met photoUrl). Alleen-lezen.
- [ ] Verifieer: `npx tsc --noEmit`; runtime-check op Ramons telefoon (hot reload) hoort bij de smoke.
- [ ] Commit: `"objects: app GLB-modellen + info-tik"`.

---

### Task 11: Deploy + end-to-end smoke (deels controller-gated)

- [ ] **Volgorde-gate:** eerst server-release (Ramons "release beta" + .247-update), DAN daemon-deploy naar .100 en .244 (bewezen recept: scp, losse bracket-pkills, setsid-start, verse-ssh-verificatie van loop + kind).
- [ ] **Smoke (CONTROLLER, vereist maaibeurt .100):** daemon-log toont frame-captures; `frames/<sn>/`-dir vult op de server; na de final-fold draait `runRecognition` (server-log), `terrain_clusters` gevuld, GET clusters geeft klassen + foto's; dashboard toont GLB's (trampoline!), klik toont foto, override werkt; app toont dezelfde modellen.
- [ ] Eindcheck: alle suites + tsc's groen; `git pull --rebase && git push`.

## Buiten dit plan (bewust)
- Correctie-UI in de app; nieuwe labels toevoegen via UI (labellijst is code); her-classificatie-knop; icoon-animaties. Modelkwaliteit-tuning (prompt-engineering) op basis van praktijkdata — eerst meten.
