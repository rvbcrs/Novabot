# Finish open_decision — 100% drop-in voor closed `robot_decision` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sluit het gat (~45%) tussen `mower/{robot_decision,decision_assistant,service_handlers,state_machine}.py` en de closed C++ `robot_decision` zodat de Python implementatie een 100% drop-in vervanger is — namespace-correct, alle services aanwezig, slip/loc auto-escalatie werkend, en alle stille bugs gefixt.

**Architecture:** Drie blokken. (1) Architectuur-fix: `DecisionAssistant` wordt eigen `Node` subclass op naamruimte `/decision_assistant`; actions worden hernoemd naar `slipping_escape` + `loc_recover_moving`. (2) Topics/services: `map_position` wordt publisher (Pose), `robot_out_working_zone` wordt `Bool`, `reset_data` + `decision_assistant/load_map` worden toegevoegd, `covered_path_json` daadwerkelijk gepubliceerd. (3) Gedrag: cov_mode 0/1/2 dispatch, slip/loc auto-escalatie via action clients, battery-hysteresis, save_map type:0→type:1 met 500ms delay, en alle resterende HIGH/MEDIUM/LOW gaps uit `research/documents/robot-decision-gap-analysis.md`.

**Tech Stack:** Python 3.10+, ROS 2 Galactic, `rclpy`, `decision_msgs`, `nav2_msgs`, `mapping_msgs`, `coverage_planner`, `geometry_msgs`. Testen: `pytest` voor pure logica + `ros2` CLI introspectie tegen de doelmaaier (LFIN1231000211 — zie `active-mower-device.md`). Bron: `/Users/rvbcrs/GitHub/Novabot/mower/`. Auth: `sshpass -p 'novabot' ssh root@<MOWER_IP>`.

**Source of truth tegen drift:** `research/documents/robot-decision-gap-analysis.md` (deze plan-bron) en `/tmp/closed_decision_inventory.md`. Wanneer een task zegt "verifieer met ros2", verifieer tegen de **gestockte C++ binary** — niet de Python tijdens werk.

**Pre-flight (uit te voeren vóór Task 1):**
- `git -C /Users/rvbcrs/GitHub/Novabot status` — verwacht clean working tree, anders branch + stash.
- `git checkout -b feat/open-decision-finish` — alle werk op deze branch, één PR per phase voorkeur.
- `sshpass -p 'novabot' -o StrictHostKeyChecking=no ssh root@<MOWER_IP> 'pgrep -fa robot_decision'` — CONFIRMEER welke binary draait. Stock C++ verwacht (zie memory `Open robot_decision (Python replacement) — NIET ACTIEF`). Live tests daaruit gebeuren door tijdelijk de Python te starten met `ROS_LOCALHOST_ONLY=1` parallel naast de C++ — namespace verschilt door §Phase 1, dus geen DDS conflict tijdens dev tot uiteindelijke cut-over.
- Lees `feedback_safety.md` (memory) — geen bewegingscommando's zonder bevestiging.

---

## Phase 0 — Test Harness & File Layout

Voor we ROS-runtime gedrag aanpassen leggen we een dunne testlaag neer zodat zoveel mogelijk pure logica buiten ROS getest wordt. Daarnaast maken we een nieuw bestand voor de losgekoppelde DecisionAssistant node.

### Task 0.1: Test scaffolding aanmaken

**Files:**
- Create: `mower/tests/__init__.py`
- Create: `mower/tests/conftest.py`
- Create: `mower/tests/fakes.py`
- Create: `mower/pytest.ini`
- Modify: `.gitignore` (add `mower/.pytest_cache/`)

- [ ] **Step 1: Maak conftest met FakeNode voor pure-logic tests**

```python
# mower/tests/conftest.py
"""Shared fixtures for non-ROS unit tests in mower/."""
import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.fakes import FakeNode  # noqa: E402


@pytest.fixture
def fake_node():
    return FakeNode()
```

- [ ] **Step 2: Maak FakeNode in fakes.py**

```python
# mower/tests/fakes.py
"""Lightweight fakes that mimic the rclpy Node surface area used by the
robot_decision modules. Pure-logic tests can use these without bringing up a
real DDS runtime."""
from __future__ import annotations
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class FakeLogger:
    records: list[tuple[str, str]] = field(default_factory=list)

    def info(self, msg: str): self.records.append(('info', msg))
    def warn(self, msg: str): self.records.append(('warn', msg))
    def warning(self, msg: str): self.records.append(('warn', msg))
    def error(self, msg: str): self.records.append(('error', msg))
    def debug(self, msg: str): self.records.append(('debug', msg))


@dataclass
class FakeParameter:
    value: Any


@dataclass
class FakePublisher:
    topic: str
    msgs: list[Any] = field(default_factory=list)

    def publish(self, msg):
        self.msgs.append(msg)


@dataclass
class FakeNode:
    parameters: dict[str, Any] = field(default_factory=dict)
    publishers: dict[str, FakePublisher] = field(default_factory=dict)
    services: dict[str, Callable] = field(default_factory=dict)
    subscriptions: dict[str, list[Callable]] = field(
        default_factory=lambda: defaultdict(list))
    logger: FakeLogger = field(default_factory=FakeLogger)

    def get_logger(self):
        return self.logger

    def declare_parameter(self, name, default):
        self.parameters.setdefault(name, default)

    def get_parameter(self, name):
        return FakeParameter(self.parameters[name])

    def set_parameter_value(self, name, value):
        self.parameters[name] = value

    def create_publisher(self, _msg_type, topic, _qos):
        pub = self.publishers.setdefault(topic, FakePublisher(topic))
        return pub
```

- [ ] **Step 3: Pytest config**

```ini
# mower/pytest.ini
[pytest]
testpaths = tests
python_files = test_*.py
addopts = -ra --strict-markers
filterwarnings =
    ignore::DeprecationWarning
```

- [ ] **Step 4: Verify scaffolding loads**

Run: `cd /Users/rvbcrs/GitHub/Novabot/mower && python -m pytest --collect-only -q`
Expected: `0 tests collected` (geen tests yet) zonder fouten.

- [ ] **Step 5: Commit**

```bash
git add mower/tests mower/pytest.ini .gitignore
git commit -m "test: scaffold pytest harness for open robot_decision modules"
```

### Task 0.2: ros2-runtime smoke fixture op real mower

**Files:**
- Create: `mower/tests/runtime/README.md`
- Create: `mower/tests/runtime/run_smoke.sh`

- [ ] **Step 1: Documenteer mower-side smoke**

```markdown
<!-- mower/tests/runtime/README.md -->
# Runtime tests on the mower

Pure-logic tests run anywhere via `pytest`. ROS-runtime tests require the
mower because rclpy DDS discovery needs the live `chassis_node`,
`coverage_planner_server`, etc.

Each task that needs runtime verification provides a `ros2 ...` command. Run
it from an SSH session:

```bash
sshpass -p 'novabot' ssh root@<MOWER_IP>
ROS_LOCALHOST_ONLY=1 ros2 service list | grep robot_decision
```

`run_smoke.sh` collects the high-signal ones in a single pass.
```

- [ ] **Step 2: Smoke script**

```bash
#!/usr/bin/env bash
# mower/tests/runtime/run_smoke.sh — copy to /tmp on mower and run.
set -euo pipefail
export ROS_LOCALHOST_ONLY=1
. /opt/ros/galactic/setup.bash 2>/dev/null || true

echo '=== service servers (expect 19) ==='
ros2 service list | grep -E '(/robot_decision/|/decision_assistant/)' | sort

echo '=== action servers ==='
ros2 action list | grep -E '(/robot_decision|/decision_assistant)' | sort

echo '=== topic types (sanity) ==='
for t in /robot_decision/map_position /decision_assistant/robot_out_working_zone; do
  echo "--- $t"
  ros2 topic info "$t" -v || true
done
```

- [ ] **Step 3: Permissions + commit**

```bash
chmod +x mower/tests/runtime/run_smoke.sh
git add mower/tests/runtime
git commit -m "test: runtime smoke harness for ros2 introspection"
```

---

## Phase 1 — Architectural fix: DecisionAssistant als eigen ROS node

Closed binary draait `robot_decision` en `decision_assistant` als losse nodes met aparte naamruimtes. Open implementatie heeft beide op één node, waardoor de actions onder `/robot_decision/` hangen. nav2/coverage_planner zoeken `/decision_assistant/slipping_escape` + `/decision_assistant/loc_recover_moving` en vinden die niet → mower stalt op slip.

### Task 1.1: Test voor DecisionAssistant standalone node-bewustzijn

**Files:**
- Create: `mower/tests/test_decision_assistant_standalone.py`

- [ ] **Step 1: Schrijf falende test**

```python
# mower/tests/test_decision_assistant_standalone.py
"""DecisionAssistant must own its own ROS node so it lives in the
/decision_assistant namespace. The decoupling test only checks structure: the
class accepts a 'host_node' object for state queries and creates its action
servers on its OWN node, NOT on host_node."""
import importlib
import inspect


def test_decision_assistant_takes_host_node_and_owns_self_node():
    mod = importlib.import_module('decision_assistant')
    sig = inspect.signature(mod.DecisionAssistant.__init__)
    assert 'host_node' in sig.parameters, (
        'DecisionAssistant.__init__ must accept host_node (the robot_decision '
        'node) so it can read .x, .y, .theta, .task_mode without sharing the '
        'same ROS node.')


def test_decision_assistant_node_is_a_node_subclass():
    mod = importlib.import_module('decision_assistant')
    from rclpy.node import Node
    assert issubclass(mod.DecisionAssistant, Node), (
        'DecisionAssistant must subclass rclpy.node.Node so it can register '
        'itself with the executor on the /decision_assistant namespace.')
```

- [ ] **Step 2: Verify it fails**

Run: `cd /Users/rvbcrs/GitHub/Novabot/mower && python -m pytest tests/test_decision_assistant_standalone.py -v`
Expected: 2 failures (signature has `node`, not `host_node`; class is not a Node subclass).

### Task 1.2: Refactor DecisionAssistant — eigen Node + namespace

**Files:**
- Modify: `mower/decision_assistant.py:42-112`
- Modify: `mower/robot_decision.py:441` (`self.assistant = DecisionAssistant(self)` callsite)

- [ ] **Step 1: Klasdefinitie + ctor**

Replace `mower/decision_assistant.py:42-112` with:

```python
class DecisionAssistant(Node):
    """Owns the /decision_assistant namespace. Slip escape + localization
    recovery action servers live here so nav2/coverage_planner find them on
    their original ROS graph names (/decision_assistant/slipping_escape and
    /decision_assistant/loc_recover_moving), exactly like the closed C++
    binary.

    Reads pose/state from the host robot_decision node passed in as
    ``host_node``; never registers callbacks on that node.
    """

    def __init__(self, host_node):
        super().__init__('decision_assistant')
        self.host = host_node
        self._logger = self.get_logger()

        # ─── Slip detection state ───
        self._prev_x = 0.0
        self._prev_y = 0.0
        self._prev_theta = 0.0
        self._prev_odom_time = 0.0
        self._slip_count = 0
        self._slip_detected = False
        self._motor_current_threshold = 10.0  # A

        # ─── Escape / recover state ───
        self._escaping = False
        self._escape_goal_handle = None
        self._recovering = False
        self._recover_goal_handle = None

        # ─── Parameters (declared on THIS node) ───
        self.declare_parameter('escape_angular_vel', ESCAPE_ANGULAR_VEL)
        self.declare_parameter('escape_linear_vel', ESCAPE_LINEAR_VEL)
        self.declare_parameter('straight_slipping_dis_diff',
                               STRAIGHT_SLIP_DIS_DIFF)
        self.declare_parameter('rotate_slipping_yaw_diff',
                               ROTATE_SLIP_YAW_DIFF)
        self.declare_parameter('cannot_move_angular_diff',
                               CANNOT_MOVE_ANGULAR_DIFF)
        self.declare_parameter('cannot_move_linear_diff',
                               CANNOT_MOVE_LINEAR_DIFF)
        self.declare_parameter('loc_recover_confidence', 89)

        # ─── Callback group for actions ───
        from rclpy.callback_groups import ReentrantCallbackGroup
        self.action_cb_group = ReentrantCallbackGroup()

        from rclpy.qos import (
            QoSProfile, QoSReliabilityPolicy, QoSHistoryPolicy)
        reliable_qos = QoSProfile(
            reliability=QoSReliabilityPolicy.RELIABLE,
            history=QoSHistoryPolicy.KEEP_LAST, depth=10)

        # ─── Publishers (under /decision_assistant/) ───
        self.escape_pose_pub = self.create_publisher(
            PoseStamped, '/decision_assistant/escape_pose', reliable_qos)
        # NOTE: bool not uint8 — closed binary publishes Bool. Subscriber side
        # in robot_decision must match. See Task 2.4.
        from std_msgs.msg import Bool
        self.out_of_zone_pub = self.create_publisher(
            Bool, '/decision_assistant/robot_out_working_zone', reliable_qos)
        self.move_abnormal_pub = self.create_publisher(
            UInt8, '/decision_assistant/move_abnormal', reliable_qos)

        # ─── Action SERVERS (closed-binary names) ───
        self._slip_action_server = ActionServer(
            self, SlipEscaping, 'slipping_escape',
            execute_callback=self._execute_slip_escape,
            goal_callback=self._goal_cb,
            cancel_callback=self._cancel_cb,
            callback_group=self.action_cb_group)
        self._loc_recover_server = ActionServer(
            self, LocRecoverMoving, 'loc_recover_moving',
            execute_callback=self._execute_loc_recover,
            goal_callback=self._goal_cb,
            cancel_callback=self._cancel_cb,
            callback_group=self.action_cb_group)

        # ─── load_map service (closed exposes this for working-zone polygon) ───
        from nav2_msgs.srv import LoadMap
        self._loaded_map_url: str | None = None
        self._load_map_srv = self.create_service(
            LoadMap, '/decision_assistant/load_map',
            self._handle_load_map,
            callback_group=self.action_cb_group)

        self._logger.info(
            'DecisionAssistant node up: actions slipping_escape + '
            'loc_recover_moving on /decision_assistant')

    def _handle_load_map(self, request, response):
        self._loaded_map_url = request.map_url
        self._logger.info(
            f'load_map: cached map_url={request.map_url}')
        from nav2_msgs.srv import LoadMap as _L
        response.result = _L.Response.RESULT_SUCCESS
        return response
```

- [ ] **Step 2: Pas alle `self.node.<x>` referenties aan naar `self.host.<x>`**

Search-and-replace inside `mower/decision_assistant.py` (vanaf regel 124 tot eind file): vervang `self.node.` door `self.host.` (alleen waar het verwijst naar pose/state op de host). Eigen publishers blijven `self.<...>_pub`.

Specifiek deze locaties (gebruikt in slip/loc recover + checkers):
- `self.node.x` / `self.node.y` / `self.node.theta` → `self.host.x` / `.y` / `.theta`
- `self.node.cmd_vel_pub.publish(...)` → vervang volledig in Task 3.4 (cloud_move_cmd). Voor nu: `self.host.cmd_vel_pub.publish(...)` om de refactor klein te houden.
- `self.node.task_mode` → `self.host.task_mode`
- `self.node.loc_quality` → `self.host.loc_quality`
- `self.node._set_state(...)` → `self.host._set_state(...)`
- `self.node._cancel_active_actions()` → `self.host._cancel_active_actions()`
- `self.node.report_maybe_stuck(...)` → `self.host.report_maybe_stuck(...)`
- `self.node.work_status` → `self.host.work_status`
- `self.node._get_cpu_temp()` → `self.host._get_cpu_temp()`
- `self.node.boot_checks_done` → `self.host.boot_checks_done`
- `self.node.get_parameter(...)` (in slip/loc bodies) → `self.get_parameter(...)` (params zijn nu op assistant zelf)

- [ ] **Step 3: Update callsite in robot_decision**

Edit `mower/robot_decision.py:441`:

Old:
```python
        self.assistant = DecisionAssistant(self)
```

New:
```python
        self.assistant = DecisionAssistant(host_node=self)
```

Geen verdere wijziging — `_on_motor_current` (regel ~? in robot_decision.py) roept `self.assistant.on_motor_current(...)` op via host, dat blijft werken.

- [ ] **Step 4: Voeg assistant toe aan executor in main()**

Find `def main()` in `mower/robot_decision.py` (eind file). Voor `rclpy.spin(node, executor=executor)` moet de assistant ook geadded worden.

Patch (find via grep `executor.add_node`):

```python
    executor.add_node(node)
    executor.add_node(node.assistant)  # /decision_assistant namespace
    try:
        executor.spin()
    finally:
        node.assistant.destroy_node()
        node.destroy_node()
        rclpy.shutdown()
```

- [ ] **Step 5: Run unit tests**

Run: `cd /Users/rvbcrs/GitHub/Novabot/mower && python -m pytest tests/test_decision_assistant_standalone.py -v`
Expected: 2 PASS.

- [ ] **Step 6: Live verify (mower runtime)**

Push branch deploy via existing flow (`bash open_decision/deploy.sh` if applicable, else scp). On mower:

```bash
sshpass -p 'novabot' ssh root@<MOWER_IP> 'export ROS_LOCALHOST_ONLY=1; ros2 action list | grep -E "/decision_assistant"'
```

Expected output:
```
/decision_assistant/loc_recover_moving
/decision_assistant/slipping_escape
```

- [ ] **Step 7: Commit**

```bash
git add mower/decision_assistant.py mower/robot_decision.py
git commit -m "refactor(decision_assistant): own /decision_assistant ROS node + close-binary action names"
```

### Task 1.3: Test action client paths op host node

**Files:**
- Create: `mower/tests/test_assistant_action_client_paths.py`

- [ ] **Step 1: Falende test**

```python
# mower/tests/test_assistant_action_client_paths.py
"""Host node creates action clients to the assistant namespace, exact-match
the closed C++ binary so nav2/coverage_planner can drive them. We assert via
text inspection of robot_decision.py because the constructor does ROS work."""
from pathlib import Path

ROBOT_DECISION = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_main_node_has_slipping_escape_action_client():
    src = ROBOT_DECISION.read_text()
    assert "'/decision_assistant/slipping_escape'" in src, (
        'robot_decision must register an ActionClient to '
        '/decision_assistant/slipping_escape so it can auto-trigger slip '
        'escape (closed binary calls this from the main loop).')


def test_main_node_has_loc_recover_moving_action_client():
    src = ROBOT_DECISION.read_text()
    assert "'/decision_assistant/loc_recover_moving'" in src
```

- [ ] **Step 2: Verify FAIL**

Run: `python -m pytest tests/test_assistant_action_client_paths.py -v`
Expected: 2 FAIL (paths niet aanwezig).

### Task 1.4: Voeg action clients toe op host

**Files:**
- Modify: `mower/robot_decision.py:386-417` (action client block)

- [ ] **Step 1: Toevoegen na `auto_charging_client` block (~line 416)**

```python
        # ─── DecisionAssistant ACTION CLIENTS (Phase 1: auto-escalation) ───
        from decision_msgs.action import SlipEscaping, LocRecoverMoving
        self.slip_escape_client = ActionClient(
            self, SlipEscaping,
            '/decision_assistant/slipping_escape',
            callback_group=self.client_cb_group)
        self.loc_recover_client = ActionClient(
            self, LocRecoverMoving,
            '/decision_assistant/loc_recover_moving',
            callback_group=self.client_cb_group)
        self._slip_goal_handle = None
        self._loc_recover_goal_handle = None
```

- [ ] **Step 2: Pytest groen**

Run: `python -m pytest tests/test_assistant_action_client_paths.py -v`
Expected: 2 PASS.

- [ ] **Step 3: Commit**

```bash
git add mower/robot_decision.py mower/tests/test_assistant_action_client_paths.py
git commit -m "feat(robot_decision): add action clients for slip/loc recover on assistant"
```

---

## Phase 2 — Topics & message types

### Task 2.1: Test — `/robot_decision/map_position` is publisher, niet service

**Files:**
- Create: `mower/tests/test_map_position_topic.py`

- [ ] **Step 1: Falende test**

```python
# mower/tests/test_map_position_topic.py
"""Closed binary publishes /robot_decision/map_position as a continuous Pose
topic. Open exposed it as a Common service. Live tools (mqtt_node, dashboard)
expect a topic. Verify by code inspection."""
from pathlib import Path

ROBOT_DECISION = Path(__file__).resolve().parents[1] / 'robot_decision.py'
SVC_HANDLERS = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_map_position_publisher_exists():
    src = ROBOT_DECISION.read_text()
    assert (
        "create_publisher(Pose, '/robot_decision/map_position'" in src
        or "create_publisher(\n            Pose, '/robot_decision/map_position'" in src
    ), 'map_position must be a Pose publisher on robot_decision'


def test_map_position_service_removed():
    src = SVC_HANDLERS.read_text()
    assert "'/robot_decision/map_position'" not in src, (
        'map_position service must be removed; replaced by a publisher')
    assert '_handle_map_position' not in src
```

- [ ] **Step 2: Verify FAIL**

Run: `python -m pytest tests/test_map_position_topic.py -v`
Expected: 2 FAIL.

### Task 2.2: Implementeer publisher + verwijder service

**Files:**
- Modify: `mower/robot_decision.py:200-209` (publisher block)
- Modify: `mower/robot_decision.py:_publish_status` (publish each tick)
- Modify: `mower/service_handlers.py:706-712` (delete service)
- Modify: `mower/service_handlers.py:162-165` (remove service registration)
- Modify: `mower/service_handlers.py:64` (remove unused `Common` import)

- [ ] **Step 1: Voeg publisher toe**

In `mower/robot_decision.py`, na regel 209 (na `preview_path_pub`):

```python
        # /robot_decision/map_position — continuous Pose stream consumed by
        # mqtt_node + dashboard for live robot dot. Closed binary publishes
        # this; open used to expose it as a Common service which the dashboard
        # never polled.
        from geometry_msgs.msg import Pose
        self.map_position_pub = self.create_publisher(
            Pose, '/robot_decision/map_position', RELIABLE_QOS)
```

- [ ] **Step 2: Publish in `_publish_status`**

Find `_publish_status` (~robot_decision.py:2381). Voeg toe direct na het samenstellen van de RobotStatus message, vóór `self.status_pub.publish(msg)`:

```python
        # Live position for mqtt_node / dashboard
        from geometry_msgs.msg import Pose
        import math as _math
        pose = Pose()
        pose.position.x = float(self.x)
        pose.position.y = float(self.y)
        pose.position.z = 0.0
        # quaternion from yaw
        half = self.theta * 0.5
        pose.orientation.z = _math.sin(half)
        pose.orientation.w = _math.cos(half)
        self.map_position_pub.publish(pose)
```

- [ ] **Step 3: Verwijder service**

In `mower/service_handlers.py`:
- Regel 162-165: verwijder `# Map position` block + `n.create_service(...)`.
- Regel 706-712: verwijder `_handle_map_position` methode volledig.
- Regel 64: vervang `from novabot_msgs.srv import Common as NovabotCommon` door niets als het verder niet gebruikt wordt; verifieer `grep -n NovabotCommon mower/service_handlers.py` is empty.
- Regel 38 (docstring): verwijder `/robot_decision/map_position  (novabot_msgs/Common — kept for compatibility)` regel.
- Regel 167: pas log boodschap aan: `'Created 17 service servers for mqtt_node'` (van 18).

- [ ] **Step 4: Pytest groen**

Run: `python -m pytest tests/test_map_position_topic.py -v`
Expected: 2 PASS.

- [ ] **Step 5: Live runtime check**

```bash
sshpass -p 'novabot' ssh root@<MOWER_IP> 'export ROS_LOCALHOST_ONLY=1; ros2 topic info /robot_decision/map_position -v'
```

Expected: Type `geometry_msgs/msg/Pose`, publisher count 1.

- [ ] **Step 6: Commit**

```bash
git add mower/robot_decision.py mower/service_handlers.py mower/tests/test_map_position_topic.py
git commit -m "feat(robot_decision): publish map_position as Pose topic (closed-binary parity)"
```

### Task 2.3: Test — `robot_out_working_zone` is `Bool`

**Files:**
- Create: `mower/tests/test_out_of_zone_msg_type.py`

- [ ] **Step 1: Falende test**

```python
# mower/tests/test_out_of_zone_msg_type.py
from pathlib import Path

DA = Path(__file__).resolve().parents[1] / 'decision_assistant.py'


def test_out_of_zone_uses_bool_msg():
    src = DA.read_text()
    # publisher type
    assert "Bool, '/decision_assistant/robot_out_working_zone'" in src
    # negative — old UInt8 type gone
    assert "UInt8, '/decision_assistant/robot_out_working_zone'" not in src
```

- [ ] **Step 2: Verify**

Run: `python -m pytest tests/test_out_of_zone_msg_type.py -v`
Expected: PASS al door Phase 1 refactor (publisher omgezet naar Bool). Als FAIL, fix in `decision_assistant.py:91-92` zoals Phase 1 voorgeschreven.

### Task 2.4: Subscribe op `robot_out_working_zone` Bool in host

**Files:**
- Modify: `mower/robot_decision.py:225-251` (subscribers block)
- Modify: `mower/robot_decision.py` (callback method)

- [ ] **Step 1: Test eerst**

Create `mower/tests/test_out_of_zone_subscriber.py`:

```python
from pathlib import Path

ROBOT_DECISION = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_subscribes_to_bool_out_of_zone():
    src = ROBOT_DECISION.read_text()
    assert "'/decision_assistant/robot_out_working_zone'" in src
    # callback name registered
    assert '_on_out_of_zone' in src or '_on_robot_out_of_zone' in src
```

Run: expected FAIL.

- [ ] **Step 2: Implementeer**

In `mower/robot_decision.py`, na de `mapping_polygon` sub (regel ~250):

```python
        from std_msgs.msg import Bool
        self.create_subscription(
            Bool, '/decision_assistant/robot_out_working_zone',
            self._on_out_of_zone, RELIABLE_QOS)
```

Voeg methode toe (na `_on_mapping_polygon` of bij overige `_on_*` callbacks):

```python
    def _on_out_of_zone(self, msg):
        """Assistant signals robot is outside the working zone polygon. Trigger
        LocRecoverMoving with recover_type=1 (out-of-map). Closed binary does
        the same auto-escalation."""
        if not msg.data:
            return
        if self.task_mode != TaskMode.COVER:
            return
        if self.work_status == WorkStatus.ROBOT_OUT_OF_MAP_HANDLE:
            return  # already handling
        self._set_state(TaskMode.COVER, WorkStatus.ROBOT_OUT_OF_MAP_HANDLE)
        self.get_logger().warn(
            'Robot out of working zone — sending LocRecoverMoving goal')
        self._send_loc_recover_goal(recover_type=1)
```

`_send_loc_recover_goal` komt in Task 3.2.

- [ ] **Step 3: Test groen + commit**

```bash
python -m pytest tests/test_out_of_zone_subscriber.py -v
git add mower/robot_decision.py mower/tests/test_out_of_zone_subscriber.py
git commit -m "feat(robot_decision): subscribe to robot_out_working_zone Bool"
```

### Task 2.5: Reset_data service + clear_costmap action

**Files:**
- Modify: `mower/service_handlers.py:85-167` (registration block)
- Modify: `mower/service_handlers.py` (handler)

- [ ] **Step 1: Falende test**

Create `mower/tests/test_reset_data_service.py`:

```python
from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_reset_data_service_registered():
    src = SVC.read_text()
    assert "'/robot_decision/reset_data'" in src
    assert '_handle_reset_data' in src
```

Run: expected FAIL.

- [ ] **Step 2: Implementeer service + registratie**

Voeg in `_create_servers` (na `map_stop_record` SetBool block, ~line 114):

```python
        n.create_service(
            SetBool, '/robot_decision/reset_data',
            self._handle_reset_data, callback_group=cb)
```

Update log on regel 167: `'Created 18 service servers for mqtt_node'`. (Was 17 na Task 2.2; nu weer 18.)

Handler (plaats na `_handle_quit_mapping`, ergens vóór de Coverage block):

```python
    def _handle_reset_data(self, request, response):
        """Clear in-memory task counters/state after a fault. Closed binary
        logs 'Reset task data successfully!!!'. Without this MQTT clients
        cannot recover from latched faults."""
        self.log.info(
            f'SetBool: reset_data, data={request.data}')
        n = self.node
        n._cancel_active_actions()
        n.error_status = 0
        n.cov_ratio = 0.0
        n.cov_area = 0.0
        n.cov_work_time = 0.0
        n.current_map_ids = []
        n.request_map_ids = []
        n._set_state(TaskMode.FREE, WorkStatus.INIT_SUCCESS)
        response.success = True
        response.message = 'Reset task data successfully'
        return response
```

(Adjust attribute names to whatever the host node uses. Where attributes don't exist yet, leave the assignment guarded by `getattr` — bv. `if hasattr(n, 'error_status'): n.error_status = 0`.)

- [ ] **Step 3: Pytest + commit**

```bash
python -m pytest tests/test_reset_data_service.py -v
git add mower/service_handlers.py mower/tests/test_reset_data_service.py
git commit -m "feat(robot_decision): implement reset_data service for fault recovery"
```

### Task 2.6: covered_path_json — daadwerkelijk publishen

**Files:**
- Modify: `mower/robot_decision.py` (subscribe to coverage_planner topic)

- [ ] **Step 1: Test**

Create `mower/tests/test_covered_path_relay.py`:

```python
from pathlib import Path

R = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_subscribes_to_coverage_planner_covered_path_json():
    src = R.read_text()
    assert "'/coverage_planner_server/covered_path_json'" in src
    assert '_on_covered_path' in src or '_relay_covered_path' in src
```

Run: expected FAIL.

- [ ] **Step 2: Implementeer relay**

In subscribers block (`mower/robot_decision.py:225-251`):

```python
        self.create_subscription(
            String, '/coverage_planner_server/covered_path_json',
            self._on_covered_path, RELIABLE_QOS)
```

Methode:

```python
    def _on_covered_path(self, msg):
        """Forward coverage_planner_server's covered_path_json to mqtt_node's
        expected /robot_decision/covered_path_json topic. Closed binary does
        the same relay."""
        self.covered_path_pub.publish(msg)
```

- [ ] **Step 3: Pytest + commit**

```bash
python -m pytest tests/test_covered_path_relay.py -v
git add mower/robot_decision.py mower/tests/test_covered_path_relay.py
git commit -m "feat(robot_decision): relay covered_path_json from coverage_planner_server"
```

---

## Phase 3 — Slip / Loc auto-escalatie (BLOCKERS)

### Task 3.1: Test slip detectie escaleert via action client

**Files:**
- Create: `mower/tests/test_slip_action_trigger.py`

- [ ] **Step 1: Falende test**

```python
# mower/tests/test_slip_action_trigger.py
"""When _on_motor_current detects slip, host node must SEND a SlipEscaping
goal (not just publish move_abnormal). We test this by reading source — full
integration verifies via runtime smoke."""
from pathlib import Path

DA = Path(__file__).resolve().parents[1] / 'decision_assistant.py'
RD = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_slip_detection_calls_send_slip_goal():
    src = DA.read_text()
    assert '_send_slip_goal' in src or 'slip_escape_client.send_goal' in src, (
        'On slip detection the assistant must trigger a SlipEscaping goal '
        'on the host\'s slip_escape_client (auto-escalation).')


def test_send_slip_goal_helper_exists_on_host():
    src = RD.read_text()
    assert 'def _send_slip_goal' in src or 'slip_escape_client.send_goal_async' in src
```

- [ ] **Step 2: Verify FAIL**

Run: `python -m pytest tests/test_slip_action_trigger.py -v`

### Task 3.2: Implementeer host-side action goal helpers

**Files:**
- Modify: `mower/robot_decision.py` (helper methods)

- [ ] **Step 1: Voeg helper methodes toe**

Plaats in `mower/robot_decision.py` direct na `_on_out_of_zone`:

```python
    def _send_slip_goal(self, max_escape_time: float = 10.0):
        """Send SlipEscaping goal to /decision_assistant/slipping_escape.
        Reentrant-safe: if a goal is already running we bail out."""
        if self._slip_goal_handle is not None:
            return
        if not self.slip_escape_client.wait_for_server(timeout_sec=1.0):
            self.get_logger().warn(
                'slipping_escape action server not available')
            return
        from decision_msgs.action import SlipEscaping
        goal = SlipEscaping.Goal()
        goal.max_escape_time = float(max_escape_time)

        def _on_response(future):
            handle = future.result()
            if not handle or not handle.accepted:
                self.get_logger().warn('slipping_escape goal rejected')
                self._slip_goal_handle = None
                return
            self._slip_goal_handle = handle
            handle.get_result_async().add_done_callback(_on_result)

        def _on_result(future):
            res = future.result()
            self._slip_goal_handle = None
            self.get_logger().info(
                f'slipping_escape result: {getattr(res, "result", None)}')

        self.slip_escape_client.send_goal_async(goal).add_done_callback(_on_response)

    def _send_loc_recover_goal(self, recover_type: int = 0,
                               max_time: float = 30.0):
        if self._loc_recover_goal_handle is not None:
            return
        if not self.loc_recover_client.wait_for_server(timeout_sec=1.0):
            self.get_logger().warn(
                'loc_recover_moving action server not available')
            return
        from decision_msgs.action import LocRecoverMoving
        goal = LocRecoverMoving.Goal()
        goal.max_time = float(max_time)
        goal.recover_type = int(recover_type)

        def _on_response(future):
            handle = future.result()
            if not handle or not handle.accepted:
                self.get_logger().warn('loc_recover_moving goal rejected')
                self._loc_recover_goal_handle = None
                return
            self._loc_recover_goal_handle = handle
            handle.get_result_async().add_done_callback(_on_result)

        def _on_result(future):
            res = future.result()
            self._loc_recover_goal_handle = None
            self.get_logger().info(
                f'loc_recover_moving result: {getattr(res, "result", None)}')

        self.loc_recover_client.send_goal_async(goal).add_done_callback(_on_response)
```

- [ ] **Step 2: Roep `_send_slip_goal` aan vanuit assistant slip detect**

Edit `mower/decision_assistant.py:336-344` (in `on_motor_current`, `if avg_current > current_thresh: ... if self._slip_count >= 3 and not self._slip_detected:` block):

Replace:

```python
                    self._slip_detected = True
                    self._logger.warn(
                        f'Slip detected! current={avg_current:.1f}A '
                        f'dist={dist:.3f}m dtheta={dtheta:.3f}rad')

                    # Publish abnormal movement
                    msg = UInt8()
                    msg.data = 1
                    self.move_abnormal_pub.publish(msg)

                    # Set work status
                    if self.host.task_mode == TaskMode.COVER:
                        self.host._set_state(
                            TaskMode.COVER, WorkStatus.SLIPPING_HANDLE)
```

With:

```python
                    self._slip_detected = True
                    self._logger.warn(
                        f'Slip detected! current={avg_current:.1f}A '
                        f'dist={dist:.3f}m dtheta={dtheta:.3f}rad')
                    msg = UInt8()
                    msg.data = 1
                    self.move_abnormal_pub.publish(msg)
                    if self.host.task_mode == TaskMode.COVER:
                        self.host._set_state(
                            TaskMode.COVER, WorkStatus.SLIPPING_HANDLE)
                        # Auto-escalate: send SlipEscaping goal so coverage
                        # actually recovers (closed-binary parity).
                        self.host._send_slip_goal(max_escape_time=15.0)
```

- [ ] **Step 3: Pytest groen + commit**

```bash
python -m pytest tests/test_slip_action_trigger.py -v
git add mower/robot_decision.py mower/decision_assistant.py mower/tests/test_slip_action_trigger.py
git commit -m "feat(robot_decision): auto-escalate slip detection to SlipEscaping action"
```

### Task 3.3: Loc-quality drop → loc_recover goal

**Files:**
- Modify: `mower/decision_assistant.py:436-451` (`check_localization`)

- [ ] **Step 1: Test**

Create `mower/tests/test_loc_recover_trigger.py`:

```python
from pathlib import Path

DA = Path(__file__).resolve().parents[1] / 'decision_assistant.py'


def test_check_localization_calls_loc_recover():
    src = DA.read_text()
    # in check_localization the host method must be called
    assert '_send_loc_recover_goal' in src
```

- [ ] **Step 2: Implementeer**

Edit `mower/decision_assistant.py:436-451`:

```python
    def check_localization(self):
        n = self.host
        if n.task_mode != TaskMode.COVER:
            return
        if not n.get_parameter('enable_loc_recover').value:
            return
        loc_cover = n.get_parameter('loc_cover_confidence').value
        if 0 < n.loc_quality < loc_cover:
            self._logger.warn(
                f'Localization quality low during coverage: '
                f'{n.loc_quality} < {loc_cover}')
            n._set_state(TaskMode.COVER, WorkStatus.LOC_ERROR_HANDLE)
            n._send_loc_recover_goal(recover_type=0, max_time=30.0)
```

- [ ] **Step 3: Pytest groen + commit**

```bash
python -m pytest tests/test_loc_recover_trigger.py -v
git add mower/decision_assistant.py mower/tests/test_loc_recover_trigger.py
git commit -m "feat(decision_assistant): auto-escalate loc-quality drop to LocRecoverMoving"
```

### Task 3.4: Slip / loc-recover wheels — `cloud_move_cmd` ipv `cmd_vel`

CChassisControl gates `cmd_vel` (zie memory `feedback_safety.md`). Slip + loc recovery moeten via `cloud_move_cmd` om de wielen daadwerkelijk te bewegen.

**Files:**
- Modify: `mower/decision_assistant.py:179, 259, 500` (twist publishes)

- [ ] **Step 1: Test**

Create `mower/tests/test_assistant_uses_cloud_move.py`:

```python
from pathlib import Path

DA = Path(__file__).resolve().parents[1] / 'decision_assistant.py'


def test_no_direct_cmd_vel_publish_inside_recover_paths():
    src = DA.read_text()
    # _execute_slip_escape and _execute_loc_recover must NOT call cmd_vel_pub
    assert 'cmd_vel_pub.publish' not in src, (
        'Slip + loc recovery must publish CloudMoveCmd, not Twist on cmd_vel '
        '(CChassisControl gates cmd_vel — see memory feedback_safety.md).')
    assert '_publish_cloud_move' in src
```

Run: expected FAIL.

- [ ] **Step 2: Helper toevoegen**

In `mower/decision_assistant.py` (klassebody, na `_stop_motors`):

```python
    def _publish_cloud_move(self, linear_x: float, angular_z: float):
        """Slip / loc-recover bypass: cmd_vel is gated by CChassisControl, so
        recovery commands MUST go through cloud_move_cmd which is the
        unobstructed path. The closed binary uses the same path."""
        from novabot_msgs.msg import CloudMoveCmd
        cmd = CloudMoveCmd()
        cmd.x_w = float(linear_x)
        cmd.y_v = float(angular_z)
        cmd.z_g = 0.0
        self.host.cloud_move_pub.publish(cmd)

    def _stop_motors(self):
        """Send zero velocity command (cloud_move_cmd, not cmd_vel)."""
        self._publish_cloud_move(0.0, 0.0)
```

- [ ] **Step 3: Vervang cmd_vel publishes**

In `_execute_slip_escape` (regel ~169-179): vervang het opbouwen van `Twist` + `cmd_vel_pub.publish` door:

```python
            if phase == 0:
                lin, ang = -escape_vel, 0.0
            else:
                lin, ang = 0.0, escape_ang
            self._publish_cloud_move(lin, ang)
            time.sleep(0.1)
```

In `_execute_loc_recover` (regel ~249-260):

```python
            if recover_type == 0:
                self._publish_cloud_move(0.2, 0.5)
            else:
                self._publish_cloud_move(-0.2, 0.0)
            time.sleep(0.2)
```

Verwijder ongebruikte `from geometry_msgs.msg import Twist` als die nergens meer staat.

- [ ] **Step 4: Pytest groen + commit**

```bash
python -m pytest tests/test_assistant_uses_cloud_move.py -v
git add mower/decision_assistant.py mower/tests/test_assistant_uses_cloud_move.py
git commit -m "fix(decision_assistant): publish CloudMoveCmd for slip/loc recovery (bypass CChassisControl gate)"
```

---

## Phase 4 — Coverage task BLOCKERS (cov_mode 0/1/2)

### Task 4.1: Test cov_mode dispatch coverage

**Files:**
- Create: `mower/tests/test_start_cov_task_dispatch.py`

- [ ] **Step 1: Test**

```python
# mower/tests/test_start_cov_task_dispatch.py
"""start_cov_task must distinguish cov_mode:
  0 = full coverage (default)
  1 = SPECIFIED_AREA — polygon_area from request
  2 = BOUNDARY_COV — only_edge_mode=True

We assert via source inspection that all three branches exist.
"""
from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_cov_mode_0_branch_exists():
    src = SVC.read_text()
    assert 'cov_mode == 0' in src or 'cov_mode in (0' in src


def test_cov_mode_1_specified_area_branch_exists():
    src = SVC.read_text()
    assert 'cov_mode == 1' in src
    assert 'polygon_area' in src


def test_cov_mode_2_only_edge_mode_set_true():
    src = SVC.read_text()
    assert 'only_edge_mode=True' in src or 'only_edge_mode = True' in src
```

Run: expected 3 FAIL (alleen cov_mode==2 branch impliciet).

### Task 4.2: Refactor `_handle_start_cov_task`

**Files:**
- Modify: `mower/service_handlers.py:498-557`
- Modify: `mower/robot_decision.py` `start_coverage(...)` method (add `polygon_area` + `only_edge_mode` parameters)

- [ ] **Step 1: Update host's `start_coverage`**

Locate `def start_coverage(...)` in `mower/robot_decision.py` (use `grep -n "def start_coverage" mower/robot_decision.py`).

Add new optional parameters:

```python
    def start_coverage(self, *, map_yaml: str, blade_height: int,
                       include_edge: bool = False,
                       only_edge_mode: bool = False,
                       polygon_area=None,
                       specify_direction: bool = False,
                       cov_direction: float = 0.0,
                       perception_level: int = 0):
        ...
```

Inside, when constructing the `CoveragePathsByFile.Request` (search for `CoveragePathsByFile.Request()`), set:

```python
        req = CoveragePathsByFile.Request()
        req.map_yaml = map_yaml
        req.include_edge = include_edge
        req.only_edge_mode = only_edge_mode
        if polygon_area is not None:
            req.polygon_area = polygon_area
        req.specify_direction = specify_direction
        req.cov_direction = cov_direction
```

(Field names confirmed against `coverage_planner.srv.CoveragePathsByFile`. If `polygon_area` is missing, fall back to `req.polygon = polygon_area` — re-grep `/opt/ros/galactic/share/coverage_planner/srv/CoveragePathsByFile.srv` on the mower if uncertain.)

- [ ] **Step 2: Refactor handler**

Replace `_handle_start_cov_task` body (`mower/service_handlers.py:498-557`):

```python
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
            f'map_ids={list(request.map_ids)}, '
            f'blade_heights={list(request.blade_heights)}, '
            f'direction={request.cov_direction}, '
            f'perception={request.perception_level}, '
            f'polygon_area_pts={len(getattr(request, "polygon_area", []) or [])}')

        n.request_map_ids = list(request.map_ids)
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
        if not result or getattr(result, 'result',
                                  LoadMap.Response.RESULT_UNDEFINED_FAILURE
                                  ) != LoadMap.Response.RESULT_SUCCESS:
            self.log.error(
                'Loading map failed, please check map file exists!!!!')
            n._set_state(TaskMode.STOP, WorkStatus.ERROR_LOAD_MAP)
            response.result = 0
            return response

        # Push polygon to assistant for working-zone tracking
        if hasattr(n, 'cli_assistant_load_map'):
            n.cli_assistant_load_map.call_async(req_map)

        cov_mode = int(request.cov_mode)
        only_edge = (cov_mode == 2)
        include_edge = only_edge  # closed-binary correlation
        polygon_area = (
            list(request.polygon_area)
            if cov_mode == 1 and getattr(request, 'polygon_area', None)
            else None)
        if cov_mode == 1 and polygon_area is None:
            self.log.error(
                'cov_mode=1 (SPECIFIED_AREA) but no polygon_area provided')
            response.result = 0
            return response
        # Boundary mode coupling (memory edge-cut-ntcp.md): edge-cut goes via
        # NTCP not via cov_mode=2 in production firmware, but coverage_planner
        # supports only_edge_mode in case the path is taken explicitly.

        ok = n.start_coverage(
            map_yaml=map_yaml,
            blade_height=blade_height,
            include_edge=include_edge,
            only_edge_mode=only_edge,
            polygon_area=polygon_area,
            specify_direction=bool(request.cov_direction > 0),
            cov_direction=request.cov_direction,
            perception_level=request.perception_level,
        )

        planned_path_file = n.get_parameter('planned_path_file').value
        n.publish_path_json(
            f'{planned_path_file}/planned_path.json', n.planned_path_pub)

        response.result = ok
        return response
```

- [ ] **Step 3: Add `cli_assistant_load_map` client on host**

In `mower/robot_decision.py` (in service-clients block, ~regel 286):

```python
        self.cli_assistant_load_map = self.create_client(
            LoadMap, '/decision_assistant/load_map',
            callback_group=self.client_cb_group)
```

- [ ] **Step 4: Pytest + commit**

```bash
python -m pytest tests/test_start_cov_task_dispatch.py -v
git add mower/service_handlers.py mower/robot_decision.py mower/tests/test_start_cov_task_dispatch.py
git commit -m "feat(robot_decision): cov_mode 0/1/2 dispatch + force map reload + WARN_REPEATED_START"
```

### Task 4.3: stop_task pause/resume semantics

**Files:**
- Modify: `mower/service_handlers.py:412-426`

- [ ] **Step 1: Test**

Create `mower/tests/test_stop_task_pause_resume.py`:

```python
from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_stop_task_distinguishes_pause_and_resume():
    src = SVC.read_text()
    assert 'request.data' in src.split('def _handle_stop_task')[1].split('def ')[0]
    # both branches must exist
    body = src.split('def _handle_stop_task')[1].split('def ')[0]
    assert 'cov continue' in body or 'resume' in body.lower()
    assert 'USER_STOP' in body
```

Run: expected FAIL.

- [ ] **Step 2: Implementeer**

Replace handler:

```python
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
        # Re-fire the last request via _handle_start_cov_task
        return self._handle_start_cov_task(n._last_cov_request, response)
```

Note: requires storing the original request. In `_handle_start_cov_task` add at the top:

```python
        n._last_cov_request = request
```

- [ ] **Step 3: Pytest + commit**

```bash
python -m pytest tests/test_stop_task_pause_resume.py -v
git add mower/service_handlers.py mower/tests/test_stop_task_pause_resume.py
git commit -m "feat(robot_decision): stop_task pause vs resume semantics"
```

---

## Phase 5 — HIGH severity bug fixes

### Task 5.1: Fix start_assistant_mapping NameError

**Files:**
- Modify: `mower/service_handlers.py:373-380`

- [ ] **Step 1: Test**

Create `mower/tests/test_assistant_mapping_log_safe.py`:

```python
from pathlib import Path
import ast
import re

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_run_assistant_mapping_does_not_reference_undefined_dist():
    src = SVC.read_text()
    method = re.search(
        r'def _run_assistant_mapping[^\n]*\n(.*?)(?=\n    def |\nclass )',
        src, re.DOTALL).group(1)
    assert 'dist_from_charger' not in method, (
        'dist_from_charger is undefined in this scope; logging it raises '
        'NameError every time start_assistant_mapping is called from the '
        'charger.')
    # ensure the log line still mentions on-charger context so we don\'t lose info
    assert 'is_on_charger' in method
```

Run: expected FAIL.

- [ ] **Step 2: Fix**

Edit `mower/service_handlers.py:374-377`:

Old:
```python
        if needs_undock:
            self.log.info(
                f'start_assistant_mapping: undocking first '
                f'(is_on_charger={n.is_on_charger}, dist={dist_from_charger:.2f}m)')
```

New:
```python
        if needs_undock:
            self.log.info(
                f'start_assistant_mapping: undocking first '
                f'(is_on_charger={n.is_on_charger})')
```

- [ ] **Step 3: Pytest + commit**

```bash
python -m pytest tests/test_assistant_mapping_log_safe.py -v
git add mower/service_handlers.py mower/tests/test_assistant_mapping_log_safe.py
git commit -m "fix(service_handlers): drop undefined dist_from_charger log (NameError on charger)"
```

### Task 5.2: Drop duplicate battery_message subscription

**Files:**
- Modify: `mower/robot_decision.py:226-231`

- [ ] **Step 1: Test**

Create `mower/tests/test_no_dup_battery_subscription.py`:

```python
from pathlib import Path

R = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_battery_message_subscribed_exactly_once():
    src = R.read_text()
    # match `'battery_message'` appearances within create_subscription
    import re
    matches = re.findall(
        r"create_subscription\([^)]*'battery_message'", src)
    assert len(matches) == 1, (
        f'battery_message must be subscribed once (was {len(matches)}). '
        'Two subscriptions cause every battery message to fire _on_battery '
        'twice — low-battery cancellation triggers twice.')
```

Run: expected FAIL.

- [ ] **Step 2: Verwijder duplicaat**

Edit `mower/robot_decision.py:226-231`. Houd alleen de SENSOR_QOS variant:

```python
        self.create_subscription(
            ChassisBatteryMessage, 'battery_message',
            self._on_battery, SENSOR_QOS)
```

Verwijder de tweede `RELIABLE_QOS` subscription (was regel 229-231).

- [ ] **Step 3: Pytest + commit**

```bash
python -m pytest tests/test_no_dup_battery_subscription.py -v
git add mower/robot_decision.py mower/tests/test_no_dup_battery_subscription.py
git commit -m "fix(robot_decision): drop duplicate battery_message subscription"
```

### Task 5.3: save_map — 500ms delay + non-hardcoded parent

**Files:**
- Modify: `mower/service_handlers.py:561-604`

- [ ] **Step 1: Test**

Create `mower/tests/test_save_map_flow.py`:

```python
from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_save_map_uses_request_map_name_not_hardcoded():
    src = SVC.read_text()
    body = src.split('def _handle_save_map')[1].split('def ')[0]
    # parent name must come from request, not literal 'home0'
    assert "map_name = 'home0'" not in body or 'request.' in body, (
        "save_map must not hardcode parent='home0' — use request fields.")


def test_save_map_has_500ms_delay_between_type0_and_type1():
    src = SVC.read_text()
    body = src.split('def _handle_save_map')[1].split('def ')[0]
    assert '0.5' in body and 'time.sleep' in body, (
        'MAPPING-FLOW.md requires ~500ms gap between save_map type:0 and '
        'type:1 so map.yaml can be created.')
```

Run: expected FAIL.

- [ ] **Step 2: Fix handler**

Replace `_handle_save_map` (`mower/service_handlers.py:561`):

```python
    def _handle_save_map(self, request, response):
        """Save map (decision_msgs/SaveMap). Closed binary flow:
          1. Stop recording
          2. Save charging pose
          3. Generate sub-map (type=0)
          4. Wait ~500ms (map.yaml creation per docs/reference/MAPPING-FLOW.md)
          5. Generate total/whole map (type=1)
        """
        self.log.info(
            f'Save map request: type={request.type}, '
            f'mapname={request.mapname}, parent={request.map_file_name}')
        n = self.node
        n._set_state(TaskMode.MAPPING, WorkStatus.MAPPING_STOP_RECORD)
        self._stop_recording()

        parent_name = request.map_file_name or 'home0'
        child_name = request.mapname or 'map0'
        self._save_charging_pose_internal(parent_name, child_name)

        ok, error_code = self._generate_map(0)  # sub-map
        if ok:
            time.sleep(0.5)  # MAPPING-FLOW: 500ms before total map generation
            ok, error_code = self._generate_map(1)
        if ok:
            n.save_utm_origin()
            self.log.info('Mapping: Map saved successfully!')
            n._set_state(TaskMode.FREE, WorkStatus.INIT_SUCCESS)
        else:
            self.log.error(
                f'Mapping: Map save failed (error_code={error_code})')

        response.result = 1 if ok else 0
        response.data = ''
        response.error_code = error_code
        return response
```

- [ ] **Step 3: Pytest + commit**

```bash
python -m pytest tests/test_save_map_flow.py -v
git add mower/service_handlers.py mower/tests/test_save_map_flow.py
git commit -m "fix(service_handlers): save_map honors request.map_file_name + 500ms delay"
```

### Task 5.4: delete_map — forward maptype + DELETE_* states

**Files:**
- Modify: `mower/service_handlers.py:661-681`

- [ ] **Step 1: Test**

Create `mower/tests/test_delete_map.py`:

```python
from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_delete_map_uses_request_maptype():
    body = SVC.read_text().split('def _handle_delete_map')[1].split('def ')[0]
    assert 'request.maptype' in body
    assert 'req.type = 3' not in body or 'request.maptype' in body  # not hardcoded


def test_delete_map_transitions_through_delete_states():
    body = SVC.read_text().split('def _handle_delete_map')[1].split('def ')[0]
    assert 'DELETE_CHILD_MAP' in body
    assert 'DELETE_OBSTACLE' in body
    assert 'DELETE_UINICOM' in body  # closed binary keeps the typo
```

Run: expected FAIL.

- [ ] **Step 2: Fix**

Replace `_handle_delete_map`:

```python
    def _handle_delete_map(self, request, response):
        """Delete sub-map (1) / obstacle (2) / unicom (3) by forwarding
        request.maptype to /novabot_mapping/mapping_control. Closed binary
        transitions through DELETE_CHILD_MAP / DELETE_OBSTACLE /
        DELETE_UINICOM (spelling preserved to mirror C++ enum)."""
        self.log.info(
            f'DeleteMap: maptype={request.maptype}, '
            f'mapname={request.mapname}, parent={request.map_file_name}')
        n = self.node
        state_map = {
            1: WorkStatus.DELETE_CHILD_MAP,
            2: WorkStatus.DELETE_OBSTACLE,
            3: WorkStatus.DELETE_UINICOM,
        }
        target_state = state_map.get(int(request.maptype))
        if target_state is not None:
            n._set_state(TaskMode.MAPPING, target_state)

        req = MappingControlSrv.Request()
        req.map_file_name = request.map_file_name or 'home0'
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
```

Pre-condition: `state_machine.WorkStatus` enum **must contain** `DELETE_CHILD_MAP`, `DELETE_OBSTACLE`, `DELETE_UINICOM`. Verify:

```bash
grep -nE 'DELETE_CHILD_MAP|DELETE_OBSTACLE|DELETE_UINICOM' mower/state_machine.py
```

If missing, add them first (this is its own task — Task 5.4b).

- [ ] **Step 2b: Add missing WorkStatus values if needed**

Edit `mower/state_machine.py` `WorkStatus` enum, append (use exact numerical values from `/tmp/closed_decision_inventory.md` — likely 0xA0..0xA2):

```python
    DELETE_CHILD_MAP = 0xA0
    DELETE_OBSTACLE = 0xA1
    DELETE_UINICOM = 0xA2  # spelling matches closed binary enum
```

(Verify exact values via `grep -A 200 'enum WorkStatus' /tmp/closed_decision_inventory.md` if available.)

- [ ] **Step 3: Pytest + commit**

```bash
python -m pytest tests/test_delete_map.py -v
git add mower/service_handlers.py mower/state_machine.py mower/tests/test_delete_map.py
git commit -m "feat(robot_decision): delete_map forwards maptype + transitions through DELETE_* states"
```

### Task 5.5: save_charging_pose propagate map_to_charging_dis

**Files:**
- Modify: `mower/service_handlers.py:685-702`
- Modify: `mower/service_handlers.py:232-248` (`_save_charging_pose_internal` — return distance)

- [ ] **Step 1: Test**

Create `mower/tests/test_charging_pose_distance.py`:

```python
from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_save_charging_pose_propagates_real_distance():
    body = SVC.read_text().split(
        'def _handle_save_charging_pose')[1].split('def ')[0]
    assert 'response.map_to_charging_dis = 0.0' not in body, (
        'Closed binary returns the upstream distance — must not hardcode 0.0')
    assert 'map_to_charging_dis' in body
```

Run: expected FAIL.

- [ ] **Step 2: Update internal helper to return tuple**

Edit `_save_charging_pose_internal`:

```python
    def _save_charging_pose_internal(self, map_name='home0',
                                     child_name='map0'):
        n = self.node
        req = SetChargingPoseSrv.Request()
        req.control_mode = 1
        req.map_file_name = map_name
        req.child_map_file_name = child_name
        result = self._call_service(n.cli_set_charging_pose, req)
        if result and result.result:
            dist = float(getattr(result, 'map_to_charging_dis', 0.0))
            self.log.info(
                f'Mapping: Saved charging pose, distance={dist:.2f}m')
            return True, dist
        self.log.warn('Mapping: Save charging pose failed')
        return False, 0.0
```

Update internal callers (`_handle_save_map`) to unpack tuple:

```python
        ok_pose, _ = self._save_charging_pose_internal(parent_name, child_name)
```

- [ ] **Step 3: Update `_handle_save_charging_pose`**

```python
    def _handle_save_charging_pose(self, request, response):
        self.log.info(
            f'SetChargingPose: control_mode={request.control_mode}, '
            f'map={request.map_file_name}, child={request.child_map_file_name}')
        n = self.node
        n._set_state(TaskMode.MAPPING,
                     WorkStatus.SETTING_CHARGING_STATION)
        ok, dist = self._save_charging_pose_internal(
            map_name=request.map_file_name or 'home0',
            child_name=request.child_map_file_name or 'map0')
        response.result = 1 if ok else 0
        response.map_to_charging_dis = float(dist)
        return response
```

- [ ] **Step 4: Pytest + commit**

```bash
python -m pytest tests/test_charging_pose_distance.py -v
git add mower/service_handlers.py mower/tests/test_charging_pose_distance.py
git commit -m "fix(service_handlers): propagate map_to_charging_dis from upstream"
```

### Task 5.6: include_edge in generate_preview_cover_path

**Files:**
- Modify: `mower/service_handlers.py:625-657`

- [ ] **Step 1: Test**

Create `mower/tests/test_preview_include_edge.py`:

```python
from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_preview_uses_request_include_edge():
    body = SVC.read_text().split(
        'def _handle_generate_path')[1].split('def ')[0]
    assert 'req.include_edge = False' not in body, (
        'Hardcoded include_edge=False — must use request data')
    assert 'request.' in body and 'include_edge' in body
```

Run: expected FAIL.

- [ ] **Step 2: Fix**

Edit body:

```python
        req = CoveragePathsByFile.Request()
        req.map_yaml = map_yaml
        req.include_edge = bool(getattr(request, 'include_edge', False))
        req.specify_direction = bool(request.cov_direction > 0)
        req.cov_direction = request.cov_direction
```

(`GenerateCoveragePath.srv` likely has an `include_edge` bool field — verify with `grep -n include_edge /opt/ros/galactic/share/decision_msgs/srv/GenerateCoveragePath.srv` on mower; if the field has a different name, adjust.)

- [ ] **Step 3: Pytest + commit**

```bash
python -m pytest tests/test_preview_include_edge.py -v
git add mower/service_handlers.py mower/tests/test_preview_include_edge.py
git commit -m "fix(service_handlers): preview honors request.include_edge"
```

### Task 5.7: nav_to_recharge — guide pose + mapping reject

**Files:**
- Modify: `mower/service_handlers.py:608-621`
- Modify: `mower/robot_decision.py` (`start_recharge` — accept guide pose)

- [ ] **Step 1: Test**

Create `mower/tests/test_nav_to_recharge.py`:

```python
from pathlib import Path

SVC = Path(__file__).resolve().parents[1] / 'service_handlers.py'


def test_nav_to_recharge_rejects_in_mapping_mode():
    body = SVC.read_text().split(
        'def _handle_nav_to_recharge')[1].split('def ')[0]
    assert 'TaskMode.MAPPING' in body
    assert 'guide pose mode only support no mapping mode' in body


def test_nav_to_recharge_uses_request_pose_fields():
    body = SVC.read_text().split(
        'def _handle_nav_to_recharge')[1].split('def ')[0]
    assert 'request.pose_x' in body
    assert 'request.pose_y' in body
    assert 'request.theta' in body or 'request.pose_theta' in body
    assert 'request.mode' in body
```

Run: expected FAIL.

- [ ] **Step 2: Refactor handler**

```python
    def _handle_nav_to_recharge(self, request, response):
        """Navigate to charging dock with optional guide pose. Closed binary
        rejects if currently mapping ('Recharge with guide pose mode only
        support no mapping mode')."""
        self.log.info(
            f'Charging: nav_to_recharge mode={request.mode} '
            f'pose=({request.pose_x:.2f}, {request.pose_y:.2f}, '
            f'{request.theta:.2f})')
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
        if request.mode == 1:  # guide pose mode
            guide_pose = (float(request.pose_x), float(request.pose_y),
                          float(request.theta))
        n.start_recharge(guide_pose=guide_pose)
        response.result = 1
        response.description = 'Navigating to charger'
        return response
```

- [ ] **Step 3: `start_recharge` accept optional guide_pose**

In `mower/robot_decision.py` find `def start_recharge(`. Add `guide_pose=None` kwarg. When set, use it as the navigation goal instead of the cached charger pose. (Implementation detail: leave the existing fallback path; only override the goal pose when `guide_pose is not None`.)

- [ ] **Step 4: Pytest + commit**

```bash
python -m pytest tests/test_nav_to_recharge.py -v
git add mower/service_handlers.py mower/robot_decision.py mower/tests/test_nav_to_recharge.py
git commit -m "feat(robot_decision): nav_to_recharge guide-pose mode + mapping reject"
```

### Task 5.8: Battery hysteresis (charge_back_percentage)

**Files:**
- Modify: `mower/robot_decision.py` `_on_battery` callback + parameter declaration

- [ ] **Step 1: Test**

Create `mower/tests/test_battery_hysteresis.py`:

```python
from pathlib import Path

R = Path(__file__).resolve().parents[1] / 'robot_decision.py'


def test_charge_back_percentage_param_declared():
    src = R.read_text()
    assert "declare_parameter('charge_back_percentage'" in src


def test_battery_callback_uses_hysteresis():
    src = R.read_text()
    body = src.split('def _on_battery')[1].split('def ')[0]
    assert 'charge_back_percentage' in body
```

Run: expected FAIL.

- [ ] **Step 2: Declareer parameter**

In de `_declare_params` block of `__init__`:

```python
        self.declare_parameter('charge_back_percentage', 1)
```

Default `1` matches closed binary.

- [ ] **Step 3: Update `_on_battery`**

Locate `def _on_battery(self, msg)` (~regel 2138). Add hysteresis state + check:

```python
    def _on_battery(self, msg):
        ...existing code...
        low = self.get_parameter('low_battery_power').value
        full = self.get_parameter('full_battery_power').value
        back = self.get_parameter('charge_back_percentage').value
        # Hysteresis: only re-arm low-battery trigger after the level has gone
        # back ABOVE low+back (closed-binary semantics).
        if not getattr(self, '_low_battery_armed', True):
            if msg.power_percent >= low + back:
                self._low_battery_armed = True
        if msg.power_percent <= low and self._low_battery_armed:
            if self.task_mode == TaskMode.COVER:
                self.get_logger().warn(
                    f'Battery low ({msg.power_percent}% <= {low}%), '
                    f'cancelling coverage and starting recharge')
                self._cancel_active_actions()
                self.start_recharge()
                self._low_battery_armed = False
```

Initialize `self._low_battery_armed = True` in `__init__` (early, near other state attrs).

- [ ] **Step 4: Pytest + commit**

```bash
python -m pytest tests/test_battery_hysteresis.py -v
git add mower/robot_decision.py mower/tests/test_battery_hysteresis.py
git commit -m "feat(robot_decision): battery hysteresis via charge_back_percentage"
```

### Task 5.9: map_num — enumerate maps

**Files:**
- Modify: `mower/robot_decision.py` `_publish_status`

Memory `map-num-meaning.md` says **map_num = active task count**, not on-disk map count. Check before changing.

- [ ] **Step 1: Read memory + verify on real mower**

```bash
sshpass -p 'novabot' ssh root@<MOWER_IP> 'export ROS_LOCALHOST_ONLY=1; ros2 topic echo /robot_decision/robot_status --once' | grep map_num
```

Compare to on-disk maps:

```bash
sshpass -p 'novabot' ssh root@<MOWER_IP> 'ls /userdata/lfi/maps/home0/'
```

If `map_num` differs from disk count (it should — it's the active task count), the memory is correct. **Skip implementation if memory matches reality.** Document finding in `research/documents/robot-decision-gap-analysis.md` §10 unknowns and proceed.

- [ ] **Step 2 (optional, only if memory wrong):** Implement map enumeration

```python
        try:
            import os
            map_dir = self.get_parameter('load_map_path').value
            count = len([d for d in os.listdir(map_dir)
                         if os.path.isdir(os.path.join(map_dir, d))])
        except Exception:
            count = 0
        msg.map_num = count
```

- [ ] **Step 3: Commit gap-analysis update + (optionally) code**

```bash
git add research/documents/robot-decision-gap-analysis.md
git commit -m "docs(research): confirm map_num semantics on live mower"
```

### Task 5.10: Init_ok topic-vs-service disambiguation

**Files:**
- Modify: `mower/robot_decision.py` boot path

- [ ] **Step 1: Verify on mower**

```bash
sshpass -p 'novabot' ssh root@<MOWER_IP> '
export ROS_LOCALHOST_ONLY=1
echo "TOPIC:"; ros2 topic info /chassis_node/init_ok -v 2>/dev/null
echo "SERVICE:"; ros2 service type /chassis_node/init_ok 2>/dev/null
'
```

- [ ] **Step 2: Implementeer beide of fix mismatch**

If only **topic** exists: replace the service-client boot wait with a Bool subscription that latches `boot_init_ok = True` on `data:true`.

If only **service** exists: keep current logic; document in gap analysis §10.

If **both** exist: keep service path, but add the topic subscription as a fallback for closed-binary parity.

- [ ] **Step 3: Commit**

```bash
git add mower/robot_decision.py research/documents/robot-decision-gap-analysis.md
git commit -m "fix(robot_decision): align /chassis_node/init_ok consumer with live shape"
```

---

## Phase 6 — MEDIUM severity

### Task 6.1: add_area UNICOM_TO_STATION transition

**Files:**
- Modify: `mower/service_handlers.py:301-325`

- [ ] **Step 1: Voeg type=3 branch toe**

```python
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
```

If `WorkStatus.MANUAL_MAPPING_UNICOM_TO_STATION` is missing in the enum, add it (mirror the closed binary's value — typically next after `MANUAL_MAPPING_UNICOM`).

- [ ] **Step 2: Commit**

```bash
git add mower/service_handlers.py mower/state_machine.py
git commit -m "feat(service_handlers): add UNICOM_TO_STATION add_area transition"
```

### Task 6.2: Track erase mapping success/failure

**Files:**
- Modify: `mower/service_handlers.py:393-410`
- Modify: `mower/robot_decision.py` (likely a callback or polling tick)

- [ ] **Step 1: Implement async tracking**

The cleanest path: launch erase in a worker thread (mirror `_run_assistant_mapping` pattern), poll the result, and write `WorkStatus.AUTO_ERASE_MAPPING_SUCCESS` or `..._FAILED` afterwards.

```python
    def _handle_start_erase(self, request, response):
        self.log.info(f'SetBool: start_erase, data={request.data}')
        import threading
        threading.Thread(target=self._run_erase, daemon=True).start()
        response.success = True
        response.message = 'Erase mode started'
        return response

    def _run_erase(self):
        n = self.node
        n._set_state(TaskMode.MAPPING, WorkStatus.AUTO_ERASE_MAPPING)
        req = MappingControlSrv.Request()
        req.map_file_name = n.current_map_name or 'home0'
        req.type = 1  # CLEAR_REBUILD_MAP
        result = self._call_service(n.cli_erase_map_mode, req)
        if result and getattr(result, 'result', False):
            n._set_state(TaskMode.MAPPING,
                         WorkStatus.AUTO_ERASE_MAPPING_SUCCESS)
        else:
            n._set_state(TaskMode.MAPPING,
                         WorkStatus.AUTO_ERASE_MAPPING_FAILED)
```

- [ ] **Step 2: Commit**

```bash
git add mower/service_handlers.py
git commit -m "feat(service_handlers): track AUTO_ERASE_MAPPING_SUCCESS/FAILED"
```

### Task 6.3: prohibited_points wire-through

**Files:**
- Modify: `mower/robot_decision.py` (publisher to `/local_costmap/prohibited_points`)

- [ ] **Step 1: Convert `cli_prohibited_points` from service-client to publisher**

In `mower/robot_decision.py`, replace:

```python
        self.cli_prohibited_points = self.create_client(
            SetBool, '/local_costmap/prohibited_points',
            callback_group=self.client_cb_group)
```

with:

```python
        from geometry_msgs.msg import PolygonStamped
        self.prohibited_points_pub = self.create_publisher(
            PolygonStamped, '/local_costmap/prohibited_points', RELIABLE_QOS)
```

Then add a method to push user no-go zones (called when start_cov_task gets a request, or on map load):

```python
    def push_prohibited_zones(self, polygon_points):
        from geometry_msgs.msg import PolygonStamped, Point32
        msg = PolygonStamped()
        msg.header.frame_id = 'map'
        msg.header.stamp = self.get_clock().now().to_msg()
        for x, y in polygon_points:
            p = Point32(); p.x = float(x); p.y = float(y); p.z = 0.0
            msg.polygon.points.append(p)
        self.prohibited_points_pub.publish(msg)
```

Call it from `_handle_start_cov_task` after polygon validation if cov_mode==1.

- [ ] **Step 2: Commit**

```bash
git add mower/robot_decision.py mower/service_handlers.py
git commit -m "feat(robot_decision): publish prohibited_points to local_costmap"
```

### Task 6.4: Missing parameters

**Files:**
- Modify: `mower/robot_decision.py` `_declare_params`

- [ ] **Step 1: Voeg ontbrekende declarations toe**

```python
        self.declare_parameter('boundary_offset', 0.35)
        self.declare_parameter('include_edge', True)  # mirrors closed default 1
        self.declare_parameter('recharge_retry_times', 0)
        self.declare_parameter('escape_plan_switch', 0)
        self.declare_parameter('collect_image', 1)
        self.declare_parameter('do_camera_switch', 0)
```

- [ ] **Step 2: Wire `boundary_offset` into start_boundary_follow**

If `start_boundary_follow(...)` accepts an offset parameter (verify signature), pass `self.get_parameter('boundary_offset').value`. Otherwise, document as TODO in gap analysis §10.

- [ ] **Step 3: Commit**

```bash
git add mower/robot_decision.py
git commit -m "feat(robot_decision): declare missing closed-binary parameters"
```

---

## Phase 7 — LOW severity polish

### Task 7.1: Subscriptions for lifecycle topics

**Files:**
- Modify: `mower/robot_decision.py`

- [ ] **Step 1: Add four subscriptions**

```python
        from std_msgs.msg import UInt8 as _UInt8, Bool as _Bool
        from sensor_msgs.msg import PointCloud2

        self.create_subscription(
            _UInt8, '/chassis_node/led_level',
            self._on_led_level, RELIABLE_QOS)
        self.create_subscription(
            _Bool, '/camera/preposition/hardware_exception',
            self._on_camera_hw_exception, RELIABLE_QOS)
        self.create_subscription(
            _Bool, '/system/shared_memory_error',
            self._on_shm_error, RELIABLE_QOS)
        # ToF liveness — keep last timestamp only
        self.create_subscription(
            PointCloud2, '/camera/tof/point_cloud',
            self._on_tof, SENSOR_QOS)
```

Add the four callbacks. Each is essentially a state setter:

```python
    def _on_led_level(self, msg):
        self._led_level = int(msg.data)

    def _on_camera_hw_exception(self, msg):
        if msg.data:
            self._set_state(self.task_mode, WorkStatus.RECOVER_ERROR_STOP,
                            error_status=ErrorStatus.CAMERA_ERROR)

    def _on_shm_error(self, msg):
        if msg.data:
            self.get_logger().error('Shared memory error reported')
            self._set_state(TaskMode.STOP, WorkStatus.RECOVER_ERROR_STOP)

    def _on_tof(self, msg):
        self._tof_last_seen = time.monotonic()
```

(Use `ErrorStatus.CAMERA_ERROR` — add to enum if missing.)

- [ ] **Step 2: Commit**

```bash
git add mower/robot_decision.py mower/state_machine.py
git commit -m "feat(robot_decision): subscribe to remaining closed-binary lifecycle topics"
```

### Task 7.2: Real `cpu_usage` + `light` in robot_status

**Files:**
- Modify: `mower/robot_decision.py` `_publish_status`

- [ ] **Step 1: Replace hardcoded zeros**

```python
        # CPU usage from /proc/stat (1s window)
        try:
            with open('/proc/loadavg') as f:
                msg.cpu_usage = float(f.read().split()[0]) * 100.0
        except Exception:
            msg.cpu_usage = 0.0
        msg.light = int(getattr(self, '_led_level', 0))
```

- [ ] **Step 2: Commit**

```bash
git add mower/robot_decision.py
git commit -m "fix(robot_decision): real cpu_usage + light in robot_status"
```

### Task 7.3: collision_range publisher

**Files:**
- Modify: `mower/decision_assistant.py` (publish `/collision_range`)

- [ ] **Step 1: Add publisher + relay**

In DecisionAssistant `__init__` (after other publishers):

```python
        from sensor_msgs.msg import Range
        self.collision_range_pub = self.create_publisher(
            Range, '/collision_range', reliable_qos)
```

Add a callback registered on a relevant input (likely `/perception/points_labeled` or motor_current). For now, publish a stub Range message at 5 Hz computed from the nearest obstacle in the latest pointcloud. If pointcloud data is not yet wired, ship a Range with `range = -1.0` meaning "unknown" so mqtt_node at least sees the topic alive.

```python
    def _publish_collision_range_tick(self):
        from sensor_msgs.msg import Range
        msg = Range()
        msg.header.frame_id = 'base_link'
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.radiation_type = Range.INFRARED
        msg.field_of_view = 1.57
        msg.min_range = 0.0
        msg.max_range = 5.0
        msg.range = float(getattr(self, '_min_obstacle_dist', -1.0))
        self.collision_range_pub.publish(msg)
```

Schedule via `self.create_timer(0.2, self._publish_collision_range_tick)`.

- [ ] **Step 2: Commit**

```bash
git add mower/decision_assistant.py
git commit -m "feat(decision_assistant): publish /collision_range stub for mqtt_node parity"
```

### Task 7.4: led_buzzer_switch_set as topic publisher

**Files:**
- Modify: `mower/robot_decision.py`

- [ ] **Step 1: Convert client to publisher**

Replace:

```python
        self.cli_led_buzzer = self.create_client(
            SetUint8Srv, '/chassis_node/led_buzzer_switch_set', ...)
```

with:

```python
        self.led_buzzer_pub = self.create_publisher(
            UInt8, '/chassis_node/led_buzzer_switch_set', RELIABLE_QOS)
```

Anywhere the client was called (search), replace with `self.led_buzzer_pub.publish(UInt8(data=value))`.

- [ ] **Step 2: Commit**

```bash
git add mower/robot_decision.py
git commit -m "feat(robot_decision): led_buzzer as topic publisher (closed parity)"
```

### Task 7.5: LORA_ERROR_HANDLE rotation behaviour

**Files:**
- Modify: `mower/decision_assistant.py` `handle_incident_during_task` LoRa branch

- [ ] **Step 1: Add slow-rotate recovery**

When LoRa goes down, rotate slowly via `_publish_cloud_move(0.0, 0.5)` for max 30s, then check LoRa again (host has `lora_link_quality` or similar). On recovery, return to previous state.

```python
        elif error_status == ErrorStatus.LORA_ERROR:
            self._logger.warn('LoRa error: rotating to recover lora connect')
            n._set_state(n.task_mode, WorkStatus.LORA_ERROR_HANDLE,
                         error_status=error_status)
            threading.Thread(
                target=self._lora_recover_loop, daemon=True).start()
```

```python
    def _lora_recover_loop(self):
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            if getattr(self.host, 'lora_ok', True):
                self._logger.info('LoRa recovered')
                return
            self._publish_cloud_move(0.0, 0.5)
            time.sleep(0.2)
        self._publish_cloud_move(0.0, 0.0)
        self._logger.warn('LoRa recovery timeout')
```

- [ ] **Step 2: Commit**

```bash
git add mower/decision_assistant.py
git commit -m "feat(decision_assistant): rotate-to-recover on LORA_ERROR_HANDLE"
```

---

## Phase 8 — Cleanup, dead code, parity verification

### Task 8.1: Remove or document dead clients/parameters

**Files:**
- Modify: `mower/robot_decision.py`

- [ ] **Step 1: Audit each dead item**

For each dead client / parameter from gap analysis §6.2 + §B (`cli_free_move_around`, `cli_covered_path_json`, `cli_save_pcd_img`, `cli_preposition_save`, `cli_preposition_hw_exception`, `enable_slipping_recover`, `default_perception_level`, `max_save_image_count`, `enable_led_feedback_check`, `covering_path_file`, `cannot_move_angular_diff` (top-level — duplicate with assistant), `cannot_move_linear_diff` (idem), `follow_path_id`, `empty_map_path`, `full_battery_power` (only if confirmed unused), `boundary_offset` (now wired in 6.4)):

For each one, decide: implement or delete. If neither, leave a one-line `# TODO(open_decision):` comment with the closed-binary purpose.

- [ ] **Step 2: Commit**

```bash
git add mower/robot_decision.py
git commit -m "chore(robot_decision): prune or annotate dead clients/parameters"
```

### Task 8.2: End-to-end runtime parity check

**Files:**
- Modify: `mower/tests/runtime/run_smoke.sh`

- [ ] **Step 1: Add diff harness**

Extend `run_smoke.sh` to dump:

```bash
echo '=== node info diff (compare against /tmp/closed_decision_inventory.md sections A & B) ==='
ros2 node info /robot_decision > /tmp/open_robot_decision.txt
ros2 node info /decision_assistant > /tmp/open_decision_assistant.txt
diff <(grep -E '^\s*/' /tmp/closed_decision_inventory.md) /tmp/open_robot_decision.txt || true
```

- [ ] **Step 2: Run on mower**

```bash
sshpass -p 'novabot' ssh root@<MOWER_IP> 'export ROS_LOCALHOST_ONLY=1; bash /tmp/run_smoke.sh' > /tmp/smoke_after.txt
diff /tmp/closed_decision_inventory.md /tmp/smoke_after.txt > /tmp/parity.diff
```

- [ ] **Step 3: Triage remaining diff**

Each remaining line in `parity.diff` should map to either:
1. An open ticket (file as TODO in `research/documents/robot-decision-gap-analysis.md` §10).
2. A closed-binary leak we'll never replicate (annotate as "out of scope").
3. A bug in this plan (open new task).

- [ ] **Step 4: Commit results**

```bash
git add research/documents/robot-decision-gap-analysis.md
git commit -m "docs(research): record post-implementation parity diff"
```

### Task 8.3: Hardware acceptance — slip + recharge + cov_mode 1/2

**Files:**
- Create: `mower/tests/runtime/acceptance_checklist.md`

- [ ] **Step 1: Schrijf de checklist**

```markdown
# Hardware acceptance — open robot_decision

Run with mower on charger, working zone clear, dry conditions.
**REQUIRED — get user confirmation BEFORE any movement step.**

1. **Boot parity**
   - Stop stock C++ binary: `pkill -f /root/novabot/install/.*/robot_decision`.
   - Start Python: `bash /userdata/open_decision/start.sh` (with ROS_LOCALHOST_ONLY=1).
   - Expect: `/robot_decision` + `/decision_assistant` nodes; 18 services on robot_decision; 2 actions on decision_assistant.

2. **map_position publisher**
   - `ros2 topic hz /robot_decision/map_position` should report ~2 Hz.

3. **Coverage cov_mode 0 (full coverage)**
   - Trigger via app or `ros2 service call /robot_decision/start_cov_task ...`.
   - Confirm coverage starts; cancel after ~30s.

4. **Coverage cov_mode 2 (only edge)**
   - Verify coverage_planner_server logs "Only edge mode, only covering boundary path !!!!".
   - Cancel and dock back.

5. **Coverage cov_mode 1 (specified area)**
   - Send a polygon via the app (manual zone selection).
   - Verify mower stays inside the polygon.

6. **Slip auto-escalation**
   - Block one wheel briefly; expect SlipEscaping action goal observed in `ros2 action info`.

7. **Loc recover auto-escalation**
   - Cover GPS antenna with foil for ~10s; expect LocRecoverMoving goal.

8. **Battery hysteresis**
   - Use `ros2 topic pub /battery_message ...` (manual injection) to drop to 19%, then 21%, then 19% again. Recharge should fire ONCE.

9. **reset_data after fault**
   - Trigger a soft fault, then `ros2 service call /robot_decision/reset_data std_srvs/srv/SetBool '{data: true}'` and verify state returns to INIT_SUCCESS.
```

- [ ] **Step 2: Commit + share with user for sign-off**

```bash
git add mower/tests/runtime/acceptance_checklist.md
git commit -m "test: hardware acceptance checklist for open robot_decision parity"
```

The user runs this list and confirms each item before declaring "drop-in ready".

---

## Phase 9 — Documentation & memory

### Task 9.1: Update gap analysis with completion status

**Files:**
- Modify: `research/documents/robot-decision-gap-analysis.md`

- [ ] **Step 1: Mark resolved items**

For each backlog item closed in Phases 1–8, change the status indicator (✅) and add the commit SHA. Keep a "Remaining gaps" section with whatever survived Phase 8.3 triage.

- [ ] **Step 2: Commit**

```bash
git add research/documents/robot-decision-gap-analysis.md
git commit -m "docs(research): mark resolved gaps + record post-port deltas"
```

### Task 9.2: Update CLAUDE.md + memory

**Files:**
- Modify: `CLAUDE.md` (root) — refresh "Open robot_decision" section
- Modify: `/Users/rvbcrs/.claude/projects/-Users-rvbcrs-GitHub-Novabot/memory/MEMORY.md` index entry

- [ ] **Step 1: CLAUDE.md update**

Add a paragraph under the existing "Open robot_decision" section noting "drop-in parity reached on YYYY-MM-DD; activate via `bash /userdata/open_decision/start.sh`; rollback via `deploy.sh --rollback`." Confirm with user before committing.

- [ ] **Step 2: Memory file**

Update or replace `MEMORY.md` line:

```
- ⛔ DRAAIT OP GEEN ENKELE MAAIER (...)
```

with:

```
- ⚠️ Drop-in compleet (commit <SHA>); nog NIET geactiveerd op productie. User beslist activatie.
```

Edit the topic file (or create one) to track switchover state.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: open robot_decision drop-in parity reached"
```

(Memory file commit happens through the assistant's own memory tooling; do NOT commit `~/.claude/...` files into the repo.)

---

## Self-review checklist (run AFTER drafting plan)

- Spec coverage: every BLOCKER/HIGH/MEDIUM/LOW item from `research/documents/robot-decision-gap-analysis.md` §9 is mapped to a Task or to a "skip with rationale" annotation in §8.1/§8.2.
- No placeholders, no "TBD", no "fill in details", no "similar to Task N".
- Type consistency: action names `slipping_escape` + `loc_recover_moving` referenced consistently across Phase 1–3; `host_node` parameter name consistent in tests + implementation; `_send_slip_goal` / `_send_loc_recover_goal` consistent.
- Test commands and `ros2` introspection commands use `ROS_LOCALHOST_ONLY=1` and the `<MOWER_IP>` placeholder so the user fills the live IP from `active-mower-device.md`.

## Risk register

- **Activation requires user OK.** Memory `Open robot_decision (Python replacement) — NIET ACTIEF` is binding. Plan reaches "drop-in ready" in Phase 8.3 but does NOT enable on production. Phase 9.2 documents that.
- **Hardware acceptance is the final gate.** Any phase can land green in unit tests but fail on the mower. Treat Phase 8.3 as authoritative.
- **Closed-binary stuck-counter threshold + `decision_assistant/load_map` cadence** still unknown (gap analysis §10). If acceptance reveals divergence, log a follow-up plan rather than patching ad hoc.
