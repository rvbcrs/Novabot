# mower/mqtt_node/ros2_bridge.py
"""ROS 2 bridge for the open mqtt_node.

This is a thin rclpy.Node that owns:
- All service clients the stock binary uses (~16, per mqtt_node-graph-snapshot.txt)
- All action clients the stock binary uses (2, per mqtt_node-graph-snapshot.txt)
- Topic subscriptions used by sensor_aggregator
- Topic publications used by the app/MQTT layer

The bridge does NOT contain MQTT logic — command_dispatcher routes
inbound payloads to bridge methods, and sensor_aggregator pulls cached
state out via getter methods.

Field-name discipline: every Request()/Goal() construction below MUST
have its fields verified by the AST test
mower/mqtt_node/tests/test_field_name_verification.py. That test
cross-checks against research/ros2_msg_definitions/ schemas. Do NOT
add a field that is not present in the cached schema.

Endpoint-name discipline: every endpoint string passed to
create_client/ActionClient MUST appear in
research/documents/mqtt_node-graph-snapshot.txt.  The test
test_no_fabricated_endpoint_names enforces this.  Endpoints that exist
only in robot_decision or decision_assistant (not in /mqtt_node's own
client list) are NOT wired here.
"""
from __future__ import annotations
import logging

import rclpy
from rclpy.node import Node
from rclpy.action import ActionClient
from rclpy.callback_groups import ReentrantCallbackGroup

# ROS 2 message imports — extend as new commands are wired
from std_srvs.srv import SetBool, Trigger, Empty
from decision_msgs.srv import (
    StartCoverageTask,
    StartMap,
    SaveMap,
    DeleteMap,
    GenerateCoveragePath,
    Charging as ChargingSrv,
)
from mapping_msgs.srv import SetChargingPose
from nav2_msgs.srv import ClearCostmapAroundRobot
from novabot_msgs.srv import Common
from platform_msgs.srv import OtaUpgradeSys
from novabot_msgs.action import ChassisLoraSet, ChassisPinCodeSet

log = logging.getLogger('mqtt_node.ros2_bridge')


class Ros2Bridge(Node):
    def __init__(self):
        super().__init__('mqtt_node')
        self._cb = ReentrantCallbackGroup()

        # ── Service clients ────────────────────────────────────────────
        # Names come from research/documents/mqtt_node-graph-snapshot.txt
        # and are AST-verified by test_no_fabricated_endpoint_names.

        # Mowing / task control
        self.cli_start_cov_task = self.create_client(
            StartCoverageTask, '/robot_decision/start_cov_task',
            callback_group=self._cb)
        self.cli_stop_task = self.create_client(
            SetBool, '/robot_decision/stop_task',
            callback_group=self._cb)
        self.cli_cancel_task = self.create_client(
            Trigger, '/robot_decision/cancel_task',
            callback_group=self._cb)

        # Charging / recharge
        self.cli_auto_recharge = self.create_client(
            Trigger, '/robot_decision/auto_recharge',
            callback_group=self._cb)
        self.cli_cancel_recharge = self.create_client(
            Trigger, '/robot_decision/cancel_recharge',
            callback_group=self._cb)
        self.cli_nav_to_recharge = self.create_client(
            ChargingSrv, '/robot_decision/nav_to_recharge',
            callback_group=self._cb)

        # Mapping
        self.cli_start_mapping = self.create_client(
            StartMap, '/robot_decision/start_mapping',
            callback_group=self._cb)
        self.cli_start_assistant_mapping = self.create_client(
            SetBool, '/robot_decision/start_assistant_mapping',
            callback_group=self._cb)
        self.cli_add_area = self.create_client(
            StartMap, '/robot_decision/add_area',
            callback_group=self._cb)
        self.cli_reset_mapping = self.create_client(
            StartMap, '/robot_decision/reset_mapping',
            callback_group=self._cb)
        self.cli_save_map = self.create_client(
            SaveMap, '/robot_decision/save_map',
            callback_group=self._cb)
        self.cli_delete_map = self.create_client(
            DeleteMap, '/robot_decision/delete_map',
            callback_group=self._cb)
        self.cli_quit_mapping = self.create_client(
            Empty, '/robot_decision/quit_mapping_mode',
            callback_group=self._cb)
        self.cli_map_stop_record = self.create_client(
            SetBool, '/robot_decision/map_stop_record',
            callback_group=self._cb)
        self.cli_start_erase = self.create_client(
            SetBool, '/robot_decision/start_erase',
            callback_group=self._cb)

        # Preview path
        self.cli_generate_preview_path = self.create_client(
            GenerateCoveragePath,
            '/robot_decision/generate_preview_cover_path',
            callback_group=self._cb)

        # Charging pose
        self.cli_save_charging_pose = self.create_client(
            SetChargingPose, '/robot_decision/save_charging_pose',
            callback_group=self._cb)

        # Mid-task pause / resume (novabot_msgs/Common)
        self.cli_mid_pause = self.create_client(
            Common, '/MidPauseTask',
            callback_group=self._cb)
        self.cli_mid_resume = self.create_client(
            Common, '/MidResumeTask',
            callback_group=self._cb)
        self.cli_resume_task = self.create_client(
            Common, '/ResumeTask',
            callback_group=self._cb)

        # Costmap clear
        self.cli_clear_local_costmap = self.create_client(
            ClearCostmapAroundRobot,
            '/local_costmap/clear_around_local_costmap',
            callback_group=self._cb)

        # OTA service
        self.cli_ota_upgrade = self.create_client(
            OtaUpgradeSys, '/ota_upgrade_srv',
            callback_group=self._cb)

        # UTM origin reset
        self.cli_reset_utm = self.create_client(
            Empty, '/reset_utm_origin_info',
            callback_group=self._cb)

        # ── Action clients ─────────────────────────────────────────────
        # Only /chassis_lora_set and /chassis_pin_code_set appear under
        # /mqtt_node Action Clients in the live graph snapshot.
        # The navigation/boundary/auto-charging actions belong to
        # robot_decision — not wired here.
        self.act_chassis_lora_set = ActionClient(
            self, ChassisLoraSet, '/chassis_lora_set',
            callback_group=self._cb)
        self.act_chassis_pin_code_set = ActionClient(
            self, ChassisPinCodeSet, '/chassis_pin_code_set',
            callback_group=self._cb)

        log.info('ros2_bridge: node up with %d service clients + 2 action clients',
                 sum(1 for n in dir(self) if n.startswith('cli_')))

    # ── Generic helpers ────────────────────────────────────────────────
    def call_service(self, client, request, timeout: float = 5.0):
        """Synchronous service call. Returns response or None on timeout.

        We use call_async + manual wait inside a MultiThreadedExecutor
        callback group rather than blocking on a single-threaded executor
        — same pattern open_decision uses.
        """
        if not client.wait_for_service(timeout_sec=1.0):
            log.warning('ros2_bridge: %s not available', client.srv_name)
        future = client.call_async(request)
        # Spinning is the executor's job; we just await the future
        import time
        deadline = time.monotonic() + timeout
        while not future.done():
            if time.monotonic() > deadline:
                log.warning('ros2_bridge: %s timed out', client.srv_name)
                return None
            time.sleep(0.05)
        try:
            return future.result()
        except Exception as e:
            log.warning('ros2_bridge: %s raised: %s', client.srv_name, e)
            return None
