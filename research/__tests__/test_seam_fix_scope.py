#!/usr/bin/env python3
"""The seam-fix must not reach the navigation raster.

Coverage planning wants the firmware's spurious occupied stripe inside a work
polygon gone, so mapN.pgm frees it. nav2 plans its travel between zones on
map.pgm, and there an occupied cell means a real obstacle. Running one fix over
both erased 7004 cells (17.5 m2) of vegetation from the nav map on
LFIN2230700238 and the mower planned through the bushes to reach a far zone
(2026-09-14).

This mirrors the grid arithmetic of handle_regenerate_per_map_files without the
ROS and MQTT machinery around it, so the rule is checkable off the mower.

Run: python3 research/__tests__/test_seam_fix_scope.py
"""
import numpy as np

OCCUPIED = 0
FREE = 254


def split_grids(whole, lawn_mask, obs_mask):
    """Exactly the split the handler makes: (nav grid, coverage grid)."""
    whole = whole.copy()
    whole_cov = whole.copy()
    seam = (whole < 128) & lawn_mask & (~obs_mask)
    whole_cov[seam] = np.uint8(FREE)
    if obs_mask.any():
        whole[obs_mask] = np.uint8(OCCUPIED)
        whole_cov[obs_mask] = np.uint8(OCCUPIED)
    return whole, whole_cov, int(seam.sum())


def scene():
    """5x5: lawn over the left half, one occupied cell inside it (a bush),
    one mapped obstacle inside it, one occupied cell outside the lawn."""
    whole = np.full((5, 5), np.uint8(FREE))
    whole[1, 1] = OCCUPIED          # bush inside the lawn, not a mapped obstacle
    whole[3, 1] = OCCUPIED          # mapped obstacle inside the lawn
    whole[2, 4] = OCCUPIED          # something outside the lawn
    lawn = np.zeros((5, 5), dtype=bool); lawn[:, 0:3] = True
    obs = np.zeros((5, 5), dtype=bool); obs[3, 1] = True
    return whole, lawn, obs


def test_the_nav_map_keeps_a_bush_inside_a_work_polygon():
    nav, cov, n = split_grids(*scene())
    assert n == 1
    assert nav[1, 1] == OCCUPIED, "nav2 mag hier niet doorheen plannen"
    assert cov[1, 1] == FREE, "de coverage-planner moet de streep juist kwijt"


def test_a_mapped_obstacle_stays_occupied_in_both():
    nav, cov, _ = split_grids(*scene())
    assert nav[3, 1] == OCCUPIED and cov[3, 1] == OCCUPIED


def test_nothing_outside_the_lawn_is_touched():
    whole, lawn, obs = scene()
    nav, cov, _ = split_grids(whole, lawn, obs)
    assert nav[2, 4] == OCCUPIED and cov[2, 4] == OCCUPIED


def test_free_ground_stays_free():
    nav, cov, _ = split_grids(*scene())
    assert nav[0, 0] == FREE and cov[0, 0] == FREE


def test_the_two_grids_really_differ_only_on_the_seam():
    nav, cov, _ = split_grids(*scene())
    diff = np.argwhere(nav != cov)
    assert diff.tolist() == [[1, 1]], diff.tolist()


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn(); print(f"ok  {name}")
    print("all seam-fix scope checks passed")
