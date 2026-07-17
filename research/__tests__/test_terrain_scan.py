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

# hoogte-outliers: binnen dieptebereik maar buiten [HEIGHT_MIN, HEIGHT_MAX]
for p_bad in ([1.8, 0.0, 1.6], [1.8, 0.0, -0.4]):   # 1.6 > 1.5 en -0.4 < -0.3
    p_c_bad = R.T @ (np.array(p_bad) - np.array([0, 0, ts.CAM_HEIGHT]))
    assert ts.RANGE_MIN <= p_c_bad[2] <= ts.RANGE_MAX  # bewijs: allén hoogte filtert
    got = ts.cam_to_base(np.array([[p_c_bad[0], p_c_bad[1], p_c_bad[2], 0.9]], dtype=np.float32))
    assert len(got) == 0, (p_bad, got)

# ── base_to_map: 90° yaw ──
m = ts.base_to_map(np.array([[0.8, 0.2, 0.05]]), 2.0, 3.0, math.pi / 2)
assert np.allclose(m[0], [2.0 - 0.2, 3.0 + 0.8, 0.05], atol=1e-6), m[0]

# ── yaw_from_quat: 90° om z ──
q = (0.0, 0.0, math.sin(math.pi / 4), math.cos(math.pi / 4))
assert abs(ts.yaw_from_quat(*q) - math.pi / 2) < 1e-6

# ── MAX_CELLS-cap: bestaande cellen blijven tellen, nieuwe cellen worden stil genegeerd ──
old_cap = ts.MAX_CELLS
ts.MAX_CELLS = 1
grid3 = {}
ts.accumulate(grid3, np.array([[0.02, 0.02, 0.10]]))          # cel 1 → past
ts.accumulate(grid3, np.array([[0.52, 0.52, 0.20]]))          # nieuwe cel → geweigerd (cap)
ts.accumulate(grid3, np.array([[0.03, 0.03, 0.30]]))          # bestaande cel → telt bij
assert len(grid3) == 1, grid3
assert list(grid3.values())[0][1] == 2
ts.MAX_CELLS = old_cap

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
