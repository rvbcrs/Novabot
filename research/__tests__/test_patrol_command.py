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
        self.killed = self.terminated = False

    def poll(self):
        return None

    def kill(self):
        self.killed = True

    def terminate(self):
        self.terminated = True


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
        "_edge_cut_running": lambda: False,
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

def edge_cut_start(params, extra=None):
    """handle_start_edge_cut with the ROS side faked. The order of what it did, and its answers."""
    order, answers = [], []
    patches = {
        "_clear_costmaps": lambda: order.append("clear_costmaps"),
        "kill_stale_mow_drives": lambda timeout=5.0: order.append("kill_stale") or [],
        "_depart_pile": lambda *a, **k: order.append("depart"),
        "_apply_edge_perception_low": lambda: False,
        "_watch_edge_cut_safety": lambda *a, **k: None,
    }
    patches.update(extra or {})
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
check("the watcher's echo process is ended with SIGTERM, which timeout passes on to ros2",
      seen.get("echo") is not None and seen["echo"].terminated and not seen["echo"].killed)
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
    connection drops, the second ends the loop. `events` keeps what main() did to it, in
    order, for the checks of what comes after what. A publish whose payload holds
    `fail_publish_of` raises, as a dead link does."""
    published, connects, events, fail_publish_of = [], [0], [], None

    def __init__(self, host, port, client_id, on_message=None):
        FakeMQTT.handler = on_message

    def connect(self):
        FakeMQTT.connects[0] += 1
        if FakeMQTT.connects[0] > 4:
            raise KeyboardInterrupt     # a main() that keeps reconnecting must not hang the run
        FakeMQTT.events.append(("connect",))

    def subscribe(self, topic):
        FakeMQTT.events.append(("subscribe", topic))

    def publish(self, topic, payload):
        if FakeMQTT.fail_publish_of and FakeMQTT.fail_publish_of in payload:
            FakeMQTT.events.append(("publish_failed", topic))
            raise OSError("broker link down")
        FakeMQTT.published.append((topic, json.loads(payload)))
        FakeMQTT.events.append(("publish", topic, json.loads(payload)))

    def loop_forever(self):
        FakeMQTT.events.append(("loop",))
        if FakeMQTT.connects[0] >= 2:
            raise KeyboardInterrupt


WATCHERS_STARTED = []   # the ROS watchers main() started, in order (start_up)


def start_up(status_file, fail_publish_of=None):
    """One start of extended_commands (main) against FakeMQTT, with the ROS
    relays off. The patrol_status messages it published, one list per connection."""
    WATCHERS_STARTED.clear()
    patches = {
        "MiniMQTT": FakeMQTT, "PATROL_STATUS_FILE": status_file,
        "read_config": lambda: ("LFIN2230700238", "127.0.0.1", 1883),
        "start_blade_telemetry_relay": lambda *a: None, "start_rtk_telemetry_relay": lambda *a: None,
        "enable_rtk_telemetry": lambda: False, "start_charging_station_guard": lambda: None,
        "start_perception_model_client": lambda: None,
        "start_recharge_light_watcher": lambda: WATCHERS_STARTED.append("recharge_light"),
    }
    real = {k: getattr(ec, k, MISSING) for k in patches}
    handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGCHLD)}
    real_sleep = ec.time.sleep
    FakeMQTT.published, FakeMQTT.connects, FakeMQTT.events = [], [0], []
    FakeMQTT.fail_publish_of = fail_publish_of
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

# ext_hello: the server learns which commands this script dispatches instead of guessing them
# from the firmware build. Said on every connect (the server forgets a device when its link
# drops): after the subscribe, before the last patrol status goes out again.
RESPONSE_TOPIC = "novabot/extended_response/LFIN2230700238"


def patrolling_status_file():
    """What a mower leaves behind that went down mid-patrol: main() reports it (mower_restarted)
    at every connect, so there is a patrol status to go out again."""
    path = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
    with open(path, "w") as fh:
        json.dump({"body": {"phase": "patrolling", "run": "1791"}, "t": time.time() - 600}, fh)
    return path


def connections(events):
    """FakeMQTT.events, one list per connection."""
    split = []
    for event in events:
        if event[0] == "connect":
            split.append([])
        else:
            split[-1].append(event)
    return split


def timeline(connection):
    """What one connection did, in order, by name: the subscribe, every answer it published
    (an answer's name is its one key), the loop."""
    return [next(iter(ev[2])) if ev[0] == "publish" else ev[0] for ev in connection]


def precedes(names, a, b):
    """True when both `a` and `b` are in `names` and `a` comes first."""
    return a in names and b in names and names.index(a) < names.index(b)


def hellos(connection):
    """The ext_hello answers one connection published, as (topic, body)."""
    return [(ev[1], ev[2]) for ev in connection if ev[0] == "publish" and "ext_hello" in ev[2]]


start_up(patrolling_status_file())
conns = connections(FakeMQTT.events)
said = hellos(conns[0])
hello = said[0][1] if said else {}
commands = hello.get("ext_hello", {}).get("commands")
check("a connect says ext_hello once, on the response topic, after its subscribe",
      [topic for topic, _body in said] == [RESPONSE_TOPIC] and precedes(timeline(conns[0]), "subscribe", "ext_hello"))
check("the hello is exactly {ext_hello: {commands: [...]}}",
      list(hello) == ["ext_hello"] and list(hello["ext_hello"]) == ["commands"])
check("its commands are the keys of COMMANDS, sorted", commands == sorted(ec.COMMANDS))
check("among them patrol, mow_zone and stop_mow_zone",
      all(name in (commands or []) for name in ("patrol", "mow_zone", "stop_mow_zone")))
check("after a reconnect it is said again, the same, after that connection's subscribe",
      len(conns) == 2 and len(hellos(conns[1])) == 1 and hellos(conns[1]) == said
      and precedes(timeline(conns[1]), "subscribe", "ext_hello"))
check("on every connection the hello comes before the patrol status that goes out again",
      len(conns) == 2 and all(precedes(timeline(c), "ext_hello", "patrol_status") for c in conns))

# A hello that cannot be sent is logged and nothing more: the connection still re-announces the
# patrol status and enters its loop, and the failure does not cost a reconnect.
logged = []
real = {"log": ec.log}
ec.log = logged.append
try:
    start_up(patrolling_status_file(), fail_publish_of="ext_hello")
finally:
    restore(real)
check("a hello that fails to send ends neither the connection nor the patrol re-announce",
      [timeline(c) for c in connections(FakeMQTT.events)]
      == [["subscribe", "subscribe", "publish_failed", "patrol_status", "loop"]] * 2)
check("and the failure is logged", any("ext_hello" in line for line in logged))

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


# R2: a second stop_mow_zone for a drive already on its way out keeps the FIRST kill time as the
# goal-cancel stamp, or it cancels the docking goal a go_pile started in between
stop_stamps = []
real = {k: getattr(ec, k, MISSING) for k in ("_stop_mow_zone_cleanup",)}
real_run, real_thread = ec.subprocess.run, ec.threading.Thread
ec._stop_mow_zone_cleanup = lambda killed_at_ns=None: stop_stamps.append(killed_at_ns)
ec.subprocess.run, ec.threading.Thread = (lambda *a, **k: None), SyncThread


def stop(pause=0.002):
    time.sleep(pause)   # every stop a little later than the one before
    ec.handle_stop_mow_zone({}, lambda name, body: None)


try:
    reset_mow_state()
    first = FakeProc([])
    ec._register_mow_drive(first)
    stop()                                  # kills it: the first kill time
    stop()                                  # registered still, on its way out
    ec._unregister_mow_drive(first)
    stop()                                  # gone: no newer drive has started since
    second = FakeProc([])
    ec._register_mow_drive(second)
    stop()                                  # a newer drive: its own kill time
    third = FakeProc([])
    ec._register_mow_drive(third)
    time.sleep(0.002)
    ec._terminate_patrol_drive(third)       # the patrol handler stops its drive (STOP button)
    stop()                                  # and the owner's stop follows
finally:
    restore(real)
    ec.subprocess.run, ec.threading.Thread = real_run, real_thread
    reset_mow_state()
check("a second stop for a drive on its way out keeps the first kill time",
      len(stop_stamps) == 6 and stop_stamps[0] == stop_stamps[1] == stop_stamps[2])
check("a newer drive gets its own kill time", stop_stamps[3] > stop_stamps[0])
check("a stop after the handler stopped the drive itself keeps the handler's kill time",
      stop_stamps[4] == stop_stamps[5] and stop_stamps[4] > stop_stamps[3])

# R6: a status on disk older than 6 h is no patrol of now: no mower_restarted, the file goes
old_file = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
with open(old_file, "w") as fh:
    json.dump({"body": {"phase": "patrolling", "run": "1791"}, "t": time.time() - 6 * 3600 - 60}, fh)
check("a status older than 6 h is not reported after a restart", start_up(old_file) == [])
check("and its file is cleared", not os.path.exists(old_file))

# R9: no patrol while an NTCP edge cut drives on the mower (before the server knows, or started
# straight on /extended): a refusal before anything moved
sent, calls, seen = run(["PHASE patrolling", "PHASE done"], patches={"_edge_cut_running": lambda: True})
check("a patrol is refused while an edge cut runs on the mower",
      sent == [("patrol_respond", {"result": 1, "error": "edge_cut_running"})]
      and "kill_stale" not in seen["events"] and "proc" not in seen)


def proc_root(cmdlines):
    root = tempfile.mkdtemp()
    for pid, argv in cmdlines.items():
        os.makedirs(os.path.join(root, str(pid)))
        with open(os.path.join(root, str(pid), "cmdline"), "wb") as fh:
            fh.write("\0".join(argv).encode())
    return root


EDGE_GOAL = ["timeout", "1800", "ros2", "action", "send_goal", "--feedback", "/navigate_through_coverage_paths",
             "coverage_planner/action/NavigateThroughCoveragePaths", "{only_edge_mode: true}"]
check("the edge cut's goal process counts as an edge cut running",
      ec._edge_cut_running(proc_root=proc_root({4711: EDGE_GOAL})) is True)
quiet = proc_root({4712: ["python3", "/root/novabot/scripts/mow_zone_drive.py", "patrol", "/tmp/p.json"]})
check("a mower without one has none", ec._edge_cut_running(proc_root=quiet) is False)
during = []
edge_cut_start({"mapName": "map0", "departFromDock": True},
               extra={"_depart_pile": lambda *a, **k: during.append(ec._edge_cut_running(proc_root=quiet))})
check("from the start_edge_cut until its goal process exists (the departure) it counts too", during == [True])
check("and once the goal was dispatched only that process counts", ec._edge_cut_running(proc_root=quiet) is False)


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

# Novabot-9ukw: a checkpoint the drive skipped goes out like a skipped zone, with its seq
sent, calls, seen = run(["PHASE patrolling",
                         'SKIPPED {"zone": "map0", "seq": 3, "reason": "checkpoint_unreachable"}',
                         "PHASE done"])
check("forwards a skipped checkpoint with its zone, seq and run",
      ("patrol_skipped", {"zone": "map0", "seq": 3, "reason": "checkpoint_unreachable", "run": "1791"}) in sent)


# ── Headlight during a recharge (Novabot-cwr4) ──────────────────────────────
# Live on LFIN2230700238, 2026-10-15: at headlight 100 the dock's ArUco label
# was overexposed (error 113 "no aruco"), at 30 it was readable. Ruling: while a
# recharge runs (RobotStatus.recharge_status 50 and up, no charging contact) the
# headlight is DOCKING_HEADLIGHT, set once on entering; leaving (below 50, or
# merged_work_status 4) puts back the user's headlight once: the last led_set
# the server sent on novabot/cmd/<SN>, 0 until one came.

def robot_status(recharge, merged=0, error=0):
    """A RobotStatus as the watcher reads it."""
    return types.SimpleNamespace(recharge_status=recharge, merged_work_status=merged, error_status=error)


def scenario(name, fn):
    """check() for a scenario that may raise: an exception is a FAIL, with its text."""
    try:
        ok = bool(fn())
    except Exception as e:
        print(f"     ({type(e).__name__}: {e})")
        ok = False
    check(name, ok)


def quietly(fn):
    """Run fn with ec.log collected instead of printed; (result, lines)."""
    lines, real_log = [], ec.log
    ec.log = lines.append
    try:
        return fn(), lines
    finally:
        ec.log = real_log


def drive(light, *events):
    """Feed the watcher in order: an int is a user led_set from novabot/cmd, a
    tuple a RobotStatus (recharge[, merged[, error]])."""
    for ev in events:
        if isinstance(ev, tuple):
            light.on_status(robot_status(*ev))
        else:
            light.on_user_led(ev)


def lights_for(*events):
    """The levels a fresh watcher publishes for these events, and its log lines."""
    levels = []

    def go():
        drive(ec.RechargeLight(levels.append), *events)
        return levels
    return quietly(go)


scenario("the docking light is 1, the owner's choice", lambda: ec.DOCKING_HEADLIGHT == 1)
scenario("no recharge, no light: idle, docked, cancelled, failed and stopped statuses publish nothing",
         lambda: lights_for(30, (0,), (9, 4), (2,), (1,), (1, 0, 126), (10,), (49,))[0] == [])
scenario("a recharge that starts (50) publishes the docking light once",
         lambda: lights_for(30, (0,), (50,))[0] == [ec.DOCKING_HEADLIGHT])
scenario("its start states and the drive home (90 and up) publish nothing more",
         lambda: lights_for(30, (50,), (57,), (55,), (51,), (53,), (90,), (191,), (192,), (193,), (193,))[0]
         == [ec.DOCKING_HEADLIGHT])
scenario("a recharge first seen mid-dock (191) sets it too",
         lambda: lights_for(30, (191,))[0] == [ec.DOCKING_HEADLIGHT])
scenario("finished (9, docked) puts the user's headlight back once",
         lambda: lights_for(30, (50,), (191,), (9, 4), (9, 4))[0] == [ec.DOCKING_HEADLIGHT, 30])
scenario("failed (1, with an error) puts it back too, and the FAILED that stays adds nothing",
         lambda: lights_for(55, (53,), (192,), (1, 0, 126), (1, 0, 126))[0] == [ec.DOCKING_HEADLIGHT, 55])
scenario("cancelled (2) puts it back",
         lambda: lights_for(20, (50,), (2,))[0] == [ec.DOCKING_HEADLIGHT, 20])
scenario("charging contact ends it while recharge_status still reads 193, and the 9 after it adds nothing",
         lambda: lights_for(20, (193,), (193, 4))[0] == [ec.DOCKING_HEADLIGHT, 20]
         and lights_for(20, (193,), (193, 4), (9, 4))[0] == [ec.DOCKING_HEADLIGHT, 20])
scenario("what comes back is the last user led_set, also one sent during the recharge",
         lambda: lights_for(30, (50,), (9, 4), 100, (50,), 0, (191,), (9, 4))[0]
         == [ec.DOCKING_HEADLIGHT, 30, ec.DOCKING_HEADLIGHT, 0])
scenario("before any user led_set the light goes back to 0",
         lambda: lights_for((53,), (1,))[0] == [ec.DOCKING_HEADLIGHT, 0])
scenario("one log line per transition, none without one",
         lambda: len(lights_for(30, (0,), (50,), (53,), (191,), (9, 4), (9, 4))[1]) == 2)


def failing_publish():
    def boom(level):
        raise RuntimeError("blade relay not up")
    light = ec.RechargeLight(boom)
    drive(light, 30, (50,), (9, 4))
    return light


scenario("a publish that fails never raises, and says so in one line per transition",
         lambda: len(quietly(failing_publish)[1]) == 2
         and all("recharge-light" in line and "publish failed" in line for line in quietly(failing_publish)[1]))


def malformed_status():
    levels = []
    light = ec.RechargeLight(levels.append)
    light.on_status(types.SimpleNamespace())          # a status without its fields
    drive(light, 30, (50,), (9, 4))
    return levels == [ec.DOCKING_HEADLIGHT, 30]


scenario("a malformed status is logged, never raised, and the watcher goes on",
         lambda: len(quietly(malformed_status)[1]) == 3)


def put_back_after(*payloads):
    """What the module's watcher puts back after a recharge, once these
    novabot/cmd payloads came in: (level, log lines)."""
    levels = []
    real = ec._RECHARGE_LIGHT
    ec._RECHARGE_LIGHT = ec.RechargeLight(levels.append)

    def go():
        for payload in payloads:
            ec.note_user_headlight(payload)
        drive(ec._RECHARGE_LIGHT, (50,), (9, 4))
    try:
        _none, lines = quietly(go)
    finally:
        ec._RECHARGE_LIGHT = real
    return levels[-1], lines


scenario("a novabot/cmd led_set is the user's headlight; the last one counts",
         lambda: put_back_after(b'{"led_set": 30}')[0] == 30
         and put_back_after(b'{"led_set": 30}', b'{"led_set": 0}')[0] == 0)
scenario("other novabot/cmd messages and broken ones change nothing and never raise",
         lambda: put_back_after(b'{"led_set": 30}', b'{"blade": 1}', b"not json", b'{"led_set": "x"}',
                                b"[1]", b'{"led_set": null}')[0] == 30)


class WatcherNode:
    """rclpy.node.Node for the watcher: records what it subscribes to."""
    made = []

    def __init__(self, name):
        self.name, self.subs = name, []
        WatcherNode.made.append(self)

    def create_subscription(self, msg_type, topic, callback, qos):
        self.subs.append((topic, msg_type, callback, qos))
        return object()


class WatcherExecutor:
    """The shared executor the blade relay owns: records the nodes added to it."""

    def __init__(self):
        self.nodes = []

    def add_node(self, node):
        self.nodes.append(node)


WATCHER_MODULES = ("rclpy", "rclpy.node", "decision_msgs", "decision_msgs.msg")


def start_watcher(with_rclpy=True, starts=2, then=None):
    """start_recharge_light_watcher `starts` times against fake ROS modules (or
    none), the shared executor ready and a blade relay up; then `then(nodes)`,
    while all that is still in place. Returns the nodes made, the executor, the
    relay and the log lines."""
    mods = {name: types.ModuleType(name) for name in WATCHER_MODULES}
    mods["rclpy.node"].Node = WatcherNode
    mods["decision_msgs.msg"].RobotStatus = type("RobotStatus", (), {})
    if not with_rclpy:
        mods = {name: None for name in WATCHER_MODULES}     # import fails as on a machine without ROS
    saved_mods = {name: sys.modules.get(name, MISSING) for name in WATCHER_MODULES}
    saved = {k: getattr(ec, k, MISSING) for k in ("_RECHARGE_LIGHT", "_RECHARGE_LIGHT_STARTED")}
    executor, relay = WatcherExecutor(), Relay()
    real_exec, real_node, was_ready = ec._ROS_EXECUTOR[0], ec._ROS_BLADE_NODE[0], ec._ROS_EXECUTOR_READY.is_set()
    real_thread = ec.threading.Thread
    WatcherNode.made = []
    sys.modules.update(mods)
    ec._RECHARGE_LIGHT, ec._RECHARGE_LIGHT_STARTED = ec.RechargeLight(ec._relay_headlight), [False]
    ec._ROS_EXECUTOR[0], ec._ROS_BLADE_NODE[0] = executor, relay
    ec._ROS_EXECUTOR_READY.set()
    ec.threading.Thread = SyncThread
    try:
        _none, lines = quietly(lambda: [ec.start_recharge_light_watcher() for _ in range(starts)])
        if then is not None:
            quietly(lambda: then(WatcherNode.made))
    finally:
        ec.threading.Thread = real_thread
        ec._ROS_EXECUTOR[0], ec._ROS_BLADE_NODE[0] = real_exec, real_node
        if not was_ready:
            ec._ROS_EXECUTOR_READY.clear()
        restore(saved)
        for name, module in saved_mods.items():
            if module is MISSING:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
    return WatcherNode.made, executor, relay, lines


def watcher_subscribes_to_robot_status_only():
    nodes, executor, _relay, _lines = start_watcher()
    subs = {topic: qos for topic, _type, _cb, qos in nodes[0].subs}
    return len(nodes) == 1 and executor.nodes == nodes and subs == {"/robot_decision/robot_status": 1}


def watcher_lights_through_the_relay():
    def feed(nodes):
        on_status = nodes[0].subs[0][2]
        ec.note_user_headlight(b'{"led_set": 30}')
        on_status(robot_status(50))
        on_status(robot_status(9, 4))
    _nodes, _executor, relay, _lines = start_watcher(starts=1, then=feed)
    return relay.levels == [ec.DOCKING_HEADLIGHT, 30]


def watcher_without_rclpy():
    nodes, executor, _relay, lines = start_watcher(with_rclpy=False, starts=1)
    return nodes == [] and executor.nodes == [] and any("recharge-light" in line for line in lines)


scenario("the watcher is one node in the shared executor with robot_status at depth 1 and no /led_set "
         "subscription (the firmware's own 2/5/0 there are not the user's); a second start adds nothing",
         watcher_subscribes_to_robot_status_only)
scenario("its callback sets the light through the blade relay's /led_set publisher",
         watcher_lights_through_the_relay)
scenario("without rclpy the watcher logs and stays off, it never raises", watcher_without_rclpy)

CMD_TOPIC, EXTENDED_TOPIC = "novabot/cmd/LFIN2230700238", "novabot/extended/LFIN2230700238"
start_up(patrolling_status_file())
check("main() starts the recharge-light watcher once", WATCHERS_STARTED == ["recharge_light"])
conns = connections(FakeMQTT.events)
check("every connection subscribes novabot/extended/<SN>, then novabot/cmd/<SN>",
      len(conns) == 2 and all([ev[1] for ev in c if ev[0] == "subscribe"] == [EXTENDED_TOPIC, CMD_TOPIC]
                              for c in conns))


def handled(topic, payload):
    """One message through main()'s MQTT handler: the extended commands it
    started, and what the watcher puts back after a recharge that follows."""
    ran, levels = [], []
    real = {"run_extended_command": ec.run_extended_command, "_RECHARGE_LIGHT": ec._RECHARGE_LIGHT}
    real_thread = ec.threading.Thread
    ec.run_extended_command = lambda name, handler, params, respond: ran.append(name)
    ec._RECHARGE_LIGHT = ec.RechargeLight(levels.append)
    ec.threading.Thread = SyncThread
    try:
        quietly(lambda: FakeMQTT.handler(topic, payload))
        quietly(lambda: drive(ec._RECHARGE_LIGHT, (50,), (9, 4)))
    finally:
        ec.threading.Thread = real_thread
        restore(real)
    return ran, levels[-1]


scenario("a led_set on novabot/cmd becomes the user's headlight and runs nothing",
         lambda: handled(CMD_TOPIC, b'{"led_set": 30}') == ([], 30))
scenario("a command on novabot/cmd is never run; the same on novabot/extended is",
         lambda: handled(CMD_TOPIC, b'{"patrol": {}}') == ([], 0)
         and handled(EXTENDED_TOPIC, b'{"patrol": {}}')[0] == ["patrol"])

print(f"\n{sum(checks)}/{len(checks)} checks ok")
raise SystemExit(0 if all(checks) else 1)
