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
import re
import signal
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
    "geometry_msgs.msg": ["PoseStamped", "PointStamped", "Point", "Twist"],
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
        self.arrive = []   # arrive_m of every nav_to
        self._loc = (5.0, 5.0)
        self.fail_at = fail_at

    def set_params(self, items):
        self.params.append(list(items))

    def log_applied_params(self, names):
        pass

    def robot_xy(self, timeout=6.0):
        return self._loc

    def nav_to(self, x, y, yaw=None, timeout=120.0, arrive_m=None):
        self.calls.append(("nav_to", round(x, 2), round(y, 2)))
        self.arrive.append(arrive_m)
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


class StaleAfterApproach(HopDriver):
    """nav2 drives the approach, but no fresh pose comes back afterwards."""

    def __init__(self):
        super().__init__()
        self.paths, self.stale = [], False

    def robot_xy(self, timeout=6.0):
        return None if self.stale else self._loc

    def nav_to(self, x, y, yaw=None, timeout=120.0, arrive_m=None):
        result = super().nav_to(x, y, yaw, timeout, arrive_m)
        self.stale = True
        return result

    def follow_path(self, pts):
        self.paths.append(list(pts))
        return super().follow_path(pts)


class StaleReturnDriver(HopDriver):
    """Stands at the far end of a channel home; no fresh pose after the hop."""

    def __init__(self):
        super().__init__()
        self._loc, self.stale = (8.0, 0.2), False

    def robot_xy(self, timeout=6.0):
        return None if self.stale else self._loc

    def follow_path(self, pts):
        self.stale = True
        return super().follow_path(pts)

    def auto_recharge(self):
        self.calls.append(("auto_recharge",))
        return True


def test_a_stale_pose_after_a_return_hop_docks_from_where_the_hop_went():
    with_maps({"map1tomap0_0_unicom.csv": [(0.5, 0.5), (8.0, 0.0)]})
    drv = StaleReturnDriver()
    seen = []
    real, mzd.phase = mzd.phase, (lambda *a: seen.append(a))
    try:
        rc = mzd.do_return(drv)
    finally:
        mzd.phase = real
    # Not "no return segment near (8.0, 0.2)": the hop ended at the dock end.
    assert rc == 0 and seen[-1] == ("done", ""), seen
    assert drv.calls == [("follow_path",), ("auto_recharge",)], drv.calls


def test_a_stale_pose_after_the_approach_starts_the_channel_where_nav2_drove_to():
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6,
               "map0tomap6_0_unicom.csv": [(9, 5), (31, 5)]})
    drv = StaleAfterApproach()
    ok, _msg, robot = mzd._drive_channel_hop(drv, mzd._csv_base(), "map0tomap6_0_unicom.csv",
                                             (2.0, 5.0), 0, 1)
    assert ok and drv.calls[0] == ("nav_to", 9, 5), drv.calls
    # The channel starts where nav2 drove to, not back at (2.0, 5.0), where the
    # mower stood before the approach.
    assert drv.paths[0][0] == (9.0, 5.0), drv.paths[0][:3]
    assert robot == (31.0, 5.0), robot


# ── Task 3: patrol mode ─────────────────────────────────────────────────────

DOCK = [(0.5, 0.7), (2, 3)]   # map0tocharge_unicom: anchor inside SQ0


class PatrolDriver(HopDriver):
    def __init__(self, unreachable=(), status=(0, 0), merged=0, at=None):
        super().__init__()
        self._loc = at                   # None: on the dock after a boot, no frame yet
        self.unreachable = {tuple(p) for p in unreachable}
        self.status = status
        self.merged = merged             # RobotStatus.merged_work_status
        self.events = []                 # headlight levels and phases, in order (run_patrol)

    def docked(self, timeout=5.0):
        return self.merged == mzd.MERGED_CHARGING

    def prepare_headlight(self):
        self.events.append(("light_ready",))

    def set_headlight(self, level, match_timeout=3.0):
        self.events.append(("light", level))
        return True

    def cancel_own_goal(self, timeout=0.5):
        self.events.append(("cancel_own_goal",))
        return False

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

    def nav_to(self, x, y, yaw=None, timeout=120.0, arrive_m=None):
        if (x, y) in self.unreachable:
            self.calls.append(("nav_to_fail", x, y))
            return False, "nav_to_pose_status_6"
        return super().nav_to(x, y, yaw, timeout, arrive_m)

    def ensure_perception(self):
        return True

    def watch_labels(self, seconds):
        return {"person": [0, 60, 70], "animal": [0, 0, 0]}, 3

    def restart_camera(self, topic):
        self.calls.append(("restart_camera", topic))
        return True


def live_camera():
    """fetch_snapshot as a live camera answers: never the same bytes twice."""
    shots = iter(range(1, 10 ** 6))
    return lambda topic, timeout=25.0: b"\xff\xd8%d" % next(shots)


def run_patrol(drv, zones, snapshot=None):
    seen, uploads = [], []
    real = (mzd.phase, mzd.fetch_snapshot, mzd.upload_checkpoint)
    mzd.phase = lambda *a: seen.append(a) or drv.events.append(("phase",) + a)
    mzd.fetch_snapshot = snapshot or live_camera()
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


class SettleDriver(PatrolDriver):
    """The frame after the departure: |/map_utm - map pose| per measurement,
    in order; the last value repeats."""
    def __init__(self, residuals, **kw):
        super().__init__(**kw)
        self.residuals = list(residuals)

    def frame_residual(self, timeout=6.0):
        r = self.residuals.pop(0) if len(self.residuals) > 1 else self.residuals[0]
        return r, 200


# Live LFIN2230700238, 2026-10-18: straight after the departure the map pose
# sat 1.3 m from GPS, the costmap's trampoline 1.3 m from the real one, and
# the patrol lost all five checkpoints. A short leg settles the frame first.
def test_patrol_settles_the_frame_before_the_first_checkpoint():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = SettleDriver([1.3, 0.2], merged=mzd.MERGED_CHARGING)
    rc, seen, uploads, out = run_patrol(drv, [{"zone": "map0", "points": [[7, 7]]}])
    assert rc == 0, (rc, seen)
    navs = [c for c in drv.calls if c[0] == "nav_to"]
    assert len(navs) == 2 and navs[1][1:] == (7, 7), navs          # one settle leg, then the checkpoint
    leg = navs[0][1:]
    assert mzd.point_in_poly(leg[0], leg[1], SQ0) and mzd._dist_to_poly(leg, SQ0) >= 1.5, leg
    assert len(uploads) == 1


def test_patrol_and_transit_goals_end_within_reach():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = SettleDriver([1.3, 0.2], merged=mzd.MERGED_CHARGING)
    run_patrol(drv, [{"zone": "map0", "points": [[7, 7]]}])
    assert drv.arrive == [mzd.ARRIVE_M] * 2, drv.arrive               # the settle leg, the checkpoint
    with_maps({"map0_work.csv": SQ0, "map1_work.csv": SQ1, "map6_work.csv": SQ6,
               "map0tomap6_0_unicom.csv": [(9, 5), (31, 5)]})
    hop = HopDriver()
    mzd._drive_hops(hop, mzd._csv_base(), (5.0, 5.0), [("touch", None, "map1")])
    hop._loc = (5.0, 5.0)
    mzd._drive_hops(hop, mzd._csv_base(), (5.0, 5.0), [("channel", "map0tomap6_0_unicom.csv", "map6")])
    assert hop.arrive == [mzd.ARRIVE_M] * 2, hop.arrive               # the touch step, the lead-in


# Walter (LFIN2231000367), 2026-10-23 00:15: after its start the front camera
# gave one frame and then nothing. camera_stream kept serving that frame: eleven
# photos of the same 9837 bytes, 0 perception frames, and error 113 at the dock.
# A live camera never gives the same JPEG across a checkpoint's dwell.
def frozen_then(after_restart):
    """fetch_snapshot as a camera that repeats one frame until restart_camera, then `after_restart`."""
    state = {"restarted": False}
    live = live_camera()

    def shot(topic, timeout=25.0):
        if not state["restarted"]:
            return b"\xff\xd8frozen"
        return live(topic) if after_restart == "live" else b"\xff\xd8still"
    return state, shot


class FrozenCameraDriver(PatrolDriver):
    def __init__(self, state, **kw):
        super().__init__(**kw)
        self.state = state

    def restart_camera(self, topic):
        self.state["restarted"] = True
        return super().restart_camera(topic)


def test_a_frozen_camera_is_restarted_once_and_the_checkpoint_looked_at_again():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    state, shot = frozen_then("live")
    drv = FrozenCameraDriver(state, at=(5.0, 5.0))
    real_settle, mzd.CAMERA_SETTLE_S = mzd.CAMERA_SETTLE_S, 0
    try:
        rc, seen, uploads, out = run_patrol(drv, [{"zone": "map0", "points": [[3, 3], [7, 7]]}], shot)
    finally:
        mzd.CAMERA_SETTLE_S = real_settle
    assert rc == 0, (rc, seen)
    assert [c for c in drv.calls if c[0] == "restart_camera"] == [("restart_camera", "front")]
    assert [u[0] for u in uploads] == [1, 2] and all(u[3] for u in uploads), uploads


def test_a_camera_still_frozen_after_its_restart_ends_the_round():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    state, shot = frozen_then("still")
    drv = FrozenCameraDriver(state, at=(5.0, 5.0))
    real_settle, mzd.CAMERA_SETTLE_S = mzd.CAMERA_SETTLE_S, 0
    try:
        rc, seen, uploads, out = run_patrol(drv, [{"zone": "map0", "points": [[3, 3], [7, 7]]}], shot)
    finally:
        mzd.CAMERA_SETTLE_S = real_settle
    assert rc == 1 and ("error", "camera_frozen") in seen, seen
    assert len([c for c in drv.calls if c[0] == "restart_camera"]) == 1, drv.calls
    assert uploads == [], uploads                                       # no frozen photo as a look
    assert ("nav_to", 7, 7) not in drv.calls, drv.calls                 # the round ends there


def test_a_missing_photo_is_not_a_frozen_camera():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = PatrolDriver(at=(5.0, 5.0))
    rc, seen, uploads, out = run_patrol(drv, [{"zone": "map0", "points": [[3, 3]]}],
                                        lambda topic, timeout=25.0: None)
    assert rc == 0 and "restart_camera" not in [c[0] for c in drv.calls], (rc, drv.calls)


def test_patrol_ends_when_the_frame_never_settles():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = SettleDriver([1.3], merged=mzd.MERGED_CHARGING)
    rc, seen, uploads, out = run_patrol(drv, [{"zone": "map0", "points": [[7, 7]]}])
    assert rc == 1 and ("error", "frame_not_settled") in seen, seen
    assert len([c for c in drv.calls if c[0] == "nav_to"]) == mzd.PATROL_SETTLE_LEGS
    assert uploads == []


def test_settle_target_keeps_clear_of_borders_and_obstacles():
    robot, middle = (1.0, 1.9), (5.0, 5.0)
    t = mzd._settle_target(robot, SQ0, [], middle)
    assert t is not None and mzd._dist_to_poly(t, SQ0) >= 1.5
    assert abs(((t[0] - robot[0]) ** 2 + (t[1] - robot[1]) ** 2) ** 0.5 - 3.0) < 1e-6
    box = [(2, 3), (4, 3), (4, 5), (2, 5)]        # on the way to the middle: no leg at all
    assert mzd._settle_target(robot, SQ0, [box], middle) is None
    far = [(7, 7), (8, 7), (8, 8), (7, 8)]        # an obstacle elsewhere changes nothing
    assert mzd._settle_target(robot, SQ0, [far], middle) == t


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


class StalePatrolDriver(PatrolDriver):
    """No fresh pose comes back once the patrol drives."""

    def __init__(self):
        super().__init__()
        self.driven = False

    def robot_xy(self, timeout=6.0):
        return None if self.driven else self._loc

    def nav_to(self, x, y, yaw=None, timeout=120.0, arrive_m=None):
        self.driven = True
        return super().nav_to(x, y, yaw, timeout, arrive_m)


def test_a_stale_pose_after_a_checkpoint_reports_that_checkpoint():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = StalePatrolDriver()
    rc, seen, _uploads, out = run_patrol(drv, [{"zone": "map0", "points": [[3, 3], [7, 7]]}])
    assert rc == 0 and seen[-1] == ("done",), seen
    looks = [json.loads(line.split(" ", 1)[1]) for line in out if line.startswith("CHECKPOINT ")]
    # Not (1.0, 1.0) twice, where the patrol stood before it drove.
    assert [(c["x"], c["y"]) for c in looks] == [(3, 3), (7, 7)], looks


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


# ── Checkpoints nav2 refuses (live LFIN2230700238, 2026-10-15 14:46) ────────
# Checkpoint 1 at (6.27, 2.16): "goal is occupied with no tolerance", aborted
# within ~1 s. Checkpoints 2 and 3: driven ~35 s and ~30 s, then aborted
# (TEB "trajectory not feasible", "goal is occupied by obstacle"). Three in a
# row ended the run at the pool corner.

L0 = [(0, 0), (10, 0), (10, 2), (2, 2), (2, 10), (0, 10)]   # its middle (3.2, 3.2) lies outside it


class CheckpointDriver(PatrolDriver):
    """nav2 per goal: an `occupied` goal aborts at once (a goal in an occupied
    cell), a `blocked` goal aborts after `drive_s` seconds of driving, every
    other goal is reached in `drive_s`. The clock only moves inside nav_to."""

    def __init__(self, occupied=(), blocked=(), drive_s=35.0):
        super().__init__()
        self.occupied = {tuple(p) for p in occupied}
        self.blocked = {tuple(p) for p in blocked}
        self.drive_s = drive_s
        self.now = 1000.0
        self.goals = []          # every goal nav2 got, rounded to the cm

    def monotonic(self):
        return self.now

    def nav_to(self, x, y, yaw=None, timeout=120.0, arrive_m=None):
        goal = (round(x, 2), round(y, 2))
        self.goals.append(goal)
        if goal in self.occupied:
            self.now += 0.9
            return False, "nav_to_pose_status_6"
        self.now += self.drive_s
        if goal in self.blocked:
            return False, "nav_to_pose_status_6"
        self._loc = (x, y)
        return True, ""


class NothingReachable(PatrolDriver):
    """nav2 refuses every goal at once, the inward retries too."""

    def nav_to(self, x, y, yaw=None, timeout=120.0, arrive_m=None):
        return False, "nav_to_pose_status_6"


class NavClock:
    """mzd's `time` while a CheckpointDriver drives: the real module, except
    that monotonic() reads the driver's clock."""

    def __init__(self, drv):
        self.monotonic = drv.monotonic

    def __getattr__(self, name):
        return getattr(time, name)


def run_checkpoints(drv, zones):
    real, mzd.time = mzd.time, NavClock(drv)
    try:
        return run_patrol(drv, zones)
    finally:
        mzd.time = real


def skipped_lines(out):
    return [json.loads(line.split(" ", 1)[1]) for line in out if line.startswith("SKIPPED ")]


def looked_at(out):
    return [json.loads(line.split(" ", 1)[1]) for line in out if line.startswith("CHECKPOINT ")]


def test_a_checkpoint_refused_at_once_is_tried_again_further_in_and_looked_at_there():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = CheckpointDriver(occupied=[(1, 5)])
    rc, seen, uploads, out = run_checkpoints(drv, [{"zone": "map0", "points": [[1, 5]]}])
    assert rc == 0 and seen[-1] == ("done",), seen
    # 0.6 m from (1, 5) towards the middle of the square, (5, 5)
    assert drv.goals == [(1, 5), (1.6, 5)], drv.goals
    assert [(c["seq"], c["x"], c["y"]) for c in looked_at(out)] == [(1, 1.6, 5)], out
    assert [u[0] for u in uploads] == [1] and skipped_lines(out) == [], out


STRIP = [(0, 0), (30, 0), (30, 4), (0, 4)]                 # 30 x 4 m along a hedge
THIN = [(0, 0), (10, 0), (10, 0.5), (0, 0.5)]              # 0.5 m wide
THIN_L = [(0, 0), (10, 0), (10, 0.5), (0.5, 0.5), (0.5, 10), (0, 10)]   # its middle (2.7, 2.7) lies outside


def test_a_checkpoint_along_a_long_hedge_steps_straight_away_from_it():
    # Towards the middle of the strip, (15, 2), the step ran along the hedge:
    # 0.06 m further from it. Away from the nearest border point it is 0.6 m.
    with_maps({"map0_work.csv": STRIP, "map0tocharge_unicom.csv": DOCK})
    drv = CheckpointDriver(occupied=[(5, 1)])
    rc, seen, _uploads, out = run_checkpoints(drv, [{"zone": "map0", "points": [[5, 1]]}])
    assert rc == 0 and seen[-1] == ("done",), seen
    assert drv.goals == [(5, 1), (5, 1.6)], drv.goals


STRIP_2M = [(0, 0), (30, 0), (30, 2), (0, 2)]


def test_in_a_narrow_zone_a_retry_never_ends_closer_to_a_border():
    # 1.0 m inside a 2 m strip is its middle: 0.6 m off the nearest edge would
    # leave 0.4 m to the other one. Along the strip the clearance stays 1.0 m.
    with_maps({"map0_work.csv": STRIP_2M, "map0tocharge_unicom.csv": DOCK})
    drv = CheckpointDriver(occupied=[(5, 1)])
    rc, seen, _uploads, _out = run_checkpoints(drv, [{"zone": "map0", "points": [[5, 1]]}])
    assert rc == 0 and seen[-1] == ("done",), seen
    assert drv.goals == [(5, 1), (5.6, 1)], drv.goals
    assert mzd._dist_to_poly((5.6, 1.0), STRIP_2M) >= mzd._dist_to_poly((5.0, 1.0), STRIP_2M)


def test_an_inner_corner_checkpoint_of_an_l_steps_into_the_zone():
    # Towards the middle of the L, (3.2, 3.2), it would leave the zone at (2.22, 2.22).
    with_maps({"map0_work.csv": L0, "map0tocharge_unicom.csv": DOCK})
    drv = CheckpointDriver(occupied=[(1.8, 1.8)])
    rc, seen, uploads, out = run_checkpoints(drv, [{"zone": "map0", "points": [[1.8, 1.8]]}])
    assert rc == 0 and seen[-1] == ("done",), seen
    assert drv.goals == [(1.8, 1.8), (1.38, 1.38)], drv.goals
    assert mzd.point_in_poly(1.38, 1.38, L0) and [u[0] for u in uploads] == [1]


def test_where_the_step_off_the_border_leaves_the_zone_the_centroid_step_is_tried():
    # 0.1 m from the edge of a 0.5 m wide zone: 0.6 m away from it is outside.
    with_maps({"map0_work.csv": THIN, "map0tocharge_unicom.csv": DOCK})
    drv = CheckpointDriver(occupied=[(2, 0.1)])
    rc, seen, _uploads, out = run_checkpoints(drv, [{"zone": "map0", "points": [[2, 0.1]]}])
    assert rc == 0 and seen[-1] == ("done",), seen
    assert drv.goals == [(2, 0.1), (2.6, 0.13)], drv.goals     # towards (5, 0.25)


def test_a_fallback_outside_the_zone_is_not_tried_and_the_checkpoint_is_skipped():
    # Both steps leave a thin L: off the border to (5, 0.7), towards its middle to (4.6, 0.55).
    with_maps({"map0_work.csv": THIN_L, "map0tocharge_unicom.csv": DOCK})
    drv = CheckpointDriver(occupied=[(5, 0.1)])
    rc, seen, uploads, out = run_checkpoints(drv, [{"zone": "map0", "points": [[5, 0.1], [8, 0.25]]}])
    assert rc == 0 and seen[-1] == ("done",), seen
    assert drv.goals == [(5, 0.1), (8, 0.25)], drv.goals
    assert skipped_lines(out) == [{"zone": "map0", "seq": 1, "reason": "checkpoint_unreachable"}], out
    assert [u[0] for u in uploads] == [2]
    assert any("checkpoint 1 skipped" in line for line in out), out


class StaleCheckpointDriver(CheckpointDriver):
    """No fresh pose comes back once the patrol drives."""

    def robot_xy(self, timeout=6.0):
        return None if self.goals else self._loc


def test_without_a_fresh_pose_a_checkpoint_is_reported_where_nav2_got_to():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = StaleCheckpointDriver(occupied=[(1, 5)])
    rc, seen, _uploads, out = run_checkpoints(drv, [{"zone": "map0", "points": [[1, 5], [7, 7]]}])
    assert rc == 0 and seen[-1] == ("done",), seen
    # The retry's point, then the goal itself; not the refused (1, 5), nor
    # (1.0, 1.0), where the patrol stood before it drove.
    assert [(c["x"], c["y"]) for c in looked_at(out)] == [(1.6, 5), (7, 7)], out


def test_without_a_fresh_pose_a_skipped_checkpoint_leaves_the_pose_from_before_it():
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6, "map0tocharge_unicom.csv": DOCK,
               "map0tomap6_0_unicom.csv": [(9, 5), (31, 5)]})
    drv = StaleCheckpointDriver(blocked=[(9.2, 5.2)])     # beside the channel's start
    rc, seen, _uploads, _out = run_checkpoints(drv, [{"zone": "map0", "points": [[3, 3], [9.2, 5.2]]},
                                                     {"zone": "map6", "points": [[35, 5]]}])
    assert rc == 0 and seen[-1] == ("done",), seen
    # The transit starts from (3, 3), the last goal reached, so it drives to
    # the channel first; from the failed goal it would start at the channel.
    assert drv.goals[:4] == [(3, 3), (9.2, 5.2), (9, 5), (35, 5)], drv.goals


def test_an_inward_retry_that_fails_too_is_tried_once_and_the_checkpoint_skipped():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = CheckpointDriver(occupied=[(1, 5), (1.6, 5)])
    rc, seen, uploads, out = run_checkpoints(drv, [{"zone": "map0", "points": [[1, 5], [7, 7]]}])
    assert rc == 0 and seen[-1] == ("done",), seen
    assert drv.goals == [(1, 5), (1.6, 5), (7, 7)], drv.goals
    assert skipped_lines(out) == [{"zone": "map0", "seq": 1, "reason": "checkpoint_unreachable"}], out
    assert [u[0] for u in uploads] == [2]


def test_a_checkpoint_that_fails_after_driving_is_skipped_without_a_retry():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = CheckpointDriver(blocked=[(1, 5)])          # driven 35 s, then aborted
    rc, seen, uploads, out = run_checkpoints(drv, [{"zone": "map0", "points": [[1, 5], [7, 7]]}])
    assert rc == 0 and seen[-1] == ("done",), seen
    assert drv.goals == [(1, 5), (7, 7)], drv.goals  # no (1.6, 5)
    assert skipped_lines(out) == [{"zone": "map0", "seq": 1, "reason": "checkpoint_unreachable"}], out
    assert [u[0] for u in uploads] == [2]


def test_a_reached_checkpoint_starts_the_count_of_failures_again():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    points = [[2, 2], [3, 3], [4, 4], [6, 6], [7, 7], [8, 8], [9, 9]]
    drv = CheckpointDriver(blocked=[(2, 2), (3, 3), (6, 6), (7, 7), (8, 8), (9, 9)])
    rc, seen, uploads, out = run_checkpoints(drv, [{"zone": "map0", "points": points}])
    # two skipped, one reached, four skipped: never five in a row
    assert rc == 0 and seen[-1] == ("done",), seen
    assert [u[0] for u in uploads] == [3]
    assert [s["seq"] for s in skipped_lines(out)] == [1, 2, 4, 5, 6, 7], out
    assert len(drv.goals) == 7, drv.goals


def test_five_checkpoints_that_fail_in_a_row_end_the_patrol():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    points = [[2, 2], [3, 3], [4, 4], [6, 6], [7, 7], [8, 8]]
    drv = CheckpointDriver(blocked=[tuple(p) for p in points])
    rc, seen, uploads, out = run_checkpoints(drv, [{"zone": "map0", "points": points}])
    assert rc == 1 and seen[-1] == ("error", "checkpoints_unreachable"), seen
    assert uploads == []
    assert drv.goals == [(2, 2), (3, 3), (4, 4), (6, 6), (7, 7)], drv.goals   # the sixth is never driven
    assert [s["seq"] for s in skipped_lines(out)] == [1, 2, 3, 4, 5], out


def test_a_patrol_that_reaches_no_checkpoint_at_all_ends_unreachable():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    points = [[2, 2], [3, 3], [4, 4]]                 # fewer than five
    drv = CheckpointDriver(blocked=[tuple(p) for p in points])
    rc, seen, uploads, out = run_checkpoints(drv, [{"zone": "map0", "points": points}])
    assert rc == 1 and seen[-1] == ("error", "checkpoints_unreachable"), seen
    assert uploads == [] and [s["seq"] for s in skipped_lines(out)] == [1, 2, 3], out


def test_skipped_checkpoints_carry_their_zone_and_overall_seq():
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6, "map0tocharge_unicom.csv": DOCK,
               "map0tomap6_0_unicom.csv": [(9, 5), (31, 5)]})
    drv = CheckpointDriver(blocked=[(35, 5)])
    rc, seen, uploads, out = run_checkpoints(drv, [{"zone": "map0", "points": [[3, 3]]},
                                                   {"zone": "map6", "points": [[35, 5], [37, 7]]}])
    assert rc == 0 and seen[-1] == ("done",), seen
    assert skipped_lines(out) == [{"zone": "map6", "seq": 2, "reason": "checkpoint_unreachable"}], out
    assert [u[0] for u in uploads] == [1, 3]


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


# Live on LFIN2230700238, 2026-10-15 13:42: docked at (-1.463, 1.218), 1.9 m
# from the origin and 1.57 m from the anchor (0.03, 0.73). The position said
# "not on the dock", the patrol skipped the firmware departure and nav2 aborted
# every goal from the dock (checkpoints_unreachable). RobotStatus said CHARGING.
DOCKED_244 = (-1.463, 1.218)
DOCK_244 = {"map0tocharge_unicom.csv": [(0.03, 0.73), (2.0, 3.0)]}
GARDEN_244 = dict(DOCK_244, **{"map0_work.csv": [(-3, -3), (10, -3), (10, 10), (-3, 10)]})


def test_a_charging_mower_departs_before_patrolling_even_outside_the_dock_disc():
    with_maps(GARDEN_244)
    drv = PatrolDriver(merged=mzd.MERGED_CHARGING, at=DOCKED_244)
    rc, seen, _uploads, out = run_patrol(drv, [{"zone": "map0", "points": [[3, 3]]}])
    assert rc == 0 and seen[-1] == ("done",), seen
    assert drv.calls[0] == ("localize", 1, mzd.PATROL_DEPART_CUTTERHIGH), drv.calls
    assert any("on the dock (charging)" in line for line in out), out


def test_docked_reads_merged_work_status_charging():
    def status(merged):   # live while docked: work 2, recharge 9, merged 4
        return types.SimpleNamespace(task_mode=1, work_status=2, recharge_status=9,
                                     merged_work_status=merged)
    for merged, expect in ((mzd.MERGED_CHARGING, True), (0, False), (2, False)):
        drv = tf_driver(FakeTfBuffer(None))
        with probe_spins(lambda: drv._on_status(status(merged))):
            assert drv.docked(timeout=1.0) is expect, merged
    drv = tf_driver(FakeTfBuffer(None))
    with probe_spins(lambda: None):   # no RobotStatus at all
        assert drv.docked(timeout=0.2) is False


def test_a_patrol_not_charging_there_starts_where_it_stands():
    with_maps(GARDEN_244)
    drv = PatrolDriver(merged=0, at=DOCKED_244)
    rc, seen, _uploads, _out = run_patrol(drv, [{"zone": "map0", "points": [[3, 3]]}])
    assert rc == 0 and seen[-1] == ("done",), seen
    assert not any(c[0] == "localize" for c in drv.calls), drv.calls


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


# ── The drive owns what it starts: the departure task, its nav2 goal, the light ──
# A drive is killed with SIGTERM by a newer drive start (kill_stale_mow_drives)
# or by stop_mow_zone, and SIGKILLed 3 to 5 s later. In that window it has to
# stop the coverage task its firmware departure started, or robot_decision runs
# that task to its end: the dock zone mowed at 90 mm, at night.

@contextlib.contextmanager
def stop_handlers():
    """The SIGTERM/SIGHUP handlers a driving mode installs, restored afterwards."""
    previous = mzd._install_stop_handlers()
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


class DepartureDriver(mzd.Driver):
    """The real Driver.localize_via_firmware against a fake robot_decision.
    `sigterm_in` names the call during which the drive receives SIGTERM;
    `fail_in` the one that raises instead. The mower stands at `before` until
    the departure starts and at `after` from then on."""

    def __init__(self, sigterm_in=None, fail_in=None, recharging=False,
                 before=(0.0, 0.0), after=(1.0, 1.0), merged=0):
        self.calls = []
        self.sigterm_in, self.fail_in, self.recharging = sigterm_in, fail_in, recharging
        self.before, self.after, self.departed = before, after, False
        self.merged = merged   # RobotStatus.merged_work_status until the departure starts
        self._status = (mzd.TASK_MODE_COVERAGE, 30)   # the departure's init states
        self._recharge = 0

    def _step(self, name):
        if self.sigterm_in == name:
            self.sigterm_in = None
            os.kill(os.getpid(), signal.SIGTERM)
        if self.fail_in == name:
            self.fail_in = None
            raise RuntimeError(f"{name} broke")

    def start_cov(self, map_ids, cutterhigh, direction):
        self.calls.append(("start_cov",))
        self.departed = True
        self._step("start_cov")
        return True

    def robot_xy(self, timeout=6.0):
        self.calls.append(("robot_xy",))
        if not self.departed:
            return self.before   # the pose the departure starts from
        self._step("robot_xy")
        return self.after

    def docked(self, timeout=5.0):
        # On the charger until the departure starts: a read after start_cov says no.
        return self.merged == mzd.MERGED_CHARGING and not self.departed

    def wait_status(self, pred, timeout=30.0):
        self.calls.append(("wait_status", timeout))
        self._step("wait_status")
        return self._status

    def recharge_active(self, timeout=4.0):
        self.calls.append(("recharge_active", timeout))
        return self.recharging

    def _prepare_release(self):
        self.calls.append(("prepare_release",))

    def stop_task(self, timeout=None):
        self.calls.append(("stop_task", timeout))
        self._step("stop_task" if timeout is None else "release_stop_task")
        self._status = (mzd.TASK_MODE_COVERAGE, mzd.WORK_STATUS_USER_STOP)   # parked
        return True

    def quit_mapping_mode(self, timeout=None):
        self.calls.append(("quit_mapping_mode", timeout))
        self._status = (mzd.TASK_MODE_COVERAGE, 0)
        return True

    def cancel_coverage_goals(self):
        self.calls.append(("cancel_coverage_goals",))
        return True


def depart(drv, sleep=None):
    """localize_via_firmware with the stop handlers installed. (exit code or None, result)."""
    real_time = mzd.time
    if sleep is not None:
        mzd.time = types.SimpleNamespace(time=time.time, monotonic=time.monotonic, sleep=sleep)
    try:
        with stop_handlers():
            try:
                return None, drv.localize_via_firmware(1, mzd.PATROL_DEPART_CUTTERHIGH, None)
            except SystemExit as e:
                return e.code, None
    finally:
        mzd.time = real_time


def names(drv):
    return [c[0] for c in drv.calls]


def test_a_sigterm_during_the_departure_stops_and_clears_its_task():
    for when in ("start_cov", "robot_xy", "wait_status"):
        drv = DepartureDriver(sigterm_in=when)
        code, _pos = depart(drv)
        assert code == 143, (when, code)
        n = names(drv)
        assert "stop_task" in n and "quit_mapping_mode" in n, (when, drv.calls)
        assert n.index("start_cov") < n.index("stop_task") < n.index("quit_mapping_mode"), (when, drv.calls)
        # Short service timeouts: the whole release fits well inside the 3 s
        # after which stop_mow_zone and the patrol handler SIGKILL the drive.
        timed = [c for c in drv.calls if c[0] in ("stop_task", "quit_mapping_mode",
                                                   "recharge_active", "wait_status")]
        after_kill = timed[[c[0] for c in timed].index("stop_task") - 1:]
        assert all(c[1] is not None and c[1] <= 1.0 for c in after_kill), (when, after_kill)


def test_an_exception_during_the_departure_stops_and_clears_its_task():
    drv = DepartureDriver(fail_in="robot_xy")
    try:
        with stop_handlers():
            drv.localize_via_firmware(1, mzd.PATROL_DEPART_CUTTERHIGH, None)
    except RuntimeError:
        pass
    else:
        raise AssertionError("the exception must still reach the caller")
    assert names(drv).count("stop_task") == 1 and "quit_mapping_mode" in names(drv), drv.calls


def test_a_sigterm_after_the_handover_does_not_stop_the_task_again():
    drv = DepartureDriver()
    code, _pos = depart(drv, sleep=lambda s: os.kill(os.getpid(), signal.SIGTERM))
    assert code == 143
    assert names(drv).count("stop_task") == 1, drv.calls          # the handover's own stop
    assert [c for c in drv.calls if c[0] == "stop_task"] == [("stop_task", None)], drv.calls


def test_a_sigterm_while_the_robot_reports_a_recharge_does_not_stop_it():
    drv = DepartureDriver(sigterm_in="robot_xy", recharging=True)
    code, _pos = depart(drv)
    assert code == 143
    assert "stop_task" not in names(drv) and "quit_mapping_mode" not in names(drv), drv.calls


# ── A recharge runs from recharge_status 50 up (robot_decision rechargeDeal) ─
# rechargeDeal sets 50 at the start and 51..59 before the AutoCharging goal;
# from 90 the drive to the pile, the search and the alignment (191-193 seen
# mid-dock). It ends below 50: 9 FINISHED, 2 CANCELLED, 1 FAILED (which stays),
# 0 WAIT. Counting 1..8 as driving missed every real drive home and took a
# failed one for one: each drive start after it waited 15 s for a FAILED that
# never changes.

def status_driver(recharge, cls=None):
    """A real Driver whose RobotStatus reads recharge_status `recharge` (None: no status)."""
    drv = (cls or mzd.Driver)(FakeNode(misses=0))
    drv._probe_node = object()        # the probe exists already: no node is made
    drv._recharge = recharge
    return drv


def test_a_recharge_runs_from_recharge_status_50_up():
    with probe_spins(lambda: None):
        for value, running in ((0, False), (1, False), (2, False), (9, False), (10, False), (49, False),
                               (50, True), (53, True), (59, True), (90, True), (191, True), (193, True)):
            assert status_driver(value).recharge_active(timeout=0.5) is running, value
        assert status_driver(None).recharge_active(timeout=0.2) is False   # no RobotStatus at all


class CancelDriver(mzd.Driver):
    """robot_decision as clear_recharge sees it: a cancel ends the recharge as
    CANCELLED (2)."""
    cancels = 0

    def wait_status(self, pred, timeout=30.0):
        return (0, 0)

    def cancel_recharge(self):
        self.cancels += 1
        self._recharge = 2
        return True


def clear_with(recharge):
    """clear_recharge against recharge_status `recharge`: (driver, sleeps)."""
    drv = status_driver(recharge, CancelDriver)
    slept = []
    real = mzd.time
    mzd.time = types.SimpleNamespace(time=time.time, monotonic=time.monotonic, sleep=slept.append)
    try:
        with probe_spins(lambda: None), contextlib.redirect_stdout(io.StringIO()):
            mzd.clear_recharge(drv)
    finally:
        mzd.time = real
    return drv, slept


def test_a_failed_recharge_is_nothing_to_break_off_before_a_drive():
    drv, slept = clear_with(1)          # Recharge: FAILED stays at 1
    assert drv.cancels == 0 and slept == [], (drv.cancels, slept)


def test_a_drive_home_is_broken_off_before_a_drive():
    for value in (53, 191):
        drv, slept = clear_with(value)
        assert drv.cancels == 1 and slept == [], (value, drv.cancels, slept)   # it let go at once


class DepartureDuringRecharge(DepartureDriver):
    """The departure's release with the real recharge test: RobotStatus reads
    recharge_status `recharge`."""
    recharge_active = mzd.Driver.recharge_active

    def __init__(self, recharge, **kw):
        super().__init__(**kw)
        self._probe_node = object()
        self._recharge = recharge


def test_the_release_leaves_a_drive_home_alone_and_stops_after_a_failed_recharge():
    for recharge, left_alone in ((191, True), (53, True), (1, False), (2, False), (9, False)):
        drv = DepartureDuringRecharge(recharge, sigterm_in="robot_xy")
        with probe_spins(lambda: None):
            code, _pos = depart(drv)
        assert code == 143, (recharge, code)
        assert ("stop_task" not in names(drv)) is left_alone, (recharge, drv.calls)


class CheckDriver(CancelDriver):
    """check_mow's view of the mower: localized inside map0, map_server reloads."""

    def robot_xy(self, timeout=6.0):
        return (5.0, 5.0)

    def reload_map(self, map_yaml=None):
        return True, "ok"


def firmware_check(recharge):
    """check_mow's "firmware rijdt niet zelf" line at recharge_status `recharge`."""
    with_maps({"map0_work.csv": SQ0})
    drv = status_driver(recharge, CheckDriver)
    out = io.StringIO()
    real_phase, mzd.phase = mzd.phase, (lambda *a: None)
    try:
        with probe_spins(lambda: None), contextlib.redirect_stdout(out):
            mzd.check_mow(drv, "map0")
    finally:
        mzd.phase = real_phase
    return [line for line in out.getvalue().splitlines() if "firmware rijdt niet zelf" in line]


def test_check_mow_names_a_drive_home_but_not_a_failed_recharge():
    assert [line[:9] for line in firmware_check(1)] == ["CHECK ok "], firmware_check(1)
    assert [line[:10] for line in firmware_check(191)] == ["CHECK FAIL"], firmware_check(191)


def test_a_second_sigterm_does_not_cut_the_release_short():
    # stop_mow_zone sends SIGTERM, and pkill another one 3 s later: the release
    # holds signals, so the second one cannot stop it half way.
    drv = DepartureDriver(sigterm_in="robot_xy")
    drv.fail_in = None
    real_step = drv._step

    def step(name):
        real_step(name)
        if name == "release_stop_task":
            os.kill(os.getpid(), signal.SIGTERM)
    drv._step = step
    code, _pos = depart(drv)
    assert code == 143
    assert "quit_mapping_mode" in names(drv), drv.calls


def test_a_departure_that_hands_over_runs_no_release():
    with_maps({"map0tocharge_unicom.csv": [(0.16, 0.01), (2.0, 3.0)]})   # anchor beside (0, 0)
    drv = DepartureDriver()
    code, pos = depart(drv, sleep=lambda s: None)
    assert code is None and pos == (1.0, 1.0)
    # The handover's own stop and clear, no release after it.
    assert [c for c in drv.calls if c[0] in ("stop_task", "quit_mapping_mode")] == [
        ("stop_task", None), ("quit_mapping_mode", None)], drv.calls
    assert "recharge_active" not in names(drv), drv.calls


# Walter (LFIN2231000367), 2026-10-21: the departure's coverage goal stayed
# paused in coverage_planner_server after the stop and the quit, for hours
# ("total navigation time" counting from 19:30:41). The next start_cov was
# refused ("Can not planning when action working") as error 125, and the
# patrol of 21:30 never left the dock.
def test_the_handover_cancels_the_coverage_goal_the_departure_left():
    with_maps({"map0tocharge_unicom.csv": [(0.16, 0.01), (2.0, 3.0)]})
    drv = DepartureDriver()
    code, _pos = depart(drv, sleep=lambda s: None)
    assert code is None
    n = names(drv)
    # One left over from before (the departure runs on the dock, where nothing
    # drives), and the departure's own after the handover.
    assert n.count("cancel_coverage_goals") == 2, drv.calls
    assert n.index("cancel_coverage_goals") < n.index("start_cov"), drv.calls
    assert n.index("quit_mapping_mode") < len(n) - 1 - n[::-1].index("cancel_coverage_goals"), drv.calls


def test_the_release_clients_are_made_when_the_departure_starts():
    drv = DepartureDriver(sigterm_in="robot_xy")
    depart(drv)
    n = names(drv)
    assert n[0] == "prepare_release" and n.index("prepare_release") < n.index("start_cov"), drv.calls


class ServiceNode:
    """A node whose service clients answer at once. Records every client it makes."""

    def __init__(self):
        self.clients = []

    def create_publisher(self, msg_type, topic, qos):
        return FakePub(0)

    def create_client(self, srv_type, name):
        self.clients.append(name)

        class Client:
            def wait_for_service(self, timeout_sec=0.0):
                return True

            def call_async(self, req):
                return Done(types.SimpleNamespace(success=True))
        return Client()


def test_a_camera_restart_switches_the_camera_behind_the_topic_off_then_on():
    sent = []

    class RecordingNode(ServiceNode):
        def create_client(self, srv_type, name):
            client = super().create_client(srv_type, name)
            call = client.call_async
            client.call_async = lambda req: sent.append((name, req.data)) or call(req)
            return client
    real = (mzd.SetBool, getattr(mzd.rclpy, "spin_until_future_complete", None))
    mzd.SetBool = types.SimpleNamespace(Request=lambda: types.SimpleNamespace(data=None))
    mzd.rclpy.spin_until_future_complete = lambda node, fut, timeout_sec=None: None
    try:
        drv = mzd.Driver(RecordingNode())
        assert drv.restart_camera("front") is True
        assert drv.restart_camera("tof_gray") is True
    finally:
        mzd.SetBool = real[0]
        if real[1] is None:
            del mzd.rclpy.spin_until_future_complete
        else:
            mzd.rclpy.spin_until_future_complete = real[1]
    assert sent == [("/camera/preposition/start_camera", False), ("/camera/preposition/start_camera", True),
                    ("/camera/tof/start_camera", False), ("/camera/tof/start_camera", True)], sent


def test_stop_task_and_quit_mapping_mode_reuse_the_clients_made_at_the_start():
    real = (mzd.SetBool, mzd.Empty, getattr(mzd.rclpy, "spin_until_future_complete", None))
    mzd.SetBool = types.SimpleNamespace(Request=lambda: types.SimpleNamespace(data=None))
    mzd.Empty = types.SimpleNamespace(Request=lambda: object())
    mzd.rclpy.spin_until_future_complete = lambda node, fut, timeout_sec=None: None
    try:
        node = ServiceNode()
        drv = mzd.Driver(node)
        drv._prepare_release()
        made = list(node.clients)
        assert drv.stop_task(timeout=0.3) is True and drv.quit_mapping_mode(timeout=0.3) is True
        assert drv.stop_task() is True and drv.quit_mapping_mode() is True
    finally:
        mzd.SetBool, mzd.Empty = real[0], real[1]
        if real[2] is None:
            del mzd.rclpy.spin_until_future_complete
        else:
            mzd.rclpy.spin_until_future_complete = real[2]
    assert made == [f"{mzd.DECISION}/stop_task", f"{mzd.DECISION}/quit_mapping_mode"], made
    assert node.clients == made, node.clients   # no discovery wait for a new client in the release


def test_an_inherited_ignored_sighup_stays_ignored():
    # Under nohup SIGHUP comes in ignored: a logout must not end the drive.
    real = signal.signal(signal.SIGHUP, signal.SIG_IGN)
    try:
        previous = mzd._install_stop_handlers()
        try:
            assert signal.getsignal(signal.SIGHUP) == signal.SIG_IGN
            assert signal.getsignal(signal.SIGTERM) is mzd._stop_on_signal
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
        signal.signal(signal.SIGHUP, signal.SIG_DFL)
        previous = mzd._install_stop_handlers()
        try:
            assert signal.getsignal(signal.SIGHUP) is mzd._stop_on_signal
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    finally:
        signal.signal(signal.SIGHUP, real)


def test_a_refused_departure_leaves_robot_decision_alone():
    class Refused(DepartureDriver):
        def start_cov(self, map_ids, cutterhigh, direction):
            self.calls.append(("start_cov",))
            return False
    drv = Refused()
    assert depart(drv) == (None, None)
    # The pose before the start, a leftover coverage goal, the start, and no stop, no clear.
    assert names(drv) == ["prepare_release", "robot_xy", "cancel_coverage_goals", "start_cov"], drv.calls


# ── A departure that did not happen is never handed over (#142, custom-49) ──
# In three of Walter's mow attempts the status read (1, 1) or (1, 2) right after
# start_cov, the stop went out at once, "firmware init done" logged the docked
# pose, and nav2 drove the mower off the dock.

class NeverStartsDriver(DepartureDriver):
    """robot_decision takes the start, but its status never shows the task.
    `starts_late`: the task does show up after the wait, so the stop parks it
    (USER_STOP) and the quit clears it."""

    def __init__(self, starts_late=False):
        super().__init__(before=(0.10, 0.09), after=(0.10, 0.09))
        self._status = (mzd.TASK_MODE_COVERAGE, 2)
        self.starts_late = starts_late

    def stop_task(self, timeout=None):
        self.calls.append(("stop_task", timeout))
        if self.starts_late:
            self._status = (mzd.TASK_MODE_COVERAGE, mzd.WORK_STATUS_USER_STOP)
        return True


def test_a_departure_that_never_starts_is_not_handed_over():
    for late in (False, True):
        drv = NeverStartsDriver(starts_late=late)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code, pos = depart(drv, sleep=lambda s: None)
        assert code is None and pos is None, (late, code, pos)
        waits = [c for c in drv.calls if c[0] == "wait_status"]
        assert waits[0] == ("wait_status", mzd.DEPARTURE_START_S), drv.calls
        n = names(drv)
        assert "stop_task" in n, drv.calls                           # the stop still goes out
        assert ("quit_mapping_mode" in n) == late, (late, drv.calls)   # and clears a late task
        assert n.count("cancel_coverage_goals") == (2 if late else 1), (late, drv.calls)   # with its coverage goal
        assert "recharge_active" not in n, drv.calls                 # no release on top of it
        said = out.getvalue()
        assert "firmware task never started (status=(1, 2))" in said, said
        assert "firmware init done" not in said, said


class LateTaskDriver(DepartureDriver):
    """The departure's task shows up only after the 20 s wait, running, on
    status read `shows_on_read` after the first stop (1 is the read right
    after it). That stop found nothing to stop; a stop to a running task parks
    it (USER_STOP). A status read takes 0.2 s and a wait whose condition never
    holds takes its whole timeout (`waits`: timeout, seconds, held).
    `sigterm` delivers a SIGTERM on the read where the task shows up."""

    def __init__(self, shows_on_read=2, sigterm=False):
        super().__init__(before=(0.10, 0.09), after=(0.10, 0.09))
        self._status = (mzd.TASK_MODE_COVERAGE, 2)
        self.shows_on_read, self.sigterm = shows_on_read, sigterm
        self.reads_after_stop = None
        self.waits = []

    def stop_task(self, timeout=None):
        self.calls.append(("stop_task", timeout))
        if mzd.task_executing(*self._status):
            self._status = (mzd.TASK_MODE_COVERAGE, mzd.WORK_STATUS_USER_STOP)
        if self.reads_after_stop is None:
            self.reads_after_stop = 0
        return True

    def _read(self):
        if self.reads_after_stop is not None:
            self.reads_after_stop += 1
            if self.reads_after_stop == self.shows_on_read:
                self._status = (mzd.TASK_MODE_COVERAGE, 92)   # the task shows up, running
                if self.sigterm:
                    os.kill(os.getpid(), signal.SIGTERM)
        return self._status

    def wait_status(self, pred, timeout=30.0):
        self.calls.append(("wait_status", timeout))
        took = 0.0
        while took < timeout:
            took += 0.2
            if pred(*self._read()):
                self.waits.append((timeout, took, True))
                return self._status
        self.waits.append((timeout, timeout, False))
        return self._status


def test_a_departure_task_that_shows_up_after_the_wait_is_stopped_and_cleared():
    # Otherwise it runs on unsupervised: on a patrol the dock zone at 90 mm, at night.
    drv = LateTaskDriver()
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code, pos = depart(drv, sleep=lambda s: None)
    assert code is None and pos is None, (code, pos)
    n = names(drv)
    stops = [i for i, c in enumerate(n) if c == "stop_task"]
    assert len(stops) == 2 and n.index("quit_mapping_mode") > stops[1], drv.calls
    assert drv._status == (mzd.TASK_MODE_COVERAGE, 0), drv._status   # cleared
    assert "firmware task showed up late" in out.getvalue(), out.getvalue()
    assert "recharge_active" not in n, drv.calls   # the drive cleared it itself, no release


def test_a_task_that_shows_up_right_after_the_first_stop_gets_a_stop_of_its_own():
    # Visible on the first read after a stop that found nothing: no USER_STOP
    # will ever come from that stop, and quit_mapping_mode is for a parked task.
    drv = LateTaskDriver(shows_on_read=1)
    code, pos = depart(drv, sleep=lambda s: None)
    assert code is None and pos is None, (code, pos)
    n = names(drv)
    stops = [i for i, c in enumerate(n) if c == "stop_task"]
    assert len(stops) == 2 and n.index("quit_mapping_mode") > stops[1], drv.calls
    # After the second stop: the USER_STOP wait, then the quit on the parked task.
    assert drv.calls[stops[1] + 1] == ("wait_status", 30.0), drv.calls
    assert drv._status == (mzd.TASK_MODE_COVERAGE, 0), drv._status
    # The 20 s wait for the start ran out; no wait after the first stop did.
    assert all(held for _t, _s, held in drv.waits[1:]), drv.waits
    assert sum(s for _t, s, _h in drv.waits[1:]) < 2.0, drv.waits


def test_a_sigterm_while_watching_for_a_late_task_still_stops_it():
    drv = LateTaskDriver(sigterm=True)
    code, _pos = depart(drv, sleep=lambda s: None)
    assert code == 143, code
    # The first stop went out before the task existed: the release sends its own.
    assert [c for c in drv.calls if c[0] == "stop_task"][-1][1] is not None, drv.calls
    assert drv._status == (mzd.TASK_MODE_COVERAGE, 0), drv.calls


class RunDriver(DepartureDriver):
    """robot_decision moves on one state per status read, through `states`,
    until a read finds what it waits for."""

    def __init__(self, states, before, after, merged=0):
        super().__init__(before=before, after=after, merged=merged)
        self._status = (mzd.TASK_MODE_COVERAGE, 2)   # docked, no task yet
        self.states = list(states)

    def wait_status(self, pred, timeout=30.0):
        self.calls.append(("wait_status", timeout))
        while self.states and not pred(*self._status):
            self._status = self.states.pop(0)
        return self._status


DEPARTURE_RUN = [(mzd.TASK_MODE_COVERAGE, ws) for ws in (50, 53, 56, 59)]   # .. INIT_SUCCESS
WALTER_DOCK = {"map0tocharge_unicom.csv": [(0.16, 0.01), (2.0, 3.0)]}      # anchor (0.16, 0.01)


def test_a_departure_that_did_not_move_the_mower_is_not_handed_over():
    with_maps(WALTER_DOCK)
    docked = (0.10346326455538557, 0.08879976553824738)   # Walter's pose on the pile, before and after
    drv = RunDriver(DEPARTURE_RUN, before=docked, after=docked)
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code, pos = depart(drv, sleep=lambda s: None)
    assert code is None and pos is None, pos
    said = out.getvalue()
    assert "departure did not move the mower" in said and "firmware init done" not in said, said
    n = names(drv)   # the task is stopped and cleared as on every handover
    assert n.index("start_cov") < n.index("stop_task") < n.index("quit_mapping_mode"), drv.calls


def test_a_departure_that_moved_the_mower_hands_over_where_it_stands():
    with_maps(WALTER_DOCK)
    drv = RunDriver(DEPARTURE_RUN, before=(0.10, 0.09), after=(1.10, 0.09))
    code, pos = depart(drv, sleep=lambda s: None)
    assert code is None and pos == (1.10, 0.09), pos
    # The pose handed over is read after the stop and the settle, not before.
    n = names(drv)
    assert n[-1] == "robot_xy" and n.index("quit_mapping_mode") < len(n) - 1, drv.calls


def test_a_departure_without_a_frame_before_hands_over_off_the_pile():
    # After a boot there is no map frame before the start: nothing to compare,
    # and a real 1 m departure ends well away from the anchor.
    with_maps(WALTER_DOCK)
    drv = RunDriver(DEPARTURE_RUN, before=None, after=(1.16, 0.09))
    code, pos = depart(drv, sleep=lambda s: None)
    assert code is None and pos == (1.16, 0.09), pos


def test_a_departure_that_ends_on_the_pile_is_not_handed_over_even_without_a_frame_before():
    with_maps(WALTER_DOCK)
    drv = RunDriver(DEPARTURE_RUN, before=None, after=(0.32, 0.01))   # 0.16 m from the anchor
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code, pos = depart(drv, sleep=lambda s: None)
    assert code is None and pos is None, pos
    assert "departure did not move the mower" in out.getvalue(), out.getvalue()


def test_a_departure_from_the_charger_that_did_not_move_is_not_handed_over():
    # The pose says 1.57 m from the anchor, RobotStatus says on the charger.
    with_maps(DOCK_244)
    drv = RunDriver(DEPARTURE_RUN, before=DOCKED_244, after=DOCKED_244,
                    merged=mzd.MERGED_CHARGING)
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code, pos = depart(drv, sleep=lambda s: None)
    assert code is None and pos is None, pos
    assert "departure did not move the mower" in out.getvalue(), out.getvalue()


def test_a_departure_from_the_charger_that_moved_hands_over():
    with_maps(DOCK_244)
    moved = (DOCKED_244[0] + 1.0, DOCKED_244[1])
    drv = RunDriver(DEPARTURE_RUN, before=DOCKED_244, after=moved, merged=mzd.MERGED_CHARGING)
    code, pos = depart(drv, sleep=lambda s: None)
    assert code is None and pos == moved, pos


def test_a_charging_mower_without_a_frame_before_hands_over_once_it_moved():
    # The usual start after a reboot on the dock: charging, no map frame yet.
    # Nothing to compare the pose after the handover with; only the anchor counts.
    with_maps(DOCK_244)
    moved = (DOCKED_244[0] + 1.0, DOCKED_244[1])
    drv = RunDriver(DEPARTURE_RUN, before=None, after=moved, merged=mzd.MERGED_CHARGING)
    code, pos = depart(drv, sleep=lambda s: None)
    assert code is None and pos == moved, pos


def test_a_mower_off_the_pile_is_not_held_to_the_distance():
    # A mow restarted right after a stopped departure: inside the 1.2 m dock
    # disc but 0.9 m from the anchor. Off the pile the firmware's departure
    # does not move it, so it hands over where it stands.
    with_maps(WALTER_DOCK)
    off_pile = (1.06, 0.01)
    drv = RunDriver(DEPARTURE_RUN, before=off_pile, after=off_pile)
    code, pos = depart(drv, sleep=lambda s: None)
    assert code is None and pos == off_pile, pos


def test_without_a_dock_anchor_the_mower_is_not_held_to_the_distance():
    with_maps({})
    docked = (0.10, 0.09)
    drv = RunDriver(DEPARTURE_RUN, before=docked, after=docked)
    code, pos = depart(drv, sleep=lambda s: None)
    assert code is None and pos == docked, pos


class Done:
    """A future that completed with `value`."""

    def __init__(self, value):
        self.value = value

    def done(self):
        return True

    def result(self):
        return self.value


class FakeGoalHandle:
    accepted = True

    def __init__(self, result=None):
        self.cancelled = 0
        self._result = result

    def get_result_async(self):
        return Done(self._result)

    def cancel_goal_async(self):
        self.cancelled += 1
        return Done(object())


@contextlib.contextmanager
def fake_actions(handle, send=Done):
    """nav2's NavigateToPose and FollowPath actions, accepting every goal with
    `handle`; send_goal_async answers with send(handle). Yields the action
    clients made, as (action name, client)."""
    made = []

    class Client:
        def __init__(self, node, action, name):
            made.append((name, self))

        def wait_for_server(self, timeout_sec=0.0):
            return True

        def send_goal_async(self, goal):
            return send(handle)

    ns = types.SimpleNamespace

    def pose():
        return ns(header=ns(frame_id=""), pose=ns(position=ns(x=0.0, y=0.0), orientation=ns(z=0.0, w=1.0)))

    names = ("ActionClient", "NavigateToPose", "FollowPath", "Path", "PoseStamped")
    real = {name: getattr(mzd, name) for name in names}
    real_spin = getattr(mzd.rclpy, "spin_until_future_complete", None)
    mzd.ActionClient = Client
    mzd.NavigateToPose = ns(Goal=lambda: ns(pose=pose()))
    mzd.FollowPath = ns(Goal=lambda: ns(path=None, controller_id="", goal_checker_id=""))
    mzd.Path = lambda: ns(header=ns(frame_id=""), poses=[])
    mzd.PoseStamped = pose
    mzd.rclpy.spin_until_future_complete = lambda node, fut, timeout_sec=None: None
    try:
        yield made
    finally:
        for name, value in real.items():
            setattr(mzd, name, value)
        if real_spin is None:
            del mzd.rclpy.spin_until_future_complete
        else:
            mzd.rclpy.spin_until_future_complete = real_spin


def test_a_drive_holds_the_goal_nav2_took_until_its_result_arrives():
    finished = FakeGoalHandle(result=types.SimpleNamespace(status=4))
    with fake_actions(finished):
        drv = mzd.Driver(FakeNode(misses=0))
        assert drv.nav_to(1.0, 2.0) == (True, "nav_to_pose_status_4")
        assert drv.cancel_own_goal() is False and finished.cancelled == 0   # nothing left to cancel


def test_a_goal_that_outlives_its_wait_is_cancelled_before_the_next_one_replaces_it():
    # A 180 s checkpoint timeout returned with the goal still driving; the next
    # goal then took its place in _goal, so nothing could cancel it any more.
    for drive, timed_out in ((lambda drv: drv.nav_to(1.0, 2.0), "nav_to_pose timeout"),
                             (lambda drv: drv.follow_path([(0.0, 0.0), (1.0, 0.0)]), "no result (timeout)")):
        hanging = FakeGoalHandle(result=None)                 # no result within the wait
        with fake_actions(hanging), contextlib.redirect_stdout(io.StringIO()):
            drv = mzd.Driver(FakeNode(misses=0))
            assert drive(drv) == (False, timed_out)
            assert hanging.cancelled == 1, timed_out            # by its own id, at once
            assert drv.cancel_own_goal() is False and hanging.cancelled == 1, timed_out


class Pending:
    """A result future that never completes: nav2 still driving."""

    def done(self):
        return False

    def result(self):
        return None


class DrivingHandle(FakeGoalHandle):
    def get_result_async(self):
        return Pending()


# Walter (LFIN2231000367), 2026-10-21: nav2 ran 15-23 cm past a goal at
# 0.5 m/s, then tried to reach its yaw (0.1 rad) on the spot and spun a wheel
# for minutes (03:37 and 22:07 at the channel map0->map1, 19:32 at a
# checkpoint). Within ARRIVE_M of the goal the drive ends the goal itself.
def test_a_goal_within_reach_is_ended_by_the_drive_as_arrived():
    driving = WindingDown()
    poses = iter([(5.0, 2.0), (1.5, 2.0), (1.2, 2.1)])
    with fake_actions(driving), contextlib.redirect_stdout(io.StringIO()):
        drv = mzd.Driver(FakeNode(misses=0))
        drv.robot_xy = lambda timeout=6.0: next(poses)
        assert drv.nav_to(1.0, 2.0, arrive_m=mzd.ARRIVE_M) == (True, "arrived")
        assert driving.cancelled == 1                                   # its own goal, once
        assert drv.cancel_own_goal() is False and driving.cancelled == 1


class WindingDown(FakeGoalHandle):
    """nav2 answers a cancel with the goal's result only a few polls later."""

    def __init__(self):
        super().__init__()
        self.polls_after_cancel = 0
        handle = self

        class Result:
            def done(self):
                if handle.cancelled:
                    handle.polls_after_cancel += 1
                return handle.polls_after_cancel >= 3

            def result(self):
                return types.SimpleNamespace(status=5) if self.done() else None
        self._fut = Result()

    def get_result_async(self):
        return self._fut


# Walter (LFIN2231000367), 2026-10-22 22:28:17: nav2 cancelled its own
# FollowPath while it wound the cancelled NavigateToPose down, 40 ms after the
# cancel was answered, and took the channel's FollowPath we had just sent with
# it (followpath_aborted_status_5). An arrival waits for the goal's end.
def test_an_arrival_waits_until_nav2_has_ended_the_goal():
    ending = WindingDown()
    slept = []
    real_time = mzd.time
    mzd.time = types.SimpleNamespace(time=time.time, monotonic=time.monotonic, sleep=slept.append)
    try:
        with fake_actions(ending), contextlib.redirect_stdout(io.StringIO()):
            drv = mzd.Driver(FakeNode(misses=0))
            drv.robot_xy = lambda timeout=6.0: (1.1, 2.0)
            assert drv.nav_to(1.0, 2.0, arrive_m=mzd.ARRIVE_M) == (True, "arrived")
    finally:
        mzd.time = real_time
    assert ending.cancelled == 1 and ending.polls_after_cancel >= 3
    assert slept == [mzd.ARRIVE_SETTLE_S]


def test_a_goal_never_within_reach_still_times_out():
    driving = DrivingHandle()
    with fake_actions(driving), contextlib.redirect_stdout(io.StringIO()):
        drv = mzd.Driver(FakeNode(misses=0))
        drv.robot_xy = lambda timeout=6.0: (9.0, 9.0)
        assert drv.nav_to(1.0, 2.0, timeout=0.05, arrive_m=mzd.ARRIVE_M) == (False, "nav_to_pose timeout")
        assert driving.cancelled == 1


class LateAnswer:
    """send_goal_async's future: no answer within the send's wait, the goal
    handle after it."""

    def __init__(self, handle):
        self.handle, self.reads = handle, 0

    def done(self):
        return self.reads > 0

    def result(self):
        self.reads += 1
        return None if self.reads == 1 else self.handle


NAVS = (lambda drv: drv.nav_to(1.0, 2.0), lambda drv: drv.follow_path([(0.0, 0.0), (1.0, 0.0)]))


def test_a_goal_nav2_takes_only_after_the_send_wait_is_cancelled_too():
    for drive in NAVS:
        handle = FakeGoalHandle()
        with fake_actions(handle, send=LateAnswer), contextlib.redirect_stdout(io.StringIO()):
            drv = mzd.Driver(FakeNode(misses=0))
            assert drive(drv)[0] is False
            assert handle.cancelled == 1 and drv.cancel_own_goal() is False


class Unanswered:
    """send_goal_async's future, answered only when the test says so."""

    def __init__(self, handle):
        self.handle, self.answered = handle, False

    def done(self):
        return self.answered

    def result(self):
        return self.handle if self.answered else None


def unanswered_sends():
    """A send for fake_actions that nav2 does not answer in time, and the sends made."""
    sends = []

    def send(handle):
        sends.append(Unanswered(handle))
        return sends[-1]
    return send, sends


def test_a_send_still_unanswered_after_the_drop_wait_is_kept_for_the_way_out():
    for drive in NAVS:
        handle = FakeGoalHandle()
        send, sends = unanswered_sends()
        with fake_actions(handle, send=send), contextlib.redirect_stdout(io.StringIO()):
            drv = mzd.Driver(FakeNode(misses=0))
            assert drive(drv)[0] is False and handle.cancelled == 0
            sends[-1].answered = True                       # nav2 takes it after all
            assert drv.cancel_own_goal() is True and handle.cancelled == 1


def test_a_sigterm_in_the_drop_wait_leaves_the_send_for_the_way_out():
    handle = FakeGoalHandle()
    send, sends = unanswered_sends()

    def spin(node, fut, timeout_sec=None):
        if timeout_sec == 2.0:          # _drop_goal's wait, mid-drive: signals are not held there
            raise SystemExit(143)
    with fake_actions(handle, send=send), contextlib.redirect_stdout(io.StringIO()):
        drv = mzd.Driver(FakeNode(misses=0))
        mzd.rclpy.spin_until_future_complete = spin
        try:
            drv.nav_to(1.0, 2.0)
        except SystemExit as e:
            assert e.code == 143, e.code
        else:
            raise AssertionError("the SIGTERM must reach the caller")
        mzd.rclpy.spin_until_future_complete = lambda node, fut, timeout_sec=None: None
        sends[-1].answered = True
        assert drv.cancel_own_goal() is True and handle.cancelled == 1   # run()'s exit cancel


def test_repeated_navs_reuse_one_client_per_action():
    finished = FakeGoalHandle(result=types.SimpleNamespace(status=4))
    with fake_actions(finished) as made:
        drv = mzd.Driver(FakeNode(misses=0))
        for _ in range(3):
            assert drv.nav_to(1.0, 2.0)[0] and drv.follow_path([(0.0, 0.0), (1.0, 0.0)])[0]
    assert [name for name, _client in made] == ["/navigate_to_pose", "/follow_path"], made


def test_a_goal_still_being_sent_is_cancelled_once_nav2_took_it():
    handle = FakeGoalHandle()
    with fake_actions(handle):
        drv = mzd.Driver(FakeNode(misses=0))
        drv._goal_send = Done(handle)   # killed between send_goal_async and its answer
        assert drv.cancel_own_goal() is True and handle.cancelled == 1


def patrol_params(zones):
    path = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
    with open(path, "w") as fh:
        json.dump({"run": "1", "zones": zones, "dwell_s": 1, "photo_topic": "front",
                   "upload": "http://srv/u?sn=X&run=1"}, fh)
    return path


class KilledPatrolDriver(PatrolDriver):
    """Killed (SIGTERM) on its way to the first checkpoint."""

    def nav_to(self, x, y, yaw=None, timeout=120.0, arrive_m=None):
        self.events.append(("nav_to", x, y))
        os.kill(os.getpid(), signal.SIGTERM)
        return True, ""


def test_a_killed_patrol_cancels_its_goal_and_switches_the_light_off_on_its_way_out():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = KilledPatrolDriver()
    real = (mzd.phase, mzd.fetch_snapshot, mzd.upload_checkpoint)
    mzd.phase = lambda *a: drv.events.append(("phase",) + a)
    mzd.fetch_snapshot = lambda topic, timeout=25.0: None
    mzd.upload_checkpoint = lambda *a, **k: True
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            mzd.run(drv, ["patrol", patrol_params([{"zone": "map0", "points": [[3, 3], [7, 7]]}])])
    except SystemExit as e:
        code = e.code
    else:
        code = None
    finally:
        mzd.phase, mzd.fetch_snapshot, mzd.upload_checkpoint = real
    assert code == 143, code
    after = drv.events[drv.events.index(("nav_to", 3, 3)) + 1:]
    assert after == [("cancel_own_goal",), ("light", 0)], drv.events
    # run() puts the handlers back: this test process keeps its own SIGTERM.
    assert signal.getsignal(signal.SIGTERM) is not mzd._stop_on_signal


def test_the_light_goes_off_on_the_mower_before_the_end_is_reported():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    cases = [
        (PatrolDriver(), [{"zone": "map0", "points": [[3, 3]]}], ("phase", "done")),
        (NothingReachable(),
         [{"zone": "map0", "points": [[3, 3], [4, 4], [5, 5]]}], ("phase", "error", "checkpoints_unreachable")),
        (PatrolDriver(status=(mzd.TASK_MODE_COVERAGE, 60)),
         [{"zone": "map0", "points": [[3, 3]]}], ("phase", "error", "busy_mowing")),
    ]
    for drv, zones, end in cases:
        run_patrol(drv, zones)
        assert end in drv.events, (end, drv.events)
        assert drv.events.count(("light", 0)) == 1, drv.events
        assert drv.events.index(("light", 0)) < drv.events.index(end), drv.events
        # The publisher exists from the start, so it is matched by the end.
        assert drv.events[0] == ("light_ready",), drv.events


def test_a_patrol_that_cannot_read_its_params_switches_the_light_off_too():
    drv = PatrolDriver()
    real_phase = mzd.phase
    mzd.phase = lambda *a: drv.events.append(("phase",) + a)
    try:
        rc = mzd.run(drv, ["patrol", "/nonexistent/patrol.json"])
    finally:
        mzd.phase = real_phase
    assert rc == 2
    ends = [e for e in drv.events if e[0] in ("light", "phase")]
    assert [e[0] for e in ends] == ["light", "phase"] and ends[1][1] == "error", drv.events


# ── robot_xy reads the pose now, not the one from before a drive ────────────
# Only the main node spins while nav2 drives, so the probe's tf buffer still
# holds the transform from before the drive. In Walter's log (#142, custom-49)
# the pose after every transit hop equals the pose before it to 15 decimals.

def tf_at(x, y, stamp):
    """A map->base_link TransformStamped as tf2's lookup_transform returns it."""
    ns = types.SimpleNamespace
    sec = int(stamp)
    return ns(header=ns(stamp=ns(sec=sec, nanosec=int((stamp - sec) * 1e9))),
              transform=ns(translation=ns(x=x, y=y, z=0.0)))


class FakeTfBuffer:
    """The probe's tf buffer: the newest map->base_link it holds, or tf2's
    exception while it holds none."""

    def __init__(self, held=None):
        self.held = held
        self.lookups = 0

    def lookup_transform(self, target, source, when):
        self.lookups += 1
        if self.held is None:
            raise RuntimeError('"map" passed to lookupTransform argument target_frame does not exist')
        return self.held


@contextlib.contextmanager
def probe_spins(on_spin):
    """Every rclpy.spin_once runs on_spin(); rclpy.time.Time() exists."""
    saved = {k: getattr(mzd.rclpy, k) for k in ("spin_once", "time") if hasattr(mzd.rclpy, k)}
    mzd.rclpy.spin_once = lambda node, timeout_sec=0.0: on_spin()
    mzd.rclpy.time = types.SimpleNamespace(Time=lambda: None)
    try:
        yield
    finally:
        for k in ("spin_once", "time"):
            if k in saved:
                setattr(mzd.rclpy, k, saved[k])
            else:
                delattr(mzd.rclpy, k)


def tf_driver(buf):
    drv = mzd.Driver(FakeNode(misses=0))
    drv._probe_node = object()   # the probe exists already: no node is made
    drv._tf_buf = buf
    return drv


def test_robot_xy_never_returns_the_pose_from_before_a_drive():
    buf = FakeTfBuffer(tf_at(1.46, 0.10, time.time() - 30.0))   # left over from before the hop
    out = io.StringIO()
    with probe_spins(lambda: time.sleep(0.01)), contextlib.redirect_stdout(out):
        assert tf_driver(buf).robot_xy(timeout=0.3) is None
    assert buf.lookups > 1, buf.lookups   # it kept spinning for a fresh one
    said = [line for line in out.getvalue().splitlines() if "robot_xy" in line]
    assert len(said) == 1, said           # once per call, not once per spin
    assert re.search(r"no fresh map->base_link in 0\.3s \(latest 30\.\ds old\)", said[0]), said


def test_robot_xy_takes_the_transform_that_arrives_while_it_spins():
    buf = FakeTfBuffer(tf_at(1.46, 0.10, time.time() - 30.0))
    spins = []

    def spin():   # one queued message per spin; the third is the pose now
        spins.append(1)
        if len(spins) == 3:
            buf.held = tf_at(5.27, 18.6, time.time())
    with probe_spins(spin):
        assert tf_driver(buf).robot_xy(timeout=2.0) == (5.27, 18.6)
    assert len(spins) == 3, spins


def test_robot_xy_accepts_a_transform_from_just_before_the_call():
    # tf lags the wall clock a little: half a second old is still the pose now.
    buf = FakeTfBuffer(tf_at(2.0, 3.0, time.time() - 0.2))
    spins = []
    with probe_spins(lambda: spins.append(1)):
        assert tf_driver(buf).robot_xy(timeout=1.0) == (2.0, 3.0)
    assert len(spins) == 1, spins   # taken on the first spin, no wait for a new sample


def test_robot_xy_takes_a_new_sample_whose_stamp_lags_the_wall_clock():
    # Freshness by the wall clock alone would refuse every pose if the tf stamps
    # ran 2 s behind it. A sample that arrives during the call proves the
    # buffer is live, whatever its stamp says.
    buf = FakeTfBuffer(tf_at(1.46, 0.10, time.time() - 30.0))
    spins = []

    def spin():
        spins.append(1)
        if len(spins) == 2:
            buf.held = tf_at(5.27, 18.6, time.time() - 2.0)
    with probe_spins(spin):
        assert tf_driver(buf).robot_xy(timeout=1.0) == (5.27, 18.6)
    assert len(spins) == 2, spins
    # The same lag with no new sample: a dead buffer, not the pose now.
    buf = FakeTfBuffer(tf_at(5.27, 18.6, time.time() - 2.0))
    out = io.StringIO()
    with probe_spins(lambda: time.sleep(0.01)), contextlib.redirect_stdout(out):
        assert tf_driver(buf).robot_xy(timeout=0.3) is None
    assert out.getvalue().count("robot_xy: no fresh map->base_link") == 1, out.getvalue()


class ThenThrows(FakeTfBuffer):
    """Holds a transform at the call; every lookup after that throws (tf2's
    extrapolation error once newer samples pruned the old ones)."""

    def lookup_transform(self, target, source, when):
        self.lookups += 1
        if self.lookups > 1:
            raise RuntimeError("Lookup would require extrapolation into the past")
        return self.held


def test_robot_xy_says_so_when_the_held_transform_stops_resolving():
    buf = ThenThrows(tf_at(1.46, 0.10, time.time() - 30.0))
    out = io.StringIO()
    with probe_spins(lambda: time.sleep(0.01)), contextlib.redirect_stdout(out):
        assert tf_driver(buf).robot_xy(timeout=0.3) is None
    said = [line for line in out.getvalue().splitlines() if "robot_xy" in line]
    assert len(said) == 1 and re.search(r"\(latest 30\.\ds old\)", said[0]), said


def test_robot_xy_without_a_map_frame_is_none_and_quiet():
    # After a boot there is no map frame at all. The callers say so; the
    # departure's frame wait asks every 2 s, so this stays silent.
    buf = FakeTfBuffer(None)
    out = io.StringIO()
    with probe_spins(lambda: time.sleep(0.01)), contextlib.redirect_stdout(out):
        assert tf_driver(buf).robot_xy(timeout=0.2) is None
    assert out.getvalue() == "", out.getvalue()


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all patrol checks passed")
