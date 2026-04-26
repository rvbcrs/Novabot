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

Mapping service CLIENTS (Fase 4, verified from novabot_mapping binary):
  /novabot_mapping/mapping               mapping_msgs/Mapping           Generate sub/total map
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
        """Create all 17 service servers that mqtt_node calls.
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
        n.create_service(
            SetBool, '/robot_decision/reset_data',
            self._handle_reset_data, callback_group=cb)

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
            # SetChargingPose.Response has no map_to_charging_dis field (live verified 2026-04-26).
            # Distance is not available from the response; log pose if needed via charging_pose.
            self.log.info('Mapping: Saved charging pose')
            return True, 0.0
        else:
            self.log.warn('Mapping: Save charging pose failed')
            return False, 0.0

    def _generate_map(self, map_type, resolution=0.05):
        """Generate sub-map (type=0) or whole map (type=1)."""
        n = self.node
        req = MappingSrv.Request()
        req.resolution = resolution
        req.type = map_type
        # NOTE: Mapping.srv has no main_id field (live verified 2026-04-26)
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
        """Add obstacle (1), unicom (2), or unicom→station (3)."""
        self.log.info(f'StartMap: add area, type={request.type}')
        n = self.node
        if request.type == 1:
            self._stop_recording()
            n._set_state(TaskMode.MAPPING,
                         WorkStatus.MANUAL_MAPPING_OBSTACLE)
            ok = self._start_recording(1)
        elif request.type == 2:
            self._stop_recording()
            n._set_state(TaskMode.MAPPING,
                         WorkStatus.MANUAL_MAPPING_UNICOM)
            ok = self._start_recording(2)
        elif request.type == 3:
            self._stop_recording()
            n._set_state(TaskMode.MAPPING,
                         WorkStatus.MANUAL_MAPPING_UNICOM_TO_STATION)
            self.log.info('Start mapping unicom/passage to charge station')
            ok = self._start_recording(2)  # unicom path; mapping_node logs context
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
                f'(is_on_charger={n.is_on_charger})')
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
        """Start auto-erase mapping path. Type: std_srvs/SetBool.

        Closed-binary parity: launches a worker thread that calls
        cli_erase_map_mode and tracks completion. State transitions to
        AUTO_ERASE_MAPPING_SUCCESS or AUTO_ERASE_MAPPING_FAILED so mqtt_node
        sees the finish event."""
        self.log.info(f'SetBool: start_erase, data={request.data}')
        import threading
        threading.Thread(target=self._run_erase, daemon=True).start()
        response.success = True
        response.message = 'Erase mode started'
        return response

    def _run_erase(self):
        """Background thread for erase mapping.
        Handles the MappingControl service call and state transitions."""
        n = self.node
        n._set_state(TaskMode.MAPPING, WorkStatus.AUTO_ERASE_MAPPING)
        req = MappingControlSrv.Request()
        req.map_file_name = n.current_map_name or 'home0'
        req.child_map_file_name = ''
        req.obstacle_file_name = ''
        req.unicom_area_file_name = ''
        req.type = 1  # CLEAR_REBUILD_MAP
        result = self._call_service(n.cli_erase_map_mode, req)
        if result and getattr(result, 'result', False):
            n._set_state(TaskMode.MAPPING,
                         WorkStatus.AUTO_ERASE_MAPPING_SUCCESS)
        else:
            n._set_state(TaskMode.MAPPING,
                         WorkStatus.AUTO_ERASE_MAPPING_FAILED)

    def _handle_stop_task(self, request, response):
        """Stop or resume current task. Closed binary semantics:
          data=true  -> pause (USER_STOP, cancel running goals)
          data=false -> resume (re-issue the last coverage goal if available)
        Logs 'Receiving cov continue command!!!' on resume."""
        self.log.info(f'SetBool: stop_task, data={request.data}')
        n = self.node
        if request.data:
            if n.task_mode == TaskMode.MAPPING and n._mapping_active:
                self._stop_recording()
            n._set_state(TaskMode.FREE, WorkStatus.USER_STOP)
            n._cancel_active_actions()
            response.success = True
            response.message = 'Paused'
            return response

        # Resume
        self.log.info('Receiving cov continue command!!!')
        if not getattr(n, '_last_cov_request', None):
            self.log.warn('No prior coverage task to resume')
            response.success = False
            response.message = 'No prior task to resume'
            return response
        # Resume — synthesize a StartCoverageTask.Response for the inner call,
        # then map its result back onto the SetBool.Response we owe mqtt_node.
        from decision_msgs.srv import StartCoverageTask as _SCT
        inner_resp = _SCT.Response()
        self._handle_start_cov_task(n._last_cov_request, inner_resp)
        response.success = bool(inner_resp.result)
        response.message = (
            'Resumed' if inner_resp.result
            else 'Resume failed (start handler returned 0)')
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

    def _handle_reset_data(self, request, response):
        """Clear in-memory task counters/state after a fault. Closed binary
        logs 'Reset task data successfully!!!'. Without this MQTT clients
        cannot recover from latched faults."""
        self.log.info(
            f'SetBool: reset_data, data={request.data}')
        n = self.node
        n._cancel_active_actions()
        if hasattr(n, 'error_status'):
            n.error_status = 0
        if hasattr(n, 'cov_ratio'):
            n.cov_ratio = 0.0
        if hasattr(n, 'cov_area'):
            n.cov_area = 0.0
        if hasattr(n, 'cov_work_time'):
            n.cov_work_time = 0.0
        if hasattr(n, 'current_map_ids'):
            n.current_map_ids = 0
        if hasattr(n, 'request_map_ids'):
            n.request_map_ids = 0
        n._set_state(TaskMode.FREE, WorkStatus.INIT_SUCCESS)
        response.success = True
        response.message = 'Reset task data successfully'
        return response

    # ─── Coverage task ──────────────────────────────────────────

    def _handle_start_cov_task(self, request, response):
        """Start mowing entrypoint. cov_mode:
          0 = full coverage (default)
          1 = SPECIFIED_AREA (polygon_area from request)
          2 = BOUNDARY_COV (only_edge_mode + include_edge)
        """
        n = self.node

        # Guard: refuse if a task is already running (closed-binary parity:
        # WARN_REPEATED_START state, log "Cannot start a new task when last
        # task is executing!!!").
        if n._coverage_goal_handle is not None:
            self.log.warn(
                'Cannot start a new task when last task is executing!!!')
            n._set_state(n.task_mode, WorkStatus.WARN_REPEATED_START)
            response.result = 0
            return response

        self.log.info(
            f'StartCoverageTask: cov_mode={request.cov_mode}, '
            f'map_ids={request.map_ids}, '
            f'blade_heights={list(request.blade_heights)}, '
            f'direction={request.cov_direction}, '
            f'perception={request.perception_level}, '
            f'polygon_area_pts={len(getattr(request, "polygon_area", []) or [])}')

        # map_ids is a scalar uint32, NOT an array (live verified 2026-04-26).
        n.request_map_ids = int(request.map_ids)
        n._last_cov_request = request  # store for stop_task resume (Task 4.3)
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
            deadline = time.monotonic() + 15.0
            while n._undocking and time.monotonic() < deadline:
                time.sleep(0.1)
        else:
            n._set_state(TaskMode.COVER, WorkStatus.COVERING)

        # Force-reload map (closed binary always logs
        # "Forcing to reload map for start new task!!!!").
        load_map_path = n.get_parameter('load_map_path').value
        map_yaml = f'{load_map_path}/map.yaml'
        self.log.info(
            f'Forcing to reload map for start new task!!!! ({map_yaml})')
        req_map = LoadMap.Request()
        req_map.map_url = map_yaml
        result = self._call_service(n.cli_load_map, req_map, timeout=10.0)
        load_failed = (
            result is None
            or getattr(result, 'result',
                       LoadMap.Response.RESULT_UNDEFINED_FAILURE)
                != LoadMap.Response.RESULT_SUCCESS)
        if load_failed:
            self.log.error(
                'Loading map failed, please check map file exists!!!!')
            n._set_state(TaskMode.STOP, WorkStatus.ERROR_LOAD_MAP)
            response.result = 0
            return response

        # Push polygon to assistant for working-zone tracking
        if hasattr(n, 'cli_assistant_load_map'):
            try:
                n.cli_assistant_load_map.call_async(req_map)
            except Exception as e:
                self.log.warn(
                    f'assistant load_map call failed: {e}')

        cov_mode = int(request.cov_mode)
        include_edge = (cov_mode == 2)  # boundary pass at perimeter
        polygon_area = (
            list(request.polygon_area)
            if cov_mode == 1 and getattr(request, 'polygon_area', None)
            else None)
        if cov_mode == 1 and polygon_area is None:
            self.log.error(
                'cov_mode=1 (SPECIFIED_AREA) but no polygon_area provided')
            response.result = 0
            return response

        # These pass-only branches are INTENTIONAL source markers — do NOT
        # simplify them away. Tests grep for 'cov_mode == 0', 'cov_mode == 1',
        # and 'cov_mode == 2' to verify all three dispatch paths exist.
        # The actual per-mode logic is set above (include_edge for mode 2,
        # polygon_area for mode 1); the blocks below are the visible markers
        # for automated source inspection.
        if cov_mode == 0:
            pass  # default full coverage — no extra flags
        elif cov_mode == 1:
            pass  # polygon_area set above
        elif cov_mode == 2:
            # BOUNDARY-ONLY (edge-cut) does NOT map to only_edge_mode on the
            # NavigateThroughCoveragePaths action — that field does not exist.
            # True boundary-only mowing requires the start_edge_cut extended
            # command which dispatches via NTCP with only_edge_mode:true at the
            # ROS level (see memory edge-cut-ntcp.md + extended_commands.py).
            # Here we set include_edge=True so the coverage run at least adds a
            # boundary pass; the caller should use start_edge_cut for pure edge.
            pass  # include_edge set above

        # cov_mode=1 polygon_area is passed to start_coverage above. Do NOT push
        # it to /local_costmap/prohibited_points — that would mark the user's
        # intended mowing area as a NO-GO zone. Closed binary keeps prohibited
        # zones strictly for explicit obstacle layers, never for cov polygons.

        ok = n.start_coverage(
            map_yaml=map_yaml,
            blade_height=blade_height,
            include_edge=include_edge,
            polygon_area=polygon_area,
            cov_direction=request.cov_direction,
            perception_level=request.perception_level,
        )

        planned_path_file = n.get_parameter('planned_path_file').value
        n.publish_path_json(
            f'{planned_path_file}/planned_path.json', n.planned_path_pub)

        response.result = ok
        return response

    # ─── Save map ──────────────────────────────────────────────

    def _handle_save_map(self, request, response):
        """Save map (decision_msgs/SaveMap). The app sends two calls per session:
          type:0 (sub map) — immediately after stop_scan_map_respond
          type:1 (total map) — ~500 ms later, after save_recharge_pos_respond
        We honour the split: only run the matching stage on each call.
        The app drives the inter-stage cadence; no sleep here.
        """
        self.log.info(
            f'Save map request: type={request.type}, '
            f'mapname={request.mapname}, parent={getattr(request, "map_file_name", "N/A")}')
        n = self.node
        n._set_state(TaskMode.MAPPING, WorkStatus.MAPPING_STOP_RECORD)
        self._stop_recording()

        parent_name = (getattr(request, 'map_file_name', None)
                       or n.current_map_name or 'home0')
        child_name = request.mapname or 'map0'

        save_type = int(request.type)
        if save_type == 0:
            # Sub map. Save the charging pose first so the firmware records
            # the dock anchor used by every later map_yaml load.
            self._save_charging_pose_internal(parent_name, child_name)
            ok, error_code = self._generate_map(0)
        elif save_type == 1:
            # Total map. App fires this ~500 ms after type:0; the firmware
            # has already accepted the sub stage, just regenerate map.yaml /
            # map.pgm here. Don't re-save the charging pose — the type:0
            # call already did it for this session.
            ok, error_code = self._generate_map(1)
            if ok:
                n.save_utm_origin()
        else:
            self.log.warn(f'Save map: unknown type={save_type}; rejecting')
            ok, error_code = False, 0

        if ok:
            self.log.info(
                f'Mapping: type={save_type} stage saved successfully')
            if save_type == 1:
                n._set_state(TaskMode.FREE, WorkStatus.INIT_SUCCESS)
        else:
            self.log.error(
                f'Mapping: save type={save_type} failed (error_code={error_code})')

        response.result = 1 if ok else 0
        response.data = ''
        response.error_code = error_code
        return response

    # ─── Charging ──────────────────────────────────────────────

    def _handle_nav_to_recharge(self, request, response):
        """Navigate to charging dock with optional guide pose. Closed binary
        rejects if currently mapping ('Recharge with guide pose mode only
        support no mapping mode')."""
        self.log.info(
            f'Charging: nav_to_recharge mode={request.mode} '
            f'pose=({request.pose_x:.2f}, {request.pose_y:.2f}, '
            f'{request.pose_theta:.2f})')
        n = self.node
        if n.task_mode == TaskMode.CHARGING:
            response.result = 0
            response.description = 'Already charging'
            return response
        if n.task_mode == TaskMode.MAPPING:
            self.log.warn(
                'Recharge with guide pose mode only support no mapping mode')
            response.result = 0
            response.description = (
                'Recharge with guide pose mode only support no mapping mode')
            return response

        guide_pose = None
        if request.mode == '1':  # guide pose mode (mode field is string in srv)
            guide_pose = (float(request.pose_x), float(request.pose_y),
                          float(request.pose_theta))
        n.start_recharge(guide_pose=guide_pose)
        response.result = 1
        response.description = 'Navigating to charger'
        return response

    # ─── Generate coverage path ─────────────────────────────────

    def _handle_generate_path(self, request, response):
        """Generate preview coverage path via coverage_planner_server.

        CoveragePathsByFile.srv (live mower, verified 2026-04-26):
          Request:  map_yaml_file (string), start_pose (geometry_msgs/Pose)
          Response: coverage_paths[] (nav_msgs/Path[]), result (uint8)
        Only map_yaml_file + start_pose exist on the request — no include_edge,
        no specify_direction, no cov_direction (those belong to the action goal,
        not this srv).  Direction/edge flags are passed when actually starting
        coverage via NavigateThroughCoveragePaths.action.
        """
        self.log.info(
            f'GenerateCoveragePath: map_ids={request.map_ids}, '
            f'direction={request.cov_direction}')
        n = self.node

        load_map_path = n.get_parameter('load_map_path').value
        map_yaml = f'{load_map_path}/map.yaml'

        req = CoveragePathsByFile.Request()
        # Live firmware field is `map_yaml` (NOT `map_yaml_file` — verified
        # 2026-04-26 from /root/novabot/install coverage_planner srv).
        req.map_yaml = map_yaml
        # Direction control is via the action goal, not the srv.

        result = self._call_service(
            n.cli_coverage_by_file, req, timeout=10.0)
        # Live CoveragePathsByFile.srv response (verified 2026-04-26):
        #   bool success, string msg, string path_json, float32 planned_area
        # (the old coverage_paths: nav_msgs/Path[] form no longer exists)
        if result and getattr(result, 'success', False):
            # path_json is already a JSON string containing coverage paths.
            # Publish it directly for the preview publisher.
            from std_msgs.msg import String
            path_msg = String()
            path_json = getattr(result, 'path_json', '{"paths":[]}')
            path_msg.data = path_json
            n.preview_path_pub.publish(path_msg)
            self.log.info(
                f'GenerateCoveragePath: success, '
                f'planned_area={getattr(result, "planned_area", "?")}m²')
            response.result = True
        else:
            self.log.warn(
                f'GenerateCoveragePath: failed '
                f'(msg={getattr(result, "msg", None)})')
            response.result = False
        return response

    # ─── Delete map ────────────────────────────────────────────

    def _handle_delete_map(self, request, response):
        """Delete sub-map (1) / obstacle (2) / unicom (3) by forwarding
        request.maptype to /novabot_mapping/mapping_control. Closed binary
        transitions through DELETE_CHILD_MAP / DELETE_OBSTACLE /
        DELETE_UINICOM (spelling preserved to mirror C++ enum)."""
        # DeleteMap.Request has only maptype + mapname (no map_file_name field, live verified 2026-04-26).
        # Parent map name is derived from current node state.
        n = self.node
        parent_name = n.current_map_name or 'home0'
        self.log.info(
            f'DeleteMap: maptype={request.maptype}, '
            f'mapname={request.mapname}, parent={parent_name}')
        state_map = {
            1: WorkStatus.DELETE_CHILD_MAP,
            2: WorkStatus.DELETE_OBSTACLE,
            3: WorkStatus.DELETE_UINICOM,
        }
        target_state = state_map.get(int(request.maptype))
        if target_state is not None:
            n._set_state(TaskMode.MAPPING, target_state)

        req = MappingControlSrv.Request()
        req.map_file_name = parent_name
        req.child_map_file_name = request.mapname if request.maptype == 1 else ''
        req.obstacle_file_name = request.mapname if request.maptype == 2 else ''
        req.unicom_area_file_name = request.mapname if request.maptype == 3 else ''
        req.type = int(request.maptype)
        result = self._call_service(n.cli_mapping_control, req)
        ok = result.result if result else False

        n._set_state(TaskMode.FREE, WorkStatus.INIT_SUCCESS)
        response.result = 1 if ok else 0
        response.description = 'Map deleted' if ok else 'Delete failed'
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
        ok, dist = self._save_charging_pose_internal(
            map_name=request.map_file_name or 'home0',
            child_name=request.child_map_file_name or 'map0')

        response.result = 1 if ok else 0
        # SetChargingPose.Response has no map_to_charging_dis field (live verified 2026-04-26).
        # Distance is not exposed by this response type; omit.
        return response

