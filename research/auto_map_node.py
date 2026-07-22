#!/usr/bin/env python3
"""auto_map_node — orkestratie van de autonome boundary-rit (route B).

Standalone daemon naast extended_commands.py (importeert die als bibliotheek
voor MiniMQTT/read_config/ros2_run — import is bijwerkingsvrij). Luistert op
novabot/extended/<SN> en handelt ALLEEN de auto-map-commando's af:

  start_auto_map_test  {radiusM?, timeoutS?}  — kale volg-test (fase 0) én
                                                de volgmotor tijdens een echte
                                                opname (de server start dan
                                                eerst start_scan_map)
  stop_auto_map        {}                     — cancel de rit
  get_auto_map_status  {}                     — laatste status opvragen

Statusstroom: publiceert auto_map_status-events op
novabot/extended_response/<SN>:
  {"auto_map_status": {"phase": ..., ...}}
met phase ∈ preparing | searching_boundary | following | result | error |
aborted. Bij phase "result" zit er {"code": <int>, "name": <str>} bij.

Zie docs/superpowers/specs/2026-07-22-autonomous-mapping-design.md.
"""
import json
import math
import os
import re
import sys
import threading
import time

DEFAULT_RADIUS_M = 30.0     # geofence-straal vanaf startpositie (spec §4)
DEFAULT_TIMEOUT_S = 1200    # 20 min (spec: result-tabel)
ACTION_LOG = "/tmp/auto_map_action.log"

RESULT_NAMES = {
    0: "LOOP_CLOSED",
    1: "NO_VALID_BOUNDARY",
    2: "CANCELLED",
    3: "FOLLOW_FAILED",
    4: "SEARCHING_START_FAILED",
}


def boundary_goal_yaml():
    """Goal voor `ros2 action send_goal /boundary_follow
    coverage_planner/action/BoundaryFollow` (maart-flow: follow_mode=0,
    start_follow_wait=false; coverage_planner configureert perceptie zelf)."""
    return "{follow_mode: 0, start_follow_wait: false}"


def haversine_m(lat1, lng1, lat2, lng2):
    """Afstand in meters tussen twee WGS84-punten (geofence-check)."""
    if lat1 == lat2 and lng1 == lng2:
        return 0.0
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def parse_action_result(text):
    """Parse `ros2 action send_goal`-uitvoer → (status, result_code).

    Zoekt de LAATSTE `result: <n>` (de goal-echo bevat ook velden) en de
    `Goal finished with status: <STATUS>`-regel. Beide None zolang de action
    nog loopt of de log onvolledig is.
    """
    status = None
    m = re.search(r"Goal finished with status:\s*(\w+)", text)
    if m:
        status = m.group(1)
    codes = re.findall(r"^\s*result:\s*(\d+)\s*$", text, flags=re.MULTILINE)
    code = int(codes[-1]) if codes and status is not None else None
    return status, code


if __name__ == "__main__":
    print("auto_map_node: main() komt in de volgende taak", file=sys.stderr)
    sys.exit(1)
