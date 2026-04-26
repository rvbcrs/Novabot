"""Closed binary publishes /robot_decision/map_position as a continuous Pose
topic. Open exposed it as a Common service. Live tools (mqtt_node, dashboard)
expect a topic. Verify by code inspection."""
from pathlib import Path

ROBOT_DECISION = Path(__file__).resolve().parents[1] / 'robot_decision.py'
SVC_HANDLERS = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_map_position_publisher_exists():
    src = ROBOT_DECISION.read_text()
    assert (
        "create_publisher(Pose, '/robot_decision/map_position'" in src
        or "create_publisher(\n            Pose, '/robot_decision/map_position'" in src
    ), 'map_position must be a Pose publisher on robot_decision'


def test_map_position_service_removed():
    src = SVC_HANDLERS.read_text()
    assert "'/robot_decision/map_position'" not in src, (
        'map_position service must be removed; replaced by a publisher')
    assert '_handle_map_position' not in src
