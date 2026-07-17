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


def cam_to_base_mask(pts):
    """Boolean-masker van cam_to_base's filters, zodat een aanroeper parallelle
    arrays (labels) synchroon kan uitdunnen."""
    ok = (pts[:, 3] >= CONF_MIN) & np.isfinite(pts[:, 2]) \
        & (pts[:, 2] >= RANGE_MIN) & (pts[:, 2] <= RANGE_MAX)
    base = pts[:, 0:1] * _XC + pts[:, 1:2] * _YC + pts[:, 2:3] * _ZC + _T
    ok &= (base[:, 2] >= HEIGHT_MIN) & (base[:, 2] <= HEIGHT_MAX)
    return ok


def cam_to_base(pts):
    """(N,4) cam-optical x/y/z/conf → (M,3) base-frame, gefilterd."""
    ok = cam_to_base_mask(pts)
    p = pts[ok, :3].astype(np.float64)
    return p[:, 0:1] * _XC + p[:, 1:2] * _YC + p[:, 2:3] * _ZC + _T


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


# ── ROS-schil (draait alleen op de maaier) ─────────────────────────────
SESSION_DIR = "/userdata/lfi/terrain"
MAX_SESSION_FILES = 5
FRAME_INTERVAL = 0.5      # s → max 2 fps
POSE_MAX_AGE = 0.5        # s — geen verse pose = frame overslaan
FLUSH_AFTER_IDLE = 120.0  # s zonder ToF-frames terwijl er data is → sessie klaar
UPLOAD_TIMEOUT = 30


def _read_config():
    """Resolve (http_address, sn) net als extended_commands.py:
    _server_from_config() / _sn_from_config() op de maaier.

    Discovery (2026-07-17, LFIN2230700238): er is GEEN "http_address" key
    in json_config.json. De echte bronnen zijn:
    - /userdata/lfi/http_address.txt — door set_server_urls.sh geschreven
      "<host>:<port>" (optioneel http(s):// prefix), bv. "opennova.local:8080".
      Fallback als leeg/ontbrekend: json_config.json → mqtt.value.addr + ":8080".
    - json_config.json → sn.value.code (genest, geen platte "sn" key), bv.
      {"sn": {"set": 1, "value": {"code": "LFIN2230700238"}}}.

    Retryt geduldig: bij boot kan de config later komen dan deze daemon
    start, en zonder config kan de daemon toch niets — nooit crashen op IO
    (fix na review Task 2, geen supervisor in start_terrain.sh).
    """
    import json
    import sys
    import time as _t

    while True:
        try:
            http_address = None
            try:
                with open("/userdata/lfi/http_address.txt") as f:
                    line = f.read().strip()
                if line:
                    if line.startswith("http://"):
                        line = line[len("http://"):]
                    elif line.startswith("https://"):
                        line = line[len("https://"):]
                    http_address = line.rstrip("/")
            except OSError:
                pass

            with open("/userdata/lfi/json_config.json") as f:
                cfg = json.load(f)

            if not http_address:
                addr = cfg["mqtt"]["value"]["addr"]
                http_address = f"{addr}:8080" if addr else None

            sn = cfg["sn"]["value"]["code"]

            if http_address and sn:
                return http_address, sn
        except Exception as e:  # noqa: BLE001 — config-IO mag de daemon nooit killen
            print(f"terrain: config nog niet leesbaar ({e}), retry over 60s",
                  file=sys.stderr, flush=True)
        _t.sleep(60)


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
        if msg.point_step != 16:
            node.get_logger().warn(
                f"terrain: onverwachte point_step {msg.point_step} (verwacht 16) — frame overgeslagen")
            return
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
        try:
            path = os.path.join(SESSION_DIR, f"session_{int(time.time())}.tgr")
            with open(path, "wb") as f:
                f.write(serialize_grid(st["grid"], CELL))
            node.get_logger().info(
                f"terrain: sessie {path} ({len(st['grid'])} cellen, {st['frames']} frames)")
            _rotate_sessions()
        except Exception as e:  # noqa: BLE001 — disk-IO mag de daemon nooit killen
            node.get_logger().warn(f"terrain: sessie wegschrijven faalde: {e} — sessie verloren")
        finally:
            st["grid"] = {}
            st["frames"] = 0
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
