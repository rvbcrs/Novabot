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
    "rclpy.qos": ["QoSProfile"],
    "rclpy.action": ["ActionClient"],
}.items():
    for a in attrs:
        setattr(sys.modules[mod], a, type(a, (), {}))

# QoSProfile/QoSHistoryPolicy worden op moduleniveau gebruikt (TF_QOS), dus de
# stub moet echte attributen hebben in plaats van een kale klasse.
sys.modules["rclpy.qos"].QoSHistoryPolicy = type("QoSHistoryPolicy", (), {"KEEP_LAST": 1, "KEEP_ALL": 0})
sys.modules["rclpy.qos"].QoSProfile = lambda **kw: kw

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


RAMON = [   # de echte kanalen op LFIN2230700238, 2026-09-14
    "map0tocharge_unicom.csv",
    "map0tomap3_0_unicom.csv",
    "map1tomap0_0_unicom.csv",
    "map2tomap1_0_unicom.csv",
    "map4tomap1_0_unicom.csv",
    "map5tomap4_0_unicom.csv",
    "map6tomap5_0_unicom.csv",
]


def test_a_channel_is_drivable_in_both_directions():
    g = mzd.channel_graph(["map1tomap0_0_unicom.csv"])
    assert g == {"map0": {"map1": "map1tomap0_0_unicom.csv"},
                 "map1": {"map0": "map1tomap0_0_unicom.csv"}}
    # to-charge en rommel horen er niet in
    assert mzd.channel_graph(["map0tocharge_unicom.csv", "map0_work.csv"]) == {}


def test_route_chains_the_recorded_channels():
    g = mzd.channel_graph(RAMON)
    # Geen directe map0->map6, wel een ketting van vier.
    assert mzd.channel_route("map0", "map6", g) == [
        "map1tomap0_0_unicom.csv",
        "map4tomap1_0_unicom.csv",
        "map5tomap4_0_unicom.csv",
        "map6tomap5_0_unicom.csv",
    ]
    # en andersom net zo lang
    assert len(mzd.channel_route("map6", "map0", g)) == 4
    # één hop blijft één hop
    assert mzd.channel_route("map0", "map1", g) == ["map1tomap0_0_unicom.csv"]


def test_route_is_the_shortest_one():
    g = mzd.channel_graph(RAMON + ["map0tomap5_0_unicom.csv"])
    # Met een snelweg map0-map5 erbij is map6 in twee hops te doen.
    assert mzd.channel_route("map0", "map6", g) == [
        "map0tomap5_0_unicom.csv", "map6tomap5_0_unicom.csv",
    ]


def test_no_route_when_the_zone_is_not_connected():
    g = mzd.channel_graph(RAMON)
    assert mzd.channel_route("map0", "map9", g) == []
    assert mzd.channel_route("map0", "map0", g) == []
    assert mzd.channel_route(None, "map6", g) == []


def test_channel_files_reads_the_route_from_disk():
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


def test_lead_in_starts_the_path_at_the_mower():
    # Precies de live-situatie: map1tomap0 is twee punten, de maaier stond er
    # 3,02 m vandaan en nav2 hield 0 poses over (2026-09-14).
    robot = (-0.19, 2.88)
    channel = [(2.24, 4.68), (3.93, 5.87)]
    out = mzd._lead_in(channel, robot)
    assert out[0] == robot and out[1:] == channel

def test_lead_in_adds_nothing_when_the_mower_is_already_on_the_path():
    robot = (2.25, 4.68)
    channel = [(2.24, 4.68), (3.93, 5.87)]
    assert mzd._lead_in(channel, robot) == channel

def test_lead_in_is_harmless_without_a_position_or_path():
    assert mzd._lead_in([(1.0, 1.0)], None) == [(1.0, 1.0)]
    assert mzd._lead_in([], (0.0, 0.0)) == []

def test_the_transit_is_on_by_default():
    # Een kanaal bestaat om gevolgd te worden; de firmware kent ze niet.
    assert mzd.USE_TRANSIT is True
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6,
               "map0tomap6_0_unicom.csv": [(9, 5), (31, 5)]})
    assert mzd._channel_files("map0", "map6") == ["map0tomap6_0_unicom.csv"]


def test_the_switch_hands_routing_back_to_the_firmware():
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6,
               "map0tomap6_0_unicom.csv": [(9, 5), (31, 5)]})
    mzd.USE_TRANSIT = False
    try:
        assert mzd._channel_files("map0", "map6") == []
    finally:
        mzd.USE_TRANSIT = True


def test_a_long_approach_goes_through_the_planner():
    # Een rechte lijn vanaf een willekeurige plek loopt tegen het dock: de
    # controller meldde "detected collision ahead" en gaf het binnen een tiende
    # seconde op (live, 2026-09-14). Boven LEAD_IN_MAX_M plant nav2 het.
    assert mzd.LEAD_IN_MAX_M <= 1.0
    assert mzd._dist((-0.41, 1.32), (2.24, 4.68)) > mzd.LEAD_IN_MAX_M


def test_a_short_approach_is_just_prepended():
    # Vlak bij het kanaal is een rechte lijn prima en scheelt een planner-ronde.
    # Tussen min_gap (0,3 m) en LEAD_IN_MAX_M: zelf doen, wel met aanloop.
    robot = (1.84, 4.68)
    channel = [(2.24, 4.68), (3.93, 5.87)]
    gap = mzd._dist(robot, channel[0])
    assert 0.3 < gap < mzd.LEAD_IN_MAX_M, gap
    assert mzd._lead_in(channel, robot)[0] == robot

    # Staat hij er al bovenop, dan voegen we niets toe.
    opdepunt = (2.25, 4.68)
    assert mzd._lead_in(channel, opdepunt) == channel


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
