from pathlib import Path

R = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_charge_back_percentage_param_declared():
    src = R.read_text()
    assert "declare_parameter('charge_back_percentage'" in src


def test_battery_callback_uses_hysteresis():
    src = R.read_text()
    body = src.split('def _on_battery')[1].split('def ')[0]
    assert 'charge_back_percentage' in body
