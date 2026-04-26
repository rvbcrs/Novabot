"""Test that all closed-binary parameters are declared."""
from pathlib import Path

R = Path(__file__).resolve().parents[1] / 'robot_decision.py'

REQUIRED = [
    'boundary_offset',
    'include_edge',
    'recharge_retry_times',
    'escape_plan_switch',
    'collect_image',
    'do_camera_switch',
]


def test_all_closed_binary_parameters_declared():
    """Verify all closed-binary parameters are declared in _declare_params."""
    src = R.read_text()
    missing = [p for p in REQUIRED if f"declare_parameter('{p}'" not in src]
    assert not missing, f'Missing closed-binary parameter declarations: {missing}'
