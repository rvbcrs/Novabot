"""When _on_motor_current detects slip, host node must SEND a SlipEscaping
goal (not just publish move_abnormal). We test this by reading source — full
integration verifies via runtime smoke."""
from pathlib import Path

DA = Path(__file__).resolve().parents[1] / 'decision_assistant.py'
RD = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_slip_detection_calls_send_slip_goal():
    src = DA.read_text()
    assert '_send_slip_goal' in src or 'slip_escape_client.send_goal' in src, (
        'On slip detection the assistant must trigger a SlipEscaping goal '
        'on the host\'s slip_escape_client (auto-escalation).')


def test_send_slip_goal_helper_exists_on_host():
    src = RD.read_text()
    assert 'def _send_slip_goal' in src or 'slip_escape_client.send_goal_async' in src
