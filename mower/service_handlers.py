"""
Service handlers for the open-source robot_decision.

These service SERVERS are called by mqtt_node to command the mower.
Service names and types VERIFIED from `ros2 node info /mqtt_node` output
(Service Clients section). Types must match EXACTLY or DDS rejects the connection.

Service type mapping (mqtt_node is CLIENT of these):
  decision_msgs/StartMap:
    /robot_decision/start_mapping
    /robot_decision/add_area
    /robot_decision/reset_mapping
  std_srvs/SetBool:
    /robot_decision/start_assistant_mapping  (verified via ros2 service type: mqtt_node is SetBool client)
    /robot_decision/start_erase
    /robot_decision/stop_task
    /robot_decision/map_stop_record
  std_srvs/Trigger:
    /robot_decision/auto_recharge
    /robot_decision/cancel_task
    /robot_decision/cancel_recharge
  std_srvs/Empty:
    /robot_decision/quit_mapping_mode
  decision_msgs/StartCoverageTask:
    /robot_decision/start_cov_task
  decision_msgs/SaveMap:
    /robot_decision/save_map
  decision_msgs/Charging:
    /robot_decision/nav_to_recharge
  decision_msgs/GenerateCoveragePath:
    /robot_decision/generate_preview_cover_path
  decision_msgs/DeleteMap:
    /robot_decision/delete_map
  mapping_msgs/SetChargingPose:
    /robot_decision/save_charging_pose

  NOT in mqtt_node clients (our own):
    /robot_decision/map_position  (novabot_msgs/Common — kept for compatibility)

Mapping service CLIENTS (Fase 4, verified from novabot_mapping binary):
  /novabot_mapping/mapping_data          mapping_msgs/Mapping           Generate sub/total map
  /novabot_mapping/recording_edge        mapping_msgs/Recording         Start recording (type 0/1/2)
  /novabot_mapping/recording_stop        mapping_msgs/Recording         Stop recording
  /novabot_mapping/set_charging_pose     mapping_msgs/SetChargingPose   Save charger position
  /novabot_mapping/generate_empty_map    mapping_msgs/GenerateEmptyMap  Generate empty map
  /novabot_mapping/mapping_control       mapping_msgs/MappingControl    Map operations (delete/etc)
  /novabot_mapping/control_erase_map_mode  mapping_msgs/MappingControl  Erase mode control

Coverage service CLIENTS (Fase 5):
  /map_server/load_map                          nav2_msgs/LoadMap
  /perception/do_perception                     std_srvs/SetBool
  /coverage_planner_server/coverage_by_file     CoveragePathsByFile
  /coverage_planner_server/cover_task_stop      std_srvs/SetBool
  /navigate_through_coverage_paths              NavigateThroughCoveragePaths (action)
"""

import time

from decision_msgs.srv import (
    StartMap, StartCoverageTask, SaveMap,
    Charging as ChargingSrv, GenerateCoveragePath, DeleteMap,
)
from std_srvs.srv import SetBool, Trigger, Empty
from novabot_msgs.srv import Common as NovabotCommon
from mapping_msgs.srv import (
    Recording as RecordingSrv,
    MappingControl as MappingControlSrv,
    Mapping as MappingSrv,
    SetChargingPose as SetChargingPoseSrv,
)
from coverage_planner.srv import CoveragePathsByFile
from nav2_msgs.srv import LoadMap

from state_machine import TaskMode, WorkStatus, RechargeStatus


class ServiceHandlers:
    """Creates and manages all ROS2 service servers for robot_decision."""

    def __init__(self, node):
        self.node = node
        self.log = node.get_logger()
        self._create_servers()

    def _create_servers(self):
        """Create all 18 service servers that mqtt_node calls.
        Types MUST match mqtt_node's service clients exactly."""
        n = self.node
        cb = n.service_cb_group

        # StartMap services (decision_msgs/StartMap)
        n.create_service(
            StartMap, '/robot_decision/start_mapping',
            self._handle_start_mapping, callback_group=cb)
        n.create_service(
            StartMap, '/robot_decision/add_area',
            self._handle_add_area, callback_group=cb)
        n.create_service(
            StartMap, '/robot_decision/reset_mapping',
            self._handle_reset_mapping, callback_group=cb)

        # start_assistant_mapping: mqtt_node connects as SetBool client (verified via ros2 service type)
        n.create_service(
            SetBool, '/robot_decision/start_assistant_mapping',
            self._handle_start_assistant, callback_group=cb)
        n.create_service(
            SetBool, '/robot_decision/start_erase',
            self._handle_start_erase, callback_group=cb)
        n.create_service(
            SetBool, '/robot_decision/stop_task',
            self._handle_stop_task, callback_group=cb)
        n.create_service(
            SetBool, '/robot_decision/map_stop_record',
            self._handle_map_stop_record, callback_group=cb)

        # Trigger services (std_srvs/Trigger)
        n.create_service(
            Trigger, '/robot_decision/auto_recharge',
            self._handle_auto_recharge, callback_group=cb)
        n.create_service(
            Trigger, '/robot_decision/cancel_task',
            self._handle_cancel_task, callback_group=cb)
        n.create_service(
            Trigger, '/robot_decision/cancel_recharge',
            self._handle_cancel_recharge, callback_group=cb)

        # Empty service (std_srvs/Empty)
        n.create_service(
            Empty, '/robot_decision/quit_mapping_mode',
            self._handle_quit_mapping, callback_group=cb)

        # Coverage task (decision_msgs/StartCoverageTask)
        n.create_service(
            StartCoverageTask, '/robot_decision/start_cov_task',
            self._handle_start_cov_task, callback_group=cb)

        # Save map (decision_msgs/SaveMap)
        n.create_service(
            SaveMap, '/robot_decision/save_map',
            self._handle_save_map, callback_group=cb)

        # Charging: nav_to_recharge (decision_msgs/Charging)
        n.create_service(
            ChargingSrv, '/robot_decision/nav_to_recharge',
            self._handle_nav_to_recharge, callback_group=cb)

        # Generate coverage path (decision_msgs/GenerateCoveragePath)
        n.create_service(
            GenerateCoveragePath, '/robot_decision/generate_preview_cover_path',
            self._handle_generate_path, callback_group=cb)

        # Delete map (decision_msgs/DeleteMap)
        n.create_service(
            DeleteMap, '/robot_decision/delete_map',
            self._handle_delete_map, callback_group=cb)

        # Save charging pose (mapping_msgs/SetChargingPose)
        n.create_service(
            SetChargingPoseSrv, '/robot_decision/save_charging_pose',
            self._handle_save_charging_pose, callback_group=cb)

        # Map position (novabot_msgs/Common — not in mqtt_node clients but kept)
        n.create_service(
            NovabotCommon, '/robot_decision/map_position',
            self._handle_map_position, callback_group=cb)

        self.log.info('Created 18 service servers for mqtt_node')

    # ─── Helper: synchronous service call ─────────────────────

    def _call_service(self, client, request, timeout=5.0):
        """Call a service synchronously. Works because we use
        MultiThreadedExecutor with separate callback groups."""
        if not client.wait_for_service(timeout_sec=1.0):
            self.log.warn(
                f'Service {client.srv_name} not available '
                f'(DDS may hide it, attempting anyway)')
            # Try anyway — DDS discovery doesn't always show services
            # that are actually available (proven with chassis_control)
        future = client.call_async(request)
        deadline = time.monotonic() + timeout
        while not future.done():
            if time.monotonic() > deadline:
                self.log.warn(
                    f'Service {client.srv_name} timed out ({timeout}s)')
                return None
            time.sleep(0.05)
        try:
            return future.result()
        except Exception as e:
            self.log.error(
                f'Service {client.srv_name} failed: {e}')
            return None

    # ─── Mapping helpers ──────────────────────────────────────

    def _start_recording(self, rec_type):
        """Start GPS boundary recording via novabot_mapping.
        type: 0=work area (passable), 1=obstacle, 2=unicom passage."""
        n = self.node

        # Start recording GPS edge points
        req = RecordingSrv.Request()
        req.type = rec_type
        result = self._call_service(n.cli_recording_edge, req)
        if result and result.result:
            self.log.info(
                f'Mapping: Started recording (type={rec_type})')
            n._mapping_active = True
            return True
        else:
            self.log.error(
                f'Mapping: Failed to start recording (type={rec_type})')
            return False

    def _stop_recording(self):
        """Stop GPS boundary recording via novabot_mapping.
        Uses Recording.srv (confirmed from C++ mangled names in binary)."""
        n = self.node
        n._mapping_active = False

        req = RecordingSrv.Request()
        req.type = 0
        result = self._call_service(n.cli_recording_stop, req)
        if result and result.result:
            self.log.info('Mapping: Recording stopped')
            return True
        else:
            self.log.warn('Mapping: Stop recording failed or not active')
            return False

    def _save_charging_pose_internal(self, map_name='home0',
                                     child_name='map0'):
        """Save charger position to map."""
        n = self.node
        req = SetChargingPoseSrv.Request()
        req.control_mode = 1  # write
        req.map_file_name = map_name
        req.child_map_file_name = child_name
        result = self._call_service(n.cli_set_charging_pose, req)
        if result and result.result:
            self.log.info(
                f'Mapping: Saved charging pose, '
                f'distance={result.map_to_charging_dis:.2f}m')
            return True
        else:
            self.log.warn('Mapping: Save charging pose failed')
            return False

    def _generate_map(self, map_type, resolution=0.05):
        """Generate sub-map (type=0) or whole map (type=1)."""
        n = self.node
        req = MappingSrv.Request()
        req.resolution = resolution
        req.type = map_type
        req.main_id = 0
        result = self._call_service(n.cli_mapping_data, req, timeout=10.0)
        if result and result.result:
            self.log.info(
                f'Mapping: Generated map (type={map_type})')
            return True, getattr(result, 'error_code', 0)
        else:
            msg = result.message if result else 'no response'
            self.log.error(
                f'Mapping: Failed to generate map '
                f'(type={map_type}): {msg}')
            return False, getattr(result, 'error_code', 0) if result else 0

    # ─── StartMap handlers (decision_msgs/StartMap) ───────────

    def _handle_start_mapping(self, request, response):
        """Manual mapping: MQTT start_scan_map -> type=0.
        Flow: undock (if needed) → set state → init mapping → start recording."""
        self.log.info(
            f'Receiving start mapping request!!! '
            f'mapname={request.mapname}, type={request.type}')
        n = self.node

        if n.is_on_charger:
            n.request_undock(after_state=(
                TaskMode.MAPPING,
                WorkStatus.MANUAL_MAPPING_WORKING_ZONE))
            # Wait for undock to complete before starting recording
            deadline = time.monotonic() + 15.0
            while n._undocking and time.monotonic() < deadline:
                time.sleep(0.1)
        else:
            n._set_state(TaskMode.MAPPING,
                         WorkStatus.MANUAL_MAPPING_WORKING_ZONE)

        n.current_map_name = request.mapname

        # Start recording work area boundary (type=0 = passable area)
        self.log.info('Now start mapping work area')
        ok = self._start_recording(0)

        response.result = 1 if ok else 0
        response.data = ''
        return response

    def _handle_add_area(self, request, response):
        """Add obstacle/unicom area during mapping.
        type=1: obstacle, type=2: unicom passage."""
        self.log.info(f'StartMap: add area, type={request.type}')
        n = self.node

        if request.type == 1:
            # Stop current work area recording, start obstacle recording
            self._stop_recording()
            n._set_state(TaskMode.MAPPING,
                         WorkStatus.MANUAL_MAPPING_OBSTACLE)
            ok = self._start_recording(1)  # obstacle
        elif request.type == 2:
            # Stop current recording, start unicom recording
            self._stop_recording()
            n._set_state(TaskMode.MAPPING,
                         WorkStatus.MANUAL_MAPPING_UNICOM)
            ok = self._start_recording(2)  # unicom
        else:
            self.log.warn(f'Unknown area type: {request.type}')
            ok = False

        response.result = 1 if ok else 0
        response.data = ''
        return response

    def _handle_reset_mapping(self, request, response):
        """Reset mapping state. Type: decision_msgs/StartMap (verified from mqtt_node)."""
        self.log.info('StartMap: reset_mapping')
        n = self.node

        # Stop any active recording
        if n.task_mode == TaskMode.MAPPING and n._mapping_active:
            self._stop_recording()

        n._set_state(TaskMode.FREE, WorkStatus.INIT_SUCCESS)
        n._mapping_active = False
        n._mapping_polygon_points = []
        response.result = 1
        response.data = 'Mapping reset'
        return response

    # ─── SetBool handlers (std_srvs/SetBool) ─────────────────

    def _handle_start_assistant(self, request, response):
        """Autonomous mapping: MQTT start_assistant_build_map.
        Type: std_srvs/SetBool (verified: mqtt_node connects as SetBool client).
        Uses BoundaryFollow action to automatically detect and follow boundaries.

        IMPORTANT: start_boundary_follow() blocks for ~35s (camera warmup,
        perception wait, map generation). Running this in the service callback
        causes rclpy executor crash (InvalidHandle) when the service caller
        disconnects. Solution: launch in a separate thread and return immediately."""
        self.log.info(
            f'SetBool: start_assistant_mapping, data={request.data}')

        import threading
        t = threading.Thread(
            target=self._run_assistant_mapping, daemon=True)
        t.start()

        response.success = True
        response.message = 'Autonomous mapping starting (async)'
        return response

    def _run_assistant_mapping(self):
        """Background thread for autonomous mapping.
        Handles undock + boundary follow without blocking the service callback."""
        n = self.node

        # Only undock if actually ON the charger (charge contacts active).
        # Never undock based on distance alone — causes unexpected backwards driving.
        needs_undock = n.is_on_charger
        if needs_undock:
            self.log.info(
                f'start_assistant_mapping: undocking first '
                f'(is_on_charger={n.is_on_charger}, dist={dist_from_charger:.2f}m)')
            n.request_undock(after_state=(
                TaskMode.MAPPING,
                WorkStatus.ASSISTANT_MAPPING_WORKING_ZONE))
            deadline = time.monotonic() + 20.0
            while n._undocking and time.monotonic() < deadline:
                time.sleep(0.1)
        else:
            n._set_state(TaskMode.MAPPING,
                         WorkStatus.ASSISTANT_MAPPING_WORKING_ZONE)

        # Start autonomous boundary following
        ok = n.start_boundary_follow(follow_mode=0)
        if not ok:
            self.log.error('start_assistant_mapping: boundary follow failed to start')

    def _handle_start_erase(self, request, response):
        """Start auto-erase mapping path. Type: std_srvs/SetBool."""
        self.log.info(f'SetBool: start_erase, data={request.data}')
        n = self.node
        n._set_state(TaskMode.MAPPING, WorkStatus.AUTO_ERASE_MAPPING)

        # Control erase mode via dedicated erase service
        req = MappingControlSrv.Request()
        req.map_file_name = n.current_map_name or 'home0'
        req.child_map_file_name = ''
        req.obstacle_file_name = ''
        req.unicom_area_file_name = ''
        req.type = 1  # CLEAR_REBUILD_MAP
        self._call_service(n.cli_erase_map_mode, req)

        response.success = True
        response.message = 'Erase mode started'
        return response

    def _handle_stop_task(self, request, response):
        """Stop current task. Type: std_srvs/SetBool."""
        self.log.info(f'SetBool: stop_task, data={request.data}')
        n = self.node
        prev_mode = n.task_mode

        # If mapping, stop recording first
        if n.task_mode == TaskMode.MAPPING and n._mapping_active:
            self._stop_recording()

        n._set_state(TaskMode.FREE, WorkStatus.USER_STOP)
        n._cancel_active_actions()
        response.success = True
        response.message = f'Stopped from {prev_mode.name}'
        return response

    def _handle_map_stop_record(self, request, response):
        """Stop map recording (MQTT stop_scan_map). Type: std_srvs/SetBool."""
        self.log.info(f'SetBool: map_stop_record, data={request.data}')
        n = self.node
        n._set_state(TaskMode.MAPPING, WorkStatus.MAPPING_STOP_RECORD)
        ok = self._stop_recording()
        response.success = ok
        response.message = 'Recording stopped' if ok else 'Stop failed'
        return response

    # ─── Trigger handlers (std_srvs/Trigger) ─────────────────

    def _handle_auto_recharge(self, request, response):
        """Auto recharge: MQTT go_to_charge. Type: std_srvs/Trigger."""
        self.log.info('Trigger: auto_recharge')
        n = self.node
        if n.task_mode == TaskMode.CHARGING:
            self.log.info(
                'Already in recharging status, No need to recharge!!!')
            response.success = False
            response.message = 'Already charging'
            return response
        # Start full recharge sequence (navigate → dock)
        n.start_recharge()
        response.success = True
        response.message = 'Recharge started'
        return response

    def _handle_cancel_task(self, request, response):
        """Cancel current task. Type: std_srvs/Trigger."""
        self.log.info('Trigger: cancel_task')
        n = self.node

        # If mapping, stop recording first
        if n.task_mode == TaskMode.MAPPING and n._mapping_active:
            self._stop_recording()

        n._set_state(TaskMode.FREE, WorkStatus.CANCELLED)
        n._cancel_active_actions()
        response.success = True
        response.message = 'Task cancelled'
        return response

    def _handle_cancel_recharge(self, request, response):
        """Cancel recharge. Type: std_srvs/Trigger."""
        self.log.info('Trigger: cancel_recharge')
        n = self.node
        n.cancel_recharge()
        n._set_state(TaskMode.FREE, WorkStatus.CANCELLED,
                     recharge_status=RechargeStatus.IDLE)
        response.success = True
        response.message = 'Recharge cancelled'
        return response

    # ─── Empty handler (std_srvs/Empty) ──────────────────────

    def _handle_quit_mapping(self, request, response):
        """Quit mapping mode. Type: std_srvs/Empty (no request/response data)."""
        self.log.info('Empty: quit_mapping_mode')
        n = self.node

        # Stop any active recording
        if n.task_mode == TaskMode.MAPPING and n._mapping_active:
            self._stop_recording()

        n._set_state(TaskMode.FREE, WorkStatus.INIT_SUCCESS)
        return response

    # ─── Coverage task ──────────────────────────────────────────

    def _handle_start_cov_task(self, request, response):
        """Start mowing: MQTT start_run.
        Flow: undock → load map → start NavigateThroughCoveragePaths action."""
        self.log.info(
            f'StartCoverageTask: cov_mode={request.cov_mode}, '
            f'map_ids={request.map_ids}, '
            f'blade_heights={list(request.blade_heights)}, '
            f'direction={request.cov_direction}, '
            f'perception={request.perception_level}')
        n = self.node

        # Store task parameters
        n.request_map_ids = request.map_ids
        blade_height = (request.blade_heights[0]
                        if request.blade_heights else 40)
        n.target_height = blade_height
        n.perception_level = request.perception_level
        n.cov_ratio = 0.0
        n.cov_area = 0.0
        n.cov_work_time = 0.0

        if n.is_on_charger:
            n.request_undock(after_state=(TaskMode.COVER,
                                         WorkStatus.COVERING))
            # Wait for undock to complete
            deadline = time.monotonic() + 15.0
            while n._undocking and time.monotonic() < deadline:
                time.sleep(0.1)
        else:
            n._set_state(TaskMode.COVER, WorkStatus.COVERING)

        # Load nav2 map
        load_map_path = n.get_parameter('load_map_path').value
        map_yaml = f'{load_map_path}/map.yaml'
        self.log.info(f'Coverage: Loading map from {map_yaml}')
        req_map = LoadMap.Request()
        req_map.map_url = map_yaml
        result = self._call_service(n.cli_load_map, req_map, timeout=10.0)
        if result:
            self.log.info(f'Coverage: Map loaded (result={result.result})')
        else:
            self.log.warn('Coverage: Map load failed, attempting anyway')

        # Start coverage action
        ok = n.start_coverage(
            map_yaml=map_yaml,
            blade_height=blade_height,
            include_edge=bool(request.cov_mode == 2),  # boundary mode
            specify_direction=bool(request.cov_direction > 0),
            cov_direction=request.cov_direction,
            perception_level=request.perception_level,
        )

        # Publish planned path JSON if available
        planned_path_file = n.get_parameter('planned_path_file').value
        n.publish_path_json(
            f'{planned_path_file}/planned_path.json', n.planned_path_pub)

        response.result = ok
        return response

    # ─── Save map ──────────────────────────────────────────────

    def _handle_save_map(self, request, response):
        """Save map: MQTT save_map.
        Full flow from original binary:
          1. Stop recording
          2. Save charging pose
          3. Generate sub-map
          4. Generate total map"""
        self.log.info(
            f'Save map request: type={request.type} '
            f'name={request.mapname}')
        n = self.node

        n._set_state(TaskMode.MAPPING, WorkStatus.MAPPING_STOP_RECORD)

        # 1. Stop recording
        self._stop_recording()

        # 2. Save charging pose
        map_name = 'home0'
        child_name = request.mapname or 'map0'
        self._save_charging_pose_internal(map_name, child_name)

        # 3. Generate sub-map
        ok, error_code = self._generate_map(0)  # type=0: sub-map

        # 4. Generate total/whole map
        if ok:
            ok, error_code = self._generate_map(1)  # type=1: total map

        # 5. Save UTM origin (Fase 8)
        if ok:
            n.save_utm_origin()

        if ok:
            self.log.info('Mapping: Map saved successfully!')
            n._set_state(TaskMode.FREE, WorkStatus.INIT_SUCCESS)
        else:
            self.log.error(
                f'Mapping: Map save failed (error_code={error_code})')

        response.result = 1 if ok else 0
        response.data = ''
        response.error_code = error_code
        return response

    # ─── Charging ──────────────────────────────────────────────

    def _handle_nav_to_recharge(self, request, response):
        """Navigate to recharge station. Type: decision_msgs/Charging."""
        self.log.info('Charging: nav_to_recharge')
        n = self.node
        if n.task_mode == TaskMode.CHARGING:
            self.log.info('Already charging!')
            response.result = 0
            response.description = 'Already charging'
            return response
        # Start full recharge sequence (navigate → dock)
        n.start_recharge()
        response.result = 1
        response.description = 'Navigating to charger'
        return response

    # ─── Generate coverage path ─────────────────────────────────

    def _handle_generate_path(self, request, response):
        """Generate preview coverage path via coverage_planner_server."""
        self.log.info(
            f'GenerateCoveragePath: map_ids={request.map_ids}, '
            f'direction={request.cov_direction}')
        n = self.node

        load_map_path = n.get_parameter('load_map_path').value
        map_yaml = f'{load_map_path}/map.yaml'

        req = CoveragePathsByFile.Request()
        req.map_yaml = map_yaml
        req.include_edge = False
        req.specify_direction = bool(request.cov_direction > 0)
        req.cov_direction = request.cov_direction

        result = self._call_service(
            n.cli_coverage_by_file, req, timeout=10.0)
        if result and result.success:
            self.log.info(
                f'GenerateCoveragePath: success, '
                f'area={result.planned_area:.1f}m²')
            # Publish preview path JSON
            from std_msgs.msg import String
            path_msg = String()
            path_msg.data = result.path_json
            n.preview_path_pub.publish(path_msg)
            response.result = True
        else:
            msg = getattr(result, 'msg', 'no response') if result else 'no response'
            self.log.warn(f'GenerateCoveragePath: failed — {msg}')
            response.result = False
        return response

    # ─── Delete map ────────────────────────────────────────────

    def _handle_delete_map(self, request, response):
        """Delete map or sub-map via mapping_control service."""
        self.log.info(
            f'DeleteMap: maptype={request.maptype}, '
            f'mapname={request.mapname}')
        n = self.node

        req = MappingControlSrv.Request()
        req.map_file_name = 'home0'
        req.child_map_file_name = request.mapname
        req.obstacle_file_name = ''
        req.unicom_area_file_name = ''
        # type=3: delete sub-map, type=5: delete whole map (deprecated)
        req.type = 3
        result = self._call_service(n.cli_mapping_control, req)
        ok = result.result if result else False

        response.result = 1 if ok else 0
        response.description = ('Map deleted' if ok
                                else 'Delete failed')
        return response

    # ─── Save charging pose (mapping_msgs/SetChargingPose) ───

    def _handle_save_charging_pose(self, request, response):
        """Save charging station position (from MQTT command).
        Type: mapping_msgs/SetChargingPose — same as novabot_mapping's service."""
        self.log.info(
            f'SetChargingPose: control_mode={request.control_mode}, '
            f'map={request.map_file_name}, child={request.child_map_file_name}')
        n = self.node
        n._set_state(TaskMode.MAPPING,
                     WorkStatus.SETTING_CHARGING_STATION)

        # Forward to novabot_mapping's set_charging_pose
        ok = self._save_charging_pose_internal(
            map_name=request.map_file_name or 'home0',
            child_name=request.child_map_file_name or 'map0')

        response.result = ok
        response.map_to_charging_dis = 0.0
        return response

    # ─── Map position (novabot_msgs/Common — own service) ────

    def _handle_map_position(self, request, response):
        """Get current map position."""
        n = self.node
        response.result = 1
        response.data = (f'{{"x": {n.x:.4f}, "y": {n.y:.4f}, '
                         f'"theta": {n.theta:.4f}}}')
        return response
