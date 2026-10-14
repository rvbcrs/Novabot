#!/usr/bin/env python3
"""Self-check for the night patrol in research/mow_zone_drive.py.

Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
Run: python3 research/__tests__/test_patrol.py
ROS modules are stubbed; the patrol logic runs against fake Drivers.
"""
import contextlib
import importlib.util
import io
import json
import os
import struct
import sys
import tempfile
import time
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
        return True

    def watch_labels(self, seconds):
        time.sleep(seconds)   # the real window takes this long too
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
    runs = os.listdir(mzd.PROBE_DIR)
    assert len(runs) == 1 and os.path.isdir(os.path.join(mzd.PROBE_DIR, runs[0]))
    assert sorted(os.listdir(os.path.join(mzd.PROBE_DIR, runs[0]))) == ["front_00.jpg", "tof_gray_00.jpg"]


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


class FakePub:
    """A /led_set publisher whose subscriber matches after `misses` polls."""

    def __init__(self, misses):
        self.misses = misses
        self.polls = 0
        self.sent = []   # (poll count at publish time, data)

    def get_subscription_count(self):
        self.polls += 1
        return 0 if self.polls <= self.misses else 1

    def publish(self, msg):
        self.sent.append((self.polls, msg.data))


class FakeNode:
    """Driver.__init__ makes two publishers; the LED one is created last."""

    def __init__(self, misses):
        self.misses = misses
        self.last = None

    def create_publisher(self, msg_type, topic, qos):
        self.last = FakePub(self.misses)
        return self.last


@contextlib.contextmanager
def no_spin():
    """The rclpy stub has no spin_once; the headlight wait spins it."""
    had = hasattr(mzd.rclpy, "spin_once")
    real = getattr(mzd.rclpy, "spin_once", None)
    mzd.rclpy.spin_once = lambda node, timeout_sec=0.0: None
    try:
        yield
    finally:
        if had:
            mzd.rclpy.spin_once = real
        else:
            del mzd.rclpy.spin_once


def test_headlight_waits_for_its_subscriber_then_sends_twice():
    node = FakeNode(misses=3)
    with no_spin():
        drv = mzd.Driver(node)
        assert drv.set_headlight(100, match_timeout=2.0) is True
    # both sends come after the fourth poll, the first one that saw a subscriber
    assert node.last.sent == [(4, 100), (4, 100)]


def test_headlight_without_a_subscriber_sends_nothing():
    node = FakeNode(misses=10 ** 9)
    with no_spin():
        drv = mzd.Driver(node)
        assert drv.set_headlight(100, match_timeout=0.3) is False
    assert node.last.sent == []


# ── Task 2: route driver ────────────────────────────────────────────────────

SQ0 = [(0, 0), (10, 0), (10, 10), (0, 10)]
SQ1 = [(10, 0), (20, 0), (20, 10), (10, 10)]    # touches SQ0 along x = 10
SQ6 = [(30, 0), (40, 0), (40, 10), (30, 10)]    # elsewhere


class HopDriver:
    def __init__(self, fail_at=None):
        self.calls, self.params = [], []
        self._loc = (5.0, 5.0)
        self.fail_at = fail_at

    def set_params(self, items):
        self.params.append(list(items))

    def log_applied_params(self, names):
        pass

    def robot_xy(self, timeout=6.0):
        return self._loc

    def nav_to(self, x, y, yaw=None, timeout=120.0):
        self.calls.append(("nav_to", round(x, 2), round(y, 2)))
        if self.fail_at == "nav_to":
            return False, "nav_to_pose_status_6"
        self._loc = (x, y)
        return True, ""

    def follow_path(self, pts):
        self.calls.append(("follow_path",))
        self._loc = pts[-1]
        return True, ""


def test_drive_hops_restores_the_controller_params_also_on_failure():
    with_maps({"map0_work.csv": SQ0, "map1_work.csv": SQ1})
    drv = HopDriver(fail_at="nav_to")
    ok, msg, _robot = mzd._drive_hops(drv, mzd._csv_base(), (5.0, 5.0), [("touch", None, "map1")])
    assert not ok and msg == "nav_to_pose_status_6"
    assert drv.params[-1] == [(n, d) for (n, _r, d) in mzd.TRANSIT_PARAMS]


def test_drive_hops_drives_a_channel_and_reports_where_it_ended():
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6,
               "map0tomap6_0_unicom.csv": [(9, 5), (31, 5)]})
    drv = HopDriver()
    ok, msg, robot = mzd._drive_hops(drv, mzd._csv_base(), (9.0, 5.0),
                                     [("channel", "map0tomap6_0_unicom.csv", "map6")])
    assert ok and msg == "" and robot[0] > 30


# ── Task 3: patrol mode ─────────────────────────────────────────────────────

DOCK = [(0.5, 0.7), (2, 3)]   # map0tocharge_unicom: anchor inside SQ0


class PatrolDriver(HopDriver):
    def __init__(self, unreachable=(), status=(0, 0)):
        super().__init__()
        self._loc = None                 # on the dock after a boot: no frame yet
        self.unreachable = {tuple(p) for p in unreachable}
        self.status = status

    def wait_status(self, pred, timeout=30.0):
        return self.status

    def reload_map(self, map_yaml=None):
        return True, "ok"

    def recharge_active(self, timeout=4.0):
        return False

    def localize_via_firmware(self, map_ids, cutterhigh, direction, timeout=90.0):
        self.calls.append(("localize", map_ids, cutterhigh))
        self._loc = (1.0, 1.0)
        return self._loc

    def nav_to(self, x, y, yaw=None, timeout=120.0):
        if (x, y) in self.unreachable:
            self.calls.append(("nav_to_fail", x, y))
            return False, "nav_to_pose_status_6"
        return super().nav_to(x, y, yaw, timeout)

    def ensure_perception(self):
        return True

    def watch_labels(self, seconds):
        return {"person": [0, 60, 70], "animal": [0, 0, 0]}, 3


def run_patrol(drv, zones):
    seen, uploads = [], []
    real = (mzd.phase, mzd.fetch_snapshot, mzd.upload_checkpoint)
    mzd.phase = lambda *a: seen.append(a)
    mzd.fetch_snapshot = lambda topic, timeout=25.0: b"\xff\xd8x"
    mzd.upload_checkpoint = (lambda url, seq, xy, scores, frames, jpeg, timeout=20.0:
                             uploads.append((seq, scores, frames, jpeg is not None)) or True)
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            rc = mzd.do_patrol(drv, {"run": "1", "zones": zones, "dwell_s": 1,
                                     "photo_topic": "front", "upload": "http://srv/u?sn=X&run=1"})
    finally:
        mzd.phase, mzd.fetch_snapshot, mzd.upload_checkpoint = real
    return rc, seen, uploads, buf.getvalue().splitlines()


def test_patrol_departs_like_stock_and_looks_at_every_checkpoint():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = PatrolDriver()
    rc, seen, uploads, out = run_patrol(drv, [{"zone": "map0", "points": [[3, 3], [7, 7]]}])
    assert rc == 0 and seen[0] == ("patrolling",) and seen[-1] == ("done",), seen
    assert drv.calls[0] == ("localize", 1, mzd.PATROL_DEPART_CUTTERHIGH)
    assert [u[0] for u in uploads] == [1, 2]
    assert uploads[0][1] == {"person": 60, "animal": 0} and uploads[0][2] == 3
    assert ("follow_path",) not in drv.calls          # no transit inside the dock's zone
    looks = [json.loads(line.split(" ", 1)[1]) for line in out if line.startswith("CHECKPOINT ")]
    keys = {"seq", "x", "y", "frames", "photo", "sent", "person", "animal"}
    assert len(looks) == 2 and all(set(c) == keys for c in looks), looks
    assert [c["seq"] for c in looks] == [1, 2]
    assert looks[0]["person"] == 60 and looks[0]["photo"] is True and looks[0]["sent"] is True


def test_points_outside_every_zone_are_skipped_not_driven():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = PatrolDriver()
    rc, _seen, uploads, _out = run_patrol(drv, [{"zone": "map0", "points": [[3, 3], [50, 50]]}])
    assert rc == 0 and [u[0] for u in uploads] == [1]
    assert ("nav_to", 50, 50) not in drv.calls


def test_a_zone_without_a_route_is_skipped_and_the_rest_goes_on():
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6, "map0tocharge_unicom.csv": DOCK})
    drv = PatrolDriver()
    rc, seen, uploads, out = run_patrol(drv, [{"zone": "map6", "points": [[35, 5]]},
                                              {"zone": "map0", "points": [[3, 3]]}])
    assert rc == 0 and seen[-1] == ("done",), seen
    assert [u[0] for u in uploads] == [2]             # map6's point was seq 1, never driven
    skipped = [json.loads(line.split(" ", 1)[1]) for line in out if line.startswith("SKIPPED ")]
    assert skipped == [{"zone": "map6", "reason": "no_route"}], out


def test_three_unreachable_checkpoints_in_a_row_end_the_patrol():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = PatrolDriver(unreachable=[(3, 3), (4, 4), (5, 5)])
    rc, seen, uploads, _out = run_patrol(drv, [{"zone": "map0", "points": [[3, 3], [4, 4], [5, 5], [6, 6]]}])
    assert rc == 1 and seen[-1] == ("error", "checkpoints_unreachable"), seen
    assert uploads == []


def test_another_zone_is_reached_over_its_channel_and_left_again():
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6, "map0tocharge_unicom.csv": DOCK,
               "map0tomap6_0_unicom.csv": [(9, 5), (31, 5)]})
    drv = PatrolDriver()
    rc, seen, uploads, _out = run_patrol(drv, [{"zone": "map0", "points": [[3, 3]]},
                                               {"zone": "map6", "points": [[35, 5]]}])
    assert rc == 0 and ("returning",) in seen and seen[-1] == ("done",), seen
    assert [u[0] for u in uploads] == [1, 2]
    assert drv.calls.count(("follow_path",)) == 2      # out over the channel and back


def test_a_running_mow_is_never_touched():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = PatrolDriver(status=(mzd.TASK_MODE_COVERAGE, 60))
    rc, seen, _uploads, _out = run_patrol(drv, [{"zone": "map0", "points": [[3, 3]]}])
    assert rc == 1 and seen == [("error", "busy_mowing")]
    assert not any(c[0] == "localize" for c in drv.calls)


def test_a_patrol_run_counts_as_a_stale_drive():
    root = tempfile.mkdtemp()
    os.makedirs(os.path.join(root, "111"))
    with open(os.path.join(root, "111", "cmdline"), "wb") as fh:
        fh.write(b"python3\0/root/novabot/scripts/mow_zone_drive.py\0patrol\0/tmp/patrol_1.json")
    assert mzd.find_stale_mow_drives(root, self_pid=999) == [111]


SQ7 = [(50, 0), (60, 0), (60, 10), (50, 10)]   # past map6, beyond the failing hop


class FailingTransitDriver(PatrolDriver):
    """follow_path aborts once a path runs past x = 45: the map6 -> map7 hop,
    so the mower stops inside map6 with map7 still ahead of it."""

    def follow_path(self, pts):
        if pts[-1][0] > 45:
            self.calls.append(("follow_path_fail",))
            return False, "followpath_aborted_status_6"
        return super().follow_path(pts)


class DyingPerceptionDriver(PatrolDriver):
    """Perception dies on the second look, the one at the map6 checkpoint."""

    def __init__(self):
        super().__init__()
        self.looks = 0

    def watch_labels(self, seconds):
        self.looks += 1
        if self.looks == 2:
            raise RuntimeError("perception died")
        return super().watch_labels(seconds)


class Ack:
    """What urlopen hands back for a 200: a status and a context manager."""
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_a_failed_transit_still_returns_into_the_dock_zone():
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6, "map7_work.csv": SQ7,
               "map0tocharge_unicom.csv": DOCK,
               "map0tomap6_0_unicom.csv": [(9, 5), (31, 5)],
               "map6tomap7_0_unicom.csv": [(39, 5), (51, 5)]})
    drv = FailingTransitDriver()
    rc, seen, _uploads, _out = run_patrol(drv, [{"zone": "map0", "points": [[3, 3]]},
                                                {"zone": "map7", "points": [[55, 5]]}])
    assert rc == 1 and ("returning",) in seen, seen
    assert seen[-1] == ("error", "followpath_aborted_status_6"), seen
    assert drv._loc[0] < 10, drv._loc          # the last follow_path drove back towards map0


def test_an_exception_in_the_loop_still_returns():
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6, "map0tocharge_unicom.csv": DOCK,
               "map0tomap6_0_unicom.csv": [(9, 5), (31, 5)]})
    drv = DyingPerceptionDriver()
    rc, seen, _uploads, _out = run_patrol(drv, [{"zone": "map0", "points": [[3, 3]]},
                                                {"zone": "map6", "points": [[35, 5]]}])
    assert rc == 1 and ("returning",) in seen, seen
    assert seen[-1][0] == "error" and "perception died" in seen[-1][1], seen


def test_upload_checkpoint_posts_the_scores_and_the_photo():
    sent = []
    real = urllib.request.urlopen

    def accept(req, timeout=0):
        sent.append(req)
        return Ack()

    url = "http://srv/u?sn=X&run=1"
    expected = f"&seq=3&x={1.2345:.3f}&y={-2.0:.3f}&frames=5&person=40&animal=0"
    try:
        urllib.request.urlopen = accept
        assert mzd.upload_checkpoint(url, 3, (1.2345, -2.0), {"person": 40, "animal": 0}, 5,
                                     b"\xff\xd8jpeg") is True
        req = sent[-1]
        assert req.full_url == url + expected, req.full_url
        assert req.get_method() == "POST" and req.data == b"\xff\xd8jpeg"
        assert req.get_header("Content-type") == "application/octet-stream"
        assert mzd.upload_checkpoint(url, 3, (1.0, 2.0), {"person": 0, "animal": 0}, 0,
                                     None) is True
        assert sent[-1].data == b""

        def refuse(req, timeout=0):
            raise OSError("connection refused")
        urllib.request.urlopen = refuse
        assert mzd.upload_checkpoint(url, 3, (1.0, 2.0), {"person": 0, "animal": 0}, 0,
                                     b"x") is False
    finally:
        urllib.request.urlopen = real


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all patrol checks passed")
