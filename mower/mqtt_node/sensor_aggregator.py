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


class SensorAggregator:
    def __init__(self):
        self._pose = _Pose()
        self._gps = _Gps()
        self._battery = _Battery()
        self._loc_quality: int = 0
        self._loc_state: str = 'NOT_INITIALIZED'
        self._task_mode: int = 0
        self._work_status: int = 0
        self._recharge_status: int = 0
        self._error_status: int = 0
        self._error_msg: str = ''
        self._msg: str = ''
        self._cov_ratio: float = 0.0
        self._cov_area: float = 0.0
        self._cov_work_time: float = 0.0
        self._target_height: int = 0
        self._cpu_temperature: int = 0
        self._cpu_usage: int = 0
        self._wifi_rssi: int = 0
        self._rtk_sat: int = 0
        self._incident_bits: Dict[str, bool] = {}

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

    def update_error(self, *, error_status: int, error_msg: str) -> None:
        self._error_status = error_status
        self._error_msg = error_msg

    def update_coverage(self, *, ratio: float, area: float,
                        work_time: float) -> None:
        self._cov_ratio = ratio
        self._cov_area = area
        self._cov_work_time = work_time

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

    # ── Build methods (called from publish timer) ──────────────────
    def build_report_state_robot(self) -> Dict[str, Any]:
        return {
            'battery_power': self._battery.power_percent,
            'battery_state': self._battery.state,
            'task_mode': self._task_mode,
            'work_status': self._work_status,
            'recharge_status': self._recharge_status,
            'error_status': self._error_status,
            'error_msg': self._error_msg,
            'msg': self._msg,
            'cov_ratio': self._cov_ratio,
            'cov_area': self._cov_area,
            'cov_work_time': self._cov_work_time,
            'target_height': self._target_height,
            'cpu_temperature': self._cpu_temperature,
            'cpu_usage': self._cpu_usage,
            'loc_quality': self._loc_quality,
            'wifi_rssi': self._wifi_rssi,
            'rtk_sat': self._rtk_sat,
            'x': self._pose.x,
            'y': self._pose.y,
            'theta': self._pose.theta,
        }

    def build_report_state_timer_data(self) -> Dict[str, Any]:
        return {
            'battery_capacity': self._battery.power_percent,
            'battery_state': self._battery.state,
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
            'start_edit_or_assistant_map_flag': 0,
            'timer_task': 0,
            'if_closed_cycle': 0,
        }

    def build_report_state_exception(self) -> Dict[str, Any]:
        # Per audit (mqtt_node-command-catalog.md), error_status bits map:
        # bit3 (=8) = LORA_ERROR
        bits = self._incident_bits
        status = 0
        if bits.get('error_lora'):
            status |= 8
        return {
            'robot_error_status': status,
            'robot_error_msg': bits.get('error_lora_msg', ''),
            'robot_button_stop': bool(bits.get('button_stop', False)),
            'robot_collision': bool(bits.get('collision', False)),
            'robot_overturn': bool(bits.get('overturn', False)),
            'robot_tilt': bool(bits.get('tilt', False)),
            'robot_upraise': bool(bits.get('upraise', False)),
            'robot_wheel_stall': int(bits.get('wheel_stall', 0)),
        }
