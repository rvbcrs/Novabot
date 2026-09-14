#!/usr/bin/env python3
"""Self-check for the zone selection in research/mow_zone_drive.py.

The selection is a decimal positional bitmask: map0 = 1, map1 = 10, map2 = 100.
robot_decision refuses anything above 60000 (or exactly 255) before decoding it
and substitutes a test task, which is the error 125 users hit from slot 5 up.
Those selections have to go out as a list of map files instead.

Run: python3 research/__tests__/test_map_names_selection.py
"""
import importlib.util
import os
import sys
import types

# mow_zone_drive imports rclpy and the mower's ROS messages at module level;
# stub them so the pure selection helpers can be checked off the mower.
for name in ["rclpy", "rclpy.node", "rclpy.action", "rclpy.qos",
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
}.items():
    for a in attrs:
        setattr(sys.modules[mod], a, type(a, (), {}))
sys.modules["rclpy"].node = sys.modules["rclpy.node"]
setattr(sys.modules["rclpy.node"], "Node", type("Node", (), {}))
setattr(sys.modules["rclpy.action"], "ActionClient", type("ActionClient", (), {}))
setattr(sys.modules["tf2_ros"], "Buffer", type("Buffer", (), {}))
setattr(sys.modules["tf2_ros"], "TransformListener", type("TransformListener", (), {}))

spec = importlib.util.spec_from_file_location(
    "mzd", os.path.join(os.path.dirname(__file__), "..", "mow_zone_drive.py"))
mzd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mzd)


def test_bitmask_decodes_to_slots():
    assert mzd.slots_from_map_ids(1) == [0]
    assert mzd.slots_from_map_ids(1000) == [3]
    assert mzd.slots_from_map_ids(100000) == [5]
    assert mzd.slots_from_map_ids(11111) == [0, 1, 2, 3, 4]
    assert mzd.slots_from_map_ids(100001) == [0, 5]


def test_zones_up_to_slot_4_keep_using_the_number():
    # 11111 is all five reachable zones at once and stays under the limit.
    for map_ids in (1, 10, 100, 1000, 10000, 11111):
        assert mzd.map_names_for(map_ids) == [], map_ids


def test_slot_5_and_up_switch_to_file_names():
    assert mzd.map_names_for(100000) == ["map5.yaml"]
    assert mzd.map_names_for(1000000) == ["map6.yaml"]
    assert mzd.map_names_for(100001) == ["map0.yaml", "map5.yaml"]


def test_the_255_special_case_also_switches():
    # coverRequestDataInit rejects exactly 255 as well, so it must not go out
    # as a number either.
    assert mzd.map_names_for(255) == ["map0.yaml", "map1.yaml", "map2.yaml"]


def test_names_carry_the_yaml_extension():
    # The bare name is what produced error 118; access() needs the real file.
    for name in mzd.map_names_for(100000) + mzd.map_names_for(1000000):
        assert name.endswith(".yaml"), name


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all zone-selection checks passed")
