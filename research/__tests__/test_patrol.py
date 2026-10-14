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
        self.events = []                 # headlight levels and phases, in order (run_patrol)

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
    mzd.phase = lambda *a: seen.append(a) or drv.events.append(("phase",) + a)
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
    `fail_in` the one that raises instead."""

    def __init__(self, sigterm_in=None, fail_in=None, recharging=False):
        self.calls = []
        self.sigterm_in, self.fail_in, self.recharging = sigterm_in, fail_in, recharging
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
        self._step("start_cov")
        return True

    def robot_xy(self, timeout=6.0):
        self.calls.append(("robot_xy",))
        self._step("robot_xy")
        return (1.0, 1.0)

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
    drv = DepartureDriver()
    code, pos = depart(drv, sleep=lambda s: None)
    assert code is None and pos == (1.0, 1.0)
    # The handover's own stop and clear, no release after it.
    assert [c for c in drv.calls if c[0] in ("stop_task", "quit_mapping_mode")] == [
        ("stop_task", None), ("quit_mapping_mode", None)], drv.calls
    assert "recharge_active" not in names(drv), drv.calls


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
    assert names(drv) == ["prepare_release", "start_cov"], drv.calls   # no stop, no clear


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
def fake_actions(handle):
    """nav2's NavigateToPose action, accepting every goal with `handle`."""
    class Client:
        def __init__(self, node, action, name):
            pass

        def wait_for_server(self, timeout_sec=0.0):
            return True

        def send_goal_async(self, goal):
            return Done(handle)

    def goal():
        ns = types.SimpleNamespace
        return ns(pose=ns(header=ns(frame_id=""), pose=ns(position=ns(x=0.0, y=0.0),
                                                          orientation=ns(z=0.0, w=1.0))))

    real = (mzd.ActionClient, mzd.NavigateToPose, getattr(mzd.rclpy, "spin_until_future_complete", None))
    mzd.ActionClient = Client
    mzd.NavigateToPose = types.SimpleNamespace(Goal=goal)
    mzd.rclpy.spin_until_future_complete = lambda node, fut, timeout_sec=None: None
    try:
        yield
    finally:
        mzd.ActionClient, mzd.NavigateToPose = real[0], real[1]
        if real[2] is None:
            del mzd.rclpy.spin_until_future_complete
        else:
            mzd.rclpy.spin_until_future_complete = real[2]


def test_a_drive_holds_the_goal_nav2_took_until_its_result_arrives():
    finished = FakeGoalHandle(result=types.SimpleNamespace(status=4))
    with fake_actions(finished):
        drv = mzd.Driver(FakeNode(misses=0))
        assert drv.nav_to(1.0, 2.0) == (True, "nav_to_pose_status_4")
        assert drv.cancel_own_goal() is False and finished.cancelled == 0   # nothing left to cancel
    hanging = FakeGoalHandle(result=None)                                 # no result within the timeout
    with fake_actions(hanging):
        drv = mzd.Driver(FakeNode(misses=0))
        assert drv.nav_to(1.0, 2.0) == (False, "nav_to_pose timeout")
        # On its way out the drive cancels that goal, by its own id, once.
        assert drv.cancel_own_goal() is True and hanging.cancelled == 1
        assert drv.cancel_own_goal() is False and hanging.cancelled == 1


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

    def nav_to(self, x, y, yaw=None, timeout=120.0):
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
        (PatrolDriver(unreachable=[(3, 3), (4, 4), (5, 5)]),
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


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all patrol checks passed")
