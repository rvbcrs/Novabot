"""
Mock ROS2 modules for testing mqtt_bridge.py on a non-ROS2 system (Mac/Linux).

Provides fake rclpy, std_srvs, decision_msgs, mapping_msgs, novabot_msgs,
geometry_msgs, and std_msgs so mqtt_bridge.py can import and run without
an actual ROS2 installation.

Service calls return success by default. Topic subscribers receive no data
(status publishing is tested by injecting fake RobotStatus messages).
"""

import sys
import types
import threading


# ── Fake ROS2 message types ──────────────────────────────────────────────────

class FakeMsg:
    """Base class for fake ROS2 messages — allows any attribute with nesting."""
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)

    def __getattr__(self, name):
        # Return a nested FakeMsg for chained attribute access (e.g. msg.header.frame_id)
        obj = FakeMsg()
        object.__setattr__(self, name, obj)
        return obj

    def __setattr__(self, name, value):
        object.__setattr__(self, name, value)

    def __str__(self):
        return "FakeMsg"

    def __float__(self):
        return 0.0

    def __int__(self):
        return 0


class FakeRequest:
    """Fake service request — allows setting any attribute."""
    def __getattr__(self, name):
        return 0

    def __setattr__(self, name, value):
        object.__setattr__(self, name, value)


class FakeResponse:
    """Fake service response — configurable success/failure."""
    def __init__(self, success=True):
        self.result = 1 if success else 0
        self.success = success
        self.message = "mock"
        self.data = ""
        self.error_code = 0
        self.description = ""
        self.charging_pose = FakeMsg(
            position=FakeMsg(x=1.0, y=2.0, z=0.0),
            orientation=FakeMsg(x=0.0, y=0.0, z=0.5, w=0.866),
        )
        self.map_to_charging_dis = 1.5


class FakeFuture:
    """Fake asyncio future that resolves immediately."""
    def __init__(self, response):
        self._response = response

    def done(self):
        return True

    def result(self):
        return self._response


class FakeServiceClient:
    """Fake ROS2 service client — returns success immediately."""
    def __init__(self, srv_type, srv_name, **kwargs):
        self.srv_name = srv_name
        self._srv_type = srv_type

    def wait_for_service(self, timeout_sec=1.0):
        return True

    def call_async(self, request):
        return FakeFuture(FakeResponse(success=True))


class FakePublisher:
    """Fake ROS2 publisher — logs published messages."""
    def __init__(self, msg_type, topic, qos):
        self.topic = topic
        self.msg_type = msg_type
        self.published = []

    def publish(self, msg):
        self.published.append(msg)


class FakeSubscription:
    """Fake ROS2 subscription — stores callback for manual triggering."""
    def __init__(self, msg_type, topic, callback, qos, **kwargs):
        self.topic = topic
        self.callback = callback


class FakeCallbackGroup:
    pass


class FakeNode:
    """Fake ROS2 node with service client/publisher/subscription creation."""
    def __init__(self, name):
        self.name = name
        self._clients = {}
        self._publishers = {}
        self._subscriptions = {}
        self._logger = FakeLogger()

    def create_client(self, srv_type, srv_name, **kwargs):
        client = FakeServiceClient(srv_type, srv_name, **kwargs)
        self._clients[srv_name] = client
        return client

    def create_publisher(self, msg_type, topic, qos):
        pub = FakePublisher(msg_type, topic, qos)
        self._publishers[topic] = pub
        return pub

    def create_subscription(self, msg_type, topic, callback, qos, **kwargs):
        sub = FakeSubscription(msg_type, topic, callback, qos, **kwargs)
        self._subscriptions[topic] = sub
        return sub

    def get_logger(self):
        return self._logger

    def destroy_node(self):
        pass


class FakeLogger:
    def info(self, msg): print(f"[ROS2-MOCK] INFO: {msg}")
    def warn(self, msg): print(f"[ROS2-MOCK] WARN: {msg}")
    def error(self, msg): print(f"[ROS2-MOCK] ERROR: {msg}")


class FakeExecutor:
    """Fake MultiThreadedExecutor — spin() blocks forever."""
    def __init__(self, **kwargs):
        self._nodes = []

    def add_node(self, node):
        self._nodes.append(node)

    def spin(self):
        # Block forever (runs in daemon thread)
        threading.Event().wait()


# ── Build fake module hierarchy ──────────────────────────────────────────────

def _make_srv_module(service_names):
    """Create a fake srv module with Request/Response classes for each service."""
    mod = types.ModuleType('srv')
    for name in service_names:
        cls = type(name, (), {
            'Request': type('Request', (FakeRequest,), {}),
            'Response': type('Response', (FakeResponse,), {}),
        })
        setattr(mod, name, cls)
    return mod


def _make_msg_module(msg_names):
    """Create a fake msg module with message classes."""
    mod = types.ModuleType('msg')
    for name in msg_names:
        cls = type(name, (FakeMsg,), {
            '__init__': lambda self, **kw: FakeMsg.__init__(self, **kw),
        })
        setattr(mod, name, cls)
    return mod


def install_mock_ros2():
    """Install all fake ROS2 modules into sys.modules."""

    # rclpy
    rclpy = types.ModuleType('rclpy')
    rclpy.ok = lambda: False
    rclpy.init = lambda **kw: None
    rclpy.create_node = lambda name: FakeNode(name)
    sys.modules['rclpy'] = rclpy

    # rclpy.callback_groups
    cb = types.ModuleType('rclpy.callback_groups')
    cb.ReentrantCallbackGroup = FakeCallbackGroup
    sys.modules['rclpy.callback_groups'] = cb

    # rclpy.executors
    ex = types.ModuleType('rclpy.executors')
    ex.MultiThreadedExecutor = FakeExecutor
    sys.modules['rclpy.executors'] = ex

    # decision_msgs
    decision_msgs = types.ModuleType('decision_msgs')
    decision_msgs.srv = _make_srv_module([
        'StartMap', 'StartCoverageTask', 'SaveMap',
        'Charging', 'GenerateCoveragePath', 'DeleteMap',
    ])
    decision_msgs.msg = _make_msg_module(['RobotStatus'])
    sys.modules['decision_msgs'] = decision_msgs
    sys.modules['decision_msgs.srv'] = decision_msgs.srv
    sys.modules['decision_msgs.msg'] = decision_msgs.msg

    # std_srvs
    std_srvs = types.ModuleType('std_srvs')
    std_srvs.srv = _make_srv_module(['SetBool', 'Trigger', 'Empty'])
    sys.modules['std_srvs'] = std_srvs
    sys.modules['std_srvs.srv'] = std_srvs.srv

    # novabot_msgs
    novabot_msgs = types.ModuleType('novabot_msgs')
    novabot_msgs.srv = _make_srv_module(['Common'])
    sys.modules['novabot_msgs'] = novabot_msgs
    sys.modules['novabot_msgs.srv'] = novabot_msgs.srv

    # mapping_msgs
    mapping_msgs = types.ModuleType('mapping_msgs')
    mapping_msgs.srv = _make_srv_module(['SetChargingPose', 'Recording', 'MappingControl', 'Mapping', 'GenerateEmptyMap'])
    sys.modules['mapping_msgs'] = mapping_msgs
    sys.modules['mapping_msgs.srv'] = mapping_msgs.srv

    # coverage_planner
    coverage_planner = types.ModuleType('coverage_planner')
    coverage_planner.srv = _make_srv_module(['CoveragePathsByFile'])
    sys.modules['coverage_planner'] = coverage_planner
    sys.modules['coverage_planner.srv'] = coverage_planner.srv

    # nav2_msgs
    nav2_msgs = types.ModuleType('nav2_msgs')
    nav2_msgs.srv = _make_srv_module(['LoadMap', 'SemanticMode'])
    sys.modules['nav2_msgs'] = nav2_msgs
    sys.modules['nav2_msgs.srv'] = nav2_msgs.srv

    # general_msgs
    general_msgs = types.ModuleType('general_msgs')
    general_msgs.srv = _make_srv_module(['SetUint8'])
    sys.modules['general_msgs'] = general_msgs
    sys.modules['general_msgs.srv'] = general_msgs.srv

    # std_msgs
    std_msgs = types.ModuleType('std_msgs')
    std_msgs.msg = _make_msg_module(['String', 'UInt8', 'Bool'])
    sys.modules['std_msgs'] = std_msgs
    sys.modules['std_msgs.msg'] = std_msgs.msg

    # geometry_msgs
    geometry_msgs = types.ModuleType('geometry_msgs')
    geometry_msgs.msg = _make_msg_module(['Twist', 'PoseStamped', 'Point', 'Pose'])
    sys.modules['geometry_msgs'] = geometry_msgs
    sys.modules['geometry_msgs.msg'] = geometry_msgs.msg

    # state_machine (used by service_handlers)
    state_machine = types.ModuleType('state_machine')
    for name in ['TaskMode', 'WorkStatus', 'RechargeStatus']:
        setattr(state_machine, name, type(name, (), {}))
    sys.modules['state_machine'] = state_machine

    print("[MOCK] ROS2 mock modules installed")
