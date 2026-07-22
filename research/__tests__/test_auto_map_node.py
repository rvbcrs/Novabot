#!/usr/bin/env python3
"""Self-check voor de pure helpers van research/auto_map_node.py.
Run: python3 research/__tests__/test_auto_map_node.py"""
import importlib.util, math, os

spec = importlib.util.spec_from_file_location(
    "amn", os.path.join(os.path.dirname(__file__), "..", "auto_map_node.py"))
amn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(amn)


def test_goal_yaml():
    y = amn.boundary_goal_yaml()
    assert "follow_mode: 0" in y, y
    assert "start_follow_wait: false" in y, y


def test_haversine_known_distance():
    # 0.001 graad breedte ≈ 111.19 m
    d = amn.haversine_m(52.0, 5.0, 52.001, 5.0)
    assert abs(d - 111.19) < 0.5, d
    assert amn.haversine_m(52.0, 5.0, 52.0, 5.0) == 0.0


def test_parse_action_result_success():
    text = (
        "Waiting for an action server to become available...\n"
        "Sending goal:\n     follow_mode: 0\n\n"
        "Goal accepted with ID: c3d4\n\n"
        "Result:\n    result: 0\n\n"
        "Goal finished with status: SUCCEEDED\n")
    status, code = amn.parse_action_result(text)
    assert status == "SUCCEEDED"
    assert code == 0


def test_parse_action_result_follow_failed():
    text = "Result:\n    result: 3\n\nGoal finished with status: ABORTED\n"
    status, code = amn.parse_action_result(text)
    assert status == "ABORTED"
    assert code == 3
    assert amn.RESULT_NAMES[code] == "FOLLOW_FAILED"


def test_parse_action_result_incomplete():
    assert amn.parse_action_result("Waiting for an action server...") == (None, None)


if __name__ == "__main__":
    test_goal_yaml()
    test_haversine_known_distance()
    test_parse_action_result_success()
    test_parse_action_result_follow_failed()
    test_parse_action_result_incomplete()
    print("OK - alle auto_map_node helper-tests geslaagd")
