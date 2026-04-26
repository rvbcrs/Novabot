"""Host node creates action clients to the assistant namespace, exact-match
the closed C++ binary so nav2/coverage_planner can drive them. We assert via
text inspection of robot_decision.py because the constructor does ROS work."""
from pathlib import Path

ROBOT_DECISION = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_main_node_has_slipping_escape_action_client():
    src = ROBOT_DECISION.read_text()
    assert "'/decision_assistant/slipping_escape'" in src, (
        'robot_decision must register an ActionClient to '
        '/decision_assistant/slipping_escape so it can auto-trigger slip '
        'escape (closed binary calls this from the main loop).')


def test_main_node_has_loc_recover_moving_action_client():
    src = ROBOT_DECISION.read_text()
    assert "'/decision_assistant/loc_recover_moving'" in src
