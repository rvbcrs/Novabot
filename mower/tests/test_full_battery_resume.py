from pathlib import Path

R = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_full_battery_param_read_in_on_battery():
    body = R.read_text().split('def _on_battery')[1].split('def ')[0]
    assert "get_parameter('full_battery_power')" in body, (
        'full_battery_power must be read in _on_battery for hysteresis '
        'auto-resume.')


def test_full_battery_triggers_resume_path():
    body = R.read_text().split('def _on_battery')[1].split('def ')[0]
    # Either explicit resume call or transition out of CHARGING when full
    assert 'CHARGING' in body
    assert '_last_cov_request' in body or 'INIT_SUCCESS' in body
