#!/usr/bin/env python3
"""Self-check for research/opennova_discovery.py (GH #160).

The loop is the zero-touch server migration: it follows opennova.local and
must keep doing so. It missed a server that only DNS pointed at, left
server_ip.txt on the old address and restarted only mqtt_node, so
extended_commands.py, led_bridge.py and auto_map_node.py stayed on the old
broker. Now:
  - mDNS first, unchanged: it may replace any address
  - then the DNS redirect of mqtt.lfibot.com, but only for an address this
    firmware wrote itself (stock name, or equal to server_ip.txt) and only to
    a server that answers /api/setup/health as OpenNova
  - a confirmed switch also writes server_ip.txt and restarts the helpers the
    way run_novabot.sh starts them

Run: python3 research/__tests__/test_opennova_discovery.py
"""
import http.server
import importlib.util
import json
import os
import tempfile
import threading
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

OLD, NEW = "192.168.178.8", "192.168.178.228"
tmp = Path(tempfile.mkdtemp())
d.JSON_PATH = tmp / "json_config.json"
d.HTTP_ADDR_PATH = tmp / "http_address.txt"
d.SERVER_IP_PATH = tmp / "server_ip.txt"


def setup(addr, server_ip=OLD, http="opennova.local:80"):
    d.JSON_PATH.write_text(json.dumps({
        "sn": {"set": 1, "value": {"code": "LFIN2231000451"}},
        "wifi": {"set": 1, "value": {"ssid": "home"}},
        "mqtt": {"set": 1, "value": {"addr": addr, "port": 1883}}}))
    d.HTTP_ADDR_PATH.write_text(http)
    if server_ip is None:
        if d.SERVER_IP_PATH.exists():
            d.SERVER_IP_PATH.unlink()
    else:
        d.SERVER_IP_PATH.write_text(server_ip + "\n")


def stub_names(mdns=None, dns=None, opennova=()):
    probed = []
    d.resolve_mdns = lambda hostnames: mdns
    d.resolve_dns = lambda *a, **k: dns

    def answers(ip, ports=None):
        probed.append(ip)
        return ip in opennova
    d.answers_as_opennova = answers
    return probed


# ── Which server ─────────────────────────────────────────────────────────────
setup(OLD)
stub_names(mdns=NEW, dns="10.0.0.9", opennova=("10.0.0.9", NEW))
check("mDNS first", d.find_server(OLD, OLD) == (NEW, "mDNS"), d.find_server(OLD, OLD))

stub_names(mdns=None, dns=NEW, opennova=(NEW,))
check("the issue: mDNS silent, own address, DNS at a new OpenNova -> follow DNS",
      d.find_server(OLD, OLD) == (NEW, "DNS"), d.find_server(OLD, OLD))
check("  ... also for a stock address",
      d.find_server("mqtt.lfibot.com", None) == (NEW, "DNS"))

probed = stub_names(mdns=None, dns=NEW, opennova=(NEW,))
check("DNS never replaces an address set by hand",
      d.find_server("192.168.0.50", OLD) == (None, None) and probed == [], probed)

stub_names(mdns=None, dns="47.254.33.10", opennova=())
check("a DNS answer that is not OpenNova (public lfibot.com) is ignored",
      d.find_server(OLD, OLD) == (None, None))

probed = stub_names(mdns=None, dns=OLD, opennova=())
check("DNS pointing at the current address needs no probe",
      d.find_server(OLD, OLD) == (OLD, "DNS") and probed == [], probed)

stub_names(mdns=NEW, dns=None)
check("mDNS still replaces any address, also one set by hand (unchanged)",
      d.find_server("192.168.0.50", OLD) == (NEW, "mDNS"))

# ── The switch ───────────────────────────────────────────────────────────────
events = []
d.kill_mqtt_node = lambda: events.append("kill_mqtt_node")
d.restart_helpers = lambda: events.append("restart_helpers")

setup(OLD, http="192.168.178.8:8080")
stub_names(mdns=None, dns=NEW, opennova=(NEW,))
state = d.new_state()
d.poll_once(state)
check("one sighting is not enough (debounce)", events == [] and
      json.loads(d.JSON_PATH.read_text())["mqtt"]["value"]["addr"] == OLD, events)
d.poll_once(state)
cfg = json.loads(d.JSON_PATH.read_text())
check("second sighting switches json_config", cfg["mqtt"]["value"]["addr"] == NEW)
check("  ... keeps the other sections", "sn" in cfg and "wifi" in cfg)
check("  ... rewrites http_address.txt", d.HTTP_ADDR_PATH.read_text() == NEW + ":8080")
check("  ... writes server_ip.txt", d.SERVER_IP_PATH.read_text().strip() == NEW)
check("  ... restarts mqtt_node and the helpers", events == ["kill_mqtt_node", "restart_helpers"], events)

events.clear()
d.poll_once(state)
check("after the switch the server matches: nothing more happens", events == [], events)

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

# ── spawn_detached / helper_log / answers_as_opennova, for real ──────────────
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


class Health(http.server.BaseHTTPRequestHandler):
    body = b'{"server":"running","mqtt":"running"}'

    def do_GET(self):
        ok = self.path == "/api/setup/health"
        self.send_response(200 if ok else 404)
        self.end_headers()
        self.wfile.write(self.body if ok else b"nope")

    def log_message(self, *a):
        pass


srv = http.server.HTTPServer(("127.0.0.1", 0), Health)
threading.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]
check("answers_as_opennova: OpenNova's health answer", d3.answers_as_opennova("127.0.0.1", [port]) is True)
Health.body = b"<html>NAS login</html>"
check("answers_as_opennova: some other web server", d3.answers_as_opennova("127.0.0.1", [port]) is False)
srv.shutdown()

d3.HTTP_ADDR_PATH = tmp / "http_address.txt"
d3.HTTP_ADDR_PATH.write_text("opennova.local:8080")
check("probe ports: the one in http_address.txt first", d3.http_ports()[:2] == [8080, 80], d3.http_ports())

print(f"\n{sum(checks)}/{len(checks)} checks ok")
raise SystemExit(0 if all(checks) else 1)
