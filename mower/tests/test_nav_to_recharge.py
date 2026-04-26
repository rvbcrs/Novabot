from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_nav_to_recharge_rejects_in_mapping_mode():
    body = SVC.read_text().split(
        'def _handle_nav_to_recharge')[1].split('def ')[0]
    assert 'TaskMode.MAPPING' in body
    assert 'guide pose mode only support no mapping mode' in body


def test_nav_to_recharge_uses_request_pose_fields():
    body = SVC.read_text().split(
        'def _handle_nav_to_recharge')[1].split('def ')[0]
    assert 'request.pose_x' in body
    assert 'request.pose_y' in body
    assert 'request.theta' in body or 'request.pose_theta' in body
    assert 'request.mode' in body
