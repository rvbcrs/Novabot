#!/usr/bin/env python3
"""Self-check for the edge cut safety watch in research/extended_commands.py (#147).

The edge cut is an NTCP goal outside robot_decision. The STOP button only made
the firmware pause its own task and ask for the PIN; after the PIN the mower
drove on cutting the edge. The watch reads /chassis_incident and stops the goal.

Run: python3 research/__tests__/test_edge_cut_safety.py
"""
import importlib.util
import os

spec = importlib.util.spec_from_file_location(
    "ec", os.path.join(os.path.dirname(__file__), "..", "extended_commands.py"))
ec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ec)

# Two messages as `ros2 topic echo /chassis_incident` prints them (trimmed).
QUIET = """stamp:
  sec: 0
  nanosec: 0
event_set_flag: 0
warning_set_flag: 0
warning_push_button_stop: false
error_set_flag: 0
error_push_button_stop: false
error_upraise_stop: false
error_no_pin_code: false
---
"""
STOP = QUIET.replace("error_push_button_stop: false", "error_push_button_stop: true")

checks = []


def check(name, ok):
    checks.append(ok)
    print(("ok   " if ok else "FAIL ") + name)


msgs = list(ec._echo_messages((QUIET + STOP).splitlines(True)))
check("parses one dict per message", len(msgs) == 2 and msgs[0]["error_push_button_stop"] is False)
check("a quiet message is no reason to stop", ec._edge_stop_reason(msgs[0]) is None)
check("the STOP button is", ec._edge_stop_reason(msgs[1]) == "error_push_button_stop")
check("lifting the mower is", ec._edge_stop_reason({"warning_upraise_stop": True}) == "warning_upraise_stop")
check("a PIN lock is", ec._edge_stop_reason({"error_no_pin_code": True}) == "error_no_pin_code")
check("a collision alone is not on the list", ec._edge_stop_reason({"error_collision_stop": True}) is None)


class FakeProc:
    def __init__(self, text, running=True):
        self.stdout = iter(text.splitlines(True))
        self._running = running
        self.killed = False

    def poll(self):
        return None if self._running else 0

    def kill(self):
        self.killed = True


def run_watch(echo_text, edge_running=True):
    calls, responses = [], []
    watcher = FakeProc(echo_text)
    ec.subprocess.Popen, real_popen = (lambda *a, **k: watcher), ec.subprocess.Popen
    ec._kill_ros2_action_clients, real_kill = (lambda: calls.append("kill")), ec._kill_ros2_action_clients
    ec._call_cover_task_stop, real_stop = (lambda: calls.append("cover_task_stop") or "dispatched"), ec._call_cover_task_stop
    try:
        ec._watch_edge_cut_safety(FakeProc("", running=edge_running), lambda name, body: responses.append((name, body)))
    finally:
        ec.subprocess.Popen, ec._kill_ros2_action_clients, ec._call_cover_task_stop = real_popen, real_kill, real_stop
    return calls, responses, watcher


calls, responses, watcher = run_watch(QUIET + QUIET + STOP)
check("STOP during the edge cut kills the goal and stops the planner", calls == ["kill", "cover_task_stop"])
check("and tells the server why", responses == [("edge_cut_stopped", {"reason": "error_push_button_stop"})])
check("the echo process is cleaned up", watcher.killed)

calls, responses, _ = run_watch(QUIET + STOP, edge_running=False)
check("after the edge cut ended a STOP changes nothing", calls == [] and responses == [])

print(f"\n{sum(checks)}/{len(checks)} checks ok")
raise SystemExit(0 if all(checks) else 1)
