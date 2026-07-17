# 3D-terreinkaart (ToF grid-accumulator) — implementatieplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Een 2.5D-hoogtekaart van de tuin die passief tijdens het maaien groeit (ToF + pose op de maaier → grid-upload → server-merge) en als 3D-terrein in het dashboard rendert.

**Architecture:** Een Python-sidecar op de maaier accumuleert ToF-punten direct in een 5 cm-grid (kaartframe) en POST het sessie-grid na de maaibeurt naar de cloud-api. De server merget sessies per cel (mediaan over max 7 sessies) in een persistent bestand + metadata-rij, en serveert een display-grid aan een lazy-loaded three.js-viewer in het dashboard.

**Tech Stack:** Python 3 + rclpy + numpy (maaier), Express/TypeScript + better-sqlite3 (server), React + three (dashboard).

**Spec:** `docs/superpowers/specs/2026-07-17-terrain-3d-map-design.md`

## Global Constraints

- Test-mower voor dit project: **`.244` = LFIN2230700238** (expliciet door Ramon; NIET .100).
- Fase-0 constanten: pose-topic `/robot_combination_localization/odom` (nav_msgs/Odometry, `frame_id: map`), ToF-topic `/camera/tof/point_cloud` (PointCloud2, 43200 punten, velden x/y/z/conf float32, 5,2 Hz), camera-kanteling **25° omlaag**, camera-hoogte **0,37 m**, celgrootte **0,05 m**.
- Maaier-load tijdens maaien ≈ 12: daemon max **2 frames/s**, numpy-gevectoriseerd, `nice -n 10`, harde cap **2.000.000 cellen**.
- Mower-scripts local-first: bron in `research/`, deploy via scp, meebakken in `build_custom_firmware.sh`. ROS-scripts NOOIT kaal `python3` starten — altijd via env-wrapper (RtkRelay-les).
- Cloud-api wijzigingen vereisen een entry in `server/src/cloud-api/CHANGELOG.md` (pre-commit hook dwingt af).
- Commits: geen Co-Authored-By; husky-hook draaien met `PATH="/bin:/usr/bin:$PATH"` (de x86-brew-bash op deze Mac is stuk).
- Binair sessie-formaat **TGR1** (little-endian): `'TGR1'` (4B ASCII) · `float64 cell_size` · `int32 n_cells` · daarna per cel `int32 ix · int32 iy · float32 mean_h · uint32 cnt` (16 B/cel). Celcentrum = `(ix*cell, iy*cell)` in kaartframe-meters.
- Binair merge-formaat **TGM1**: `'TGM1'` · `float64 cell_size` · `int32 n_cells` · per cel `int32 ix · int32 iy · uint8 k · float32[7] samples · uint32 cnt` (41 B/cel). `k` = aantal gevulde sample-slots (sessie-gemiddelden, oudste valt eruit bij >7).

---

### Task 1: Pure rekenkern maaier-daemon (transform + accumulate + serialize)

**Files:**
- Create: `research/terrain_scan.py` (alleen het pure deel; de ROS-schil komt in Task 2)
- Test: `research/__tests__/test_terrain_scan.py`

**Interfaces:**
- Produces (Task 2 gebruikt deze exact):
  - `cam_to_base(pts: np.ndarray) -> np.ndarray` — (N,4) cam-optical x/y/z/conf → (M,3) base-frame (X vooruit, Y links, Z omhoog boven wielvlak), gefilterd op conf/bereik/hoogte
  - `base_to_map(pts: np.ndarray, x: float, y: float, yaw: float) -> np.ndarray` — (M,3) → (M,3) kaartframe
  - `yaw_from_quat(qx, qy, qz, qw) -> float`
  - `accumulate(grid: dict, pts: np.ndarray) -> None` — grid: `{packed_key: [sum_h, cnt]}`
  - `serialize_grid(grid: dict, cell_size: float) -> bytes` — TGR1
  - Constanten: `CELL=0.05`, `CAM_HEIGHT=0.37`, `CAM_TILT_DEG=25.0`, `CONF_MIN=0.5`, `RANGE_MIN=0.3`, `RANGE_MAX=2.0`, `MAX_CELLS=2_000_000`

- [ ] **Step 1: Schrijf de falende test**

`research/__tests__/test_terrain_scan.py` (zelfde stijl als `test_extended_helpers.py`: plain python3 + assert, geen pytest):

```python
#!/usr/bin/env python3
"""Self-check voor de pure rekenkern van research/terrain_scan.py.
Run: python3 research/__tests__/test_terrain_scan.py"""
import importlib.util, math, os, struct
import numpy as np

spec = importlib.util.spec_from_file_location(
    "ts", os.path.join(os.path.dirname(__file__), "..", "terrain_scan.py"))
ts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ts)

# ── cam_to_base: round-trip van een bekend grondpunt ──
# Base-punt p_b=(0.8, 0.2, 0.0) → handmatig naar cam-frame → terug.
th = math.radians(ts.CAM_TILT_DEG)
# cam-assen in base: xc=(0,-1,0), yc=(-sin,0,-cos), zc=(cos,0,-sin), t=(0,0,H)
R = np.array([[0, -math.sin(th), math.cos(th)],
              [-1, 0, 0],
              [0, -math.cos(th), -math.sin(th)]])  # kolommen xc,yc,zc
p_b = np.array([0.8, 0.2, 0.0])
p_c = R.T @ (p_b - np.array([0, 0, ts.CAM_HEIGHT]))
pts = np.array([[p_c[0], p_c[1], p_c[2], 0.9]], dtype=np.float32)
out = ts.cam_to_base(pts)
assert out.shape == (1, 3), out.shape
assert np.allclose(out[0], p_b, atol=1e-3), out[0]

# conf-filter: zelfde punt met conf 0.1 valt af
pts_low = pts.copy(); pts_low[0, 3] = 0.1
assert len(ts.cam_to_base(pts_low)) == 0

# hoogte-outlier: punt 2 m boven wielvlak valt af
p_hi = R.T @ (np.array([0.8, 0.2, 2.0]) - np.array([0, 0, ts.CAM_HEIGHT]))
assert len(ts.cam_to_base(np.array([[p_hi[0], p_hi[1], p_hi[2], 0.9]], dtype=np.float32))) == 0

# ── base_to_map: 90° yaw ──
m = ts.base_to_map(np.array([[0.8, 0.2, 0.05]]), 2.0, 3.0, math.pi / 2)
assert np.allclose(m[0], [2.0 - 0.2, 3.0 + 0.8, 0.05], atol=1e-6), m[0]

# ── yaw_from_quat: 90° om z ──
q = (0.0, 0.0, math.sin(math.pi / 4), math.cos(math.pi / 4))
assert abs(ts.yaw_from_quat(*q) - math.pi / 2) < 1e-6

# ── accumulate + serialize round-trip ──
grid = {}
ts.accumulate(grid, np.array([[0.02, 0.02, 0.10], [0.03, 0.04, 0.20], [0.12, 0.02, 0.30]]))
blob = ts.serialize_grid(grid, ts.CELL)
assert blob[:4] == b"TGR1"
cell, = struct.unpack_from("<d", blob, 4)
n, = struct.unpack_from("<i", blob, 12)
assert cell == ts.CELL and n == 2, (cell, n)
rows = {}
for i in range(n):
    ix, iy, mean, cnt = struct.unpack_from("<iif I".replace(" ", ""), blob, 16 + i * 16)
    rows[(ix, iy)] = (mean, cnt)
assert rows[(0, 0)][1] == 2 and abs(rows[(0, 0)][0] - 0.15) < 1e-6
assert rows[(2, 0)][1] == 1 and abs(rows[(2, 0)][0] - 0.30) < 1e-6

# negatieve coördinaten pakken/unpacken correct
grid2 = {}
ts.accumulate(grid2, np.array([[-0.07, -0.12, 0.5]]))
blob2 = ts.serialize_grid(grid2, ts.CELL)
ix, iy, mean, cnt = struct.unpack_from("<iifI", blob2, 16)
assert (ix, iy) == (-2, -3) and cnt == 1, (ix, iy, cnt)

print("test_terrain_scan: ALLES OK")
```

- [ ] **Step 2: Run — verwacht falen**

Run: `python3 research/__tests__/test_terrain_scan.py`
Expected: `FileNotFoundError` of `AttributeError` (terrain_scan.py bestaat nog niet).

- [ ] **Step 3: Implementeer de rekenkern**

`research/terrain_scan.py`:

```python
#!/usr/bin/env python3
"""Terrain-scan daemon: accumuleert ToF-punten in een 5 cm-hoogtegrid
(kaartframe) tijdens het maaien en uploadt het sessie-grid naar de server.
Spec: docs/superpowers/specs/2026-07-17-terrain-3d-map-design.md
Pure rekenkern bovenin (unit-getest zonder ROS); ROS-schil onder
__name__ == "__main__" zodat import op een dev-machine niets start.
"""
import math
import struct

import numpy as np

# ── Fase-0 kalibratie (gemeten op LFIN2230700238, 2026-07-17) ──
CAM_HEIGHT = 0.37        # m boven wielvlak
CAM_TILT_DEG = 25.0      # graden omlaag
CELL = 0.05              # m per gridcel
CONF_MIN = 0.5
RANGE_MIN, RANGE_MAX = 0.3, 2.0   # m diepte (cam-z)
HEIGHT_MIN, HEIGHT_MAX = -0.3, 1.5  # m t.o.v. wielvlak — outlier-afwijzing
MAX_CELLS = 2_000_000    # harde RAM-cap (X3 OOM-les)

_TH = math.radians(CAM_TILT_DEG)
# Cam-optical assen (x rechts, y omlaag, z vooruit) uitgedrukt in base
# (X vooruit, Y links, Z omhoog); camera CAM_TILT_DEG omlaag gekanteld.
_XC = np.array([0.0, -1.0, 0.0])
_YC = np.array([-math.sin(_TH), 0.0, -math.cos(_TH)])
_ZC = np.array([math.cos(_TH), 0.0, -math.sin(_TH)])
_T = np.array([0.0, 0.0, CAM_HEIGHT])


def cam_to_base(pts):
    """(N,4) cam-optical x/y/z/conf → (M,3) base-frame, gefilterd."""
    ok = (pts[:, 3] >= CONF_MIN) & np.isfinite(pts[:, 2]) \
        & (pts[:, 2] >= RANGE_MIN) & (pts[:, 2] <= RANGE_MAX)
    p = pts[ok, :3].astype(np.float64)
    base = p[:, 0:1] * _XC + p[:, 1:2] * _YC + p[:, 2:3] * _ZC + _T
    hok = (base[:, 2] >= HEIGHT_MIN) & (base[:, 2] <= HEIGHT_MAX)
    return base[hok]


def yaw_from_quat(qx, qy, qz, qw):
    return math.atan2(2.0 * (qw * qz + qx * qy), 1.0 - 2.0 * (qy * qy + qz * qz))


def base_to_map(pts, x, y, yaw):
    """(M,3) base → kaartframe via 2D-pose. Hoogte blijft base-Z."""
    c, s = math.cos(yaw), math.sin(yaw)
    out = np.empty_like(pts)
    out[:, 0] = x + pts[:, 0] * c - pts[:, 1] * s
    out[:, 1] = y + pts[:, 0] * s + pts[:, 1] * c
    out[:, 2] = pts[:, 2]
    return out


def _pack(ix, iy):
    return (int(ix) << 32) | (int(iy) & 0xFFFFFFFF)


def _unpack(key):
    ix = key >> 32
    iy = key & 0xFFFFFFFF
    if iy >= 0x80000000:
        iy -= 0x100000000
    return ix, iy


def accumulate(grid, pts):
    """Tel (M,3) kaartframe-punten op in grid {key: [sum_h, cnt]}."""
    if len(pts) == 0:
        return
    ix = np.floor(pts[:, 0] / CELL).astype(np.int64)
    iy = np.floor(pts[:, 1] / CELL).astype(np.int64)
    keys = (ix << 32) | (iy & 0xFFFFFFFF)
    uniq, inv = np.unique(keys, return_inverse=True)
    sums = np.bincount(inv, weights=pts[:, 2])
    cnts = np.bincount(inv)
    for k, s, c in zip(uniq.tolist(), sums.tolist(), cnts.tolist()):
        e = grid.get(k)
        if e is None:
            if len(grid) >= MAX_CELLS:
                continue  # ponytail: cap = stil stoppen met nieuwe cellen
            grid[k] = [s, int(c)]
        else:
            e[0] += s
            e[1] += int(c)


def serialize_grid(grid, cell_size):
    """Grid → TGR1 bytes (zie plan-header voor het formaat)."""
    out = bytearray()
    out += b"TGR1"
    out += struct.pack("<d", cell_size)
    out += struct.pack("<i", len(grid))
    for key, (s, c) in grid.items():
        ix, iy = _unpack(key)
        out += struct.pack("<iifI", ix, iy, s / c, c)
    return bytes(out)
```

- [ ] **Step 4: Run — verwacht slagen**

Run: `python3 research/__tests__/test_terrain_scan.py`
Expected: `test_terrain_scan: ALLES OK`

- [ ] **Step 5: Commit**

```bash
PATH="/bin:/usr/bin:$PATH" git add research/terrain_scan.py research/__tests__/test_terrain_scan.py
PATH="/bin:/usr/bin:$PATH" git commit -m "terrain: pure rekenkern grid-accumulator (transform + TGR1)"
```

---

### Task 2: ROS-schil + sessielevenscyclus + upload (maaier)

**Files:**
- Modify: `research/terrain_scan.py` (ROS-deel onder `if __name__ == "__main__":`)
- Create: `research/start_terrain.sh` (env-wrapper)

**Interfaces:**
- Consumes: alle Task-1-functies (exacte signaturen hierboven).
- Produces: daemon die `/userdata/lfi/terrain/session_<unix_ts>.tgr` schrijft en POST naar `http://<http_address>/api/nova-file-server/terrain/uploadTerrainGrid?sn=<SN>` (raw body, `Content-Type: application/octet-stream`) — het endpoint uit Task 5.

Geen unit test mogelijk (ROS + netwerk); de checks zijn een lokale importtest en de live smoke in Task 8.

- [ ] **Step 1: Discovery — server-adres en SN op de maaier**

Run op .244:
```bash
sshpass -p novabot ssh -o ConnectTimeout=5 root@192.168.0.244 \
  "grep -o '\"http_address\"[^,}]*' /userdata/lfi/config/json_config.json; grep -o '\"sn\"[^,}]*' /userdata/lfi/config/json_config.json | head -1"
```
Expected: een `http_address` met het lokale serveradres en de SN `LFIN2230700238`. Gebruik de exacte JSON-sleutels die hier verschijnen in `_read_config()` hieronder (pas aan als de sleutel anders heet, bv. `deviceSn`).

- [ ] **Step 2: ROS-schil schrijven**

Toevoegen aan `research/terrain_scan.py` (onder de rekenkern):

```python
# ── ROS-schil (draait alleen op de maaier) ─────────────────────────────
SESSION_DIR = "/userdata/lfi/terrain"
MAX_SESSION_FILES = 5
FRAME_INTERVAL = 0.5      # s → max 2 fps
POSE_MAX_AGE = 0.5        # s — geen verse pose = frame overslaan
FLUSH_AFTER_IDLE = 120.0  # s zonder ToF-frames terwijl er data is → sessie klaar
UPLOAD_TIMEOUT = 30


def _read_config():
    import json
    with open("/userdata/lfi/config/json_config.json") as f:
        cfg = json.load(f)
    return cfg["http_address"], cfg["sn"]


def _upload(path, http_address, sn):
    import urllib.request
    url = f"http://{http_address}/api/nova-file-server/terrain/uploadTerrainGrid?sn={sn}"
    with open(path, "rb") as f:
        req = urllib.request.Request(
            url, data=f.read(), method="POST",
            headers={"Content-Type": "application/octet-stream"})
    with urllib.request.urlopen(req, timeout=UPLOAD_TIMEOUT) as resp:
        return 200 <= resp.status < 300


def _rotate_sessions():
    import os
    files = sorted(f for f in os.listdir(SESSION_DIR) if f.endswith(".tgr"))
    for f in files[:-MAX_SESSION_FILES]:
        os.remove(os.path.join(SESSION_DIR, f))


def main():
    import os
    import time

    import rclpy
    from rclpy.node import Node
    from nav_msgs.msg import Odometry
    from sensor_msgs.msg import PointCloud2

    os.makedirs(SESSION_DIR, exist_ok=True)
    http_address, sn = _read_config()

    rclpy.init()
    node = Node("terrain_scan")
    st = {"pose": None, "pose_t": 0.0, "grid": {}, "last_frame": 0.0,
          "last_cloud": 0.0, "frames": 0}

    def on_odom(msg):
        p = msg.pose.pose
        st["pose"] = (p.position.x, p.position.y,
                      yaw_from_quat(p.orientation.x, p.orientation.y,
                                    p.orientation.z, p.orientation.w))
        st["pose_t"] = time.time()

    def on_cloud(msg):
        now = time.time()
        st["last_cloud"] = now
        if now - st["last_frame"] < FRAME_INTERVAL:
            return
        if st["pose"] is None or now - st["pose_t"] > POSE_MAX_AGE:
            return
        st["last_frame"] = now
        pts = np.frombuffer(bytes(msg.data), dtype=np.float32).reshape(-1, 4)
        base = cam_to_base(pts)
        x, y, yaw = st["pose"]
        accumulate(st["grid"], base_to_map(base, x, y, yaw))
        st["frames"] += 1

    def flush():
        if not st["grid"]:
            return
        path = os.path.join(SESSION_DIR, f"session_{int(time.time())}.tgr")
        with open(path, "wb") as f:
            f.write(serialize_grid(st["grid"], CELL))
        node.get_logger().info(
            f"terrain: sessie {path} ({len(st['grid'])} cellen, {st['frames']} frames)")
        st["grid"] = {}
        st["frames"] = 0
        _rotate_sessions()
        # upload alles wat er nog ligt (incl. eerdere gefaalde uploads)
        for fn in sorted(os.listdir(SESSION_DIR)):
            if not fn.endswith(".tgr"):
                continue
            fp = os.path.join(SESSION_DIR, fn)
            try:
                if _upload(fp, http_address, sn):
                    os.remove(fp)
                    node.get_logger().info(f"terrain: geüpload {fn}")
            except Exception as e:  # noqa: BLE001 — offline is normaal, later opnieuw
                node.get_logger().warn(f"terrain: upload {fn} faalde: {e}")
                break

    node.create_subscription(Odometry, "/robot_combination_localization/odom", on_odom, 10)
    node.create_subscription(PointCloud2, "/camera/tof/point_cloud", on_cloud, 5)

    while rclpy.ok():
        rclpy.spin_once(node, timeout_sec=2.0)
        if st["grid"] and time.time() - st["last_cloud"] > FLUSH_AFTER_IDLE:
            flush()


if __name__ == "__main__":
    main()
```

`research/start_terrain.sh`:

```bash
#!/bin/bash
# Start terrain_scan.py met ROS-env (NOOIT kaal python3 — RtkRelay-les).
# Kill-switch: pkill -f terrain_scan.py
source /opt/ros/galactic/setup.bash
source /root/novabot/install/setup.bash
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export ROS_LOCALHOST_ONLY=1
exec nice -n 10 python3 /root/novabot/scripts/terrain_scan.py
```

- [ ] **Step 3: Importtest lokaal (rekenkern onaangetast, geen ROS-start)**

Run: `python3 research/__tests__/test_terrain_scan.py`
Expected: nog steeds `ALLES OK` (main() is gegate op `__main__`; rclpy wordt pas in main geïmporteerd).

- [ ] **Step 4: Commit**

```bash
PATH="/bin:/usr/bin:$PATH" git add research/terrain_scan.py research/start_terrain.sh
PATH="/bin:/usr/bin:$PATH" git commit -m "terrain: ROS-schil met sessieflush + upload naar cloud-api"
```

---

### Task 3: Server — TGR1/TGM1 parse & merge (pure service)

**Files:**
- Create: `server/src/services/terrainGrid.ts`
- Test: `server/src/__tests__/services/terrainGrid.test.ts`

**Interfaces:**
- Produces (Task 5/6 gebruiken exact):
  - `parseTgr1(buf: Buffer): { cellSize: number; cells: Map<string, { mean: number; cnt: number }> }` — key `"ix,iy"`; gooit `Error('bad magic')` bij fout formaat
  - `mergeIntoTgm1(existing: Buffer | null, session: Buffer): Buffer` — TGM1 in/uit; per cel sessie-mean toevoegen aan max 7 slots (oudste eruit), cnt optellen
  - `tgm1ToDisplayTgr1(tgm: Buffer): Buffer` — per cel mediaan van de slots → TGR1 voor de viewer
  - `tgm1CellCount(tgm: Buffer): number`

- [ ] **Step 1: Schrijf de falende test**

`server/src/__tests__/services/terrainGrid.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseTgr1, mergeIntoTgm1, tgm1ToDisplayTgr1, tgm1CellCount } from '../../services/terrainGrid.js';

function tgr1(cells: Array<[number, number, number, number]>, cellSize = 0.05): Buffer {
  const buf = Buffer.alloc(16 + cells.length * 16);
  buf.write('TGR1', 0, 'ascii');
  buf.writeDoubleLE(cellSize, 4);
  buf.writeInt32LE(cells.length, 12);
  cells.forEach(([ix, iy, mean, cnt], i) => {
    const o = 16 + i * 16;
    buf.writeInt32LE(ix, o); buf.writeInt32LE(iy, o + 4);
    buf.writeFloatLE(mean, o + 8); buf.writeUInt32LE(cnt, o + 12);
  });
  return buf;
}

describe('terrainGrid', () => {
  it('parseTgr1 round-trip incl. negatieve indices', () => {
    const p = parseTgr1(tgr1([[2, 0, 0.3, 1], [-2, -3, 0.5, 4]]));
    expect(p.cellSize).toBe(0.05);
    expect(p.cells.get('2,0')).toEqual({ mean: expect.closeTo(0.3, 5), cnt: 1 });
    expect(p.cells.get('-2,-3')).toEqual({ mean: expect.closeTo(0.5, 5), cnt: 4 });
  });

  it('parseTgr1 weigert verkeerde magic', () => {
    expect(() => parseTgr1(Buffer.from('NOPE0000'))).toThrow(/bad magic/);
  });

  it('merge: nieuwe cel, tweede sessie, mediaan in display', () => {
    let tgm = mergeIntoTgm1(null, tgr1([[0, 0, 0.10, 2]]));
    tgm = mergeIntoTgm1(tgm, tgr1([[0, 0, 0.30, 2]]));
    tgm = mergeIntoTgm1(tgm, tgr1([[0, 0, 0.20, 2]]));
    expect(tgm1CellCount(tgm)).toBe(1);
    const disp = parseTgr1(tgm1ToDisplayTgr1(tgm));
    expect(disp.cells.get('0,0')!.mean).toBeCloseTo(0.20, 5); // mediaan van .1/.3/.2
    expect(disp.cells.get('0,0')!.cnt).toBe(6);
  });

  it('merge: >7 sessies laat de oudste vallen', () => {
    let tgm: Buffer | null = null;
    for (let i = 1; i <= 9; i++) tgm = mergeIntoTgm1(tgm, tgr1([[1, 1, i / 10, 1]]));
    const disp = parseTgr1(tgm1ToDisplayTgr1(tgm!));
    // slots = sessies 3..9 → mediaan 0.6
    expect(disp.cells.get('1,1')!.mean).toBeCloseTo(0.6, 5);
  });
});
```

- [ ] **Step 2: Run — verwacht falen**

Run: `cd server && npx vitest run src/__tests__/services/terrainGrid.test.ts`
Expected: FAIL — module bestaat niet.

- [ ] **Step 3: Implementeer**

`server/src/services/terrainGrid.ts`:

```ts
/**
 * TGR1 (sessie-grid van de maaier) en TGM1 (persistent merge-bestand).
 * Formaten: zie docs/superpowers/plans/2026-07-17-terrain-3d-map.md.
 * Pure Buffer-functies — geen fs/DB, volledig unit-testbaar.
 */

const TGR_HEADER = 16;
const TGR_CELL = 16;
const TGM_HEADER = 16;
const TGM_CELL = 41;
const SLOTS = 7;

export interface Tgr1 { cellSize: number; cells: Map<string, { mean: number; cnt: number }> }

export function parseTgr1(buf: Buffer): Tgr1 {
  if (buf.length < TGR_HEADER || buf.toString('ascii', 0, 4) !== 'TGR1') throw new Error('bad magic');
  const cellSize = buf.readDoubleLE(4);
  const n = buf.readInt32LE(12);
  if (buf.length < TGR_HEADER + n * TGR_CELL) throw new Error('truncated TGR1');
  const cells = new Map<string, { mean: number; cnt: number }>();
  for (let i = 0; i < n; i++) {
    const o = TGR_HEADER + i * TGR_CELL;
    cells.set(`${buf.readInt32LE(o)},${buf.readInt32LE(o + 4)}`,
      { mean: buf.readFloatLE(o + 8), cnt: buf.readUInt32LE(o + 12) });
  }
  return { cellSize, cells };
}

interface TgmCell { k: number; samples: number[]; cnt: number }

function parseTgm1(buf: Buffer): { cellSize: number; cells: Map<string, TgmCell> } {
  if (buf.toString('ascii', 0, 4) !== 'TGM1') throw new Error('bad magic');
  const cellSize = buf.readDoubleLE(4);
  const n = buf.readInt32LE(12);
  const cells = new Map<string, TgmCell>();
  for (let i = 0; i < n; i++) {
    const o = TGM_HEADER + i * TGM_CELL;
    const k = buf.readUInt8(o + 8);
    const samples: number[] = [];
    for (let s = 0; s < k; s++) samples.push(buf.readFloatLE(o + 9 + s * 4));
    cells.set(`${buf.readInt32LE(o)},${buf.readInt32LE(o + 4)}`,
      { k, samples, cnt: buf.readUInt32LE(o + 37) });
  }
  return { cellSize, cells };
}

function writeTgm1(cellSize: number, cells: Map<string, TgmCell>): Buffer {
  const buf = Buffer.alloc(TGM_HEADER + cells.size * TGM_CELL);
  buf.write('TGM1', 0, 'ascii');
  buf.writeDoubleLE(cellSize, 4);
  buf.writeInt32LE(cells.size, 12);
  let i = 0;
  for (const [key, c] of cells) {
    const o = TGM_HEADER + i++ * TGM_CELL;
    const [ix, iy] = key.split(',').map(Number);
    buf.writeInt32LE(ix, o); buf.writeInt32LE(iy, o + 4);
    buf.writeUInt8(c.samples.length, o + 8);
    c.samples.forEach((v, s) => buf.writeFloatLE(v, o + 9 + s * 4));
    buf.writeUInt32LE(c.cnt, o + 37);
  }
  return buf;
}

export function mergeIntoTgm1(existing: Buffer | null, session: Buffer): Buffer {
  const s = parseTgr1(session);
  const base = existing ? parseTgm1(existing) : { cellSize: s.cellSize, cells: new Map<string, TgmCell>() };
  for (const [key, cell] of s.cells) {
    const cur = base.cells.get(key) ?? { k: 0, samples: [], cnt: 0 };
    cur.samples.push(cell.mean);
    if (cur.samples.length > SLOTS) cur.samples.shift(); // oudste sessie eruit
    cur.cnt += cell.cnt;
    base.cells.set(key, cur);
  }
  return writeTgm1(base.cellSize, base.cells);
}

export function tgm1CellCount(tgm: Buffer): number {
  return tgm.readInt32LE(12);
}

export function tgm1ToDisplayTgr1(tgm: Buffer): Buffer {
  const { cellSize, cells } = parseTgm1(tgm);
  const out = Buffer.alloc(TGR_HEADER + cells.size * TGR_CELL);
  out.write('TGR1', 0, 'ascii');
  out.writeDoubleLE(cellSize, 4);
  out.writeInt32LE(cells.size, 12);
  let i = 0;
  for (const [key, c] of cells) {
    const o = TGR_HEADER + i++ * TGR_CELL;
    const [ix, iy] = key.split(',').map(Number);
    const sorted = [...c.samples].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    out.writeInt32LE(ix, o); out.writeInt32LE(iy, o + 4);
    out.writeFloatLE(median, o + 8);
    out.writeUInt32LE(c.cnt, o + 12);
  }
  return out;
}
```

- [ ] **Step 4: Run — verwacht slagen**

Run: `cd server && npx vitest run src/__tests__/services/terrainGrid.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
PATH="/bin:/usr/bin:$PATH" git add server/src/services/terrainGrid.ts server/src/__tests__/services/terrainGrid.test.ts
PATH="/bin:/usr/bin:$PATH" git commit -m "terrain: TGR1/TGM1 parse + merge service"
```

---

### Task 4: Server — DB-tabel + repository

**Files:**
- Modify: `server/src/db/database.ts` (migratieblok, na het `skip_date`-blok)
- Create: `server/src/db/repositories/terrainGrids.ts`
- Modify: `server/src/db/repositories/index.ts` (export toevoegen)
- Test: `server/src/__tests__/repositories/terrainGrids.test.ts`

**Interfaces:**
- Produces: `terrainGridRepo.upsertMeta({ mower_sn, cell_size, cells, sessions_delta })`, `terrainGridRepo.findBySn(sn): TerrainGridRow | undefined` met `TerrainGridRow = { mower_sn: string; cell_size: number; sessions: number; cells: number; updated_at: string }`

- [ ] **Step 1: Schrijf de falende test**

`server/src/__tests__/repositories/terrainGrids.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { terrainGridRepo } from '../../db/repositories/index.js';

describe('terrainGridRepo', () => {
  it('upsert maakt aan en telt sessies op', () => {
    terrainGridRepo.upsertMeta({ mower_sn: 'LFIN2230700238', cell_size: 0.05, cells: 100, sessions_delta: 1 });
    terrainGridRepo.upsertMeta({ mower_sn: 'LFIN2230700238', cell_size: 0.05, cells: 250, sessions_delta: 1 });
    const row = terrainGridRepo.findBySn('LFIN2230700238')!;
    expect(row.sessions).toBe(2);
    expect(row.cells).toBe(250);
    expect(row.cell_size).toBe(0.05);
  });

  it('findBySn onbekend → undefined', () => {
    expect(terrainGridRepo.findBySn('LFIN0000000000')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — verwacht falen**

Run: `cd server && npx vitest run src/__tests__/repositories/terrainGrids.test.ts`
Expected: FAIL — repo bestaat niet.

- [ ] **Step 3: Migratie + repository**

In `server/src/db/database.ts`, direct na het `skip_date`-migratieblok:

```ts
  // 3D-terreinkaart: metadata per maaier; het grid zelf staat als TGM1-
  // bestand op disk (STORAGE_PATH/terrain/<sn>.tgm).
  db.exec(`
    CREATE TABLE IF NOT EXISTS terrain_grids (
      mower_sn   TEXT PRIMARY KEY,
      cell_size  REAL NOT NULL DEFAULT 0.05,
      sessions   INTEGER NOT NULL DEFAULT 0,
      cells      INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
```

`server/src/db/repositories/terrainGrids.ts`:

```ts
import { db } from '../database.js';

export interface TerrainGridRow {
  mower_sn: string;
  cell_size: number;
  sessions: number;
  cells: number;
  updated_at: string;
}

class TerrainGridRepository {
  private _find = db.prepare('SELECT * FROM terrain_grids WHERE mower_sn = ?');
  private _upsert = db.prepare(`
    INSERT INTO terrain_grids (mower_sn, cell_size, sessions, cells, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mower_sn) DO UPDATE SET
      cell_size = excluded.cell_size,
      sessions  = sessions + ?,
      cells     = excluded.cells,
      updated_at = datetime('now')
  `);

  findBySn(sn: string): TerrainGridRow | undefined {
    return this._find.get(sn) as TerrainGridRow | undefined;
  }

  upsertMeta(d: { mower_sn: string; cell_size: number; cells: number; sessions_delta: number }): void {
    this._upsert.run(d.mower_sn, d.cell_size, d.sessions_delta, d.cells, d.sessions_delta);
  }
}

export const terrainGridRepo = new TerrainGridRepository();
```

In `server/src/db/repositories/index.ts` de export toevoegen naast de bestaande repo-exports:

```ts
export { terrainGridRepo } from './terrainGrids.js';
```

- [ ] **Step 4: Run — verwacht slagen**

Run: `cd server && npx vitest run src/__tests__/repositories/terrainGrids.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
PATH="/bin:/usr/bin:$PATH" git add server/src/db/database.ts server/src/db/repositories/terrainGrids.ts server/src/db/repositories/index.ts server/src/__tests__/repositories/terrainGrids.test.ts
PATH="/bin:/usr/bin:$PATH" git commit -m "terrain: terrain_grids tabel + repository"
```

---

### Task 5: Server — cloud-api upload-endpoint

**Files:**
- Create: `server/src/cloud-api/routes/terrain.ts`
- Modify: `server/src/cloud-api/index.ts` (router registreren)
- Modify: `server/src/cloud-api/CHANGELOG.md` (verplicht — pre-commit guard)
- Test: `server/src/cloud-api/__tests__/contract/terrain.upload.test.ts`

**Interfaces:**
- Consumes: `parseTgr1`, `mergeIntoTgm1`, `tgm1CellCount` (Task 3), `terrainGridRepo` (Task 4).
- Produces: `POST /api/nova-file-server/terrain/uploadTerrainGrid?sn=<SN>` — raw octet-stream body (max 8 MB); antwoordt `{code:200,...}` (het `ok(null)`-patroon van de cloud-api). Slaat merged TGM1 op als `STORAGE_PATH/terrain/<sn>.tgm`.

- [ ] **Step 1: Schrijf de falende contract-test**

`server/src/cloud-api/__tests__/contract/terrain.upload.test.ts` (volg het supertest-patroon van de bestaande contract-tests, bv. `map.uploadPreservesAlias.test.ts` voor de app-setup):

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { buildTestApp } from '../helpers.js'; // zelfde helper als de andere contract-tests; check exacte naam in die dir
import { terrainGridRepo } from '../../../db/repositories/index.js';

function tgr1Cells(cells: Array<[number, number, number, number]>): Buffer {
  const buf = Buffer.alloc(16 + cells.length * 16);
  buf.write('TGR1', 0, 'ascii');
  buf.writeDoubleLE(0.05, 4);
  buf.writeInt32LE(cells.length, 12);
  cells.forEach(([ix, iy, mean, cnt], i) => {
    const o = 16 + i * 16;
    buf.writeInt32LE(ix, o); buf.writeInt32LE(iy, o + 4);
    buf.writeFloatLE(mean, o + 8); buf.writeUInt32LE(cnt, o + 12);
  });
  return buf;
}

describe('POST /api/nova-file-server/terrain/uploadTerrainGrid', () => {
  it('accepteert TGR1, merget en registreert metadata', async () => {
    const app = buildTestApp();
    const res = await request(app)
      .post('/api/nova-file-server/terrain/uploadTerrainGrid?sn=LFIN2230700238')
      .set('Content-Type', 'application/octet-stream')
      .send(tgr1Cells([[0, 0, 0.1, 3], [5, -2, 0.4, 1]]));
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(200);
    const row = terrainGridRepo.findBySn('LFIN2230700238')!;
    expect(row.sessions).toBeGreaterThanOrEqual(1);
    expect(row.cells).toBe(2);
    const tgm = path.join(process.env.STORAGE_PATH ?? './storage', 'terrain', 'LFIN2230700238.tgm');
    expect(fs.existsSync(tgm)).toBe(true);
  });

  it('weigert kapotte payload met 400', async () => {
    const app = buildTestApp();
    const res = await request(app)
      .post('/api/nova-file-server/terrain/uploadTerrainGrid?sn=LFIN2230700238')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('GARBAGE'));
    expect(res.status).toBe(400);
  });

  it('weigert ontbrekende sn met 400', async () => {
    const app = buildTestApp();
    const res = await request(app)
      .post('/api/nova-file-server/terrain/uploadTerrainGrid')
      .set('Content-Type', 'application/octet-stream')
      .send(tgr1Cells([[0, 0, 0.1, 1]]));
    expect(res.status).toBe(400);
  });
});
```

Let op: check eerst hoe de bestaande contract-tests hun Express-app bouwen (`ls server/src/cloud-api/__tests__/contract/` en lees er één) en gebruik exact diezelfde helper/opzet i.p.v. `buildTestApp` als die anders heet.

- [ ] **Step 2: Run — verwacht falen**

Run: `cd server && npx vitest run src/cloud-api/__tests__/contract/terrain.upload.test.ts`
Expected: FAIL — route bestaat niet (404).

- [ ] **Step 3: Implementeer de route**

`server/src/cloud-api/routes/terrain.ts`:

```ts
/**
 * Terrain-grid uploads van de maaier (terrain_scan.py).
 * POST /api/nova-file-server/terrain/uploadTerrainGrid?sn=<SN>
 * Body: raw TGR1 (application/octet-stream, max 8 MB).
 * Merget direct in STORAGE_PATH/terrain/<sn>.tgm en werkt terrain_grids bij.
 */
import express, { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { ok, fail } from '../../types/index.js';
import { parseTgr1, mergeIntoTgm1, tgm1CellCount } from '../../services/terrainGrid.js';
import { terrainGridRepo } from '../../db/repositories/index.js';

const TERRAIN_DIR = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain');

export const terrainRouter = Router();

terrainRouter.post(
  '/uploadTerrainGrid',
  express.raw({ type: 'application/octet-stream', limit: '8mb' }),
  (req: Request, res: Response) => {
    const sn = String(req.query.sn ?? '');
    if (!/^LFI[A-Z]\d+$/.test(sn)) { res.status(400).json(fail('sn required', 400)); return; }
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length < 16) { res.status(400).json(fail('empty body', 400)); return; }

    let session;
    try { session = parseTgr1(body); }
    catch { res.status(400).json(fail('invalid TGR1', 400)); return; }

    fs.mkdirSync(TERRAIN_DIR, { recursive: true });
    const tgmPath = path.join(TERRAIN_DIR, `${sn}.tgm`);
    const existing = fs.existsSync(tgmPath) ? fs.readFileSync(tgmPath) : null;
    const merged = mergeIntoTgm1(existing, body);
    fs.writeFileSync(tgmPath, merged);

    terrainGridRepo.upsertMeta({
      mower_sn: sn,
      cell_size: session.cellSize,
      cells: tgm1CellCount(merged),
      sessions_delta: 1,
    });
    console.log(`[TERRAIN] sessie gemerged voor ${sn}: ${session.cells.size} sessie-cellen → ${tgm1CellCount(merged)} totaal`);
    res.json(ok(null));
  },
);
```

In `server/src/cloud-api/index.ts` (naast de andere routers):

```ts
import { terrainRouter } from './routes/terrain.js';
// ... bij de app.use-regels:
app.use('/api/nova-file-server/terrain', terrainRouter);
```

Voeg bovenaan `server/src/cloud-api/CHANGELOG.md` een entry toe:

```markdown
## 2026-07-17 — terrain: uploadTerrainGrid endpoint

- Nieuw: `POST /api/nova-file-server/terrain/uploadTerrainGrid?sn=` — raw
  TGR1 sessie-grid van terrain_scan.py; merge naar TGM1 op disk +
  terrain_grids metadata. Zie spec 2026-07-17-terrain-3d-map-design.md.
```

- [ ] **Step 4: Run — verwacht slagen**

Run: `cd server && npx vitest run src/cloud-api/__tests__/contract/terrain.upload.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Volledige suite + commit**

Run: `cd server && npx tsc --noEmit && npx vitest run --silent`
Expected: alles groen.

```bash
PATH="/bin:/usr/bin:$PATH" git add server/src/cloud-api/routes/terrain.ts server/src/cloud-api/index.ts server/src/cloud-api/CHANGELOG.md server/src/cloud-api/__tests__/contract/terrain.upload.test.ts
PATH="/bin:/usr/bin:$PATH" git commit -m "terrain: cloud-api uploadTerrainGrid endpoint + merge"
```

---

### Task 6: Server — dashboard GET-endpoint (display-grid)

**Files:**
- Modify: `server/src/routes/dashboard.ts` (één GET-route, bij de andere per-SN GET-routes)
- Test: `server/src/__tests__/routes/terrainGet.test.ts`

**Interfaces:**
- Consumes: `tgm1ToDisplayTgr1` (Task 3), `terrainGridRepo` (Task 4).
- Produces: `GET /api/dashboard/terrain/:sn` → gzip TGR1 (`Content-Type: application/octet-stream`, `Content-Encoding: gzip`) of 404 als er geen terrein is. De dashboard-viewer (Task 7) consumeert dit.

- [ ] **Step 1: Schrijf de falende test**

`server/src/__tests__/routes/terrainGet.test.ts` (volg de opzet van een bestaande dashboard-route-test in dezelfde dir voor de app/bootstrap):

```ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { buildDashboardTestApp } from './helpers.js'; // check exacte helper in deze dir, bv. wat adminPageAuth.test.ts gebruikt
import { mergeIntoTgm1 } from '../../services/terrainGrid.js';

function tgr1(cells: Array<[number, number, number, number]>): Buffer {
  const buf = Buffer.alloc(16 + cells.length * 16);
  buf.write('TGR1', 0, 'ascii');
  buf.writeDoubleLE(0.05, 4);
  buf.writeInt32LE(cells.length, 12);
  cells.forEach(([ix, iy, mean, cnt], i) => {
    const o = 16 + i * 16;
    buf.writeInt32LE(ix, o); buf.writeInt32LE(iy, o + 4);
    buf.writeFloatLE(mean, o + 8); buf.writeUInt32LE(cnt, o + 12);
  });
  return buf;
}

describe('GET /api/dashboard/terrain/:sn', () => {
  it('404 zonder terrein', async () => {
    const app = buildDashboardTestApp();
    const res = await request(app).get('/api/dashboard/terrain/LFIN0000000001');
    expect(res.status).toBe(404);
  });

  it('levert gzip TGR1 als het TGM-bestand bestaat', async () => {
    const dir = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'LFIN2230700238.tgm'), mergeIntoTgm1(null, tgr1([[0, 0, 0.2, 5]])));
    const app = buildDashboardTestApp();
    const res = await request(app)
      .get('/api/dashboard/terrain/LFIN2230700238')
      .buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    const raw = zlib.gunzipSync(res.body as Buffer);
    expect(raw.toString('ascii', 0, 4)).toBe('TGR1');
    expect(raw.readInt32LE(12)).toBe(1);
  });
});
```

- [ ] **Step 2: Run — verwacht falen**

Run: `cd server && npx vitest run src/__tests__/routes/terrainGet.test.ts`
Expected: FAIL (404 op de tweede test / route bestaat niet).

- [ ] **Step 3: Implementeer de route**

In `server/src/routes/dashboard.ts`, bij de andere per-SN GET-routes:

```ts
// GET /api/dashboard/terrain/:sn — display-hoogtegrid (gzip TGR1) voor de
// 3D-terreinviewer. 404 zolang er nog geen enkele sessie geüpload is.
dashboardRouter.get('/terrain/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const tgmPath = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain', `${sn}.tgm`);
  if (!fs.existsSync(tgmPath)) {
    res.status(404).json({ error: 'geen terrein voor deze maaier' });
    return;
  }
  const display = tgm1ToDisplayTgr1(fs.readFileSync(tgmPath));
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Encoding', 'gzip');
  res.send(zlib.gzipSync(display));
});
```

Imports bovenin dashboard.ts aanvullen (alleen wat nog ontbreekt): `zlib` en `tgm1ToDisplayTgr1` uit `../services/terrainGrid.js` (fs/path zijn er al).

- [ ] **Step 4: Run — verwacht slagen**

Run: `cd server && npx vitest run src/__tests__/routes/terrainGet.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
PATH="/bin:/usr/bin:$PATH" git add server/src/routes/dashboard.ts server/src/__tests__/routes/terrainGet.test.ts
PATH="/bin:/usr/bin:$PATH" git commit -m "terrain: dashboard GET display-grid (gzip TGR1)"
```

---

### Task 7: Dashboard — 3D-terreinviewer

**Files:**
- Modify: `dashboard/package.json` (dependency `three` + `@types/three`)
- Create: `dashboard/src/utils/terrainParser.ts`
- Create: `dashboard/src/pages/TerrainPage.tsx`
- Modify: de tab/navigatie-registratie (discovery in Step 1)

**Interfaces:**
- Consumes: `GET /api/dashboard/terrain/:sn` (Task 6; browser gunzipt transparant door de Content-Encoding header — fetch levert de rauwe TGR1-bytes).
- Produces: `parseTerrain(buf: ArrayBuffer): { cellSize: number; ix: Int32Array; iy: Int32Array; h: Float32Array }` en een lazy-loaded `TerrainPage`.

- [ ] **Step 1: Discovery — waar pages geregistreerd worden**

Run: `grep -rn "MapTab\|SchedulePage" dashboard/src/shell dashboard/src/App* dashboard/src 2>/dev/null | grep -v "pages/" | head`
Expected: de plek (router/tabbar) waar `MapTab`/`SchedulePage` gemount worden. Registreer `TerrainPage` daar op identieke wijze, als `React.lazy(() => import('./pages/TerrainPage'))` met een berg-icoon (lucide `Mountain`).

- [ ] **Step 2: Dependency**

Run: `cd dashboard && npm install three @types/three`
Expected: beide in package.json; `npx tsc --noEmit` blijft schoon.

- [ ] **Step 3: Parser + pagina schrijven**

`dashboard/src/utils/terrainParser.ts`:

```ts
/** Parse het TGR1 display-grid van GET /api/dashboard/terrain/:sn. */
export interface TerrainData {
  cellSize: number;
  ix: Int32Array;
  iy: Int32Array;
  h: Float32Array;
  cnt: Uint32Array;
}

export function parseTerrain(buf: ArrayBuffer): TerrainData {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'TGR1') throw new Error('bad magic');
  const cellSize = dv.getFloat64(4, true);
  const n = dv.getInt32(12, true);
  const ix = new Int32Array(n), iy = new Int32Array(n);
  const h = new Float32Array(n); const cnt = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const o = 16 + i * 16;
    ix[i] = dv.getInt32(o, true);
    iy[i] = dv.getInt32(o + 4, true);
    h[i] = dv.getFloat32(o + 8, true);
    cnt[i] = dv.getUint32(o + 12, true);
  }
  return { cellSize, ix, iy, h, cnt };
}
```

`dashboard/src/pages/TerrainPage.tsx` — kern (mesh-opbouw uit sparse cellen; volledige component):

```tsx
/**
 * 3D-terreinviewer: heightmap-mesh uit het TGR1 display-grid, hoogte-
 * shading, orbit-controls, werk-polygonen als overlay-lijnen.
 * Lazy-loaded — three.js blijft buiten de hoofdbundle.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { parseTerrain, type TerrainData } from '../utils/terrainParser';
import { fetchMaps, BASE, apiFetch } from '../api/client';
import type { MapData } from '../types';

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
      const res = await apiFetch(`${BASE}/terrain/${encodeURIComponent(sn)}`);
      if (res.status === 404) { setStatus('empty'); return; }
      if (!res.ok) { setStatus('error'); return; }
      const terrain = parseTerrain(await res.arrayBuffer());
      const maps: MapData[] = await fetchMaps(sn).catch(() => []);
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
      for (const m of maps.filter(m => m.mapType === 'work' && m.points?.length)) {
        const pts = m.points.map(p => new THREE.Vector3(p.x, p.y, 0.05));
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
```

Let op: check de exacte export-namen in `dashboard/src/api/client.ts` (`BASE`, `apiFetch`, `fetchMaps`) en `MapData`-velden (`mapType`, `points`) en pas de imports aan op wat er werkelijk staat.

- [ ] **Step 4: Registreer de pagina + typecheck + build**

Registreer `TerrainPage` op de plek uit Step 1 (lazy import + tab/route met `Mountain`-icoon en label via i18n-key `terrain.title` = "Terrein" in de vier locale-JSONs).

Run: `cd dashboard && npx tsc --noEmit && npm run build`
Expected: schoon + build slaagt.

- [ ] **Step 5: Handmatige verificatie + commit**

Met de server lokaal draaiend (`cd server && npm run dev`) en een `.tgm` aanwezig (staat er na Task 8's eerste maaibeurt; voor een snelle lokale check kan het contract-test-TGM-bestand uit `storage/terrain/` gekopieerd worden): open het dashboard, Terrein-tab → mesh zichtbaar, orbit werkt, polygon-overlay klopt qua positie met de 2D-kaart.

```bash
PATH="/bin:/usr/bin:$PATH" git add dashboard/package.json dashboard/package-lock.json dashboard/src/utils/terrainParser.ts dashboard/src/pages/TerrainPage.tsx dashboard/src/i18n/locales/*.json <registratie-bestand uit Step 1>
PATH="/bin:/usr/bin:$PATH" git commit -m "terrain: 3D-viewer in dashboard (three.js heightmap)"
```

---

### Task 8: Deploy naar .244 + end-to-end smoke

**Files:**
- Modify: `research/build_custom_firmware.sh` (terrain-sectie zodat OTA het script niet wist)

**Interfaces:**
- Consumes: alles hiervoor. Geen nieuwe interfaces.

- [ ] **Step 1: Discovery — hoe extended_commands autostart en in de build zit**

Run:
```bash
grep -n "extended_commands" research/build_custom_firmware.sh | head
sshpass -p novabot ssh -o ConnectTimeout=5 root@192.168.0.244 "grep -rn 'start_ext\|extended_commands' /root/*.sh /etc/rc.local 2>/dev/null | head"
```
Expected: de build-sectie die extended_commands.py in de .deb stopt en het boot-mechanisme dat `start_ext.sh` aanroept. Spiegel BEIDE voor `terrain_scan.py` + `start_terrain.sh` (zelfde dir `/root/novabot/scripts/`, zelfde autostart-plek).

- [ ] **Step 2: Deploy naar .244 (zonder firmware-rebuild, voor de smoke)**

```bash
sshpass -p novabot scp -o StrictHostKeyChecking=no research/terrain_scan.py research/start_terrain.sh root@192.168.0.244:/root/novabot/scripts/
sshpass -p novabot ssh -o ConnectTimeout=5 root@192.168.0.244 "chmod +x /root/novabot/scripts/start_terrain.sh && setsid nohup /root/novabot/scripts/start_terrain.sh > /tmp/terrain_scan.log 2>&1 < /dev/null & sleep 2; pgrep -af terrain_scan"
```
Expected: één `python3 /root/novabot/scripts/terrain_scan.py` proces. (De ssh-sessie kan blijven hangen door setsid — afbreken is OK, daarna met een verse ssh `pgrep -af terrain_scan` verifiëren; dat zagen we bij de fase-0 probe ook.)

- [ ] **Step 3: Smoke tijdens een maaibeurt**

Vraag Ramon om .244 te laten maaien (of wacht op het schema). Daarna:

```bash
sshpass -p novabot ssh root@192.168.0.244 "tail -5 /tmp/terrain_scan.log; ls -la /userdata/lfi/terrain/ 2>/dev/null"
```
Expected: `terrain: sessie ... (N cellen, M frames)` gevolgd door `terrain: geüpload session_<ts>.tgr`, en een lege sessie-dir (upload gelukt). Op de server:

```bash
curl -s http://192.168.0.247:8080/api/dashboard/terrain/LFIN2230700238 --output /tmp/terrain.bin -w '%{http_code} %{size_download}\n'
```
Expected: `200` met een payload > 1 kB. NB: dit werkt pas op .247 ná een beta-release; test eerst tegen een lokaal draaiende dev-server als de maaier via DNS daarheen wijst, of doe de smoke pas na de release-stap. Let op de mDNS-kaping-regel: geen lokale container op het maaier-LAN laten draaien buiten deze test om.

- [ ] **Step 4: Viewer-check**

Dashboard openen tegen de server die de upload ontving → Terrein-tab voor LFIN2230700238 toont de gemaaide stroken als terrein (dekking volgt het maaipatroon; gaten zijn normaal na één beurt).

- [ ] **Step 5: build_custom_firmware.sh sectie + commit**

Voeg de terrain-sectie toe (gespiegeld aan de extended_commands-sectie uit Step 1), run de test-suites nog één keer en commit:

```bash
python3 research/__tests__/test_terrain_scan.py
cd server && npx tsc --noEmit && npx vitest run --silent && cd ..
PATH="/bin:/usr/bin:$PATH" git add research/build_custom_firmware.sh
PATH="/bin:/usr/bin:$PATH" git commit -m "terrain: terrain_scan meebakken in custom firmware build"
```

---

## Buiten dit plan (bewust)

- Release naar prod (.247) — aparte beslissing van Ramon (`release-beta.sh`), niet automatisch.
- RGB-kleur, app-viewer, object-clusters, glTF-export — spec-sectie "latere upgrades".
- App-kant toont geen terrein in v1.
