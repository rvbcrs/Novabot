#!/usr/bin/env python3
"""Self-check for the start decision in research/mow_zone_drive.py.

A mower that boots on the dock has no map frame yet. robot_decision builds
that frame at the start of every task, so the orchestrator only needs the
init-then-stop dance when a recorded channel has to be driven afterwards.
Without such a channel the firmware task is the mow itself; starting it only
to stop and restart it produced "Cannot start a new task when last task is
executing" (live LFIN2230700238, 2026-09-14).

Run: python3 research/__tests__/test_mow_zone_handover.py
"""
import importlib.util
import os
import sys
import tempfile
import types

for name in ["rclpy", "rclpy.node", "rclpy.action", "rclpy.qos", "rclpy.time",
             "rcl_interfaces", "rcl_interfaces.srv", "rcl_interfaces.msg",
             "decision_msgs", "decision_msgs.srv", "decision_msgs.msg",
             "std_msgs", "std_msgs.msg", "std_srvs", "std_srvs.srv",
             "geometry_msgs", "geometry_msgs.msg",
             "nav_msgs", "nav_msgs.msg", "nav2_msgs", "nav2_msgs.action",
             "coverage_planner", "coverage_planner.action", "action_msgs",
             "action_msgs.msg", "tf2_ros", "builtin_interfaces",
             "builtin_interfaces.msg"]:
    sys.modules.setdefault(name, types.ModuleType(name))
for mod, attrs in {
    "decision_msgs.srv": ["StartCoverageTask"],
    "decision_msgs.msg": ["RobotStatus"],
    "std_srvs.srv": ["Trigger", "SetBool", "Empty"],
    "geometry_msgs.msg": ["PoseStamped", "Point", "Twist"],
    "nav_msgs.msg": ["Path", "Odometry"],
    "nav2_msgs.action": ["FollowPath", "NavigateToPose"],
    "coverage_planner.action": ["NavigateThroughCoveragePaths"],
    "action_msgs.msg": ["GoalStatus"],
    "builtin_interfaces.msg": ["Duration"],
    "rcl_interfaces.srv": ["SetParameters", "GetParameters"],
    "rcl_interfaces.msg": ["Parameter", "ParameterValue", "ParameterType"],
    "std_msgs.msg": ["UInt8"],
    "rclpy.qos": ["QoSProfile", "QoSHistoryPolicy"],
    "rclpy.action": ["ActionClient"],
}.items():
    for a in attrs:
        setattr(sys.modules[mod], a, type(a, (), {}))

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


SQ0 = [(0, 0), (10, 0), (10, 10), (0, 10)]       # map0, dock at (0.5, 0.7)
SQ6 = [(30, 0), (40, 0), (40, 10), (30, 10)]     # map6, elsewhere


def test_dock_zone_follows_the_anchor():
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6,
               "map0tocharge_unicom.csv": [(0.5, 0.7), (2, 3)]})
    assert mzd._dock_zone() == "map0"


def test_no_anchor_means_no_dock_zone():
    with_maps({"map0_work.csv": SQ0})
    assert mzd._dock_zone() is None


def test_channel_files_match_the_transit_pattern():
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6,
               "map0tomap6_0_unicom.csv": [(9, 5), (31, 5)],
               "map6tomap0_0_unicom.csv": [(31, 5), (9, 5)],
               "map0tomap3_0_unicom.csv": [(9, 5), (20, 5)]})
    assert mzd._channel_files("map0", "map6") == ["map0tomap6_0_unicom.csv"]
    assert mzd._channel_files("map0", "map0") == []
    assert mzd._channel_files(None, "map6") == []
    assert mzd._channel_files("dock", "map6") == []


class FakeDriver:
    def __init__(self, localized=None, status=(0, 0)):
        self.calls = []
        self._loc = localized
        self._status = status

    def robot_xy(self, timeout=6.0):
        return self._loc

    def wait_status(self, pred, timeout=30.0):
        return self._status

    def quit_mapping_mode(self):
        self.calls.append(("quit_mapping_mode",))
        self._status = (mzd.TASK_MODE_COVERAGE, 0)
        return True

    def start_cov(self, map_ids, cutterhigh, direction):
        self.calls.append(("start_cov", map_ids))
        return True

    def localize_via_firmware(self, *a):
        self.calls.append(("localize",))
        return (0.0, 1.9)


def test_without_channel_the_firmware_runs_the_whole_task():
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6,
               "map0tocharge_unicom.csv": [(0.5, 0.7), (2, 3)]})
    drv = FakeDriver(localized=None)
    assert mzd.do_mow(drv, "map6", 1000000, 6, None) == 0
    assert drv.calls == [("start_cov", 1000000)]      # one start, no init dance


def test_a_parked_task_is_cleared_before_the_start():
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6,
               "map0tocharge_unicom.csv": [(0.5, 0.7), (2, 3)]})
    # USER_STOP left behind by an earlier attempt: start_cov would be refused.
    drv = FakeDriver(localized=None, status=(mzd.TASK_MODE_COVERAGE, mzd.WORK_STATUS_USER_STOP))
    assert mzd.do_mow(drv, "map6", 1000000, 6, None) == 0
    assert drv.calls == [("quit_mapping_mode",), ("start_cov", 1000000)]


def test_nothing_parked_means_no_quit_call():
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6,
               "map0tocharge_unicom.csv": [(0.5, 0.7), (2, 3)]})
    drv = FakeDriver(localized=None, status=(mzd.TASK_MODE_COVERAGE, 9))
    assert mzd.do_mow(drv, "map6", 1000000, 6, None) == 0
    assert drv.calls == [("start_cov", 1000000)]


def test_executing_gate_matches_the_firmware_rule():
    ex = mzd.task_executing
    assert ex(mzd.TASK_MODE_COVERAGE, mzd.WORK_STATUS_USER_STOP)   # parked = still executing
    assert ex(mzd.TASK_MODE_COVERAGE, 20)
    assert not ex(mzd.TASK_MODE_COVERAGE, 9)                       # charging / wait
    assert not ex(0, 20)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all handover checks passed")
