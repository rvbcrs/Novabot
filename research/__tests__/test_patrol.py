#!/usr/bin/env python3
"""Self-check for the night patrol in research/mow_zone_drive.py.

Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
Run: python3 research/__tests__/test_patrol.py
ROS modules are stubbed; the patrol logic runs against fake Drivers.
"""
import importlib.util
import os
import struct
import sys
import tempfile
import types
import urllib.request

for name in ["rclpy", "rclpy.node", "rclpy.action", "rclpy.qos", "rclpy.time",
             "rcl_interfaces", "rcl_interfaces.srv", "rcl_interfaces.msg",
             "decision_msgs", "decision_msgs.srv", "decision_msgs.msg",
             "std_msgs", "std_msgs.msg", "std_srvs", "std_srvs.srv",
             "geometry_msgs", "geometry_msgs.msg",
             "nav_msgs", "nav_msgs.msg", "nav2_msgs", "nav2_msgs.action",
             "nav2_msgs.srv",
             "coverage_planner", "coverage_planner.action", "action_msgs",
             "action_msgs.msg", "tf2_ros", "builtin_interfaces",
             "builtin_interfaces.msg"]:
    sys.modules.setdefault(name, types.ModuleType(name))
for mod, attrs in {
    "decision_msgs.srv": ["StartCoverageTask"],
    "decision_msgs.msg": ["RobotStatus"],
    "std_srvs.srv": ["Trigger", "SetBool", "Empty"],
    "geometry_msgs.msg": ["PoseStamped", "Point", "Twist"],
    "nav_msgs.msg": ["Path", "Odometry", "OccupancyGrid"],
    "nav2_msgs.action": ["FollowPath", "NavigateToPose"],
    "nav2_msgs.srv": ["LoadMap"],
    "coverage_planner.action": ["NavigateThroughCoveragePaths"],
    "action_msgs.msg": ["GoalStatus"],
    "builtin_interfaces.msg": ["Duration"],
    "rcl_interfaces.srv": ["SetParameters", "GetParameters"],
    "rcl_interfaces.msg": ["Parameter", "ParameterValue", "ParameterType"],
    "std_msgs.msg": ["UInt8"],
    "rclpy.qos": ["QoSProfile"],
    "rclpy.action": ["ActionClient"],
}.items():
    for a in attrs:
        setattr(sys.modules[mod], a, type(a, (), {}))
sys.modules["rclpy.qos"].QoSHistoryPolicy = type("QoSHistoryPolicy", (), {"KEEP_LAST": 1, "KEEP_ALL": 0})
sys.modules["rclpy.qos"].QoSProfile = lambda **kw: kw
sys.modules["rclpy.qos"].QoSReliabilityPolicy = type(
    "QoSReliabilityPolicy", (), {"RELIABLE": 1, "BEST_EFFORT": 2})
sys.modules["rclpy.qos"].QoSDurabilityPolicy = type(
    "QoSDurabilityPolicy", (), {"TRANSIENT_LOCAL": 1, "VOLATILE": 2})

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "mow_zone_drive", os.path.join(HERE, "..", "mow_zone_drive.py"))
mzd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mzd)


def write(path, pts):
    with open(path, "w") as fh:
        fh.write("\n".join(f"{x},{y}" for x, y in pts) + "\n")


def with_maps(files):
    """Point MAPS_HOME at a temp dir holding the given csv_file/ entries."""
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, "csv_file"))
    for name, pts in files.items():
        write(os.path.join(d, "csv_file", name), pts)
    mzd.MAPS_HOME = d
    return d


def cloud(labels):
    """A packed points_labeled buffer: x, y, z float32 and one label byte per point."""
    return b"".join(struct.pack("<fff", 0.0, 0.0, 0.0) + bytes([label]) for label in labels)


class Field:
    def __init__(self, name, offset):
        self.name, self.offset = name, offset


# ── Task 1: looking ─────────────────────────────────────────────────────────

def test_label_offset_reads_the_field_and_defaults_to_12():
    assert mzd.label_offset([Field("x", 0), Field("label", 12)]) == 12
    assert mzd.label_offset([Field("x", 0), Field("label", 16)]) == 16
    assert mzd.label_offset([]) == 12


def test_label_counts_counts_people_and_animals_only():
    assert mzd.label_counts(cloud([100, 100, 101, 2, 5, 100]), 13, 12) == {"person": 3, "animal": 1}
    assert mzd.label_counts(b"", 13, 12) == {"person": 0, "animal": 0}


def test_steady_count_needs_two_frames():
    assert mzd.steady_count([]) == 0
    assert mzd.steady_count([500]) == 0           # one spike is noise
    assert mzd.steady_count([0, 80, 120]) == 80   # reached in two frames


class Resp:
    def __init__(self, body):
        self.body = body

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_fetch_snapshot_accepts_only_a_jpeg():
    real = urllib.request.urlopen
    try:
        urllib.request.urlopen = lambda url, timeout=0: Resp(b"\xff\xd8abc")
        assert mzd.fetch_snapshot("front") == b"\xff\xd8abc"
        urllib.request.urlopen = lambda url, timeout=0: Resp(b"<html>busy</html>")
        assert mzd.fetch_snapshot("front") is None

        def refused(url, timeout=0):
            raise OSError("connection refused")
        urllib.request.urlopen = refused
        assert mzd.fetch_snapshot("front") is None
    finally:
        urllib.request.urlopen = real


class ProbeDriver:
    def __init__(self):
        self.calls = []

    def ensure_perception(self):
        self.calls.append(("perception",))
        return True

    def set_headlight(self, level):
        self.calls.append(("light", level))

    def watch_labels(self, seconds):
        return {"person": [3, 50], "animal": [0, 0]}, 2


def test_probe_takes_photos_and_switches_the_light_back_off():
    mzd.PROBE_DIR = tempfile.mkdtemp()
    real = mzd.fetch_snapshot
    mzd.fetch_snapshot = lambda topic, timeout=25.0: b"\xff\xd8" + topic.encode()
    try:
        drv = ProbeDriver()
        assert mzd.do_probe(drv, 2, 100) == 0
    finally:
        mzd.fetch_snapshot = real
    assert drv.calls[0] == ("perception",)
    assert ("light", 100) in drv.calls and drv.calls[-1] == ("light", 0)
    assert sorted(os.listdir(mzd.PROBE_DIR)) == ["led100_front_00.jpg", "led100_tof_gray_00.jpg"]


def test_probe_switches_the_light_off_when_perception_breaks():
    class Broken(ProbeDriver):
        def watch_labels(self, seconds):
            raise RuntimeError("no perception")
    mzd.PROBE_DIR = tempfile.mkdtemp()
    real = mzd.fetch_snapshot
    mzd.fetch_snapshot = lambda topic, timeout=25.0: None
    drv = Broken()
    try:
        mzd.do_probe(drv, 1, 100)
    except RuntimeError:
        pass
    finally:
        mzd.fetch_snapshot = real
    assert drv.calls[-1] == ("light", 0)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all patrol checks passed")
