"""Chassis node publishes /chassis_node/init_ok as a std_msgs/Bool topic.
Open implementation must subscribe to this topic, not call it as a service.

Live verification on mower (2026-04-26):
  ros2 topic info /chassis_node/init_ok -v
  Type: std_msgs/msg/Bool
  Publisher: CChassisControl node
  Subscriber: robot_decision node ✓

Closed binary uses topic subscription. Open must match.
"""
from pathlib import Path

ROBOT_DECISION = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_init_ok_topic_subscriber_exists():
    """robot_decision must subscribe to /chassis_node/init_ok Bool topic."""
    src = ROBOT_DECISION.read_text()
    assert (
        "create_subscription(Bool, '/chassis_node/init_ok'" in src
        or "create_subscription(\n            Bool, '/chassis_node/init_ok'" in src
        or "Bool, '/chassis_node/init_ok'" in src
    ), 'init_ok must be subscribed as a Bool topic on robot_decision'


def test_init_ok_service_client_removed():
    """robot_decision must NOT use init_ok as a service client."""
    src = ROBOT_DECISION.read_text()
    assert (
        "create_client(EmptySrv, '/chassis_node/init_ok'" not in src
        and "cli_init_ok" not in src
        and "_boot_init_ok_future" not in src
    ), 'init_ok service client must be removed; replaced by Bool topic subscription'
