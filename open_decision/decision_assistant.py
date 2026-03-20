#!/usr/bin/env python3
"""
DecisionAssistant — slip escape and localization recovery.

Part of the open robot_decision replacement for the Novabot mower.
Provides action SERVERS that nav2/coverage_planner call when they detect
the mower is stuck (slipping) or has bad localization.

Also monitors motor current + odom to proactively detect slip.

Action servers (matching original C++ binary):
  - SlipEscaping: escape from wheel slip situation
  - LocRecoverMoving: recover from localization loss or out-of-map

Published topics:
  - /decision_assistant/escape_pose (PoseStamped)
  - /decision_assistant/robot_out_working_zone (UInt8)
  - /decision_assistant/move_abnormal (UInt8)
"""

import math
import time
import threading

from rclpy.action import ActionServer, CancelResponse, GoalResponse
from geometry_msgs.msg import Twist, PoseStamped
from std_msgs.msg import UInt8

from decision_msgs.action import SlipEscaping, LocRecoverMoving

from state_machine import TaskMode, WorkStatus, ErrorStatus

# Escape parameters (from decision_assistant config in yaml)
ESCAPE_ANGULAR_VEL = 1.5    # rad/s
ESCAPE_LINEAR_VEL = 0.5     # m/s
STRAIGHT_SLIP_DIS_DIFF = 0.07   # m — position delta threshold
ROTATE_SLIP_YAW_DIFF = 0.11     # rad — rotation delta threshold
CANNOT_MOVE_ANGULAR_DIFF = 0.5  # rad
CANNOT_MOVE_LINEAR_DIFF = 0.15  # m


class DecisionAssistant:
    """Handles slip escape, localization recovery, and movement monitoring."""

    def __init__(self, node):
        """Initialize DecisionAssistant with reference to main node.

        Args:
            node: OpenRobotDecision node instance
        """
        self.node = node
        self._logger = node.get_logger()

        # ─── Slip detection state ───
        self._prev_x = 0.0
        self._prev_y = 0.0
        self._prev_theta = 0.0
        self._prev_odom_time = 0.0
        self._slip_count = 0
        self._slip_detected = False
        self._motor_current_threshold = 10.0  # A (from config)

        # ─── Escape state ───
        self._escaping = False
        self._escape_goal_handle = None

        # ─── Recovery state ───
        self._recovering = False
        self._recover_goal_handle = None

        # ─── Declare parameters ───
        node.declare_parameter('escape_angular_vel', ESCAPE_ANGULAR_VEL)
        node.declare_parameter('escape_linear_vel', ESCAPE_LINEAR_VEL)
        node.declare_parameter('straight_slipping_dis_diff',
                               STRAIGHT_SLIP_DIS_DIFF)
        node.declare_parameter('rotate_slipping_yaw_diff',
                               ROTATE_SLIP_YAW_DIFF)
        node.declare_parameter('cannot_move_angular_diff',
                               CANNOT_MOVE_ANGULAR_DIFF)
        node.declare_parameter('cannot_move_linear_diff',
                               CANNOT_MOVE_LINEAR_DIFF)

        # ─── Publishers ───
        from rclpy.qos import QoSProfile, QoSReliabilityPolicy, QoSHistoryPolicy
        reliable_qos = QoSProfile(
            reliability=QoSReliabilityPolicy.RELIABLE,
            history=QoSHistoryPolicy.KEEP_LAST, depth=10)

        self.escape_pose_pub = node.create_publisher(
            PoseStamped, '/decision_assistant/escape_pose', reliable_qos)
        self.out_of_zone_pub = node.create_publisher(
            UInt8, '/decision_assistant/robot_out_working_zone', reliable_qos)
        self.move_abnormal_pub = node.create_publisher(
            UInt8, '/decision_assistant/move_abnormal', reliable_qos)

        # ─── Action SERVERS ───
        self._slip_action_server = ActionServer(
            node, SlipEscaping, 'slip_escaping',
            execute_callback=self._execute_slip_escape,
            goal_callback=self._goal_cb,
            cancel_callback=self._cancel_cb,
            callback_group=node.service_cb_group)

        self._loc_recover_server = ActionServer(
            node, LocRecoverMoving, 'loc_recover',
            execute_callback=self._execute_loc_recover,
            goal_callback=self._goal_cb,
            cancel_callback=self._cancel_cb,
            callback_group=node.service_cb_group)

        self._logger.info('DecisionAssistant: action servers created '
                          '(slip_escaping, loc_recover)')

    # ─── Goal / Cancel callbacks ─────────────────────────────────

    def _goal_cb(self, goal_request):
        return GoalResponse.ACCEPT

    def _cancel_cb(self, goal_handle):
        return CancelResponse.ACCEPT

    # ─── SlipEscaping action ─────────────────────────────────────

    def _execute_slip_escape(self, goal_handle):
        """Execute slip escape maneuver.

        Strategy: alternate between backing up and rotating to free the mower.
        1. Back up for 1s
        2. Rotate for 1s
        3. Check if position changed
        4. Repeat until escaped or timeout
        """
        max_time = goal_handle.request.max_escape_time
        if max_time <= 0:
            max_time = 10.0  # default 10 seconds
        self._logger.info(
            f'SlipEscape: Starting (max_time={max_time:.1f}s)')

        self._escaping = True
        self._escape_goal_handle = goal_handle
        result = SlipEscaping.Result()

        escape_vel = self.node.get_parameter('escape_linear_vel').value
        escape_ang = self.node.get_parameter('escape_angular_vel').value
        dis_thresh = self.node.get_parameter(
            'straight_slipping_dis_diff').value

        start_time = time.monotonic()
        start_x, start_y = self.node.x, self.node.y

        # Publish escape pose
        ps = PoseStamped()
        ps.header.frame_id = 'map'
        ps.header.stamp = self.node.get_clock().now().to_msg()
        ps.pose.position.x = self.node.x
        ps.pose.position.y = self.node.y
        self.escape_pose_pub.publish(ps)

        phase = 0  # 0=backup, 1=rotate
        while time.monotonic() - start_time < max_time:
            if goal_handle.is_cancel_requested:
                self._logger.info('SlipEscape: Cancelled')
                goal_handle.canceled()
                self._stop_motors()
                self._escaping = False
                result.result = SlipEscaping.Result.FAILED
                return result

            twist = Twist()
            if phase == 0:
                # Back up
                twist.linear.x = -escape_vel
                twist.angular.z = 0.0
            else:
                # Rotate
                twist.linear.x = 0.0
                twist.angular.z = escape_ang

            self.node.cmd_vel_pub.publish(twist)
            time.sleep(0.1)

            # Switch phase every 1 second
            elapsed = time.monotonic() - start_time
            phase = int(elapsed) % 2

            # Check if we've moved enough
            dx = self.node.x - start_x
            dy = self.node.y - start_y
            dist = math.sqrt(dx * dx + dy * dy)
            if dist > dis_thresh * 3:  # moved significantly
                self._logger.info(
                    f'SlipEscape: Escaped! dist={dist:.3f}m')
                self._stop_motors()
                self._escaping = False
                result.result = SlipEscaping.Result.SUCCESS
                goal_handle.succeed()
                return result

        # Timeout
        self._stop_motors()
        self._escaping = False
        self._logger.warn(
            f'SlipEscape: Timeout after {max_time:.1f}s')
        result.result = SlipEscaping.Result.FAILED
        goal_handle.succeed()
        return result

    # ─── LocRecoverMoving action ─────────────────────────────────

    def _execute_loc_recover(self, goal_handle):
        """Execute localization recovery maneuver.

        recover_type:
          0 = localization bad → drive slowly in circles to get GPS fix
          1 = robot out of map → drive toward center of map

        Strategy for type 0:
          - Drive slowly forward + rotate to give GPS/localization time to improve
          - Check localization quality periodically

        Strategy for type 1:
          - Drive backward slowly (likely just went out)
          - Check localization quality
        """
        max_time = goal_handle.request.max_time
        recover_type = goal_handle.request.recover_type
        if max_time <= 0:
            max_time = 30.0
        self._logger.info(
            f'LocRecover: Starting (type={recover_type}, '
            f'max_time={max_time:.1f}s)')

        self._recovering = True
        self._recover_goal_handle = goal_handle
        result = LocRecoverMoving.Result()

        loc_thresh = self.node.get_parameter('loc_recover_confidence').value
        start_time = time.monotonic()

        while time.monotonic() - start_time < max_time:
            if goal_handle.is_cancel_requested:
                self._logger.info('LocRecover: Cancelled')
                goal_handle.canceled()
                self._stop_motors()
                self._recovering = False
                result.result = LocRecoverMoving.Result.FAILED
                return result

            twist = Twist()
            if recover_type == 0:
                # Localization bad: drive slowly and rotate
                twist.linear.x = 0.2
                twist.angular.z = 0.5
            else:
                # Out of map: reverse slowly
                twist.linear.x = -0.2
                twist.angular.z = 0.0

            self.node.cmd_vel_pub.publish(twist)
            time.sleep(0.2)

            # Check if localization recovered
            if self.node.loc_quality >= loc_thresh:
                self._logger.info(
                    f'LocRecover: Success! '
                    f'quality={self.node.loc_quality} >= {loc_thresh}')
                self._stop_motors()
                self._recovering = False
                result.result = LocRecoverMoving.Result.SUCCESS
                goal_handle.succeed()
                return result

        # Timeout
        self._stop_motors()
        self._recovering = False
        self._logger.warn(
            f'LocRecover: Timeout after {max_time:.1f}s, '
            f'quality={self.node.loc_quality}')
        result.result = LocRecoverMoving.Result.FAILED
        goal_handle.succeed()
        return result

    # ─── Slip detection ──────────────────────────────────────────

    def on_motor_current(self, left_ma, right_ma, cut_ma):
        """Process motor current readings for slip detection.

        Called from robot_decision._on_motor_current callback.
        Compares motor current with actual movement from odom.
        """
        if not self.node.boot_checks_done:
            return
        if self.node.task_mode not in (TaskMode.COVER, TaskMode.MAPPING):
            self._slip_count = 0
            self._slip_detected = False
            return

        now = time.monotonic()
        if now - self._prev_odom_time < 0.5:
            return  # sample at 2 Hz max
        dt = now - self._prev_odom_time if self._prev_odom_time > 0 else 1.0
        self._prev_odom_time = now

        # Position delta
        dx = self.node.x - self._prev_x
        dy = self.node.y - self._prev_y
        dist = math.sqrt(dx * dx + dy * dy)

        # Rotation delta (handle wrap)
        dtheta = abs(self.node.theta - self._prev_theta)
        if dtheta > math.pi:
            dtheta = 2 * math.pi - dtheta

        self._prev_x = self.node.x
        self._prev_y = self.node.y
        self._prev_theta = self.node.theta

        # Get thresholds from params
        current_thresh = self.node.get_parameter('slipping_motor_current').value
        dis_thresh = self.node.get_parameter(
            'straight_slipping_dis_diff').value
        yaw_thresh = self.node.get_parameter(
            'rotate_slipping_yaw_diff').value

        # Check if motors are consuming current but mower isn't moving
        avg_current = (abs(left_ma) + abs(right_ma)) / 2000.0  # mA → A
        if avg_current > current_thresh:
            if dist < dis_thresh and dtheta < yaw_thresh:
                self._slip_count += 1
                if self._slip_count >= 3 and not self._slip_detected:
                    self._slip_detected = True
                    self._logger.warn(
                        f'Slip detected! current={avg_current:.1f}A '
                        f'dist={dist:.3f}m dtheta={dtheta:.3f}rad')

                    # Publish abnormal movement
                    msg = UInt8()
                    msg.data = 1
                    self.move_abnormal_pub.publish(msg)

                    # Set work status
                    if self.node.task_mode == TaskMode.COVER:
                        self.node._set_state(
                            TaskMode.COVER, WorkStatus.SLIPPING_HANDLE)
            else:
                self._slip_count = max(0, self._slip_count - 1)
                if self._slip_count == 0:
                    self._slip_detected = False
        else:
            self._slip_count = max(0, self._slip_count - 1)
            if self._slip_count == 0:
                self._slip_detected = False

    # ─── Error recovery during tasks ─────────────────────────────

    def handle_incident_during_task(self, error_status):
        """Called when a chassis incident occurs during an active task.

        Decides whether to pause, stop, or cancel the current task.
        """
        n = self.node
        if n.task_mode not in (TaskMode.COVER, TaskMode.MAPPING):
            return  # Only handle during active tasks

        # Critical errors → cancel task immediately
        critical = {
            ErrorStatus.PUSH_BUTTON_STOP,
            ErrorStatus.COLLISION_STOP,
            ErrorStatus.UPRAISE_STOP,
            ErrorStatus.TILE_STOP,
            ErrorStatus.TURN_OVER,
            ErrorStatus.BLADE_MOTOR_STALL,
            ErrorStatus.LIFT_MOTOR_ERROR,
        }

        if error_status in critical:
            self._logger.warn(
                f'Critical incident during task: {error_status.name}')
            n._cancel_active_actions()
            n._set_state(TaskMode.STOP, WorkStatus.USER_STOP,
                         error_status=error_status)

        # Motor stalls → might be temporary, set error but don't cancel yet
        elif error_status in (ErrorStatus.LEFT_MOTOR_STALL,
                              ErrorStatus.RIGHT_MOTOR_STALL):
            self._logger.warn(
                f'Motor stall during task: {error_status.name}')
            n._set_state(n.task_mode, WorkStatus.SLIPPING_HANDLE,
                         error_status=error_status)

        # Motor overcurrent → set error, report maybe_stuck
        elif error_status in (ErrorStatus.LEFT_MOTOR_OVERCURRENT,
                              ErrorStatus.RIGHT_MOTOR_OVERCURRENT,
                              ErrorStatus.BLADE_MOTOR_OVERCURRENT,
                              ErrorStatus.WHEEL_OVERCURRENT_TIMEOUT):
            self._logger.warn(
                f'Motor overcurrent during task: {error_status.name}')
            n._set_state(n.task_mode, WorkStatus.SLIPPING_HANDLE,
                         error_status=error_status)
            n.report_maybe_stuck(True)

        # Charge stop during task → unexpected
        elif error_status == ErrorStatus.CHARGE_STOP:
            self._logger.warn('Charge stop during task — stopping')
            n._cancel_active_actions()
            n._set_state(TaskMode.STOP, WorkStatus.RECOVER_ERROR_STOP,
                         error_status=error_status)

        # LoRa/RTK errors → signal but don't cancel immediately
        elif error_status in (ErrorStatus.LORA_ERROR,
                              ErrorStatus.RTK_ERROR):
            self._logger.warn(
                f'Communication error during task: {error_status.name}')
            if error_status == ErrorStatus.LORA_ERROR:
                n._set_state(n.task_mode, WorkStatus.LORA_ERROR_HANDLE,
                             error_status=error_status)
            else:
                n._set_state(n.task_mode, WorkStatus.LOC_ERROR_HANDLE,
                             error_status=error_status)

    def check_cpu_temp(self):
        """Check CPU temperature and handle overheating.
        Called periodically from status publisher.
        """
        n = self.node
        temp = n._get_cpu_temp()
        thresh = n.get_parameter('cpu_temp_thresh').value
        if temp > thresh and n.task_mode == TaskMode.COVER:
            self._logger.warn(
                f'CPU overheating ({temp}°C > {thresh}°C), '
                f'stopping coverage!')
            n._cancel_active_actions()
            n._set_state(TaskMode.STOP, WorkStatus.RECOVER_ERROR_STOP,
                         error_status=ErrorStatus.CPU_OVERHEAT)

    def check_localization(self):
        """Check localization quality during tasks.
        Called periodically from status publisher.
        """
        n = self.node
        if n.task_mode != TaskMode.COVER:
            return
        if not n.get_parameter('enable_loc_recover').value:
            return

        loc_cover = n.get_parameter('loc_cover_confidence').value
        if n.loc_quality < loc_cover and n.loc_quality > 0:
            self._logger.warn(
                f'Localization quality low during coverage: '
                f'{n.loc_quality} < {loc_cover}')
            n._set_state(TaskMode.COVER, WorkStatus.LOC_ERROR_HANDLE)

    def check_loc_drift(self):
        """Check for localization drift/instability during tasks.
        Called periodically from status publisher.
        """
        n = self.node
        if n.task_mode != TaskMode.COVER:
            return
        if not n.get_parameter('enable_loc_unstable_handle').value:
            return

        # Detect large sudden position jumps indicating drift
        if self._prev_odom_time > 0:
            dx = n.x - self._prev_x
            dy = n.y - self._prev_y
            dist = math.sqrt(dx * dx + dy * dy)
            # If position jumped more than 2m in one cycle, loc is drifting
            if dist > 2.0:
                self._logger.warn(
                    f'Localization drift detected! '
                    f'jump={dist:.2f}m')
                n._set_state(TaskMode.COVER, WorkStatus.LOC_ERROR_HANDLE)

    def check_out_of_map(self):
        """Check if robot is outside the working zone.
        Called periodically from status publisher.
        """
        n = self.node
        if n.task_mode != TaskMode.COVER:
            return
        if not n.get_parameter('enable_out_of_map_recover').value:
            return
        if not n.get_parameter('detect_out_of_boundary').value:
            return

        # Publish out-of-zone status based on localization
        # The actual boundary check is done by nav2/coverage_planner
        # We just monitor for the ROBOT_OUT_OF_MAP_HANDLE state
        if n.work_status == WorkStatus.ROBOT_OUT_OF_MAP_HANDLE:
            msg = UInt8()
            msg.data = 1
            self.out_of_zone_pub.publish(msg)

    # ─── Helpers ─────────────────────────────────────────────────

    def _stop_motors(self):
        """Send zero velocity command."""
        twist = Twist()
        self.node.cmd_vel_pub.publish(twist)

    @property
    def is_escaping(self):
        return self._escaping

    @property
    def is_recovering(self):
        return self._recovering
