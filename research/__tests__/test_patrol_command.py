#!/usr/bin/env python3
"""Self-check for the `patrol` extended command in research/extended_commands.py.

Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
Run: python3 research/__tests__/test_patrol_command.py
"""
import importlib.util
import json
import os
import tempfile

spec = importlib.util.spec_from_file_location(
    "ec", os.path.join(os.path.dirname(__file__), "..", "extended_commands.py"))
ec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ec)

checks = []


def check(name, ok):
    checks.append(ok)
    print(("ok   " if ok else "FAIL ") + name)


GOOD = {"run": "1791", "zones": [{"zone": "map0", "points": [[1.5, 2.0], [3, 4]]}],
        "dwell_s": 6, "photo_topic": "front"}

clean, err = ec.validate_patrol_params(GOOD)
check("good params pass", err is None and clean["zones"][0]["points"] == [[1.5, 2.0], [3.0, 4.0]])
for bad, why in [
    ({**GOOD, "run": "../x"}, "invalid_run"),
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
    def __init__(self, lines, rc=0, stopped=False):
        self.stdout = iter([line + "\n" for line in lines])
        self.returncode = None
        self._rc, self._stopped = rc, stopped

    def wait(self, timeout=None):
        if self._stopped:
            ec._MOW_DRIVE_STOPPED[0] = True     # as handle_stop_mow_zone does
        self.returncode = self._rc
        return self._rc

    def poll(self):
        return self.returncode


class SyncThread:
    def __init__(self, target=None, daemon=None, name=None):
        self._target = target

    def start(self):
        self._target()


def run(lines, rc=0, stopped=False, params=None):
    sent, calls, seen = [], [], {}
    script = tempfile.NamedTemporaryFile(suffix=".py", delete=False).name
    patches = {
        "PATROL_DRIVE_SCRIPT": script,
        "_server_from_config": lambda: "srv:8080",
        "_sn_from_config": lambda: "LFIN2230700238",
        "kill_stale_mow_drives": lambda timeout=5.0: [],
        "_apply_edge_perception_low": lambda: calls.append("perception_on") or True,
        "_restore_edge_perception": lambda: calls.append("perception_off"),
        "_publish_blade_speed": lambda s: calls.append(("blade_speed", s)) or "",
        "_publish_blade_height": lambda h: calls.append(("blade_height", h)) or "",
        "_ros_env": lambda: {},
    }
    real = {k: getattr(ec, k) for k in patches}
    real_popen, real_thread = ec.subprocess.Popen, ec.threading.Thread

    seen["script"] = script

    def fake_popen(argv, **kw):
        seen["argv"] = argv
        with open(argv[-1]) as fh:
            seen["params"] = json.load(fh)
        seen["params_file"] = argv[-1]
        return FakeProc(lines, rc, stopped)

    for k, v in patches.items():
        setattr(ec, k, v)
    ec.subprocess.Popen, ec.threading.Thread = fake_popen, SyncThread
    try:
        ec.handle_patrol(params or GOOD, lambda name, body: sent.append((name, body)))
    finally:
        for k, v in real.items():
            setattr(ec, k, v)
        ec.subprocess.Popen, ec.threading.Thread = real_popen, real_thread
    return sent, calls, seen


sent, calls, seen = run([
    "LOG map_server reload: ok",
    "PHASE patrolling",
    'CHECKPOINT {"seq": 1, "x": 1.5, "y": 2.0, "frames": 3, "photo": true, "sent": true, "person": 60, "animal": 0}',
    'SKIPPED {"zone": "map6", "reason": "no_route"}',
    "PHASE done",
])
statuses = [b["phase"] for n, b in sent if n == "patrol_status"]
check("answers the start", ("patrol_respond", {"result": 0, "run": "1791"}) in sent)
check("streams the phases", statuses == ["patrolling", "done"])
check("forwards the checkpoint with its run",
      ("patrol_checkpoint", {"seq": 1, "x": 1.5, "y": 2.0, "frames": 3, "photo": True, "sent": True,
                             "person": 60, "animal": 0, "run": "1791"}) in sent)
check("forwards a skipped zone", ("patrol_skipped", {"zone": "map6", "reason": "no_route", "run": "1791"}) in sent)
check("blades off once the patrol starts", calls.count(("blade_speed", 0)) == 1 and ("blade_height", 0) in calls)
check("detection on before, restored after", calls[0] == "perception_on" and calls[-1] == "perception_off")
check("the drive gets the upload address", seen["params"]["upload"]
      == "http://srv:8080/api/nova-file-server/patrol/uploadFrame?sn=LFIN2230700238&run=1791")
check("runs the patrol mode", seen["argv"][3:5] == ["patrol", seen["script"]]
      and 'patrol "$2"' in seen["argv"][2])
check("cleans up the params file", not os.path.exists(seen["params_file"]))

sent, calls, _seen = run(["PHASE patrolling"], rc=-15, stopped=True)
check("a drive killed by stop reports stopped", [b["phase"] for n, b in sent if n == "patrol_status"]
      == ["patrolling", "stopped"])
check("and still restores the detection", calls[-1] == "perception_off")

sent, _calls, _seen = run(["PHASE patrolling"], rc=1)
check("a drive that died says so", ("patrol_status", {"phase": "error", "run": "1791", "error": "drive_exit_1"}) in sent)

sent, _calls, _seen = run([], params={**GOOD, "run": "x"})
check("bad params never start a drive", sent == [("patrol_respond", {"result": 1, "error": "invalid_run"})])

print(f"\n{sum(checks)}/{len(checks)} checks ok")
raise SystemExit(0 if all(checks) else 1)
