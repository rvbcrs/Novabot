#!/usr/bin/env python3
"""A stuck mow_zone_drive must be cleared before the next one starts.

This application only gets 4 MB iceoryx chunks, so a run that hangs keeps
every chunk it holds and the next run cannot get a single one: it strands a
metre off the dock with MEPOO__MEMPOOL_GETCHUNK_POOL_IS_RUNNING_OUT_OF_CHUNKS.
Live on LFIN2230700238, 2026-09-14: the 15:13 attempt sat in that loop for ten
minutes and every later attempt failed until it was killed by hand.

The scan reads procfs rather than shelling out to pgrep, because our own argv
carries the script name too and a shell match shoots its own parent - the same
trap as in _restart_novabot_mapping.

Run: python3 research/__tests__/test_stale_mow_drive.py
"""
import importlib.util
import os
import sys
import tempfile
import types

for name in ["rclpy", "rclpy.node", "rclpy.action", "rclpy.qos", "rclpy.time",
             "rcl_interfaces", "rcl_interfaces.srv", "rcl_interfaces.msg",
             "decision_msgs", "decision_msgs.srv", "decision_msgs.msg",
             "std_msgs", "std_msgs.msg", "std_srvs", "std_srvs.srv",
             "geometry_msgs", "geometry_msgs.msg", "sensor_msgs", "sensor_msgs.msg",
             "nav_msgs", "nav_msgs.msg", "nav2_msgs", "nav2_msgs.action",
             "coverage_planner", "coverage_planner.action", "action_msgs",
             "action_msgs.msg", "tf2_ros", "builtin_interfaces",
             "builtin_interfaces.msg", "numpy", "PIL", "PIL.Image", "PIL.ImageDraw"]:
    sys.modules.setdefault(name, types.ModuleType(name))

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "ec", os.path.join(HERE, "..", "extended_commands.py"))
ec = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(ec)
except Exception:
    # extended_commands trekt de halve ROS-stack binnen; voor deze test hebben
    # we alleen de twee pure helpers nodig, dus plukken we ze uit de bron.
    src = open(os.path.join(HERE, "..", "extended_commands.py")).read()
    start = src.index("def find_stale_mow_drives(")
    end = src.index("def kill_stale_mow_drives(")
    ec = types.ModuleType("ec")
    ec.os = os
    exec(compile(src[start:end], "ec", "exec"), ec.__dict__)


def fake_proc(entries):
    """procfs-achtige map: {pid: cmdline}."""
    root = tempfile.mkdtemp()
    for pid, cmd in entries.items():
        d = os.path.join(root, str(pid))
        os.makedirs(d)
        with open(os.path.join(d, "cmdline"), "wb") as fh:
            fh.write(cmd.replace(" ", "\0").encode())
    os.makedirs(os.path.join(root, "self"), exist_ok=True)   # niet-numeriek
    return root


def test_it_finds_a_leftover_run():
    root = fake_proc({
        111: "python3 /root/novabot/scripts/mow_zone_drive.py mow map6 1000000 6 -",
        222: "/usr/bin/irrelevant",
    })
    assert ec.find_stale_mow_drives(root, self_pid=999) == [111]


def test_it_never_reports_itself():
    root = fake_proc({
        111: "python3 /root/novabot/scripts/extended_commands.py mow_zone_drive.py",
    })
    assert ec.find_stale_mow_drives(root, self_pid=111) == []


def test_no_leftovers_is_an_empty_list():
    assert ec.find_stale_mow_drives(fake_proc({222: "/bin/sh"}), self_pid=999) == []


def test_an_unreadable_process_does_not_break_the_scan():
    root = fake_proc({111: "python3 /root/novabot/scripts/mow_zone_drive.py mow map6"})
    os.makedirs(os.path.join(root, "333"))          # geen cmdline erin
    assert ec.find_stale_mow_drives(root, self_pid=999) == [111]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn(); print(f"ok  {name}")
    print("all stale-run checks passed")
