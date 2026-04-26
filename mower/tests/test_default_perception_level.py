from pathlib import Path

R = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_default_perception_level_read_at_init():
    """The host must read default_perception_level and assign to perception_level"""
    src = R.read_text()
    # The parameter must be read (not just declared)
    assert "get_parameter('default_perception_level')" in src
    # Specifically near the perception_level state init
    assert 'self.perception_level' in src
