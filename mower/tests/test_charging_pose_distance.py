from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_save_charging_pose_propagates_real_distance():
    body = SVC.read_text().split(
        'def _handle_save_charging_pose')[1].split('def ')[0]
    assert 'response.map_to_charging_dis = 0.0' not in body, (
        'Closed binary returns the upstream distance — must not hardcode 0.0')
    assert 'map_to_charging_dis' in body
