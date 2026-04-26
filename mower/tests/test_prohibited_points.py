from pathlib import Path

R = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_prohibited_points_is_publisher_not_client():
    src = R.read_text()
    assert "create_publisher(\n            PolygonStamped, '/local_costmap/prohibited_points'" in src \
        or "create_publisher(PolygonStamped, '/local_costmap/prohibited_points'" in src, (
        'prohibited_points must be a PolygonStamped publisher.')


def test_no_prohibited_points_service_client():
    src = R.read_text()
    assert "cli_prohibited_points" not in src or "# cli_prohibited_points" in src, (
        'service-client form must be removed (or commented out).')


def test_push_prohibited_zones_helper_exists():
    src = R.read_text()
    assert 'def push_prohibited_zones' in src
