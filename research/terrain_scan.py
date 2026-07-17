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
