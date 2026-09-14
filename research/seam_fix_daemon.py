#!/usr/bin/env python3
"""seam_fix_daemon.py - keep map.pgm free of the firmware's occupied-inside-lawn seam.

Why this exists
---------------
The stock occupancy-grid writer (`MapGenerator::saveMap`, called by
`NovabotMapping::updateMonitorMapData`) renders a thin OCCUPIED stripe INSIDE the
covered work area. PROVEN on LFIN2231000633: ~490 cells are occupied in map.pgm
yet FREE in a plain polygon fill of the work CSVs (cv2.fillPoly) — i.e. the
stripe is in NO csv, the firmware draws it during grid construction. It
re-appears on EVERY map/task interaction (updateMonitorMapData re-renders), so a
one-shot fix never survives. nav2 return-home then cannot cross it and the mower
gets stuck mid-map.

The fix (structural, principled)
--------------------------------
Inside a designated work area the only OCCUPIED cells should be mapped obstacles;
any other occupied cell is a grid artefact. So: a cell that is occupied but
strictly inside a work polygon and not a mapped obstacle -> free (254).

Talud-safe by construction: only cells inside the RAW (un-inflated) work polygons
are touched. Everything outside (boundary / embankment) stays occupied, so the
mower never gains traversable space toward the talud.

After cleaning the global map.pgm it regenerates the per-slot mapN.pgm (same
masking as handle_regenerate_per_map_files) so the coverage planner inherits the
clean grid too.

Model: unicom_mirror.py — poll loop, atomic write (tmp + os.replace), idempotent
(no churn when already clean), never lets the loop die.
"""
import math
import os
import re
import glob
import time
import json
import ctypes
import struct
import select
import subprocess
import sys

POLL_SEC = 1.0               # fallback cadence when inotify is unavailable
FALLBACK_POLL_SEC = 5.0      # safety sweep cadence while inotify IS active
MIN_SWEEP_INTERVAL = 0.15    # debounce: coalesce write-bursts, bound CPU/temp
MAPS_GLOB = "/userdata/lfi/maps/home*"
OCCUPIED = 0
FREE = 254
THRESH = 128                 # pixel < THRESH == occupied
OBSTACLE_INFLATE_M = 0.10
# per-slot regenerate constants (match handle_regenerate_per_map_files)
INFLATE_M = 0.6
UNICOM_W_M = 1.4
DOCK_R_M = 0.8
EDGE_MARGIN_M = 0.15         # erode each work polygon inward this much so the mower
                            # BODY (not just its center path) stays off the border.
                            # 0 = path may reach the polygon edge (body overhangs).
                            # Overwritten at runtime from CONFIG_PATH (app-controlled).
CONFIG_PATH = "/userdata/lfi/seam_fix.json"   # written by extended_commands `set_seam_fix`
                            # (from the app). {"enabled": bool, "edge_margin_cm": int}.
                            # Absent/disabled -> daemon idles, so non-opted-in mowers
                            # are untouched. /userdata survives firmware upgrades.


def _read_csv(path):
    pts = []
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                a = line.replace(",", " ").split()
                if len(a) >= 2:
                    pts.append((float(a[0]), float(a[1])))
    except OSError:
        pass
    return pts


def _res_origin(yaml_text):
    rm = re.search(r"resolution:\s*([0-9.eE+-]+)", yaml_text)
    om = re.search(r"origin:\s*\[\s*([0-9.eE+-]+)\s*,\s*([0-9.eE+-]+)", yaml_text)
    if not rm or not om:
        return None
    return float(rm.group(1)), float(om.group(1)), float(om.group(2))


def fix_one(base, np, Image, ImageDraw):
    whole_pgm = f"{base}/map.pgm"
    whole_yaml = f"{base}/map.yaml"
    csv_dir = f"{base}/csv_file"
    if not (os.path.exists(whole_pgm) and os.path.exists(whole_yaml) and os.path.isdir(csv_dir)):
        return 0
    ro = _res_origin(open(whole_yaml).read())
    if not ro:
        return 0
    res, ox, oy = ro
    arr = np.array(Image.open(whole_pgm).convert("L"), dtype=np.uint8)
    H, W = arr.shape

    def to_px(x, y):
        return (int((x - ox) / res), (H - 1) - int((y - oy) / res))

    # raw work-polygon union (NO inflate -> strictly interior, talud-safe)
    lawn_img = Image.new("L", (W, H), 0)
    ld = ImageDraw.Draw(lawn_img)
    n_work = 0
    for fname in sorted(os.listdir(csv_dir)):
        if re.match(r"^map\d+_work\.csv$", fname):
            p = _read_csv(f"{csv_dir}/{fname}")
            if len(p) >= 3:
                ld.polygon([to_px(x, y) for (x, y) in p], fill=255)
                n_work += 1
    if n_work == 0:
        return 0
    lawn = np.array(lawn_img) > 0

    # mapped obstacles (+ min thickness) MUST stay occupied
    obst_img = Image.new("L", (W, H), 0)
    od = ImageDraw.Draw(obst_img)
    ow = max(1, 2 * int(round(OBSTACLE_INFLATE_M / res)))
    for fname in os.listdir(csv_dir):
        if re.match(r"^map\d+_\d+_obstacle\.csv$", fname):
            op = [to_px(x, y) for (x, y) in _read_csv(f"{csv_dir}/{fname}")]
            if len(op) >= 3:
                od.polygon(op, fill=255, outline=255)
                od.line(op + [op[0]], fill=255, width=ow, joint="curve")
    obst = np.array(obst_img) > 0

    fix = (arr < THRESH) & lawn & (~obst)
    freed = int(fix.sum())
    if freed == 0:
        return 0  # already clean -> no churn

    arr[fix] = np.uint8(FREE)
    tmp = whole_pgm + ".seamtmp"
    with open(tmp, "wb") as fh:
        fh.write(f"P5\n# CREATOR: map_generator.cpp {res:.3f} m/pix\n{W} {H}\n255\n".encode("ascii"))
        fh.write(arr.tobytes())
    os.replace(tmp, whole_pgm)
    try:
        Image.fromarray(arr, mode="L").save(f"{base}/map.png")
    except Exception:
        pass

    _regenerate_per_slot(base, res, ox, oy, arr, csv_dir, np, Image, ImageDraw)
    print("[seam_fix] %s: freed %d occupied cell(s) inside %d work polygon(s)"
          % (base, freed, n_work), flush=True)
    return freed


def _regenerate_per_slot(base, res, ox, oy, whole, csv_dir, np, Image, ImageDraw):
    H, W = whole.shape

    def to_px(x, y):
        return (int((x - ox) / res), (H - 1) - int((y - oy) / res))

    slots, unicom_files, obstacle_files = [], [], []
    for f in os.listdir(csv_dir):
        m = re.match(r"^(map\d+)_work\.csv$", f)
        if m:
            slots.append(m.group(1))
        if f.endswith("_unicom.csv"):
            unicom_files.append(f)
        if re.match(r"^map\d+_\d+_obstacle\.csv$", f):
            obstacle_files.append(f)
    dock = None
    cs = f"{base}/charging_station_file/charging_station.yaml"
    if os.path.exists(cs):
        cm = re.search(r"charging_pose:\s*\[\s*([0-9.eE+-]+)\s*,\s*([0-9.eE+-]+)", open(cs).read())
        if cm:
            dock = to_px(float(cm.group(1)), float(cm.group(2)))
    infl = max(1, int(round(INFLATE_M / res)))
    uw = max(2, int(round(UNICOM_W_M / res)))
    dr = max(2, int(round(DOCK_R_M / res)))
    ow = max(1, 2 * int(round(OBSTACLE_INFLATE_M / res)))
    edge_px = int(round(EDGE_MARGIN_M / res))
    whole_yaml_content = open(f"{base}/map.yaml").read()
    for slot in sorted(slots):
        wp = _read_csv(f"{csv_dir}/{slot}_work.csv")
        if len(wp) < 3:
            continue
        mask = Image.new("L", (W, H), 0)
        d = ImageDraw.Draw(mask)
        poly = [to_px(x, y) for (x, y) in wp]
        d.polygon(poly, fill=255)
        if edge_px > 0:
            d.line(poly + [poly[0]], fill=0, width=2 * edge_px, joint="curve")  # erode inward: edge margin so the body stays off the border
        # ponytail: NO outside halo. The old `d.line(poly, width=2*infl)` added a
        # ~0.6 m FREE ring OUTSIDE the work polygon, so coverage (which plans on this
        # pgm) mowed up to 0.6 m over the border — fine on open lawn, but on David's
        # tight stone/talud edges it drove off. FREE is now clipped to the work
        # polygon; unicom corridors + the dock disc below are the only legitimate
        # out-of-polygon free.  (`infl` is now unused but left defined; harmless.)
        for uf in unicom_files:
            mm = re.match(r"^(map\d+)to(map\d+|charge)", uf)
            if mm and (mm.group(1) == slot or mm.group(2) == slot):
                up = [to_px(x, y) for (x, y) in _read_csv(f"{csv_dir}/{uf}")]
                if len(up) >= 2:
                    d.line(up, fill=255, width=uw, joint="curve")
        if dock is not None:
            d.ellipse([dock[0] - dr, dock[1] - dr, dock[0] + dr, dock[1] + dr], fill=255)
        out = np.where(np.array(mask, dtype=np.uint8) > 0, whole, np.uint8(OCCUPIED)).astype(np.uint8)
        om = Image.new("L", (W, H), 0)
        oD = ImageDraw.Draw(om)
        for of in obstacle_files:
            if re.match("^" + slot + r"_\d+_obstacle\.csv$", of):
                op = [to_px(x, y) for (x, y) in _read_csv(f"{csv_dir}/{of}")]
                if len(op) >= 3:
                    oD.polygon(op, fill=255, outline=255)
                    oD.line(op + [op[0]], fill=255, width=ow, joint="curve")
        out = np.where(np.array(om, dtype=np.uint8) > 0, np.uint8(OCCUPIED), out).astype(np.uint8)
        tmp = f"{base}/{slot}.pgm.seamtmp"
        with open(tmp, "wb") as fh:
            fh.write(f"P5\n# CREATOR: map_generator.cpp {res:.3f} m/pix\n{W} {H}\n255\n".encode("ascii"))
            fh.write(out.tobytes())
        os.replace(tmp, f"{base}/{slot}.pgm")
        try:
            Image.fromarray(out, mode="L").save(f"{base}/{slot}.png")
        except Exception:
            pass


def _read_config():
    """(enabled, edge_margin_cm) from CONFIG_PATH. Absent/garbled -> (False, 0.0):
    opt-in default, so a mower without the app toggle set is never touched."""
    try:
        with open(CONFIG_PATH) as fh:
            c = json.load(fh)
        return bool(c.get("enabled", False)), float(c.get("edge_margin_cm", 0))
    except Exception:
        return False, 0.0


def regen_one(base, np, Image, ImageDraw):
    """Force a per-slot regenerate from the current global map.pgm. Used at startup
    so a masking change (e.g. dropping the outside halo) takes effect immediately,
    even when the global is already clean and fix_one would skip the regenerate."""
    wp = f"{base}/map.pgm"; wy = f"{base}/map.yaml"; cd = f"{base}/csv_file"
    if not (os.path.exists(wp) and os.path.exists(wy) and os.path.isdir(cd)):
        return
    ro = _res_origin(open(wy).read())
    if not ro:
        return
    res, ox, oy = ro
    arr = np.array(Image.open(wp).convert("L"), dtype=np.uint8)
    _regenerate_per_slot(base, res, ox, oy, arr, cd, np, Image, ImageDraw)


# Breedte van de doorgang die een kanaal vrijhoudt. nav2 houdt
# inflation_radius 0.451 m aan, dus een strook moet ruim daarboven zitten,
# anders is het begin van het kanaal onbereikbaar ("goal is occupied").
UNICOM_W_M = 1.4


def extend_line(pts, extra_m):
    """Trek een polylijn aan beide kanten `extra_m` door.

    Een lijn met breedte heeft een PLATTE kop: precies op het uiteinde is er
    zijwaarts ruimte zat maar vooruit niets, en nav2 weigert zo'n punt als doel
    ("Look like goal is occupied by obstacle", live LFIN2230700238 2026-09-14:
    0,05 m ruimte op het beginpunt van map0tomap1 terwijl de strook 1,4 m breed
    was). Doortrekken geeft het uiteinde dezelfde ruimte als de rest en hecht de
    doorgang meteen aan de vrije grond van de zone ernaast.
    """
    if len(pts) < 2 or extra_m <= 0:
        return list(pts)

    def _push(a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        d = math.hypot(dx, dy)
        if d < 1e-9:
            return b
        return (b[0] + dx / d * extra_m, b[1] + dy / d * extra_m)

    out = list(pts)
    return [_push(out[1], out[0])] + out + [_push(out[-2], out[-1])]


def enforce_unicoms_free(base, np, Image, ImageDraw):
    """ALWAYS-ON invariant, tegenhanger van enforce_obstacles_occupied: een
    opgenomen kanaal moet BERIJDBAAR zijn in de nav-kaart.

    Een getekend kanaal is nooit bereden, dus de firmware kent die grond als
    bezet. regenerate_per_map_files zet de strook open, maar map_generator.cpp
    schrijft map.pgm terug uit zijn eigen SLAM-data bij elke taak- of
    monitor-update en gooit dat weg. Gemeten op LFIN2230700238 2026-09-14: de
    regenerate schreef 880x471, een halfuur later stond er weer 850x440 van de
    firmware, en langs map0tomap1 was nergens meer dan 0,25 m ruimte. nav2
    weigerde het kanaal dan ook als doel: "Look like goal is occupied by
    obstacle". Vandaar hier, in de lus die toch al tegen dat terugschrijven
    vecht. Obstakels gaan vóór: die worden na ons opnieuw dichtgezet.
    Idempotent: schrijft alleen als er echt een cel verandert.
    """
    yaml_p = f"{base}/map.yaml"
    csv_dir = f"{base}/csv_file"
    if not (os.path.exists(yaml_p) and os.path.isdir(csv_dir)):
        return 0
    ro = _res_origin(open(yaml_p).read())
    if not ro:
        return 0
    res, ox, oy = ro
    lines = []
    for fname in os.listdir(csv_dir):
        if fname.endswith("_unicom.csv"):
            p = _read_csv(f"{csv_dir}/{fname}")
            if len(p) >= 2:
                lines.append(p)
    if not lines:
        return 0
    uw = max(2, int(round(UNICOM_W_M / res)))
    pgm = f"{base}/map.pgm"
    if not os.path.exists(pgm):
        return 0
    arr = np.array(Image.open(pgm).convert("L"), dtype=np.uint8)
    H, W = arr.shape

    def to_px(x, y):
        return (int((x - ox) / res), (H - 1) - int((y - oy) / res))

    img = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(img)
    for p in lines:
        p2 = extend_line(p, UNICOM_W_M / 2.0)
        d.line([to_px(x, y) for (x, y) in p2], fill=255, width=uw, joint="curve")

    # Getekende obstakels uitsluiten. Zonder dit openen wij elke ronde precies
    # de cellen die enforce_obstacles_occupied er daarna weer dichtzet, en dan
    # blijven de twee elkaar eeuwig overschrijven (gemeten: 8 cellen heen en
    # weer, elke cyclus opnieuw). Een obstakel gaat voor, dus het kanaal komt
    # daar simpelweg niet open.
    oimg = Image.new("L", (W, H), 0)
    od = ImageDraw.Draw(oimg)
    ow = max(1, 2 * int(round(OBSTACLE_INFLATE_M / res)))
    for fname in os.listdir(csv_dir):
        if re.match(r"^map\d+_\d+_obstacle\.csv$", fname):
            op = _read_csv(f"{csv_dir}/{fname}")
            if len(op) >= 3:
                pp = [to_px(x, y) for (x, y) in op]
                od.polygon(pp, fill=255, outline=255)
                od.line(pp + [pp[0]], fill=255, width=ow, joint="curve")

    need = (np.array(img) > 0) & (np.array(oimg) == 0) & (arr < THRESH)
    n = int(need.sum())
    if n == 0:
        return 0
    arr[need] = np.uint8(FREE)
    tmp = pgm + ".unitmp"
    with open(tmp, "wb") as fh:
        fh.write(f"P5\n# CREATOR: map_generator.cpp {res:.3f} m/pix\n{W} {H}\n255\n".encode("ascii"))
        fh.write(arr.tobytes())
    os.replace(tmp, pgm)
    return n


def enforce_obstacles_occupied(base, np, Image, ImageDraw):
    """ALWAYS-ON invariant, independent of the seam-fix opt-in: a mapped obstacle
    must be OCCUPIED in BOTH the nav map (map.pgm) and the per-slot coverage grids
    (mapN.pgm). The firmware leaves obstacles FREE in map.pgm and rewrites it on
    every task/monitor update, so nav2 drove through them (verified LFIN2231000633
    2026-06-22: firebowl free in map.pgm). We punch obstacles occupied IN PLACE —
    no re-masking — so a non-opted-in mower's free region is otherwise untouched.
    Idempotent: writes only when a cell actually changes. Returns cells occupied."""
    yaml_p = f"{base}/map.yaml"
    csv_dir = f"{base}/csv_file"
    if not (os.path.exists(yaml_p) and os.path.isdir(csv_dir)):
        return 0
    ro = _res_origin(open(yaml_p).read())
    if not ro:
        return 0
    res, ox, oy = ro
    obst_polys = []
    for fname in os.listdir(csv_dir):
        if re.match(r"^map\d+_\d+_obstacle\.csv$", fname):
            p = _read_csv(f"{csv_dir}/{fname}")
            if len(p) >= 3:
                obst_polys.append(p)
    if not obst_polys:
        return 0
    ow = max(1, 2 * int(round(OBSTACLE_INFLATE_M / res)))
    total = 0
    for pgm in [f"{base}/map.pgm"] + sorted(glob.glob(f"{base}/map[0-9]*.pgm")):
        if not os.path.exists(pgm):
            continue
        arr = np.array(Image.open(pgm).convert("L"), dtype=np.uint8)
        H, W = arr.shape

        def to_px(x, y):
            return (int((x - ox) / res), (H - 1) - int((y - oy) / res))

        oimg = Image.new("L", (W, H), 0)
        od = ImageDraw.Draw(oimg)
        for p in obst_polys:
            pp = [to_px(x, y) for (x, y) in p]
            od.polygon(pp, fill=255, outline=255)
            od.line(pp + [pp[0]], fill=255, width=ow, joint="curve")
        need = (np.array(oimg) > 0) & (arr >= THRESH)
        n = int(need.sum())
        if n == 0:
            continue
        arr[need] = np.uint8(OCCUPIED)
        tmp = pgm + ".obstmp"
        with open(tmp, "wb") as fh:
            fh.write(f"P5\n# CREATOR: map_generator.cpp {res:.3f} m/pix\n{W} {H}\n255\n".encode("ascii"))
            fh.write(arr.tobytes())
        os.replace(tmp, pgm)
        try:
            Image.fromarray(arr, mode="L").save(pgm[:-4] + ".png")
        except Exception:
            pass
        total += n
    if total:
        print("[seam_fix] %s: enforced %d obstacle cell(s) OCCUPIED (always-on)"
              % (base, total), flush=True)
    return total


_IN_CLOSE_WRITE = 0x00000008
_IN_MOVED_TO = 0x00000080
_IN_CREATE = 0x00000100
_IN_NONBLOCK = 0x800


class _InotifyWatch:
    """Dependency-free inotify (ctypes) on the map home dirs. Fires the moment
    the firmware (re)writes map.pgm, so the seam is cleaned within milliseconds
    instead of up to a poll-interval later — closing the race where nav2 reads a
    transient striped global. Construction raises if inotify is unavailable; the
    caller then falls back to plain polling."""

    def __init__(self, dirs):
        self._libc = ctypes.CDLL("libc.so.6", use_errno=True)
        self.fd = self._libc.inotify_init1(_IN_NONBLOCK)
        if self.fd < 0:
            raise OSError("inotify_init1 failed (errno %d)" % ctypes.get_errno())
        self._mask = _IN_CLOSE_WRITE | _IN_MOVED_TO | _IN_CREATE
        self.watched = set()
        self.add(dirs)

    def add(self, dirs):
        for d in dirs:
            if d in self.watched:
                continue
            if self._libc.inotify_add_watch(self.fd, d.encode(), self._mask) >= 0:
                self.watched.add(d)

    def wait(self, timeout):
        """Block up to `timeout`s; return True iff map.pgm changed. Drains the
        whole queue so a burst collapses into one sweep."""
        try:
            r, _, _ = select.select([self.fd], [], [], timeout)
        except Exception:
            return False
        if not r:
            return False
        try:
            data = os.read(self.fd, 8192)
        except OSError:
            return False
        hit = False
        i = 0
        while i + 16 <= len(data):
            _wd, _m, _ck, nlen = struct.unpack_from("iIII", data, i)
            i += 16
            name = data[i:i + nlen].split(b"\0", 1)[0].decode("utf-8", "replace")
            i += nlen
            if name == "map.pgm":
                hit = True
        return hit


RELOAD_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reload_nav_map.py")
RELOAD_TIMEOUT_S = 30
# MAPS_GLOB matcht ook home0.bak.*, home0.untangle_bak_* enzovoort. De
# invarianten mogen daar gerust overheen lopen, dat raakt alleen bestanden, maar
# een reload met zo'n map laadt een oude kaart in de draaiende navigatie. Precies
# dat gebeurde live: map_server stond na één daemon-ronde op
# home0.pre_map5_bak_1789115596. Alleen de actieve kaart mag hier door.
NAV_MAP_BASE = "/userdata/lfi/maps/home0"
_reloaded_mtime = {}


def reload_nav_map(base):
    """Vertel map_server dat map.pgm veranderd is.

    map_server leest de kaart alleen bij het opstarten. Alles wat daarna in
    map.pgm komt (map_generator.cpp die hem herschrijft, wij die de kanalen
    openzetten) ziet nav2 pas na een herstart. Zonder deze reload plant de
    planner op een kaart die uren oud kan zijn: live gemeten gaf een cel die op
    schijf 0,70 m vrij lag in de costmap nog `254` en dus GOAL_COLLIDED.

    Alleen bij een echt gewijzigd bestand, en in een los proces: rclpy hierin
    trekken maakt deze daemon een permanente iceoryx-deelnemer.
    """
    if os.path.normpath(base) != NAV_MAP_BASE:
        return False
    pgm = os.path.join(base, "map.pgm")
    yaml_path = os.path.join(base, "map.yaml")
    try:
        mtime = os.path.getmtime(pgm)
    except OSError:
        return False
    if _reloaded_mtime.get(base) == mtime:
        return False
    if not os.path.exists(yaml_path):
        return False
    _reloaded_mtime[base] = mtime          # ook bij mislukking: niet blijven hameren
    try:
        r = subprocess.run([sys.executable, RELOAD_SCRIPT, yaml_path],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           timeout=RELOAD_TIMEOUT_S)
        out = (r.stdout or b"").decode("utf-8", "replace").strip().splitlines()
        print("[seam_fix] map_server reload %s: %s"
              % (base, out[-1] if out else "rc=%d" % r.returncode), flush=True)
        return r.returncode == 0
    except Exception as e:
        print("[seam_fix] map_server reload %s faalde: %s" % (base, e), flush=True)
        return False


def main():
    global EDGE_MARGIN_M
    try:
        import numpy as np
        from PIL import Image, ImageDraw
    except Exception as e:
        print("[seam_fix] numpy/PIL import failed: %s" % e, flush=True)
        return

    def sweep():
        total = 0
        for base in glob.glob(MAPS_GLOB):
            try:
                total += fix_one(base, np, Image, ImageDraw)
            except Exception as e:
                print("[seam_fix] %s: %s" % (base, e), flush=True)
        return total

    def enforce_all():
        total = 0
        for base in glob.glob(MAPS_GLOB):
            try:
                # Volgorde telt: eerst de kanalen open, daarna de obstakels dicht.
                # Een getekend obstakel dat over een kanaal ligt hoort te winnen.
                opened = enforce_unicoms_free(base, np, Image, ImageDraw)
                if opened:
                    print("[seam_fix] %s: %d cel(len) kanaal weer opengezet"
                          % (base, opened), flush=True)
                total += opened
                total += enforce_obstacles_occupied(base, np, Image, ImageDraw)
                # Pas nadat de invarianten erin staan: anders laadt map_server
                # de kaart van halverwege de bewerking.
                reload_nav_map(base)
            except Exception as e:
                print("[seam_fix] enforce %s: %s" % (base, e), flush=True)
        return total

    ino = None
    try:
        ino = _InotifyWatch(sorted(glob.glob(MAPS_GLOB)))
        print("[seam_fix] started (inotify, fallback=%ss)" % FALLBACK_POLL_SEC, flush=True)
        _heartbeat("started mode=inotify")
    except Exception as e:
        print("[seam_fix] inotify unavailable (%s) -> poll mode %ss" % (e, POLL_SEC), flush=True)
        _heartbeat("started mode=poll")

    enabled, margin_cm = _read_config()
    EDGE_MARGIN_M = margin_cm / 100.0
    enforce_all()                        # obstacle-occupied invariant: ALWAYS on (opt-in independent)
    if enabled:                          # force clean+regen at startup so a config change applies now
        sweep()
        for base in glob.glob(MAPS_GLOB):
            try:
                regen_one(base, np, Image, ImageDraw)
            except Exception as e:
                print("[seam_fix] regen_one %s: %s" % (base, e), flush=True)
    _heartbeat("started enabled=%s margin=%.2f" % (enabled, EDGE_MARGIN_M))
    it = 0
    last_sweep = 0.0
    while True:
        it += 1
        enabled, margin_cm = _read_config()   # re-read each loop -> app toggle/margin apply live
        EDGE_MARGIN_M = margin_cm / 100.0
        try:
            if ino is not None:
                hit = ino.wait(FALLBACK_POLL_SEC)
                reason = "event" if hit else "fallback"
                ino.add(sorted(glob.glob(MAPS_GLOB)))  # pick up newly-created home dirs
                if hit:
                    dt = time.monotonic() - last_sweep
                    if dt < MIN_SWEEP_INTERVAL:
                        time.sleep(MIN_SWEEP_INTERVAL - dt)  # coalesce write-burst
            else:
                reason = "poll"
                time.sleep(POLL_SEC)
            occ = enforce_all()              # ALWAYS: obstacles occupied in nav + per-slot grids
            total = sweep() if enabled else 0  # OPT-IN: seam-free inside lawn + edge margin + regen
            last_sweep = time.monotonic()
        except Exception as e:
            print("[seam_fix] loop error: %s" % e, flush=True)
            _heartbeat("looperr iter=%d %s" % (it, e))
            time.sleep(POLL_SEC)
            continue
        _heartbeat("iter=%d %s enabled=%s occ=%d freed=%d margin=%.2f" % (it, reason, enabled, occ, total, EDGE_MARGIN_M))


def _heartbeat(msg):
    try:
        with open("/tmp/seam_fix.status", "w") as fh:
            fh.write(msg + "\n")
    except Exception:
        pass


if __name__ == "__main__":
    main()
