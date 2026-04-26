from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_save_charging_pose_does_not_use_nonexistent_field():
    """SetChargingPose.Response has no map_to_charging_dis field (live verified 2026-04-26).
    The handler must not assign to this non-existent field on the response,
    as rclpy raises AttributeError and crashes the service callback."""
    body = SVC.read_text().split(
        'def _handle_save_charging_pose')[1].split('def ')[0]
    assert 'response.map_to_charging_dis' not in body, (
        'SetChargingPose.Response has no map_to_charging_dis field — '
        'assigning it crashes the service callback at runtime')
