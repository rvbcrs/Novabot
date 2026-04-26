from pathlib import Path

R = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_led_buzzer_is_publisher_not_client():
    src = R.read_text()
    # New publisher
    assert "UInt8, '/chassis_node/led_buzzer_switch_set'" in src or \
           "led_buzzer_pub" in src
    # Old client gone
    assert 'cli_led_buzzer' not in src or '# cli_led_buzzer' in src
