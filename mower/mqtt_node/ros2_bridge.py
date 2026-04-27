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

        # Aggregator wiring (set by bind_aggregator). The bridge subscribes
        # to /robot_decision/robot_status, /battery_message, /chassis_incident,
        # /bestpos_parsed_data, /gps_raw — those topics drive every field
        # in report_state_robot / report_state_timer_data /
        # report_exception_state.
        self._agg = None
        self._battery_state = 'UNKNOWN'

    def bind_aggregator(self, aggregator) -> None:
        """Wire ROS topic subscriptions that feed the SensorAggregator.

        Topics taken from research/documents/mqtt_node-graph-snapshot.txt
        (live SSH from /mqtt_node node info on LFIN1231000211).
        Schemas verified at research/ros2_msg_definitions/.
        """
        from decision_msgs.msg import RobotStatus
        from novabot_msgs.msg import (
            ChassisBatteryMessage, ChassisIncident, BestPos,
        )
        from sensor_msgs.msg import NavSatFix

        self._agg = aggregator

        self.create_subscription(
            RobotStatus, '/robot_decision/robot_status',
            self._on_robot_status, 10, callback_group=self._cb)
        self.create_subscription(
            ChassisBatteryMessage, '/battery_message',
            self._on_battery, 10, callback_group=self._cb)
        self.create_subscription(
            ChassisIncident, '/chassis_incident',
            self._on_incident, 10, callback_group=self._cb)
        self.create_subscription(
            BestPos, '/bestpos_parsed_data',
            self._on_bestpos, 10, callback_group=self._cb)
        self.create_subscription(
            NavSatFix, '/gps_raw',
            self._on_gps, 10, callback_group=self._cb)
        log.info('ros2_bridge: aggregator bound, 5 topic subscriptions live')

    # ── Aggregator callbacks ──────────────────────────────────────────

    def _on_robot_status(self, msg) -> None:
        """decision_msgs/msg/RobotStatus — primary feed for report_state_robot.
        Schema: research/ros2_msg_definitions/decision_msgs/msg/RobotStatus.msg
        """
        if self._agg is None:
            return
        self._agg.update_status(
            task_mode=int(msg.task_mode),
            work_status=int(msg.work_status),
            recharge_status=int(msg.recharge_status),
            msg=str(msg.msg))
        self._agg.update_error(
            error_status=int(msg.error_status),
            error_msg=str(msg.error_msg))
        self._agg.update_coverage(
            ratio=float(msg.cov_ratio),
            area=float(msg.cov_area),
            work_time=float(msg.cov_work_time))
        self._agg.update_cpu(
            temp=int(msg.cpu_temperature),
            usage=int(msg.cpu_usage))
        self._agg.update_loc_quality(int(msg.loc_quality))
        self._agg.update_target_height(int(msg.target_height))
        self._agg.update_pose(
            x=float(msg.x), y=float(msg.y), theta=float(msg.theta))
        self._agg.update_battery(
            power_percent=int(msg.battery_power),
            state=self._battery_state)

    def _on_battery(self, msg) -> None:
        """novabot_msgs/msg/ChassisBatteryMessage — battery_state string.
        battery_current_ma > 0 → CHARGING; rsoc>=99 → FULL; else DISCHARGING.
        """
        if msg.battery_current_ma > 0:
            self._battery_state = 'CHARGING'
        elif msg.battery_rsoc_percent >= 99:
            self._battery_state = 'FULL'
        else:
            self._battery_state = 'DISCHARGING'
        if self._agg is not None:
            self._agg.update_battery(
                power_percent=int(msg.battery_rsoc_percent),
                state=self._battery_state)

    def _on_incident(self, msg) -> None:
        """novabot_msgs/msg/ChassisIncident — feeds report_exception_state.
        chassis_err = error_set_flag bitmask; rtk = healthy when not error_rtk.
        """
        if self._agg is None:
            return
        self._agg.update_incident(
            button_stop=bool(msg.error_push_button_stop),
            chassis_err=int(msg.error_set_flag),
            no_set_pin_code=bool(msg.error_no_set_pin_code),
            rtk=not bool(msg.error_rtk),
        )

    def _on_bestpos(self, msg) -> None:
        """novabot_msgs/msg/BestPos — RTK satellite count.
        sol_in_svs = sats used in solution. wifi_rssi cached separately.
        """
        if self._agg is None:
            return
        # Preserve any cached wifi_rssi already in the aggregator
        self._agg.update_signal(
            wifi_rssi=getattr(self._agg, '_wifi_rssi', 0),
            rtk_sat=int(msg.sol_in_svs),
        )

    def _on_gps(self, msg) -> None:
        """sensor_msgs/msg/NavSatFix — gps_position for timer_data.
        status.status >= 0 → ENABLE (NavSatStatus.STATUS_FIX or better).
        """
        if self._agg is None:
            return
        state = 'ENABLE' if msg.status.status >= 0 else 'DISABLE'
        self._agg.update_gps(
            lat=float(msg.latitude),
            lng=float(msg.longitude),
            alt=float(msg.altitude),
            state=state)

    # ── Command handlers ──────────────────────────────────────────────

    def handle_start_navigation(self, mqtt_payload: dict) -> dict:
        """Handle MQTT ``start_navigation`` (also triggered by ``start_run``).

        MQTT JSON shape (catalog RE-5 §start_run / start_navigation):
          { "start_navigation": { "cmd_num": <int>, "area": <int>, "cutterhigh": <uint8> } }

        ROS 2 endpoint: /robot_decision/start_cov_task  (StartCoverageTask)
        Schema: research/ros2_msg_definitions/decision_msgs/srv/StartCoverageTask.srv

        Field mapping (catalog RE-5 §start_run, decompile mqtt_node_decompiled.c:347738-347744):
          area       → request.map_ids       (uint32)
          cutterhigh → request.blade_heights (uint8[], index 0; formula: cutterhigh = user_cm − 2)
          (hardcoded) request.request_type   = 11 (0xb = MQTT normal start)
          (hardcoded) request.cov_mode       = 0  (NORMAL)
        """
        inner = mqtt_payload if not isinstance(mqtt_payload.get('start_navigation'), dict) \
            else mqtt_payload['start_navigation']

        req = StartCoverageTask.Request()
        req.cov_mode = 0  # StartCoverageTask.NORMAL
        req.request_type = 11  # 0xb — MQTT normal start (decompile:347738)

        area = inner.get('area')
        if area is not None:
            try:
                req.map_ids = int(area)
            except (TypeError, ValueError):
                log.warning('handle_start_navigation: invalid area=%r, using 0', area)
                req.map_ids = 0
        else:
            req.map_ids = 0

        cutterhigh = inner.get('cutterhigh')
        if cutterhigh is not None:
            try:
                req.blade_heights = [int(cutterhigh)]
            except (TypeError, ValueError):
                log.warning('handle_start_navigation: invalid cutterhigh=%r, skipping', cutterhigh)
                req.blade_heights = []
        else:
            req.blade_heights = []

        resp = self.call_service(self.cli_start_cov_task, req)
        if resp is None:
            return {'result': 1, 'msg': 'start_cov_task timeout or unavailable'}
        return {'result': 0 if resp.result else 1,
                'msg': 'start_navigation_respond'}

    # Alias: the MQTT docs call this start_run; the binary key is start_navigation.
    handle_start_run = handle_start_navigation

    def handle_stop_task(self, mqtt_payload: dict) -> dict:
        """Handle MQTT ``stop_task`` (also ``stop_run`` / ``stop_navigation``).

        MQTT JSON shape (catalog RE-5 §stop_run / stop_task):
          { "stop_task": <any> }

        ROS 2 endpoint: /robot_decision/stop_task  (std_srvs/srv/SetBool)
        Schema: research/ros2_msg_definitions/std_srvs/srv/SetBool.srv

        Field mapping:
          data = True  (stop the current task)
        """
        req = SetBool.Request()
        req.data = True  # True = stop (catalog: "likely true = stop")

        resp = self.call_service(self.cli_stop_task, req)
        if resp is None:
            return {'result': 1, 'msg': 'stop_task timeout or unavailable'}
        return {'result': 0 if resp.success else 1,
                'msg': resp.message or 'stop_task_respond'}

    def handle_stop_to_charge(self, mqtt_payload: dict) -> dict:
        """Handle MQTT ``stop_to_charge``.

        MQTT JSON shape (catalog RE-5 §stop_to_charge, decompile:349576):
          { "stop_to_charge": <any> }

        ROS 2 endpoint: /robot_decision/cancel_recharge  (std_srvs/srv/Trigger)
        Schema: research/ros2_msg_definitions/std_srvs/srv/Trigger.srv

        Trigger.Request has no fields — just call the service.
        """
        req = Trigger.Request()
        # No request fields on Trigger (schema: empty request section)

        resp = self.call_service(self.cli_cancel_recharge, req)
        if resp is None:
            return {'result': 1, 'msg': 'cancel_recharge timeout or unavailable'}
        return {'result': 0 if resp.success else 1,
                'msg': resp.message or 'stop_to_charge_respond'}

    def handle_auto_recharge(self, payload: dict) -> dict:
        """Handle MQTT ``auto_recharge``.

        MQTT JSON shape (catalog RE-5 §auto_recharge, decompile:349064):
          { "auto_recharge": <any> }

        ROS 2 endpoint: /robot_decision/auto_recharge  (std_srvs/srv/Trigger)
        Schema: research/ros2_msg_definitions/std_srvs/srv/Trigger.srv

        Trigger.Request has no fields — just call the service.
        Response fields: success (bool), message (string).
        """
        req = Trigger.Request()
        # No request fields on Trigger (schema: empty request section)

        resp = self.call_service(self.cli_auto_recharge, req)
        if resp is None:
            return {'result': 1, 'msg': 'auto_recharge timeout or unavailable'}
        return {'result': 0 if resp.success else 1,
                'msg': resp.message or 'auto_recharge_respond'}

    def handle_nav_to_recharge(self, payload: dict) -> dict:
        """Handle MQTT ``go_to_charge`` (mapped as nav_to_recharge).

        MQTT JSON shape (catalog RE-5 §go_to_charge, decompile:350102):
          { "go_to_charge": <any> }

        ROS 2 endpoint: /robot_decision/nav_to_recharge  (decision_msgs/srv/Charging)
        Schema: research/ros2_msg_definitions/decision_msgs/srv/Charging.srv

        Catalog notes (RE-5 §go_to_charge, line 135):
          "The ROS2 request fields (name, pose_x, pose_y, pose_theta, mode)
           are populated from internal state — exact mapping <unknown — needs
           Ghidra deep-dive> beyond the MQTT key name."

        We populate what we can from the payload (if present); otherwise the
        firmware fills fields from its own internal state on the ROS2 side.
        Fields per schema: name (string), pose_x (float32), pose_y (float32),
        pose_theta (float32), mode (string).
        Response fields: result (uint8), description (string).
        """
        inner = payload if not isinstance(payload.get('go_to_charge'), dict) \
            else payload['go_to_charge']

        req = ChargingSrv.Request()
        # Populate from payload if present; defaults match empty/zero state.
        req.name = str(inner.get('name', ''))           # string
        req.pose_x = float(inner.get('pose_x', 0.0))   # float32
        req.pose_y = float(inner.get('pose_y', 0.0))   # float32
        req.pose_theta = float(inner.get('pose_theta', 0.0))  # float32
        req.mode = str(inner.get('mode', ''))           # string

        resp = self.call_service(self.cli_nav_to_recharge, req)
        if resp is None:
            return {'result': 1, 'msg': 'nav_to_recharge timeout or unavailable'}
        return {'result': 0 if resp.result == 0 else 1,
                'msg': resp.description or 'go_to_charge_respond'}

    # Alias: MQTT docs call this go_to_charge; ROS2 endpoint is nav_to_recharge.
    handle_go_to_charge = handle_nav_to_recharge

    def handle_cancel_task(self, payload: dict) -> dict:
        """Handle MQTT ``cancel_task``.

        MQTT JSON shape: { "cancel_task": <any> }
        (The string "/robot_decision/cancel_task" appears in
        mqtt_node-strings.md:688 and graph-snapshot.txt:56, confirming the
        client is wired in mqtt_node. No separate catalog entry exists as of
        Phase 2 — the MQTT key is inferred from the endpoint name.)

        ROS 2 endpoint: /robot_decision/cancel_task  (std_srvs/srv/Trigger)
        Schema: research/ros2_msg_definitions/std_srvs/srv/Trigger.srv

        Trigger.Request has no fields — just call the service.
        Response fields: success (bool), message (string).
        """
        req = Trigger.Request()
        # No request fields on Trigger (schema: empty request section)

        resp = self.call_service(self.cli_cancel_task, req)
        if resp is None:
            return {'result': 1, 'msg': 'cancel_task timeout or unavailable'}
        return {'result': 0 if resp.success else 1,
                'msg': resp.message or 'cancel_task_respond'}

    def handle_cancel_recharge(self, payload: dict) -> dict:
        """Handle MQTT ``cancel_recharge``.

        This is a direct-name alias for ``stop_to_charge``.  The underlying
        ROS 2 endpoint is /robot_decision/cancel_recharge (Trigger).
        ``handle_stop_to_charge`` is the canonical implementation;
        ``handle_cancel_recharge`` delegates to it so both MQTT key spellings
        are handled by the same logic.

        MQTT JSON shape: { "cancel_recharge": <any> }

        ROS 2 endpoint: /robot_decision/cancel_recharge  (std_srvs/srv/Trigger)
        Schema: research/ros2_msg_definitions/std_srvs/srv/Trigger.srv
        Response fields: success (bool), message (string).
        """
        return self.handle_stop_to_charge(payload)

    # NOTE: handle_reset_data is intentionally NOT implemented.
    # /robot_decision/reset_data (std_srvs/SetBool) is a SERVICE SERVER on
    # robot_decision, not a service client of mqtt_node.  It does NOT appear
    # in research/documents/mqtt_node-graph-snapshot.txt under /mqtt_node's
    # Service Clients section.  cli_reset_data therefore does not exist on
    # this bridge and cannot be called here.  If a direct MQTT→reset_data
    # path is needed in future, a cli_reset_data client must first be added
    # to __init__ (after confirming the endpoint appears in the live graph).

    # ── Mapping handlers ─────────────────────────────────────────────────

    def handle_start_scan_map(self, payload: dict) -> dict:
        """Handle MQTT ``start_scan_map`` — begin a new mapping session.

        MQTT JSON shape (catalog RE-5 §start_scan_map, decompile:341434):
          { "start_scan_map": { "cmd_num": <int>, "model": "<string>",
                                "mapName": "<string>", "type": <int> } }

        ROS 2 endpoint: /robot_decision/start_mapping  (decision_msgs/srv/StartMap)
        Schema: research/ros2_msg_definitions/decision_msgs/srv/StartMap.srv

        Field mapping (request):
          model   → request.model   (string — mapping model name)
          mapName → request.mapname (string — map file name)
          type    → request.type    (uint8; 0 = work map, 1 = obstacle map)
          cmd_num → (dedup guard, NOT forwarded to ROS2)

        Field mapping (response):
          result  → uint8 (0 = success)
          data    → informational string
        """
        inner = payload if not isinstance(payload.get('start_scan_map'), dict) \
            else payload['start_scan_map']

        req = StartMap.Request()
        req.model = str(inner.get('model', ''))       # string
        req.mapname = str(inner.get('mapName', ''))   # string
        try:
            req.type = int(inner.get('type', 0))      # uint8
        except (TypeError, ValueError):
            log.warning('handle_start_scan_map: invalid type=%r, using 0',
                        inner.get('type'))
            req.type = 0

        resp = self.call_service(self.cli_start_mapping, req)
        if resp is None:
            return {'result': 1, 'msg': 'start_mapping timeout or unavailable'}
        return {'result': 0 if resp.result == 0 else 1,
                'msg': resp.data or 'start_scan_map_respond'}

    def handle_add_scan_map(self, payload: dict) -> dict:
        """Handle MQTT ``add_scan_map`` — add an area to an ongoing mapping session.

        MQTT JSON shape (catalog RE-5 §add_scan_map, decompile:340269):
          { "add_scan_map": { "cmd_num": <int>, "mapName": "<string>",
                              "type": <int> } }

        ROS 2 endpoint: /robot_decision/add_area  (decision_msgs/srv/StartMap)
        Schema: research/ros2_msg_definitions/decision_msgs/srv/StartMap.srv

        Field mapping (request):
          mapName → request.mapname (string)
          type    → request.type    (uint8; 0 = unicom/work boundary, 1 = obstacle)
                    Note: obstacle live-capture uses type:1; unicom uses type:0.
                    See research/documents/novabot-ble-mapping-protocol.md.
          model   → request.model   (string; not present in add_scan_map MQTT
                                     payload, left as empty string default)
          cmd_num → (dedup guard, NOT forwarded to ROS2)

        Field mapping (response):
          result  → uint8 (0 = success)
          data    → informational string
        """
        inner = payload if not isinstance(payload.get('add_scan_map'), dict) \
            else payload['add_scan_map']

        req = StartMap.Request()
        req.mapname = str(inner.get('mapName', ''))   # string
        req.model = str(inner.get('model', ''))       # string (not in MQTT payload; default '')
        try:
            req.type = int(inner.get('type', 0))      # uint8
        except (TypeError, ValueError):
            log.warning('handle_add_scan_map: invalid type=%r, using 0',
                        inner.get('type'))
            req.type = 0

        resp = self.call_service(self.cli_add_area, req)
        if resp is None:
            return {'result': 1, 'msg': 'add_area timeout or unavailable'}
        return {'result': 0 if resp.result == 0 else 1,
                'msg': resp.data or 'add_scan_map_respond'}

    def handle_save_map(self, payload: dict) -> dict:
        """Handle MQTT ``save_map`` — finalise a sub-map or total map.

        Sent TWICE per mapping session:
          type:0 — sub map (writes csv_file + x3_csv_file)
          type:1 — total map (generates map.pgm / map.png / map.yaml)
        See CLAUDE.md "BLE Mapping — save_map type:0 vs type:1" for
        the exact timing (500ms Flutter delay between them).

        MQTT JSON shape (catalog RE-5 §save_map, decompile:339763):
          { "save_map": { "cmd_num": <int>, "mapName": "<string>",
                          "type": <int> } }

        ROS 2 endpoint: /robot_decision/save_map  (decision_msgs/srv/SaveMap)
        Schema: research/ros2_msg_definitions/decision_msgs/srv/SaveMap.srv

        Field mapping (request):
          mapName    → request.mapname    (string)
          type       → request.type       (int64; 0 = sub, 1 = total)
          resolution → request.resolution (float32; not in MQTT payload,
                                           ROS2 default used — decompile §save_map
                                           does not extract resolution from JSON)
          cmd_num    → (dedup guard, NOT forwarded to ROS2)

        Field mapping (response):
          result     → uint8 (0 = success)
          error_code → uint8 (1=overlap other map, 2=overlap unicom, 3=cross multi maps)
          data       → informational string
        """
        inner = payload if not isinstance(payload.get('save_map'), dict) \
            else payload['save_map']

        req = SaveMap.Request()
        req.mapname = str(inner.get('mapName', ''))   # string
        try:
            req.type = int(inner.get('type', 0))      # int64
        except (TypeError, ValueError):
            log.warning('handle_save_map: invalid type=%r, using 0',
                        inner.get('type'))
            req.type = 0
        # resolution: not present in MQTT payload; use ROS2 default (0.0)
        req.resolution = 0.0                          # float32

        resp = self.call_service(self.cli_save_map, req)
        if resp is None:
            return {'result': 1, 'msg': 'save_map timeout or unavailable'}
        return {'result': 0 if resp.result == 0 else 1,
                'msg': resp.data or 'save_map_respond',
                'error_code': int(resp.error_code)}

    def handle_delete_map(self, payload: dict) -> dict:
        """Handle MQTT ``delete_map`` — delete a named map.

        MQTT JSON shape (catalog RE-5 §delete_map, decompile:345258):
          { "delete_map": { "mapName": "<string>", "maptype": <uint8> } }

        ROS 2 endpoint: /robot_decision/delete_map  (decision_msgs/srv/DeleteMap)
        Schema: research/ros2_msg_definitions/decision_msgs/srv/DeleteMap.srv

        Field mapping (request):
          mapName  → request.mapname  (string)
          maptype  → request.maptype  (uint8; exact enum values unknown — Ghidra
                                       deep-dive needed; forwarded verbatim)

        Field mapping (response):
          result      → uint8 (0 = success)
          description → string
        """
        inner = payload if not isinstance(payload.get('delete_map'), dict) \
            else payload['delete_map']

        req = DeleteMap.Request()
        req.mapname = str(inner.get('mapName', ''))   # string
        try:
            req.maptype = int(inner.get('maptype', 0))  # uint8
        except (TypeError, ValueError):
            log.warning('handle_delete_map: invalid maptype=%r, using 0',
                        inner.get('maptype'))
            req.maptype = 0

        resp = self.call_service(self.cli_delete_map, req)
        if resp is None:
            return {'result': 1, 'msg': 'delete_map timeout or unavailable'}
        return {'result': 0 if resp.result == 0 else 1,
                'msg': resp.description or 'delete_map_respond'}

    def handle_quit_mapping_mode(self, payload: dict) -> dict:
        """Handle MQTT ``quit_mapping_mode`` — exit mapping mode.

        MQTT JSON shape (catalog RE-5 §quit_mapping_mode, decompile:338506):
          { "quit_mapping_mode": <any> }

        ROS 2 endpoint: /robot_decision/quit_mapping_mode  (std_srvs/srv/Empty)
        Schema: research/ros2_msg_definitions/std_srvs/srv/Empty.srv

        Empty.Request has no fields — just call the service.
        Empty.Response has no fields either; success is inferred from the call
        completing without timeout.
        """
        req = Empty.Request()
        # No request or response fields on Empty (schema: only --- separator)

        resp = self.call_service(self.cli_quit_mapping, req)
        if resp is None:
            return {'result': 1, 'msg': 'quit_mapping_mode timeout or unavailable'}
        # Empty response has no success flag — treat any non-None response as success
        return {'result': 0, 'msg': 'quit_mapping_mode_respond'}

    def handle_start_assistant_build_map(self, payload: dict) -> dict:
        """Handle MQTT ``start_assistant_build_map`` — start autonomous mapping.

        MQTT JSON shape (catalog RE-5 §start_assistant_build_map, decompile:342434):
          { "start_assistant_build_map": { "cmd_num": <int>, "value": <bool> } }

        ROS 2 endpoint: /robot_decision/start_assistant_mapping  (std_srvs/srv/SetBool)
        Schema: research/ros2_msg_definitions/std_srvs/srv/SetBool.srv

        Field mapping (request):
          value   → request.data  (bool; True = start, False = stop autonomous mapping)
          cmd_num → (dedup guard, NOT forwarded to ROS2)

        Field mapping (response):
          success → bool
          message → string
        """
        inner = payload if not isinstance(
            payload.get('start_assistant_build_map'), dict) \
            else payload['start_assistant_build_map']

        req = SetBool.Request()
        req.data = bool(inner.get('value', True))     # bool

        resp = self.call_service(self.cli_start_assistant_mapping, req)
        if resp is None:
            return {'result': 1,
                    'msg': 'start_assistant_mapping timeout or unavailable'}
        return {'result': 0 if resp.success else 1,
                'msg': resp.message or 'start_assistant_build_map_respond'}

    def handle_get_preview_cover_path(self, payload: dict) -> dict:
        """Handle MQTT ``get_preview_cover_path`` — serve the cached preview path.

        MQTT JSON shape (catalog RE-5 §get_preview_cover_path,
        decompile:319628):
          { "get_preview_cover_path": <any> }

        ROS 2 endpoint: NONE.
        The stock mqtt_node does NOT make a ROS2 service call for this
        command.  Instead, `api_get_preview_cover_path` reads the file
          /userdata/lfi/maps/home0/planned_path/preview_planned_path.json
        and publishes its content directly back to the app on
        `Dart/Receive_mqtt/<SN>`.

        # NOTE: No cli_* for this command — no ROS2 service client is
        # wired (or needed) in __init__.  The handler reads the on-disk
        # JSON file and returns its parsed content.  Because the open
        # mqtt_node must avoid the stock buffer-overflow bug (see
        # research/memory/get-preview-cover-path-crash.md), we let the
        # caller stream the file in chunks or use a size guard — that
        # logic lives in the MQTT publisher, not here.  This method only
        # reads + deserialises.

        CRITICAL: stock mqtt_node overflows its send buffer for large
        preview paths.  See research/memory/get-preview-cover-path-crash.md.
        """
        import json
        import os

        preview_path_file = (
            '/userdata/lfi/maps/home0/planned_path/preview_planned_path.json'
        )
        if not os.path.exists(preview_path_file):
            log.warning('handle_get_preview_cover_path: file not found: %s',
                        preview_path_file)
            return {'result': 1, 'msg': 'preview_planned_path.json not found'}

        try:
            with open(preview_path_file, 'r', encoding='utf-8') as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            log.warning('handle_get_preview_cover_path: read error: %s', exc)
            return {'result': 1, 'msg': f'read error: {exc}'}

        # Caller (MQTT publisher) wraps this in the respond envelope.
        # Return the parsed data so the publisher can forward it verbatim.
        return {'result': 0, 'msg': 'get_preview_cover_path_respond',
                'data': data}

    def handle_save_recharge_pos(self, payload: dict) -> dict:
        """Handle MQTT ``save_recharge_pos`` — write charging pose to map.

        MQTT JSON shape (catalog RE-5 §save_recharge_pos,
        decompile:346293):
          { "save_recharge_pos": { "cmd_num": <int>, "mapName": "<string>" } }

        ROS 2 endpoint: /robot_decision/save_charging_pose
        Endpoint type:  mapping_msgs/srv/SetChargingPose
        Schema: research/ros2_msg_definitions/mapping_msgs/srv/SetChargingPose.srv

        Field mapping (request):
          control_mode       = 1  (write operation; 0 = read per schema comment)
          map_file_name      → mapName from payload (total-map name, e.g. "map0")
          child_map_file_name → mapName from payload (sub-map name; exact
                                split <unknown — needs Ghidra deep-dive of
                                api_save_recharge_pos:346293>; using mapName
                                for both until Ghidra clarifies)

        Field mapping (response):
          result  → bool (True = success)
          message → string
          NOTE: `map_to_charging_dis` (float32) is present in the response
          schema but is NOT read here — the stock mqtt_node does not
          forward it to the app (audit C2, open-decision project).

        Post-condition: Flutter sends `save_map type:1` 500ms after
        `save_recharge_pos_respond` (see CLAUDE.md §BLE Mapping).
        """
        inner = payload if not isinstance(payload.get('save_recharge_pos'), dict) \
            else payload['save_recharge_pos']

        map_name = str(inner.get('mapName', ''))  # e.g. "map0"

        req = SetChargingPose.Request()
        req.control_mode = 1           # uint8 — 1 = write
        req.map_file_name = map_name   # string — total map name
        # child_map_file_name: exact decompile mapping unknown (Ghidra needed);
        # using mapName verbatim — same field the stock binary most likely
        # passes per catalog note (api_save_recharge_pos:346293).
        req.child_map_file_name = map_name  # string

        resp = self.call_service(self.cli_save_charging_pose, req)
        if resp is None:
            return {'result': 1, 'msg': 'save_charging_pose timeout or unavailable'}
        # NOTE: resp.map_to_charging_dis intentionally NOT read (audit C2).
        return {'result': 0 if resp.result else 1,
                'msg': resp.message or 'save_recharge_pos_respond'}

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
