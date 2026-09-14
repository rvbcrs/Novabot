#!/usr/bin/env python3
"""A recorded channel must stay drivable in the nav map, permanently.

regenerate_per_map_files opens a 1.4 m corridor along every channel, but
map_generator.cpp rewrites map.pgm from its own SLAM data on every task or
monitor update and throws that away. Measured on LFIN2230700238 2026-09-14: the
regenerate wrote 880x471, half an hour later the firmware's 850x440 was back,
and along map0tomap1 there was nowhere more than 0.25 m of room. nav2 needs
more than its inflation_radius of 0.451 m, so it refused the channel as a goal:
"Look like goal is occupied by obstacle".

That is the same fight seam_fix_daemon already runs for obstacles, so the
channel invariant belongs in the same loop. Obstacles win: they are re-occupied
after us.

Run: python3 research/__tests__/test_unicom_stays_open.py
"""
import math

import numpy as np
from PIL import Image, ImageDraw

OCCUPIED, FREE, THRESH = 0, 254, 128
RES = 0.05
UNICOM_W_M = 1.4
INFLATION_RADIUS_M = 0.451      # coverage_planner/params/novabot.yaml
W = H = 80


def to_px(x, y):
    return (int(x / RES), (H - 1) - int(y / RES))


def extend_line(pts, extra_m):
    def _push(a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        d = math.hypot(dx, dy)
        return b if d < 1e-9 else (b[0] + dx / d * extra_m, b[1] + dy / d * extra_m)
    out = list(pts)
    return [_push(out[1], out[0])] + out + [_push(out[-2], out[-1])]


def enforce(arr, channels, obstacles=()):
    """De twee invarianten uit enforce_all, in volgorde."""
    img = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(img)
    uw = max(2, int(round(UNICOM_W_M / RES)))
    for c in channels:
        d.line([to_px(*p) for p in extend_line(c, UNICOM_W_M / 2.0)], fill=255, width=uw, joint="curve")
    oimg = Image.new("L", (W, H), 0)
    if obstacles:
        od0 = ImageDraw.Draw(oimg)
        for o in obstacles:
            od0.polygon([to_px(*p) for p in o], fill=255, outline=255)
    arr[(np.array(img) > 0) & (np.array(oimg) == 0) & (arr < THRESH)] = np.uint8(FREE)

    if obstacles:
        oimg = Image.new("L", (W, H), 0)
        od = ImageDraw.Draw(oimg)
        for o in obstacles:
            od.polygon([to_px(*p) for p in o], fill=255, outline=255)
        arr[(np.array(oimg) > 0) & (arr >= THRESH)] = np.uint8(OCCUPIED)
    return arr


def clearance(arr, x, y, maxr=1.5):
    """Vrije straal rond een punt, zoals de planner hem voelt."""
    def free(px, py):
        cx, cy = to_px(px, py)
        return 0 <= cx < W and 0 <= cy < H and arr[cy, cx] >= THRESH
    r = 0.0
    while r < maxr:
        r += RES
        n = max(8, int(2 * math.pi * r / RES))
        for i in range(n):
            a = 2 * math.pi * i / n
            if not free(x + r * math.cos(a), y + r * math.sin(a)):
                return r
    return maxr


CHANNEL = [(1.0, 1.0), (3.0, 1.0)]


def firmware_raster():
    """Zoals map_generator.cpp hem achterlaat: alles bezet behalve bereden gras."""
    return np.full((H, W), np.uint8(OCCUPIED))


def test_the_channel_start_is_reachable_as_a_goal():
    # Dit is precies wat faalde: nav2 plant naar het begin van het kanaal en
    # weigert als daar minder dan inflation_radius vrij is.
    arr = enforce(firmware_raster(), [CHANNEL])
    assert clearance(arr, *CHANNEL[0]) > INFLATION_RADIUS_M, \
        f"maar {clearance(arr, *CHANNEL[0]):.2f} m rond het beginpunt"


def test_the_whole_channel_has_room():
    arr = enforce(firmware_raster(), [CHANNEL])
    for t in (0.0, 0.25, 0.5, 0.75, 1.0):
        x = CHANNEL[0][0] + (CHANNEL[1][0] - CHANNEL[0][0]) * t
        y = CHANNEL[0][1] + (CHANNEL[1][1] - CHANNEL[0][1]) * t
        assert clearance(arr, x, y) > INFLATION_RADIUS_M, f"te krap op {t*100:.0f}%"


def test_an_obstacle_over_the_channel_still_wins():
    obstacle = [(1.8, 0.8), (2.2, 0.8), (2.2, 1.2), (1.8, 1.2)]
    arr = enforce(firmware_raster(), [CHANNEL], [obstacle])
    cx, cy = to_px(2.0, 1.0)
    assert arr[cy, cx] == OCCUPIED


def test_it_is_idempotent():
    once = enforce(firmware_raster(), [CHANNEL])
    twice = enforce(once.copy(), [CHANNEL])
    assert np.array_equal(once, twice)


def test_the_two_invariants_do_not_fight_each_other():
    # Openen en dichtzetten mogen niet om dezelfde cellen vechten: dan schrijven
    # ze elkaar elke ronde over (gemeten op de maaier: 8 cellen heen en weer).
    obstacle = [(1.8, 0.8), (2.2, 0.8), (2.2, 1.2), (1.8, 1.2)]
    een = enforce(firmware_raster(), [CHANNEL], [obstacle])
    twee = enforce(een.copy(), [CHANNEL], [obstacle])
    assert np.array_equal(een, twee), "de invarianten overschrijven elkaar"


def test_ground_beside_the_channel_is_left_alone():
    arr = enforce(firmware_raster(), [CHANNEL])
    cx, cy = to_px(2.0, 2.5)
    assert arr[cy, cx] == OCCUPIED


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn(); print(f"ok  {name}")
    print("all channel-stays-open checks passed")
