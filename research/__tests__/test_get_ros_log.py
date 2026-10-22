#!/usr/bin/env python3
"""Self-check for get_ros_log's extended_commands source.

extended_commands.log is written per boot into novabot_log/<boot>/, not into
ros2_log, so Mower debug could not fetch it and users had nothing to send
(2026-10-22). The source "extended_commands" reads the newest one.
"""
import importlib.util
import os
import tempfile
import time

spec = importlib.util.spec_from_file_location(
    "ec", os.path.join(os.path.dirname(__file__), "..", "extended_commands.py"))
ec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ec)

checks = []


def check(name, ok):
    checks.append(ok)
    print(("ok   " if ok else "FAIL ") + name)


def fetch(params):
    out = []
    ec.handle_get_ros_log(params, lambda name, body: out.append((name, body)))
    return out[0][1]["value"]


root = tempfile.mkdtemp()
ros_dir, boot_dir = os.path.join(root, "ros2_log"), os.path.join(root, "novabot_log")
os.makedirs(ros_dir)
for i, boot in enumerate(["20261019Oct101792418969", "20261021Oct211792588000"]):
    os.makedirs(os.path.join(boot_dir, boot))
    path = os.path.join(boot_dir, boot, "extended_commands.log")
    with open(path, "w") as fh:
        fh.write("".join(f"[EXT-CMD] boot{i} line{n}\n" for n in range(5)))
    os.utime(path, (time.time() - 100 + i * 50,) * 2)
with open(os.path.join(ros_dir, "mqtt_node_1.log"), "w") as fh:
    fh.write("mqtt one\nmqtt two\n")
ec._ROS_LOG_DIR, ec._NOVABOT_LOG_DIR = ros_dir, boot_dir

got = fetch({"source": "extended_commands", "lines": 2})
check("extended_commands reads the newest boot's log", got.get("lines") == ["[EXT-CMD] boot1 line3", "[EXT-CMD] boot1 line4"])
check("and says which file", got.get("file", "").endswith("20261021Oct211792588000/extended_commands.log"))
check("a ROS source still reads ros2_log", fetch({"source": "mqtt", "lines": 5}).get("lines") == ["mqtt one", "mqtt two"])

print(f"\n{sum(checks)}/{len(checks)} checks ok")
raise SystemExit(0 if all(checks) else 1)
