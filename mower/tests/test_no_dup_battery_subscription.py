from pathlib import Path
import re

R = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_battery_message_subscribed_exactly_once():
    src = R.read_text()
    matches = re.findall(
        r"create_subscription\([^)]*'battery_message'", src)
    assert len(matches) == 1, (
        f'battery_message must be subscribed once (was {len(matches)}). '
        'Two subscriptions cause every battery message to fire _on_battery '
        'twice — low-battery cancellation triggers twice.')
