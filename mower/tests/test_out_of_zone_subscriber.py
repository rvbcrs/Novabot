from pathlib import Path

ROBOT_DECISION = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_subscribes_to_bool_out_of_zone():
    src = ROBOT_DECISION.read_text()
    assert "'/decision_assistant/robot_out_working_zone'" in src
    # callback name registered
    assert '_on_out_of_zone' in src or '_on_robot_out_of_zone' in src
