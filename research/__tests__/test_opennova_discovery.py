#!/usr/bin/env python3
"""Self-check for research/opennova_discovery.py (GH #160, #170).

The loop keeps every server address on the mower pointing at the OpenNova
server. Which server that is, and writing the addresses, is server_address.py
(its own self-check). Here: the loop compares ALL three addresses with the
server found, not only the broker; it switches after two sightings; it
restarts mqtt_node on any change and the helpers when the broker moved; and
it restarts the helpers the way run_novabot.sh starts them.

It used to compare only json_config's broker, so a correct broker next to an
http_address.txt that still said the cloud was never fixed (GH #170).

Run: python3 research/__tests__/test_opennova_discovery.py
"""
import importlib.util
import json
import os
import tempfile
import time
import types
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
RESEARCH = os.path.dirname(HERE)

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print(("ok   " if ok else "FAIL ") + name + (f" | {detail}" if detail else ""))


spec = importlib.util.spec_from_file_location("disc", os.path.join(RESEARCH, "opennova_discovery.py"))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
sa = d.server_address

OLD, NEW, CLOUD = "192.168.178.8", "192.168.178.228", "47.253.145.99"
tmp = Path(tempfile.mkdtemp())
sa.JSON_PATH = tmp / "json_config.json"
sa.HTTP_ADDR_PATH = tmp / "http_address.txt"
sa.SERVER_IP_PATH = tmp / "server_ip.txt"
sa.SENSOR_JSON_PATH = tmp / "sensor.json"


def setup(addr, server_ip, http):
    sa.JSON_PATH.write_text(json.dumps({
        "sn": {"set": 1, "value": {"code": "LFIN2231000451"}},
        "wifi": {"set": 1, "value": {"ssid": "home"}},
        "mqtt": {"set": 1, "value": {"addr": addr, "port": 1883}}}))
    sa.HTTP_ADDR_PATH.write_text(http)
    sa.SERVER_IP_PATH.write_text(server_ip + "\n")


events = []
d.kill_mqtt_node = lambda: events.append("kill_mqtt_node")
d.restart_helpers = lambda: events.append("restart_helpers")


def found(server):
    sa.find_server = lambda state: server


def addresses():
    return (json.loads(sa.JSON_PATH.read_text())["mqtt"]["value"]["addr"],
            sa.HTTP_ADDR_PATH.read_text(), sa.SERVER_IP_PATH.read_text().strip())


# ── The server moved ─────────────────────────────────────────────────────────
setup(OLD, OLD, OLD + ":8080")
found((NEW, 8080))
state = d.new_state()
d.poll_once(state)
check("one sighting is not enough (debounce)", events == [] and addresses()[0] == OLD, events)
d.poll_once(state)
check("second sighting points all three at the new server", addresses() == (NEW, NEW + ":8080", NEW), addresses())
check("  ... keeps the other sections", all(k in json.loads(sa.JSON_PATH.read_text()) for k in ("sn", "wifi")))
check("  ... restarts mqtt_node and, as the broker moved, the helpers",
      events == ["kill_mqtt_node", "restart_helpers"], events)

events.clear()
d.poll_once(state)
check("after the switch everything matches: nothing more happens", events == [], events)

# ── GH #170: broker right, http_address.txt still the cloud ─────────────────
setup(NEW, NEW, CLOUD + ":80")
found((NEW, 80))
state = d.new_state()
d.poll_once(state)
d.poll_once(state)
check("a stale http_address.txt next to a correct broker is fixed", addresses() == (NEW, NEW + ":80", NEW), addresses())
check("  ... mqtt_node restarts (it reads http_address.txt at start), the helpers do not",
      events == ["kill_mqtt_node"], events)

# ── Only autosys_monitor's broker (sensor.json) still the cloud ─────────────
events.clear()
setup(NEW, NEW, NEW + ":80")
sa.SENSOR_JSON_PATH.write_text('{"mqttServer": "tcp://47.253.57.111:1883"}')
found((NEW, 80))
state = d.new_state()
d.poll_once(state)
d.poll_once(state)
check("sensor.json is pointed at the server too", NEW in sa.SENSOR_JSON_PATH.read_text(), sa.SENSOR_JSON_PATH.read_text())
check("  ... without restarting mqtt_node or the helpers (autosys_monitor reads it at boot)", events == [], events)
sa.SENSOR_JSON_PATH.unlink()

# ── No server answers ───────────────────────────────────────────────────────
events.clear()
setup(NEW, NEW, CLOUD + ":80")
found(None)
state = d.new_state()
d.poll_once(state)
d.poll_once(state)
check("no OpenNova server answers: nothing is touched", events == [] and addresses()[1] == CLOUD + ":80", events)

# ── A different server each poll ────────────────────────────────────────────
setup(OLD, OLD, OLD + ":80")
state = d.new_state()
found((NEW, 80))
d.poll_once(state)
found(("192.168.178.9", 80))
d.poll_once(state)
check("two different servers in a row do not switch", events == [] and addresses()[0] == OLD, events)

# ── Restarting the helpers ───────────────────────────────────────────────────
d2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d2)
running = {
    "/root/novabot/scripts/extended_commands.py": [101],
    "/root/novabot/scripts/led_bridge.py": [202],
    "/root/novabot/scripts/start_auto_map.sh": [],
    "/root/novabot/scripts/auto_map_node.py": [],
}
signals, spawned = [], []


def pids_of(pattern):
    return list(running.get(pattern, []))


def send_signal(pid, sig):
    signals.append((pid, sig))
    for p in running.values():
        if pid in p:
            p.remove(pid)


d2.pids_of = pids_of
d2.send_signal = send_signal
d2.spawn_detached = lambda command, log_path: spawned.append((command, str(log_path)))
d2.time = types.SimpleNamespace(sleep=lambda _s: None, monotonic=time.monotonic)
d2.helper_log = lambda name: f"/logs/{name}.log"
d2.restart_helpers()
cmds = {log: cmd for cmd, log in spawned}
check("running helpers are stopped", sorted(p for p, _ in signals) == [101, 202], signals)
check("extended_commands comes back through start_ext.sh (ROS env)",
      "start_ext.sh" in cmds.get("/logs/extended_commands.log", ""), cmds)
led = cmds.get("/logs/led_bridge.log", "")
check("led_bridge comes back with the ROS env of run_novabot.sh",
      "source /opt/ros/galactic/setup.bash" in led and "source /root/novabot/install/setup.bash" in led
      and "ROS_LOCALHOST_ONLY=1" in led and led.rstrip().endswith("/root/novabot/scripts/led_bridge.py"), led)
check("a helper that was not running is not started", "/logs/auto_map_node.log" not in cmds, cmds)

signals.clear()
spawned.clear()
running["/root/novabot/scripts/start_auto_map.sh"] = [303]
running["/root/novabot/scripts/auto_map_node.py"] = [304]
d2.restart_helpers()
cmds = {log: cmd for cmd, log in spawned}
check("auto_map_node: its respawn loop is stopped before the node",
      [p for p, _ in signals] == [303, 304], signals)
check("  ... and start_auto_map.sh is started again",
      "start_auto_map.sh" in cmds.get("/logs/auto_map_node.log", ""), cmds)

stuck = {"/root/novabot/scripts/led_bridge.py": [404]}
signals.clear()
spawned.clear()
d2.pids_of = lambda pattern: list(stuck.get(pattern, []))
d2.send_signal = lambda pid, sig: signals.append((pid, sig))
d2.restart_helpers()
check("a helper that ignores SIGTERM gets SIGKILL",
      [s for _, s in signals] == [d2.signal.SIGTERM, d2.signal.SIGKILL], signals)

# ── spawn_detached / helper_log, for real ──────────────
log_path = tmp / "spawn.log"
d3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d3)
d3.shutil = types.SimpleNamespace(which=lambda _n: None)
d3.spawn_detached("echo started-$((40 + 2))", log_path)
for _ in range(50):
    if log_path.exists() and "started-42" in log_path.read_text():
        break
    time.sleep(0.1)
check("spawn_detached runs the command in the background, output in the log",
      log_path.exists() and "started-42" in log_path.read_text())

ran = []
d3.shutil = types.SimpleNamespace(which=lambda n: "/usr/bin/systemd-run" if n == "systemd-run" else None)
d3.subprocess = types.SimpleNamespace(run=lambda argv, **kw: (ran.append(argv), types.SimpleNamespace(returncode=0))[1],
                                      DEVNULL=-3)
d3.spawn_detached("true", log_path)
check("with systemd-run it starts outside this unit's cgroup (survives a restart of the loop)",
      ran and ran[0][:3] == ["systemd-run", "--scope", "--quiet"], ran)

logs = tmp / "novabot_log"
for boot, age in (("20261020", 100), ("20261022", 10)):
    (logs / boot).mkdir(parents=True)
    f = logs / boot / "led_bridge.log"
    f.write_text("x")
    os.utime(f, (time.time() - age,) * 2)
d3.HELPER_LOG_DIR = str(logs)
check("helper_log appends to this boot's log", d3.helper_log("led_bridge").endswith("20261022/led_bridge.log"),
      d3.helper_log("led_bridge"))


print(f"\n{sum(checks)}/{len(checks)} checks ok")
raise SystemExit(0 if all(checks) else 1)
