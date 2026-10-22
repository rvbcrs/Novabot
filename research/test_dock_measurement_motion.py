"""Run: python3 research/test_dock_measurement_motion.py. No ROS or hardware."""
import importlib.util
import math
import os
import sys
import tempfile
import json
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('dock_commands', os.path.join(os.path.dirname(__file__), 'extended_commands.py'))
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
ID = '12345678-1234-1234-1234-123456789abc'
PROTOCOL = 'dock-measurement-motion-v4'
GOAL = '/auto_charging'
CANCEL = '/auto_charging/_action/cancel_goal'


class MotionTest(unittest.TestCase):
    def setUp(self):
        c._DOCK_MOTIONS.clear()

    def test_single_use_arm_cancel_and_expired_heartbeat(self):
        with patch.object(c.time, 'monotonic', return_value=100):
            c.handle_dock_measurement_control({'motion_id': ID, 'action': 'arm'}, lambda *a: None)
            with self.assertRaises(ValueError):
                c.handle_dock_measurement_control({'motion_id': ID, 'action': 'arm'}, lambda *a: None)
        with patch.object(c.time, 'monotonic', return_value=102.86):
            c.handle_dock_measurement_control({'motion_id': ID, 'action': 'keepalive'}, lambda *a: None)
        with patch.object(c.time, 'monotonic', return_value=107):
            with self.assertRaises(ValueError):
                c.handle_dock_measurement_control({'motion_id': ID, 'action': 'keepalive'}, lambda *a: None)
        self.assertTrue(c._DOCK_MOTIONS[ID]['cancelled'])
        c._DOCK_MOTIONS.clear()
        c.handle_dock_measurement_control({'motion_id': ID, 'action': 'stop'}, lambda *a: None)
        with self.assertRaises(ValueError):
            c.handle_dock_measurement_control({'motion_id': ID, 'action': 'arm'}, lambda *a: None)

    def test_signed_distance_heading_sideways_and_jump_guards(self):
        start = (0, 0, 0)
        self.assertAlmostEqual(c._dock_motion_progress(start, (-.5, 0, 0), (-.48, 0, 0), .5), .5)
        for pose, previous in [((.04, 0, 0), start), ((-.02, .07, 0), start), ((-.02, 0, .2), start), ((-.5, 0, 0), start), ((-.57, 0, 0), (-.55, 0, 0)), ((math.nan, 0, 0), start)]:
            with self.subTest(pose=pose), self.assertRaises(ValueError):
                c._dock_motion_progress(start, pose, previous, .5)

    def test_chassis_faults_and_missing_stop_sensor_are_rejected(self):
        d = {k: False for k in ('warning_push_button_stop', 'error_push_button_stop', 'warning_collision_stop', 'error_collision_stop', 'warning_upraise_stop', 'error_upraise_stop', 'error_turn_over', 'error_lora', 'warning_lora_rtk_data_overtime')}
        self.assertTrue(c._dock_motion_chassis_ok(d))
        charging = dict(d, warning_charge_stop=True, error_charge_stop=True)
        self.assertFalse(c._dock_motion_chassis_ok(charging))
        self.assertTrue(c._dock_motion_chassis_ok(charging, allow_charge_stop=True))
        for key in d:
            self.assertFalse(c._dock_motion_chassis_ok(dict(d, **{key: True})))
            self.assertFalse(c._dock_motion_chassis_ok(dict(charging, **{key: True}), allow_charge_stop=True))
        del d['error_push_button_stop']
        self.assertFalse(c._dock_motion_chassis_ok(d))

    def test_dock_start_window_matches_auto_recharge_server_init_check(self):
        # 0.87..1.47 m and 0.51 rad are the native INIT_CHECK limits; the
        # handler keeps a margin so the native server never picks nav2 or step-back.
        dock = (0., 0., 0.)
        self.assertIsNone(c._dock_start_window(dock, (-1.1, 0., 0.)))
        self.assertIsNone(c._dock_start_window(dock, (-.96, .1, -.3)))
        for pose in [(-.9, 0., 0.), (-1.45, 0., 0.), (-1.1, 0., .45), (-1.1, .6, 0.), (1.1, 0., 0.), (-1.1, 0., math.pi), (math.nan, 0., 0.)]:
            with self.subTest(pose=pose):
                self.assertTrue(c._dock_start_window(dock, pose))

    def run_motion(self, action='reverse', failure=None, from_dock=None, recovery=False, start=None, charge_pose='auto', distance=None):
        if from_dock is None: from_dock = action == 'reverse'
        if start is None: start = (0. if from_dock else -.5 if action == 'reverse' else -1.1, 0., 0.)
        if charge_pose == 'auto': charge_pose = {'x': 0., 'y': 0., 'yaw': 0.} if action == 'dock' else None
        if distance is None: distance = (1. if from_dock else .2) if action == 'reverse' else 0
        sim = types.SimpleNamespace(now=100., next_map=100., x=start[0], y=start[1], yaw=start[2], velocity=0., homing=False, native_done=False, native_code=None, detector=False, calls=[], goals=[], published=[], lights=[], destroyed=False, service_fault_at=float('inf'),
                                    coast_until=0., coast_speed=0., docked_at=None, detector_at=None)
        subscriptions = {}
        state = {'created': 100., 'heartbeat': 100., 'cancelled': False, 'used': False}
        c._DOCK_MOTIONS[ID] = state
        class Twist:
            def __init__(self):
                self.linear = types.SimpleNamespace(x=0., y=0., z=0.)
                self.angular = types.SimpleNamespace(x=0., y=0., z=0.)
        class PoseStamped:
            def __init__(self):
                self.header = types.SimpleNamespace(frame_id='', stamp=None)
                self.pose = types.SimpleNamespace(position=types.SimpleNamespace(x=0., y=0., z=0.), orientation=types.SimpleNamespace(x=0., y=0., z=0., w=1.))
        class Service:
            class Request: pass
        class Client:
            def __init__(self, name): self.name = name
            def wait_for_service(self, **kw): return True
            def call_async(self, req):
                sim.calls.append(self.name)
                if self.name == CANCEL: sim.homing = False
                if self.name == '/enable_aruco_localization':
                    sim.detector = req.data
                    if req.data: sim.detector_at = sim.now
                refused = self.name == CANCEL and failure == 'cancel-refused'
                return types.SimpleNamespace(done=lambda: True, result=lambda: types.SimpleNamespace(success=True, return_code=1 if refused else 0))
        class AutoCharging:
            class Goal:
                def __init__(self):
                    self.charge_pose = PoseStamped(); self.overwrite = False; self.non_charging_pose_mode = False
                    self.enable_no_visual_recharge = False; self.max_retry = 0; self.disable_charge_check = False
                    self.keep_alive = False; self.rotate_searching = False
        class ActionClient:
            def __init__(self, node, kind, name): self.name = name
            def wait_for_server(self, **kw): return failure != 'no-action-server'
            def send_goal_async(self, goal):
                sim.calls.append(self.name); sim.goals.append(goal)
                accepted = failure != 'goal-rejected'
                if accepted: sim.homing = True
                if failure == 'rtk-during-goal':
                    sim.service_fault_at = sim.now + .1
                    done_at = sim.now + .4
                    return types.SimpleNamespace(done=lambda: sim.now >= done_at, result=lambda: handle)
                handle = types.SimpleNamespace(accepted=accepted, get_result_async=lambda: types.SimpleNamespace(
                    done=lambda: sim.native_done, result=lambda: types.SimpleNamespace(result=types.SimpleNamespace(code=sim.native_code, message='native'))))
                return types.SimpleNamespace(done=lambda: True, result=lambda: handle)
        class Publisher:
            def __init__(self, topic): self.topic = topic
            def get_subscription_count(self): return 0 if self.topic == '/led_set' and failure == 'lamp-unavailable' else 1
            def publish(self, msg):
                if self.topic == '/cmd_vel':
                    # The chassis ramps down and the fused pose trails the wheels.
                    if failure == 'coast' and msg.linear.x == 0 and sim.velocity < 0:
                        sim.coast_until, sim.coast_speed = sim.now + .6, sim.velocity
                    sim.velocity = msg.linear.x
                    sim.published.append(sim.velocity)
                if self.topic == '/led_set': sim.lights.append(msg['data'])
        class Node:
            def create_publisher(self, kind, topic, qos): return Publisher(topic)
            def create_client(self, kind, name): return Client(name)
            def create_subscription(self, kind, topic, cb, qos): subscriptions[topic] = cb
            def get_clock(self): return types.SimpleNamespace(now=lambda: types.SimpleNamespace(to_msg=lambda: {'sec': int(sim.now), 'nanosec': 0}))
            def destroy_node(self): sim.destroyed = True
        class Context:
            def shutdown(self): pass
        class Executor:
            def __init__(self, **kw): pass
            def add_node(self, node): pass
            def remove_node(self, node): pass
            def shutdown(self): pass
            def spin_once(self, timeout_sec):
                sim.now += .05
                if failure != 'heartbeat': state['heartbeat'] = sim.now
                if failure == 'stop' and sim.now > 103: state['cancelled'] = True
                speed = .15 if sim.homing else sim.velocity
                if failure == 'moving-at-start' or (failure == 'creeping' and speed == 0 and any(v < 0 for v in sim.published)):
                    speed = -.03
                if failure == 'coast' and sim.now < sim.coast_until:
                    speed = sim.coast_speed
                if failure != 'stalled': sim.x = min(0., sim.x + speed * .05)
                if sim.x == 0 and sim.homing:
                    sim.homing = False; speed = 0
                    sim.native_done = True
                    sim.docked_at = sim.now
                    sim.native_code = 12 if failure in ('no-contact', 'native-fail-after-contact') else 100
                contact = sim.x > -.01 and failure != 'no-contact'
                # robot_decision can report the charging state after the chassis
                # flags (native "wait 1500ms and reconfirm charge status").
                if failure in ('flags-first', 'final-gap'):
                    contact = sim.docked_at is not None and sim.now >= sim.docked_at + 1.5
                if failure == 'contact-flicker' and sim.docked_at is not None and sim.docked_at + .3 <= sim.now < sim.docked_at + .8:
                    contact = False
                if failure == 'native-fail-early' and sim.homing and sim.x < -.6:
                    sim.homing = False; speed = 0; sim.native_done = True; sim.native_code = 3
                stamp_ns = round((1000 + sim.now - .001) * 1e9)
                h = {'stamp': {'sec': stamp_ns // 10**9, 'nanosec': stamp_ns % 10**9}}
                p = {'position': {'x': sim.x, 'y': sim.y, 'z': 0.}, 'orientation': {'x': 0., 'y': 0., 'z': math.sin(sim.yaw / 2), 'w': math.cos(sim.yaw / 2)}}
                if failure == 'shifted-map':
                    p['position']['x'] += 12
                    p['position']['y'] += 7
                if failure == 'initial-heading-correction' and sim.x > -.1:
                    p['position']['x'] += .15
                    p['orientation'].update(z=math.sin(.4 / 2), w=math.cos(.4 / 2))
                chassis = {k: False for k in ('warning_push_button_stop', 'error_push_button_stop', 'warning_collision_stop', 'error_collision_stop', 'warning_upraise_stop', 'error_upraise_stop', 'error_turn_over', 'error_lora', 'warning_lora_rtk_data_overtime')}
                if from_dock or (action == 'dock' and sim.x == 0. and (failure != 'final-gap' or contact)) or failure == 'charge-fault':
                    chassis.update(warning_charge_stop=True, error_charge_stop=True)
                if failure == 'bumper' and sim.now > 103: chassis['error_collision_stop'] = True
                values = {
                    '/robot_decision/map_position': p,
                    '/robot_combination_localization/odom': {'header': h, 'twist': {'twist': {'linear': {'x': 0. if failure in ('moving-at-start', 'creeping') else speed, 'y': 0., 'z': 0.}, 'angular': {'x': 0., 'y': 0., 'z': 0.}}}},
                    '/robot_decision/robot_status': {'merged_work_status': 4 if contact else 2 if sim.homing else 0, 'error_status': 0, 'battery_power': 80},
                    '/bestpos_parsed_data': {'qual': 5 if failure == 'float' else 1 if (failure == 'rtk' and sim.now > 103) or (failure == 'rtk-during-goal' and sim.now > sim.service_fault_at) else 4,
                                             'diff_age': 4. if failure == 'rtk-age' and sim.now > 103 else 1.},
                    '/chassis_incident': chassis,
                    '/robot_combination_localization/combination_status': {'status': 100 if failure == 'localization' and sim.now > 103 else 200},
                }
                # One late robot_status (2 s, still inside 2.5 s) and one that stays away.
                if (failure == 'late-status' and 102 <= sim.now < 104) or (failure == 'lost-status' and 102 <= sim.now < 105.2):
                    values.pop('/robot_decision/robot_status')
                pattern_gap = ((failure == 'pattern-gap' and 103 <= sim.now < 104.5) or
                               (failure == 'final-gap' and sim.x > -.15))
                if sim.detector and failure != 'missing-pattern' and not pattern_gap and not (failure in ('pattern-lost', 'cancel-refused') and sim.now > 104):
                    # A native lateral correction swings the pattern to the side for a moment.
                    lateral = {'native-correction': .5, 'native-overcorrection': .7}.get(failure, 0.) if 103 <= sim.now < 104 else 0.
                    header = dict(h, frame_id='aruco_tag')
                    if failure == 'stale-pattern' or (failure == 'stale-pattern-first' and sim.now < sim.detector_at + .5):
                        old_ns = stamp_ns - 2 * 10**9
                        header['stamp'] = {'sec': old_ns // 10**9, 'nanosec': old_ns % 10**9}
                    values['/aruco/pose'] = {'header': header, 'pose': {'position': {'x': -(2.5 if failure == 'distant-pattern' else .1 - sim.x), 'y': -lateral, 'z': -.15}, 'orientation': {'x': 0., 'y': 0., 'z': 0., 'w': 1.}}}
                if failure == 'manual' and sim.now > 103: values['/cloud_move_cmd'] = {}
                if failure == 'stale' and sim.now > 103: values.pop('/robot_combination_localization/odom')
                if sim.now < sim.next_map:
                    values.pop('/robot_decision/map_position')
                else:
                    sim.next_map = sim.now + .5
                for topic, cb in list(subscriptions.items()):
                    if topic in values: cb(values[topic])
        modules = {}
        def module(name, **members):
            m = types.ModuleType(name); m.__dict__.update(members); modules[name] = m; return m
        module('rclpy', init=lambda **kw: None, create_node=lambda *a, **kw: Node())
        module('rclpy.context', Context=Context); module('rclpy.executors', SingleThreadedExecutor=Executor)
        module('rclpy.action', ActionClient=ActionClient)
        module('rclpy.qos', QoSProfile=lambda **kw: None, ReliabilityPolicy=types.SimpleNamespace(BEST_EFFORT=0))
        module('rosidl_runtime_py.utilities', get_message=lambda kind: object)
        module('rosidl_runtime_py.convert', message_to_ordereddict=lambda msg: msg)
        module('geometry_msgs.msg', Twist=Twist, PoseStamped=PoseStamped); module('std_msgs.msg', UInt8=lambda **kw: kw)
        module('std_srvs.srv', Trigger=Service, SetBool=Service)
        module('action_msgs.srv', CancelGoal=Service)
        module('automatic_recharge_msgs.action', AutoCharging=AutoCharging)
        results = []
        params = {'motion_id': ID, 'action': action, 'distance_m': distance, 'from_dock': from_dock, 'recovery': recovery, 'frame_fingerprint': 'frame'}
        if charge_pose is not None: params['charge_pose'] = charge_pose
        with tempfile.TemporaryDirectory() as directory:
            os.mkdir(directory + '/csv_file')
            with open(directory + '/csv_file/map_info.json', 'w') as f: json.dump({'charging_pose': {'x': 0, 'y': 0, 'orientation': 0}}, f)
            with patch.dict(sys.modules, modules), patch.object(c, '_marker_frame_fingerprint', return_value='frame'), patch.object(c, '_map_home', return_value=directory), patch.object(c, '_marker_camera_use', side_effect=lambda action, *args: sim.now + 30), patch.object(c.time, 'monotonic', side_effect=lambda: sim.now), patch.object(c.time, 'time', side_effect=lambda: sim.now + 1000):
                try:
                    c.handle_dock_measurement_move(params, lambda name, data: results.append(data))
                except ValueError as error: sim.error = str(error)
        self.assertTrue(sim.destroyed)
        self.assertEqual(sim.published[-1], 0.)
        self.assertTrue(state['cancelled'])
        return sim, results

    def test_real_handler_bounds_departure_then_uses_distance_for_second_step(self):
        sim, results = self.run_motion()
        self.assertEqual(results[0]['result'], 0)
        self.assertEqual(results[0]['protocol'], PROTOCOL)
        self.assertAlmostEqual(sim.x, -1., delta=.02)
        self.assertNotIn(GOAL, sim.calls)
        sim, results = self.run_motion(from_dock=False)
        self.assertEqual(results[0]['result'], 0)
        self.assertAlmostEqual(sim.x, -.7, delta=.06)

    def test_departure_reports_the_docked_pose_it_left_from(self):
        # The live frame pose (here shifted 12/7 m from the saved dock), not map_info.json.
        sim, results = self.run_motion(failure='shifted-map', start=(0., 0., 1.3))
        self.assertEqual(results[0]['result'], 0)
        pose = results[0]['start_pose']
        self.assertAlmostEqual(pose['x'], 12.); self.assertAlmostEqual(pose['y'], 7.); self.assertAlmostEqual(pose['yaw'], 1.3)

    def test_parameter_limits_are_checked_before_any_node_exists(self):
        base = {'motion_id': ID, 'from_dock': True, 'recovery': False, 'frame_fingerprint': 'frame'}
        for params in ({'action': 'reverse', 'distance_m': 1.3}, {'action': 'reverse', 'distance_m': .5, 'charge_pose': {'x': 0, 'y': 0, 'yaw': 0}},
                       {'action': 'dock', 'distance_m': 0, 'from_dock': False}, {'action': 'dock', 'distance_m': 0, 'from_dock': False, 'charge_pose': {'x': 0, 'y': 0}},
                       {'action': 'dock', 'distance_m': 0, 'from_dock': False, 'charge_pose': {'x': 0, 'y': 0, 'yaw': math.nan}},
                       {'action': 'dock', 'distance_m': 0, 'from_dock': False, 'charge_pose': {'x': True, 'y': 0, 'yaw': 0}}):
            with self.subTest(params=params), self.assertRaises(ValueError):
                c.handle_dock_measurement_move(dict(base, **params), lambda *a: None)
        self.assertFalse(c._DOCK_MOTIONS[ID]['used'] if ID in c._DOCK_MOTIONS else False)

    def test_first_departure_accepts_heading_initialization(self):
        sim, results = self.run_motion(failure='initial-heading-correction')
        self.assertEqual(results[0]['result'], 0)
        self.assertAlmostEqual(sim.x, -1., delta=.02)
        self.assertTrue(all(v in (0., -.08) for v in sim.published))

    def test_first_departure_accepts_float_but_later_motion_does_not(self):
        sim, results = self.run_motion(failure='float')
        self.assertEqual(results[0]['result'], 0)
        self.assertAlmostEqual(sim.x, -1., delta=.02)
        sim, results = self.run_motion(failure='float', from_dock=False)
        self.assertFalse(results)
        self.assertFalse(any(v < 0 for v in sim.published))
        sim, results = self.run_motion(failure='charge-fault', from_dock=False)
        self.assertFalse(results)
        self.assertFalse(any(v < 0 for v in sim.published))

    def test_visual_dock_sends_the_measured_pose_in_the_native_goal_and_requires_contact(self):
        sim, results = self.run_motion('dock', charge_pose={'x': 0., 'y': 0., 'yaw': 0.})
        self.assertEqual(results[0]['docked'], True)
        self.assertEqual(results[0]['native_code'], 100)
        self.assertAlmostEqual(sim.x, 0.)
        self.assertNotIn('/robot_decision/auto_recharge', sim.calls)
        goal = sim.goals[0]
        self.assertTrue(goal.overwrite)
        self.assertFalse(goal.non_charging_pose_mode or goal.enable_no_visual_recharge or goal.rotate_searching or goal.keep_alive or goal.disable_charge_check)
        self.assertEqual(goal.charge_pose.header.frame_id, 'map')
        self.assertEqual((goal.charge_pose.pose.position.x, goal.charge_pose.pose.position.y), (0., 0.))
        self.assertAlmostEqual(goal.charge_pose.pose.orientation.w, 1.)
        sim, results = self.run_motion('dock', 'no-contact')
        self.assertFalse(results)
        self.assertIn(CANCEL, sim.calls)

    def test_visual_dock_refuses_outside_the_native_start_window(self):
        # Includes a stale saved pose in a shifted frame: 14 m from the live pose.
        for kwargs in ({'start': (-.7, 0., 0.)}, {'start': (-1.5, 0., 0.)}, {'start': (-1.1, 0., .5)}, {'start': (-1.1, .7, 0.)}, {'failure': 'shifted-map'}):
            with self.subTest(**kwargs):
                sim, results = self.run_motion('dock', **kwargs)
                self.assertFalse(results)
                self.assertNotIn(GOAL, sim.calls)
                self.assertFalse(sim.lights)

    def test_recovery_docks_on_camera_and_contact_despite_translated_map(self):
        # The server passes the docked pose it measured in the same shifted frame.
        sim, results = self.run_motion('dock', 'shifted-map', recovery=True, charge_pose={'x': 12., 'y': 7., 'yaw': 0.})
        self.assertEqual(results[0]['protocol'], PROTOCOL)
        self.assertTrue(results[0]['docked'])
        self.assertAlmostEqual(sim.x, 0.)
        self.assertEqual(sim.lights, [255, 0])
        for failure in ('missing-pattern', 'distant-pattern', 'no-contact', 'stop', 'heartbeat', 'pattern-lost', 'goal-rejected', 'no-action-server', 'native-fail-early'):
            with self.subTest(failure=failure):
                sim, results = self.run_motion('dock', failure, recovery=True)
                self.assertFalse(results)
                self.assertFalse(sim.homing)
                self.assertEqual(sim.lights, [255, 0])
        sim, results = self.run_motion('dock', 'lamp-unavailable', recovery=True)
        self.assertFalse(results)
        self.assertEqual(sim.lights, [])
        self.assertNotIn(GOAL, sim.calls)

    def test_native_failure_after_confirmed_contact_still_counts_as_docked(self):
        sim, results = self.run_motion('dock', 'native-fail-after-contact')
        self.assertTrue(results[0]['docked'])
        self.assertEqual(results[0]['native_code'], 12)
        self.assertNotIn(CANCEL, sim.calls)

    def test_dock_goal_reports_first_guard_failure(self):
        sim, results = self.run_motion('dock', 'rtk-during-goal', recovery=True)
        self.assertFalse(results)
        self.assertEqual(sim.error, 'RTK not Fixed during motion (quality 1)')
        self.assertFalse(sim.homing)

    def test_each_lost_rtk_or_localization_cause_has_its_own_reason(self):
        # One combined reason sent users after RTK when the localization was
        # re-initialising, and the other way round (GH #158).
        for failure, reason in (('rtk', 'RTK not Fixed during motion (quality 1)'),
                                ('rtk-age', 'RTK corrections stale during motion (age 4.0 s)'),
                                ('localization', 'localization status not 200 during motion (status 100)')):
            with self.subTest(failure=failure):
                sim, results = self.run_motion(failure=failure)
                self.assertFalse(results)
                self.assertEqual(sim.error, reason)

    def test_stop_window_after_the_reverse_outlasts_a_chassis_ramp_down(self):
        # stationary() needs a 1.75 s pose window free of driving samples plus a
        # 1 s hold: a 0.6 s ramp-down left nothing of the 3 s window (GH #158).
        sim, results = self.run_motion(failure='coast')
        self.assertEqual(results[0]['result'] if results else getattr(sim, 'error', None), 0)
        self.assertTrue(all(v in (0., -.08) for v in sim.published))

    def test_robot_status_may_arrive_late_but_not_stay_away(self):
        sim, results = self.run_motion(failure='late-status')
        self.assertEqual(results[0]['result'] if results else getattr(sim, 'error', None), 0)
        sim, results = self.run_motion(failure='lost-status')
        self.assertFalse(results)
        self.assertEqual(sim.error, 'motion telemetry stale: /robot_decision/robot_status')

    def test_pattern_bounds_cover_the_start_window(self):
        def marker(forward, lateral):
            return {'header': {'frame_id': 'aruco_tag'}, 'pose': {'position': {'x': -forward, 'y': -lateral, 'z': -.15},
                                                                  'orientation': {'x': 0., 'y': 0., 'z': 0., 'w': 1.}}}
        # 1.40 m x sin(0.40 rad) = 0.55 m: the side offset the start window itself accepts.
        self.assertAlmostEqual(c._dock_marker_forward(marker(1.5, .55)), 1.5)
        self.assertAlmostEqual(c._dock_marker_forward(marker(.4, -.55)), .4)
        for forward, lateral in ((1.5, .65), (1.95, 0.), (-.1, 0.)):
            with self.subTest(forward=forward, lateral=lateral), self.assertRaises(ValueError):
                c._dock_marker_forward(marker(forward, lateral))

    def test_native_correction_may_swing_or_hide_the_pattern_briefly(self):
        # Normal native docking steers the pattern aside or out of view for a
        # moment and recovers (GH #158); the guard must let it.
        for failure in ('native-correction', 'pattern-gap', 'final-gap'):
            with self.subTest(failure=failure):
                sim, results = self.run_motion('dock', failure)
                self.assertTrue(results and results[0]['docked'], getattr(sim, 'error', None))
        for failure in ('native-overcorrection', 'pattern-lost'):
            with self.subTest(failure=failure):
                sim, results = self.run_motion('dock', failure)
                self.assertFalse(results)
                self.assertFalse(sim.homing)
                self.assertIn(CANCEL, sim.calls)

    def test_charge_stop_belongs_to_contact_seen_just_before_or_after(self):
        # chassis_incident (every 2 s) and robot_status (2 Hz) report one
        # contact in either order (GH #158).
        for failure in ('flags-first', 'contact-flicker'):
            with self.subTest(failure=failure):
                sim, results = self.run_motion('dock', failure)
                self.assertTrue(results and results[0]['docked'], getattr(sim, 'error', None))
        # Without contact the flags are a stop again once the window has passed.
        sim, results = self.run_motion('dock', 'no-contact')
        self.assertFalse(results)
        self.assertEqual(sim.error, 'chassis stop or fault')

    def test_docking_waits_for_a_pattern_seen_after_the_detector_was_enabled(self):
        sim, results = self.run_motion('dock', 'stale-pattern-first')
        self.assertTrue(results and results[0]['docked'], getattr(sim, 'error', None))
        sim, results = self.run_motion('dock', 'stale-pattern')
        self.assertFalse(results)
        self.assertEqual(sim.error, 'no fresh dock pattern before docking')
        self.assertNotIn(GOAL, sim.calls)

    def test_failed_cancellation_keeps_the_original_cause_in_the_error(self):
        # 2026-09-30 20:11: a refused cancel inside `finally` replaced the guard
        # fault ("robot is busy") by "dock service did not confirm" in the logs.
        sim, results = self.run_motion('dock', 'cancel-refused', recovery=True)
        self.assertFalse(results)
        self.assertIn('dock pattern lost', sim.error)
        self.assertIn('cancellation not confirmed', sim.error)

    def test_retired_calibration_never_reads_or_writes_files(self):
        responses = []
        with patch('builtins.open', side_effect=AssertionError('legacy command touched files')):
            c.handle_recalibrate_charging_pose({'x': 9, 'y': 4, 'theta': 1}, lambda _, data: responses.append(data))
        self.assertEqual(responses[0]['result'], 1)

    def test_zero_twist_does_not_prove_standstill(self):
        sim, results = self.run_motion(failure='moving-at-start')
        self.assertFalse(results)
        self.assertFalse(any(v < 0 for v in sim.published), 'must not start while positions are moving')
        sim, results = self.run_motion(failure='creeping')
        self.assertFalse(results, 'must not confirm a stop while positions are moving')
        self.assertNotIn(GOAL, sim.calls)

    def test_real_handler_aborts_and_stops_for_fault_loss_or_operator_intervention(self):
        for failure in ('stop', 'heartbeat', 'stalled', 'rtk', 'rtk-age', 'bumper', 'manual', 'stale'):
            with self.subTest(failure=failure):
                sim, results = self.run_motion(failure=failure)
                self.assertFalse(results)
                self.assertTrue(sim.error)
                self.assertNotIn(GOAL, sim.calls)
        for failure in ('stop', 'heartbeat', 'missing-pattern'):
            with self.subTest(docking=failure):
                sim, results = self.run_motion('dock', failure)
                self.assertFalse(results)
                self.assertFalse(sim.homing)


if __name__ == '__main__': unittest.main()
