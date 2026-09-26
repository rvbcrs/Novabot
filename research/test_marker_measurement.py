"""Run on a laptop: python3 research/test_marker_measurement.py (no ROS required)."""
import importlib.util
import json
import math
import os
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("marker_commands", os.path.join(os.path.dirname(__file__), "extended_commands.py"))
commands = importlib.util.module_from_spec(spec)
spec.loader.exec_module(commands)


def pose(transform):
    p, q = transform
    return {"position": dict(zip("xyz", p)), "orientation": dict(zip("xyzw", q))}


def header(t, frame):
    return {"stamp": {"sec": int(t), "nanosec": round((t % 1) * 1e9)}, "frame_id": frame}


def capture():
    # Deliberately nonzero roll, pitch and lever arm: yaw-only math must fail this test.
    q = commands._marker_qmul((0, 0, math.sin(.6), math.cos(.6)),
                             commands._marker_qmul((math.sin(.1), 0, 0, math.cos(.1)),
                                                   (0, math.sin(.15), 0, math.cos(.15))))
    map_base = ((3, -2, .1), q)
    base_gps = ((.186, 0, .15), (0, 0, 0, 1))
    base_tag = ((1.1, .03, .15), (0, 0, math.sin(.2), math.cos(.2)))
    map_gps = commands._marker_compose(map_base, base_gps)
    tag_base = commands._marker_inverse(base_tag)
    out = {"/tf_static": {"gps_link": {
        "header": header(0, "base_link"), "child_frame_id": "gps_link",
        "transform": {"translation": pose(base_gps)["position"], "rotation": pose(base_gps)["orientation"]}}}}
    for i in range(35):
        t = 99.8 + i * .2
        def add(topic, data):
            out.setdefault(topic, []).append({"received": t + .01, "data": data})
        add("/aruco/pose", {"header": header(t, "aruco_tag"), "pose": pose(tag_base)})
        add("/robot_combination_localization/odom", {
            "header": header(t, "map"), "child_frame_id": "gps_link",
            "pose": {"pose": pose(map_gps)},
            "twist": {"twist": {"linear": dict.fromkeys("xyz", 0), "angular": dict.fromkeys("xyz", 0)}}})
        add("/robot_decision/map_position", pose(map_base))
        add("/bestpos_parsed_data", {"header": header(t, "gps_link"), "qual": 4})
        add("/robot_combination_localization/combination_status", {"status": 200})
        add("/robot_decision/robot_status", {"merged_work_status": 0, "error_status": 0})
    return out, commands._marker_compose(map_base, base_tag)


class MarkerMeasurementTest(unittest.TestCase):
    def test_full_se3_vehicle_offset_and_inverse(self):
        samples, expected = capture()
        result = commands._marker_measurement_result(samples, 100, 106)
        for key, value in zip("xyz", expected[0]):
            self.assertAlmostEqual(result["marker"][key], value, places=12)
        self.assertAlmostEqual(result["marker"]["yaw"], commands._marker_yaw(expected[1]), places=12)
        self.assertAlmostEqual(result["base"]["x"], 3)
        self.assertGreaterEqual(result["unique_stamps"], 20)

    def test_stale_repeated_and_unpaired_images_fail(self):
        for kind in ("old", "repeated", "unpaired"):
            with self.subTest(kind=kind):
                samples, _ = capture()
                for row in samples["/aruco/pose"]:
                    if kind == "old":
                        row["received"] += 2
                    elif kind == "repeated":
                        row["data"]["header"] = header(100, "aruco_tag")
                if kind == "unpaired":
                    samples["/robot_combination_localization/odom"] = samples["/robot_combination_localization/odom"][:1]
                with self.assertRaises(ValueError):
                    commands._marker_measurement_result(samples, 100, 106)

    def test_one_bad_health_sample_motion_or_wrong_map_fails(self):
        for kind in ("float", "jump", "active", "moving", "wrong_map", "stale_rtk"):
            with self.subTest(kind=kind):
                samples, _ = capture()
                if kind == "float":
                    samples["/bestpos_parsed_data"][15]["data"]["qual"] = 5
                elif kind == "jump":
                    samples["/robot_combination_localization/combination_status"][15]["data"]["status"] = 6
                elif kind == "active":
                    samples["/robot_decision/robot_status"][15]["data"]["merged_work_status"] = 2
                elif kind == "moving":
                    samples["/robot_combination_localization/odom"][15]["data"]["twist"]["twist"]["linear"]["x"] = .1
                elif kind == "wrong_map":
                    samples["/robot_decision/map_position"][15]["data"]["position"]["x"] += .2
                else:
                    for row in samples["/bestpos_parsed_data"]:
                        row["data"]["header"] = header(99.8, "gps_link")
                with self.assertRaises(ValueError):
                    commands._marker_measurement_result(samples, 100, 106)

    def test_fingerprint_checks_native_dock_and_dispatcher_checks_frame(self):
        with tempfile.TemporaryDirectory() as directory:
            home = os.path.join(directory, "maps", "home0")
            os.makedirs(os.path.join(home, "csv_file"))
            origin = os.path.join(directory, "pos.json")
            dock_yaml = os.path.join(directory, "charging.yaml")
            with open(origin, "w") as fh:
                json.dump({"utm_origin": {"x": 310000, "y": 5780000, "z": 0, "utm_zone": 32}}, fh)
            with open(os.path.join(home, "csv_file", "map_info.json"), "w") as fh:
                json.dump({"charging_pose": {"x": .03, "y": .73, "orientation": -1.5}}, fh)
            with open(dock_yaml, "w") as fh:
                fh.write("charging_pose: [0.03, 0.73, -1.5]\n")
            with patch.object(commands, "MAPS_HOME", home), patch.object(commands, "MAP_POS_FILE", origin), patch.object(commands, "MAP_CHARGING_STATION_FILE", dock_yaml):
                before = commands._marker_frame_fingerprint()
                self.assertEqual(len(before), 64)
                with open(dock_yaml, "w") as fh:
                    fh.write("charging_pose: [1.03, 0.73, -1.5]\n")
                with self.assertRaises(ValueError):
                    commands._marker_frame_fingerprint()
        replies = []
        with patch.object(commands, "_coverage_is_active", return_value=False), patch.object(commands, "_marker_frame_fingerprint", side_effect=["a", "b"]), patch.object(commands, "_capture_dock_marker", return_value={"result": 0}):
            commands.run_extended_command("measure_dock_marker", commands.handle_measure_dock_marker,
                                          {"operation_id": "test-op"}, lambda key, value: replies.append(value))
        self.assertEqual(replies[0]["result"], 1)
        self.assertEqual(replies[0]["operation_id"], "test-op")
        self.assertIn("measure_dock_marker", commands._MAP_OPERATION_COMMANDS)

    def test_detector_is_disabled_after_capture_failure_without_motion_publishers(self):
        callbacks, toggles, cleanup = {}, [], []

        class Context:
            def shutdown(self):
                cleanup.append("context")

        class Client:
            def wait_for_service(self, **kwargs):
                return True

            def call_async(self, request):
                toggles.append(request.data)
                return types.SimpleNamespace(done=lambda: True, result=lambda: types.SimpleNamespace(success=True))

        class Node:
            def create_subscription(self, kind, topic, callback, qos):
                callbacks[topic] = callback

            def create_client(self, kind, topic):
                self_topic = "/enable_aruco_localization"
                if topic != self_topic:
                    raise AssertionError("unexpected service: " + topic)
                return Client()

            def destroy_node(self):
                cleanup.append("node")

        class Executor:
            def __init__(self, **kwargs):
                pass

            def add_node(self, node):
                pass

            def remove_node(self, node):
                pass

            def spin_until_future_complete(self, future, **kwargs):
                pass

            def spin_once(self, **kwargs):
                callbacks["/bestpos_parsed_data"]({"qual": 4})
                callbacks["/robot_combination_localization/combination_status"]({"status": 200})
                callbacks["/robot_decision/robot_status"]({"merged_work_status": 0, "error_status": 0})

            def shutdown(self):
                cleanup.append("executor")

        ns = types.SimpleNamespace
        modules = {"rclpy": ns(init=lambda **kw: None, create_node=lambda *a, **kw: Node()),
                   "rclpy.context": ns(Context=Context),
                   "rclpy.executors": ns(SingleThreadedExecutor=Executor),
                   "rclpy.qos": ns(QoSProfile=lambda **kw: None, ReliabilityPolicy=ns(BEST_EFFORT=1, RELIABLE=2), DurabilityPolicy=ns(TRANSIENT_LOCAL=1)),
                   "rosidl_runtime_py.utilities": ns(get_message=lambda kind: object),
                   "rosidl_runtime_py.convert": ns(message_to_ordereddict=lambda value: value),
                   "std_srvs.srv": ns(SetBool=ns(Request=lambda: ns(data=False)))}
        with patch.dict("sys.modules", modules), patch.object(commands.time, "time", return_value=100), patch.object(commands.time, "monotonic", side_effect=iter(range(100))):
            with self.assertRaisesRegex(ValueError, "static transform missing"):
                commands._capture_dock_marker()
        self.assertEqual(toggles, [True, False])
        self.assertEqual(cleanup, ["node", "executor", "context"])


if __name__ == "__main__":
    unittest.main()
