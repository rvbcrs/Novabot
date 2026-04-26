"""Heading discovery must use free_move_around (reverse drive, closed-binary
parity) instead of forward drive + spin.

FreeMoveAround.srv schema (live SSH probe 2026-04-26):
  nav2_pro_msgs/srv/FreeMoveAround
  Request:
    geometry_msgs/PoseStamped pose
    bool using_input_pose
    bool local_costmap
    bool global_costmap
    float32 radius
  Response:
    bool result

The closed binary uses this service for QUIT_PILE_INIT (undock/heading-discovery)
because it allows movement WITHOUT a loaded map (no localization required).
"""
from pathlib import Path

R = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_heading_discovery_uses_free_move_around():
    src = R.read_text()
    # Should use cli_free_move_around in the heading-discovery path
    body = src.split('def _start_heading_discovery')[1].split('\ndef ')[0] \
        if 'def _start_heading_discovery' in src else src
    assert 'cli_free_move_around' in body or 'free_move_around' in body, (
        'Heading discovery must use free_move_around service for reverse '
        'drive (closed-binary parity)')


def test_quit_pile_distance_param_used():
    src = R.read_text()
    assert "get_parameter('quit_pile_distance')" in src


def test_heading_discovery_has_fallback():
    """If free_move_around is unavailable, code must fall back to old
    forward+spin path rather than crashing."""
    src = R.read_text()
    body = src.split('def _start_heading_discovery')[1].split('\ndef ')[0] \
        if 'def _start_heading_discovery' in src else src
    assert '_fallback_forward_spin_heading_discovery' in body or \
        'wait_for_service' in body, (
        '_start_heading_discovery must test service availability and fall back '
        'if free_move_around is not reachable')
