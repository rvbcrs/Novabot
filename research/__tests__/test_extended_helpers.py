#!/usr/bin/env python3
"""Standalone self-check for the pure helpers in research/extended_commands.py.

No pytest on the mower - plain python3 + assert. Run:
    python3 research/__tests__/test_extended_helpers.py

Covers:
  Task 1: _follow_unicom() dry-run path orientation
  Task 2: _point_in_poly() / _current_zone_slot()
  Task 3: _cov_task_yaml()
"""
import importlib.util
import os
import shutil
import tempfile

spec = importlib.util.spec_from_file_location(
    "ec", os.path.join(os.path.dirname(__file__), "..", "extended_commands.py"))
# NOTE: importing ec starts nothing (guarded by __name__=="__main__" in the
# module). No monkeypatching of mower-only pieces is needed for these helpers.
ec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ec)


def _make_fixture_dir():
    """Build a temp MAPS_HOME with an x3_csv_file/ subfolder containing:
      - map0tomap3_0_unicom.csv: the REAL recorded segment (copied verbatim
        from research/documents reference capture, dock end near (0, 0.8),
        map3 end near (-10.8, 6.26), 45 points, as-recorded map3-first).
      - map3_work.csv: synthetic polygon containing (-17, 8) (Task 2 fixture).
      - map0_work.csv: synthetic polygon containing (2, 3) (Task 2 fixture).
    """
    tmp_dir = tempfile.mkdtemp(prefix="ec_helpers_fixture_")
    csv_dir = os.path.join(tmp_dir, "x3_csv_file")
    os.makedirs(csv_dir, exist_ok=True)

    # Real recorded map0<->map3 unicom segment (as-recorded: map3 end first,
    # dock end last). 45 points, matches the live-capture note in the plan.
    unicom_pts = [
        (-10.820, 6.257), (-10.786, 6.294), (-10.519, 6.493), (-10.240, 6.724),
        (-9.974, 6.963), (-9.691, 7.088), (-9.378, 7.187), (-9.004, 7.224),
        (-8.664, 7.220), (-8.306, 7.200), (-7.936, 7.189), (-7.571, 7.034),
        (-7.256, 6.862), (-6.907, 6.723), (-6.562, 6.545), (-6.245, 6.342),
        (-5.977, 6.205), (-5.677, 6.012), (-5.364, 5.829), (-5.090, 5.672),
        (-4.775, 5.544), (-4.432, 5.414), (-4.120, 5.305), (-3.810, 5.276),
        (-3.470, 5.247), (-3.116, 5.163), (-2.733, 5.071), (-2.407, 5.059),
        (-2.033, 5.050), (-1.671, 4.965), (-1.364, 4.868), (-1.040, 4.722),
        (-0.690, 4.600), (-0.404, 4.478), (-0.226, 4.187), (-0.203, 3.853),
        (-0.177, 3.468), (-0.150, 3.144), (-0.133, 2.813), (-0.109, 2.450),
        (-0.086, 2.089), (-0.092, 1.768), (-0.041, 1.398), (-0.045, 1.086),
        (-0.013, 0.776),
    ]
    assert len(unicom_pts) == 45
    with open(os.path.join(csv_dir, "map0tomap3_0_unicom.csv"), "w") as fh:
        for x, y in unicom_pts:
            fh.write(f"{x},{y}\n")

    # Synthetic map3 work polygon containing (-17, 8).
    map3_poly = [(-18.0, 7.0), (-16.0, 7.0), (-16.0, 9.0), (-18.0, 9.0)]
    with open(os.path.join(csv_dir, "map3_work.csv"), "w") as fh:
        for x, y in map3_poly:
            fh.write(f"{x},{y}\n")

    # Synthetic map0 work polygon containing (2, 3).
    map0_poly = [(1.0, 2.0), (3.0, 2.0), (3.0, 4.0), (1.0, 4.0)]
    with open(os.path.join(csv_dir, "map0_work.csv"), "w") as fh:
        for x, y in map0_poly:
            fh.write(f"{x},{y}\n")

    return tmp_dir


def test_orient_dock_to_map3(tmp_dir):
    ec.MAPS_HOME = tmp_dir
    r = ec._follow_unicom("map0", "map3", dry_run=True)
    assert r["result"] == 0
    assert r["oriented"] == "reversed"          # dock end must be first
    assert r["path"][0][1] < r["path"][-1][1]   # y increases dock(0.8) -> map3(6.2)
    print("test_orient_dock_to_map3: PASS")


def test_zone_detection(tmp_dir):
    ec.MAPS_HOME = tmp_dir
    assert ec._current_zone_slot(None) == "dock"
    assert ec._current_zone_slot((0.0, 0.5)) == "dock"          # on dock disc
    assert ec._current_zone_slot((-17.0, 8.0)) == "map3"        # inside map3 polygon (fixture)
    assert ec._current_zone_slot((2.0, 3.0)) == "map0"          # inside map0
    print("test_zone_detection: PASS")


def test_cov_task_yaml():
    # map3 -> map_ids 1000, NORMAL mode, EMPTY map_names (map_names + map_ids:0
    # is exactly what caused robot_decision Error 118 in the live test).
    y = ec._cov_task_yaml(1000, 2, 90)
    assert "cov_mode: 0" in y and "request_type: 11" in y
    assert "map_ids: 1000" in y
    assert "map_names: []" in y
    assert "map3" not in y                       # never a file-name path
    assert "blade_heights: [2]" in y
    assert "specify_direction: true" in y and "cov_direction: 90" in y
    y2 = ec._cov_task_yaml(1, 3, None)           # map0 -> map_ids 1
    assert "specify_direction: false" in y2 and "map_ids: 1" in y2
    print("test_cov_task_yaml: PASS")


def main():
    tmp_dir = _make_fixture_dir()
    try:
        test_orient_dock_to_map3(tmp_dir)
        test_zone_detection(tmp_dir)
        test_cov_task_yaml()
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    print("ALL PASS")


if __name__ == "__main__":
    main()
