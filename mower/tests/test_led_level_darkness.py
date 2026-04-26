"""F5: _on_camera_gain must call cli_led_level on darkness transitions."""
from pathlib import Path
import re

R = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_on_camera_gain_calls_led_level_client():
    """Verify _on_camera_gain calls cli_led_level service on darkness transitions."""
    src = R.read_text()

    # Extract _on_camera_gain method body
    match = re.search(
        r'def _on_camera_gain[^\n]*\n(.*?)(?=\n    def |\nclass |\Z)',
        src, re.DOTALL)
    assert match, '_on_camera_gain method not found'

    body = match.group(1)

    # Must reference cli_led_level client
    assert 'cli_led_level' in body, (
        '_on_camera_gain must call cli_led_level when darkness state '
        'transitions (closed-binary parity for night-docking LED control).')

    # Must set brightness to 255 (bright LED) or 1 (dim LED)
    assert '255' in body, (
        '_on_camera_gain must set LED to 255 for dark scenes '
        '(ArUco visibility at night).')
    assert '1' in body, (
        '_on_camera_gain must set LED to 1 for bright scenes '
        '(minimum brightness, status LED alive).')
