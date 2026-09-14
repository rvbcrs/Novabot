#!/usr/bin/env python3
"""A drawn channel must become a drivable corridor in the navigation map.

We let people draw a work area on a satellite image and then make it "driven"
by freeing its interior, otherwise the coverage planner refuses it. The same
promise has to hold for the connection between two such areas: a drawn channel
has never been driven, so map.pgm holds it occupied and nav2 cannot plan
through it. The zone behind it is then unreachable no matter how neatly it is
drawn, and the mower falls back on whatever ground it happened to drive itself
- which is how LFIN2230700238 planned through the bushes to reach map6
(2026-09-14).

Mirrors the grid arithmetic of handle_regenerate_per_map_files so the rule is
checkable off the mower.

Run: python3 research/__tests__/test_drawn_channel_corridor.py
"""
import numpy as np
from PIL import Image, ImageDraw

OCCUPIED, FREE = 0, 254
RES = 0.05
UNICOM_W_M = 1.4
W = H = 60


def to_px(x, y):
    return (int(x / RES), (H - 1) - int(y / RES))


def build(channel, obstacle=None):
    """(nav grid, cells opened) for one channel and an optional obstacle."""
    whole = np.full((H, W), np.uint8(OCCUPIED))

    obs_img = Image.new("L", (W, H), 0)
    if obstacle:
        ImageDraw.Draw(obs_img).polygon([to_px(*p) for p in obstacle], fill=255, outline=255)
    obs_mask = np.array(obs_img) > 0

    uni_img = Image.new("L", (W, H), 0)
    uw = max(2, int(round(UNICOM_W_M / RES)))
    ImageDraw.Draw(uni_img).line([to_px(*p) for p in channel], fill=255, width=uw, joint="curve")
    uni_mask = (np.array(uni_img) > 0) & (~obs_mask)

    opened = int(((whole < 128) & uni_mask).sum())
    whole[uni_mask] = np.uint8(FREE)
    if obs_mask.any():
        whole[obs_mask] = np.uint8(OCCUPIED)
    return whole, opened


CHANNEL = [(0.5, 1.0), (2.5, 1.0)]     # 2 m horizontal


def test_a_drawn_channel_opens_a_corridor():
    grid, opened = build(CHANNEL)
    assert opened > 0
    # het midden van het kanaal is vrij
    cx, cy = to_px(1.5, 1.0)
    assert grid[cy, cx] == FREE


def test_the_corridor_is_wide_enough_for_the_mower():
    # nav2 houdt inflation_radius 0.451 m aan, dus er moet aan weerskanten van
    # de lijn meer dan dat vrij zijn, anders vindt de planner er niets.
    grid, _ = build(CHANNEL)
    cx, cy = to_px(1.5, 1.0)
    boven = sum(1 for d in range(1, 20) if grid[cy - d, cx] == FREE)
    onder = sum(1 for d in range(1, 20) if grid[cy + d, cx] == FREE)
    marge_m = min(boven, onder) * RES
    assert marge_m > 0.451, f"maar {marge_m:.2f} m marge, nav2 wil > 0.451 m"


def test_ground_beside_the_channel_stays_blocked():
    grid, _ = build(CHANNEL)
    cx, cy = to_px(1.5, 2.5)          # anderhalve meter ernaast
    assert grid[cy, cx] == OCCUPIED


def test_a_drawn_obstacle_wins_over_a_channel_crossing_it():
    obstacle = [(1.3, 0.7), (1.7, 0.7), (1.7, 1.3), (1.3, 1.3)]
    grid, _ = build(CHANNEL, obstacle)
    cx, cy = to_px(1.5, 1.0)
    assert grid[cy, cx] == OCCUPIED, "een getekend obstakel gaat voor"
    # en buiten het obstakel is het kanaal nog steeds open
    ox, oy = to_px(0.8, 1.0)
    assert grid[oy, ox] == FREE


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn(); print(f"ok  {name}")
    print("all drawn-channel checks passed")
