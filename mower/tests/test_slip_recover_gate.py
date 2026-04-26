"""F6: _send_slip_goal must respect enable_slipping_recover parameter."""
from pathlib import Path
import re

R = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_send_slip_goal_checks_enable_slipping_recover():
    src = R.read_text()
    body = re.search(
        r'def _send_slip_goal[^\n]*\n(.*?)(?=\n    def |\nclass )',
        src, re.DOTALL).group(1)
    assert "get_parameter('enable_slipping_recover')" in body, (
        '_send_slip_goal must read enable_slipping_recover parameter and '
        'bail when disabled.')
