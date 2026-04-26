from pathlib import Path

R = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_cpu_usage_reads_loadavg():
    body = R.read_text().split('def _publish_status')[1].split('def ')[0]
    assert '/proc/loadavg' in body or 'loadavg' in body, (
        'cpu_usage must come from /proc/loadavg, not hardcoded')
    # Check that loadavg is read, not just hardcoded to 0
    assert 'open(\'/proc/loadavg\')' in body or 'open("/proc/loadavg")' in body


def test_light_uses_led_level_state():
    body = R.read_text().split('def _publish_status')[1].split('def ')[0]
    assert '_led_level' in body
    assert 'msg.light = 0' not in body
