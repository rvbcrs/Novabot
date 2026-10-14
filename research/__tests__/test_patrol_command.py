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
import tempfile

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
    def __init__(self, target=None, daemon=None, name=None):
        self._target = target

    def start(self):
        self._target()


def reset_mow_state():
    """Forget the drive registration and any takeover mark a check left behind."""
    ec._MOW_DRIVE_PROC[0] = None
    if hasattr(ec, "_MOW_DRIVE_SUPERSEDED"):
        ec._MOW_DRIVE_SUPERSEDED[0] = None


def run(lines, rc=0, stopped=False, params=None, patches=None, respond_fails_on=None,
        ignores_terminate=False, proc_class=FakeProc):
    sent, calls, seen = [], [], {}
    cleanups, sleeps = [], []    # nav-goal cleanups (the drive's state then), the guard's pauses
    events = []                  # the stale-run cleanup and every answer (name, phase), in order
    seen.update(cleanups=cleanups, sleeps=sleeps, events=events)
    script = tempfile.NamedTemporaryFile(suffix=".py", delete=False).name
    defaults = {
        "PATROL_DRIVE_SCRIPT": script,
        "_server_from_config": lambda: "srv:8080",
        "_sn_from_config": lambda: "LFIN2230700238",
        "kill_stale_mow_drives": lambda timeout=5.0: events.append("kill_stale") or [],
        "_apply_edge_perception_low": lambda: calls.append("perception_on") or True,
        "_restore_edge_perception": lambda: calls.append("perception_off"),
        "_publish_blade_speed": lambda s: calls.append(("blade_speed", s)) or "",
        "_publish_blade_height": lambda h: calls.append(("blade_height", h)) or "",
        "_stop_mow_zone_cleanup": lambda: cleanups.append((seen["proc"].terminated, seen["proc"].killed)),
        "_ros_env": lambda: {},
    }
    defaults.update(patches or {})
    real = {k: getattr(ec, k) for k in defaults}
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
        for k, v in real.items():
            setattr(ec, k, v)
        ec.subprocess.Popen, ec.threading.Thread = real_popen, real_thread
    return sent, calls, seen


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

print(f"\n{sum(checks)}/{len(checks)} checks ok")
raise SystemExit(0 if all(checks) else 1)
