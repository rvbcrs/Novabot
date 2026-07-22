# Autonoom karteren (route B) — Implementatieplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De maaier karteert een tuin zonder handmatige boundary-rit: lawn_edge_relay maakt de grasrand zichtbaar als obstakelwand, BoundaryFollow rijdt de rand rond binnen een normale firmware-karteersessie, en de gebruiker beoordeelt de kaart in het dashboard.

**Architectuur:** Twee nieuwe standalone daemons op de maaier (`lawn_edge_relay.py`, `auto_map_node.py`, zelfde patroon als `terrain_scan.py`), OTA-bestendig via `research/build_custom_firmware.sh`. De server orkestreert de firmware-karteersessie (`start_scan_map` … `save_map`) via het bestaande `publishToDevice`/`onDeviceResponse`-kanaal in `server/src/services/autoMap.ts`; het dashboard krijgt een start/voortgang/review-paneel in `MapTab.tsx`.

**Tech Stack:** Python 3 + rclpy + numpy (maaier), TypeScript/Express/vitest (server), React (dashboard).

**Spec:** `docs/superpowers/specs/2026-07-22-autonomous-mapping-design.md`

**Bewuste afwijking van de spec (goedgekeurd bij planreview):** de spec noemt "orkestratie-uitbreiding in `extended_commands.py`". Dit plan zet de maaier-orkestratie in een NIEUWE standalone daemon `research/auto_map_node.py` die `extended_commands.py` als bibliotheek importeert (import is bijwerkingsvrij, bewezen door `research/__tests__/test_extended_helpers.py`). Reden: `research/extended_commands.py` bevat ongecommitte transit-WIP van Ramon die niet meegecommit mag worden; bovendien is een eigen daemon het bewezen patroon (`terrain_scan.py`). De spec-intentie (OTA-bestendige maaier-orkestratie, extended-command-kanaal) blijft volledig overeind: de daemon luistert op hetzelfde `novabot/extended/<SN>`-topic.

## Global Constraints

- **Costmap-parameters ALTIJD runtime** via `ros2 param set /local_costmap/local_costmap obstacle_layer.pointcloud.topic /perception/points_relabeled` — NOOIT via YAML-patches (worden niet geladen bij boot, maart-les).
- **NOOIT zelf `set_semantic_mode`, `set_detection_mode` of obstacle-range-params zetten rond een BoundaryFollow-goal** — `coverage_planner_server` configureert die zelf bij goal-ontvangst; dubbel zetten conflicteert (maart-les).
- **Relay-regel exact:** elk punt met label ≠ 2 (lawn) wordt label 5 (fixed obstacle); publiceren op `/perception/points_relabeled`. Geen N-van-M-filter bouwen tenzij fase 0 het nodig bewijst (YAGNI, spec §1).
- **Preflight:** RTK Fixed (`rtk_fix_quality == 4`) én accu > 40%. Geofence-straal default **30 m**, timeout **20 min (1200 s)**.
- **Result-codes BoundaryFollow:** 0=LOOP_CLOSED (afronden), 1=NO_VALID_BOUNDARY (abort "geen grasrand gevonden op startpunt"), 2=CANCELLED, 3=FOLLOW_FAILED (abort + rapport), 4=SEARCHING_START_FAILED (fase 3: één retry vanaf 2 m verderop), timeout/geofence = stop + `stop_scan_map` ZONDER save.
- **BoundaryFollow-goal:** action `/boundary_follow`, type `coverage_planner/action/BoundaryFollow`, goal `{follow_mode: 0, start_follow_wait: false}`.
- **Firmware-afrondreeks exact** (bewezen BLE-mapping-flow, `docs/reference/MAPPING-FLOW.md`): `stop_scan_map {value:false}` → `save_map {mapName:"map0", type:0}` → `save_recharge_pos {mapName:"map0"}` → ≥500 ms wachten → `save_map {mapName:"map0", type:1}`. Elk commando met `cmd_num: getNextCmdNum(sn)`.
- **OTA-bestendig:** alle maaier-bestanden geïnstalleerd via `research/build_custom_firmware.sh`, autostart-blokken naar het patroon van de terrain_scan-sectie (regels ~1735-1783).
- **Maaier-Python-tests:** plain `python3` + `assert` in `research/__tests__/test_*.py` (geen pytest op de maaier). Module-import moet bijwerkingsvrij zijn (`if __name__ == "__main__"`-guard).
- **Server-tests:** vitest; DB-isolatie komt UITSLUITEND uit `vitest.config.ts` (`test.env.DB_PATH`), NOOIT `process.env.DB_PATH` in setup-files zetten.
- **NOOIT stagen/committen:** `app/src/context/DemoContext.tsx`, `app/src/components/UnicomTransitAnimation.tsx`, `app/src/components/mower/mowerIconPath.ts`, `research/mow_zone_drive.py`, `research/extended_commands.py` (bevatten Ramons transit-WIP). Altijd per-bestand stagen, nooit `git add -A`.
- **NOOIT bewegingscommando's naar een maaier sturen zonder expliciete bevestiging van Ramon.** Veldtests (fase 0-protocol) start Ramon zelf; implementatietaken deployen niets naar een maaier.
- **Dashboard-copy in het Nederlands.** Geen em-dashes in UI-teksten.
- **Perceptiemodel:** hoge-gevoeligheid segmentatie zetten via `ros2 service call /perception/set_infer_model general_msgs/srv/SetUint8 '{value: 3}'` (mode 3 = SEG_HIGH, maart-flow) vóór de goal; dit is de ENIGE perceptie-instelling die wij zetten.

---

## Fase 0 — kale volg-test (go/no-go)

### Task 1: lawn_edge_relay — pure hermapkern + tests

**Files:**
- Create: `research/lawn_edge_relay.py`
- Test: `research/__tests__/test_lawn_edge_relay.py`

**Interfaces:**
- Produces: `relabel(data: bytes) -> bytes` en constants `LAWN_LABEL=2`, `OBSTACLE_LABEL=5`, `POINT_STEP=13`, `LABEL_OFFSET=12`, `SUB_TOPIC="/perception/points_labeled"`, `PUB_TOPIC="/perception/points_relabeled"`. Task 2 bouwt de node-main in ditzelfde bestand.

- [ ] **Step 1: Schrijf de failing test**

`research/__tests__/test_lawn_edge_lay.py` bestaat niet — maak `research/__tests__/test_lawn_edge_relay.py`:

```python
#!/usr/bin/env python3
"""Self-check voor de pure hermapkern van research/lawn_edge_relay.py.
Run: python3 research/__tests__/test_lawn_edge_relay.py"""
import importlib.util, os, struct
import numpy as np

spec = importlib.util.spec_from_file_location(
    "ler", os.path.join(os.path.dirname(__file__), "..", "lawn_edge_relay.py"))
ler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ler)


def make_buf(points):
    """points = [(x, y, z, label), ...] → packed 13B/punt buffer."""
    out = b""
    for x, y, z, lab in points:
        out += struct.pack("<fffB", x, y, z, lab)
    return out


def test_relabel_non_lawn_to_obstacle():
    buf = make_buf([(1.0, 2.0, 0.1, 2),    # lawn → blijft 2
                    (1.5, 2.0, 0.2, 1),    # background → 5
                    (2.0, 2.0, 0.3, 8),    # bush → 5
                    (2.5, 2.0, 0.0, 2)])   # lawn → blijft 2
    out = ler.relabel(buf)
    labels = np.frombuffer(out, dtype=np.uint8)[ler.LABEL_OFFSET::ler.POINT_STEP]
    assert list(labels) == [2, 5, 5, 2], labels


def test_relabel_preserves_xyz():
    buf = make_buf([(1.25, -3.5, 0.75, 11)])
    out = ler.relabel(buf)
    x, y, z, lab = struct.unpack("<fffB", out)
    assert (x, y, z) == (1.25, -3.5, 0.75)
    assert lab == 5


def test_relabel_bad_stride_passthrough():
    buf = b"\x00" * 14  # geen veelvoud van 13 → ongewijzigd terug
    assert ler.relabel(buf) == buf


def test_relabel_empty():
    assert ler.relabel(b"") == b""


if __name__ == "__main__":
    test_relabel_non_lawn_to_obstacle()
    test_relabel_preserves_xyz()
    test_relabel_bad_stride_passthrough()
    test_relabel_empty()
    print("OK - alle lawn_edge_relay kern-tests geslaagd")
```

- [ ] **Step 2: Run de test, verwacht falen**

Run: `python3 research/__tests__/test_lawn_edge_relay.py`
Verwacht: FAIL (`FileNotFoundError` of `AttributeError` — lawn_edge_relay.py bestaat nog niet).

- [ ] **Step 3: Schrijf de minimale kern**

Maak `research/lawn_edge_relay.py`:

```python
#!/usr/bin/env python3
"""lawn_edge_relay — grasrand als obstakelwand voor de costmap.

Abonneert op /perception/points_labeled (packed 13 B/punt: x,y,z float32 +
label uint8, zelfde layout als terrain_scan.py), hermapt ELK punt dat niet
label 2 (lawn) is naar label 5 (fixed obstacle) en publiceert het resultaat
op /perception/points_relabeled. De SemanticObstacleLayer ziet daardoor de
gras-rand als boundary, ongeacht of het heg, border, stoep of zand is
(de heg-als-background-zwakte uit maart 2026 wordt irrelevant).

Onderdeel van autonoom karteren route B, zie
docs/superpowers/specs/2026-07-22-autonomous-mapping-design.md.

Run (op de maaier, via start_lawn_relay.sh voor de ROS-env):
    python3 /root/novabot/scripts/lawn_edge_relay.py
"""
import sys
import time

import numpy as np

LAWN_LABEL = 2       # infer_class.json: 2 = lawn (enige betrouwbare label)
OBSTACLE_LABEL = 5   # 5 = fixed obstacle → SemanticObstacleLayer boundary
POINT_STEP = 13      # x,y,z float32 + label uint8
LABEL_OFFSET = 12
SUB_TOPIC = "/perception/points_labeled"
PUB_TOPIC = "/perception/points_relabeled"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def relabel(data):
    """Packed labeled-buffer → zelfde buffer met alle niet-gras-labels op 5.

    Onverwachte stride (geen veelvoud van 13) → ongewijzigd doorgeven, zodat
    een firmware-wijziging in het puntformaat nooit corrupte clouds oplevert.
    """
    if not data or len(data) % POINT_STEP != 0:
        return bytes(data)
    arr = np.frombuffer(data, dtype=np.uint8).copy()
    labels = arr[LABEL_OFFSET::POINT_STEP]
    labels[labels != LAWN_LABEL] = OBSTACLE_LABEL
    return arr.tobytes()


if __name__ == "__main__":
    from lawn_edge_relay_main import main  # placeholder tot Task 2; zie Step 3 daar
    sys.exit(main())
```

Let op: de laatste drie regels (`if __name__ …`) zijn tijdelijk en worden in Task 2 vervangen door de echte `main()` in ditzelfde bestand. De tests raken ze niet (import loopt niet door de guard).

- [ ] **Step 4: Run de test, verwacht slagen**

Run: `python3 research/__tests__/test_lawn_edge_relay.py`
Verwacht: `OK - alle lawn_edge_relay kern-tests geslaagd`

- [ ] **Step 5: Commit**

```bash
git add research/lawn_edge_relay.py research/__tests__/test_lawn_edge_relay.py
git commit -m "automap: lawn_edge_relay hermapkern (niet-gras -> obstakel) + self-tests"
```

---

### Task 2: lawn_edge_relay — rclpy-node + startscript

**Files:**
- Modify: `research/lawn_edge_relay.py` (vervang de tijdelijke `__main__`-regels)
- Create: `research/start_lawn_relay.sh`

**Interfaces:**
- Consumes: `relabel()` en de constants uit Task 1.
- Produces: draaiende node `lawn_edge_relay` die op `PUB_TOPIC` publiceert. Task 4 (auto_map_node) verifieert het bestaan van die publisher; Task 5 installeert beide bestanden.

- [ ] **Step 1: Vervang de tijdelijke main door de echte node**

Vervang in `research/lawn_edge_relay.py` het blok

```python
if __name__ == "__main__":
    from lawn_edge_relay_main import main  # placeholder tot Task 2; zie Step 3 daar
    sys.exit(main())
```

door:

```python
def main():
    import rclpy
    from rclpy.node import Node
    from sensor_msgs.msg import PointCloud2

    rclpy.init()
    node = Node("lawn_edge_relay")
    pub = node.create_publisher(PointCloud2, PUB_TOPIC, 5)
    stats = {"in": 0, "out": 0, "bad": 0, "last_log": time.monotonic()}

    def on_labeled(msg):
        stats["in"] += 1
        if msg.point_step != POINT_STEP:
            # Onbekend formaat: ongewijzigd doorgeven zodat de costmap niet
            # blind wordt, maar wel tellen zodat het in de log opvalt.
            stats["bad"] += 1
            pub.publish(msg)
        else:
            msg.data = relabel(bytes(msg.data))
            pub.publish(msg)
        stats["out"] += 1
        now = time.monotonic()
        if now - stats["last_log"] >= 60.0:
            log(f"relay: in={stats['in']} out={stats['out']} bad_stride={stats['bad']}")
            stats["last_log"] = now

    node.create_subscription(PointCloud2, SUB_TOPIC, on_labeled, 5)
    log(f"lawn_edge_relay actief: {SUB_TOPIC} -> {PUB_TOPIC}")
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run de bestaande tests opnieuw (import moet bijwerkingsvrij blijven)**

Run: `python3 research/__tests__/test_lawn_edge_relay.py`
Verwacht: `OK - alle lawn_edge_relay kern-tests geslaagd` (rclpy wordt pas in `main()` geïmporteerd, dus de test draait ook op de Mac zonder ROS).

- [ ] **Step 3: Maak het startscript naar het terrain-patroon**

```bash
sed 's/terrain_scan\.py/lawn_edge_relay.py/g' research/start_terrain.sh > research/start_lawn_relay.sh
chmod +x research/start_lawn_relay.sh
```

Controleer daarna met `cat research/start_lawn_relay.sh` dat het script de ROS-omgeving sourcet en eindigt met het starten van `lawn_edge_relay.py`. Er mag geen `terrain` meer in voorkomen: `grep -c terrain research/start_lawn_relay.sh` → `0`.

- [ ] **Step 4: Commit**

```bash
git add research/lawn_edge_relay.py research/start_lawn_relay.sh
git commit -m "automap: lawn_edge_relay rclpy-node + startscript"
```

---

### Task 3: auto_map_node — pure helpers + tests

**Files:**
- Create: `research/auto_map_node.py`
- Test: `research/__tests__/test_auto_map_node.py`

**Interfaces:**
- Produces (voor Task 4 en Task 10, zelfde bestand):
  - `boundary_goal_yaml() -> str` — CLI-goal voor `ros2 action send_goal`
  - `haversine_m(lat1, lng1, lat2, lng2) -> float` — afstand in meters
  - `parse_action_result(text) -> (status: str|None, code: int|None)` — parse van `ros2 action send_goal`-output
  - `RESULT_NAMES: dict[int, str]` — {0:"LOOP_CLOSED", 1:"NO_VALID_BOUNDARY", 2:"CANCELLED", 3:"FOLLOW_FAILED", 4:"SEARCHING_START_FAILED"}
  - constants `DEFAULT_RADIUS_M = 30.0`, `DEFAULT_TIMEOUT_S = 1200`, `ACTION_LOG = "/tmp/auto_map_action.log"`

- [ ] **Step 1: Schrijf de failing test**

Maak `research/__tests__/test_auto_map_node.py`:

```python
#!/usr/bin/env python3
"""Self-check voor de pure helpers van research/auto_map_node.py.
Run: python3 research/__tests__/test_auto_map_node.py"""
import importlib.util, math, os

spec = importlib.util.spec_from_file_location(
    "amn", os.path.join(os.path.dirname(__file__), "..", "auto_map_node.py"))
amn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(amn)


def test_goal_yaml():
    y = amn.boundary_goal_yaml()
    assert "follow_mode: 0" in y, y
    assert "start_follow_wait: false" in y, y


def test_haversine_known_distance():
    # 0.001 graad breedte ≈ 111.19 m
    d = amn.haversine_m(52.0, 5.0, 52.001, 5.0)
    assert abs(d - 111.19) < 0.5, d
    assert amn.haversine_m(52.0, 5.0, 52.0, 5.0) == 0.0


def test_parse_action_result_success():
    text = (
        "Waiting for an action server to become available...\n"
        "Sending goal:\n     follow_mode: 0\n\n"
        "Goal accepted with ID: c3d4\n\n"
        "Result:\n    result: 0\n\n"
        "Goal finished with status: SUCCEEDED\n")
    status, code = amn.parse_action_result(text)
    assert status == "SUCCEEDED"
    assert code == 0


def test_parse_action_result_follow_failed():
    text = "Result:\n    result: 3\n\nGoal finished with status: ABORTED\n"
    status, code = amn.parse_action_result(text)
    assert status == "ABORTED"
    assert code == 3
    assert amn.RESULT_NAMES[code] == "FOLLOW_FAILED"


def test_parse_action_result_incomplete():
    assert amn.parse_action_result("Waiting for an action server...") == (None, None)


if __name__ == "__main__":
    test_goal_yaml()
    test_haversine_known_distance()
    test_parse_action_result_success()
    test_parse_action_result_follow_failed()
    test_parse_action_result_incomplete()
    print("OK - alle auto_map_node helper-tests geslaagd")
```

- [ ] **Step 2: Run de test, verwacht falen**

Run: `python3 research/__tests__/test_auto_map_node.py`
Verwacht: FAIL (auto_map_node.py bestaat nog niet).

- [ ] **Step 3: Schrijf de helpers**

Maak `research/auto_map_node.py`:

```python
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
```

- [ ] **Step 4: Run de test, verwacht slagen**

Run: `python3 research/__tests__/test_auto_map_node.py`
Verwacht: `OK - alle auto_map_node helper-tests geslaagd`

- [ ] **Step 5: Commit**

```bash
git add research/auto_map_node.py research/__tests__/test_auto_map_node.py
git commit -m "automap: auto_map_node pure helpers (goal-yaml, haversine, result-parse) + tests"
```

---

### Task 4: auto_map_node — daemon (MQTT-loop, prepare, watchdog, status)

**Files:**
- Modify: `research/auto_map_node.py` (vervang het `__main__`-blok, voeg de daemon toe)
- Create: `research/start_auto_map.sh`

**Interfaces:**
- Consumes: helpers uit Task 3; uit `extended_commands.py` (zelfde map): `read_config() -> (sn, addr, port)`, `class MiniMQTT(broker_host, broker_port, client_id, on_message)` met `.connect() .subscribe(topic) .publish(topic, payload_str) .loop_forever()`, `ros2_run(cmd_list, timeout)`, `log(msg)`.
- Produces: MQTT-commando's `start_auto_map_test` / `stop_auto_map` / `get_auto_map_status` en het `auto_map_status`-eventformaat waar Task 7 (server) op matcht:
  - `{"auto_map_status": {"phase": "preparing"|"searching_boundary"|"following"|"result"|"error"|"aborted", "code"?: int, "name"?: str, "error"?: str, "elapsed_s"?: int, "dist_m"?: float}}`
  - `{"start_auto_map_test_respond": {"result": 0|1, "error"?: str}}`
  - `{"stop_auto_map_respond": {"result": 0}}`
  - `{"get_auto_map_status_respond": {...laatste status...}}`

- [ ] **Step 1: Voeg de daemon toe**

Vervang in `research/auto_map_node.py` het `__main__`-blok door onderstaande code (boven het blok invoegen, `__main__` roept `main()` aan):

```python
# ── Daemon ───────────────────────────────────────────────────────────────────
# extended_commands.py als bibliotheek: MiniMQTT, read_config, ros2_run, log.
# Import is bijwerkingsvrij (alles achter __main__-guard), bewezen door
# research/__tests__/test_extended_helpers.py.
_EC = None


def _ec():
    global _EC
    if _EC is None:
        import importlib.util
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "extended_commands.py")
        spec = importlib.util.spec_from_file_location("ec_lib", p)
        _EC = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_EC)
    return _EC


class AutoMapSession:
    """Eén rit. State + watchdog. Thread-safe via één lock."""

    def __init__(self, publish_status, radius_m, timeout_s):
        self.publish_status = publish_status   # dict -> None (MQTT publish)
        self.radius_m = radius_m
        self.timeout_s = timeout_s
        self.lock = threading.Lock()
        self.last_status = {"phase": "idle"}
        self.stop_requested = False
        self.start_gps = None                  # (lat, lng) bij start
        self.last_gps = None
        self.started = time.monotonic()

    def status(self, phase, **extra):
        st = {"phase": phase, "elapsed_s": int(time.monotonic() - self.started)}
        st.update(extra)
        with self.lock:
            self.last_status = st
        self.publish_status(st)


def _relay_alive(ec):
    """Is lawn_edge_relay actief? Check publisher-count op het relay-topic."""
    r = ec.ros2_run(["ros2", "topic", "info", "/perception/points_relabeled"], timeout=15)
    return r.returncode == 0 and "Publisher count: 0" not in (r.stdout or "")


def _set_costmap_topic(ec):
    """Runtime costmap-param (NOOIT YAML, maart-les). Verifieer met param get."""
    ec.ros2_run(["ros2", "param", "set", "/local_costmap/local_costmap",
                 "obstacle_layer.pointcloud.topic", "/perception/points_relabeled"],
                timeout=20)
    r = ec.ros2_run(["ros2", "param", "get", "/local_costmap/local_costmap",
                     "obstacle_layer.pointcloud.topic"], timeout=20)
    return "points_relabeled" in (r.stdout or "")


def _cancel_follow(ec):
    """Zelfde stop-pad als stop_boundary_follow in extended_commands:
    cover_task_stop cancelt BoundaryFollow, plus kill van de CLI-client."""
    ec.ros2_run(["ros2", "service", "call", "/coverage_planner_server/cover_task_stop",
                 "std_srvs/srv/SetBool", "'{data: true}'"], timeout=15)
    os.system("pkill -f 'ros2 action send_goal /boundary_follow' 2>/dev/null")


def _run_session(sess, ec):
    """Prepare → goal → watchdog. Draait in eigen thread."""
    import subprocess
    sess.status("preparing")

    if not _relay_alive(ec):
        sess.status("error", error="relay_missing")
        return
    if not _set_costmap_topic(ec):
        sess.status("error", error="costmap_param_failed")
        return

    # Enige perceptie-instelling die wij zetten: SEG_HIGH (mode 3, maart-flow).
    # coverage_planner_server regelt semantic/detection-mode ZELF bij de goal.
    ec.ros2_run(["ros2", "service", "call", "/perception/set_infer_model",
                 "general_msgs/srv/SetUint8", "'{value: 3}'"], timeout=15)

    # GPS-volger voor de geofence: één achtergrond-subscription op NavSatFix.
    _start_gps_watch(sess)
    deadline = time.monotonic() + 30
    while sess.start_gps is None and time.monotonic() < deadline:
        time.sleep(0.5)
    if sess.start_gps is None:
        sess.status("error", error="no_gps_fix")
        return

    # BoundaryFollow-goal via CLI, output naar ACTION_LOG voor result-parse.
    try:
        os.unlink(ACTION_LOG)
    except OSError:
        pass
    with open(ACTION_LOG, "w") as logf:
        proc = subprocess.Popen(
            ["ros2", "action", "send_goal", "/boundary_follow",
             "coverage_planner/action/BoundaryFollow", boundary_goal_yaml()],
            stdout=logf, stderr=subprocess.STDOUT)
    sess.status("searching_boundary")

    following_reported = False
    while True:
        time.sleep(2.0)
        elapsed = time.monotonic() - sess.started
        if sess.stop_requested:
            _cancel_follow(ec)
            proc.wait(timeout=15)
            sess.status("aborted", error="user_stop")
            return
        if elapsed > sess.timeout_s:
            _cancel_follow(ec)
            proc.wait(timeout=15)
            sess.status("aborted", error="timeout")
            return
        if sess.last_gps and sess.start_gps:
            d = haversine_m(sess.start_gps[0], sess.start_gps[1],
                            sess.last_gps[0], sess.last_gps[1])
            if d > sess.radius_m:
                _cancel_follow(ec)
                proc.wait(timeout=15)
                sess.status("aborted", error="geofence", dist_m=round(d, 1))
                return
            if not following_reported and elapsed > 10:
                following_reported = True
                sess.status("following", dist_m=round(d, 1))
        if proc.poll() is not None:
            try:
                with open(ACTION_LOG) as f:
                    text = f.read()
            except OSError:
                text = ""
            status, code = parse_action_result(text)
            if code is None:
                sess.status("error", error=f"action_exit_{proc.returncode}_no_result")
            else:
                sess.status("result", code=code,
                            name=RESULT_NAMES.get(code, f"code_{code}"))
            return


def _start_gps_watch(sess):
    """NavSatFix-subscriber in eigen thread (patroon: calibration-drive in
    extended_commands). Vult sess.start_gps (eerste fix) en sess.last_gps."""
    def _spin():
        try:
            import rclpy
            from rclpy.node import Node
            from sensor_msgs.msg import NavSatFix
            try:
                rclpy.init()
            except RuntimeError:
                pass
            node = Node("auto_map_gps_watch")

            def on_fix(msg):
                if msg.latitude == 0.0 and msg.longitude == 0.0:
                    return
                if sess.start_gps is None:
                    sess.start_gps = (msg.latitude, msg.longitude)
                sess.last_gps = (msg.latitude, msg.longitude)

            node.create_subscription(NavSatFix, "/gps/fix", on_fix, 5)
            while not sess.stop_requested and sess.last_status.get("phase") not in (
                    "result", "error", "aborted"):
                rclpy.spin_once(node, timeout_sec=1.0)
            node.destroy_node()
        except Exception as ex:
            _ec().log(f"[auto_map] gps watch dood: {ex}")
    threading.Thread(target=_spin, daemon=True).start()


def main():
    ec = _ec()
    sn, addr, port = ec.read_config()
    sub_topic = f"novabot/extended/{sn}"
    resp_topic = f"novabot/extended_response/{sn}"
    ec.log(f"[auto_map] SN={sn} MQTT={addr}:{port} sub={sub_topic}")

    state = {"session": None, "client": None}

    def publish_status(st):
        c = state["client"]
        if c:
            c.publish(resp_topic, json.dumps({"auto_map_status": st}))

    def respond(key, payload):
        c = state["client"]
        if c:
            c.publish(resp_topic, json.dumps({key: payload}))

    def on_message(topic, payload):
        try:
            cmd = json.loads(payload)
        except (ValueError, TypeError):
            return
        if "start_auto_map_test" in cmd:
            params = cmd.get("start_auto_map_test") or {}
            sess = state["session"]
            if sess and sess.last_status.get("phase") in (
                    "preparing", "searching_boundary", "following"):
                respond("start_auto_map_test_respond",
                        {"result": 1, "error": "already_running"})
                return
            try:
                radius = float(params.get("radiusM", DEFAULT_RADIUS_M))
                timeout = int(params.get("timeoutS", DEFAULT_TIMEOUT_S))
            except (TypeError, ValueError) as ex:
                respond("start_auto_map_test_respond",
                        {"result": 1, "error": f"param type error: {ex}"})
                return
            radius = max(5.0, min(200.0, radius))
            timeout = max(60, min(3600, timeout))
            sess = AutoMapSession(publish_status, radius, timeout)
            state["session"] = sess
            threading.Thread(target=_run_session, args=(sess, ec), daemon=True).start()
            respond("start_auto_map_test_respond", {"result": 0})
        elif "stop_auto_map" in cmd:
            sess = state["session"]
            if sess:
                sess.stop_requested = True
            respond("stop_auto_map_respond", {"result": 0})
        elif "get_auto_map_status" in cmd:
            sess = state["session"]
            respond("get_auto_map_status_respond",
                    sess.last_status if sess else {"phase": "idle"})
        # Alle andere commando's zijn voor extended_commands.py — negeren.

    while True:
        try:
            client = ec.MiniMQTT(addr, port, f"auto_map_{sn}", on_message)
            client.connect()
            client.subscribe(sub_topic)
            state["client"] = client
            ec.log("[auto_map] verbonden, wacht op commando's")
            client.loop_forever()
        except Exception as ex:
            ec.log(f"[auto_map] MQTT-verbinding weg ({ex}), retry in 10 s")
            time.sleep(10)


if __name__ == "__main__":
    sys.exit(main())
```

Verificatie vooraf (implementeersteun, geen speculatie): het NavSatFix-topic is op de maaier te bevestigen met `sshpass -p novabot ssh root@192.168.0.100 "source /opt/tros/setup.bash 2>/dev/null; ros2 topic list | grep -i 'fix\|gps'"` — pas `/gps/fix` in `_start_gps_watch` aan als het werkelijke topic anders heet (bijv. `/fix` of `/gnss/fix`). Zet het gevonden topic ook in het commit-bericht.

- [ ] **Step 2: Run de helper-tests opnieuw (import moet bijwerkingsvrij blijven)**

Run: `python3 research/__tests__/test_auto_map_node.py && python3 research/__tests__/test_lawn_edge_relay.py`
Verwacht: beide `OK`. (De daemon-code importeert rclpy/extended_commands alleen binnen functies.)

- [ ] **Step 3: Syntaxcheck**

Run: `python3 -m py_compile research/auto_map_node.py && echo COMPILE_OK`
Verwacht: `COMPILE_OK`

- [ ] **Step 4: Maak het startscript**

```bash
sed 's/terrain_scan\.py/auto_map_node.py/g' research/start_terrain.sh > research/start_auto_map.sh
chmod +x research/start_auto_map.sh
grep -c terrain research/start_auto_map.sh   # verwacht: 0
```

- [ ] **Step 5: Commit**

```bash
git add research/auto_map_node.py research/start_auto_map.sh
git commit -m "automap: auto_map_node daemon - prepare, BoundaryFollow-goal, geofence-watchdog, statusstroom"
```

---

### Task 5: build_custom_firmware.sh-integratie + fase-0 veldtestprotocol

**Files:**
- Modify: `research/build_custom_firmware.sh` (nieuwe sectie direct NA de terrain_scan-sectie, ~regel 1783)
- Create: `research/documents/auto-map-fase0-protocol.md`

**Interfaces:**
- Consumes: `research/lawn_edge_relay.py`, `research/start_lawn_relay.sh`, `research/auto_map_node.py`, `research/start_auto_map.sh` (Tasks 1-4).
- Produces: custom firmware waarin beide daemons meereizen en na boot starten (OTA-bestendig, spec §5).

- [ ] **Step 1: Lees de terrain_scan-sectie als sjabloon**

Run: `sed -n '1730,1790p' research/build_custom_firmware.sh`
Noteer exact: (a) hoe bestanden naar `$NOVABOT_ROOT/scripts/` gekopieerd worden, (b) hoe het autostart-blok in het start-service-script geïnjecteerd wordt (incl. het respawn/killall-patroon en `$LOGS_PATH`), (c) de "niet gevonden — overslaan"-fallback.

- [ ] **Step 2: Voeg de auto-map-sectie toe**

Direct na de terrain_scan-sectie (na de `fi` op ~regel 1783), naar exact hetzelfde patroon dat je in Step 1 zag, met deze invulling:

```bash
# ─── Autonoom karteren (route B): lawn_edge_relay + auto_map_node ───────────
# Zie docs/superpowers/specs/2026-07-22-autonomous-mapping-design.md
RELAY_SRC="$SCRIPT_DIR/lawn_edge_relay.py"
AUTOMAP_SRC="$SCRIPT_DIR/auto_map_node.py"
if [ -f "$RELAY_SRC" ] && [ -f "$AUTOMAP_SRC" ] \
   && [ -f "$SCRIPT_DIR/start_lawn_relay.sh" ] && [ -f "$SCRIPT_DIR/start_auto_map.sh" ]; then
    cp "$RELAY_SRC" "$NOVABOT_ROOT/scripts/lawn_edge_relay.py"
    cp "$AUTOMAP_SRC" "$NOVABOT_ROOT/scripts/auto_map_node.py"
    cp "$SCRIPT_DIR/start_lawn_relay.sh" "$NOVABOT_ROOT/scripts/start_lawn_relay.sh"
    cp "$SCRIPT_DIR/start_auto_map.sh" "$NOVABOT_ROOT/scripts/start_auto_map.sh"
    chmod +x "$NOVABOT_ROOT/scripts/"{lawn_edge_relay.py,auto_map_node.py,start_lawn_relay.sh,start_auto_map.sh}
    echo "  lawn_edge_relay + auto_map_node gekopieerd naar scripts/"
    # autostart-blok: kopieer het terrain_scan-injectiepatroon 1-op-1, met
    # twee entries (start_lawn_relay.sh -> lawn_edge_relay.log,
    # start_auto_map.sh -> auto_map_node.log)
else
    echo "  lawn_edge_relay/auto_map_node niet compleet — overslaan"
fi
```

Het autostart-commentaar hierboven is een aanwijzing, geen placeholder: neem het werkelijke injectieblok uit Step 1 over (zelfde heredoc/`sed -i`-mechaniek, zelfde killall-respawn-afhandeling) en vul de twee scriptnamen en lognamen in. Voeg ook een regel toe aan de feature-samenvatting onderaan het script (patroon regel ~2361):

```bash
[ -f "$NOVABOT_ROOT/scripts/auto_map_node.py" ] && echo "    ✓ Autonoom karteren (fase 0): lawn_edge_relay + auto_map_node"
```

- [ ] **Step 3: Shellcheck-niveau verificatie zonder build**

Run: `bash -n research/build_custom_firmware.sh && echo SYNTAX_OK`
Verwacht: `SYNTAX_OK`. (Een echte firmwarebuild is een release-handeling en gebeurt alleen op Ramons verzoek via het genoemde script.)

- [ ] **Step 4: Schrijf het veldtestprotocol**

Maak `research/documents/auto-map-fase0-protocol.md`:

```markdown
# Fase 0 veldtest — kale volg-test (go/no-go voor route B)

**Doel:** meten hoe ver BoundaryFollow met lawn_edge_relay komt langs de
randtypes van het testgazon. Succescriterium (spec): ≥1 volledige ronde om
het testgazon zonder FOLLOW_FAILED. Structureel falen → route A.

## Voorbereiding (eenmalig, door Ramon gestart)
1. Custom firmware met auto-map-sectie op de testmaaier (build via
   ./research/build_custom_firmware.sh, flash via normale OTA-flow), OF
   handmatig voor een snelle iteratie:
   scp research/lawn_edge_relay.py research/auto_map_node.py \
       research/start_lawn_relay.sh research/start_auto_map.sh \
       root@192.168.0.100:/root/novabot/scripts/
2. Daemons starten (ROS-env verplicht, NOOIT kaal python3):
   ssh root@192.168.0.100 "(nohup /root/novabot/scripts/start_lawn_relay.sh \
       >> /userdata/lfi/log/lawn_edge_relay.log 2>&1 &)"
   ssh root@192.168.0.100 "(nohup /root/novabot/scripts/start_auto_map.sh \
       >> /userdata/lfi/log/auto_map_node.log 2>&1 &)"
3. Check relay: ros2 topic hz /perception/points_relabeled (verwacht ~5 Hz
   zodra perceptie draait).

## Testrit (maaier midden op het gras, NIET op de dock)
Start via MQTT (server of mosquitto_pub op de broker):
  topic:   novabot/extended/<SN>
  payload: {"start_auto_map_test": {"radiusM": 30, "timeoutS": 1200}}
Stop:      {"stop_auto_map": {}}
Status:    {"get_auto_map_status": {}}
Volg auto_map_status-events op novabot/extended_response/<SN>.

## Meetformulier (per poging invullen)
| # | Startpunt | Randtype bereikt | Afstand/duur | Result-code | Notities |
|---|-----------|------------------|--------------|-------------|----------|
Randtypes van het testgazon: heg, border, stoeprand, zandbak-overgang
(= maart-breekpunt), schutting.

## Uitkomst
- ≥1 volledige ronde zonder FOLLOW_FAILED → GO voor fase 1.
- Structureel FOLLOW_FAILED op hetzelfde randtype → log + laatste positie
  documenteren; beslissing route A (spec: gedocumenteerd vangnet).
```

- [ ] **Step 5: Commit**

```bash
git add research/build_custom_firmware.sh research/documents/auto-map-fase0-protocol.md
git commit -m "automap: OTA-bestendige install in build_custom_firmware.sh + fase-0 veldtestprotocol"
```

**LET OP:** hierna is fase 0 bouwtechnisch klaar. De veldtest zelf (go/no-go) doet Ramon; fase 1-3 hieronder mag alvast gebouwd worden (server/dashboard-werk is route-onafhankelijk herbruikbaar richting route A op de review-flow na de volgmotor).

---

## Fase 1 — opname + afronding (server-orkestratie)

### Task 6: DB-tabel + repository voor auto-map-sessies

**Files:**
- Modify: `server/src/db/database.ts` (CREATE TABLE toevoegen in `initDb()`)
- Create: `server/src/db/repositories/autoMapSessions.ts`
- Test: `server/src/__tests__/repositories/autoMapSessions.test.ts`

**Interfaces:**
- Produces (voor Task 7/8):

```ts
export interface AutoMapSession {
  id: number;
  sn: string;
  mode: 'test' | 'record';
  phase: string;            // preflight|preparing|recording|following|finishing|awaiting_review|done|rejected|error|aborted
  radius_m: number;
  result_code: number | null;
  error: string | null;
  started_at: string;       // ISO
  finished_at: string | null;
}
export function createSession(sn: string, mode: 'test' | 'record', radiusM: number): AutoMapSession;
export function updatePhase(id: number, phase: string, patch?: { result_code?: number | null; error?: string | null; finished?: boolean }): void;
export function getActiveSession(sn: string): AutoMapSession | undefined;   // phase niet in (done,rejected,error,aborted)
export function getLatestSession(sn: string): AutoMapSession | undefined;
```

- [ ] **Step 1: Schrijf de failing test**

Maak `server/src/__tests__/repositories/autoMapSessions.test.ts` (volg de importstijl van een bestaande test in dezelfde map, bijv. relatieve `.js`-imports):

```ts
import { describe, it, expect } from 'vitest';
import {
  createSession, updatePhase, getActiveSession, getLatestSession,
} from '../../db/repositories/autoMapSessions.js';

describe('autoMapSessions repository', () => {
  it('maakt een sessie aan en vindt hem als actief', () => {
    const s = createSession('LFIN_TEST_AM1', 'test', 30);
    expect(s.id).toBeGreaterThan(0);
    expect(s.phase).toBe('preflight');
    expect(getActiveSession('LFIN_TEST_AM1')?.id).toBe(s.id);
  });

  it('updatePhase muteert fase en sluit sessies af', () => {
    const s = createSession('LFIN_TEST_AM2', 'record', 25);
    updatePhase(s.id, 'following');
    expect(getActiveSession('LFIN_TEST_AM2')?.phase).toBe('following');
    updatePhase(s.id, 'aborted', { error: 'geofence', finished: true });
    expect(getActiveSession('LFIN_TEST_AM2')).toBeUndefined();
    const latest = getLatestSession('LFIN_TEST_AM2');
    expect(latest?.phase).toBe('aborted');
    expect(latest?.error).toBe('geofence');
    expect(latest?.finished_at).not.toBeNull();
  });

  it('result_code wordt opgeslagen', () => {
    const s = createSession('LFIN_TEST_AM3', 'record', 30);
    updatePhase(s.id, 'awaiting_review', { result_code: 0 });
    expect(getLatestSession('LFIN_TEST_AM3')?.result_code).toBe(0);
  });
});
```

- [ ] **Step 2: Run de test, verwacht falen**

Run: `cd server && npx vitest run src/__tests__/repositories/autoMapSessions.test.ts`
Verwacht: FAIL (module bestaat niet).

- [ ] **Step 3: Tabel + repository**

In `server/src/db/database.ts`, bij de andere `CREATE TABLE IF NOT EXISTS`-statements in `initDb()`:

```sql
CREATE TABLE IF NOT EXISTS auto_map_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sn TEXT NOT NULL,
  mode TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'preflight',
  radius_m REAL NOT NULL DEFAULT 30,
  result_code INTEGER,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
```

Maak `server/src/db/repositories/autoMapSessions.ts` (volg de stijl van een bestaande repository in dezelfde map, bijv. prepared statements op de gedeelde `db`):

```ts
import { db } from '../database.js';

export interface AutoMapSession {
  id: number;
  sn: string;
  mode: 'test' | 'record';
  phase: string;
  radius_m: number;
  result_code: number | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const FINAL_PHASES = ['done', 'rejected', 'error', 'aborted'];

export function createSession(sn: string, mode: 'test' | 'record', radiusM: number): AutoMapSession {
  const info = db.prepare(
    `INSERT INTO auto_map_sessions (sn, mode, radius_m) VALUES (?, ?, ?)`
  ).run(sn, mode, radiusM);
  return db.prepare(`SELECT * FROM auto_map_sessions WHERE id = ?`)
    .get(info.lastInsertRowid) as AutoMapSession;
}

export function updatePhase(
  id: number,
  phase: string,
  patch: { result_code?: number | null; error?: string | null; finished?: boolean } = {},
): void {
  db.prepare(
    `UPDATE auto_map_sessions SET phase = ?,
       result_code = COALESCE(?, result_code),
       error = COALESCE(?, error),
       finished_at = CASE WHEN ? THEN datetime('now') ELSE finished_at END
     WHERE id = ?`
  ).run(phase, patch.result_code ?? null, patch.error ?? null, patch.finished ? 1 : 0, id);
}

export function getActiveSession(sn: string): AutoMapSession | undefined {
  return db.prepare(
    `SELECT * FROM auto_map_sessions
     WHERE sn = ? AND phase NOT IN (${FINAL_PHASES.map(() => '?').join(',')})
     ORDER BY id DESC LIMIT 1`
  ).get(sn, ...FINAL_PHASES) as AutoMapSession | undefined;
}

export function getLatestSession(sn: string): AutoMapSession | undefined {
  return db.prepare(
    `SELECT * FROM auto_map_sessions WHERE sn = ? ORDER BY id DESC LIMIT 1`
  ).get(sn) as AutoMapSession | undefined;
}
```

Controleer vóór het overnemen hoe de bestaande repositories `db` importeren (`grep -n "from '../database" server/src/db/repositories/*.ts | head -3`) en volg dat exact.

- [ ] **Step 4: Run de test, verwacht slagen**

Run: `cd server && npx vitest run src/__tests__/repositories/autoMapSessions.test.ts`
Verwacht: PASS (3 tests).

- [ ] **Step 5: TypeScript-check + commit**

```bash
cd server && npx tsc --noEmit
git add src/db/database.ts src/db/repositories/autoMapSessions.ts src/__tests__/repositories/autoMapSessions.test.ts
git commit -m "automap: auto_map_sessions tabel + repository"
```

---

### Task 7: autoMap.ts — server-orkestrator

**Files:**
- Create: `server/src/services/autoMap.ts`
- Test: `server/src/__tests__/services/autoMap.test.ts`

**Interfaces:**
- Consumes:
  - `publishToDevice(sn, payload)` en `getNextCmdNum(sn)` uit `../mqtt/mapSync.js`
  - `onDeviceResponse/offDeviceResponse(sn, handler)` en `onExtendedResponse/offExtendedResponse(sn, handler)` uit `../mqtt/mapSync.js`
  - `publishExtendedCommand(sn, cmd)` uit `../mqtt/extendedCommands.js`
  - `deviceCache` uit `../mqtt/sensorData.js` (strings: `battery_power`/`battery_capacity`, `rtk_fix_quality`)
  - repository uit Task 6
- Produces (voor Task 8):

```ts
export interface AutoMapProgress { sn: string; sessionId: number; phase: string; detail?: Record<string, unknown>; }
export function startAutoMap(sn: string, opts: { mode: 'test' | 'record'; radiusM?: number }): Promise<{ ok: true; sessionId: number } | { ok: false; error: string }>;
export function stopAutoMap(sn: string): void;
export function getStatus(sn: string): AutoMapSession | undefined;      // actieve, anders laatste
export function acceptProposal(sn: string): boolean;                    // awaiting_review -> done
export function rejectProposal(sn: string): boolean;                    // awaiting_review -> rejected
export function onProgress(cb: (p: AutoMapProgress) => void): void;     // Task 8 koppelt socket-emit
```

**Gedrag (state machine):**
1. `startAutoMap`: weiger als `getActiveSession(sn)` bestaat (`{ok:false, error:'already_running'}`). Preflight uit `deviceCache`: accu > 40 (`battery_power` ?? `battery_capacity`) en `rtk_fix_quality === '4'`; anders `{ok:false, error:'preflight_battery'|'preflight_rtk'}`.
2. mode `'test'`: alleen `publishExtendedCommand(sn, {start_auto_map_test:{radiusM, timeoutS:1200}})`; fases volgen uit `auto_map_status`-events; einde (`result`/`error`/`aborted`) sluit de sessie af (result-code opslaan; bij een test-run is code 0 gewoon einde `done`, geen review).
3. mode `'record'`: eerst `publishToDevice(sn, {start_scan_map:{model:'manual', mapName:'map0', type:0, cmd_num:getNextCmdNum(sn)}})`, wacht op `start_scan_map_respond` via `onDeviceResponse` (timeout 20 s → sessie `error`, `scan_start_timeout`). Daarna zoals mode test de volgmotor starten; fase `recording`.
4. Bij `auto_map_status {phase:'result', code:0}` (mode record): fase `finishing` en de afrondreeks uit Global Constraints sturen, elk commando wachtend op zijn `_respond` (timeout 20 s per stap, `save_recharge_pos` 30 s), met ≥600 ms tussen `save_recharge_pos_respond` en `save_map type:1`. Na `save_map_respond` van type 1: fase `awaiting_review`.
5. Bij code ≠ 0, `error` of `aborted` in mode record: `publishToDevice stop_scan_map {value:false}` sturen (zonder saves, spec: geen halve kaart) en sessie afsluiten met de code/fout. NO_VALID_BOUNDARY krijgt `error='geen grasrand gevonden op startpunt'`.
6. Elke fase-overgang: `updatePhase` + alle `onProgress`-callbacks aanroepen.
7. Handlers ALTIJD opruimen (`offDeviceResponse`/`offExtendedResponse`) bij sessie-einde.

- [ ] **Step 1: Schrijf de failing tests (gemockte MQTT-laag)**

Maak `server/src/__tests__/services/autoMap.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const published: Array<Record<string, unknown>> = [];
const extended: Array<Record<string, unknown>> = [];
let devHandlers: Array<(d: Record<string, unknown>) => void> = [];
let extHandlers: Array<(d: Record<string, unknown>) => void> = [];

vi.mock('../../mqtt/mapSync.js', () => ({
  publishToDevice: vi.fn((_sn: string, p: Record<string, unknown>) => { published.push(p); }),
  getNextCmdNum: vi.fn(() => 42),
  onDeviceResponse: vi.fn((_sn: string, h: (d: Record<string, unknown>) => void) => { devHandlers.push(h); }),
  offDeviceResponse: vi.fn((_sn: string, h: (d: Record<string, unknown>) => void) => {
    devHandlers = devHandlers.filter((x) => x !== h);
  }),
  onExtendedResponse: vi.fn((_sn: string, h: (d: Record<string, unknown>) => void) => { extHandlers.push(h); }),
  offExtendedResponse: vi.fn((_sn: string, h: (d: Record<string, unknown>) => void) => {
    extHandlers = extHandlers.filter((x) => x !== h);
  }),
}));
vi.mock('../../mqtt/extendedCommands.js', () => ({
  publishExtendedCommand: vi.fn((_sn: string, c: Record<string, unknown>) => { extended.push(c); }),
}));

import { deviceCache } from '../../mqtt/sensorData.js';
import { startAutoMap, getStatus, acceptProposal } from '../../services/autoMap.js';

const SN = 'LFIN_TEST_AUTOMAP';
function setCache(fields: Record<string, string>) {
  deviceCache.set(SN, new Map(Object.entries(fields)));
}
const emitExt = (d: Record<string, unknown>) => { for (const h of [...extHandlers]) h(d); };
const emitDev = (d: Record<string, unknown>) => { for (const h of [...devHandlers]) h(d); };
const flush = () => new Promise((r) => setTimeout(r, 750)); // > 600ms save-delay

describe('autoMap orchestrator', () => {
  beforeEach(() => {
    published.length = 0; extended.length = 0;
    devHandlers = []; extHandlers = [];
  });

  it('preflight weigert bij lage accu', async () => {
    setCache({ battery_power: '35', rtk_fix_quality: '4' });
    const r = await startAutoMap(SN, { mode: 'test' });
    expect(r).toEqual({ ok: false, error: 'preflight_battery' });
  });

  it('preflight weigert zonder RTK Fixed', async () => {
    setCache({ battery_power: '80', rtk_fix_quality: '1' });
    const r = await startAutoMap(SN, { mode: 'test' });
    expect(r).toEqual({ ok: false, error: 'preflight_rtk' });
  });

  it('record-flow: LOOP_CLOSED -> afrondreeks -> awaiting_review', async () => {
    setCache({ battery_power: '80', rtk_fix_quality: '4' });
    const r = await startAutoMap(SN, { mode: 'record', radiusM: 30 });
    expect(r.ok).toBe(true);
    // start_scan_map is verstuurd met exact het app-payload
    expect(published[0]).toEqual({
      start_scan_map: { model: 'manual', mapName: 'map0', type: 0, cmd_num: 42 },
    });
    emitDev({ start_scan_map_respond: { result: 0 } });
    await flush();
    // volgmotor gestart via extended command
    expect(extended[0]).toHaveProperty('start_auto_map_test');
    // rit klaar: LOOP_CLOSED
    emitExt({ auto_map_status: { phase: 'result', code: 0, name: 'LOOP_CLOSED' } });
    await flush();
    expect(published[1]).toHaveProperty('stop_scan_map');
    emitDev({ stop_scan_map_respond: { result: 0 } });
    await flush();
    expect(published[2]).toEqual({ save_map: { mapName: 'map0', type: 0, cmd_num: 42 } });
    emitDev({ save_map_respond: { result: 0, type: 0 } });
    await flush();
    expect(published[3]).toHaveProperty('save_recharge_pos');
    emitDev({ save_recharge_pos_respond: { result: 0 } });
    await flush();
    expect(published[4]).toEqual({ save_map: { mapName: 'map0', type: 1, cmd_num: 42 } });
    emitDev({ save_map_respond: { result: 0, type: 1 } });
    await flush();
    expect(getStatus(SN)?.phase).toBe('awaiting_review');
    expect(acceptProposal(SN)).toBe(true);
    expect(getStatus(SN)?.phase).toBe('done');
  });

  it('geofence-abort in record-mode stuurt stop_scan_map ZONDER saves', async () => {
    setCache({ battery_power: '80', rtk_fix_quality: '4' });
    await startAutoMap(SN, { mode: 'record' });
    emitDev({ start_scan_map_respond: { result: 0 } });
    await flush();
    emitExt({ auto_map_status: { phase: 'aborted', error: 'geofence', dist_m: 31.2 } });
    await flush();
    const cmds = published.map((p) => Object.keys(p)[0]);
    expect(cmds).toContain('stop_scan_map');
    expect(cmds).not.toContain('save_map');
    expect(getStatus(SN)?.phase).toBe('aborted');
    expect(getStatus(SN)?.error).toBe('geofence');
  });
});
```

- [ ] **Step 2: Run de tests, verwacht falen**

Run: `cd server && npx vitest run src/__tests__/services/autoMap.test.ts`
Verwacht: FAIL (autoMap.ts bestaat niet).

- [ ] **Step 3: Implementeer autoMap.ts**

Maak `server/src/services/autoMap.ts`:

```ts
/**
 * autoMap — orkestrator voor autonoom karteren (route B).
 *
 * De maaier-daemon (auto_map_node.py) rijdt de rand en bewaakt geofence en
 * timeout; deze service orkestreert de FIRMWARE-karteersessie eromheen
 * (start_scan_map … save_map, exact de bewezen BLE-mapping-flow) en houdt de
 * sessiestatus bij voor dashboard/review.
 * Spec: docs/superpowers/specs/2026-07-22-autonomous-mapping-design.md
 */
import {
  publishToDevice, getNextCmdNum,
  onDeviceResponse, offDeviceResponse,
  onExtendedResponse, offExtendedResponse,
} from '../mqtt/mapSync.js';
import { publishExtendedCommand } from '../mqtt/extendedCommands.js';
import { deviceCache } from '../mqtt/sensorData.js';
import {
  AutoMapSession, createSession, updatePhase, getActiveSession, getLatestSession,
} from '../db/repositories/autoMapSessions.js';

const TAG = '[autoMap]';
const RESPOND_TIMEOUT_MS = 20_000;
const RECHARGE_TIMEOUT_MS = 30_000;
const SAVE_TOTAL_DELAY_MS = 600;   // ≥500 ms tussen save_recharge_pos_respond en save_map type:1

export interface AutoMapProgress {
  sn: string; sessionId: number; phase: string; detail?: Record<string, unknown>;
}

const progressCbs: Array<(p: AutoMapProgress) => void> = [];
export function onProgress(cb: (p: AutoMapProgress) => void): void { progressCbs.push(cb); }

function emit(sn: string, sessionId: number, phase: string, detail?: Record<string, unknown>): void {
  for (const cb of progressCbs) { try { cb({ sn, sessionId, phase, detail }); } catch { /* ignore */ } }
}

/** Wacht op één device-respond met de gegeven sleutel. */
function waitForRespond(sn: string, key: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const handler = (data: Record<string, unknown>) => {
      if (key in data) { cleanup(); resolve(data[key] as Record<string, unknown>); }
    };
    const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); offDeviceResponse(sn, handler); };
    onDeviceResponse(sn, handler);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface LiveRun { session: AutoMapSession; extHandler: (d: Record<string, unknown>) => void; }
const liveRuns = new Map<string, LiveRun>();

function preflight(sn: string): string | null {
  const cache = deviceCache.get(sn);
  const battery = parseInt(cache?.get('battery_power') ?? cache?.get('battery_capacity') ?? '', 10);
  if (isNaN(battery) || battery <= 40) return 'preflight_battery';
  if ((cache?.get('rtk_fix_quality') ?? '') !== '4') return 'preflight_rtk';
  return null;
}

export async function startAutoMap(
  sn: string, opts: { mode: 'test' | 'record'; radiusM?: number },
): Promise<{ ok: true; sessionId: number } | { ok: false; error: string }> {
  if (getActiveSession(sn)) return { ok: false, error: 'already_running' };
  const pf = preflight(sn);
  if (pf) return { ok: false, error: pf };

  const radiusM = Math.max(5, Math.min(200, opts.radiusM ?? 30));
  const session = createSession(sn, opts.mode, radiusM);
  const setPhase = (phase: string, patch?: Parameters<typeof updatePhase>[2], detail?: Record<string, unknown>) => {
    updatePhase(session.id, phase, patch); emit(sn, session.id, phase, detail);
  };

  const finish = (phase: string, patch?: Parameters<typeof updatePhase>[2], detail?: Record<string, unknown>) => {
    const run = liveRuns.get(sn);
    if (run) { offExtendedResponse(sn, run.extHandler); liveRuns.delete(sn); }
    setPhase(phase, { ...patch, finished: true }, detail);
  };

  // Afrondreeks (alleen mode record, alleen bij LOOP_CLOSED). Exacte volgorde
  // en payloads: docs/reference/MAPPING-FLOW.md — NOOIT wijzigen.
  const finalize = async () => {
    setPhase('finishing');
    publishToDevice(sn, { stop_scan_map: { value: false, cmd_num: getNextCmdNum(sn) } });
    if (!await waitForRespond(sn, 'stop_scan_map_respond', RESPOND_TIMEOUT_MS)) {
      return finish('error', { error: 'stop_scan_map_timeout' });
    }
    publishToDevice(sn, { save_map: { mapName: 'map0', type: 0, cmd_num: getNextCmdNum(sn) } });
    if (!await waitForRespond(sn, 'save_map_respond', RESPOND_TIMEOUT_MS)) {
      return finish('error', { error: 'save_map0_timeout' });
    }
    publishToDevice(sn, { save_recharge_pos: { mapName: 'map0', cmd_num: getNextCmdNum(sn) } });
    if (!await waitForRespond(sn, 'save_recharge_pos_respond', RECHARGE_TIMEOUT_MS)) {
      return finish('error', { error: 'save_recharge_pos_timeout' });
    }
    await sleep(SAVE_TOTAL_DELAY_MS);
    publishToDevice(sn, { save_map: { mapName: 'map0', type: 1, cmd_num: getNextCmdNum(sn) } });
    if (!await waitForRespond(sn, 'save_map_respond', RESPOND_TIMEOUT_MS)) {
      return finish('error', { error: 'save_map1_timeout' });
    }
    setPhase('awaiting_review');
    // sessie blijft "actief" tot accept/reject — bewust geen finish()
    const run = liveRuns.get(sn);
    if (run) { offExtendedResponse(sn, run.extHandler); liveRuns.delete(sn); }
  };

  // Abort in record-mode: opname stoppen ZONDER saves (spec: geen halve kaart).
  const abortRecording = (phase: string, patch?: Parameters<typeof updatePhase>[2], detail?: Record<string, unknown>) => {
    publishToDevice(sn, { stop_scan_map: { value: false, cmd_num: getNextCmdNum(sn) } });
    finish(phase, patch, detail);
  };

  const extHandler = (data: Record<string, unknown>) => {
    const st = data['auto_map_status'] as Record<string, unknown> | undefined;
    if (!st) return;
    const phase = String(st.phase ?? '');
    if (phase === 'searching_boundary' || phase === 'following') {
      setPhase(opts.mode === 'record' ? 'recording' : phase, undefined, st);
    } else if (phase === 'result') {
      const code = Number(st.code);
      if (opts.mode === 'record' && code === 0) { void finalize(); return; }
      if (code === 0) { finish('done', { result_code: 0 }); return; }
      const error = code === 1 ? 'geen grasrand gevonden op startpunt'
        : String(st.name ?? `code_${code}`);
      if (opts.mode === 'record') abortRecording('error', { result_code: code, error }, st);
      else finish('error', { result_code: code, error }, st);
    } else if (phase === 'error' || phase === 'aborted') {
      const error = String(st.error ?? phase);
      if (opts.mode === 'record') abortRecording(phase, { error }, st);
      else finish(phase, { error }, st);
    }
  };
  onExtendedResponse(sn, extHandler);
  liveRuns.set(sn, { session, extHandler });

  void (async () => {
    if (opts.mode === 'record') {
      setPhase('recording');
      publishToDevice(sn, {
        start_scan_map: { model: 'manual', mapName: 'map0', type: 0, cmd_num: getNextCmdNum(sn) },
      });
      const resp = await waitForRespond(sn, 'start_scan_map_respond', RESPOND_TIMEOUT_MS);
      if (!resp) return finish('error', { error: 'scan_start_timeout' });
    } else {
      setPhase('preparing');
    }
    publishExtendedCommand(sn, { start_auto_map_test: { radiusM, timeoutS: 1200 } });
  })();

  console.log(`${TAG} ${sn}: sessie ${session.id} gestart (${opts.mode}, geofence ${radiusM} m)`);
  return { ok: true, sessionId: session.id };
}

export function stopAutoMap(sn: string): void {
  publishExtendedCommand(sn, { stop_auto_map: {} });
  // de maaier meldt daarna auto_map_status {phase:'aborted', error:'user_stop'}
}

export function getStatus(sn: string): AutoMapSession | undefined {
  return getActiveSession(sn) ?? getLatestSession(sn);
}

export function acceptProposal(sn: string): boolean {
  const s = getActiveSession(sn);
  if (!s || s.phase !== 'awaiting_review') return false;
  updatePhase(s.id, 'done', { finished: true });
  emit(sn, s.id, 'done');
  return true;
}

export function rejectProposal(sn: string): boolean {
  const s = getActiveSession(sn);
  if (!s || s.phase !== 'awaiting_review') return false;
  updatePhase(s.id, 'rejected', { finished: true });
  emit(sn, s.id, 'rejected');
  return true;
}
```

- [ ] **Step 4: Run de tests, verwacht slagen**

Run: `cd server && npx vitest run src/__tests__/services/autoMap.test.ts`
Verwacht: PASS (4 tests). Draai ook Task 6-tests mee: `npx vitest run src/__tests__/repositories/autoMapSessions.test.ts` → PASS.

- [ ] **Step 5: TypeScript-check + commit**

```bash
cd server && npx tsc --noEmit
git add src/services/autoMap.ts src/__tests__/services/autoMap.test.ts
git commit -m "automap: server-orkestrator - preflight, opnamesessie, afrondreeks, abort zonder saves"
```

---

### Task 8: routes + socket-voortgang

**Files:**
- Modify: `server/src/routes/dashboard.ts` (nieuwe endpoints bij de andere dashboard-routes)
- Modify: `server/src/dashboard/socketHandler.ts` (emit-helper naar het patroon van `emitDeviceOnline`)
- Modify: `server/src/index.ts` (eenmalige koppeling `onProgress` → socket-emit)
- Test: `server/src/__tests__/routes/autoMapRoutes.test.ts`

**Interfaces:**
- Consumes: Task 7 exports.
- Produces:
  - `POST /api/dashboard/auto-map/:sn/start` body `{mode: 'test'|'record', radiusM?: number}` → `{ok, sessionId?}` of 409 `{error}`
  - `POST /api/dashboard/auto-map/:sn/stop` → `{ok: true}`
  - `GET  /api/dashboard/auto-map/:sn/status` → sessie-record of `{phase:'idle'}`
  - `POST /api/dashboard/auto-map/:sn/accept` / `.../reject` → `{ok: boolean}`
  - Socket-event `auto_map_progress` met `AutoMapProgress`-payload
  - `export function emitAutoMapProgress(p: { sn: string; sessionId: number; phase: string; detail?: Record<string, unknown> }): void` in socketHandler.ts

- [ ] **Step 1: Schrijf de failing route-test**

Maak `server/src/__tests__/routes/autoMapRoutes.test.ts`. Kopieer de setup-stijl (supertest/app-bootstrap) van een bestaande route-test uit `server/src/__tests__/routes/` — bekijk eerst `ls server/src/__tests__/routes/` en open de kleinste als sjabloon. Mock `../../services/autoMap.js`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/autoMap.js', () => ({
  startAutoMap: vi.fn(async (_sn: string, opts: { mode: string }) =>
    opts.mode === 'record' ? { ok: true, sessionId: 7 } : { ok: false, error: 'preflight_rtk' }),
  stopAutoMap: vi.fn(),
  getStatus: vi.fn(() => ({ id: 7, sn: 'X', phase: 'following' })),
  acceptProposal: vi.fn(() => true),
  rejectProposal: vi.fn(() => false),
  onProgress: vi.fn(),
}));

// ...app-bootstrap zoals in de sjabloon-test...

describe('auto-map routes', () => {
  it('start geeft sessionId terug', async () => {
    const res = await request(app).post('/api/dashboard/auto-map/LFIN_X/start')
      .send({ mode: 'record', radiusM: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sessionId: 7 });
  });

  it('start met preflight-fout geeft 409', async () => {
    const res = await request(app).post('/api/dashboard/auto-map/LFIN_X/start')
      .send({ mode: 'test' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('preflight_rtk');
  });

  it('status geeft sessie terug', async () => {
    const res = await request(app).get('/api/dashboard/auto-map/LFIN_X/status');
    expect(res.status).toBe(200);
    expect(res.body.phase).toBe('following');
  });

  it('reject zonder review-sessie geeft ok:false', async () => {
    const res = await request(app).post('/api/dashboard/auto-map/LFIN_X/reject');
    expect(res.body).toEqual({ ok: false });
  });
});
```

- [ ] **Step 2: Run, verwacht falen** — `cd server && npx vitest run src/__tests__/routes/autoMapRoutes.test.ts` → FAIL (404's).

- [ ] **Step 3: Implementeer routes + socket-koppeling**

In `server/src/routes/dashboard.ts` (imports bovenaan uitbreiden, endpoints bij de andere `/api/dashboard`-routes; volg de bestaande auth/foutafhandelingsstijl van de omliggende endpoints):

```ts
import {
  startAutoMap, stopAutoMap, getStatus as getAutoMapStatus,
  acceptProposal, rejectProposal,
} from '../services/autoMap.js';

// ── Autonoom karteren ────────────────────────────────────────────────────────
router.post('/auto-map/:sn/start', async (req, res) => {
  const { sn } = req.params;
  const mode = req.body?.mode === 'record' ? 'record' : 'test';
  const radiusM = Number(req.body?.radiusM) || undefined;
  const result = await startAutoMap(sn, { mode, radiusM });
  if (!result.ok) return res.status(409).json({ error: result.error });
  res.json(result);
});

router.post('/auto-map/:sn/stop', (req, res) => {
  stopAutoMap(req.params.sn);
  res.json({ ok: true });
});

router.get('/auto-map/:sn/status', (req, res) => {
  res.json(getAutoMapStatus(req.params.sn) ?? { phase: 'idle' });
});

router.post('/auto-map/:sn/accept', (req, res) => {
  res.json({ ok: acceptProposal(req.params.sn) });
});

router.post('/auto-map/:sn/reject', (req, res) => {
  res.json({ ok: rejectProposal(req.params.sn) });
});
```

Let op: controleer eerst hoe de router in dashboard.ts heet (`router`, `dashboardRouter`, …) en of endpoints `res.json` dan wel een helper gebruiken; volg dat exact.

In `server/src/dashboard/socketHandler.ts`, naast `emitDeviceOnline` (regel ~318):

```ts
export function emitAutoMapProgress(p: { sn: string; sessionId: number; phase: string; detail?: Record<string, unknown> }): void {
  io.emit('auto_map_progress', p);
}
```

In `server/src/index.ts`, na de bestaande socket/MQTT-initialisatie (eenmalig):

```ts
import { onProgress as onAutoMapProgress } from './services/autoMap.js';
import { emitAutoMapProgress } from './dashboard/socketHandler.js';
onAutoMapProgress(emitAutoMapProgress);
```

- [ ] **Step 4: Run alle geraakte tests**

Run: `cd server && npx vitest run src/__tests__/routes/autoMapRoutes.test.ts src/__tests__/services/autoMap.test.ts src/__tests__/repositories/autoMapSessions.test.ts`
Verwacht: alles PASS.

- [ ] **Step 5: TypeScript-check + commit**

```bash
cd server && npx tsc --noEmit
git add src/routes/dashboard.ts src/dashboard/socketHandler.ts src/index.ts src/__tests__/routes/autoMapRoutes.test.ts
git commit -m "automap: dashboard-API (start/stop/status/accept/reject) + socket-voortgang"
```

---

## Fase 2 — dashboard-UX

### Task 9: AutoMapPanel in MapTab

**Files:**
- Create: `dashboard/src/components/map/AutoMapPanel.tsx`
- Modify: `dashboard/src/pages/MapTab.tsx` (paneel mounten)

**Interfaces:**
- Consumes: de Task 8-endpoints en het `auto_map_progress`-socketevent; de bestaande `apiFetch`-helper en socket-hook van het dashboard (bekijk hoe MapTab.tsx die vandaag gebruikt en volg dat exact).
- Produces: UI-flow: startknop (testrit / kaart maken) → live fase-weergave → review-banner met "Kaart accepteren" / "Verwerpen".

**Gedrag:**
- Sectie "Autonoom karteren" met: keuze `Testrit (zonder opname)` / `Kaart maken`, geofence-invoer (nummer, meters, default 30, min 5, max 200), startknop.
- Na start: fase-badge (NL-labels: `preflight` → "Voorbereiden", `preparing` → "Voorbereiden", `searching_boundary` → "Grasrand zoeken", `following` → "Rand volgen", `recording` → "Opnemen", `finishing` → "Kaart opslaan", `awaiting_review` → "Wacht op beoordeling", `done` → "Klaar", `rejected` → "Verworpen", `error` → "Fout", `aborted` → "Afgebroken") + stopknop + eventuele foutmelding uit `error`.
- Live update: luister op `auto_map_progress` (filter op de actieve SN) en val terug op een 10 s-poll van `GET /auto-map/:sn/status`.
- Bij `awaiting_review`: banner "De maaier heeft een kaart gemaakt. Controleer hem op de kaartweergave en accepteer of verwerp." met twee knoppen → `POST .../accept` / `POST .../reject`. Na verwerpen toont het paneel de hint dat de kaart op de maaier verwijderd kan worden via het bestaande kaartbeheer (delete-map-flow), en dat een nieuwe poging gestart kan worden.
- Foutcodes toonbaar maken: `preflight_battery` → "Accu moet boven 40% zijn", `preflight_rtk` → "Wacht op RTK Fixed", `already_running` → "Er loopt al een sessie", `geofence` → "Geofence overschreden, rit gestopt", `timeout` → "Tijdslimiet bereikt", `relay_missing` → "lawn_edge_relay draait niet op de maaier", `geen grasrand gevonden op startpunt` → letterlijk tonen.

- [ ] **Step 1: Bekijk MapTab-conventies** — open `dashboard/src/pages/MapTab.tsx`, noteer: hoe de actieve SN binnenkomt (prop/context), welke fetch-helper en socket-hook gebruikt worden, en de Tailwind-kaartstijl van bestaande panelen. Bouw AutoMapPanel in die stijl.

- [ ] **Step 2: Implementeer `AutoMapPanel.tsx`** — één component, lokale state `{status, busy, mode, radiusM, error}`, `useEffect` voor socket + poll, de zes UI-toestanden uit Gedrag hierboven. Geen nieuwe dependencies.

- [ ] **Step 3: Mount in MapTab** — `<AutoMapPanel sn={sn} />` op een logische plek onder de bestaande kaartbediening.

- [ ] **Step 4: Build-verificatie**

Run: `cd dashboard && npm run build`
Verwacht: `✓ built` zonder TypeScript-fouten. (Live UI-test doet Ramon; UI-wijzigingen niet als "werkend" rapporteren vóór zijn test.)

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/map/AutoMapPanel.tsx dashboard/src/pages/MapTab.tsx
git commit -m "automap: dashboard-paneel - start/voortgang/review-flow"
```

---

## Fase 3 — hardening

### Task 10: retry bij SEARCHING_START_FAILED + documentatie

**Files:**
- Modify: `research/auto_map_node.py` (retry-logica in `_run_session`)
- Modify: `research/__tests__/test_auto_map_node.py` (test voor de retry-beslissing)
- Create: `docs/user-guide/autonomous-mapping.md`

**Interfaces:**
- Consumes: Task 3/4-code.
- Produces: `should_retry(code, attempt) -> bool` (pure helper) + gedocumenteerde gebruikersflow.

- [ ] **Step 1: Failing test voor de retry-beslissing**

Toevoegen aan `research/__tests__/test_auto_map_node.py`:

```python
def test_should_retry_only_code4_once():
    assert amn.should_retry(4, attempt=1) is True    # eerste keer: retry
    assert amn.should_retry(4, attempt=2) is False   # daarna: abort
    assert amn.should_retry(3, attempt=1) is False   # FOLLOW_FAILED: nooit
    assert amn.should_retry(0, attempt=1) is False
```

En de aanroep in het `__main__`-blok van de test opnemen. Run: FAIL (`AttributeError: should_retry`).

- [ ] **Step 2: Implementeer**

In `research/auto_map_node.py`, bij de helpers:

```python
def should_retry(code, attempt):
    """Spec result-tabel: alleen SEARCHING_START_FAILED (4) krijgt één
    automatische retry (vanaf ~2 m verderop), daarna abort."""
    return code == 4 and attempt < 2
```

In `_run_session`: verpak de goal-dispatch + poll-lus in `for attempt in (1, 2):`; na een result met `should_retry(code, attempt)` eerst ~2 m verplaatsen vóór de nieuwe goal: publiceer 8 s lang `Twist(linear.x=0.25)` op `/cmd_vel` via een korte rclpy-publisher (zelfde patroon als `drive_backward` in de calibration-drive van extended_commands, maar vooruit), daarna `sess.status("searching_boundary", retry=attempt + 1)` en opnieuw de goal. Bij geen retry: bestaande result-afhandeling.

- [ ] **Step 3: Run tests** — `python3 research/__tests__/test_auto_map_node.py` → `OK`; `python3 -m py_compile research/auto_map_node.py` → stil.

- [ ] **Step 4: Gebruikersdocumentatie**

Maak `docs/user-guide/autonomous-mapping.md` met: wat de functie doet (grasrand volgen, kaart als voorstel), vereisten (custom firmware met relay+node, RTK Fixed, accu > 40%, maaier midden op het gras), de dashboardflow (testrit eerst, dan kaart maken, review/accepteren), de veiligheidsvangnetten (geofence 30 m instelbaar 5-200, timeout 20 min, bumper/obstakelvermijding blijft actief, stopknop), en de foutmeldingen-tabel uit Task 9. Schrijf voor eindgebruikers (andere Novabot-eigenaren), Nederlands, geen interne codeverwijzingen.

- [ ] **Step 5: Commit**

```bash
git add research/auto_map_node.py research/__tests__/test_auto_map_node.py docs/user-guide/autonomous-mapping.md
git commit -m "automap: retry bij SEARCHING_START_FAILED + gebruikersdocumentatie"
```

---

## Verificatie na alle taken

- [ ] Alle Python-selfchecks: `python3 research/__tests__/test_lawn_edge_relay.py && python3 research/__tests__/test_auto_map_node.py`
- [ ] Volledige servertestsuite: `cd server && npx vitest run` (geen nieuwe failures t.o.v. de bekende flake)
- [ ] `cd server && npx tsc --noEmit` en `cd dashboard && npm run build`
- [ ] `bash -n research/build_custom_firmware.sh`
- [ ] Geen WIP-bestanden gestaged: `git log --stat` bevat nergens DemoContext.tsx, UnicomTransitAnimation.tsx, mowerIconPath.ts, mow_zone_drive.py of extended_commands.py
- [ ] Veldtest fase 0 volgens `research/documents/auto-map-fase0-protocol.md` — door Ramon gestart; uitkomst bepaalt go/no-go richting route A
