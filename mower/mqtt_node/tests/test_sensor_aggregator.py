"""SensorAggregator caches ROS2 topic state and produces stock-binary-
parity MQTT report payloads.

Tests run with mocked subscriptions — we feed messages into the
aggregator's update_* methods directly. The actual rclpy subscription
callbacks just call those update_* methods.
"""
import pytest

from sensor_aggregator import SensorAggregator


def test_report_state_robot_minimum_fields():
    agg = SensorAggregator()
    agg.update_battery(power_percent=87, state='DISCHARGED')
    agg.update_pose(x=1.2, y=-0.5, theta=0.7)
    agg.update_loc_quality(85)
    payload = agg.build_report_state_robot()
    assert payload['battery_power'] == 87
    # battery_state belongs in report_state_timer_data, not here
    assert 'battery_state' not in payload
    assert payload['x'] == 1.2
    assert payload['y'] == -0.5
    assert payload['theta'] == 0.7
    assert payload['loc_quality'] == 85
    # All fields documented in docs/reference/MQTT.md must be present
    for key in ['battery_power', 'task_mode', 'work_status', 'cov_ratio',
                'cov_area', 'msg', 'error_status', 'error_msg']:
        assert key in payload


def test_report_state_timer_data_includes_localization_subtree():
    agg = SensorAggregator()
    agg.update_pose(x=3.14, y=2.71, theta=1.57)
    agg.update_gps(lat=52.14, lng=6.23, alt=10.5, state='ENABLE')
    agg.update_loc_state('RUNNING')
    payload = agg.build_report_state_timer_data()
    assert payload['localization']['gps_position']['latitude'] == 52.14
    assert payload['localization']['map_position']['x'] == 3.14
    assert payload['localization']['localization_state'] == 'RUNNING'


def test_report_exception_state_uses_stock_field_names():
    agg = SensorAggregator()
    agg.update_signal(wifi_rssi=54, rtk_sat=31)
    agg.update_incident(button_stop=False, chassis_err=0,
                        no_set_pin_code=False, rtk=True)
    payload = agg.build_report_exception_state()
    assert payload == {
        'button_stop': False,
        'chassis_err': 0,
        'no_set_pin_code': False,
        'rtk': True,
        'rtk_sat': 31,
        'wifi_rssi': 54,
    }
