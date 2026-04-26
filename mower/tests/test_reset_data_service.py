from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_reset_data_service_registered():
    src = SVC.read_text()
    assert "'/robot_decision/reset_data'" in src
    assert '_handle_reset_data' in src
