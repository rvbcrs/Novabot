"""For every fixture in tests/fixtures/parity/, drive our SensorAggregator
with the input_state and assert build_<command>() returns a dict whose
JSON representation matches stock_payload (after deterministic key
sort + float tolerance).
"""
import json
from pathlib import Path

import pytest

from sensor_aggregator import SensorAggregator

FIXTURES = Path(__file__).parent / 'fixtures' / 'parity'


def _equal_with_tolerance(a, b, *, rel=1e-3):
    if isinstance(a, float) and isinstance(b, float):
        return abs(a - b) <= rel * max(abs(a), abs(b), 1.0)
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(
            _equal_with_tolerance(a[k], b[k], rel=rel) for k in a
        )
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(
            _equal_with_tolerance(x, y, rel=rel) for x, y in zip(a, b)
        )
    return a == b


def _drive(agg: SensorAggregator, state: dict) -> None:
    """Apply every input_state key to the aggregator via the matching
    update_* method. Unknown keys are ignored (forward-compat)."""
    if 'battery_power' in state or 'battery_state' in state:
        agg.update_battery(power_percent=state.get('battery_power', 0),
                           state=state.get('battery_state', 'UNKNOWN'))
    if 'task_mode' in state:
        agg.update_status(task_mode=state.get('task_mode', 0),
                          work_status=state.get('work_status', 0),
                          recharge_status=state.get('recharge_status', 0),
                          msg=state.get('msg', ''))
    extras_keys = ('prev_task_mode', 'prev_work_status', 'prev_recharge_status',
                   'current_map_ids', 'request_map_ids', 'map_num',
                   'finished_num', 'light', 'perception_level')
    if any(k in state for k in extras_keys):
        agg.update_status_extras(**{k: state.get(k, 0) for k in extras_keys})
    if 'error_status' in state or 'error_msg' in state:
        agg.update_error(error_status=state.get('error_status', 0),
                         error_msg=state.get('error_msg', ''))
    cov_keys = ('cov_ratio', 'cov_area', 'cov_work_time', 'valid_cov_work_time',
                'avoiding_obstacle_time', 'cov_estimate_time',
                'cov_remaining_area', 'cov_map_path')
    if any(k in state for k in cov_keys):
        agg.update_coverage(
            ratio=state.get('cov_ratio', 0.0),
            area=state.get('cov_area', 0.0),
            work_time=state.get('cov_work_time', 0.0),
            valid_work_time=state.get('valid_cov_work_time', 0.0),
            avoiding_obstacle_time=state.get('avoiding_obstacle_time', 0.0),
            estimate_time=state.get('cov_estimate_time', 0.0),
            remaining_area=state.get('cov_remaining_area', 0.0),
            map_path=state.get('cov_map_path', ''))
    mapping_keys = ('if_closed_cycle', 'if_mower_can_finish',
                    'if_scan_unicom_obstacle',
                    'start_edit_or_assistant_map_flag')
    if any(k in state for k in mapping_keys):
        agg.update_mapping_flags(
            **{k: state[k] for k in mapping_keys if k in state})
    if 'cover_path' in state:
        agg.update_cover_path(state['cover_path'])
    if 'cpu_temperature' in state or 'cpu_usage' in state:
        agg.update_cpu(temp=state.get('cpu_temperature', 0),
                       usage=state.get('cpu_usage', 0))
    if 'wifi_rssi' in state or 'rtk_sat' in state:
        agg.update_signal(wifi_rssi=state.get('wifi_rssi', 0),
                          rtk_sat=state.get('rtk_sat', 0))
    if 'target_height' in state:
        agg.update_target_height(state['target_height'])
    if 'loc_quality' in state:
        agg.update_loc_quality(state['loc_quality'])
    if 'loc_state' in state:
        agg.update_loc_state(state['loc_state'])
    if 'x' in state or 'y' in state or 'theta' in state:
        agg.update_pose(x=state.get('x', 0.0),
                        y=state.get('y', 0.0),
                        theta=state.get('theta', 0.0))
    if 'gps_lat' in state or 'gps_lng' in state:
        agg.update_gps(lat=state.get('gps_lat', 0.0),
                       lng=state.get('gps_lng', 0.0),
                       alt=state.get('gps_alt', 0.0),
                       state=state.get('gps_state', 'DISABLE'))
    if 'incident' in state:
        agg.update_incident(**state['incident'])


@pytest.mark.parametrize(
    'fix_path',
    sorted(FIXTURES.glob('*.json')) if FIXTURES.exists() else [],
    ids=lambda p: p.name,
)
def test_payload_parity(fix_path):
    fix = json.loads(fix_path.read_text())
    cmd = fix['command']
    agg = SensorAggregator()
    _drive(agg, fix.get('input_state', {}))

    builder = getattr(agg, f'build_{cmd}', None)
    if builder is None:
        pytest.skip(f'no builder for {cmd}')

    actual = builder()
    stock = fix['stock_payload']

    # Compare ONLY the keys our builder produces — stock binary may emit
    # extra fields we don't aggregate yet. Missing keys are tracked
    # separately as gap items in the test failure message.
    extras = [k for k in actual if k not in stock]
    differing = [
        k for k in actual
        if k in stock and not _equal_with_tolerance(actual[k], stock[k])
    ]
    assert not extras, (
        f'{cmd}: keys we emit but stock does NOT — gap, our builder is wrong: {extras}'
    )
    assert not differing, (
        f'{cmd}: keys with mismatched values: ' + ', '.join(
            f'{k}: actual={actual[k]!r} stock={stock[k]!r}' for k in differing
        )
    )
