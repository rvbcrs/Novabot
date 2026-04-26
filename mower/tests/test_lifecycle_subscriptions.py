from pathlib import Path

R = Path(__file__).resolve().parents[1] / 'robot_decision.py'

EXPECTED_TOPICS = [
    '/chassis_node/led_level',
    '/camera/preposition/hardware_exception',
    '/system/shared_memory_error',
    '/camera/tof/point_cloud',
]


def test_lifecycle_topics_subscribed():
    src = R.read_text()
    missing = [t for t in EXPECTED_TOPICS if f"'{t}'" not in src]
    assert not missing, f'Missing subscriptions: {missing}'


def test_lifecycle_callbacks_exist():
    src = R.read_text()
    for cb in ['_on_led_level', '_on_camera_hw_exception', '_on_shm_error', '_on_tof']:
        assert f'def {cb}' in src, f'Callback missing: {cb}'
