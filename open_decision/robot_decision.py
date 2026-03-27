#!/usr/bin/env python3
"""
Open-source robot_decision — drop-in replacement for the Novabot closed-source binary.

Central state machine node that coordinates ALL mower behavior:
mapping, mowing, charging, error recovery, perception.

Usage on mower:
  source /opt/ros/galactic/setup.bash
  source /root/novabot/install/setup.bash
  python3 /userdata/open_decision/robot_decision.py

Fase 1-6: Core features (boot, mapping, mowing, charging) — complete
Fase 7: DecisionAssistant + error recovery — complete
Fase 8: Map/costmap/LED/blade/health/boundary/UTM — complete
Fase 9: Camera/perception/costmap control, all ChassisIncident flags,
        gazebo debug, low power, loc drift, boot process check — v10 (this version)

Topic names verified from mqtt_node binary (must use /robot_decision/ prefix):
  PUB: /robot_decision/robot_status, /robot_decision/cov_task_result
  SUB: battery_message, chassis_incident, motor_current, odom_raw,
       /robot_combination_localization/combination_status, cloud_move_cmd
"""

import json
import math
import sys
import os
import time
import signal
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, QoSReliabilityPolicy, QoSHistoryPolicy
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.action import ActionClient

from builtin_interfaces.msg import Time as TimeMsg

from decision_msgs.msg import RobotStatus, CovTaskResult
from novabot_msgs.msg import (
    ChassisBatteryMessage,
    ChassisIncident,
    ChassisMotorCurrent,
    CloudMoveCmd,
)
from localization_msgs.msg import CombinationStatus
from localization_msgs.srv import LoadUtmOriginInfo, SaveUtmOriginInfo
from std_srvs.srv import Empty as EmptySrv, SetBool
from mapping_msgs.srv import (
    Recording as RecordingSrv,
    MappingControl as MappingControlSrv,
    Mapping as MappingSrv,
    SetChargingPose as SetChargingPoseSrv,
    GenerateEmptyMap as GenerateEmptyMapSrv,
)
from mapping_msgs.msg import Polygon as MappingPolygon
from coverage_planner.action import (
    NavigateThroughCoveragePaths,
    BoundaryFollow,
)
from coverage_planner.srv import CoveragePathsByFile
from nav2_msgs.srv import LoadMap, ClearCostmapAroundRobot, SemanticMode
from rcl_interfaces.srv import SetParameters as SetParamsSrv
from rcl_interfaces.msg import Parameter, ParameterValue, ParameterType
from action_msgs.srv import CancelGoal as CancelGoalSrv
from nav2_msgs.action import NavigateToPose as NavigateToPoseAction
from automatic_recharge_msgs.action import AutoCharging
from nav2_pro_msgs.srv import FreeMoveAround
from general_msgs.srv import SetUint8 as SetUint8Srv, SaveFile as SaveFileSrv

from nav_msgs.msg import Odometry
from geometry_msgs.msg import Twist, PoseStamped
from std_msgs.msg import UInt8, UInt32, Int16, String, Bool

from state_machine import (
    TaskMode,
    WorkStatus,
    RechargeStatus,
    ErrorStatus,
    LocStatus,
)
from service_handlers import ServiceHandlers
from decision_assistant import DecisionAssistant


# QoS for sensor data (best effort, keep last)
SENSOR_QOS = QoSProfile(
    reliability=QoSReliabilityPolicy.BEST_EFFORT,
    history=QoSHistoryPolicy.KEEP_LAST,
    depth=1,
)

# QoS for reliable comms
RELIABLE_QOS = QoSProfile(
    reliability=QoSReliabilityPolicy.RELIABLE,
    history=QoSHistoryPolicy.KEEP_LAST,
    depth=10,
)

# Max velocities (from novabot_keyboard.py)
MAX_LIN_VEL = 0.6      # m/s
MAX_ANG_VEL = 2.094     # rad/s
UNDOCK_VEL = -0.5       # m/s (backward) — 0.3 was too slow, mower rolled back
UNDOCK_HOLD_TIME = 2.0  # seconds to hold position after driving (prevent rollback)

# ─── Heading discovery constants ─────────────────────────────
HEADING_CACHE_PATH  = '/userdata/novabot_heading.json'
HEADING_CACHE_TTL_S = 86400   # 24 uur geldig
DRIVE_OFF_SPEED     = 0.3     # m/s voorwaarts van dock af
DRIVE_OFF_TIME_S    = 5.0     # ~1.5m bij 0.3 m/s
SPIN_SPEED          = 0.3     # rad/s langzaam ronddraaien
HEADING_TIMEOUT_S   = 60.0    # max wachttijd voor heading alignment


class OpenRobotDecision(Node):
    """Open-source replacement for the Novabot robot_decision node."""

    def __init__(self):
        super().__init__('robot_decision')
        self.get_logger().info('=== Open robot_decision v17 starting ===')

        # ─── Callback groups (for MultiThreadedExecutor) ───
        self.service_cb_group = ReentrantCallbackGroup()
        self.client_cb_group = ReentrantCallbackGroup()

        # ─── Declare parameters (matching robot_decision.yaml) ───
        self._declare_params()

        # ─── State machine ───
        self.task_mode = TaskMode.FREE
        self.work_status = WorkStatus.SYSTEM_CHECK_INIT
        self.recharge_status = RechargeStatus.IDLE
        self.error_status = ErrorStatus.NONE
        self.prev_task_mode = TaskMode.FREE
        self.prev_work_status = WorkStatus.SYSTEM_CHECK_INIT
        self.prev_recharge_status = RechargeStatus.IDLE
        self.msg_text = ''
        self.error_msg = ''

        # ─── Sensor data cache ───
        self.battery_power = 0
        self.battery_voltage_mv = 0
        self.battery_current_ma = 0
        self.loc_quality = 0
        self.loc_status = LocStatus.WAIT_RTK_DATA
        self.odom_received = False
        self.odom_linear_x = 0.0
        self.odom_angular_z = 0.0
        self.cpu_temperature = 0
        self.x = 0.0
        self.y = 0.0
        self.theta = 0.0

        # ─── Coverage data ───
        self.cov_ratio = 0.0
        self.cov_area = 0.0
        self.cov_remaining_area = 0.0
        self.cov_estimate_time = 0.0
        self.cov_work_time = 0.0
        self.valid_cov_work_time = 0.0
        self.avoiding_obstacle_time = 0.0
        self.pause_time = 0.0
        self.cov_map_path = ''
        self.target_height = 40
        self.request_map_ids = 0
        self.current_map_ids = 0
        self.perception_level = 1
        self.light = 0

        # ─── Charger / undock state ───
        self.is_on_charger = False
        self._charge_stop_active = False  # ChassisIncident charge_stop flag
        self._undocking = False
        self._undock_start_time = 0.0
        self._undock_target_time = 0.0
        self._undock_after_state = None
        self.current_map_name = ''

        # ─── Joystick state ───
        self._joystick_active = False
        self._last_joystick_time = 0.0

        # ─── Incident tracking ───
        self._last_error_flag = 0
        self._last_warning_flag = 0

        # ─── Mapping state (Fase 4) ───
        self._mapping_active = False
        self._mapping_polygon_points = []
        self._charger_pose_x = 0.0
        self._charger_pose_y = 0.0
        self._charger_pose_theta = 0.0

        # ─── Timing ───
        self.start_time = self.get_clock().now()
        self.boot_start_time = time.monotonic()

        # ─── Publishers ───
        self.status_pub = self.create_publisher(
            RobotStatus, '/robot_decision/robot_status', RELIABLE_QOS)
        self.cov_result_pub = self.create_publisher(
            CovTaskResult, '/robot_decision/cov_task_result', RELIABLE_QOS)
        self.covered_path_pub = self.create_publisher(
            String, '/robot_decision/covered_path_json', RELIABLE_QOS)
        self.planned_path_pub = self.create_publisher(
            String, '/robot_decision/planned_json', RELIABLE_QOS)
        self.preview_path_pub = self.create_publisher(
            String, '/robot_decision/preview_planned_json', RELIABLE_QOS)

        # Motor control publishers (Fase 3)
        self.cmd_vel_pub = self.create_publisher(
            Twist, 'cmd_vel', RELIABLE_QOS)
        self.cloud_move_pub = self.create_publisher(
            CloudMoveCmd, 'cloud_move_cmd', RELIABLE_QOS)
        self.release_charge_pub = self.create_publisher(
            UInt8, 'release_charge_lock', RELIABLE_QOS)
        self.blade_height_pub = self.create_publisher(
            UInt8, 'blade_height_set', RELIABLE_QOS)
        self.blade_speed_pub = self.create_publisher(
            Int16, 'blade_speed_set', RELIABLE_QOS)
        self.led_pub = self.create_publisher(
            UInt8, 'led_set', RELIABLE_QOS)

        # ─── Subscribers ───
        self.create_subscription(
            ChassisBatteryMessage, 'battery_message',
            self._on_battery, SENSOR_QOS)
        self.create_subscription(
            ChassisBatteryMessage, 'battery_message',
            self._on_battery, RELIABLE_QOS)
        self.create_subscription(
            ChassisIncident, 'chassis_incident',
            self._on_incident, SENSOR_QOS)
        self.create_subscription(
            ChassisMotorCurrent, 'motor_current',
            self._on_motor_current, SENSOR_QOS)
        self.create_subscription(
            CombinationStatus,
            '/robot_combination_localization/combination_status',
            self._on_loc_status, SENSOR_QOS)
        self.create_subscription(
            Odometry, 'odom_raw',
            self._on_odom, SENSOR_QOS)
        self.create_subscription(
            CloudMoveCmd, 'cloud_move_cmd',
            self._on_cloud_move_cmd, RELIABLE_QOS)
        self.create_subscription(
            MappingPolygon, 'mapping_polygon',
            self._on_mapping_polygon, SENSOR_QOS)

        # ─── Service CLIENTS (boot) ───
        self.cli_init_ok = self.create_client(
            EmptySrv, '/chassis_node/init_ok',
            callback_group=self.client_cb_group)
        self.cli_load_utm = self.create_client(
            LoadUtmOriginInfo, 'load_utm_origin_info',
            callback_group=self.client_cb_group)
        self.cli_save_utm = self.create_client(
            SaveUtmOriginInfo, 'save_utm_origin_info',
            callback_group=self.client_cb_group)

        # ─── Mapping service CLIENTS (Fase 4) ───
        # Service names verified from novabot_mapping binary analysis
        # All use /novabot_mapping/ prefix, types from C++ mangled names
        self.cli_mapping_data = self.create_client(
            MappingSrv, '/novabot_mapping/mapping_data',
            callback_group=self.client_cb_group)
        self.cli_recording_edge = self.create_client(
            RecordingSrv, '/novabot_mapping/recording_edge',
            callback_group=self.client_cb_group)
        self.cli_recording_stop = self.create_client(
            RecordingSrv, '/novabot_mapping/recording_stop',
            callback_group=self.client_cb_group)
        self.cli_set_charging_pose = self.create_client(
            SetChargingPoseSrv, '/novabot_mapping/set_charging_pose',
            callback_group=self.client_cb_group)
        self.cli_generate_empty_map = self.create_client(
            GenerateEmptyMapSrv, '/novabot_mapping/generate_empty_map',
            callback_group=self.client_cb_group)
        self.cli_mapping_control = self.create_client(
            MappingControlSrv, '/novabot_mapping/mapping_control',
            callback_group=self.client_cb_group)
        self.cli_erase_map_mode = self.create_client(
            MappingControlSrv, '/novabot_mapping/control_erase_map_mode',
            callback_group=self.client_cb_group)

        # ─── Coverage/Mowing service CLIENTS (Fase 5) ───
        self.cli_load_map = self.create_client(
            LoadMap, '/map_server/load_map',
            callback_group=self.client_cb_group)
        self.cli_perception = self.create_client(
            SetBool, '/perception/do_perception',
            callback_group=self.client_cb_group)
        self.cli_coverage_by_file = self.create_client(
            CoveragePathsByFile,
            '/coverage_planner_server/coverage_by_file',
            callback_group=self.client_cb_group)
        self.cli_cover_task_stop = self.create_client(
            SetBool, '/coverage_planner_server/cover_task_stop',
            callback_group=self.client_cb_group)

        # ─── Costmap + nav2 service CLIENTS (Fase 8) ───
        self.cli_clear_local_costmap = self.create_client(
            ClearCostmapAroundRobot,
            '/local_costmap/clear_around_local_costmap',
            callback_group=self.client_cb_group)
        self.cli_clear_global_costmap = self.create_client(
            ClearCostmapAroundRobot,
            '/global_costmap/clear_around_global_costmap',
            callback_group=self.client_cb_group)
        self.cli_free_move_around = self.create_client(
            FreeMoveAround,
            '/nav2_single_node_navigator/free_move_around',
            callback_group=self.client_cb_group)
        self.cli_covered_path_json = self.create_client(
            SetBool,
            '/coverage_planner_server/covered_path_json',
            callback_group=self.client_cb_group)
        self.cli_maybe_stuck = self.create_client(
            SetBool,
            '/nav2_single_node_navigator/robot_maybe_stuck',
            callback_group=self.client_cb_group)

        # ─── Camera service CLIENTS (v10) ───
        self.cli_panoramic_camera = self.create_client(
            SetBool, '/camera/panoramic/start_camera',
            callback_group=self.client_cb_group)
        self.cli_preposition_camera = self.create_client(
            SetBool, '/camera/preposition/start_camera',
            callback_group=self.client_cb_group)
        self.cli_preposition_save = self.create_client(
            SaveFileSrv, '/camera/preposition/save_camera',
            callback_group=self.client_cb_group)
        self.cli_preposition_hw_exception = self.create_client(
            SetBool, '/camera/preposition/hardware_exception',
            callback_group=self.client_cb_group)
        self.cli_preposition_gain = self.create_client(
            SetUint8Srv, '/camera/preposition/total_gain',
            callback_group=self.client_cb_group)
        self.cli_tof_camera = self.create_client(
            SetBool, '/camera/tof/start_camera',
            callback_group=self.client_cb_group)

        # ─── Perception service CLIENTS (v10) ───
        self.cli_save_pcd_img = self.create_client(
            SaveFileSrv, '/perception/save_pcd_img',
            callback_group=self.client_cb_group)
        self.cli_set_infer_model = self.create_client(
            SetUint8Srv, '/perception/set_infer_model',
            callback_group=self.client_cb_group)
        self.cli_set_seg_level = self.create_client(
            SetUint8Srv, '/perception/set_seg_level',
            callback_group=self.client_cb_group)

        # ─── Costmap control CLIENTS (v10) ───
        self.cli_semantic_mode = self.create_client(
            SemanticMode, '/local_costmap/set_semantic_mode',
            callback_group=self.client_cb_group)
        self.cli_detection_mode = self.create_client(
            SetBool, '/local_costmap/set_detection_mode',
            callback_group=self.client_cb_group)
        self.cli_prohibited_points = self.create_client(
            SetBool, '/local_costmap/prohibited_points',
            callback_group=self.client_cb_group)
        self.cli_costmap_set_params = self.create_client(
            SetParamsSrv,
            '/local_costmap/local_costmap_rclcpp_node/set_parameters',
            callback_group=self.client_cb_group)
        self.cli_auto_recharge_set_params = self.create_client(
            SetParamsSrv,
            '/auto_recharge_server/set_parameters',
            callback_group=self.client_cb_group)

        # ─── Chassis extended CLIENTS (v10) ───
        self.cli_led_buzzer = self.create_client(
            SetUint8Srv, '/chassis_node/led_buzzer_switch_set',
            callback_group=self.client_cb_group)
        self.cli_led_level = self.create_client(
            SetUint8Srv, '/chassis_node/led_level',
            callback_group=self.client_cb_group)
        self.cli_init_mower = self.create_client(
            EmptySrv, '/novabot/init_mower',
            callback_group=self.client_cb_group)

        # ─── Coverage ACTION CLIENT (Fase 5) ───
        self.coverage_action_client = ActionClient(
            self, NavigateThroughCoveragePaths,
            '/navigate_through_coverage_paths',
            callback_group=self.client_cb_group)
        self._coverage_goal_handle = None
        self._cov_start_time = 0.0

        # ─── BoundaryFollow ACTION CLIENT (Fase 8: autonomous mapping) ───
        self.boundary_follow_client = ActionClient(
            self, BoundaryFollow,
            '/boundary_follow',
            callback_group=self.client_cb_group)
        self._boundary_goal_handle = None

        # ─── Charging ACTION CLIENTS (Fase 6) ───
        self.navigate_action_client = ActionClient(
            self, NavigateToPoseAction,
            '/navigate_to_pose',
            callback_group=self.client_cb_group)
        self._nav_cancel_client = self.create_client(
            CancelGoalSrv,
            '/navigate_to_pose/_action/cancel_goal',
            callback_group=self.client_cb_group)
        self.auto_charging_client = ActionClient(
            self, AutoCharging,
            '/auto_charging',
            callback_group=self.client_cb_group)
        self._nav_goal_handle = None
        self._charging_goal_handle = None
        self._charger_pose_stamped = None

        # ─── ArUco localization (heading discovery) ───
        self.cli_enable_aruco = self.create_client(
            SetBool, '/enable_aruco_localization',
            callback_group=self.client_cb_group)

        # ─── Camera darkness detection (night docking) ───
        # Subscribe to preposition camera total_gain (AGC output: high = dark scene).
        # Mirrors robot_decision.orig cameraDarknessCallback behavior.
        self._camera_is_dark: bool = False
        self.create_subscription(
            UInt32, '/camera/preposition/total_gain',
            self._on_camera_gain, SENSOR_QOS)

        # ─── Heading discovery state ───
        self._heading_phase: str | None = None  # 'drive_off' | 'spinning' | None
        self._heading_timer = None
        self._heading_phase_start: float = 0.0
        self._heading_cached: bool = False

        # ─── Service SERVERS (created by ServiceHandlers) ───
        self.service_handlers = ServiceHandlers(self)

        # ─── DecisionAssistant (Fase 7: slip escape, loc recovery) ───
        self.assistant = DecisionAssistant(self)

        # ─── Timers ───
        self.status_timer = self.create_timer(0.5, self._publish_status)
        self.summary_timer = self.create_timer(30.0, self._log_summary)
        self.boot_timer = self.create_timer(1.0, self._boot_tick)
        # One-shot: cancel stale navigation goals 10s after startup.
        # A stuck navigate_to_pose goal in nav2_single_node_navigator causes
        # coverage_planner_server to return "Not supported now!!!" and abort
        # BoundaryFollow immediately. Must cancel BEFORE first mapping attempt.
        self._nav_cancel_done = False
        self.nav_cancel_timer = self.create_timer(
            10.0, self._cancel_stale_nav_goals_once,
            callback_group=self.client_cb_group)

        self.boot_checks_done = False
        self.boot_phase = 'SYSTEM_CHECK_INIT'
        self._boot_init_ok_future = None
        self._boot_load_utm_future = None
        self._boot_loc_warned = False
        self.undock_timer = self.create_timer(0.1, self._undock_tick)
        self.joystick_timer = self.create_timer(0.5, self._joystick_timeout_tick)

        # ─── Process health monitoring (Fase 8) ───
        self._health_timer = self.create_timer(
            60.0, self._check_process_health)
        self._health_warned = set()

        self.get_logger().info(
            'Open robot_decision v17 initialized, starting boot sequence...')

    def _declare_params(self):
        """Declare all parameters matching robot_decision.yaml."""
        self.declare_parameter('coverage_times', 1)
        self.declare_parameter('gazebo_debug_mode', False)
        self.declare_parameter('low_battery_power', 20)
        self.declare_parameter('full_battery_power', 96)
        self.declare_parameter('enable_loc_recover', True)
        self.declare_parameter('enable_slipping_recover', True)
        self.declare_parameter('load_map_path', '/userdata/lfi/maps/home0')
        self.declare_parameter('empty_map_path', '/userdata/lfi/maps/')
        self.declare_parameter('save_utm_path', '/userdata/pos.json')
        self.declare_parameter('enable_loc_unstable_handle', False)
        self.declare_parameter('quit_pile_distance', 2.0)
        self.declare_parameter('follow_path_id',
                               'FollowPathPurePursuitReverseFollow')
        self.declare_parameter('loc_mapping_confidence', 69)
        self.declare_parameter('loc_cover_confidence', 40)
        self.declare_parameter('loc_recover_confidence', 89)
        self.declare_parameter('default_perception_level', 1)
        self.declare_parameter('min_perception_level', 0)
        self.declare_parameter('detect_out_of_boundary', True)
        self.declare_parameter('slipping_motor_current', 10)
        self.declare_parameter('image_darkness_thresh', 60.0)
        self.declare_parameter('image_darkness_thresh_lower', 5.0)
        self.declare_parameter('enable_save_image', True)
        self.declare_parameter('max_save_image_count', 80)
        self.declare_parameter('enable_led_light', True)
        self.declare_parameter('check_camera_clean', True)
        self.declare_parameter('enable_rtk_init_check', True)
        self.declare_parameter('enable_low_power_mode', True)
        self.declare_parameter('enable_led_feedback_check', False)
        self.declare_parameter('check_process', [
            '/nav2_single_node_navigator',
            '/robot_decision',
            '/coverage_planner_server',
            '/robot_combination_localization',
            '/chassis_control_node',
            'novabot_mapping',
        ])
        self.declare_parameter('planned_path_file',
                               '/userdata/lfi/maps/home0/planned_path')
        self.declare_parameter('covering_path_file',
                               '/userdata/lfi/maps/home0/covered_path')
        self.declare_parameter('boundary_offset', 0.35)
        self.declare_parameter('save_tof_rgb', True)
        self.declare_parameter('cpu_temp_thresh', 93.9)
        self.declare_parameter('enable_out_of_map_recover', True)

    # ─── Boot sequence ───────────────────────────────────────────

    def _boot_tick(self):
        """Boot sequence state machine, runs every 1 second."""
        if self.boot_checks_done:
            return
        elapsed = time.monotonic() - self.boot_start_time

        if self.boot_phase == 'SYSTEM_CHECK_INIT':
            self._set_state(TaskMode.FREE, WorkStatus.SYSTEM_CHECK_INIT)
            # Check critical processes are running
            self._boot_check_processes()
            self.boot_phase = 'SENSOR_INIT'

        elif self.boot_phase == 'SENSOR_INIT':
            self._set_state(TaskMode.FREE, WorkStatus.SENSOR_INIT)
            if self._boot_init_ok_future is None:
                if self.cli_init_ok.wait_for_service(timeout_sec=0.0):
                    req = EmptySrv.Request()
                    self._boot_init_ok_future = self.cli_init_ok.call_async(req)
                    self.get_logger().info(
                        'Boot: SENSOR_INIT — calling /chassis_node/init_ok')
                elif elapsed > 10.0:
                    self.get_logger().warn(
                        'Boot: /chassis_node/init_ok not available, skipping')
                    self.boot_phase = 'INIT_MOWER'
            elif self._boot_init_ok_future.done():
                try:
                    self._boot_init_ok_future.result()
                    self.get_logger().info('Boot: SENSOR_INIT — chassis init OK')
                except Exception as e:
                    self.get_logger().warn(f'Boot: init_ok failed: {e}')
                self.boot_phase = 'INIT_MOWER'

        elif self.boot_phase == 'INIT_MOWER':
            # Call /novabot/init_mower to initialize mower subsystems
            if self.cli_init_mower.wait_for_service(timeout_sec=0.0):
                req = EmptySrv.Request()
                self.call_service_async(
                    self.cli_init_mower, req, 'init_mower')
                self.get_logger().info('Boot: Called /novabot/init_mower')
            else:
                self.get_logger().info(
                    'Boot: /novabot/init_mower not available, skipping')
            self.boot_phase = 'LOCALIZATION_UTM_INIT'

        elif self.boot_phase == 'LOCALIZATION_UTM_INIT':
            self._set_state(TaskMode.FREE, WorkStatus.LOCALIZATION_UTM_INIT)
            if self._boot_load_utm_future is None:
                utm_path = self.get_parameter('save_utm_path').value
                if not os.path.exists(utm_path):
                    self.get_logger().warn(f'Boot: No UTM at {utm_path}')
                    self.boot_phase = 'LOCALIZATION_INIT'
                    return
                if self.cli_load_utm.wait_for_service(timeout_sec=0.0):
                    req = LoadUtmOriginInfo.Request()
                    req.utm_info_path = utm_path
                    self._boot_load_utm_future = self.cli_load_utm.call_async(req)
                    self.get_logger().info(f'Boot: Loading UTM from {utm_path}')
                elif elapsed > 15.0:
                    self.get_logger().warn('Boot: UTM service not available')
                    self.boot_phase = 'LOCALIZATION_INIT'
            elif self._boot_load_utm_future.done():
                try:
                    result = self._boot_load_utm_future.result()
                    if result.result:
                        self.get_logger().info(f'Boot: UTM: {result.msg}')
                    else:
                        self.get_logger().warn(f'Boot: UTM failed: {result.msg}')
                except Exception as e:
                    self.get_logger().warn(f'Boot: UTM exception: {e}')
                self.boot_phase = 'LOCALIZATION_INIT'

        elif self.boot_phase == 'LOCALIZATION_INIT':
            self._set_state(TaskMode.FREE, WorkStatus.LOCALIZATION_INIT)

            # Gazebo debug mode: skip localization checks
            if self.get_parameter('gazebo_debug_mode').value:
                self.get_logger().info(
                    'Boot: Gazebo debug mode — skipping loc check')
                self.boot_phase = 'INIT_SUCCESS'
                return

            # RTK init check: if disabled, don't wait for loc
            if not self.get_parameter('enable_rtk_init_check').value:
                self.get_logger().info(
                    'Boot: RTK init check disabled — skipping loc check')
                self.boot_phase = 'INIT_SUCCESS'
                return

            loc_threshold = self.get_parameter('loc_mapping_confidence').value
            if self.loc_quality >= loc_threshold:
                self.get_logger().info(
                    f'Boot: Loc quality {self.loc_quality} >= {loc_threshold}')
                self.boot_phase = 'INIT_SUCCESS'
            elif elapsed > 30.0:
                self.get_logger().warn(
                    f'Boot: Loc {self.loc_quality} < {loc_threshold} after 30s')
                self.boot_phase = 'INIT_SUCCESS'
            elif elapsed > 10.0 and not self._boot_loc_warned:
                self.get_logger().info(
                    f'Boot: Waiting loc ({self.loc_quality}/{loc_threshold})')
                self._boot_loc_warned = True

        elif self.boot_phase == 'INIT_SUCCESS':
            self._set_state(TaskMode.FREE, WorkStatus.INIT_SUCCESS)
            self.get_logger().info(
                f'Boot: INIT_SUCCESS — ready! (took {elapsed:.1f}s)')
            self.boot_checks_done = True
            self.boot_timer.cancel()

            # Camera clean check at boot
            self.check_camera_clean()

            self._update_charger_state()
            if self.is_on_charger:
                self._set_state(TaskMode.CHARGING, WorkStatus.INIT_SUCCESS)
                self.get_logger().info('Detected charging, setting CHARGING mode')
            else:
                self.get_logger().info(
                    'Boot: niet op dock — ArUco enablen + auto-dock starten')
                self._enable_aruco()
                # UTM-loading at boot always resets localization to ORIGIN_INITIAL (80).
                # Only LOC_SUCCESS (100) means map→odom TF is published.
                # → Always run heading discovery unless already at LOC_SUCCESS.
                self._load_heading_cache()  # Set _heading_cached flag
                if self.loc_quality >= 100:
                    # Fully aligned (LOC_SUCCESS) → map frame exists → navigate
                    self.get_logger().info(
                        'Heading aligned (loc_quality=100) — navigeren naar charger')
                    self.start_recharge()
                elif self._charge_stop_active:
                    # Charger contacts active at boot → mower is ON the dock.
                    # Skip heading discovery (would drive into dock). Dock directly.
                    self.get_logger().info(
                        'Charger contact at boot — skip heading discovery, dock direct')
                    self._start_auto_charging()
                else:
                    # ORIGIN_INITIAL or worse → no map frame → heading discovery first
                    self.get_logger().info(
                        f'Heading niet aligned (loc_quality={self.loc_quality}) '
                        '— heading discovery starten')
                    self._start_heading_discovery()

    # ─── Charger detection ─────────────────────────────────────

    def _update_charger_state(self):
        """Detect if mower is on the charger based on charging current + incident flags."""
        was_on_charger = self.is_on_charger
        # On charger if: charging current detected OR chassis reports charge_stop
        # (charge_stop = charger contacts present, current may be 0 when fully charged)
        self.is_on_charger = (
            self._charge_stop_active
            or (self.battery_current_ma > 100 and self.battery_power > 0)
        )
        if self.is_on_charger and not was_on_charger:
            self.get_logger().info('Charger: Detected — mower is on charger')
            # Safety: cancel heading discovery if it's running — otherwise
            # the timer keeps publishing cmd_vel while on the charger.
            if self._heading_timer is not None:
                self.get_logger().info(
                    'Charger: Cancelling heading discovery (on charger)')
                self.cmd_vel_pub.publish(Twist())  # Stop motors
                self._heading_timer.cancel()
                self._heading_timer = None
                self._heading_phase = None
            if self.task_mode == TaskMode.FREE and self.boot_checks_done \
                    and not self._undocking:
                self._set_state(TaskMode.CHARGING, WorkStatus.INIT_SUCCESS)
        elif was_on_charger and not self.is_on_charger:
            self.get_logger().info('Charger: Disconnected — mower left charger')
            if self.task_mode == TaskMode.CHARGING:
                self._set_state(TaskMode.FREE, WorkStatus.INIT_SUCCESS)

    # ─── Undock (Fase 3) ──────────────────────────────────────

    def request_undock(self, after_state=None):
        """Undock from charger. after_state: (TaskMode, WorkStatus) after."""
        if self._undocking:
            self.get_logger().warn('Undock: Already undocking')
            return
        self.get_logger().info('Undock: Starting undock sequence')
        self._set_state(TaskMode.FREE, WorkStatus.QUIT_PILE_INIT)
        # Force-publish RobotStatus immediately so CChassisControl sees the new state
        self._publish_status()
        self._undock_after_state = after_state
        # Release charge lock — try both 0 and 1
        for val in [1, 0]:
            msg = UInt8()
            msg.data = val
            self.release_charge_pub.publish(msg)
        self.get_logger().info(
            f'Undock: Released charge lock (error_status={self.error_status}, '
            f'odom_vel={self.odom_linear_x:.3f})')
        quit_dist = max(self.get_parameter('quit_pile_distance').value, 2.0)
        self._undock_start_time = time.monotonic()
        self._undock_target_time = quit_dist / abs(UNDOCK_VEL)
        self._undocking = True

    def _publish_drive(self, linear_x, angular_z=0.0):
        """Publish velocity via cloud_move_cmd (proven working with CChassisControl).
        cmd_vel alone doesn't move the mower — CChassisControl gates it."""
        msg = CloudMoveCmd()
        msg.stamp = self.get_clock().now().to_msg()
        msg.linear_x = float(linear_x)
        msg.angular_wheel = float(angular_z)
        self.cloud_move_pub.publish(msg)

    def _undock_tick(self):
        """Called at 10 Hz to manage undock driving.
        Phases: drive backward → hold position → verify off charger."""
        if not self._undocking:
            return
        elapsed = time.monotonic() - self._undock_start_time
        total_time = self._undock_target_time + UNDOCK_HOLD_TIME

        if elapsed < self._undock_target_time:
            # Phase 1: Drive backward — both cmd_vel AND cloud_move_cmd
            twist = Twist()
            twist.linear.x = UNDOCK_VEL
            twist.angular.z = 0.0
            self.cmd_vel_pub.publish(twist)
            self._publish_drive(UNDOCK_VEL, 0.0)
            # Log every 0.5s
            if int(elapsed * 10) % 5 == 0:
                self.get_logger().info(
                    f'Undock: t={elapsed:.1f}s vel_cmd={UNDOCK_VEL} '
                    f'odom_vel={self.odom_linear_x:.3f} '
                    f'charge_stop={self._charge_stop_active}')
        elif elapsed < total_time:
            # Phase 2: Hold position (brake) — prevent rollback on slopes
            self._publish_drive(0.0, 0.0)
        else:
            # Phase 3: Done — stop via cloud_move_cmd
            self._publish_drive(0.0, 0.0)
            self._undocking = False
            if self._charge_stop_active:
                self.get_logger().warn(
                    'Undock: charge_stop still active after undock '
                    '— mower rolled back onto charger!')
            else:
                self.is_on_charger = False
            self.get_logger().info(
                f'Undock: Complete (drove {self._undock_target_time:.1f}s '
                f'+ held {UNDOCK_HOLD_TIME:.1f}s, '
                f'on_charger={self._charge_stop_active})')
            if self._charge_stop_active:
                # Undock failed — stay in current state (or go FREE)
                self._undock_after_state = None
                self._set_state(TaskMode.FREE, WorkStatus.FAILED_ONCE)
            elif self._undock_after_state:
                mode, status = self._undock_after_state
                self._set_state(mode, status)
                self._undock_after_state = None
            else:
                self._set_state(TaskMode.FREE, WorkStatus.INIT_SUCCESS)

    # ─── Joystick control (Fase 3) ────────────────────────────

    def _on_cloud_move_cmd(self, msg: CloudMoveCmd):
        """Handle joystick commands from MQTT -> publish to cmd_vel."""
        if self._undocking:
            return
        # Block joystick during autonomous mapping (BoundaryFollow)
        if self._boundary_goal_handle is not None:
            return
        if (self.is_on_charger and
                (abs(msg.linear_x) > 0.01 or abs(msg.angular_wheel) > 0.01)):
            self.get_logger().info('Joystick: On charger, auto-undocking')
            self.request_undock()
            return
        twist = Twist()
        twist.linear.x = max(-MAX_LIN_VEL,
                             min(MAX_LIN_VEL, float(msg.linear_x)))
        twist.angular.z = max(-MAX_ANG_VEL,
                              min(MAX_ANG_VEL, float(msg.angular_wheel)))
        self.cmd_vel_pub.publish(twist)
        self._joystick_active = True
        self._last_joystick_time = time.monotonic()

    def _joystick_timeout_tick(self):
        """Stop motors if no joystick command for 1 second."""
        if not self._joystick_active:
            return
        if time.monotonic() - self._last_joystick_time > 1.0:
            # Don't publish zero velocity — let motors coast freely
            self._joystick_active = False

    # ─── Async service call helper ──────────────────────────────

    def call_service_async(self, client, request, service_name):
        """Fire-and-forget async service call with logging."""
        if not client.wait_for_service(timeout_sec=0.0):
            self.get_logger().warn(
                f'{service_name}: service not available (DDS discovery issue, '
                f'will attempt call anyway)')
        future = client.call_async(request)
        future.add_done_callback(
            lambda f: self._on_service_done(f, service_name))
        return future

    def _on_service_done(self, future, service_name):
        """Log result of async service call."""
        try:
            result = future.result()
            res = getattr(result, 'result', None)
            msg = getattr(result, 'message', '')
            self.get_logger().info(
                f'{service_name}: result={res}, message="{msg}"')
        except Exception as e:
            self.get_logger().error(f'{service_name}: FAILED — {e}')

    def _call_service_sync(self, client, request, timeout=5.0):
        """Synchronous service call with timeout. Uses busy-wait since we
        run on MultiThreadedExecutor with separate callback groups."""
        if not client.wait_for_service(timeout_sec=1.0):
            self.get_logger().warn(
                f'Service {client.srv_name} not available, trying anyway')
        future = client.call_async(request)
        deadline = time.monotonic() + timeout
        while not future.done():
            if time.monotonic() > deadline:
                self.get_logger().warn(
                    f'Service {client.srv_name} timed out ({timeout}s)')
                return None
            time.sleep(0.05)
        try:
            return future.result()
        except Exception as e:
            self.get_logger().error(
                f'Service {client.srv_name} failed: {e}')
            return None

    # ─── Mapping operations (Fase 4) ──────────────────────────

    def start_recording(self, rec_type=0):
        """Start GPS boundary recording.
        type: 0=passable (work zone), 1=obstacle, 2=unicom."""
        self.get_logger().info(
            f'Mapping: Starting recording (type={rec_type})')
        self._mapping_active = True
        self._mapping_polygon_points = []

        # Start GPS point recording via novabot_mapping
        req_rec = RecordingSrv.Request()
        req_rec.type = rec_type
        self.call_service_async(
            self.cli_recording_edge, req_rec, 'recording_edge')

    def stop_recording(self):
        """Stop GPS boundary recording via novabot_mapping."""
        self.get_logger().info('Mapping: Stopping recording')
        self._mapping_active = False

        req = RecordingSrv.Request()
        req.type = 0  # type field for stop (not used meaningfully)
        self.call_service_async(
            self.cli_recording_stop, req, 'recording_stop')

    def save_charger_pose(self, map_name='home0', child_map_name='map0'):
        """Save the charging station pose to the map."""
        self.get_logger().info(
            f'Mapping: Saving charger pose for map={map_name}')

        req = SetChargingPoseSrv.Request()
        req.control_mode = 1  # write
        req.map_file_name = map_name
        req.child_map_file_name = child_map_name

        future = self.call_service_async(
            self.cli_set_charging_pose, req, 'set_charging_pose')

        def on_charger_pose_saved(f):
            try:
                result = f.result()
                if result.result:
                    pose = result.charging_pose
                    self._charger_pose_x = pose.position.x
                    self._charger_pose_y = pose.position.y
                    self.get_logger().info(
                        f'Mapping: Charger pose saved, '
                        f'dist={result.map_to_charging_dis:.2f}m')
                else:
                    self.get_logger().warn(
                        f'Mapping: Save charger pose failed: '
                        f'{result.message}')
            except Exception as e:
                self.get_logger().error(
                    f'Mapping: Save charger pose error: {e}')

        future.add_done_callback(on_charger_pose_saved)

    def generate_sub_map(self):
        """Generate sub-map (type=0) from recorded boundary."""
        self.get_logger().info('Mapping: Generating sub-map')
        req = MappingSrv.Request()
        req.resolution = 0.05
        req.type = 0  # sub-map
        req.main_id = 0
        self.call_service_async(
            self.cli_mapping_data, req, 'mapping_data(sub-map)')

    def generate_whole_map(self):
        """Generate whole map (type=1) from all sub-maps."""
        self.get_logger().info('Mapping: Generating whole map')
        req = MappingSrv.Request()
        req.resolution = 0.05
        req.type = 1  # whole map
        req.main_id = 0
        self.call_service_async(
            self.cli_mapping_data, req, 'mapping_data(whole-map)')

    def _on_mapping_polygon(self, msg: MappingPolygon):
        """Handle mapping polygon data from novabot_mapping."""
        pts = [(p.x, p.y) for p in msg.polygon.points]
        self.get_logger().info(
            f'Mapping: Received polygon type={msg.type} '
            f'with {len(pts)} points')
        self._mapping_polygon_points = pts

    # ─── Autonomous mapping (Fase 8) ────────────────────────

    def _cancel_stale_nav_goals_once(self):
        """One-shot startup timer: cancel any stale navigate_to_pose goals.
        A stuck goal in nav2_single_node_navigator causes BoundaryFollow to
        abort with "Not supported now!!!" because nav2 is already busy.
        Uses /_action/cancel_goal service directly (Galactic has no cancel_all_goals_async).
        Sending zero UUID + zero stamp = cancel ALL goals on that action server."""
        self.nav_cancel_timer.cancel()
        if self._nav_cancel_done:
            return
        self._nav_cancel_done = True
        try:
            req = CancelGoalSrv.Request()
            # zero UUID + zero stamp = cancel ALL goals (ROS2 action protocol)
            req.goal_info.goal_id.uuid = [0] * 16
            req.goal_info.stamp.sec = 0
            req.goal_info.stamp.nanosec = 0
            self._nav_cancel_client.call_async(req)
            self.get_logger().info(
                'Startup: Sent cancel_all_nav_goals via /_action/cancel_goal service')
        except Exception as e:
            self.get_logger().warn(
                f'Startup: cancel nav goals failed: {e}')

    def _wait_for_perception_data(self, timeout_s=30.0):
        """Wait until /perception/points_labeled publishes at least one message.
        Returns True if data received, False if timeout.
        Uses a persistent subscription that stays active (no destroy to avoid
        executor conflicts in Galactic)."""
        if not hasattr(self, '_perception_data_received'):
            from sensor_msgs.msg import PointCloud2
            self._perception_data_received = False

            def on_points(msg):
                if not self._perception_data_received:
                    n_pts = len(msg.data) // msg.point_step if msg.point_step > 0 else 0
                    self.get_logger().info(
                        f'BoundaryFollow: perception data received! '
                        f'{n_pts} points, {len(msg.data)} bytes')
                    self._perception_data_received = True

            self.create_subscription(
                PointCloud2, '/perception/points_labeled', on_points,
                SENSOR_QOS)

        self._perception_data_received = False
        t0 = time.monotonic()
        last_log = 0
        while not self._perception_data_received and (time.monotonic() - t0) < timeout_s:
            elapsed = time.monotonic() - t0
            sec = int(elapsed)
            if sec > 0 and sec % 5 == 0 and sec != last_log:
                last_log = sec
                self.get_logger().info(
                    f'BoundaryFollow: waiting for perception data... '
                    f'{sec}/{int(timeout_s)}s')
            time.sleep(0.5)

        return self._perception_data_received

    def start_boundary_follow(self, follow_mode=1):
        """Start boundary following for autonomous mapping.
        follow_mode: 0=ASSIST_MAPPING, 1=AUTO_MAPPING, 2=BOUNDARY_CUTTING."""
        self.get_logger().info(
            f'BoundaryFollow: Starting (mode={follow_mode})')

        if not self.boundary_follow_client.wait_for_server(timeout_sec=5.0):
            self.get_logger().error(
                'BoundaryFollow: Action server not available!')
            return False

        # Verify mower is actually off the charger before starting
        if self._charge_stop_active:
            self.get_logger().warn(
                'BoundaryFollow: Mower still on charger! '
                'Waiting 5s for charge_stop to clear...')
            deadline = time.monotonic() + 5.0
            while self._charge_stop_active and time.monotonic() < deadline:
                time.sleep(0.2)
            if self._charge_stop_active:
                self.get_logger().error(
                    'BoundaryFollow: Mower still on charger after wait! '
                    'Cannot start boundary follow.')
                self._set_state(TaskMode.FREE, WorkStatus.FAILED_ONCE)
                return False

        # --- Phase 1: Start cameras ---
        # coverage_planner_server configures perception/costmap ITSELF
        # (it calls set_infer_model, set_semantic_mode, set_detection_mode).
        # We only need to ensure cameras are running so perception has input.
        self.get_logger().info('BoundaryFollow: Phase 1 — Starting cameras')
        self.start_cameras()
        time.sleep(3.0)  # Allow cameras to initialize hardware

        # --- Phase 2: Enable perception (camera needs do_perception to stream) ---
        self.get_logger().info('BoundaryFollow: Phase 2 — Enabling perception')
        req_p = SetBool.Request()
        req_p.data = True
        result_p = self._call_service_sync(
            self.cli_perception, req_p, timeout=5.0)
        if result_p:
            self.get_logger().info(
                f'BoundaryFollow: do_perception={result_p.success}')
        else:
            self.get_logger().warn('BoundaryFollow: do_perception call failed')

        # Set infer model so BPU starts producing labeled points
        self.set_infer_model(3)

        # NOTE: Do NOT set semantic_mode, detection_mode, or obstacle_range_params here.
        # coverage_planner_server calls these services itself when BoundaryFollow starts.
        # Our calls would conflict with or be overwritten by the server.

        # --- Phase 3: Wait for perception data ---
        self.get_logger().info(
            'BoundaryFollow: Phase 3 — Waiting for perception data '
            '(up to 30s for BPU model warmup)...')
        has_data = self._wait_for_perception_data(timeout_s=30.0)

        if not has_data:
            self.get_logger().error(
                'BoundaryFollow: NO perception data after 30s!')
            self.stop_cameras()
            self.set_perception_level(0)
            self._set_state(TaskMode.FREE, WorkStatus.FAILED_ONCE)
            return False

        self.get_logger().info(
            'BoundaryFollow: Perception data confirmed! Proceeding...')

        # --- Phase 5: Prepare map infrastructure ---
        load_map_path = self.get_parameter('load_map_path').value
        req = GenerateEmptyMapSrv.Request()
        req.map_path = load_map_path
        req.resolution = 0.05
        req.width = 30.0   # 30m initial empty map
        req.height = 30.0
        result = self._call_service_sync(
            self.cli_generate_empty_map, req, timeout=5.0)
        if result and result.result:
            self.get_logger().info(
                f'BoundaryFollow: Empty map generated at {load_map_path}')
        else:
            self.get_logger().warn(
                'BoundaryFollow: Empty map generation failed, continuing')

        # Start GPS recording for boundary (same as manual mapping)
        rec_req = RecordingSrv.Request()
        rec_req.type = 0  # work area
        rec_result = self._call_service_sync(
            self.cli_recording_edge, rec_req, timeout=5.0)
        if rec_result and rec_result.result:
            self._mapping_active = True
            self.get_logger().info('BoundaryFollow: GPS recording started')
        else:
            self.get_logger().warn(
                'BoundaryFollow: GPS recording failed, continuing')

        # --- Phase 6: Start BoundaryFollow action ---
        self.get_logger().info('BoundaryFollow: Phase 6 — Sending goal')
        goal = BoundaryFollow.Goal()
        goal.follow_mode = follow_mode
        goal.enable_coverage = False
        goal.more_close_to_boundary = False
        goal.close_loop_stop = True
        goal.start_follow_wait = False  # Don't wait — drive around to find boundary
        goal.debug_mode = False
        goal.inflation_radius = 0.0
        goal.blade_height = 0

        send_future = self.boundary_follow_client.send_goal_async(
            goal, feedback_callback=self._on_boundary_feedback)
        send_future.add_done_callback(self._on_boundary_goal_response)
        return True

    def _on_boundary_feedback(self, feedback_msg):
        """Handle BoundaryFollow action feedback."""
        fb = feedback_msg.feedback
        self.get_logger().info(
            f'BoundaryFollow: progress={getattr(fb, "progress", "?")} '
            f'status={getattr(fb, "status", "?")}')

    def _on_boundary_goal_response(self, future):
        try:
            goal_handle = future.result()
        except Exception as e:
            self.get_logger().error(
                f'BoundaryFollow: Goal send failed: {e}')
            self._set_state(TaskMode.MAPPING, WorkStatus.FAILED_ONCE)
            return

        if not goal_handle.accepted:
            self.get_logger().warn('BoundaryFollow: Goal rejected')
            self._set_state(TaskMode.MAPPING, WorkStatus.FAILED_ONCE)
            return

        self.get_logger().info('BoundaryFollow: Goal accepted')
        self._boundary_goal_handle = goal_handle
        result_future = goal_handle.get_result_async()
        result_future.add_done_callback(self._on_boundary_result)

    def _on_boundary_result(self, future):
        self._boundary_goal_handle = None
        # Stop cameras + disable perception pipeline + reset semantic mode
        self.stop_cameras()
        self.set_perception_level(0)  # disable do_perception
        self.set_semantic_mode(1)  # FREE_MOVE
        # Restore default obstacle detection range
        self.set_obstacle_range_params(max_range=1.2, max_height=0.35)

        # Stop GPS recording
        if self._mapping_active:
            rec_req = RecordingSrv.Request()
            rec_req.type = 0
            self._call_service_sync(
                self.cli_recording_stop, rec_req, timeout=5.0)
            self._mapping_active = False
            self.get_logger().info('BoundaryFollow: GPS recording stopped')

        try:
            wrapped = future.result()
            goal_status = wrapped.status  # GoalStatus: SUCCEEDED=4, ABORTED=6, CANCELED=5
            result = wrapped.result
            self.get_logger().info(
                f'BoundaryFollow: Done, goal_status={goal_status} '
                f'result_code={result.status}, msg="{result.msg}"')
            if goal_status != 4:  # not SUCCEEDED → aborted or cancelled
                self.get_logger().warn(
                    f'BoundaryFollow: Goal not succeeded (goal_status={goal_status},'
                    f' result_code={result.status}) — aborted by server')
                self._set_state(TaskMode.FREE, WorkStatus.FAILED_ONCE)
                return
            if result.status == 0:  # LOOP_CLOSED
                self.get_logger().info(
                    'BoundaryFollow: Loop closed! Generating map...')
                self._set_state(TaskMode.MAPPING,
                                WorkStatus.MAPPING_STOP_RECORD)

                # Step 1: Save charger pose (synchronous)
                ok = self.service_handlers._save_charging_pose_internal(
                    self.current_map_name or 'home0', 'map0')
                if not ok:
                    self.get_logger().warn(
                        'BoundaryFollow: Charger pose save failed')

                # Step 2: Generate sub-map (synchronous)
                ok_sub, _ = self.service_handlers._generate_map(0)
                if ok_sub:
                    # Step 3: Generate whole map (synchronous)
                    ok_whole, _ = self.service_handlers._generate_map(1)
                    if ok_whole:
                        # Step 4: Save UTM origin
                        self.save_utm_origin()
                        self.get_logger().info(
                            'BoundaryFollow: Map generation complete!')
                        self._set_state(TaskMode.FREE,
                                        WorkStatus.FINISHED_ONCE)
                    else:
                        self.get_logger().error(
                            'BoundaryFollow: Whole map generation failed')
                        self._set_state(TaskMode.FREE,
                                        WorkStatus.FAILED_ONCE)
                else:
                    self.get_logger().error(
                        'BoundaryFollow: Sub-map generation failed')
                    self._set_state(TaskMode.FREE,
                                    WorkStatus.FAILED_ONCE)
            elif result.status == 2:  # CANCELLED
                self._set_state(TaskMode.FREE, WorkStatus.CANCELLED)
            else:
                self.get_logger().warn(
                    f'BoundaryFollow: Failed (status={result.status})')
                self._set_state(TaskMode.FREE, WorkStatus.FAILED_ONCE)
        except Exception as e:
            self.get_logger().error(f'BoundaryFollow: Result error: {e}')
            self._set_state(TaskMode.FREE, WorkStatus.FAILED_ONCE)

    def cancel_boundary_follow(self):
        """Cancel running boundary follow action."""
        if self._boundary_goal_handle is not None:
            self.get_logger().info('BoundaryFollow: Cancelling...')
            self._boundary_goal_handle.cancel_goal_async()
            self._boundary_goal_handle = None

    # ─── Coverage/Mowing (Fase 5) ────────────────────────────

    def start_coverage(self, map_yaml, blade_height=40,
                       include_edge=False, specify_direction=False,
                       cov_direction=0, perception_level=1):
        """Start coverage mowing via NavigateThroughCoveragePaths action."""
        self.get_logger().info(
            f'Coverage: Starting with map={map_yaml} '
            f'blade={blade_height} edge={include_edge}')

        if not self.coverage_action_client.wait_for_server(timeout_sec=5.0):
            self.get_logger().error(
                'Coverage: Action server not available!')
            self._set_state(TaskMode.FREE, WorkStatus.FAILED_ONCE)
            return False

        # Clear costmaps before starting
        self._clear_costmaps()

        # Turn on LED + set blade height
        self._set_led(1)
        self._set_blade_height(blade_height)

        # Start cameras for perception
        self.start_cameras()

        # Set costmap semantic mode for coverage
        self.set_semantic_mode(0)  # LAWN_COVER

        # Set perception level (enables perception + inference model + seg level)
        self.set_perception_level(perception_level)

        # Build goal
        goal = NavigateThroughCoveragePaths.Goal()
        goal.map_yaml = map_yaml
        goal.coverage_type = 0  # COVERAGE_BY_FILE
        goal.return_to_start = True
        goal.reset_coverage_map = True
        goal.setting_blade_height = True
        goal.blade_height = blade_height
        goal.adaptive_mode = 1  # reciprocal
        goal.include_edge = include_edge
        goal.specify_direction = specify_direction
        goal.cov_direction = cov_direction
        goal.target_repeat_times = self.get_parameter(
            'coverage_times').value
        goal.auto_repeat_num = False
        goal.ignore_start_for_planning = False
        goal.disable_recover = False
        goal.enable_tf_action_abort_as_stop = False
        goal.mixed_edge = False
        goal.debug_mode = False
        goal.only_edge_mode = False
        goal.enable_check_walkable = False
        goal.back_avoid_mode = False

        self._cov_start_time = time.monotonic()

        send_goal_future = self.coverage_action_client.send_goal_async(
            goal, feedback_callback=self._on_coverage_feedback)
        send_goal_future.add_done_callback(self._on_coverage_goal_response)
        return True

    def _on_coverage_goal_response(self, future):
        """Handle coverage action goal acceptance/rejection."""
        try:
            goal_handle = future.result()
        except Exception as e:
            self.get_logger().error(
                f'Coverage: Goal send failed: {e}')
            self._set_state(TaskMode.FREE, WorkStatus.FAILED_ONCE)
            return

        if not goal_handle.accepted:
            self.get_logger().warn('Coverage: Goal rejected!')
            self._set_state(TaskMode.FREE, WorkStatus.FAILED_ONCE)
            return

        self.get_logger().info('Coverage: Goal accepted, mowing started!')
        self._coverage_goal_handle = goal_handle

        result_future = goal_handle.get_result_async()
        result_future.add_done_callback(self._on_coverage_result)

    def _on_coverage_feedback(self, feedback_msg):
        """Handle coverage action feedback — update RobotStatus fields."""
        fb = feedback_msg.feedback
        self.cov_ratio = fb.covered_ratio
        self.cov_area = fb.task_covered_area
        self.cov_remaining_area = (fb.task_planned_area
                                   - fb.task_covered_area)
        self.cov_estimate_time = fb.estimate_remaining_time
        self.cov_work_time = fb.navigation_time
        self.valid_cov_work_time = fb.navigation_time

        # Map feedback work_status to our WorkStatus
        if fb.work_status == 100:  # COVERING
            if self.work_status != WorkStatus.COVERING:
                self._set_state(TaskMode.COVER, WorkStatus.COVERING)
        elif fb.work_status == 150:  # BOUNDARY_COVERING
            if self.work_status != WorkStatus.BOUNDARY_COVERING:
                self._set_state(TaskMode.COVER,
                                WorkStatus.BOUNDARY_COVERING)
        elif fb.work_status == 250:  # MOVING
            if self.work_status != WorkStatus.MOVING:
                self._set_state(TaskMode.COVER, WorkStatus.MOVING)

    def _on_coverage_result(self, future):
        """Handle coverage action result — transition state."""
        try:
            result = future.result().result
        except Exception as e:
            self.get_logger().error(
                f'Coverage: Result failed: {e}')
            self._set_state(TaskMode.FREE, WorkStatus.FAILED_ONCE)
            self._coverage_goal_handle = None
            return

        elapsed = time.monotonic() - self._cov_start_time
        self.get_logger().info(
            f'Coverage: Action completed! '
            f'status={result.result_status} '
            f'covered={result.total_covered_area:.1f}m² '
            f'ratio={result.covered_ratio:.0%} '
            f'time={elapsed:.0f}s msg="{result.msg}"')

        # Publish CovTaskResult
        cov_result = CovTaskResult()
        cov_result.cov_ratio = result.covered_ratio
        cov_result.cov_area = result.total_covered_area
        cov_result.cov_work_time = elapsed
        self.cov_result_pub.publish(cov_result)

        # Map result_status to state transition
        if result.result_status == 100:  # FINISHED
            self._set_state(TaskMode.FREE, WorkStatus.FINISHED_ONCE)
        elif result.result_status == 3:  # CANCELED
            self._set_state(TaskMode.FREE, WorkStatus.CANCELLED)
        elif result.result_status == 90:  # PARTIALLY_FINISHED
            self._set_state(TaskMode.FREE, WorkStatus.FINISHED_ONCE)
        else:
            self.get_logger().warn(
                f'Coverage: Failed with status '
                f'{result.result_status}')
            self._set_state(TaskMode.FREE, WorkStatus.FAILED_ONCE)

        # Disable perception
        self.set_perception_level(0)

        # Stop cameras
        self.stop_cameras()

        # Turn off LED
        self._set_led(0)

        # Reset costmap to free move mode
        self.set_semantic_mode(1)  # FREE_MOVE

        self._coverage_goal_handle = None

    def cancel_coverage(self):
        """Cancel running coverage action."""
        if self._coverage_goal_handle is not None:
            self.get_logger().info('Coverage: Cancelling...')
            self._coverage_goal_handle.cancel_goal_async()

        # Also stop via coverage_planner service
        req = SetBool.Request()
        req.data = True
        self.call_service_async(
            self.cli_cover_task_stop, req, 'cover_task_stop')

    # ─── Map loading, costmaps, LED, path JSON (Fase 8) ────

    def _clear_costmaps(self):
        """Clear local and global costmaps."""
        req = ClearCostmapAroundRobot.Request()
        req.reset_distance = 5.0  # meters
        if self.cli_clear_local_costmap.wait_for_service(timeout_sec=0.0):
            self.call_service_async(
                self.cli_clear_local_costmap, req, 'clear_local_costmap')
        if self.cli_clear_global_costmap.wait_for_service(timeout_sec=0.0):
            self.call_service_async(
                self.cli_clear_global_costmap, req, 'clear_global_costmap')

    def _set_led(self, state):
        """Set LED state: 0=off, 1=on. Gated by enable_led_light param."""
        if not self.get_parameter('enable_led_light').value:
            return
        msg = UInt8()
        msg.data = state
        self.led_pub.publish(msg)

    def _set_blade_height(self, height):
        """Set blade height (mm). Valid: 20-90 in steps of 10."""
        msg = UInt8()
        msg.data = max(20, min(90, height))
        self.blade_height_pub.publish(msg)
        self.get_logger().info(f'Blade height set to {msg.data}mm')

    def _set_blade_speed(self, speed):
        """Set blade speed. 0=off, positive=on."""
        msg = Int16()
        msg.data = speed
        self.blade_speed_pub.publish(msg)

    def save_utm_origin(self):
        """Save current UTM origin to pos.json."""
        utm_path = self.get_parameter('save_utm_path').value
        if not self.cli_save_utm.wait_for_service(timeout_sec=0.0):
            self.get_logger().warn('save_utm: service not available')
            return
        req = SaveUtmOriginInfo.Request()
        req.utm_info_path = utm_path
        self.call_service_async(self.cli_save_utm, req, 'save_utm')

    def clear_error(self):
        """Clear error status when incident is resolved."""
        if self.error_status != ErrorStatus.NONE:
            self.get_logger().info(
                f'Error cleared: {self.error_status.name} -> NONE')
            self.error_status = ErrorStatus.NONE
            self.error_msg = ''

    def publish_path_json(self, path_file, publisher):
        """Read a path JSON file and publish it."""
        try:
            with open(path_file, 'r') as f:
                content = f.read()
            msg = String()
            msg.data = content
            publisher.publish(msg)
        except FileNotFoundError:
            pass

    # ─── Camera control (v10) ───────────────────────────────

    def start_cameras(self):
        """Start all cameras (panoramic, preposition, ToF)."""
        self.get_logger().info('Camera: Starting all cameras')
        req = SetBool.Request()
        req.data = True
        self.call_service_async(
            self.cli_panoramic_camera, req, 'panoramic_camera(start)')
        self.call_service_async(
            self.cli_preposition_camera, req, 'preposition_camera(start)')
        self.call_service_async(
            self.cli_tof_camera, req, 'tof_camera(start)')

    def stop_cameras(self):
        """Stop all cameras."""
        self.get_logger().info('Camera: Stopping all cameras')
        req = SetBool.Request()
        req.data = False
        self.call_service_async(
            self.cli_panoramic_camera, req, 'panoramic_camera(stop)')
        self.call_service_async(
            self.cli_preposition_camera, req, 'preposition_camera(stop)')
        self.call_service_async(
            self.cli_tof_camera, req, 'tof_camera(stop)')

    def save_camera_image(self, filename=''):
        """Save current camera image via preposition camera."""
        if not self.get_parameter('enable_save_image').value:
            return
        req = SaveFileSrv.Request()
        req.filename = filename
        self.call_service_async(
            self.cli_preposition_save, req, 'preposition_save')

    def save_pcd_image(self, filename=''):
        """Save point cloud + image data."""
        if not self.get_parameter('save_tof_rgb').value:
            return
        req = SaveFileSrv.Request()
        req.filename = filename
        self.call_service_async(
            self.cli_save_pcd_img, req, 'save_pcd_img')

    def report_camera_hw_exception(self, has_exception):
        """Report camera hardware exception to camera node."""
        req = SetBool.Request()
        req.data = has_exception
        self.call_service_async(
            self.cli_preposition_hw_exception, req,
            'camera_hw_exception')

    def _on_camera_gain(self, msg: UInt32):
        """Darkness callback: mirrors robot_decision.orig cameraDarknessCallback.
        total_gain is the camera AGC output — high value means dark scene.
        Calls /local_costmap/set_detection_mode(True) in dark to ignore ToF height,
        and ensures LED is on when in auto-dock state at night."""
        gain = msg.data
        thresh = self.get_parameter('image_darkness_thresh').value        # 60.0
        thresh_lower = self.get_parameter('image_darkness_thresh_lower').value  # 5.0

        was_dark = self._camera_is_dark
        if gain > thresh:
            self._camera_is_dark = True
        elif gain < thresh_lower:
            self._camera_is_dark = False

        if self._camera_is_dark != was_dark:
            self.get_logger().info(
                f'Camera darkness: {"DARK" if self._camera_is_dark else "BRIGHT"} '
                f'(gain={gain}, thresh={thresh})')
            # Set detection mode: True=ignore tof height (for dark/night operation)
            self.set_detection_mode(self._camera_is_dark)

    def set_camera_gain(self, gain):
        """Set camera total gain (exposure control)."""
        req = SetUint8Srv.Request()
        req.value = gain
        self.call_service_async(
            self.cli_preposition_gain, req, 'camera_gain')

    def check_camera_clean(self):
        """Check camera cleanliness at boot if enabled."""
        if not self.get_parameter('check_camera_clean').value:
            return
        # Start preposition camera briefly to check image quality
        req = SetBool.Request()
        req.data = True
        self.call_service_async(
            self.cli_preposition_camera, req,
            'camera_clean_check(start)')
        self.get_logger().info('Camera: Clean check started')

    # ─── Perception control (v10) ───────────────────────────

    def set_infer_model(self, model):
        """Set AI inference model.
        model: 0=default, 1=enhanced, etc."""
        req = SetUint8Srv.Request()
        req.value = model
        self.call_service_async(
            self.cli_set_infer_model, req,
            f'set_infer_model({model})')

    def set_seg_level(self, level):
        """Set segmentation/perception level.
        level: 0=off, 1=normal, 2=enhanced."""
        req = SetUint8Srv.Request()
        req.value = level
        self.call_service_async(
            self.cli_set_seg_level, req,
            f'set_seg_level({level})')

    def set_perception_level(self, level):
        """Set full perception pipeline level.
        Adjusts inference model, segmentation, and detection mode."""
        self.perception_level = level
        min_level = self.get_parameter('min_perception_level').value

        # Clamp to minimum
        effective = max(level, min_level)
        self.get_logger().info(
            f'Perception: Setting level {effective} '
            f'(requested={level}, min={min_level})')

        # Enable/disable perception
        req = SetBool.Request()
        req.data = effective > 0
        self.call_service_async(
            self.cli_perception, req,
            f'perception({"enable" if effective > 0 else "disable"})')

        # Set inference model based on level
        if effective > 0:
            self.set_infer_model(effective)
            self.set_seg_level(effective)

            # Enable detection mode in costmap
            det_req = SetBool.Request()
            det_req.data = True
            self.call_service_async(
                self.cli_detection_mode, det_req,
                'detection_mode(enable)')

    # ─── Costmap control (v10) ──────────────────────────────

    def set_semantic_mode(self, mode):
        """Set costmap semantic mode.
        0=LAWN_COVER, 1=FREE_MOVE, 2=BOUNDARY_FOLLOW, 3=IGNORE_SEMANTIC."""
        req = SemanticMode.Request()
        req.semantic_mode = mode
        self.call_service_async(
            self.cli_semantic_mode, req,
            f'semantic_mode({mode})')

    def set_detection_mode(self, enabled):
        """Enable/disable obstacle detection in costmap."""
        req = SetBool.Request()
        req.data = enabled
        self.call_service_async(
            self.cli_detection_mode, req,
            f'detection_mode({"on" if enabled else "off"})')

    def set_obstacle_range_params(self, max_range: float, max_height: float):
        """Set costmap obstacle detection range and height limits.

        max_range: obstacle_max_range and raytrace_max_range (m)
        max_height: max_obstacle_height (m)
        These are set on the local_costmap obstacle layer to capture
        boundary objects that may be further than the default 1.2m range.
        """
        def make_param(name, value):
            p = Parameter()
            p.name = name
            p.value = ParameterValue()
            p.value.type = ParameterType.PARAMETER_DOUBLE
            p.value.double_value = value
            return p

        req = SetParamsSrv.Request()
        req.parameters = [
            make_param('obstacle_layer.pointcloud.obstacle_max_range', max_range),
            make_param('obstacle_layer.pointcloud.raytrace_max_range', max_range + 0.5),
            make_param('obstacle_layer.pointcloud.max_obstacle_height', max_height),
        ]
        self.call_service_async(
            self.cli_costmap_set_params, req,
            f'costmap_obstacle_params(range={max_range}, max_h={max_height})')

    def _set_recharge_led_brightness(self, value: int):
        """Set auto_recharge_server brightness_adjustment_value parameter.
        Default is 1 (LED value=1 when dark, nearly off). Set to 255 for full brightness.
        auto_recharge_server publishes this value to /led_set when total_gain > threshold."""
        p = Parameter()
        p.name = 'brightness_adjustment_value'
        p.value = ParameterValue()
        p.value.type = ParameterType.PARAMETER_INTEGER
        p.value.integer_value = value
        req = SetParamsSrv.Request()
        req.parameters = [p]
        self.call_service_async(
            self.cli_auto_recharge_set_params, req,
            f'recharge_led_brightness({value})')

    def set_prohibited_points(self, enabled):
        """Enable/disable prohibited points in costmap."""
        req = SetBool.Request()
        req.data = enabled
        self.call_service_async(
            self.cli_prohibited_points, req,
            f'prohibited_points({"on" if enabled else "off"})')

    def report_maybe_stuck(self, stuck):
        """Report to nav2 that robot may be stuck."""
        req = SetBool.Request()
        req.data = stuck
        self.call_service_async(
            self.cli_maybe_stuck, req,
            f'maybe_stuck({stuck})')

    # ─── LED buzzer control (v10) ───────────────────────────

    def set_led_buzzer(self, value):
        """Set LED/buzzer via chassis node.
        Bit field: bit0=LED, bit1=buzzer, etc."""
        req = SetUint8Srv.Request()
        req.value = value
        self.call_service_async(
            self.cli_led_buzzer, req,
            f'led_buzzer({value})')

    def set_led_level(self, level):
        """Set LED brightness level."""
        req = SetUint8Srv.Request()
        req.value = level
        self.call_service_async(
            self.cli_led_level, req,
            f'led_level({level})')

    # ─── Charging / Auto-recharge (Fase 6) ──────────────────

    def start_recharge(self):
        """Start full recharge sequence: read charger pose → navigate → dock."""
        self.get_logger().info('Recharge: Starting recharge sequence')
        self._set_state(TaskMode.RECHARGING, WorkStatus.RETURN_TO_PILE,
                        recharge_status=RechargeStatus.NAVIGATING)

        # Read saved charger pose
        req = SetChargingPoseSrv.Request()
        req.control_mode = 0  # read
        req.map_file_name = 'home0'
        req.child_map_file_name = 'map0'

        future = self.cli_set_charging_pose.call_async(req)
        future.add_done_callback(self._on_charger_pose_read)

    def _on_charger_pose_read(self, future):
        """After reading charger pose, navigate to it."""
        try:
            result = future.result()
            if result.result:
                pose = result.charging_pose
                self.get_logger().info(
                    f'Recharge: Charger pose read, '
                    f'dist={result.map_to_charging_dis:.2f}m, '
                    f'pos=({pose.position.x:.2f},{pose.position.y:.2f})')
                # Build PoseStamped for navigation.
                # Use stamp=Time(0) so TF lookups use "latest available" instead
                # of a specific time that may predate the current TF buffer.
                ps = PoseStamped()
                ps.header.frame_id = 'map'
                ps.header.stamp = TimeMsg(sec=0, nanosec=0)
                ps.pose = pose
                self._charger_pose_stamped = ps
                self._navigate_to_charger(ps)
            else:
                self.get_logger().warn(
                    f'Recharge: No charger pose saved ({result.message}), '
                    f'trying AutoCharging directly')
                self._start_auto_charging()
        except Exception as e:
            self.get_logger().warn(
                f'Recharge: Failed to read charger pose ({e}), '
                f'trying AutoCharging directly')
            self._start_auto_charging()

    def _navigate_to_charger(self, pose_stamped):
        """Navigate to charger position via nav2."""
        if not self.navigate_action_client.wait_for_server(timeout_sec=5.0):
            self.get_logger().warn(
                'Recharge: NavigateToPose server not available, '
                'trying AutoCharging directly')
            self._start_auto_charging()
            return

        goal = NavigateToPoseAction.Goal()
        goal.pose = pose_stamped
        goal.behavior_tree = ''
        goal.controller_id = ''
        goal.goal_checker_id = ''

        self.get_logger().info(
            f'Recharge: Navigating to charger at '
            f'({pose_stamped.pose.position.x:.2f},'
            f'{pose_stamped.pose.position.y:.2f})')

        send_future = self.navigate_action_client.send_goal_async(
            goal, feedback_callback=self._nav_feedback_cb)
        send_future.add_done_callback(self._nav_goal_response_cb)

    def _nav_goal_response_cb(self, future):
        """Handle NavigateToPose goal response."""
        try:
            goal_handle = future.result()
        except Exception as e:
            self.get_logger().error(f'Recharge: Nav goal send failed: {e}')
            self._start_auto_charging()
            return

        if not goal_handle.accepted:
            self.get_logger().warn('Recharge: Nav goal rejected')
            self._start_auto_charging()
            return

        self.get_logger().info('Recharge: Nav goal accepted')
        self._nav_goal_handle = goal_handle
        result_future = goal_handle.get_result_async()
        result_future.add_done_callback(self._nav_result_cb)

    def _nav_feedback_cb(self, feedback_msg):
        """Handle NavigateToPose feedback."""
        fb = feedback_msg.feedback
        self.get_logger().debug(
            f'Recharge: Nav dist_remaining={fb.distance_remaining:.2f}m')

    def _nav_result_cb(self, future):
        """Handle NavigateToPose result → start AutoCharging."""
        self._nav_goal_handle = None
        try:
            result = future.result().result
            self.get_logger().info(
                f'Recharge: Navigation complete (status={result.status})')
        except Exception as e:
            self.get_logger().warn(
                f'Recharge: Navigation result error: {e}')

        # Regardless of nav result, try auto charging
        self._set_state(TaskMode.RECHARGING, WorkStatus.ALIGN_PILE,
                        recharge_status=RechargeStatus.DOCKING)
        self._start_auto_charging()

    # ─── Heading discovery (ArUco auto-dock at boot) ────────

    def _enable_aruco(self, enable: bool = True) -> None:
        """Enable/disable ArUco localization for heading alignment."""
        if not self.cli_enable_aruco.wait_for_service(timeout_sec=2.0):
            self.get_logger().warn(
                'enable_aruco_localization service niet beschikbaar')
            return
        req = SetBool.Request()
        req.data = enable
        self.cli_enable_aruco.call_async(req)
        self.get_logger().info(
            f'ArUco localization {"ingeschakeld" if enable else "uitgeschakeld"}')

    def _load_heading_cache(self) -> bool:
        """Lees heading cachefile. Geeft True als recente cache aanwezig."""
        try:
            with open(HEADING_CACHE_PATH) as f:
                data = json.load(f)
            age = time.time() - data.get('timestamp', 0)
            if age < HEADING_CACHE_TTL_S:
                self._heading_cached = True
                self.get_logger().info(
                    f'Heading cache gevonden (leeftijd {age / 3600:.1f}u) — '
                    f'drive-around overgeslagen')
                return True
        except (FileNotFoundError, json.JSONDecodeError, KeyError):
            pass
        self._heading_cached = False
        return False

    def _save_heading_cache(self) -> None:
        """Schrijf heading cachefile na succesvolle dock."""
        try:
            data = {
                'timestamp': time.time(),
                'loc_quality': self.loc_quality,
            }
            with open(HEADING_CACHE_PATH, 'w') as f:
                json.dump(data, f)
            self.get_logger().info(
                f'Heading cache opgeslagen (loc_quality={self.loc_quality})')
        except OSError as e:
            self.get_logger().warn(f'Heading cache schrijven mislukt: {e}')

    def _start_heading_discovery(self) -> None:
        """Rijd van dock af + draai rond totdat heading bekend is, dan auto-dock."""
        self.get_logger().info(
            f'Heading discovery: rijd {DRIVE_OFF_TIME_S}s van dock af...')
        self._heading_phase = 'drive_off'
        self._heading_phase_start = time.monotonic()
        self._heading_timer = self.create_timer(
            0.2, self._heading_discovery_tick)

    def _heading_discovery_tick(self) -> None:
        """Timer callback: beheert drive-off + spin totdat heading verkregen."""
        # Safety: abort heading discovery if no longer in appropriate state.
        if self.task_mode not in (TaskMode.FREE,) or self.is_on_charger:
            self.cmd_vel_pub.publish(Twist())  # Stop motors
            if self._heading_timer is not None:
                self._heading_timer.cancel()
                self._heading_timer = None
            self._heading_phase = None
            self.get_logger().info(
                f'Heading discovery: aborted (mode={self.task_mode}, '
                f'on_charger={self.is_on_charger})')
            return

        elapsed = time.monotonic() - self._heading_phase_start

        # Safety: charger contact during heading discovery means we're right next to dock.
        # Stop driving and transition to spinning to collect GPS data, then dock.
        if self._heading_phase == 'drive_off' and self._charge_stop_active:
            self.cmd_vel_pub.publish(Twist())  # Stop
            self.get_logger().info(
                'Heading discovery: charger contact during drive-off — switching to spin')
            self._heading_phase = 'spinning'
            self._heading_phase_start = time.monotonic()
            return

        if self._heading_phase == 'drive_off':
            twist = Twist()
            twist.linear.x = DRIVE_OFF_SPEED
            self.cmd_vel_pub.publish(twist)
            if elapsed >= DRIVE_OFF_TIME_S:
                self.get_logger().info(
                    'Heading discovery: van dock af — nu ronddraaien...')
                self._heading_phase = 'spinning'
                self._heading_phase_start = time.monotonic()

        elif self._heading_phase == 'spinning':
            if self.loc_quality >= 100:
                self.get_logger().info(
                    f'Heading verkregen (loc_quality={self.loc_quality}) '
                    f'— auto-dock starten')
                self._stop_heading_discovery()
            elif elapsed >= HEADING_TIMEOUT_S:
                self.get_logger().warn(
                    f'Heading timeout na {HEADING_TIMEOUT_S:.0f}s '
                    f'(loc_quality={self.loc_quality}) — toch auto-dock proberen')
                self._stop_heading_discovery()
            else:
                # Safety: stop spinning if charger contact (mower drifted to dock).
                if self._charge_stop_active:
                    self.cmd_vel_pub.publish(Twist())
                    self.get_logger().info(
                        'Heading discovery: charger contact during spin — stopping')
                else:
                    twist = Twist()
                    twist.angular.z = SPIN_SPEED
                    self.cmd_vel_pub.publish(twist)

    def _stop_heading_discovery(self) -> None:
        """Stop heading discovery en start auto-dock via start_recharge() for correct positioning."""
        # Don't publish zero velocity here — let motors coast.
        # Safety brakes are handled in _heading_discovery_tick.
        if self._heading_timer is not None:
            self._heading_timer.cancel()
            self._heading_timer = None
        self._heading_phase = None
        self.start_recharge()

    def _start_auto_charging(self):
        """Start AutoCharging action to dock onto charger."""
        if not self.auto_charging_client.wait_for_server(timeout_sec=5.0):
            self.get_logger().error(
                'Recharge: AutoCharging server not available!')
            self._set_state(TaskMode.FREE, WorkStatus.FAILED_ONCE,
                            recharge_status=RechargeStatus.FAILED)
            return

        goal = AutoCharging.Goal()
        goal.overwrite = False
        goal.non_charging_pose_mode = True
        # enable_no_visual_recharge: if ArUco visual fails but charge_pose is set,
        # fall back to position-based docking (GPS navigation to charger). Needed at night.
        goal.enable_no_visual_recharge = (self._charger_pose_stamped is not None)
        if self._charger_pose_stamped is not None:
            # Refresh stamp to current time so TF lookup in auto_recharge_server works.
            # Stale stamps cause "extrapolation into the past" TF errors.
            self._charger_pose_stamped.header.stamp = self.get_clock().now().to_msg()
            goal.charge_pose = self._charger_pose_stamped
        goal.max_retry = 5
        # Disable charge-current check: auto_recharge_server otherwise waits for
        # charging current > threshold. At high battery levels (>= 85%) current is too
        # low, causing RECHARGE_FAIL even though physical contact is made correctly.
        goal.disable_charge_check = (self.battery_power >= 85)
        goal.keep_alive = False
        goal.rotate_searching = (self.loc_quality < 100)

        # Ensure preposition camera is running for ArUco detection.
        # Camera may have been stopped after mowing or never started.
        req_cam = SetBool.Request()
        req_cam.data = True
        self.call_service_async(
            self.cli_preposition_camera, req_cam, 'preposition_camera(aruco)')

        # When dark: set auto_recharge_server brightness_adjustment_value to 255.
        # Default value is 1 (LED nearly off at night) — way too dim for ArUco detection.
        # auto_recharge_server publishes led_set = brightness_adjustment_value when dark.
        if self._camera_is_dark:
            self._set_recharge_led_brightness(255)

        self._set_led(1)  # LED aan voor ArUco camera zicht (ook 's nachts)
        self.get_logger().info('Recharge: Starting AutoCharging action')
        self._set_state(TaskMode.RECHARGING, WorkStatus.ALIGN_PILE,
                        recharge_status=RechargeStatus.DOCKING)

        send_future = self.auto_charging_client.send_goal_async(
            goal, feedback_callback=self._charging_feedback_cb)
        send_future.add_done_callback(self._charging_goal_response_cb)

    def _charging_goal_response_cb(self, future):
        """Handle AutoCharging goal response."""
        try:
            goal_handle = future.result()
        except Exception as e:
            self.get_logger().error(
                f'Recharge: Charging goal send failed: {e}')
            self._set_state(TaskMode.FREE, WorkStatus.FAILED_ONCE,
                            recharge_status=RechargeStatus.FAILED)
            return

        if not goal_handle.accepted:
            self.get_logger().warn('Recharge: Charging goal rejected')
            self._set_state(TaskMode.FREE, WorkStatus.FAILED_ONCE,
                            recharge_status=RechargeStatus.FAILED)
            return

        self.get_logger().info('Recharge: Charging goal accepted')
        self._charging_goal_handle = goal_handle
        result_future = goal_handle.get_result_async()
        result_future.add_done_callback(self._charging_result_cb)

    def _charging_feedback_cb(self, feedback_msg):
        """Handle AutoCharging feedback."""
        fb = feedback_msg.feedback
        self.get_logger().info(
            f'Recharge: phase="{fb.charging_phase}", '
            f'align_mode={fb.in_align_mode}')

    def _charging_result_cb(self, future):
        """Handle AutoCharging result."""
        self._charging_goal_handle = None
        try:
            result = future.result().result
            self.get_logger().info(
                f'Recharge: AutoCharging done, code={result.code}, '
                f'charge_status={result.charge_status}, '
                f'msg="{result.message}"')

            # Restore LED brightness to default (1) after dock attempt (day or night)
            self._set_recharge_led_brightness(1)

            if result.code == 100:  # SUCCESS
                self.get_logger().info('Recharge: Docking SUCCESS!')
                self._set_state(TaskMode.CHARGING, WorkStatus.INIT_SUCCESS,
                                recharge_status=RechargeStatus.CHARGING)
                self.is_on_charger = True
                self._tf_recovery_attempts = 0
                self.save_utm_origin()
                self._save_heading_cache()
            elif result.code == 7:  # CANCELED
                self.get_logger().info('Recharge: Charging cancelled')
                self._set_state(TaskMode.FREE, WorkStatus.CANCELLED,
                                recharge_status=RechargeStatus.IDLE)
            elif result.code == 10:  # TF_GETTING_FAILED
                if not hasattr(self, '_tf_recovery_attempts'):
                    self._tf_recovery_attempts = 0
                self._tf_recovery_attempts += 1
                if self._tf_recovery_attempts <= 2:
                    self.get_logger().warn(
                        f'Recharge: TF_GETTING_FAILED — starting heading discovery '
                        f'(attempt {self._tf_recovery_attempts}/2)')
                    self._set_state(TaskMode.FREE, WorkStatus.INIT_SUCCESS)
                    self._enable_aruco()
                    self._start_heading_discovery()
                else:
                    self.get_logger().error(
                        'Recharge: TF_GETTING_FAILED after 2 recovery attempts')
                    self._tf_recovery_attempts = 0
                    self._set_state(TaskMode.FREE, WorkStatus.FAILED_ONCE,
                                    recharge_status=RechargeStatus.FAILED)
            else:
                self.get_logger().warn(
                    f'Recharge: Failed (code={result.code})')
                self._set_state(TaskMode.FREE, WorkStatus.FAILED_ONCE,
                                recharge_status=RechargeStatus.FAILED)
        except Exception as e:
            self.get_logger().error(f'Recharge: Result error: {e}')
            self._set_state(TaskMode.FREE, WorkStatus.FAILED_ONCE,
                            recharge_status=RechargeStatus.FAILED)

    def cancel_recharge(self):
        """Cancel active recharge actions."""
        if self._nav_goal_handle is not None:
            self.get_logger().info('Recharge: Cancelling navigation')
            self._nav_goal_handle.cancel_goal_async()
            self._nav_goal_handle = None
        if self._charging_goal_handle is not None:
            self.get_logger().info('Recharge: Cancelling auto-charging')
            self._charging_goal_handle.cancel_goal_async()
            self._charging_goal_handle = None

    # ─── Action management ────────────────────────────────────

    def _cancel_active_actions(self):
        """Cancel any running actions (coverage, navigation, etc.)."""
        # Don't publish zero velocity — let motors coast freely
        self._undocking = False
        self._joystick_active = False
        if self._mapping_active:
            self.stop_recording()
        if self._coverage_goal_handle is not None:
            self.cancel_coverage()
        if self._boundary_goal_handle is not None:
            self.cancel_boundary_follow()
        if self._nav_goal_handle is not None or \
                self._charging_goal_handle is not None:
            self.cancel_recharge()
        # Turn off LED + blade + cameras + perception
        self._set_led(0)
        self._set_blade_speed(0)
        self.stop_cameras()
        self.set_perception_level(0)
        self.set_semantic_mode(1)  # FREE_MOVE

    # ─── State transitions ───────────────────────────────────────

    def _set_state(self, task_mode: TaskMode, work_status: WorkStatus,
                   recharge_status: RechargeStatus = None,
                   error_status: ErrorStatus = None):
        """Update state machine with optional recharge/error status."""
        self.prev_task_mode = self.task_mode
        self.prev_work_status = self.work_status
        self.prev_recharge_status = self.recharge_status
        self.task_mode = task_mode
        self.work_status = work_status
        if recharge_status is not None:
            self.recharge_status = recharge_status
        if error_status is not None:
            self.error_status = error_status
        if (self.prev_task_mode != task_mode or
                self.prev_work_status != work_status):
            self.get_logger().info(
                f'State: {self.prev_task_mode.name}/'
                f'{self.prev_work_status.name}'
                f' -> {task_mode.name}/{work_status.name}')

    # ─── Callbacks ───────────────────────────────────────────────

    def _on_battery(self, msg: ChassisBatteryMessage):
        prev = self.battery_power
        self.battery_power = msg.battery_rsoc_percent
        self.battery_voltage_mv = msg.battery_voltage_mv
        self.battery_current_ma = msg.battery_current_ma
        if prev == 0 and self.battery_power > 0:
            self.get_logger().info(
                f'Battery: {self.battery_power}% '
                f'{self.battery_voltage_mv}mV {self.battery_current_ma}mA')
        self._update_charger_state()
        if self.battery_power > 0 and self.boot_checks_done:
            low_thresh = self.get_parameter('low_battery_power').value
            if (self.battery_power <= low_thresh
                    and self.task_mode == TaskMode.COVER):
                self.get_logger().warn(
                    f'Low battery ({self.battery_power}%), '
                    f'cancelling coverage and returning to charger!')
                self.cancel_coverage()
                self.start_recharge()
            # Low power sleep mode: if idle and battery critically low
            elif (self.battery_power <= low_thresh
                    and self.task_mode == TaskMode.FREE
                    and self.get_parameter('enable_low_power_mode').value
                    and not self.is_on_charger):
                self.get_logger().warn(
                    f'Low power mode: bat={self.battery_power}%, '
                    f'returning to charger')
                self._set_state(TaskMode.FREE, WorkStatus.LOWER_POWER_STOP,
                                error_status=ErrorStatus.LOW_BATTERY)
                self.start_recharge()

    def _on_incident(self, msg: ChassisIncident):
        if msg.error_set_flag != self._last_error_flag:
            if msg.error_set_flag != 0:
                # Mask out charge_stop (bit 14) and no_pin_code (bit 16) + no_set_pin_code (bit 19)
                # for logging — these are normal operational flags, not errors
                real_errors = msg.error_set_flag & ~0x94000  # ~(0x4000|0x10000|0x80000)
                if real_errors != 0:
                    self.get_logger().warn(
                        f'ChassisIncident: error={msg.error_set_flag:#06x} (real={real_errors:#06x})')
                self._process_incident_errors(msg)
            elif self._last_error_flag != 0:
                # Error flag cleared — incident resolved
                self.clear_error()
                # charge_stop cleared = mower left charger
                if self._last_error_flag & 0x4000 and self.is_on_charger:
                    self.is_on_charger = False
                    self.get_logger().info('Charger: Disconnected (charge_stop cleared)')
                    if self.task_mode == TaskMode.CHARGING:
                        self._set_state(TaskMode.FREE, WorkStatus.INIT_SUCCESS)
            self._last_error_flag = msg.error_set_flag
        if msg.warning_set_flag != self._last_warning_flag:
            if msg.warning_set_flag != 0:
                self.get_logger().warn(
                    f'ChassisIncident: warn={msg.warning_set_flag:#06x}')
            self._last_warning_flag = msg.warning_set_flag

    def _process_incident_errors(self, msg: ChassisIncident):
        prev_error = self.error_status

        # charge_stop = charger contacts detected → NOT an error, it's charger detection
        self._charge_stop_active = msg.error_charge_stop
        if msg.error_charge_stop:
            if not self.is_on_charger:
                self.is_on_charger = True
                self.get_logger().info('Charger: Detected via charge_stop incident')
                if self.task_mode == TaskMode.FREE and self.boot_checks_done:
                    self._set_state(TaskMode.CHARGING, WorkStatus.INIT_SUCCESS)
            # Don't set error_status — this is normal when on charger

        # no_pin_code = STM32 PIN lock NOP patch → always set, ignore
        # no_set_pin_code = same category, ignore
        # (These are expected with patched STM32 v3.6.7+)

        # Real errors — only check non-charger, non-PIN flags
        if msg.error_push_button_stop:
            self.error_status = ErrorStatus.PUSH_BUTTON_STOP
        elif msg.error_collision_stop:
            self.error_status = ErrorStatus.COLLISION_STOP
        elif msg.error_upraise_stop:
            self.error_status = ErrorStatus.UPRAISE_STOP
        elif msg.error_tile_stop:
            self.error_status = ErrorStatus.TILE_STOP
        elif msg.error_turn_over:
            self.error_status = ErrorStatus.TURN_OVER
        elif msg.error_left_motor_stall_stop:
            self.error_status = ErrorStatus.LEFT_MOTOR_STALL
        elif msg.error_right_motor_stall_stop:
            self.error_status = ErrorStatus.RIGHT_MOTOR_STALL
        elif msg.error_blade_motor_stall_stop:
            self.error_status = ErrorStatus.BLADE_MOTOR_STALL
        elif msg.error_left_motor_overcur_stop:
            self.error_status = ErrorStatus.LEFT_MOTOR_OVERCURRENT
        elif msg.error_right_motor_overcur_stop:
            self.error_status = ErrorStatus.RIGHT_MOTOR_OVERCURRENT
        elif msg.error_blade_motor_overcur_stop:
            self.error_status = ErrorStatus.BLADE_MOTOR_OVERCURRENT
        elif msg.error_imu:
            self.error_status = ErrorStatus.IMU_ERROR
        elif msg.error_lora:
            self.error_status = ErrorStatus.LORA_ERROR
        elif msg.error_rtk:
            self.error_status = ErrorStatus.RTK_ERROR
        elif msg.error_wheel_static_over_current_timeout_stop:
            self.error_status = ErrorStatus.WHEEL_OVERCURRENT_TIMEOUT
        elif msg.error_usb_busy_error:
            self.error_status = ErrorStatus.USB_BUSY
        elif msg.error_usb_not_ok_error:
            self.error_status = ErrorStatus.USB_NOT_OK
        elif msg.error_lift_motor_error:
            self.error_status = ErrorStatus.LIFT_MOTOR_ERROR

        # Handle incidents during active tasks
        if self.error_status != prev_error and self.error_status != ErrorStatus.NONE:
            self.assistant.handle_incident_during_task(self.error_status)

    def _on_motor_current(self, msg: ChassisMotorCurrent):
        self.assistant.on_motor_current(
            msg.left_motor_current_ma,
            msg.right_motor_current_ma,
            msg.cut_motor_current_ma)

    def _on_loc_status(self, msg: CombinationStatus):
        self.loc_status = msg.status
        if msg.status >= LocStatus.SUCCESS:
            self.loc_quality = 100
        elif msg.status >= LocStatus.ORIGIN_INITIAL:
            self.loc_quality = 80
        elif msg.status >= LocStatus.WAIT_RTK_DATA:
            self.loc_quality = 50
        else:
            self.loc_quality = max(0, msg.status)

    def _on_odom(self, msg: Odometry):
        self.odom_received = True
        self.odom_linear_x = msg.twist.twist.linear.x
        self.odom_angular_z = msg.twist.twist.angular.z
        self.x = msg.pose.pose.position.x
        self.y = msg.pose.pose.position.y
        q = msg.pose.pose.orientation
        siny_cosp = 2.0 * (q.w * q.z + q.x * q.y)
        cosy_cosp = 1.0 - 2.0 * (q.y * q.y + q.z * q.z)
        self.theta = math.atan2(siny_cosp, cosy_cosp)

    # ─── Status summary ───────────────────────────────────────────

    def _log_summary(self):
        charger = 'CHARGER' if self.is_on_charger else 'off-charger'
        flags = ''
        if self._undocking:
            flags += ' UNDOCKING'
        if self.assistant.is_escaping:
            flags += ' ESCAPING'
        if self.assistant.is_recovering:
            flags += ' RECOVERING'
        if self.error_status != ErrorStatus.NONE:
            flags += f' err={self.error_status.name}'
        self.get_logger().info(
            f'Status: {self.task_mode.name}/{self.work_status.name} '
            f'bat={self.battery_power}% loc={self.loc_quality} '
            f'odom={"yes" if self.odom_received else "no"} '
            f'pos=({self.x:.1f},{self.y:.1f},{self.theta:.2f}) '
            f'{charger}{flags}')

    # ─── Boot process check (v10) ─────────────────────────────────

    def _boot_check_processes(self):
        """Check critical processes from check_process param during boot."""
        import subprocess
        check_list = self.get_parameter('check_process').value
        missing = []
        for name in check_list:
            # Strip leading slash for pgrep
            proc_name = name.lstrip('/')
            if proc_name == 'robot_decision':
                continue  # That's us
            try:
                result = subprocess.run(
                    ['pgrep', '-f', proc_name],
                    capture_output=True, timeout=2)
                if result.returncode != 0:
                    missing.append(proc_name)
            except (subprocess.TimeoutExpired, OSError):
                pass
        if missing:
            self.get_logger().warn(
                f'Boot: SYSTEM_CHECK — missing processes: {missing}')
        else:
            self.get_logger().info(
                f'Boot: SYSTEM_CHECK — all {len(check_list)} processes OK')

    # ─── Process health monitoring ──────────────────────────────

    def _check_process_health(self):
        """Check critical processes are running (every 60s)."""
        if not self.boot_checks_done:
            return
        import subprocess
        check_names = [
            'mqtt_node',
            'chassis_control_node',
            'novabot_mapping',
            'robot_combination_localization',
        ]
        for name in check_names:
            try:
                result = subprocess.run(
                    ['pgrep', '-f', name],
                    capture_output=True, timeout=2)
                if result.returncode != 0:
                    if name not in self._health_warned:
                        self.get_logger().warn(
                            f'Health: Process "{name}" not found!')
                        self._health_warned.add(name)
                else:
                    self._health_warned.discard(name)
            except (subprocess.TimeoutExpired, OSError):
                pass

    # ─── Status publisher ────────────────────────────────────────

    def _get_merged_status(self) -> int:
        return int(self.task_mode)

    def _get_cpu_temp(self) -> int:
        try:
            with open('/sys/class/thermal/thermal_zone0/temp', 'r') as f:
                return int(int(f.read().strip()) / 1000)
        except (FileNotFoundError, ValueError):
            return 0

    def _get_memory_remaining(self) -> int:
        try:
            with open('/proc/meminfo', 'r') as f:
                for line in f:
                    if line.startswith('MemAvailable:'):
                        return int(line.split()[1]) // 1024
        except (FileNotFoundError, ValueError, IndexError):
            pass
        return 0

    def _get_disk_remaining(self) -> int:
        try:
            st = os.statvfs('/userdata')
            return int(st.f_bavail * st.f_frsize / (1024 * 1024))
        except (OSError, AttributeError):
            try:
                st = os.statvfs('/')
                return int(st.f_bavail * st.f_frsize / (1024 * 1024))
            except (OSError, AttributeError):
                return 0


    def _publish_status(self):
        """Publish RobotStatus at 2 Hz — the heartbeat of the mower."""
        now = self.get_clock().now()
        msg = RobotStatus()
        msg.stamp = now.to_msg()
        msg.task_mode = int(self.task_mode)
        msg.work_status = int(self.work_status)
        msg.recharge_status = int(self.recharge_status)
        msg.error_status = int(self.error_status)
        msg.prev_task_mode = int(self.prev_task_mode)
        msg.prev_work_status = int(self.prev_work_status)
        msg.prev_recharge_status = int(self.prev_recharge_status)
        msg.merged_work_status = self._get_merged_status()
        msg.msg = self.msg_text
        msg.error_msg = self.error_msg
        msg.request_map_ids = self.request_map_ids
        msg.current_map_ids = self.current_map_ids
        msg.cov_ratio = self.cov_ratio
        msg.cov_area = self.cov_area
        msg.cov_remaining_area = self.cov_remaining_area
        msg.cov_estimate_time = self.cov_estimate_time
        msg.cov_work_time = self.cov_work_time
        msg.valid_cov_work_time = self.valid_cov_work_time
        msg.avoiding_obstacle_time = self.avoiding_obstacle_time
        msg.pause_time = self.pause_time
        msg.cov_map_path = self.cov_map_path
        msg.target_height = self.target_height
        msg.light = self.light
        msg.perception_level = self.perception_level
        msg.battery_power = self.battery_power
        msg.cpu_temperature = self._get_cpu_temp()
        msg.cpu_usage = 0
        msg.memory_remaining = self._get_memory_remaining()
        msg.disk_remaining = self._get_disk_remaining()
        msg.loc_quality = self.loc_quality
        uptime_min = int((time.monotonic() - self.boot_start_time) / 60)
        msg.working_time = uptime_min
        msg.x = self.x
        msg.y = self.y
        msg.theta = self.theta
        msg.start_time = self.start_time.to_msg()
        msg.end_time = now.to_msg()
        self.status_pub.publish(msg)

        # Periodic safety checks (runs at 2Hz via status timer)
        self.assistant.check_cpu_temp()
        self.assistant.check_localization()
        self.assistant.check_loc_drift()
        self.assistant.check_out_of_map()


def main(args=None):
    rclpy.init(args=args)
    node = OpenRobotDecision()

    # MultiThreadedExecutor allows service handlers to call service clients
    # without deadlocking (each runs in its own thread)
    executor = MultiThreadedExecutor(num_threads=4)
    executor.add_node(node)

    def signal_handler(sig, frame):
        node.get_logger().info('Shutting down open robot_decision...')
        # Don't send zero velocity at shutdown — let motors coast freely
        try:
            executor.shutdown(timeout_sec=1.0)
        except Exception:
            pass
        try:
            node.destroy_node()
        except Exception:
            pass
        try:
            rclpy.shutdown()
        except Exception:
            pass
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        # Don't send zero velocity — let motors coast freely
        try:
            executor.shutdown(timeout_sec=1.0)
        except Exception:
            pass
        try:
            node.destroy_node()
        except Exception:
            pass
        try:
            rclpy.shutdown()
        except Exception:
            pass


if __name__ == '__main__':
    main()
