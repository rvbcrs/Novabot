"""Cache ROS2 topic state and produce MQTT report payloads matching the
stock binary's output (per docs/reference/MQTT.md + the catalog at
research/documents/mqtt_node-payload-catalog.md).

The aggregator owns no rclpy subscriptions itself — Ros2Bridge wires
ROS2 topic callbacks to the update_* methods on this object. That keeps
this module pure-Python and unit-testable on Mac.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Dict, Any, Optional


@dataclass
class _Pose:
    x: float = 0.0
    y: float = 0.0
    theta: float = 0.0


@dataclass
class _Gps:
    latitude: float = 0.0
    longitude: float = 0.0
    altitude: float = 0.0
    state: str = 'DISABLE'


@dataclass
class _Battery:
    power_percent: int = 0
    state: str = 'UNKNOWN'


_DEFAULT_COVER_PATH = {
    'covered': {
        'covering_area': {'area_id': '0', 'points': '0'},
        'finished_area': '',
        'missed': '',
    },
    'finished_maps': '0',
    'map_id': '0',
}


class SensorAggregator:
    def __init__(self):
        self._pose = _Pose()
        self._gps = _Gps()
        self._battery = _Battery()
        self._loc_quality: int = 0
        self._loc_state: str = 'NOT_INITIALIZED'

        # ── RobotStatus core ──
        self._task_mode: int = 0
        self._work_status: int = 0
        self._recharge_status: int = 0
        self._error_status: int = 0
        self._error_msg: str = ''
        self._msg: str = ''

        # ── RobotStatus prev_* + map ids + counters ──
        self._prev_task_mode: int = 0
        self._prev_work_status: int = 0
        self._prev_recharge_status: int = 0
        self._current_map_ids: int = 0
        self._request_map_ids: int = 0
        self._map_num: int = 0
        self._finished_num: int = 0
        self._light: int = 0
        self._perception_level: int = 0

        # ── Coverage ──
        self._cov_ratio: float = 0.0
        self._cov_area: float = 0.0
        self._cov_work_time: float = 0.0
        self._valid_cov_work_time: float = 0.0
        self._avoiding_obstacle_time: float = 0.0
        self._cov_estimate_time: float = 0.0
        self._cov_remaining_area: float = 0.0
        self._cov_map_path: str = ''

        # ── Hardware metrics ──
        self._target_height: int = 0
        self._cpu_temperature: int = 0
        self._cpu_usage: int = 0
        self._wifi_rssi: int = 0
        self._rtk_sat: int = 0

        # ── Mapping subtree (timer_data) ──
        self._cover_path: Dict[str, Any] = dict(_DEFAULT_COVER_PATH)
        self._if_closed_cycle: int = 0
        self._if_mower_can_finish: bool = False
        self._if_scan_unicom_obstacle: int = 0
        self._start_edit_or_assistant_map_flag: int = 0

        self._incident_bits: Dict[str, bool] = {}

        # ── Versions + system metrics (server-only reports) ──
        self._sv: str = ''   # software version, e.g. v6.0.2-custom-24
        self._hv: str = ''   # hardware version, e.g. v0.0.1
        self._ov: str = ''   # OS version, e.g. V0.3.2
        self._disk_remaining_mb: int = 0
        self._memory_remaining_mb: int = 0
        self._working_time_min: int = 0
        self._gps_sat_num: int = 0
        self._gps_status: int = 0  # 1 = GPS active

    # ── Update methods (called from ros2 callbacks) ────────────────
    def update_battery(self, *, power_percent: int, state: str) -> None:
        self._battery = _Battery(power_percent=power_percent, state=state)

    def update_pose(self, *, x: float, y: float, theta: float) -> None:
        self._pose = _Pose(x=x, y=y, theta=theta)

    def update_gps(self, *, lat: float, lng: float, alt: float, state: str) -> None:
        self._gps = _Gps(latitude=lat, longitude=lng, altitude=alt, state=state)

    def update_loc_quality(self, q: int) -> None:
        self._loc_quality = int(q)

    def update_loc_state(self, s: str) -> None:
        self._loc_state = s

    def update_status(self, *, task_mode: int, work_status: int,
                      recharge_status: int, msg: str = '') -> None:
        self._task_mode = task_mode
        self._work_status = work_status
        self._recharge_status = recharge_status
        if msg:
            self._msg = msg

    def update_status_extras(self, *, prev_task_mode: int = 0,
                             prev_work_status: int = 0,
                             prev_recharge_status: int = 0,
                             current_map_ids: int = 0,
                             request_map_ids: int = 0,
                             map_num: int = 0,
                             finished_num: int = 0,
                             light: int = 0,
                             perception_level: int = 0) -> None:
        """RobotStatus fields beyond the core triplet — verified against
        decision_msgs/msg/RobotStatus.msg (live SSH 2026-04-26)."""
        self._prev_task_mode = int(prev_task_mode)
        self._prev_work_status = int(prev_work_status)
        self._prev_recharge_status = int(prev_recharge_status)
        self._current_map_ids = int(current_map_ids)
        self._request_map_ids = int(request_map_ids)
        self._map_num = int(map_num)
        self._finished_num = int(finished_num)
        self._light = int(light)
        self._perception_level = int(perception_level)

    def update_error(self, *, error_status: int, error_msg: str) -> None:
        self._error_status = error_status
        self._error_msg = error_msg

    def update_coverage(self, *, ratio: float, area: float,
                        work_time: float,
                        valid_work_time: float = 0.0,
                        avoiding_obstacle_time: float = 0.0,
                        estimate_time: float = 0.0,
                        remaining_area: float = 0.0,
                        map_path: str = '') -> None:
        self._cov_ratio = float(ratio)
        self._cov_area = float(area)
        self._cov_work_time = float(work_time)
        self._valid_cov_work_time = float(valid_work_time)
        self._avoiding_obstacle_time = float(avoiding_obstacle_time)
        self._cov_estimate_time = float(estimate_time)
        self._cov_remaining_area = float(remaining_area)
        self._cov_map_path = str(map_path)

    def update_cpu(self, *, temp: int, usage: int) -> None:
        self._cpu_temperature = temp
        self._cpu_usage = usage

    def update_signal(self, *, wifi_rssi: int, rtk_sat: int) -> None:
        self._wifi_rssi = wifi_rssi
        self._rtk_sat = rtk_sat

    def update_target_height(self, h: int) -> None:
        self._target_height = h

    def update_incident(self, **bits: bool) -> None:
        for k, v in bits.items():
            self._incident_bits[k] = bool(v)

    def update_versions(self, *, sv: str = '', hv: str = '', ov: str = '') -> None:
        """Set the three version strings emitted in
        report_state_to_server_work_respond. Called once at main.py
        startup from on-disk sources."""
        self._sv = str(sv)
        self._hv = str(hv)
        self._ov = str(ov)

    def update_system_metrics(self, *, disk_mb: int = 0, memory_mb: int = 0,
                              working_time_min: int = 0) -> None:
        """Polled metrics from /proc + statvfs (every ~30 s in main.py)."""
        self._disk_remaining_mb = int(disk_mb)
        self._memory_remaining_mb = int(memory_mb)
        self._working_time_min = int(working_time_min)

    def update_gps_quality(self, *, sat_num: int = 0, status: int = 0) -> None:
        """GPS satellite count + status flag (1 = active) for the server
        work respond. Cached from /gps_raw or /bestpos_parsed_data."""
        self._gps_sat_num = int(sat_num)
        self._gps_status = int(status)

    def update_cover_path(self, path: Dict[str, Any]) -> None:
        """Cache the cover_path subtree emitted in report_state_timer_data.
        Source: /robot_decision/covered_path_json (std_msgs/String JSON
        body). Pass the parsed dict in directly."""
        if isinstance(path, dict):
            self._cover_path = path

    def update_mapping_flags(self, *, if_closed_cycle: Optional[int] = None,
                             if_mower_can_finish: Optional[bool] = None,
                             if_scan_unicom_obstacle: Optional[int] = None,
                             start_edit_or_assistant_map_flag:
                             Optional[int] = None) -> None:
        """Mapping/coverage state flags emitted in report_state_timer_data.
        Topics drive each independently, so each parameter is optional —
        only the keys that arrived in the latest message get updated."""
        if if_closed_cycle is not None:
            self._if_closed_cycle = int(if_closed_cycle)
        if if_mower_can_finish is not None:
            self._if_mower_can_finish = bool(if_mower_can_finish)
        if if_scan_unicom_obstacle is not None:
            self._if_scan_unicom_obstacle = int(if_scan_unicom_obstacle)
        if start_edit_or_assistant_map_flag is not None:
            self._start_edit_or_assistant_map_flag = int(start_edit_or_assistant_map_flag)

    # ── Build methods (called from publish timer) ──────────────────
    def build_report_state_robot(self) -> Dict[str, Any]:
        """Match stock 'report_state_robot' topic — 30 fields verified
        against research/documents/mqtt_node-payload-catalog.md and the
        live container log (LFIN1231000211, 2026-04-27).

        Per catalog: battery_state, wifi_rssi, rtk_sat do NOT belong here.
        """
        return {
            'avoiding_obstacle_time': self._avoiding_obstacle_time,
            'battery_power': self._battery.power_percent,
            'cov_area': self._cov_area,
            'cov_estimate_time': self._cov_estimate_time,
            'cov_map_path': self._cov_map_path,
            'cov_ratio': self._cov_ratio,
            'cov_remaining_area': self._cov_remaining_area,
            'cov_work_time': self._cov_work_time,
            'cpu_temperature': self._cpu_temperature,
            'cpu_usage': self._cpu_usage,
            'current_map_ids': self._current_map_ids,
            'error_msg': self._error_msg,
            'error_status': self._error_status,
            'finished_num': self._finished_num,
            'light': self._light,
            'loc_quality': self._loc_quality,
            'map_num': self._map_num,
            'msg': self._msg,
            'perception_level': self._perception_level,
            'prev_recharge_status': self._prev_recharge_status,
            'prev_task_mode': self._prev_task_mode,
            'prev_work_status': self._prev_work_status,
            'recharge_status': self._recharge_status,
            'request_map_ids': self._request_map_ids,
            'target_height': self._target_height,
            'task_mode': self._task_mode,
            'theta': self._pose.theta,
            'valid_cov_work_time': self._valid_cov_work_time,
            'work_status': self._work_status,
            'x': self._pose.x,
            'y': self._pose.y,
        }

    def build_report_state_timer_data(self) -> Dict[str, Any]:
        return {
            'battery_capacity': self._battery.power_percent,
            'battery_state': self._battery.state,
            'cover_path': self._cover_path,
            'if_closed_cycle': self._if_closed_cycle,
            'if_mower_can_finish': self._if_mower_can_finish,
            'if_scan_unicom_obstacle': self._if_scan_unicom_obstacle,
            'localization': {
                'gps_position': {
                    'latitude': self._gps.latitude,
                    'longitude': self._gps.longitude,
                    'altitude': self._gps.altitude,
                    'state': self._gps.state,
                },
                'map_position': {
                    'x': self._pose.x,
                    'y': self._pose.y,
                    'orientation': self._pose.theta,
                },
                'localization_state': self._loc_state,
            },
            'plan_path': 0,
            'preview_cover_path': 0,
            'start_edit_or_assistant_map_flag': self._start_edit_or_assistant_map_flag,
            'timer_task': 0,
        }

    def build_report_exception_state(self) -> Dict[str, Any]:
        """Match stock 'report_exception_state' topic exactly.

        Stock keys (per research/documents/mqtt_node-payload-catalog.md):
          button_stop, chassis_err, no_set_pin_code, rtk, rtk_sat, wifi_rssi
        """
        bits = self._incident_bits
        return {
            'button_stop': bool(bits.get('button_stop', False)),
            'chassis_err': int(bits.get('chassis_err', 0)),
            'no_set_pin_code': bool(bits.get('no_set_pin_code', False)),
            'rtk': bool(bits.get('rtk', False)),
            'rtk_sat': int(self._rtk_sat),
            'wifi_rssi': int(self._wifi_rssi),
        }

    # ── Server-only reports (Dart/Receive_server_mqtt/<SN>) ──────────
    def build_report_state_to_server_work_respond(self) -> Dict[str, Any]:
        """Match stock server-only periodic heartbeat
        (research/documents/mqtt_node-payload-catalog.md). Envelope shape:
            { "type": "report_state_to_server_work_respond",
              "message": { "result": 0, "value": { ...21 fields... } } }
        """
        return {
            'type': 'report_state_to_server_work_respond',
            'message': {
                'result': 0,
                'value': {
                    'battery_power': self._battery.power_percent,
                    'cpu_temperature': self._cpu_temperature,
                    'cpu_usage': self._cpu_usage,
                    'disk_remaining': self._disk_remaining_mb,
                    'error_status': self._error_status,
                    'gps_altitude': self._gps.altitude,
                    'gps_latitude': self._gps.latitude,
                    'gps_longitude': self._gps.longitude,
                    'gps_sat_num': self._gps_sat_num,
                    'gps_status': self._gps_status,
                    'hv': self._hv,
                    'loc_quality': self._loc_quality,
                    'memory_remaining': self._memory_remaining_mb,
                    'ov': self._ov,
                    'recharge_status': self._recharge_status,
                    'sv': self._sv,
                    'task_mode': self._task_mode,
                    'timer_task': 0,
                    'wifi_rssi': self._wifi_rssi,
                    'work_status': self._work_status,
                    'working_time': self._working_time_min,
                },
            },
        }

    def build_report_state_to_server_exception_respond(self) -> Dict[str, Any]:
        """Match stock server-only event-driven exception report.
        Uses robot_* prefixed fields (different from app-side
        report_exception_state). Envelope shape:
            { "type": "report_state_to_server_exception_respond",
              "message": { "result": 0, "value": { ...8 fields... } } }
        """
        bits = self._incident_bits
        return {
            'type': 'report_state_to_server_exception_respond',
            'message': {
                'result': 0,
                'value': {
                    'robot_button_stop': bool(bits.get('button_stop', False)),
                    'robot_collision': bool(bits.get('collision', False)),
                    'robot_error_msg': self._error_msg,
                    'robot_error_status': self._error_status,
                    'robot_overturn': bool(bits.get('overturn', False)),
                    'robot_tilt': bool(bits.get('tilt', False)),
                    'robot_upraise': bool(bits.get('upraise', False)),
                    'robot_wheel_stall': int(bits.get('wheel_stall', 0)),
                },
            },
        }
