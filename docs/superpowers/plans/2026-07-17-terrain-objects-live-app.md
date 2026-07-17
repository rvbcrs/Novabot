# Object-lagen + live groei + native app-viewer — implementatieplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Objecten (trampoline, struiken) als voxel-lagen op de 3D-terreinkaart, de kaart live zien groeien tijdens het maaien, en dat alles ook native in de app met live maaier-marker.

**Architecture:** De bestaande terrain-daemon krijgt een tweede accumulator op `/perception/points_labeled` (hoogte-gedreven selectie, per (cel,label) max-hoogte) en uploadt elke 60 s tussentijds met een sessie-id; de server houdt de actieve sessie als aparte vervangbare laag naast de gemergde ringen en mengt die on-the-fly in de GET-antwoorden. Dashboard-viewer krijgt instanced voxel-lagen + 20 s-poll + maaier-marker; de app krijgt een native r3f-viewer met 2D⇄3D-toggle op het Map-scherm.

**Tech Stack:** Python 3 + rclpy + numpy (maaier), Express/TypeScript (server), React + three (dashboard), React Native + expo-gl + three + @react-three/fiber (app).

**Spec:** `docs/superpowers/specs/2026-07-17-terrain-objects-app-viewer-design.md` (incl. amendementen live-groei en hoogte-gedreven objecten).

## Global Constraints

- Test-mowers: **.244 (LFIN2230700238)** én **.100 (LFIN1231000211, trampoline-tuin)**. SSH: `sshpass -p novabot ssh -o ConnectTimeout=8 -o StrictHostKeyChecking=no root@<ip>`. Maaier-veiligheid: alleen scp naar `/root/novabot/scripts/`, bracket-pkill (`pkill -f '[t]errain_scan.py'`) in een LOSSE ssh zonder het pad elders in dezelfde argv, setsid-launches hangen de ssh-sessie (afbreken + verse-ssh-verificatie is normaal), NOOIT reboot/andere services.
- Fase-0 feiten points_labeled: frame `tof_camera` (zelfde als ToF → bestaande `cam_to_base` geldt), **packed 13 B/punt**: x f32@0, y f32@4, z f32@8, label u8@12; variabele breedte; **lege frames komen voor** (geen obstakel in beeld) en moeten geskipt; labels in de praktijk vooral `lawn`(2)/`background`(1)/`charging_station`(10).
- Objectselectie (spec-amendement): base-hoogte > **0,10 m**, labels **uitgesloten: {2,3,4,7,12}** (lawn/road/terrain/dynamic/sunlight). Klasse = alleen kleur: 10 blauw `#3b82f6`, 8 groen `#22c55e`, 5/6 oranje `#f97316`, overig neutraal `#d6d3d1`.
- Live groei: daemon uploadt elke **60 s** met `&session=<start-ts>&final=0`; eind-flush `final=1`. Server vervangt de actieve laag idempotent; nieuwe sessie-id of final vouwt hem in de 7-ring. Uploads ZONDER session-param gedragen zich als final=1 (backwards-compat). Viewers pollen elke **20 s** zolang gemount.
- Binaire formaten (little-endian):
  - **TGO1** (object-sessie): `'TGO1'` · `float64 cell_size` · `int32 n` · per entry `int32 ix · int32 iy · uint8 label · float32 max_h · uint32 cnt` (**17 B**).
  - **TGMO** (object-merge): `'TGMO'` · `float64 cell_size` · `int32 n` · per entry `int32 ix · int32 iy · uint8 label · uint8 k · float32[7] samples · uint32 cnt` (**42 B**). k = gevulde slots, oudste valt eruit bij >7.
  - TGR1/TGM1 (terrein) zijn ongewijzigd; zie plan 2026-07-17-terrain-3d-map.md.
- Commit-hygiëne: alleen de taak-bestanden stagen (werkboom bevat ongerelateerde WIP: app/-schedule-wijzigingen, `research/extended_commands.py`, `server/src/mqtt/broker.ts` — NOOIT meestagen); `PATH="/bin:/usr/bin:$PATH"` prefix op git commit; geen Co-Authored-By. Cloud-api-wijzigingen vereisen een CHANGELOG-entry (pre-commit guard).
- Python-tests: plain `python3 research/__tests__/test_terrain_scan.py` (geen pytest). Server: `cd server && npx vitest run --silent` + `npx tsc --noEmit`. Dashboard/app: `npx tsc --noEmit` (+ dashboard `npm run build`).
- App gebruikt de **`?raw=1`**-variant van de GET-endpoints (ongecomprimeerd) — geen gzip-afhankelijkheid in RN-fetch.

---

### Task 1: Python objectkern (parse + hoogte-filter + accumulate + TGO1)

**Files:**
- Modify: `research/terrain_scan.py` (nieuwe pure functies + constanten, bij de bestaande rekenkern)
- Test: `research/__tests__/test_terrain_scan.py` (uitbreiden)

**Interfaces:**
- Consumes: bestaande `cam_to_base` (verwacht (N,4) incl. conf-kolom), `CELL`.
- Produces (Task 2 gebruikt exact):
  - `parse_labeled(data: bytes) -> tuple[np.ndarray, np.ndarray]` — packed 13B-buffer → ((N,4) float32 x/y/z/conf=1.0, (N,) uint8 labels)
  - `accumulate_objects(objgrid: dict, pts_base: np.ndarray, labels: np.ndarray) -> None` — pts_base = output van `cam_to_base`-transformatie NAAR MAP-frame (dus (M,3) kaartframe) met bijbehorende labels van DEZELFDE lengte; grid `{(ix,iy,label): [max_h, cnt]}`
  - `serialize_objects(objgrid: dict, cell_size: float) -> bytes` — TGO1
  - Constanten: `OBJ_HEIGHT_MIN = 0.10`, `OBJ_EXCLUDE_LABELS = frozenset({2, 3, 4, 7, 12})`, `OBJ_MAX_ENTRIES = 500_000`

Let op de filter-volgorde in Task 2: `parse_labeled` levert punten+labels; het label-filter moet TOEGEPAST worden vóór `cam_to_base` de punten uitdunt, anders lopen labels en punten uit de pas. Daarom filtert `parse_labeled` NIETS en werkt Task 2 zo: eerst label-masker op de ruwe arrays, dán `cam_to_base` op het gemaskerde deel — `cam_to_base` behoudt de volgorde maar dunt uit; daarom geeft Task 2 de labels mee door het uitdun-masker zelf te berekenen. Om dat robuust te houden levert deze taak óók:
  - `cam_to_base_mask(pts: np.ndarray) -> np.ndarray` — zelfde filterlogica als `cam_to_base` maar retourneert het boolean-masker (N,) i.p.v. de punten, zodat de aanroeper labels synchroon kan houden. `cam_to_base` blijft bestaan en wordt intern `pts[cam_to_base_mask(pts)]`-equivalent (refactor: één gedeelde maskerfunctie, geen gedupliceerde filterlogica).

- [ ] **Step 1: Schrijf de falende tests** — append aan `research/__tests__/test_terrain_scan.py` vóór de slotprint:

```python
# ── objectkern (Task 1 objects-plan) ──
# parse_labeled: packed 13B → (N,4)+labels
packed = bytearray()
for (x, y, z, lab) in [(0.1, 0.2, 1.0, 1), (0.0, -0.1, 1.5, 10)]:
    packed += struct.pack("<fffB", x, y, z, lab)
pts4, labs = ts.parse_labeled(bytes(packed))
assert pts4.shape == (2, 4) and labs.shape == (2,), (pts4.shape, labs.shape)
assert abs(pts4[1, 2] - 1.5) < 1e-6 and labs[1] == 10
assert (pts4[:, 3] == 1.0).all()  # conf gefaket op 1.0 voor cam_to_base

# cam_to_base_mask is consistent met cam_to_base
m = ts.cam_to_base_mask(pts4)
assert m.shape == (2,) and m.dtype == bool
assert len(ts.cam_to_base(pts4)) == int(m.sum())

# accumulate_objects: hoogte-filter, label-exclusie, max-hoogte per (cel,label)
og = {}
pm = np.array([[0.02, 0.02, 0.50], [0.03, 0.03, 0.30], [0.02, 0.02, 0.05],
               [0.52, 0.02, 0.40], [0.02, 0.52, 0.60]])
lb = np.array([1, 1, 1, 2, 7], dtype=np.uint8)  # lawn(2) en dynamic(7) vallen af
ts.accumulate_objects(og, pm, lb)
assert set(og.keys()) == {(0, 0, 1)}, og.keys()          # 0.05m < OBJ_HEIGHT_MIN valt af
assert abs(og[(0, 0, 1)][0] - 0.50) < 1e-6               # max, niet mean
assert og[(0, 0, 1)][1] == 2                              # cnt telt beide punten >0.10

# serialize_objects round-trip
blob_o = ts.serialize_objects(og, ts.CELL)
assert blob_o[:4] == b"TGO1"
n_o, = struct.unpack_from("<i", blob_o, 12)
assert n_o == 1
ix, iy, lab_o, mh, cnt_o = struct.unpack_from("<iiBfI", blob_o, 16)
assert (ix, iy, lab_o, cnt_o) == (0, 0, 1, 2) and abs(mh - 0.5) < 1e-6

# OBJ_MAX_ENTRIES-cap
old_cap_o = ts.OBJ_MAX_ENTRIES
ts.OBJ_MAX_ENTRIES = 1
og2 = {}
ts.accumulate_objects(og2, np.array([[0.02, 0.02, 0.5]]), np.array([1], dtype=np.uint8))
ts.accumulate_objects(og2, np.array([[0.52, 0.52, 0.5]]), np.array([1], dtype=np.uint8))
assert len(og2) == 1
ts.OBJ_MAX_ENTRIES = old_cap_o
```

- [ ] **Step 2: Run — verwacht falen**

Run: `python3 research/__tests__/test_terrain_scan.py`
Expected: `AttributeError: ... parse_labeled`

- [ ] **Step 3: Implementeer** — in `research/terrain_scan.py`, onder de bestaande rekenkern:

```python
# ── Objectlaag (spec-amendement: hoogte-gedreven, klasse = alleen kleur) ──
OBJ_HEIGHT_MIN = 0.10                              # m boven wielvlak
OBJ_EXCLUDE_LABELS = frozenset({2, 3, 4, 7, 12})   # lawn/road/terrain/dynamic/sunlight
OBJ_MAX_ENTRIES = 500_000                          # RAM-cap (cel,label)-entries


def parse_labeled(data):
    """Packed points_labeled-buffer (13 B/punt: x,y,z f32 + label u8) →
    ((N,4) float32 met conf=1.0 zodat cam_to_base herbruikbaar is, (N,) u8)."""
    raw = np.frombuffer(data, dtype=np.uint8).reshape(-1, 13)
    xyz = raw[:, :12].copy().view(np.float32).reshape(-1, 3)
    pts4 = np.column_stack([xyz, np.ones(len(xyz), dtype=np.float32)]).astype(np.float32)
    return pts4, raw[:, 12].copy()


def cam_to_base_mask(pts):
    """Boolean-masker van cam_to_base's filters, zodat een aanroeper parallelle
    arrays (labels) synchroon kan uitdunnen."""
    ok = (pts[:, 3] >= CONF_MIN) & np.isfinite(pts[:, 2]) \
        & (pts[:, 2] >= RANGE_MIN) & (pts[:, 2] <= RANGE_MAX)
    base = pts[:, 0:1] * _XC + pts[:, 1:2] * _YC + pts[:, 2:3] * _ZC + _T
    ok &= (base[:, 2] >= HEIGHT_MIN) & (base[:, 2] <= HEIGHT_MAX)
    return ok
```

Refactor `cam_to_base` zodat de filterlogica één keer bestaat:

```python
def cam_to_base(pts):
    """(N,4) cam-optical x/y/z/conf → (M,3) base-frame, gefilterd."""
    ok = cam_to_base_mask(pts)
    p = pts[ok, :3].astype(np.float64)
    return p[:, 0:1] * _XC + p[:, 1:2] * _YC + p[:, 2:3] * _ZC + _T
```

```python
def accumulate_objects(objgrid, pts_map, labels):
    """Kaartframe-punten + labels → {(ix,iy,label): [max_h, cnt]}.
    Hoogte-gedreven: > OBJ_HEIGHT_MIN, exclusie-labels eruit."""
    if len(pts_map) == 0:
        return
    keep = (pts_map[:, 2] > OBJ_HEIGHT_MIN) & ~np.isin(labels, list(OBJ_EXCLUDE_LABELS))
    pts = pts_map[keep]
    labs = labels[keep]
    if len(pts) == 0:
        return
    ix = np.floor(pts[:, 0] / CELL).astype(np.int64)
    iy = np.floor(pts[:, 1] / CELL).astype(np.int64)
    comp = ((ix + 1_048_576) << 25) | ((iy + 1_048_576) << 4) | labs.astype(np.int64)
    uniq, inv = np.unique(comp, return_inverse=True)
    gmax = np.full(len(uniq), -np.inf)
    np.maximum.at(gmax, inv, pts[:, 2])
    cnts = np.bincount(inv)
    for c, mh, ct in zip(uniq.tolist(), gmax.tolist(), cnts.tolist()):
        lab = c & 0xF
        giy = ((c >> 4) & 0x1FFFFF) - 1_048_576
        gix = (c >> 25) - 1_048_576
        key = (gix, giy, lab)
        e = objgrid.get(key)
        if e is None:
            if len(objgrid) >= OBJ_MAX_ENTRIES:
                continue  # ponytail: cap = stil stoppen met nieuwe entries
            objgrid[key] = [mh, int(ct)]
        else:
            e[0] = max(e[0], mh)
            e[1] += int(ct)


def serialize_objects(objgrid, cell_size):
    """Objectgrid → TGO1 (17 B/entry, zie plan-header)."""
    out = bytearray()
    out += b"TGO1"
    out += struct.pack("<d", cell_size)
    out += struct.pack("<i", len(objgrid))
    for (ix, iy, lab), (mh, cnt) in objgrid.items():
        out += struct.pack("<iiBfI", ix, iy, lab, mh, cnt)
    return bytes(out)
```

- [ ] **Step 4: Run — verwacht slagen**

Run: `python3 research/__tests__/test_terrain_scan.py`
Expected: `test_terrain_scan: ALLES OK`

- [ ] **Step 5: Commit**

```bash
PATH="/bin:/usr/bin:$PATH" git add research/terrain_scan.py research/__tests__/test_terrain_scan.py
PATH="/bin:/usr/bin:$PATH" git commit -m "terrain-objects: pure objectkern (parse_labeled + hoogte-filter + TGO1)"
```

---

### Task 2: Daemon — points_labeled-subscriber + live-upload-lus

**Files:**
- Modify: `research/terrain_scan.py` (ROS-schil)
- Test: `research/__tests__/test_terrain_scan.py` (url-helper)

**Interfaces:**
- Consumes: Task-1-functies; bestaande `_read_config`, `serialize_grid`, sessie-flush-mechaniek.
- Produces: daemon die (a) objectgrid meebouwt, (b) elke 60 s tussentijds upload met `?sn=..&session=<ts>&final=0` naar `uploadTerrainGrid` én `uploadObjectGrid`, (c) bij de eind-flush `final=1` stuurt en het objectbestand `.tgo` naast `.tgr` schrijft/uploadt. Pure helper `upload_url(http_address, endpoint, sn, session, final) -> str` (unit-getest).

- [ ] **Step 1: Falende test voor de url-helper** — append aan de testfile:

```python
u = ts.upload_url("192.168.0.247:8080", "uploadTerrainGrid", "LFIN1231000211", 1784300000, 0)
assert u == "http://192.168.0.247:8080/api/nova-file-server/terrain/uploadTerrainGrid?sn=LFIN1231000211&session=1784300000&final=0", u
u2 = ts.upload_url("host", "uploadObjectGrid", "LFIN0001", None, 1)
assert u2 == "http://host/api/nova-file-server/terrain/uploadObjectGrid?sn=LFIN0001&final=1", u2
```

- [ ] **Step 2: Run — verwacht falen** (`AttributeError: upload_url`)

- [ ] **Step 3: Implementeer.** Bovenin het ROS-schil-deel:

```python
LIVE_INTERVAL = 60.0   # s tussen tussentijdse uploads tijdens een sessie


def upload_url(http_address, endpoint, sn, session, final):
    url = f"http://{http_address}/api/nova-file-server/terrain/{endpoint}?sn={sn}"
    if session is not None:
        url += f"&session={session}"
    return url + f"&final={final}"
```

Vervang `_upload(path, ...)` door een bytes-variant + bestandswrapper:

```python
def _upload_bytes(payload, http_address, url):
    import urllib.request
    req = urllib.request.Request(
        url, data=payload, method="POST",
        headers={"Content-Type": "application/octet-stream"})
    with urllib.request.urlopen(req, timeout=UPLOAD_TIMEOUT) as resp:
        return 200 <= resp.status < 300
```

In `main()`:
- state uitbreiden: `st = {..., "obj": {}, "session": None, "last_live": 0.0}`.
- `on_cloud` zet bij het eerste geaccepteerde frame `st["session"] = int(time.time())` als die None is.
- Nieuwe subscriber (na de bestaande twee):

```python
    def on_labeled(msg):
        now = time.time()
        if len(msg.data) == 0:
            return  # leeg frame: geen obstakel in beeld (fase-0 feit)
        if msg.point_step != 13:
            node.get_logger().warn(f"terrain: onverwachte labeled point_step {msg.point_step} (verwacht 13) — frame overgeslagen")
            return
        if st["pose"] is None or now - st["pose_t"] > POSE_MAX_AGE:
            return
        if now - st.get("last_obj_frame", 0.0) < FRAME_INTERVAL:
            return
        st["last_obj_frame"] = now
        pts4, labels = parse_labeled(bytes(msg.data))
        m = cam_to_base_mask(pts4)
        base = cam_to_base(pts4)
        x, y, yaw = st["pose"]
        accumulate_objects(st["obj"], base_to_map(base, x, y, yaw), labels[m])

    node.create_subscription(PointCloud2, "/perception/points_labeled", on_labeled, 5)
```

- Live-lus in de while (na de flush-check):

```python
        now = time.time()
        if (st["grid"] or st["obj"]) and st["session"] is not None \
                and now - st["last_live"] >= LIVE_INTERVAL:
            st["last_live"] = now
            try:
                _upload_bytes(serialize_grid(st["grid"], CELL), http_address,
                              upload_url(http_address, "uploadTerrainGrid", sn, st["session"], 0))
                if st["obj"]:
                    _upload_bytes(serialize_objects(st["obj"], CELL), http_address,
                                  upload_url(http_address, "uploadObjectGrid", sn, st["session"], 0))
            except Exception as e:  # noqa: BLE001 — live is best-effort; final flush is de waarheid
                node.get_logger().warn(f"terrain: live-upload faalde: {e}")
```

- `flush()` uitbreiden: schrijf naast het `.tgr`-bestand ook `session_<ts>.tgo` als `st["obj"]` niet leeg is; leeg `st["obj"]` en `st["session"]` in de finally; de upload-nalus stuurt `.tgr`-bestanden naar `upload_url(..., "uploadTerrainGrid", sn, <sessie-ts-uit-bestandsnaam>, 1)` en `.tgo` naar `uploadObjectGrid` met final=1 (sessie-ts parsen uit de bestandsnaam `session_(\d+)\.tg[ro]`).

- [ ] **Step 4: Run tests + syntax**

Run: `python3 research/__tests__/test_terrain_scan.py && python3 -m py_compile research/terrain_scan.py`
Expected: `ALLES OK`, geen compile-fouten.

- [ ] **Step 5: Commit**

```bash
PATH="/bin:/usr/bin:$PATH" git add research/terrain_scan.py research/__tests__/test_terrain_scan.py
PATH="/bin:/usr/bin:$PATH" git commit -m "terrain-objects: labeled-subscriber + 60s live-uploads met sessie-id"
```

---

### Task 3: Server — TGO1/TGMO parse & merge

**Files:**
- Modify: `server/src/services/terrainGrid.ts`
- Test: `server/src/__tests__/services/terrainGrid.test.ts` (uitbreiden)

**Interfaces:**
- Produces (Task 4/5 gebruiken exact):
  - `parseTgo1(buf: Buffer): { cellSize: number; cells: Map<string, { maxH: number; cnt: number }> }` — key `"ix,iy,label"`; `Error('bad magic')`/`Error('truncated TGO1')`
  - `mergeIntoTgmo(existing: Buffer | null, session: Buffer): Buffer`
  - `tgmoToDisplayTgo1(tgmo: Buffer): Buffer` — mediaan van de max-h-slots
  - `tgmoCellCount(tgmo: Buffer): number`

- [ ] **Step 1: Falende tests** — append in de bestaande describe-file:

```ts
import { parseTgo1, mergeIntoTgmo, tgmoToDisplayTgo1, tgmoCellCount } from '../../services/terrainGrid.js';

function tgo1(cells: Array<[number, number, number, number, number]>, cellSize = 0.05): Buffer {
  const buf = Buffer.alloc(16 + cells.length * 17);
  buf.write('TGO1', 0, 'ascii');
  buf.writeDoubleLE(cellSize, 4);
  buf.writeInt32LE(cells.length, 12);
  cells.forEach(([ix, iy, label, maxH, cnt], i) => {
    const o = 16 + i * 17;
    buf.writeInt32LE(ix, o); buf.writeInt32LE(iy, o + 4);
    buf.writeUInt8(label, o + 8); buf.writeFloatLE(maxH, o + 9); buf.writeUInt32LE(cnt, o + 13);
  });
  return buf;
}

describe('terrainGrid objects (TGO1/TGMO)', () => {
  it('parseTgo1 round-trip + truncation', () => {
    const p = parseTgo1(tgo1([[2, -3, 1, 0.45, 9]]));
    expect(p.cells.get('2,-3,1')).toEqual({ maxH: expect.closeTo(0.45, 5), cnt: 9 });
    expect(() => parseTgo1(Buffer.from('NOPE'))).toThrow(/bad magic/);
    const t = tgo1([[0, 0, 1, 0.2, 1]]);
    expect(() => parseTgo1(t.subarray(0, t.length - 3))).toThrow(/truncated/);
  });

  it('mergeIntoTgmo + display-mediaan + 7-ring', () => {
    let tgmo: Buffer | null = null;
    for (const h of [0.10, 0.30, 0.20]) tgmo = mergeIntoTgmo(tgmo, tgo1([[0, 0, 1, h, 2]]));
    expect(tgmoCellCount(tgmo!)).toBe(1);
    const disp = parseTgo1(tgmoToDisplayTgo1(tgmo!));
    expect(disp.cells.get('0,0,1')!.maxH).toBeCloseTo(0.20, 5);
    expect(disp.cells.get('0,0,1')!.cnt).toBe(6);
    for (let i = 1; i <= 9; i++) tgmo = mergeIntoTgmo(tgmo, tgo1([[1, 1, 10, i / 10, 1]]));
    const d2 = parseTgo1(tgmoToDisplayTgo1(tgmo!));
    expect(d2.cells.get('1,1,10')!.maxH).toBeCloseTo(0.6, 5); // slots 3..9
  });
});
```

- [ ] **Step 2: Run — verwacht falen**

Run: `cd server && npx vitest run src/__tests__/services/terrainGrid.test.ts`

- [ ] **Step 3: Implementeer** — in `terrainGrid.ts`, zelfde patroon als TGR1/TGM1 (constanten `TGO_HEADER=16, TGO_CELL=17, TGMO_HEADER=16, TGMO_CELL=42`):

```ts
export interface Tgo1 { cellSize: number; cells: Map<string, { maxH: number; cnt: number }> }

export function parseTgo1(buf: Buffer): Tgo1 {
  if (buf.length < TGO_HEADER || buf.toString('ascii', 0, 4) !== 'TGO1') throw new Error('bad magic');
  const cellSize = buf.readDoubleLE(4);
  const n = buf.readInt32LE(12);
  if (buf.length < TGO_HEADER + n * TGO_CELL) throw new Error('truncated TGO1');
  const cells = new Map<string, { maxH: number; cnt: number }>();
  for (let i = 0; i < n; i++) {
    const o = TGO_HEADER + i * TGO_CELL;
    cells.set(`${buf.readInt32LE(o)},${buf.readInt32LE(o + 4)},${buf.readUInt8(o + 8)}`,
      { maxH: buf.readFloatLE(o + 9), cnt: buf.readUInt32LE(o + 13) });
  }
  return { cellSize, cells };
}

interface TgmoCell { samples: number[]; cnt: number }

function parseTgmo(buf: Buffer): { cellSize: number; cells: Map<string, TgmoCell> } {
  if (buf.length < TGMO_HEADER || buf.toString('ascii', 0, 4) !== 'TGMO') throw new Error('bad magic');
  const cellSize = buf.readDoubleLE(4);
  const n = buf.readInt32LE(12);
  if (buf.length < TGMO_HEADER + n * TGMO_CELL) throw new Error('truncated TGMO');
  const cells = new Map<string, TgmoCell>();
  for (let i = 0; i < n; i++) {
    const o = TGMO_HEADER + i * TGMO_CELL;
    const k = buf.readUInt8(o + 9);
    const samples: number[] = [];
    for (let s = 0; s < k; s++) samples.push(buf.readFloatLE(o + 10 + s * 4));
    cells.set(`${buf.readInt32LE(o)},${buf.readInt32LE(o + 4)},${buf.readUInt8(o + 8)}`,
      { samples, cnt: buf.readUInt32LE(o + 38) });
  }
  return { cellSize, cells };
}

function writeTgmo(cellSize: number, cells: Map<string, TgmoCell>): Buffer {
  const buf = Buffer.alloc(TGMO_HEADER + cells.size * TGMO_CELL);
  buf.write('TGMO', 0, 'ascii');
  buf.writeDoubleLE(cellSize, 4);
  buf.writeInt32LE(cells.size, 12);
  let i = 0;
  for (const [key, c] of cells) {
    const o = TGMO_HEADER + i++ * TGMO_CELL;
    const [ix, iy, label] = key.split(',').map(Number);
    buf.writeInt32LE(ix, o); buf.writeInt32LE(iy, o + 4); buf.writeUInt8(label, o + 8);
    buf.writeUInt8(c.samples.length, o + 9);
    c.samples.forEach((v, s) => buf.writeFloatLE(v, o + 10 + s * 4));
    buf.writeUInt32LE(Math.min(c.cnt, 0xFFFFFFFF), o + 38);
  }
  return buf;
}

export function mergeIntoTgmo(existing: Buffer | null, session: Buffer): Buffer {
  const s = parseTgo1(session);
  const base = existing ? parseTgmo(existing) : { cellSize: s.cellSize, cells: new Map<string, TgmoCell>() };
  for (const [key, cell] of s.cells) {
    const cur = base.cells.get(key) ?? { samples: [], cnt: 0 };
    cur.samples.push(cell.maxH);
    if (cur.samples.length > 7) cur.samples.shift();
    cur.cnt += cell.cnt;
    base.cells.set(key, cur);
  }
  return writeTgmo(base.cellSize, base.cells);
}

export function tgmoCellCount(tgmo: Buffer): number { return tgmo.readInt32LE(12); }

export function tgmoToDisplayTgo1(tgmo: Buffer): Buffer {
  const { cellSize, cells } = parseTgmo(tgmo);
  const out = Buffer.alloc(TGO_HEADER + cells.size * TGO_CELL);
  out.write('TGO1', 0, 'ascii');
  out.writeDoubleLE(cellSize, 4);
  out.writeInt32LE(cells.size, 12);
  let i = 0;
  for (const [key, c] of cells) {
    const o = TGO_HEADER + i++ * TGO_CELL;
    const [ix, iy, label] = key.split(',').map(Number);
    const sorted = [...c.samples].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    out.writeInt32LE(ix, o); out.writeInt32LE(iy, o + 4); out.writeUInt8(label, o + 8);
    out.writeFloatLE(median, o + 9);
    out.writeUInt32LE(Math.min(c.cnt, 0xFFFFFFFF), o + 13);
  }
  return out;
}
```

- [ ] **Step 4: Run — verwacht slagen** (alle terrainGrid-tests groen) + `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
PATH="/bin:/usr/bin:$PATH" git add server/src/services/terrainGrid.ts server/src/__tests__/services/terrainGrid.test.ts
PATH="/bin:/usr/bin:$PATH" git commit -m "terrain-objects: TGO1/TGMO parse + merge service"
```

---

### Task 4: Server — actieve-sessie-laag + object-upload + raw=1

**Files:**
- Modify: `server/src/cloud-api/routes/terrain.ts` (sessie/final-afhandeling + object-endpoint)
- Modify: `server/src/routes/dashboard.ts` (beide GETs: actieve laag mengen + `?raw=1`; nieuwe GET `/terrain-objects/:sn`)
- Modify: `server/src/db/database.ts` + `server/src/db/repositories/terrainGrids.ts` (kolommen `obj_cells INTEGER DEFAULT 0`, `obj_sessions INTEGER DEFAULT 0` + `upsertObjMeta`)
- Modify: `server/src/cloud-api/CHANGELOG.md`
- Test: `server/src/cloud-api/__tests__/contract/terrain.upload.test.ts` (uitbreiden) + `server/src/__tests__/routes/terrainGet.test.ts` (uitbreiden)

**Interfaces:**
- Consumes: Task-3-functies; bestaande `parseTgr1/mergeIntoTgm1/tgm1ToDisplayTgr1`; `terrainGridRepo`.
- Produces:
  - Upload-gedrag: `?session=<id>&final=0` → schrijf `<sn>.active.tgr`/`.active.tgo` + `<sn>.active.json` (`{"session":"<id>"}`); zelfde sessie vervángt. `final=1`, geen session-param, of een ándere sessie-id → actieve laag (indien aanwezig en anders-dan-binnenkomend eerst invouwen) → body in TGM/TGMO mergen, metadata bijwerken, actieve bestanden weg.
  - `POST /api/nova-file-server/terrain/uploadObjectGrid?sn=` — TGO1-variant, zelfde semantiek.
  - `GET /api/dashboard/terrain/:sn` en NIEUW `GET /api/dashboard/terrain-objects/:sn`: display = merge(persistent, actieve laag) on-the-fly; `?raw=1` → géén gzip. 404 pas als bèide lagen ontbreken.
  - `terrainGridRepo.upsertObjMeta({ mower_sn, cells, sessions_delta })`.

- [ ] **Step 1: Falende tests.** Contract-test uitbreiden (gebruik de bestaande `tgr1(...)`-helper + nieuwe `tgo1(...)`-helper zoals in Task 3):

```ts
  it('live-sessie: final=0 vervangt actieve laag, final=1 vouwt één keer in', async () => {
    const app = buildTestApp();
    const S = 'sn=LFIN2230700238&session=111&final=0';
    await request(app).post(`/api/nova-file-server/terrain/uploadTerrainGrid?${S}`)
      .set('Content-Type', 'application/octet-stream').send(tgr1Cells([[0, 0, 0.1, 5]])).expect(200);
    await request(app).post(`/api/nova-file-server/terrain/uploadTerrainGrid?${S}`)
      .set('Content-Type', 'application/octet-stream').send(tgr1Cells([[0, 0, 0.1, 5], [1, 0, 0.2, 3]])).expect(200);
    const before = terrainGridRepo.findBySn('LFIN2230700238');
    await request(app).post('/api/nova-file-server/terrain/uploadTerrainGrid?sn=LFIN2230700238&session=111&final=1')
      .set('Content-Type', 'application/octet-stream').send(tgr1Cells([[0, 0, 0.1, 5], [1, 0, 0.2, 3]])).expect(200);
    const after = terrainGridRepo.findBySn('LFIN2230700238')!;
    expect(after.sessions).toBe((before?.sessions ?? 0) + 1);  // tussentijdse uploads telden NIET
  });

  it('uploadObjectGrid accepteert TGO1 en registreert obj-metadata', async () => {
    const app = buildTestApp();
    await request(app).post('/api/nova-file-server/terrain/uploadObjectGrid?sn=LFIN2230700238&final=1')
      .set('Content-Type', 'application/octet-stream').send(tgo1Cells([[3, 4, 1, 0.5, 7]])).expect(200);
    expect(terrainGridRepo.findBySn('LFIN2230700238')!.obj_sessions).toBeGreaterThanOrEqual(1);
  });
```

GET-test uitbreiden:

```ts
  it('display bevat de actieve laag; raw=1 is ongecomprimeerd', async () => {
    // schrijf persistente TGM + actieve laag
    const dir = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'LFIN2230700238.tgm'), mergeIntoTgm1(null, tgr1([[0, 0, 0.2, 5]])));
    fs.writeFileSync(path.join(dir, 'LFIN2230700238.active.tgr'), tgr1([[9, 9, 0.9, 1]]));
    fs.writeFileSync(path.join(dir, 'LFIN2230700238.active.json'), JSON.stringify({ session: '42' }));
    const app = buildDashboardTestApp();
    const res = await request(app).get('/api/dashboard/terrain/LFIN2230700238?raw=1')
      .buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    const disp = parseTgr1(res.body as Buffer);
    expect(disp.cells.has('9,9')).toBe(true);   // actieve laag zichtbaar
    expect(disp.cells.has('0,0')).toBe(true);
  });

  it('GET terrain-objects levert TGO1-display', async () => {
    const dir = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain');
    fs.writeFileSync(path.join(dir, 'LFIN2230700238.tgmo'), mergeIntoTgmo(null, tgo1([[1, 1, 10, 0.3, 4]])));
    const app = buildDashboardTestApp();
    const res = await request(app).get('/api/dashboard/terrain-objects/LFIN2230700238?raw=1')
      .buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(parseTgo1(res.body as Buffer).cells.has('1,1,10')).toBe(true);
  });
```

- [ ] **Step 2: Run — verwacht falen** (404/param-gedrag ontbreekt).

- [ ] **Step 3: Implementeer.** In `terrain.ts` een gedeelde afhandeling:

```ts
const activePaths = (sn: string) => ({
  tgr: path.join(TERRAIN_DIR, `${sn}.active.tgr`),
  tgo: path.join(TERRAIN_DIR, `${sn}.active.tgo`),
  meta: path.join(TERRAIN_DIR, `${sn}.active.json`),
});

function activeSession(sn: string): string | null {
  const p = activePaths(sn).meta;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).session ?? null; }
  catch { return null; }
}

/** Vouw een achtergebleven actieve sessie definitief in (crash-herstel of
 *  sessie-wissel zonder final). */
function foldActive(sn: string): void {
  const a = activePaths(sn);
  if (fs.existsSync(a.tgr)) {
    const tgmPath = path.join(TERRAIN_DIR, `${sn}.tgm`);
    const existing = fs.existsSync(tgmPath) ? fs.readFileSync(tgmPath) : null;
    fs.writeFileSync(tgmPath, mergeIntoTgm1(existing, fs.readFileSync(a.tgr)));
    terrainGridRepo.upsertMeta({ mower_sn: sn, cell_size: 0.05, cells: 0, sessions_delta: 1 });
  }
  if (fs.existsSync(a.tgo)) {
    const tgmoPath = path.join(TERRAIN_DIR, `${sn}.tgmo`);
    const existing = fs.existsSync(tgmoPath) ? fs.readFileSync(tgmoPath) : null;
    fs.writeFileSync(tgmoPath, mergeIntoTgmo(existing, fs.readFileSync(a.tgo)));
    terrainGridRepo.upsertObjMeta({ mower_sn: sn, cells: 0, sessions_delta: 1 });
  }
  for (const p of Object.values(a)) { try { fs.unlinkSync(p); } catch { /* al weg */ } }
}
```

Beide upload-handlers volgen dan hetzelfde stramien (getoond voor terrein; objects idem met `parseTgo1`/`mergeIntoTgmo`/`.tgmo`/`.active.tgo`/`upsertObjMeta` en `tgmoCellCount`):

```ts
    const session = req.query.session ? String(req.query.session) : null;
    const isFinal = String(req.query.final ?? '1') === '1';
    const cur = activeSession(sn);
    if (cur && session !== cur) foldActive(sn);   // sessie-wissel: oude eerst invouwen

    if (session && !isFinal) {
      fs.mkdirSync(TERRAIN_DIR, { recursive: true });
      fs.writeFileSync(activePaths(sn).tgr, body);
      fs.writeFileSync(activePaths(sn).meta, JSON.stringify({ session }));
      res.json(ok(null));
      return;
    }
    // final (of legacy zonder session): actieve laag van deze sessie is
    // vervangen door de definitieve body — weggooien en body mergen.
    for (const p of [activePaths(sn).tgr, activePaths(sn).meta]) { try { fs.unlinkSync(p); } catch { /* al weg */ } }
    // ... bestaande merge-code (mergeIntoTgm1 + upsertMeta zoals nu) ...
```

Metadata-cellen bij final: `cells: tgm1CellCount(merged)` zoals nu. `upsertObjMeta` in de repo:

```ts
  private _upsertObj = db.prepare(`
    INSERT INTO terrain_grids (mower_sn, obj_sessions, obj_cells, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(mower_sn) DO UPDATE SET
      obj_sessions = obj_sessions + ?,
      obj_cells    = excluded.obj_cells,
      updated_at   = datetime('now')
  `);

  upsertObjMeta(d: { mower_sn: string; cells: number; sessions_delta: number }): void {
    this._upsertObj.run(d.mower_sn, d.sessions_delta, d.cells, d.sessions_delta);
  }
```

Migratie in database.ts (na het terrain_grids-blok):

```ts
  for (const col of ['obj_cells INTEGER DEFAULT 0', 'obj_sessions INTEGER DEFAULT 0']) {
    try { db.exec(`ALTER TABLE terrain_grids ADD COLUMN ${col}`); }
    catch { /* kolom bestaat al */ }
  }
```

GETs in dashboard.ts — gedeeld patroon (sn-regex-guard zoals de bestaande route!):

```ts
function sendGrid(res: Response, display: Buffer, raw: boolean): void {
  res.setHeader('Content-Type', 'application/octet-stream');
  if (raw) { res.send(display); return; }
  res.setHeader('Content-Encoding', 'gzip');
  res.send(zlib.gzipSync(display));
}

dashboardRouter.get('/terrain/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  if (!/^LFI[A-Z]\d+$/.test(sn)) { res.status(400).json({ error: 'invalid sn' }); return; }
  const dir = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain');
  const tgmPath = path.join(dir, `${sn}.tgm`);
  const activePath = path.join(dir, `${sn}.active.tgr`);
  const base = fs.existsSync(tgmPath) ? fs.readFileSync(tgmPath) : null;
  const active = fs.existsSync(activePath) ? fs.readFileSync(activePath) : null;
  if (!base && !active) { res.status(404).json({ error: 'geen terrein voor deze maaier' }); return; }
  try {
    const merged = active ? mergeIntoTgm1(base, active) : base!;
    sendGrid(res, tgm1ToDisplayTgr1(merged), req.query.raw === '1');
  } catch (err) {
    console.error(`[TERRAIN] display ${sn} faalde:`, err);
    res.status(500).json({ error: 'terreindata corrupt' });
  }
});
```

`/terrain-objects/:sn` identiek met `.tgmo`/`.active.tgo`/`mergeIntoTgmo`/`tgmoToDisplayTgo1`. CHANGELOG-entry bovenaan:

```markdown
## 2026-07-17 — terrain: live sessies + object-laag

- uploadTerrainGrid/uploadObjectGrid accepteren `session`+`final`: tussentijdse
  uploads (final=0) vervangen een actieve-sessie-laag; final=1 vouwt in de
  merge-ring. Nieuw: uploadObjectGrid (TGO1). Zie objects-spec 2026-07-17.
```

- [ ] **Step 4: Run — alles groen**

Run: `cd server && npx tsc --noEmit && npx vitest run --silent`

- [ ] **Step 5: Commit**

```bash
PATH="/bin:/usr/bin:$PATH" git add server/src/cloud-api/routes/terrain.ts server/src/routes/dashboard.ts server/src/db/database.ts server/src/db/repositories/terrainGrids.ts server/src/cloud-api/CHANGELOG.md server/src/cloud-api/__tests__/contract/terrain.upload.test.ts server/src/__tests__/routes/terrainGet.test.ts
PATH="/bin:/usr/bin:$PATH" git commit -m "terrain-objects: actieve-sessie-laag + object-endpoints + raw=1"
```

---

### Task 5: Dashboard — voxel-lagen + legenda + live-poll + maaier-marker

**Files:**
- Modify: `dashboard/src/utils/terrainParser.ts` (TGO1-parser erbij)
- Modify: `dashboard/src/pages/TerrainPage.tsx`

**Interfaces:**
- Consumes: `GET /api/dashboard/terrain-objects/:sn` (gzip TGO1); bestaande terrain-fetch; live maaier-positie — **discovery**: `grep -n "map_x\|mowerPos\|position" dashboard/src/pages/MapTab.tsx | head` om de bron te vinden die MapTab voor de live positie gebruikt, en gebruik exact diezelfde bron.
- Produces: TerrainPage met (1) object-voxels via `THREE.InstancedMesh`, kleur per label (kleurtabel uit Global Constraints), (2) legenda + aan/uit-toggles per kleurgroep, (3) her-fetch van beide grids elke 20 s zolang gemount (oude geometrie disposen!), (4) maaier-marker (cone, r=0.15 m, h=0.3 m) op (x, y, terreinhoogte+0.15) + trail-lijn van de laatste 50 posities.

- [ ] **Step 1: TGO1-parser toevoegen** aan `terrainParser.ts`:

```ts
export interface ObjectData {
  cellSize: number;
  ix: Int32Array; iy: Int32Array; label: Uint8Array; h: Float32Array; cnt: Uint32Array;
}

export function parseObjects(buf: ArrayBuffer): ObjectData {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'TGO1') throw new Error('bad magic');
  const cellSize = dv.getFloat64(4, true);
  const n = dv.getInt32(12, true);
  const ix = new Int32Array(n), iy = new Int32Array(n);
  const label = new Uint8Array(n); const h = new Float32Array(n); const cnt = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const o = 16 + i * 17;
    ix[i] = dv.getInt32(o, true); iy[i] = dv.getInt32(o + 4, true);
    label[i] = dv.getUint8(o + 8); h[i] = dv.getFloat32(o + 9, true); cnt[i] = dv.getUint32(o + 13, true);
  }
  return { cellSize, ix, iy, label, h, cnt };
}

export const LABEL_COLORS: Record<number, string> = { 10: '#3b82f6', 8: '#22c55e', 5: '#f97316', 6: '#f97316' };
export const LABEL_DEFAULT_COLOR = '#d6d3d1';
```

- [ ] **Step 2: Voxels + marker + poll in TerrainPage.** Voxel-bouwer (naast buildTerrainMesh):

```ts
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
```

`groundAt` komt uit de terrain-grid (cell-lookup, val terug op 0). Poll-structuur: verplaats scene-opbouw naar een `rebuild(terrain, objects)`-functie; `useEffect` met `setInterval(20_000)` die beide endpoints her-fetcht en `rebuild` aanroept — dispose de oude mesh/voxels (`geometry.dispose()`, `material.dispose()`, scene.remove) vóór vervanging. Maaier-marker: `THREE.Mesh(new THREE.ConeGeometry(0.15, 0.3, 12))` geel, positie/rotatie geüpdatet vanuit de live-positiebron (discovery Step-consumes); trail als `THREE.Line` over de laatste 50 posities, elke update herbouwd. Legenda: klein overlay-paneel (absolute positioning, zelfde stijl als de statusteksten) met kleurvlakjes + checkboxes die `mesh.visible` per kleurgroep togglen (bouw per kleurgroep een aparte InstancedMesh: filter de ObjectData per groep en roep `buildObjectVoxels` per groep aan).

- [ ] **Step 3: Verifieer**

Run: `cd dashboard && npx tsc --noEmit && npm run build`
Expected: schoon; TerrainPage-chunk groeit beperkt.

- [ ] **Step 4: Commit**

```bash
PATH="/bin:/usr/bin:$PATH" git add dashboard/src/utils/terrainParser.ts dashboard/src/pages/TerrainPage.tsx
PATH="/bin:/usr/bin:$PATH" git commit -m "terrain-objects: dashboard voxels + legenda + 20s-poll + maaier-marker"
```

---

### Task 6: App — deps + gedeelde parsers

**Files:**
- Modify: `app/package.json` (+ lockfile) via install-commando's
- Create: `app/src/utils/terrainParser.ts`

**Interfaces:**
- Produces: `parseTerrain(buf: ArrayBuffer): TerrainData` en `parseObjects(buf: ArrayBuffer): ObjectData` — byte-identiek aan de dashboard-parsers (kopieer `dashboard/src/utils/terrainParser.ts` integraal, incl. `LABEL_COLORS`/`LABEL_DEFAULT_COLOR`); deps `three`, `@react-three/fiber`, `expo-gl` geïnstalleerd.

- [ ] **Step 1: Installeer deps**

Run: `cd app && npx expo install expo-gl && npm install three @react-three/fiber @types/three`
Expected: alle drie in package.json; `npx tsc --noEmit` schoon.

- [ ] **Step 2: Kopieer de parser** — `app/src/utils/terrainParser.ts` = letterlijke kopie van het dashboard-bestand (na Task 5, dus inclusief `parseObjects`). Voeg bovenaan een comment toe: `// Gedeeld met dashboard/src/utils/terrainParser.ts — wijzig ALTIJD beide (byte-formaat TGR1/TGO1).`

- [ ] **Step 3: Verifieer + commit**

Run: `cd app && npx tsc --noEmit`

```bash
PATH="/bin:/usr/bin:$PATH" git add app/package.json app/package-lock.json app/src/utils/terrainParser.ts
PATH="/bin:/usr/bin:$PATH" git commit -m "app: three/r3f/expo-gl deps + gedeelde terrain-parsers"
```

---

### Task 7: App — TerrainView3D (terrein + voxels + maaier + gestures)

**Files:**
- Create: `app/src/components/TerrainView3D.tsx`

**Interfaces:**
- Consumes: `parseTerrain`/`parseObjects`/`LABEL_COLORS` (Task 6); serverUrl via `getServerUrl()` uit `app/src/services/auth` (zelfde patroon als andere schermen); live positie via `useMowerState()` → `devices.get(sn)?.sensors` — gebruik dezelfde velden als HomeScreen's `mower.mowerPosX/mowerPosY` afleiding (discovery: `grep -n "mowerPosX" app/src/screens/HomeScreen.tsx | head -3` en volg de bron).
- Produces: `<TerrainView3D sn={string} />` — zelfstandig component dat fetcht (`?raw=1`-endpoints!), rendert en pollt (20 s zolang gemount). Props bewust minimaal.

- [ ] **Step 1: Component schrijven.** Kernstructuur (volledig, aanpassen aan echte veldnamen uit discovery):

```tsx
/**
 * Native 3D-terreinviewer: heightmap + object-voxels + live maaier-marker.
 * Data via de raw=1-endpoints (geen gzip-afhankelijkheid in RN-fetch).
 * Gedeelde byte-parsers met het dashboard; mesh-bouw = zelfde expliciete
 * vertex-aanpak als daar (Y-flip-les: nooit op PlaneGeometry's as-conventie
 * leunen).
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, PanResponder, Text } from 'react-native';
import { Canvas, useFrame, useThree } from '@react-three/fiber/native';
import * as THREE from 'three';
import { parseTerrain, parseObjects, LABEL_COLORS, LABEL_DEFAULT_COLOR, type TerrainData, type ObjectData } from '../utils/terrainParser';
import { getServerUrl } from '../services/auth';
import { useMowerState } from '../hooks/useMowerState';

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
```

Hoofdcomponent: fetch beide `?raw=1`-endpoints, parse, bouw geometrie + voxels (zelfde `buildObjectVoxels`-logica als dashboard, hier inline), maaier-marker `<mesh>` met cone op (posX, posY, groundAt(posX,posY)+0.15), poll met `setInterval(POLL_MS)` in een `useEffect` (cleanup: clearInterval + dispose geometrieën). Statussen: laden / geen data ("De kaart groeit tijdens het maaien…") / fout. `Canvas`-styling `{ flex: 1 }`.

- [ ] **Step 2: Verifieer**

Run: `cd app && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
PATH="/bin:/usr/bin:$PATH" git add app/src/components/TerrainView3D.tsx
PATH="/bin:/usr/bin:$PATH" git commit -m "app: native TerrainView3D (terrein + voxels + maaier + gestures)"
```

---

### Task 8: App — 2D⇄3D-toggle op MapScreen + i18n

**Files:**
- Modify: `app/src/screens/MapScreen.tsx`
- Modify: `app/src/i18n/en.ts`, `nl.ts`, `de.ts`, `fr.ts`

**Interfaces:**
- Consumes: `TerrainView3D` (Task 7). Discovery: `grep -n "return (\|ScrollView\|SafeArea" app/src/screens/MapScreen.tsx | head` voor de wortelstructuur; de toggle-knop volgt de bestaande knoppenstijl op dat scherm (zoek een bestaande TouchableOpacity met icoon als voorbeeld).
- Produces: state `view3d: boolean`; knop rechtsboven (Ionicons `cube-outline` in 2D-stand, `map-outline` in 3D-stand); in 3D-stand rendert `<TerrainView3D sn={mowerSn} />` in plaats van de 2D-kaartinhoud. i18n-keys: `map3dView` ("3D view"/"3D-weergave"/"3D-Ansicht"/"Vue 3D"), `map2dView` ("2D map"/"2D-kaart"/"2D-Karte"/"Carte 2D") — zelfde één-regel-per-key-stijl als de bestaande i18n-bestanden.

- [ ] **Step 1: Implementeer toggle + i18n** (na discovery; knop met `accessibilityLabel={view3d ? t('map2dView') : t('map3dView')}`).
- [ ] **Step 2: Verifieer** — `cd app && npx tsc --noEmit`. Handmatige check via Expo volgt in Task 9.
- [ ] **Step 3: Commit**

```bash
PATH="/bin:/usr/bin:$PATH" git add app/src/screens/MapScreen.tsx app/src/i18n/en.ts app/src/i18n/nl.ts app/src/i18n/de.ts app/src/i18n/fr.ts
PATH="/bin:/usr/bin:$PATH" git commit -m "app: 2D/3D-toggle op MapScreen"
```

---

### Task 9: Deploy .244 + .100 en live-groei-smoke (deels controller-gated)

**Files:** geen nieuwe (deploy + verificatie). De firmware-build-sectie uit het vorige plan dekt terrain_scan.py al — geen build-script-wijziging nodig.

- [ ] **Step 1: Deploy daemon naar beide maaiers.** Per maaier (eerst .244, dan .100), met de bewezen recepten:

```bash
sshpass -p novabot scp -o StrictHostKeyChecking=no research/terrain_scan.py research/start_terrain.sh root@<ip>:/root/novabot/scripts/
# losse ssh-calls (bracket-pkill, pad nooit in dezelfde argv als de pkill):
sshpass -p novabot ssh -o ConnectTimeout=8 root@<ip> "pkill -f '[s]tart_terrain.sh'"
sshpass -p novabot ssh -o ConnectTimeout=8 root@<ip> "pkill -f '[t]errain_scan.py'"
sshpass -p novabot ssh -o ConnectTimeout=8 root@<ip> "chmod +x /root/novabot/scripts/start_terrain.sh"
sshpass -p novabot ssh -o ConnectTimeout=8 root@<ip> "setsid nohup /root/novabot/scripts/start_terrain.sh > /tmp/terrain_scan.log 2>&1 < /dev/null & exit 0"
# hangt de launch-ssh: afbreken en verifiëren met verse ssh:
sshpass -p novabot ssh -o ConnectTimeout=8 root@<ip> "pgrep -af '[t]errain_scan.py'; pgrep -af '[s]tart_terrain.sh'"
```
Expected per maaier: één loop-shell + één python-kind.

- [ ] **Step 2 (CONTROLLER): live-groei-smoke.** Vereist een maaibeurt (Ramon start .100). Tijdens het maaien:

```bash
curl -s "http://192.168.0.247:8080/api/dashboard/terrain/LFIN1231000211?raw=1" -o /tmp/t1.bin -w '%{http_code} %{size_download}\n'
sleep 90
curl -s "http://192.168.0.247:8080/api/dashboard/terrain/LFIN1231000211?raw=1" -o /tmp/t2.bin -w '%{http_code} %{size_download}\n'
```
Expected: beide 200 en de tweede GROTER (meer cellen) — dat bewijst de actieve-sessie-laag. Object-check: `curl .../terrain-objects/LFIN1231000211?raw=1` → 200 met entries zodra hij langs de trampoline is geweest. Dashboard: Terrein-tab laat de kaart elke 20 s aangroeien; trampoline verschijnt als voxel-cluster. App: Expo herladen → Map-scherm → 3D-toggle → zelfde beeld + maaier-marker beweegt live.

- [ ] **Step 3: Eindcheck + push**

```bash
python3 research/__tests__/test_terrain_scan.py
cd server && npx tsc --noEmit && npx vitest run --silent && cd ..
cd dashboard && npx tsc --noEmit && cd ..
cd app && npx tsc --noEmit && cd ..
PATH="/bin:/usr/bin:$PATH" git pull --rebase && PATH="/bin:/usr/bin:$PATH" git push
```

---

## Buiten dit plan (bewust)

- Beta-release naar .247 (Ramons expliciete "release beta"-beslissing; nodig vóór de smoke van Task 9 Step 2 kan slagen tegen prod).
- Icoon-stilering van objecten; project C (2D-kaart-vervanging); socket-push i.p.v. poll.
- Periodieke voortgangs-logregel in de daemon (follow-up uit het terreinplan).
