#!/usr/bin/env python3
"""Self-check for the `patrol` extended command in research/extended_commands.py.

Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
Run: python3 research/__tests__/test_patrol_command.py
"""
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import types

spec = importlib.util.spec_from_file_location(
    "ec", os.path.join(os.path.dirname(__file__), "..", "extended_commands.py"))
ec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ec)

checks = []


def check(name, ok):
    checks.append(ok)
    print(("ok   " if ok else "FAIL ") + name)


GOOD = {"run": "1791", "token": "0123456789abcdef0123456789abcdef",
        "zones": [{"zone": "map0", "points": [[1.5, 2.0], [3, 4]]}],
        "dwell_s": 6, "photo_topic": "front"}
VALID_CHECKPOINT = ('CHECKPOINT {"seq": 1, "x": 1.5, "y": 2.0, "frames": 3, "photo": true, '
                    '"sent": true, "person": 60, "animal": 0}')

clean, err = ec.validate_patrol_params(GOOD)
check("good params pass", err is None and clean["zones"][0]["points"] == [[1.5, 2.0], [3.0, 4.0]])
for bad, why in [
    ({**GOOD, "run": "../x"}, "invalid_run"),
    ({**GOOD, "token": "x"}, "invalid_token"),
    ({k: v for k, v in GOOD.items() if k != "token"}, "invalid_token"),
    ({**GOOD, "zones": [{"zone": "map0;rm", "points": [[1, 1]]}]}, "invalid_zone"),
    ({**GOOD, "zones": [{"zone": "map0", "points": [[1, "a"]]}]}, "invalid_point"),
    ({**GOOD, "zones": [{"zone": "map0", "points": [[1, 900]]}]}, "invalid_point"),
    ({**GOOD, "zones": [{"zone": "map0", "points": []}]}, "no_points"),
    ({**GOOD, "zones": [{"zone": "map0", "points": [[1, 1]] * 61}]}, "too_many_points"),
    ({**GOOD, "dwell_s": 99}, "invalid_dwell"),
    ({**GOOD, "photo_topic": "/etc/passwd"}, "invalid_photo_topic"),
]:
    check(f"refuses {why}", ec.validate_patrol_params(bad) == (None, why))


class FakeProc:
    pid = 4242

    def __init__(self, lines, rc=0, stopped=False, ignores_terminate=False):
        self.stdout = iter([line + "\n" for line in lines])
        self.returncode = None
        self._rc, self._stopped = rc, stopped
        self._ignores_terminate = ignores_terminate
        self.terminated = self.killed = False

    def wait(self, timeout=None):
        if self._ignores_terminate and self.terminated and not self.killed and timeout is not None:
            raise subprocess.TimeoutExpired("patrol", timeout)
        if self._stopped:
            ec._MOW_DRIVE_STOPPED[0] = True     # as handle_stop_mow_zone does
        if self.returncode is None:
            self.returncode = self._rc
        return self.returncode

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = -15

    def kill(self):
        self.killed = True
        self.returncode = -9


class TakenOverProc(FakeProc):
    """wait() as a newer drive's start leaves it: the newer drive has registered, this one exits."""

    def wait(self, timeout=None):
        ec._MOW_DRIVE_PROC[0] = object()
        return super().wait(timeout)


class MarkedProc(FakeProc):
    """wait() after kill_stale_mow_drives marked this drive for a newer start, before any
    newer drive has registered."""

    def wait(self, timeout=None):
        if hasattr(ec, "_MOW_DRIVE_SUPERSEDED"):
            ec._MOW_DRIVE_SUPERSEDED[0] = self
        return super().wait(timeout)


class SyncThread:
    def __init__(self, target=None, args=(), kwargs=None, daemon=None, name=None):
        self._target, self._args, self._kwargs = target, args, kwargs or {}

    def start(self):
        self._target(*self._args, **self._kwargs)


class EchoProc:
    """`ros2 topic echo /chassis_incident` as the safety watcher reads it."""

    def __init__(self, text):
        self.stdout = iter(text.splitlines(True))
        self.killed = False

    def poll(self):
        return None

    def kill(self):
        self.killed = True


QUIET_ECHO = "error_push_button_stop: false\nwarning_upraise_stop: false\n---\n"
STOP_ECHO = "error_push_button_stop: true\nwarning_upraise_stop: false\n---\n"


MISSING = object()   # a module attribute a patch adds rather than replaces


def reset_mow_state():
    """Forget the drive registration and any takeover mark a check left behind."""
    ec._MOW_DRIVE_PROC[0] = None
    if hasattr(ec, "_MOW_DRIVE_SUPERSEDED"):
        ec._MOW_DRIVE_SUPERSEDED[0] = None


def run(lines, rc=0, stopped=False, params=None, patches=None, respond_fails_on=None,
        ignores_terminate=False, proc_class=FakeProc, echo=""):
    sent, calls, seen = [], [], {}
    cleanups, sleeps = [], []    # nav-goal cleanups (the drive's state then), the guard's pauses
    events = []                  # the stale-run cleanup and every answer (name, phase), in order
    lights, stamps = [], []      # headlight levels the handler set; the kill times the cleanups got
    seen.update(cleanups=cleanups, sleeps=sleeps, events=events, lights=lights, stamps=stamps)
    script = tempfile.NamedTemporaryFile(suffix=".py", delete=False).name

    def cleanup(killed_at_ns=None):
        stamps.append(killed_at_ns)
        cleanups.append((seen["proc"].terminated, seen["proc"].killed))

    defaults = {
        "PATROL_DRIVE_SCRIPT": script,
        "PATROL_STATUS_FILE": tempfile.NamedTemporaryFile(suffix=".json", delete=False).name,
        "_server_from_config": lambda: "srv:8080",
        "_sn_from_config": lambda: "LFIN2230700238",
        "kill_stale_mow_drives": lambda timeout=5.0: events.append("kill_stale") or [],
        "_apply_edge_perception_low": lambda: calls.append("perception_on") or True,
        "_restore_edge_perception": lambda: calls.append("perception_off"),
        "_publish_blade_speed": lambda s: calls.append(("blade_speed", s)) or "",
        "_publish_blade_height": lambda h: calls.append(("blade_height", h)) or "",
        "_stop_mow_zone_cleanup": cleanup,
        "_patrol_headlight_off": lambda: lights.append(0),
        "_ros_env": lambda: {},
    }
    defaults.update(patches or {})
    real = {k: getattr(ec, k, MISSING) for k in defaults}
    real_popen, real_thread, real_sleep = ec.subprocess.Popen, ec.threading.Thread, ec.time.sleep
    failed = []

    def respond(name, body):
        if name == respond_fails_on and not failed:
            failed.append(name)
            raise OSError("broker link down")
        sent.append((name, body))
        events.append((name, body.get("phase")))

    seen["script"] = script

    def fake_popen(argv, **kw):
        if "topic echo" in argv[-1]:
            seen["echo"] = EchoProc(echo)
            return seen["echo"]
        seen["argv"] = argv
        with open(argv[-1]) as fh:
            seen["params"] = json.load(fh)
        seen["params_file"] = argv[-1]
        seen["proc"] = proc_class(lines, rc, stopped, ignores_terminate)
        return seen["proc"]

    for k, v in defaults.items():
        setattr(ec, k, v)
    ec.subprocess.Popen, ec.threading.Thread = fake_popen, SyncThread
    ec.time.sleep = lambda seconds=0: sleeps.append(seconds)   # recorded, not slept
    try:
        ec.handle_patrol(params or GOOD, respond)
    finally:
        ec.time.sleep = real_sleep
        restore(real)
        ec.subprocess.Popen, ec.threading.Thread = real_popen, real_thread
    return sent, calls, seen


def restore(real):
    """Put patched module attributes back; drop the ones a patch added."""
    for k, v in real.items():
        if v is MISSING:
            if hasattr(ec, k):
                delattr(ec, k)
        else:
            setattr(ec, k, v)


def before(calls, a, b):
    return a in calls and b in calls and calls.index(a) < calls.index(b)


def perception_gone():
    raise RuntimeError("perception service gone")


def guard_speed(refusals):
    """A blade-speed publish that refuses its first `refusals` calls. Returns the
    publish and the list of calls it saw, one per guard attempt."""
    attempts = []

    def publish(speed):
        attempts.append(speed)
        return "ros node not ready" if len(attempts) <= refusals else ""

    return publish, attempts


def kill_stale_probe(registered_pid, stale_pids):
    """The real kill_stale_mow_drives against a fake process list, with a drive registered
    under `registered_pid`. Returns the signals it sent, whether the registered drive was
    marked at the first one, and whether it is marked afterwards."""
    proc = FakeProc([])
    proc.pid = registered_pid
    reset_mow_state()
    ec._register_mow_drive(proc)
    kills, marked_at_first = [], []
    real_find, real_kill = ec.find_stale_mow_drives, os.kill

    def fake_kill(pid, sig):
        if not marked_at_first:
            marked_at_first.append(getattr(ec, "_MOW_DRIVE_SUPERSEDED", [None])[0] is proc)
        kills.append((pid, sig))

    ec.find_stale_mow_drives = lambda *a, **k: list(stale_pids)
    os.kill = fake_kill
    try:
        ec.kill_stale_mow_drives(timeout=0)
    finally:
        ec.find_stale_mow_drives, os.kill = real_find, real_kill
    marked = getattr(ec, "_MOW_DRIVE_SUPERSEDED", [None])[0] is proc
    reset_mow_state()
    return kills, marked_at_first, marked


sent, calls, seen = run([
    "LOG map_server reload: ok",
    "PHASE patrolling",
    'CHECKPOINT {"seq": 1, "x": 1.5, "y": 2.0, "frames": 3, "photo": true, "sent": true, "person": 60, "animal": 0}',
    'SKIPPED {"zone": "map6", "reason": "no_route"}',
    "PHASE done",
])
statuses = [b["phase"] for n, b in sent if n == "patrol_status"]
check("answers the start", ("patrol_respond", {"result": 0, "run": "1791"}) in sent)
check("streams the phases", statuses == ["starting", "patrolling", "done"])
check("forwards the checkpoint with its run",
      ("patrol_checkpoint", {"seq": 1, "x": 1.5, "y": 2.0, "frames": 3, "photo": True, "sent": True,
                             "person": 60, "animal": 0, "run": "1791"}) in sent)
check("forwards a skipped zone", ("patrol_skipped", {"zone": "map6", "reason": "no_route", "run": "1791"}) in sent)
check("blades off and the deck up once the patrol starts",
      calls.count(("blade_speed", 0)) == 1 and ("blade_height", 7) in calls)
check("the blade guard runs before detection goes on, detection restored after",
      before(calls, ("blade_speed", 0), "perception_on")
      and before(calls, ("blade_height", 7), "perception_on")
      and calls[-1:] == ["perception_off"])
check("the drive gets the upload address", seen["params"]["upload"]
      == "http://srv:8080/api/nova-file-server/patrol/uploadFrame?sn=LFIN2230700238&run=1791"
                              "&token=0123456789abcdef0123456789abcdef")
check("runs the patrol mode", seen["argv"][3:5] == ["patrol", seen["script"]]
      and 'patrol "$2"' in seen["argv"][2])
check("cleans up the params file", not os.path.exists(seen["params_file"]))
# The drive process needs 11-15 s to come up. Until it prints its first phase the server still
# holds the last run's end as the patrol phase, so a stop would not see a patrol running.
check("says it is starting, with its run, before the drive's own phases",
      sent[0] == ("patrol_status", {"phase": "starting", "run": "1791"}))
check("and only after the stale runs are cleaned up",
      seen["events"][:2] == ["kill_stale", ("patrol_status", "starting")])

sent, calls, _seen = run(["PHASE patrolling"], rc=-15, stopped=True)
check("a drive killed by stop reports stopped", [b["phase"] for n, b in sent if n == "patrol_status"]
      == ["starting", "patrolling", "stopped"])
check("and still restores the detection", calls[-1] == "perception_off")

sent, _calls, _seen = run(["PHASE patrolling"], rc=1)
check("a drive that died says so", ("patrol_status", {"phase": "error", "run": "1791", "error": "drive_exit_1"}) in sent)

sent, _calls, _seen = run([], params={**GOOD, "run": "x"})
check("bad params never start a drive", sent == [("patrol_respond", {"result": 1, "error": "invalid_run"})])

# a start that cannot go ahead never says it is starting
for why, patch in [("drive_script_missing", {"PATROL_DRIVE_SCRIPT": "/nonexistent/mow_zone_drive.py"}),
                   ("server_unknown", {"_server_from_config": lambda: ""})]:
    sent, _calls, seen = run([], patches=patch)
    check(f"{why} never says it is starting",
          sent == [("patrol_respond", {"result": 1, "error": why})] and "kill_stale" not in seen["events"])

# a. the blade guard cannot be met: the drive is terminated, nothing more is forwarded
sent, calls, seen = run(
    ["PHASE patrolling", VALID_CHECKPOINT, "PHASE done"],
    patches={"_publish_blade_speed": lambda s: "ros node not ready"})
check("a failing blade guard stops the drive",
      [b["phase"] for n, b in sent if n == "patrol_status"] == ["starting", "patrolling", "error"]
      and ("patrol_status", {"phase": "error", "run": "1791", "error": "blade_guard_failed"}) in sent
      and seen["proc"].terminated)
check("and forwards no checkpoint from it", not any(n == "patrol_checkpoint" for n, _ in sent))
check("and never switches the detection on", "perception_on" not in calls)

# b. a publish that fails does not end the supervision
sent, calls, seen = run(["PHASE patrolling", VALID_CHECKPOINT, "PHASE done"],
                        respond_fails_on="patrol_checkpoint")
check("a dropped publish does not end the supervision",
      [b["phase"] for n, b in sent if n == "patrol_status"] == ["starting", "patrolling", "done"]
      and not seen["proc"].terminated and calls[-1:] == ["perception_off"])

# c. a checkpoint line whose JSON is not an object is skipped, the lines after it still count
sent, calls, seen = run([
    "PHASE patrolling",
    "CHECKPOINT [1, 2]",
    "CHECKPOINT {not json",
    'SKIPPED {"zone": "map6", "reason": "no_route"}',
    "PHASE done",
])
check("a malformed checkpoint line is skipped and the rest still counts",
      [b["phase"] for n, b in sent if n == "patrol_status"] == ["starting", "patrolling", "done"]
      and ("patrol_skipped", {"zone": "map6", "reason": "no_route", "run": "1791"}) in sent
      and not any(n == "patrol_checkpoint" for n, _ in sent))

# d. an exception in the loop terminates the drive and is reported
sent, calls, seen = run(["PHASE patrolling", VALID_CHECKPOINT, "PHASE done"],
                        patches={"_apply_edge_perception_low": perception_gone})
check("an exception in the loop terminates the drive",
      seen.get("proc") is not None and seen["proc"].terminated)
check("and the error is reported",
      ("patrol_status", {"phase": "error", "run": "1791", "error": "perception service gone"}) in sent)

# e. the drive's own error phase passes through
sent, calls, seen = run(["PHASE patrolling", "PHASE error checkpoints_unreachable"], rc=1)
check("a drive error phase passes through",
      [b for n, b in sent if n == "patrol_status" and b["phase"] == "error"]
      == [{"phase": "error", "run": "1791", "error": "checkpoints_unreachable"}])

# round 2: a guard refused once and then holding lets the patrol go on, with one retry
publish, attempts = guard_speed(1)
sent, calls, seen = run(["PHASE patrolling", VALID_CHECKPOINT, "PHASE done"],
                        patches={"_publish_blade_speed": publish})
check("a guard refused once and then holding lets the patrol go on",
      [b["phase"] for n, b in sent if n == "patrol_status"] == ["starting", "patrolling", "done"]
      and any(n == "patrol_checkpoint" for n, _ in sent) and "perception_on" in calls)
check("that is exactly two guard attempts with one pause between them",
      len(attempts) == 2 and seen["sleeps"] == [1.0] and not seen["proc"].terminated)

# round 2: a guard that never holds: three attempts, pauses only between them, the nav goal released
publish, attempts = guard_speed(3)
sent, calls, seen = run(["PHASE patrolling", VALID_CHECKPOINT, "PHASE done"],
                        patches={"_publish_blade_speed": publish})
check("three refusals make exactly three attempts with pauses only between them",
      len(attempts) == 3 and seen["sleeps"] == [1.0, 1.0])
check("a failing guard releases the nav goal after the drive was terminated",
      seen["cleanups"] == [(True, False)])

# round 2: the loop-exception path releases the nav goal too, after the drive was terminated
sent, calls, seen = run(["PHASE patrolling", VALID_CHECKPOINT, "PHASE done"],
                        patches={"_apply_edge_perception_low": perception_gone})
check("an exception in the loop releases the nav goal after the drive was terminated",
      seen["cleanups"] == [(True, False)])

# round 2: a patrol that finishes on its own leaves the nav goal alone
sent, calls, seen = run(["PHASE patrolling", VALID_CHECKPOINT, "PHASE done"])
check("a patrol that finishes leaves the nav goal alone", seen["cleanups"] == [])

# f. a drive that survives SIGTERM is killed, and its nav goal is still released
sent, calls, seen = run(["PHASE patrolling"], patches={"_apply_edge_perception_low": perception_gone},
                        ignores_terminate=True)
check("a drive that survives SIGTERM is killed", seen.get("proc") is not None and seen["proc"].killed)
check("and its nav goal is released after the kill", seen["cleanups"] == [(True, True)])

# round 3: a drive taken over by a newer drive (registered while this one exits) reports stopped
sent, calls, seen = run(["PHASE patrolling"], rc=-15, proc_class=TakenOverProc)
reset_mow_state()
check("a drive taken over by a newer drive reports stopped",
      [b["phase"] for n, b in sent if n == "patrol_status"] == ["starting", "patrolling", "stopped"])
check("and sends no error for it",
      not any(b.get("phase") == "error" for n, b in sent if n == "patrol_status"))
check("and leaves the newer drive's nav goal alone", seen["cleanups"] == [])

# round 3: a drive that exits on its own with -15, with no newer drive, is still an error
sent, calls, seen = run(["PHASE patrolling"], rc=-15)
check("a drive that exits on its own with -15 still reports drive_exit_-15",
      ("patrol_status", {"phase": "error", "run": "1791", "error": "drive_exit_-15"}) in sent)

# round 3: a drive marked by kill_stale_mow_drives reports stopped, before any newer drive registers
sent, calls, seen = run(["PHASE patrolling"], rc=-15, proc_class=MarkedProc)
reset_mow_state()
check("a drive marked by kill_stale_mow_drives reports stopped",
      [b["phase"] for n, b in sent if n == "patrol_status"] == ["starting", "patrolling", "stopped"]
      and seen["cleanups"] == [])

# round 3: kill_stale_mow_drives marks the registered drive before its first signal, and only that drive
kills, marked_at_first, marked = kill_stale_probe(registered_pid=4242, stale_pids=[4242])
check("kill_stale_mow_drives marks the registered drive before the first signal",
      marked_at_first == [True] and marked and bool(kills) and kills[0][1] == signal.SIGTERM)
kills, marked_at_first, marked = kill_stale_probe(registered_pid=4242, stale_pids=[4343])
check("and leaves a registered drive it does not kill unmarked", marked_at_first == [False] and not marked)


# ── Final fix wave ───────────────────────────────────────────────────────────

def edge_cut_start(params):
    """handle_start_edge_cut with the ROS side faked. The order of what it did, and its answers."""
    order, answers = [], []
    patches = {
        "_clear_costmaps": lambda: order.append("clear_costmaps"),
        "kill_stale_mow_drives": lambda timeout=5.0: order.append("kill_stale") or [],
        "_depart_pile": lambda *a, **k: order.append("depart"),
        "_apply_edge_perception_low": lambda: False,
        "_watch_edge_cut_safety": lambda *a, **k: None,
    }
    real = {k: getattr(ec, k, MISSING) for k in patches}
    real_popen, real_thread = ec.subprocess.Popen, ec.threading.Thread
    for k, v in patches.items():
        setattr(ec, k, v)
    ec.subprocess.Popen = lambda argv, **kw: order.append("dispatch") or FakeProc([])
    ec.threading.Thread = SyncThread
    try:
        ec.handle_start_edge_cut(params, lambda name, body: answers.append((name, body)))
    finally:
        restore(real)
        ec.subprocess.Popen, ec.threading.Thread = real_popen, real_thread
    return order, answers


# A2: an edge cut ends a running zone drive or patrol first, as every other drive start does
order, answers = edge_cut_start({"mapName": "map0", "bladeHeight": 40, "departFromDock": True})
check("an edge cut ends a running zone drive or patrol before it moves",
      "kill_stale" in order and order.index("kill_stale") < order.index("depart") < order.index("dispatch"))
check("and then starts as before", any(n == "start_edge_cut_respond" and b.get("result") == 0 for n, b in answers))
order, answers = edge_cut_start({"mapName": "map0;rm -rf /"})
check("a refused edge cut ends nothing", "kill_stale" not in order and "dispatch" not in order)

# A3: the STOP button, a lift or a tilt ends a patrol: the drive is terminated (SIGTERM, so its
# own release runs), the stop_mow_zone cleanup releases the nav goal, the end says why
sent, calls, seen = run([], rc=-15, echo=QUIET_ECHO + STOP_ECHO)
statuses = [b for n, b in sent if n == "patrol_status"]
check("a STOP press during a patrol ends it as stopped, with the flag",
      statuses == [{"phase": "starting", "run": "1791"},
                   {"phase": "stopped", "run": "1791", "error": "error_push_button_stop"}])
check("the drive is terminated with SIGTERM, not killed", seen["proc"].terminated and not seen["proc"].killed)
check("and the stop cleanup releases the nav goal after that", seen["cleanups"] == [(True, False)])
check("the watcher's echo process is cleaned up", seen.get("echo") is not None and seen["echo"].killed)
check("the headlight goes off on the mower", seen["lights"] == [0])
sent, calls, seen = run(["PHASE patrolling", "PHASE done"], echo=QUIET_ECHO * 3)
check("quiet chassis messages change nothing",
      [b["phase"] for n, b in sent if n == "patrol_status"] == ["starting", "patrolling", "done"]
      and not seen["proc"].terminated and seen["cleanups"] == [])
lifted = STOP_ECHO.replace("error_push_button_stop: true", "error_push_button_stop: false") \
                  .replace("warning_upraise_stop: false", "warning_upraise_stop: true")
sent, calls, seen = run(["PHASE patrolling"], rc=-15, echo=lifted)
check("lifting the mower ends the patrol the same way",
      ("patrol_status", {"phase": "stopped", "run": "1791", "error": "warning_upraise_stop"}) in sent
      and seen["proc"].terminated)
check("and nothing after the end goes out for that run",
      [b["phase"] for n, b in sent if n == "patrol_status"][-1] == "stopped")


class FakeRos:
    """rclpy and the message modules _stop_mow_zone_cleanup imports, recording each request."""

    NAMES = ("rclpy", "action_msgs", "action_msgs.srv", "rcl_interfaces", "rcl_interfaces.srv",
             "rcl_interfaces.msg")

    def __init__(self):
        self.sent = []
        ns = types.SimpleNamespace
        sent = self.sent

        class Client:
            def __init__(self, srv):
                self.srv = srv

            def wait_for_service(self, timeout_sec=None):
                return True

            def call_async(self, req):
                sent.append((self.srv, req))

        class Node:
            def create_client(self, srv_type, srv):
                return Client(srv)

            def destroy_node(self):
                pass

        class CancelRequest:
            def __init__(self):
                self.goal_info = ns(goal_id=ns(uuid=None), stamp=ns(sec=0, nanosec=0))

        class ParamRequest:
            def __init__(self):
                self.parameters = []

        self.modules = {name: types.ModuleType(name) for name in self.NAMES}
        self.modules["rclpy"].init = lambda *a, **k: None
        self.modules["rclpy"].create_node = lambda name: Node()
        self.modules["action_msgs.srv"].CancelGoal = ns(Request=CancelRequest)
        self.modules["rcl_interfaces.srv"].SetParameters = ns(Request=ParamRequest)
        self.modules["rcl_interfaces.msg"].Parameter = lambda: ns(name=None, value=None)
        self.modules["rcl_interfaces.msg"].ParameterValue = lambda: ns(type=None, bool_value=None, double_value=None)
        self.modules["rcl_interfaces.msg"].ParameterType = ns(PARAMETER_BOOL=1, PARAMETER_DOUBLE=3)

    def __enter__(self):
        self.real = {name: sys.modules.get(name) for name in self.NAMES}
        sys.modules.update(self.modules)
        self.real_sleep, ec.time.sleep = ec.time.sleep, (lambda seconds=0: None)
        return self

    def __exit__(self, *exc):
        ec.time.sleep = self.real_sleep
        for name, module in self.real.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
        return False


# A4: the stop cleanup cancels only the goals accepted up to the kill, so the docking
# goal of a go_pile / go_to_charge that follows the stop survives it
kill_ns = time.time_ns()
with FakeRos() as ros:
    ec._stop_mow_zone_cleanup(kill_ns)
cancels = [(srv, req) for srv, req in ros.sent if srv.endswith("/_action/cancel_goal")]
check("the cleanup cancels on both nav2 actions",
      sorted(srv for srv, _req in cancels) == ["/follow_path/_action/cancel_goal",
                                                 "/navigate_to_pose/_action/cancel_goal"])
check("with the zero goal id", all(list(req.goal_info.goal_id.uuid) == [0] * 16 for _s, req in cancels))
check("and the kill time as the stamp: only goals accepted up to the kill",
      all(req.goal_info.stamp.sec * 10 ** 9 + req.goal_info.stamp.nanosec == kill_ns for _s, req in cancels)
      and kill_ns > 0)
check("the transit params still go back", any(srv.endswith("/set_parameters") for srv, _req in ros.sent))

captured = []
real_popen, ec.subprocess.Popen = ec.subprocess.Popen, (lambda argv, **kw: captured.append(argv))
try:
    ec._stop_mow_zone_cleanup_cli(kill_ns)
finally:
    ec.subprocess.Popen = real_popen
sec, nanosec = divmod(kill_ns, 10 ** 9)
check("the CLI fallback sends the same stamp to both actions",
      bool(captured) and captured[-1][2].count(f"{{goal_info: {{stamp: {{sec: {sec}, nanosec: {nanosec}}}}}}}") == 2)

stop_stamps, answers = [], []
real = {k: getattr(ec, k, MISSING) for k in ("_stop_mow_zone_cleanup",)}
real_run, real_thread = ec.subprocess.run, ec.threading.Thread
ec._stop_mow_zone_cleanup = lambda killed_at_ns=None: stop_stamps.append(killed_at_ns)
ec.subprocess.run, ec.threading.Thread = (lambda *a, **k: None), SyncThread
running = FakeProc([])
reset_mow_state()
ec._register_mow_drive(running)
try:
    before = time.time_ns()
    ec.handle_stop_mow_zone({}, lambda name, body: answers.append((name, body)))
    after = time.time_ns()
finally:
    restore(real)
    ec.subprocess.run, ec.threading.Thread = real_run, real_thread
    reset_mow_state()
check("stop_mow_zone hands the cleanup the time it terminated the drive",
      running.terminated and len(stop_stamps) == 1 and stop_stamps[0] is not None
      and before <= stop_stamps[0] <= after)

sent, calls, seen = run(["PHASE patrolling", VALID_CHECKPOINT, "PHASE done"],
                        patches={"_apply_edge_perception_low": perception_gone})
check("a terminated patrol drive hands its kill time to the cleanup too",
      len(seen["stamps"]) == 1 and seen["stamps"][0] is not None and seen["stamps"][0] <= time.time_ns())


def reannounced(now=None):
    out = []
    kwargs = {} if now is None else {"now": now}
    ec.reannounce_patrol_status(lambda name, body: out.append((name, body)), **kwargs)
    return out


def forget_patrol_status():
    if hasattr(ec, "_LAST_PATROL_STATUS"):
        ec._LAST_PATROL_STATUS[0] = None


# A5a: the last patrol_status goes out again after every MQTT (re)connect
forget_patrol_status()
check("nothing to re-announce before any patrol", reannounced() == [])
run(["PHASE patrolling", "PHASE done"])
check("after a reconnect the end of the last patrol goes out again",
      reannounced() == [("patrol_status", {"phase": "done", "run": "1791"})])
check("but not once it is older than 6 h", reannounced(now=time.time() + 6 * 3600 + 60) == [])
run(["PHASE patrolling"], rc=-15, stopped=True)
check("a stop is an end like any other", reannounced() == [("patrol_status", {"phase": "stopped", "run": "1791"})])


class LateEndProc(FakeProc):
    """A superseded drive whose end is reported after the newer patrol said it is starting."""

    def wait(self, timeout=None):
        if not getattr(self, "newer_started", False):
            self.newer_started = True
            run([], params={**GOOD, "run": "1792"})   # the newer patrol: starting, then nothing
        return super().wait(timeout)


run(["PHASE patrolling"], rc=-15, stopped=True, proc_class=LateEndProc)
reset_mow_state()
check("an older run's late end does not replace the newer run's last status",
      [b["run"] for _n, b in reannounced()] == ["1792"])


class FakeMQTT:
    """MiniMQTT for main(): every connection publishes into `published`; the first
    connection drops, the second ends the loop."""
    published, connects = [], [0]

    def __init__(self, host, port, client_id, on_message=None):
        pass

    def connect(self):
        FakeMQTT.connects[0] += 1

    def subscribe(self, topic):
        pass

    def publish(self, topic, payload):
        FakeMQTT.published.append((topic, json.loads(payload)))

    def loop_forever(self):
        if FakeMQTT.connects[0] >= 2:
            raise KeyboardInterrupt


def start_up(status_file):
    """One start of extended_commands (main) against FakeMQTT, with the ROS
    relays off. The patrol_status messages it published, one list per connection."""
    patches = {
        "MiniMQTT": FakeMQTT, "PATROL_STATUS_FILE": status_file,
        "read_config": lambda: ("LFIN2230700238", "127.0.0.1", 1883),
        "start_blade_telemetry_relay": lambda *a: None, "start_rtk_telemetry_relay": lambda *a: None,
        "enable_rtk_telemetry": lambda: False, "start_charging_station_guard": lambda: None,
        "start_perception_model_client": lambda: None,
    }
    real = {k: getattr(ec, k, MISSING) for k in patches}
    handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGCHLD)}
    real_sleep = ec.time.sleep
    FakeMQTT.published, FakeMQTT.connects = [], [0]
    forget_patrol_status()   # a new process remembers nothing but the file
    for k, v in patches.items():
        setattr(ec, k, v)
    ec.time.sleep = lambda seconds=0: None
    try:
        ec.main()
    finally:
        ec.time.sleep = real_sleep
        restore(real)
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
    return [body["patrol_status"] for topic, body in FakeMQTT.published
            if topic == "novabot/extended_response/LFIN2230700238" and "patrol_status" in body]


status_file = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
with open(status_file, "w") as fh:
    json.dump({"body": {"phase": "patrolling", "run": "1791"}, "t": time.time() - 600}, fh)
restarted = {"phase": "error", "run": "1791", "error": "mower_restarted"}
check("a patrol that was running when the mower went down is reported as mower_restarted, "
      "on the first connect and again after the reconnect", start_up(status_file) == [restarted, restarted])
check("once: the next start-up has nothing to report", start_up(status_file) == [])
os.remove(status_file)
check("no file, no status: nothing is invented", start_up(status_file) == [])
with open(status_file, "w") as fh:
    json.dump({"body": {"phase": "done", "run": "1791"}, "t": time.time() - 600}, fh)
check("a patrol that had ended is not reported again after a restart", start_up(status_file) == [])

# The exit code is lost on the mower: main() ignores SIGCHLD (#60), so the kernel reaps every
# child and Popen reads its returncode as 0. The end of a drive that did not report its own
# must still go out, or the last status stays `patrolling` and every reconnect re-sends it.
sent, calls, seen = run(["PHASE patrolling"], rc=0, stopped=True)
check("a drive killed by stop reports stopped, also when its exit code reads 0",
      [b["phase"] for n, b in sent if n == "patrol_status"] == ["starting", "patrolling", "stopped"])
sent, calls, seen = run(["PHASE patrolling"], rc=0, proc_class=TakenOverProc)
reset_mow_state()
check("a drive taken over by a newer one reports stopped, also with exit code 0",
      [b["phase"] for n, b in sent if n == "patrol_status"] == ["starting", "patrolling", "stopped"])
sent, calls, seen = run(["PHASE patrolling"], rc=0)
check("a drive that died without its end reports an error, also with exit code 0",
      ("patrol_status", {"phase": "error", "run": "1791", "error": "drive_exit_0"}) in sent)
check("and the last status to re-send is that end", reannounced()[-1][1]["phase"] == "error")

# A5c: the handler switches the headlight off when the drive did not end by itself
sent, calls, seen = run(["PHASE patrolling"], rc=-15, stopped=True)
check("a drive killed by stop: the handler switches the headlight off", seen["lights"] == [0])
sent, calls, seen = run(["PHASE patrolling"], rc=-15, proc_class=TakenOverProc)
reset_mow_state()
check("a drive taken over by a newer one: the same", seen["lights"] == [0])
sent, calls, seen = run(["PHASE patrolling", VALID_CHECKPOINT, "PHASE done"],
                        patches={"_publish_blade_speed": lambda s: "ros node not ready"})
check("a drive ended by a failing blade guard: the same", seen["lights"] == [0])
sent, calls, seen = run(["PHASE patrolling", "PHASE done"])
check("a drive that finished switched it off itself, before its done", seen["lights"] == [])
sent, calls, seen = run(["PHASE patrolling", "PHASE error checkpoints_unreachable"], rc=1)
check("a drive that ended with its own error: the same", seen["lights"] == [])


class Relay:
    """The blade relay's long-lived ROS node, as far as the headlight goes."""

    def __init__(self):
        self.levels = []

    def publish_headlight(self, level):
        self.levels.append(level)


bg = []
real = {k: getattr(ec, k, MISSING) for k in ("_publish_topic_bg",)}
real_node = ec._ROS_BLADE_NODE[0]
ec._publish_topic_bg = lambda topic, type_name, payload: bg.append((topic, type_name, payload)) or ""
try:
    relay = ec._ROS_BLADE_NODE[0] = Relay()
    ec._patrol_headlight_off()
    check("the handler's headlight-off goes through the relay's own /led_set publisher",
          relay.levels == [0] and bg == [])
    ec._ROS_BLADE_NODE[0] = None
    ec._patrol_headlight_off()
    check("and through a ros2 topic pub when the relay is not up",
          bg == [("/led_set", "std_msgs/msg/UInt8", "{data: 0}")])
finally:
    ec._ROS_BLADE_NODE[0] = real_node
    restore(real)

print(f"\n{sum(checks)}/{len(checks)} checks ok")
raise SystemExit(0 if all(checks) else 1)
