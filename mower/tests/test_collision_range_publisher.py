from pathlib import Path

DA = Path(__file__).resolve().parents[1] / 'decision_assistant.py'


def test_collision_range_publisher_exists():
    src = DA.read_text()
    assert "Range, '/collision_range'" in src or "'/collision_range', " in src
    assert 'collision_range_pub' in src


def test_collision_range_tick_method_exists():
    src = DA.read_text()
    assert 'def _publish_collision_range_tick' in src
