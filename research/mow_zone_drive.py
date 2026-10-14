#!/usr/bin/env python3
"""Standalone rclpy orchestrator for one mow_zone run:

    undock (if on the dock) -> follow the recorded map<from>to<to> unicom
    exactly through the zone transit -> start coverage on the target map.

Why a dedicated rclpy process: the previous design drove ROS from the shell,
spawning `ros2 param set` / `ros2 service call` / `ros2 action` / `tf2_echo`
once per step. Each invocation paid 5-8s of DDS discovery and there were ~15
of them (10 just for the speed params before+after), so a run took minutes
before the mower even moved. Worse, the `ros2 param set` calls used an 8s
timeout that discovery routinely blew past, so they FAILED SILENTLY and the
speed relaxation never applied (the drive stayed at ~0.1 m/s).

Here everything runs in ONE node: DDS discovery happens once (~2-3s), then the
param service, the FollowPath action and the coverage service are all instant
and reliable.

Invoked by extended_commands.handle_mow_zone:
    python3 mow_zone_drive.py <to_slot> <map_ids> <cutterhigh> <direction|->

Emits one line per phase to stdout (the caller maps these to mow_zone_status):
    PHASE undocking
    PHASE following_unicom
    PHASE covering
    PHASE done
    PHASE error <message>
Diagnostic lines are prefixed LOG and ignored by the caller.
"""
import json
import math
import os
import re
import signal
import sys
import threading
import time

import rclpy
from rclpy.action import ActionClient
from rcl_interfaces.srv import SetParameters, GetParameters
from rcl_interfaces.msg import Parameter, ParameterValue, ParameterType
from geometry_msgs.msg import Twist, PoseStamped
from nav_msgs.msg import Path, OccupancyGrid
from std_msgs.msg import UInt8
from std_srvs.srv import Trigger, SetBool, Empty
from nav2_msgs.action import FollowPath, NavigateToPose
from nav2_msgs.srv import LoadMap
from decision_msgs.srv import StartCoverageTask
from decision_msgs.msg import RobotStatus
from rclpy.qos import (QoSProfile, QoSHistoryPolicy, QoSReliabilityPolicy,
                       QoSDurabilityPolicy)
import tf2_ros

MAPS_HOME = "/userdata/lfi/maps/home0"
NAV_MAP_YAML = os.path.join(MAPS_HOME, "map.yaml")
# navfn ziet alles vanaf kosten 253 als onbegaanbaar, en dat is exact de
# inscribed radius van de global costmap (robot_radius, live 0.1 m).
INSCRIBED_RADIUS_M = 0.1
NAV_NODE = "/nav2_single_node_navigator"
DECISION = "/robot_decision"

# Iceoryx deelt deze applicatie maar twee pools toe, van 4 MB en 8 MB, dus élk
# bericht kost een heel blok van 4 MB, ook een tf-transform van 104 bytes. Diepe
# wachtrijen zijn hier dus niet "een beetje geheugen" maar tientallen megabytes
# per abonnement. Een paar plekken is genoeg om één transform te lezen.
TF_QOS = QoSProfile(depth=5, history=QoSHistoryPolicy.KEEP_LAST)
TF_STATIC_QOS = QoSProfile(depth=10, history=QoSHistoryPolicy.KEEP_LAST)
# RobotStatus.task_mode / work_status values the orchestrator has to reason
# about. A coverage task counts as executing (start_cov_task refuses a new
# start, delete_map refuses) while task_mode is COVERAGE and work_status is
# above 9; USER_STOP is the parked state a stop lands in (docs/reference/MQTT.md).
TASK_MODE_COVERAGE = 1
WORK_STATUS_USER_STOP = 10
WORK_STATUS_INIT_SUCCESS = 59  # robot_decision: init done, departure finished


def task_executing(task_mode, work_status):
    """True while robot_decision would refuse a new coverage start."""
    return task_mode == TASK_MODE_COVERAGE and work_status > 9


def task_parked(task_mode, work_status):
    """A coverage task stopped part-way (USER_STOP .. 49, the stop states
    robot_decision's coverContinueDeal resumes). It still blocks a new start;
    anything from 50 up is a live task."""
    return task_mode == TASK_MODE_COVERAGE and 10 <= work_status < 50
DOCK_RADIUS = 1.2   # within this of the map origin counts as "on the dock"

# (name, relaxed, default) controller params applied only for the transit and
# always restored afterwards. The dominant crawl cause was curvature scaling
# (use_regulated_linear_velocity_scaling); obstacle-cost scaling is already off
# on this node. We drive a self-recorded, known-safe line, so curvature scaling
# can go off and desired_linear_vel governs.
TRANSIT_PARAMS = [
    ("progress_checker.movement_time_allowance", 45.0, 12.0),
    ("progress_checker.required_movement_radius", 0.08, 0.2),
    ("FollowPathPurePursuit.max_allowed_time_to_collision", 0.25, 0.8),
    ("FollowPathPurePursuit.use_regulated_linear_velocity_scaling", False, True),
    ("FollowPathPurePursuit.desired_linear_vel", 0.9, 0.5),
]


def phase(*a):
    print("PHASE", *a, flush=True)


def log(*a):
    print("LOG", *a, flush=True)


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


# Tot hier trekken we zelf een rechte lijn naar het begin van een kanaal; verder
# weg laten we de planner het doen. Een halve meter haalt de maaier zonder iets
# te kunnen raken, daarboven kan er van alles tussen staan.
LEAD_IN_MAX_M = 0.5

# Afstand tussen opeenvolgende punten in het pad dat naar FollowPath gaat. Een
# opgenomen kanaal is vaak maar twee punten over een paar meter, en Pure Pursuit
# heeft daar niets om op te sturen: hij pakt een mikpunt ver vooruit, schiet
# erlangs en corrigeert terug, links-rechts-links, tot de progress checker het
# opgeeft met "Failed to make progress" (live LFIN2230700238, 2026-09-14, 62 s
# op zijn plek staan dansen aan het begin van map1tomap0). Een punt om de 10 cm
# geeft hem een vloeiend spoor om te volgen.
PATH_STEP_M = 0.10


def densify(pts, step=PATH_STEP_M):
    """Interpolate a sparse path so consecutive points are at most `step` apart."""
    if len(pts) < 2:
        return list(pts)
    out = [tuple(pts[0])]
    for a, b in zip(pts, pts[1:]):
        d = _dist(a, b)
        n = max(1, int(math.ceil(d / step)))
        for k in range(1, n):
            out.append((a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n))
        out.append(tuple(b))        # eindpunt exact, niet via drijvende komma
    return out


def _lead_in(pts, robot, min_gap=0.3):
    """Put the mower's own position in front of the path when it is not on it.

    A recorded channel is the short crossing between two zones, not a route
    from wherever the mower stands: map1tomap0_0_unicom.csv is two points and
    started 3.02 m away from the mower after undocking. Handing that straight
    to FollowPath leaves nothing inside the controller's local window, which
    reports "Resulting plan has 0 poses in it" and aborts on patience (live
    LFIN2230700238, 2026-09-14). Starting the path at the mower gives it
    something to follow into the channel. The collision checker still applies,
    so an obstacle in that lead-in aborts the hop instead of being driven over.
    """
    if not robot or not pts:
        return pts
    return pts if _dist(robot, pts[0]) <= min_gap else [tuple(robot)] + list(pts)


def _trim_to_nearest(pts, robot):
    """Drop the leading points between the mower and the recorded start, so the
    controller drives forward from where the mower actually is. Without this,
    just after undock the mower sits ~1m along the line but still near the dock;
    the controller heads back to the dock end, hits the dock (lethal costmap
    cost 255) and aborts with "collision ahead". Keeps at least 2 points."""
    if not robot or len(pts) < 3:
        return pts
    ci = min(range(len(pts)), key=lambda i: _dist(robot, pts[i]))
    if 0 < ci < len(pts) - 1:
        return pts[ci:]
    return pts


def read_xy_csv(path):
    """Read a comma-separated x,y CSV into a list of (x, y) floats."""
    pts = []
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                parts = line.split(",")
                if len(parts) >= 2:
                    try:
                        pts.append((float(parts[0]), float(parts[1])))
                    except ValueError:
                        continue
    except OSError:
        pass
    return pts


def point_in_poly(x, y, poly):
    """Ray-casting point-in-polygon."""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def _csv_base():
    b = f"{MAPS_HOME}/x3_csv_file"
    return b if os.path.isdir(b) else f"{MAPS_HOME}/csv_file"


def current_zone_slot(xy):
    """Return 'dock', 'mapN', or None for a map-frame position."""
    if xy is None:
        return None
    # The anchor IS the dock; the origin only roughly (the pos.json origin is
    # the charger's GPS, 0.5-0.8 m from the anchor on the mowers measured).
    # A docked mower must always read as "dock": that is what routes it to
    # the firmware's own departure instead of a nav2 drive off the dock.
    anchor = _dock_anchor()
    if _dist(xy, (0.0, 0.0)) <= DOCK_RADIUS or (anchor and _dist(xy, anchor) <= DOCK_RADIUS):
        return "dock"
    base = _csv_base()
    try:
        names = os.listdir(base)
    except OSError:
        names = []
    for f in sorted(names):
        m = re.fullmatch(r"(map\d+)_work\.csv", f)
        if not m:
            continue
        poly = read_xy_csv(os.path.join(base, f))
        if len(poly) >= 3 and point_in_poly(xy[0], xy[1], poly):
            return m.group(1)
    return None


# ── Zone selection beyond slot 4 ─────────────────────────────────────────────
# The zone selection is a decimal positional bitmask: map0 = 1, map1 = 10,
# map2 = 100 and so on, summed for a multi-zone start. robot_decision refuses
# any value above 60000 (or exactly 255) before decoding it, which puts every
# slot from 5 upward out of reach through that input.
FIRMWARE_MAP_ID_LIMIT = 60000


def slots_from_map_ids(map_ids):
    """Decimal positional bitmask -> slot numbers. 1000 -> [3], 100001 -> [0, 5]."""
    return [pos for pos, ch in enumerate(reversed(str(int(map_ids)))) if ch != "0"]


def map_names_for(map_ids):
    """The map files to start instead of the number, or [] when the number is fine.

    Empty means: stay on the number input, which is what every zone up to slot 4
    has always used.
    """
    map_ids = int(map_ids)
    if map_ids <= FIRMWARE_MAP_ID_LIMIT and map_ids != 255:
        return []
    return [f"map{slot}.yaml" for slot in slots_from_map_ids(map_ids)]


# ── Nachtpatrouille: kijken ─────────────────────────────────────────────────
# perception_node zet detecties als label id+100 in /perception/points_labeled
# (perception_conf/infer_class.json: 100 person, 101 animal). Eén bericht is één
# camerabeeld met de ToF-punten erin; per bericht tellen we de punten per klasse.
# Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
PATROL_LABELS = {100: "person", 101: "animal"}
# camera_stream.py op de maaier zelf; die zet de camera zelf aan (tot 15 s).
SNAPSHOT_URL = "http://127.0.0.1:8000/snapshot?topic={topic}"
# /led_set (std_msgs/UInt8, 0..100) -> chassis_control_node -> MCU 0x0D, koplamp.
LED_TOPIC = "/led_set"
PROBE_DIR = "/tmp/patrol_probe"


def label_offset(fields):
    """Byte offset of the `label` field in a points_labeled point; 12 (right
    after x, y, z float32) when the message does not name it."""
    for f in fields or []:
        if getattr(f, "name", None) == "label":
            return int(f.offset)
    return 12


def label_counts(data, point_step, offset):
    """Points per patrol class in one packed points_labeled buffer."""
    counts = {name: 0 for name in PATROL_LABELS.values()}
    if point_step <= offset:
        return counts
    labels = bytes(data)[offset::point_step]
    for label_id, name in PATROL_LABELS.items():
        counts[name] = labels.count(label_id)
    return counts


def steady_count(per_frame):
    """The count a class reached in at least two frames. One frame with a
    spike is noise; two frames are something standing there."""
    if len(per_frame) < 2:
        return 0
    return sorted(per_frame)[-2]


def fetch_snapshot(topic, timeout=25.0):
    """One JPEG from camera_stream.py; None when the camera gave nothing."""
    import urllib.request
    try:
        with urllib.request.urlopen(SNAPSHOT_URL.format(topic=topic), timeout=timeout) as r:
            body = r.read()
    except Exception as e:
        log(f"snapshot {topic}: {e}")
        return None
    return body if body[:2] == b"\xff\xd8" else None


class Driver:
    def __init__(self, node):
        self.node = node
        # Minimal shm footprint: NO persistent tf listener. Its /tf + /tf_static
        # subscriptions, under the mower's shm config (16-deep history, 128-deep
        # queue, 4MB chunks), were the chunk hogs that exhausted the 50-chunk
        # iceoryx pool and stalled the node mid-drive. Position is read via a
        # throwaway probe node in robot_xy() and released immediately. Depth-1
        # publishers keep the outbound chunk count tiny.
        qos = QoSProfile(depth=1, history=QoSHistoryPolicy.KEEP_LAST)
        self.pub_cmd = node.create_publisher(Twist, "/cmd_vel", qos)
        self.pub_lock = node.create_publisher(UInt8, "/release_charge_lock", qos)
        # Eén hulpnode voor tf en status, lui aangemaakt. Zie _probe().
        self._probe_node = None
        self._tf_buf = None
        self._status = None
        self._recharge = None
        # Nachtpatrouille: koplamp-publisher, servicecliënten en het
        # points_labeled-abonnement komen lui en precies één keer: elk nieuw
        # ROS-object kost iceoryx-blokken die pas vrijkomen als het proces stopt
        # (zie _probe).
        self._pub_led = None
        self._clients = {}
        self._label_sub = None
        self._label_buf = None

    def spin(self, sec):
        rclpy.spin_once(self.node, timeout_sec=sec)

    def _probe(self):
        """De ENE hulpnode voor tf en status, één keer aangemaakt.

        Hier stond een wegwerp-node per meting, met een TransformListener erop.
        Twee dingen liepen daarin mis. De listener staat standaard op depth 100
        voor /tf én /tf_static, en deze applicatie krijgt van iceoryx alleen
        pools van 4 en 8 MB, dus zelfs een transform van 104 bytes kost een heel
        blok van 4 MB. En `destroy_node()` geeft die blokken niet meteen terug:
        roudi ruimt pas op als het PROCES weg is. Eén run doet achttien van die
        metingen, en dan is een pool van honderd blokken op vóórdat de maaier
        een meter heeft gereden (live LFIN2230700238, 2026-09-14: de run hing in
        een MEPOO-lus terwijl de maaier naast het dock stond).
        Eén node, één listener, één abonnement, vijftien plekken in totaal.
        """
        if self._probe_node is None:
            self._probe_node = rclpy.create_node("mzd_probe")
            self._tf_buf = tf2_ros.Buffer()
            tf2_ros.TransformListener(self._tf_buf, self._probe_node,
                                      qos=TF_QOS, static_qos=TF_STATIC_QOS)
            self._probe_node.create_subscription(
                RobotStatus, f"{DECISION}/robot_status", self._on_status,
                QoSProfile(depth=1, history=QoSHistoryPolicy.KEEP_LAST))
        return self._probe_node

    def _on_status(self, m):
        self._status = (int(m.task_mode), int(m.work_status))
        self._recharge = int(m.recharge_status)

    def robot_xy(self, timeout=6.0):
        """Read map -> base_link. Returns (x, y), or None if TF never resolves
        (which doubles as a not-localized guard: callers refuse to move on None)."""
        probe = self._probe()
        buf = self._tf_buf
        pos = None
        deadline = time.time() + timeout
        try:
            while time.time() < deadline:
                rclpy.spin_once(probe, timeout_sec=0.1)
                try:
                    t = buf.lookup_transform("map", "base_link", rclpy.time.Time())
                    pos = (t.transform.translation.x, t.transform.translation.y)
                    break
                except Exception:
                    continue
        finally:
            pass
        return pos

    def undock(self, seconds=9.0, linear=0.25):
        """Release the dock magnet and reverse for EXACTLY `seconds` (9s @
        0.25 m/s = ~2.25m). This must clear the dock's costmap inflation zone
        (lethal cost 255 reaches ~1.5m out): from closer in the FollowPath
        controller sees the dock "in front" and aborts with "collision ahead"
        before it can even rotate toward the transit path. ~1m is too close;
        ~2.25m clears it (the old shell version's accidental 2.5-3m over-reverse
        is why the outbound drive worked at all). The loop bounds the reverse
        precisely (the old version streamed for seconds+16 -> uncontrolled)."""
        cli = self.node.create_client(Trigger, f"{DECISION}/cancel_recharge")
        if cli.wait_for_service(timeout_sec=3.0):
            fut = cli.call_async(Trigger.Request())
            rclpy.spin_until_future_complete(self.node, fut, timeout_sec=5.0)
        for _ in range(5):
            self.pub_lock.publish(UInt8(data=1))
            self.spin(0.05)
            time.sleep(0.1)
        time.sleep(0.5)
        tw = Twist()
        tw.linear.x = -abs(linear)
        t_end = time.time() + seconds
        while time.time() < t_end:
            self.pub_cmd.publish(tw)
            self.spin(0.0)
            time.sleep(0.1)
        for _ in range(3):
            self.pub_cmd.publish(Twist())
            time.sleep(0.1)

    def set_params(self, items):
        """items: list of (name, value). Returns True if the service accepted."""
        cli = self.node.create_client(SetParameters, f"{NAV_NODE}/set_parameters")
        if not cli.wait_for_service(timeout_sec=6.0):
            log("set_params: service unavailable")
            return False
        req = SetParameters.Request()
        for name, val in items:
            p = Parameter()
            p.name = name
            pv = ParameterValue()
            if isinstance(val, bool):
                pv.type = ParameterType.PARAMETER_BOOL
                pv.bool_value = val
            elif isinstance(val, float):
                pv.type = ParameterType.PARAMETER_DOUBLE
                pv.double_value = val
            elif isinstance(val, int):
                pv.type = ParameterType.PARAMETER_INTEGER
                pv.integer_value = val
            else:
                continue
            p.value = pv
            req.parameters.append(p)
        fut = cli.call_async(req)
        rclpy.spin_until_future_complete(self.node, fut, timeout_sec=8.0)
        res = fut.result()
        ok = bool(res and all(r.successful for r in res.results))
        log(f"set_params({len(items)}): {'ok' if ok else 'partial/fail'}")
        return ok

    def log_applied_params(self, names):
        """Read the params back from the controller and log them. SetParameters
        'successful' only means accepted; this shows whether the RPP plugin
        actually took the new values (so we know if the slow transit is the
        params not applying vs a deeper limit)."""
        cli = self.node.create_client(GetParameters, f"{NAV_NODE}/get_parameters")
        if not cli.wait_for_service(timeout_sec=5.0):
            log("get_params: service unavailable")
            return
        req = GetParameters.Request()
        req.names = list(names)
        fut = cli.call_async(req)
        rclpy.spin_until_future_complete(self.node, fut, timeout_sec=6.0)
        res = fut.result()
        if not res:
            log("get_params: no response")
            return
        out = []
        for name, pv in zip(names, res.values):
            if pv.type == ParameterType.PARAMETER_BOOL:
                out.append(f"{name}={pv.bool_value}")
            elif pv.type == ParameterType.PARAMETER_DOUBLE:
                out.append(f"{name}={round(pv.double_value, 3)}")
            elif pv.type == ParameterType.PARAMETER_INTEGER:
                out.append(f"{name}={pv.integer_value}")
            else:
                out.append(f"{name}=<unset/type{pv.type}>")
        log("applied params: " + " | ".join(out))

    def reload_map(self, map_yaml=NAV_MAP_YAML):
        """Laat map_server map.pgm opnieuw inlezen voordat we gaan navigeren.

        map_server leest de kaart alleen bij het opstarten van de node. Daarna
        herschrijft map_generator.cpp map.pgm elke taak opnieuw en zetten wij de
        unicom-kanalen erin open, maar nav2 plant onverstoorbaar door op de
        kaart van uren geleden. Live op .244 (2026-09-14): op (3.18, 4.23) lag
        0,55 m vrij op schijf, /map gaf `0`, en de planner gaf GOAL_COLLIDED
        omdat zijn static layer daar nog `254` had staan.

        De global costmap staat tussen taken op `unconfigured` en bouwt zichzelf
        bij de volgende navigatie opnieuw op uit de gelatchte /map, dus
        map_server bijwerken is genoeg.
        """
        cli = self.node.create_client(LoadMap, "/map_server/load_map")
        try:
            if not cli.wait_for_service(timeout_sec=8.0):
                return False, "map_server niet bereikbaar"
            req = LoadMap.Request()
            req.map_url = map_yaml
            fut = cli.call_async(req)
            rclpy.spin_until_future_complete(self.node, fut, timeout_sec=20.0)
            res = fut.result()
            if res is None:
                return False, "geen antwoord"
            return res.result == 0, "result=%d" % res.result
        finally:
            self.node.destroy_client(cli)

    def map_grid(self, timeout=15.0):
        """De kaart die nav2 gaat gebruiken, van /map. Niet map.pgm op schijf:
        precies dat verschil kostte map6 vijftien pogingen."""
        got = {}
        qos = QoSProfile(depth=1, history=QoSHistoryPolicy.KEEP_LAST,
                         reliability=QoSReliabilityPolicy.RELIABLE,
                         durability=QoSDurabilityPolicy.TRANSIENT_LOCAL)
        sub = self.node.create_subscription(
            OccupancyGrid, "/map", lambda m: got.setdefault("m", m), qos)
        try:
            t0 = time.time()
            while "m" not in got and time.time() - t0 < timeout:
                rclpy.spin_once(self.node, timeout_sec=0.3)
            return got.get("m")
        finally:
            self.node.destroy_subscription(sub)

    def map_blocked(self, pts, grid=None, timeout=15.0):
        """Welke punten zijn bezet op de kaart die nav2 gaat gebruiken.

        Geeft None als er geen kaart binnenkomt, anders een lijst van
        (punt, reden) voor alles wat niet vrij is.
        """
        m = grid if grid is not None else self.map_grid(timeout)
        if m is None:
            return None
        res = m.info.resolution
        ox = m.info.origin.position.x
        oy = m.info.origin.position.y
        w, h = m.info.width, m.info.height
        bad = []
        for (x, y) in pts:
            cx = int((x - ox) / res)
            cy = int((y - oy) / res)
            if not (0 <= cx < w and 0 <= cy < h):
                bad.append(((x, y), "buiten de kaart"))
            elif m.data[cy * w + cx] != 0:
                bad.append(((x, y), "waarde %d" % m.data[cy * w + cx]))
        return bad

    def map_unreachable(self, start, pts, grid=None, timeout=15.0):
        """Welke punten kan de planner niet bereiken vanaf `start`.

        Vrij zijn is niet genoeg, het punt moet ook verbonden zijn met waar de
        maaier staat. navfn blokkeert alles vanaf kosten 253, en dat is precies
        alles binnen de inscribed radius van een obstakel, dus de bezette ruimte
        wordt hier met die straal opgeblazen en daarna doorzocht.

        Geeft (None, reden) als het niet te bepalen is, anders (lijst, notitie).
        """
        m = grid if grid is not None else self.map_grid(timeout)
        if m is None:
            return None, "geen /map ontvangen"
        res = m.info.resolution
        ox = m.info.origin.position.x
        oy = m.info.origin.position.y
        w, h = m.info.width, m.info.height
        r = max(1, int(math.ceil(INSCRIBED_RADIUS_M / res)))

        # Opblazen in twee gescheiden doorgangen: per rij en dan per kolom is
        # O(w*h), een vierkant per bezette cel zou hier miljoenen schrijfacties
        # kosten omdat de kaart vooral uit bezet gebied bestaat.
        def _dilate(src):
            out = bytearray(w * h)
            for y in range(h):
                base = y * w
                acc = [0] * (w + 1)
                for x in range(w):
                    acc[x + 1] = acc[x] + src[base + x]
                for x in range(w):
                    lo, hi = max(0, x - r), min(w - 1, x + r)
                    out[base + x] = 1 if acc[hi + 1] - acc[lo] else 0
            col = bytearray(w * h)
            for x in range(w):
                acc = [0] * (h + 1)
                for y in range(h):
                    acc[y + 1] = acc[y] + out[y * w + x]
                for y in range(h):
                    lo, hi = max(0, y - r), min(h - 1, y + r)
                    col[y * w + x] = 1 if acc[hi + 1] - acc[lo] else 0
            return col

        occ = bytearray(1 if v != 0 else 0 for v in m.data)
        blocked = _dilate(occ)

        def free(cx, cy):
            return 0 <= cx < w and 0 <= cy < h and not blocked[cy * w + cx]

        sx = int((start[0] - ox) / res)
        sy = int((start[1] - oy) / res)
        notitie = ""
        if not free(sx, sy):
            # Op het dock staat de maaier per definitie in bezet gebied: het
            # laadstation is een obstakel. do_mow ondockt eerst, dus de vraag is
            # of het kanaal bereikbaar is vanaf net naast het dock.
            gevonden = None
            for ring in range(1, int(2.0 / res)):
                for dx in range(-ring, ring + 1):
                    for cx, cy in ((sx + dx, sy - ring), (sx + dx, sy + ring),
                                   (sx - ring, sy + dx), (sx + ring, sy + dx)):
                        if free(cx, cy):
                            gevonden = (cx, cy)
                            break
                    if gevonden:
                        break
                if gevonden:
                    break
            if gevonden is None:
                return None, "geen vrije cel bij de startpositie"
            sx, sy = gevonden
            notitie = "start lag in bezet gebied (dock), gemeten vanaf (%.2f, %.2f)" % (
                ox + sx * res, oy + sy * res)

        seen = bytearray(w * h)
        seen[sy * w + sx] = 1
        q = [(sx, sy)]
        head = 0
        while head < len(q):
            cx, cy = q[head]
            head += 1
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = cx + dx, cy + dy
                if free(nx, ny) and not seen[ny * w + nx]:
                    seen[ny * w + nx] = 1
                    q.append((nx, ny))

        weg = []
        for (x, y) in pts:
            cx = int((x - ox) / res)
            cy = int((y - oy) / res)
            if not (0 <= cx < w and 0 <= cy < h) or not seen[cy * w + cx]:
                weg.append((x, y))
        return weg, notitie or "%d cellen bereikbaar" % sum(seen)

    def nav_to(self, x, y, yaw=None, timeout=120.0):
        """Let the planner drive the short approach to a point.

        A recorded channel starts where the mower once crossed between two
        zones, not where it happens to stand, so something has to cover the gap.
        Drawing a straight line over it and handing that to Pure Pursuit fails
        as soon as anything is in the way: standing next to the dock the
        controller reported "detected collision ahead" three times and gave up
        within a tenth of a second, because the dock itself is lethal in the
        costmap (live LFIN2230700238, 2026-09-14). Planning is exactly what the
        global planner is for, and over a few metres inside one zone it has no
        room to invent a route across the garden.
        """
        ac = ActionClient(self.node, NavigateToPose, "/navigate_to_pose")
        if not ac.wait_for_server(timeout_sec=8.0):
            return False, "no navigate_to_pose server"
        goal = NavigateToPose.Goal()
        goal.pose.header.frame_id = "map"
        goal.pose.pose.position.x = float(x)
        goal.pose.pose.position.y = float(y)
        th = 0.0 if yaw is None else float(yaw)
        goal.pose.pose.orientation.z = math.sin(th / 2.0)
        goal.pose.pose.orientation.w = math.cos(th / 2.0)
        send_fut = ac.send_goal_async(goal)
        rclpy.spin_until_future_complete(self.node, send_fut, timeout_sec=10.0)
        gh = send_fut.result()
        if gh is None or not gh.accepted:
            return False, "nav_to_pose goal rejected"
        res_fut = gh.get_result_async()
        rclpy.spin_until_future_complete(self.node, res_fut, timeout_sec=timeout)
        r = res_fut.result()
        if r is None:
            return False, "nav_to_pose timeout"
        return (r.status == 4), f"nav_to_pose_status_{r.status}"

    def follow_path(self, pts):
        path = Path()
        path.header.frame_id = "map"
        n = len(pts)
        for i, (x, y) in enumerate(pts):
            ps = PoseStamped()
            ps.header.frame_id = "map"
            ps.pose.position.x = float(x)
            ps.pose.position.y = float(y)
            if i < n - 1:
                yaw = math.atan2(pts[i + 1][1] - y, pts[i + 1][0] - x)
            elif n > 1:
                yaw = math.atan2(y - pts[i - 1][1], x - pts[i - 1][0])
            else:
                yaw = 0.0
            ps.pose.orientation.z = math.sin(yaw / 2.0)
            ps.pose.orientation.w = math.cos(yaw / 2.0)
            path.poses.append(ps)
        ac = ActionClient(self.node, FollowPath, "/follow_path")
        if not ac.wait_for_server(timeout_sec=8.0):
            return False, "no follow_path server"
        goal = FollowPath.Goal()
        goal.path = path
        goal.controller_id = "FollowPathPurePursuit"
        goal.goal_checker_id = "general_goal_checker"
        send_fut = ac.send_goal_async(goal)
        rclpy.spin_until_future_complete(self.node, send_fut, timeout_sec=10.0)
        gh = send_fut.result()
        if gh is None or not gh.accepted:
            return False, "goal rejected"
        res_fut = gh.get_result_async()
        rclpy.spin_until_future_complete(self.node, res_fut, timeout_sec=600.0)
        res = res_fut.result()
        if res is None:
            return False, "no result (timeout)"
        # GoalStatus.STATUS_SUCCEEDED == 4; anything else (ABORTED 6, CANCELED 5)
        # means the controller did not finish the path (e.g. "Failed to make
        # progress"), so do NOT fall through to coverage as if it drove.
        if getattr(res, "status", 4) != 4:
            return False, f"followpath_aborted_status_{res.status}"
        return True, "ok"

    def start_cov(self, map_ids, cutterhigh, direction):
        cli = self.node.create_client(StartCoverageTask, f"{DECISION}/start_cov_task")
        if not cli.wait_for_service(timeout_sec=8.0):
            return False
        map_ids = int(map_ids)
        names = map_names_for(map_ids)
        req = StartCoverageTask.Request()
        req.cov_mode = 0            # NORMAL: select map(s) by id
        req.request_type = 11       # normal mqtt/app start
        if names:
            # Zone 5 and up cannot be addressed by the number: coverRequestDataInit
            # swaps any selection above 60000 (or exactly 255) for a leftover test
            # task called "vision_test", the planner finds no boundary in it and
            # the mower reports error 125. The same service takes a list of map
            # files instead, decoded after that check, so it reaches every slot.
            # First shipped in v6.0.2-custom-40; the server's area gate keys on
            # that build number. Proven live on LFIN2230700238, 2026-09-12: map5 (100000) undocked,
            # mowed and finished normally. The .yaml extension is required; the
            # bare name is what produced error 118 in earlier attempts.
            req.map_ids = 0
            req.map_names = names
            req.blade_heights = [int(cutterhigh)] * len(names)
            log(f"start_cov: map_ids={map_ids} is beyond the firmware limit, "
                f"using map_names={names}")
        else:
            req.map_ids = map_ids   # decimal positional bitmask (map3 -> 1000)
            req.map_names = []
            req.blade_heights = [int(cutterhigh)]
        req.specify_direction = direction is not None
        req.cov_direction = int(direction) if direction is not None else 0
        fut = cli.call_async(req)
        rclpy.spin_until_future_complete(self.node, fut, timeout_sec=15.0)
        r = fut.result()
        return bool(r and r.result)

    def wait_status(self, pred, timeout=30.0):
        """Block until robot_decision's RobotStatus satisfies pred(task_mode,
        work_status), via a throwaway probe node (released afterwards, like
        robot_xy). Returns the last (task_mode, work_status) seen, or None."""
        probe = self._probe()
        deadline = time.time() + timeout
        while time.time() < deadline:
            rclpy.spin_once(probe, timeout_sec=0.2)
            v = self._status
            if v is not None and pred(*v):
                return v
        return self._status

    def recharge_active(self, timeout=4.0):
        """True while RobotStatus reports the mower is on its way to the dock."""
        probe = self._probe()
        deadline = time.time() + timeout
        while time.time() < deadline:
            rclpy.spin_once(probe, timeout_sec=0.2)
            if self._recharge is not None:
                return self._recharge in RECHARGE_DRIVING
        return False

    def quit_mapping_mode(self):
        """Clear a parked task: robot_decision goes back to COVERAGE/WAIT."""
        cli = self.node.create_client(Empty, f"{DECISION}/quit_mapping_mode")
        if not cli.wait_for_service(timeout_sec=5.0):
            return False
        fut = cli.call_async(Empty.Request())
        rclpy.spin_until_future_complete(self.node, fut, timeout_sec=10.0)
        return fut.done()

    def stop_task(self):
        """Stop a running coverage task (SetBool data:true; false means CONTINUE)."""
        cli = self.node.create_client(SetBool, f"{DECISION}/stop_task")
        if not cli.wait_for_service(timeout_sec=5.0):
            return False
        req = SetBool.Request()
        req.data = True
        fut = cli.call_async(req)
        rclpy.spin_until_future_complete(self.node, fut, timeout_sec=10.0)
        r = fut.result()
        return bool(r and r.success)

    def localize_via_firmware(self, map_ids, cutterhigh, direction, timeout=90.0):
        """Let the STOCK firmware initialise the map frame, then take back over.

        Standing on the dock after a boot the mower has its RTK origin but no
        map->base_link: that frame only appears once it moves and the firmware
        seeds a heading from the GPS track. robot_decision does exactly that at
        the start of every task (SYSTEM_CHECK_INIT -> LOCALIZATION_UTM_INIT ->
        SENSOR_INIT -> QUIT_PILE_INIT -> INIT_SUCCESS), so we ask it for a task,
        wait until the frame appears, and stop it again before it free-plans its
        own way to the zone. The transit below then drives the recorded channel,
        which is the whole reason this orchestrator exists.

        Driving ourselves does not work: a short open-loop reverse gives no
        heading, so TF never arrives and the mow stalled on the dock (live .244,
        2026-09-12, three attempts in a row).
        """
        log("not localized: asking the firmware to initialise the frame")
        phase("localizing")
        if not self.start_cov(map_ids, cutterhigh, direction):
            log("firmware refused the init task")
            return None
        deadline = time.time() + timeout
        pos = None
        while time.time() < deadline:
            pos = self.robot_xy(timeout=2.0)
            if pos is not None:
                break
        # A mower that was already localized has a frame before it moves. Stop
        # only once the firmware has finished its own departure (INIT_SUCCESS
        # or later), so the transit never starts from the dock itself.
        self.wait_status(
            lambda tm, ws: ws >= WORK_STATUS_INIT_SUCCESS or not task_executing(tm, ws),
            timeout=max(5.0, deadline - time.time()))
        self.stop_task()
        # The stop is queued behind the init states and only lands once the
        # task reaches MOVING, as USER_STOP. A parked task still counts as
        # executing, so a start_cov right after the stop was refused with
        # "Cannot start a new task when last task is executing" (live .244,
        # 2026-09-14). Wait for the stop to land, then clear the parked task
        # the way the delete flow does, and only then hand over the wheels.
        st = self.wait_status(
            lambda tm, ws: ws == WORK_STATUS_USER_STOP or not task_executing(tm, ws),
            timeout=30.0)
        log(f"after stop: status={st}")
        if st is not None and task_executing(*st):
            self.quit_mapping_mode()
            st = self.wait_status(lambda tm, ws: not task_executing(tm, ws), timeout=15.0)
            log(f"after quit_mapping_mode: status={st}")
        # Give the chassis a moment to settle before the transit takes the wheels.
        time.sleep(2.0)
        if pos is None:
            log("firmware init ran but the map frame never appeared")
        else:
            log(f"firmware init done: robot={pos}")
        return pos

    def cancel_recharge(self):
        """Abort a recharge the firmware started on its own.

        After a failed attempt robot_decision sends itself home
        (Recharge: RETURN_TO_PILE) and that navigation holds the wheels. A
        transit started in that window never gets them: the NavigateToPose goal
        is aborted before nav2 even logs it, and the run ends on
        nav_to_pose_status_6 while the mower calmly drives to its dock (live
        LFIN2230700238, 2026-09-14).
        """
        cli = self.node.create_client(Trigger, f"{DECISION}/cancel_recharge")
        if not cli.wait_for_service(timeout_sec=5.0):
            return False
        fut = cli.call_async(Trigger.Request())
        rclpy.spin_until_future_complete(self.node, fut, timeout_sec=10.0)
        r = fut.result()
        return bool(r and r.success)

    def auto_recharge(self):
        """Start the visual (ArUco) dock via /robot_decision/auto_recharge.
        This is the same final approach the reanchor flow uses; it is NOT
        nav_to_recharge (goal-based nav that cuts across the hedge). Returns
        True when the trigger is accepted; the firmware then docks on its own."""
        cli = self.node.create_client(Trigger, f"{DECISION}/auto_recharge")
        if not cli.wait_for_service(timeout_sec=8.0):
            return False
        fut = cli.call_async(Trigger.Request())
        rclpy.spin_until_future_complete(self.node, fut, timeout_sec=15.0)
        r = fut.result()
        return bool(r and r.success)

    def _client(self, srv_type, name):
        """One cached service client per service name."""
        cli = self._clients.get(name)
        if cli is None:
            cli = self._clients[name] = self.node.create_client(srv_type, name)
        return cli

    def _call(self, srv_type, name, req, timeout=8.0):
        cli = self._client(srv_type, name)
        if not cli.wait_for_service(timeout_sec=timeout):
            return False
        fut = cli.call_async(req)
        rclpy.spin_until_future_complete(self.node, fut, timeout_sec=timeout)
        return fut.result() is not None

    def set_headlight(self, level, match_timeout=3.0):
        """Headlight 0..100 on /led_set. Only the Phase-0 probe uses this;
        during a patrol the server switches the light (patrolService.ts).

        A volatile publisher drops a sample that goes out before the chassis
        subscriber is matched, so wait for the match first. Without a
        subscriber nothing is sent and this returns False."""
        if self._pub_led is None:
            self._pub_led = self.node.create_publisher(
                UInt8, LED_TOPIC, QoSProfile(depth=1, history=QoSHistoryPolicy.KEEP_LAST))
        deadline = time.time() + match_timeout
        count = self._pub_led.get_subscription_count()
        while count == 0 and time.time() < deadline:
            rclpy.spin_once(self.node, timeout_sec=0.1)
            count = self._pub_led.get_subscription_count()
        if count == 0:
            log(f"headlight: no {LED_TOPIC} subscriber, level {level} not sent")
            return False
        m = UInt8()
        m.data = max(0, min(100, int(level)))
        self._pub_led.publish(m)
        time.sleep(0.2)
        self._pub_led.publish(m)
        return True

    def ensure_perception(self):
        """Both cameras, perception and the detection model on. Outside a task
        the cameras are off (auto_map_node.py, live .244 2026-07-23) and
        robot_decision may switch them off again, so this runs before every
        look. Every call is idempotent. True when all four answered."""
        from general_msgs.srv import SetUint8   # alleen op de maaier aanwezig
        ok = True
        for name in ("/camera/preposition/start_camera", "/camera/tof/start_camera",
                     "/perception/do_perception"):
            req = SetBool.Request()
            req.data = True
            ok = self._call(SetBool, name, req) and ok
        req = SetUint8.Request()
        req.value = 2   # detection: person, animal, obstacle, ...
        return self._call(SetUint8, "/perception/set_infer_model", req) and ok

    def watch_labels(self, seconds):
        """Patrol counts per points_labeled message for `seconds`.
        Returns ({"person": [...], "animal": [...]}, number_of_messages)."""
        probe = self._probe()
        if self._label_sub is None:
            from sensor_msgs.msg import PointCloud2

            def _on(msg):
                if self._label_buf is not None:
                    self._label_buf.append(label_counts(msg.data, msg.point_step,
                                                        label_offset(msg.fields)))
            self._label_sub = probe.create_subscription(
                PointCloud2, "/perception/points_labeled", _on,
                QoSProfile(depth=1, history=QoSHistoryPolicy.KEEP_LAST))
        self._label_buf = []
        deadline = time.time() + seconds
        while time.time() < deadline:
            rclpy.spin_once(probe, timeout_sec=0.2)
        got, self._label_buf = self._label_buf, None
        return {name: [c[name] for c in got] for name in PATROL_LABELS.values()}, len(got)


DOCK_HOME_RADIUS = 1.2   # within this of the map origin counts as "home"

# Rijden we zelf over de opgenomen kanalen, of laat de firmware zijn eigen weg
# plannen? AAN, want dat is waar een kanaal voor bestaat. De firmware kent ze
# niet: coverage_planner_server noemt "unicom" geen enkele keer, en
# robot_decision alleen in de opname-paden. Zijn reis naar een zone is een
# NavigateToPose over de globale costmap, en die kiest het kortste vrije pad,
# desnoods dwars over gras waar de maaier ooit per ongeluk doorheen is gereden
# (live LFIN2230700238, 2026-09-14: twee keer de struiken in, twee keer
# afgebroken door de perceptie, daarna naar huis).
#
# In map.pgm valt "via het kanaal" niet af te dwingen: de vrije doorgang is
# breed en loopt meters naast de opgenomen lijn. Hier wel, want deze code rijdt
# het pad zelf met FollowPath. Kortste route naar het doelgebied, maar over de
# kanalen. `MOW_ZONE_TRANSIT=0` laat het weer aan de firmware over.
USE_TRANSIT = os.environ.get("MOW_ZONE_TRANSIT", "1").strip().lower() not in ("0", "false", "off", "no")


def _transit_unicoms():
    """Every map<->map unicom segment as (points, filename)."""
    base = _csv_base()
    out = []
    try:
        names = os.listdir(base)
    except OSError:
        names = []
    for f in names:
        if re.match(r"^map\d+tomap\d+_\d+_unicom\.csv$", f):
            pts = read_xy_csv(os.path.join(base, f))
            if len(pts) >= 2:
                out.append((pts, f))
    return out


def _zone_containing(xy):
    """'mapN' whose work polygon contains xy (no dock radius), else None."""
    if xy is None:
        return None
    base = _csv_base()
    try:
        names = os.listdir(base)
    except OSError:
        names = []
    for f in sorted(names):
        m = re.fullmatch(r"(map\d+)_work\.csv", f)
        if m and point_in_poly(xy[0], xy[1], read_xy_csv(os.path.join(base, f))):
            return m.group(1)
    return None


DOCK_ZONE_NEAR_M = 2.0   # a dock beside its zone, not in it, still belongs to it


def _dock_channel():
    """(zone, first point) of the dock channel: mapNtocharge_unicom.csv, the
    lowest N first. Usually map0, but a garden whose first zone was deleted
    has its channel under another one (the server takes any mapNtocharge too,
    services/anchor.ts). Only map0 counted here, so such a mower had no dock
    zone and every edge cut but the dock's ended in no_route_to_zone (#142)."""
    for base in (f"{MAPS_HOME}/x3_csv_file", f"{MAPS_HOME}/csv_file"):
        try:
            names = os.listdir(base)
        except OSError:
            continue
        hits = sorted((int(m.group(1)), f) for f in names
                      for m in [re.fullmatch(r"map(\d+)tocharge_unicom\.csv", f)] if m)
        for n, f in hits:
            pts = read_xy_csv(os.path.join(base, f))
            if pts:
                return f"map{n}", pts[0]
    return None, None


def _dock_anchor():
    """Where the charging station stands: the FIRST point of the dock channel,
    which is what the firmware writes as the anchor."""
    return _dock_channel()[1]


def _dist_to_poly(p, poly):
    """Distance from a point to a polygon's boundary."""
    best = float("inf")
    for a, b in zip(poly, poly[1:] + poly[:1]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
        best = min(best, _dist(p, (a[0] + t * dx, a[1] + t * dy)))
    return best


def _dock_zone():
    """Zone the charging station belongs to: the polygon around the dock
    anchor; for a dock just outside every zone the zone its channel is named
    after, else the nearest zone within DOCK_ZONE_NEAR_M."""
    zone, anchor = _dock_channel()
    if not anchor:
        return None
    inside = _zone_containing(anchor)
    if inside:
        return inside
    polys = {z: p for z, p in _work_polys().items() if len(p) >= 3}
    if zone in polys:
        return zone
    near = sorted((_dist_to_poly(anchor, p), z) for z, p in polys.items())
    return near[0][1] if near and near[0][0] <= DOCK_ZONE_NEAR_M else None


NEAR_ZONE_M = 2.0        # a robot this close to a zone's border starts from it
NEAR_DOCK_M = 3.0        # still at the dock after the firmware's 1 m departure


def _start_zone(robot, from_slot):
    """The zone a route starts from. "dock" is the dock's zone. A robot in no
    polygon at all (a dock pad beside the lawn, a departure that ended past
    the border) starts from the zone within NEAR_ZONE_M, else from the dock's
    zone while it is still near the dock. Mowing never noticed this: with no
    start zone it hands the task to the firmware. An edge cut has nothing to
    fall back on and was refused with no_route_to_zone (#142, live: on
    LFIN1231000211 the anchor is 6 cm outside map0)."""
    if from_slot == "dock":
        return _dock_zone()
    if from_slot:
        return from_slot
    if robot is None:
        return None
    polys = {z: p for z, p in _work_polys().items() if len(p) >= 3}
    near = sorted((_dist_to_poly(robot, p), z) for z, p in polys.items())
    if near and near[0][0] <= NEAR_ZONE_M:
        return near[0][1]
    anchor = _dock_anchor()
    if anchor and _dist(robot, anchor) <= NEAR_DOCK_M:
        return _dock_zone()
    return None


def find_stale_mow_drives(proc_root="/proc", self_pid=None):
    """Other mow_zone_drive processes. A run that hangs keeps its iceoryx chunks
    and the next one cannot get a single 4 MB block, so it strands where it
    stands. Read procfs, never pgrep: our own argv carries the script name too."""
    me = os.getpid() if self_pid is None else self_pid
    out = []
    try:
        entries = os.listdir(proc_root)
    except OSError:
        return out
    for name in entries:
        if not name.isdigit() or int(name) == me:
            continue
        try:
            with open(f"{proc_root}/{name}/cmdline", "rb") as fh:
                cmd = fh.read().replace(b"\0", b" ").decode("utf-8", "replace")
        except OSError:
            continue
        # Alleen echte ritten tellen: een droogloop (`check`) rijdt niet en
        # mag de volgende start niet blokkeren, en onze eigen wrapper-shell
        # draagt het scriptpad ook in zijn argv.
        if re.search(r"mow_zone_drive\.py\s+(mow|edge|return|patrol)\b", cmd):
            out.append(int(name))
    return out


def channel_graph(names):
    """Undirected graph of recorded map<->map channels: slot -> {other: filename}.

    A channel is recorded in one direction but drivable either way, so
    map1tomap0_0_unicom.csv connects map0 and map1 both ways. Between the same
    pair the lowest-numbered file wins, which keeps the route reproducible.
    """
    graph = {}
    for f in sorted(names):
        m = re.fullmatch(r"(map\d+)tomap(\d+)_(\d+)_unicom\.csv", f)
        if not m:
            continue
        a, b = m.group(1), f"map{m.group(2)}"
        if a == b:
            continue
        graph.setdefault(a, {}).setdefault(b, f)
        graph.setdefault(b, {}).setdefault(a, f)
    return graph


def channel_route(from_slot, to_slot, graph):
    """Shortest chain of channel files from one zone to another, [] if none.

    Zones are rarely all connected to each other: a garden reads as a chain
    (map0 - map1 - map4 - map5 - map6 on LFIN2230700238), so asking only for a
    direct mapAtomapB file finds nothing and the mower is left to plan its own
    way across the garden. Breadth-first gives the fewest recorded channels
    that get there.
    """
    if not from_slot or not to_slot or from_slot == to_slot:
        return []
    seen = {from_slot}
    queue = [(from_slot, [])]
    while queue:
        node, path = queue.pop(0)
        for nxt, fname in sorted(graph.get(node, {}).items()):
            if nxt in seen:
                continue
            hop = path + [fname]
            if nxt == to_slot:
                return hop
            seen.add(nxt)
            queue.append((nxt, hop))
    return []


def _channel_files(from_slot, to_slot):
    """The recorded channels the transit would drive, in order.

    Empty while the transit is off, which is the single gate for both callers:
    do_mow then neither takes the wheels nor does the init dance, and hands the
    whole task to robot_decision in one start.
    """
    if not USE_TRANSIT:
        return []
    base = _csv_base()
    try:
        names = os.listdir(base)
    except OSError:
        names = []
    return channel_route(from_slot, to_slot, channel_graph(names))


# Zones that touch or overlap are connected without a recorded channel: the
# firmware only records one between separated zones, and nav2's map has the
# touching ones joined. An edge cut of such a zone was refused with
# no_channel_to_zone (field report, custom-47: only the dock's zone worked).
# A touch step is driven by the planner (nav_to), into the next zone.
TOUCH_GAP_M = 0.3
TOUCH_SAMPLE_M = 0.25      # boundary points kept for the touch test
ENTER_DEPTH_M = 0.8        # how far into the next zone a touch step aims


def _sparse(poly, step=TOUCH_SAMPLE_M):
    """Boundary points about `step` apart (the CSVs hold one every few cm)."""
    out = []
    for p in poly:
        if not out or _dist(out[-1], p) >= step:
            out.append(p)
    return out


def zones_touch(a, b, gap=TOUCH_GAP_M):
    """Do two work polygons overlap, or come within `gap` of each other?"""
    if len(a) < 3 or len(b) < 3:
        return False
    if (max(x for x, _ in a) + gap < min(x for x, _ in b) or max(x for x, _ in b) + gap < min(x for x, _ in a) or
            max(y for _, y in a) + gap < min(y for _, y in b) or max(y for _, y in b) + gap < min(y for _, y in a)):
        return False
    sa, sb = _sparse(a), _sparse(b)
    if any(point_in_poly(x, y, b) for x, y in sa) or any(point_in_poly(x, y, a) for x, y in sb):
        return True
    # Sampled points lie at most TOUCH_SAMPLE_M apart, so allow half of that.
    limit = gap + TOUCH_SAMPLE_M / 2
    return any(_dist(p, q) <= limit for p in sa for q in sb)


def _work_polys():
    base = _csv_base()
    try:
        names = os.listdir(base)
    except OSError:
        names = []
    polys = {}
    for f in names:
        m = re.fullmatch(r"(map\d+)_work\.csv", f)
        if m:
            polys[m.group(1)] = read_xy_csv(os.path.join(base, f))
    return polys


def edge_route(from_slot, to_slot):
    """Fewest steps from one zone to another for an edge cut: recorded
    channels ("channel", file, zone) and touching zones ("touch", None, zone).
    A recorded channel wins where both connect the same pair. [] if none."""
    if not from_slot or not to_slot or from_slot == to_slot:
        return []
    base = _csv_base()
    try:
        names = os.listdir(base)
    except OSError:
        names = []
    channels = channel_graph(names) if USE_TRANSIT else {}
    polys = _work_polys()
    seen = {from_slot}
    queue = [(from_slot, [])]
    while queue:
        node, path = queue.pop(0)
        steps = [("channel", f, z) for z, f in sorted(channels.get(node, {}).items())]
        steps += [("touch", None, z) for z in sorted(polys)
                  if z != node and z not in channels.get(node, {}) and z in polys and node in polys
                  and zones_touch(polys[node], polys[z])]
        for kind, fname, nxt in steps:
            if nxt in seen:
                continue
            hop = path + [(kind, fname, nxt)]
            if nxt == to_slot:
                return hop
            seen.add(nxt)
            queue.append((nxt, hop))
    return []


def _entry_point(poly, robot, depth=ENTER_DEPTH_M):
    """A point inside `poly` near the robot: from the nearest boundary point a
    little way towards the middle."""
    if len(poly) < 3 or robot is None:
        return None
    near = min(_sparse(poly), key=lambda p: _dist(p, robot))
    cx = sum(x for x, _ in poly) / len(poly)
    cy = sum(y for _, y in poly) / len(poly)
    length = math.hypot(cx - near[0], cy - near[1]) or 1.0
    for d in (depth, depth / 2, depth * 1.5, depth * 2.5):
        t = (near[0] + (cx - near[0]) / length * d, near[1] + (cy - near[1]) / length * d)
        if point_in_poly(t[0], t[1], poly):
            return t
    return (cx, cy) if point_in_poly(cx, cy, poly) else None


def _cover(drv, map_ids, cutterhigh, direction):
    """Coverage through robot_decision (keeps the normal state machine)."""
    phase("covering")
    ok = drv.start_cov(map_ids, cutterhigh, direction)
    phase("done" if ok else "error", "" if ok else "start_cov_task_failed")
    return 0 if ok else 1


# recharge_status-waarden waarbij de firmware onderweg is naar het dock en dus
# de wielen heeft. 0 = WAIT, 9 = opgeladen/klaar; daartussen rijdt hij.
RECHARGE_DRIVING = (1, 2, 3, 4, 5, 6, 7, 8)


def clear_recharge(drv):
    """Break off a recharge the firmware started itself, and wait until it lets go."""
    st = drv.wait_status(lambda tm, ws: True, timeout=5.0)
    if st is None:
        return
    # wait_status geeft (task_mode, work_status); de recharge-status lezen we
    # via hetzelfde bericht, dus daarvoor is een eigen peiling nodig.
    if not drv.recharge_active():
        return
    log("firmware is onderweg naar het dock, recharge afbreken")
    drv.cancel_recharge()
    for _ in range(15):
        if not drv.recharge_active():
            log("recharge afgebroken")
            return
        time.sleep(1.0)
    log("recharge stopte niet binnen 15 s, we gaan toch verder")


def clear_parked_task(drv):
    """A task parked by an earlier attempt (USER_STOP) still counts as
    executing, so the next start_cov is refused. Clear it first, the way the
    delete flow does. No-op when nothing is parked."""
    st = drv.wait_status(lambda tm, ws: True, timeout=5.0)
    if st is None or not task_parked(*st):
        return
    log(f"parked task found (status={st}): clearing it first")
    drv.quit_mapping_mode()
    log(f"after quit_mapping_mode: status={drv.wait_status(lambda tm, ws: not task_executing(tm, ws), timeout=15.0)}")


def _drive_channel_hop(drv, base, fname, robot, hop, total):
    """Drive one recorded channel from where the mower is. (ok, msg, robot)."""
    pts = read_xy_csv(os.path.join(base, fname))
    if len(pts) < 2:
        return False, "unicom_empty", robot
    if _dist(robot, pts[0]) > _dist(robot, pts[-1]):
        pts = list(reversed(pts))   # start at the robot's end
    # Drop the points BEHIND the mower (between it and the dock end).
    # After the ~1m undock the mower sits ~1m along the line but still
    # near the dock; without trimming, the controller first heads back
    # to the dock end, hits the dock (lethal cost 255 in the costmap)
    # and aborts with "collision ahead". Starting the path at the
    # nearest point makes it drive forward from where it actually is.
    # The same holds at every hop: the mower lands somewhere along the
    # next channel, not at its recorded start.
    pts = _trim_to_nearest(pts, robot)
    # Aanloop naar het begin van het kanaal door de planner, niet
    # door ons: een rechte lijn vanaf een willekeurige plek loopt
    # zo tegen het dock of een struik. Zie Driver.nav_to.
    gap = _dist(robot, pts[0])
    if gap > LEAD_IN_MAX_M:
        log(f"transit hop {hop + 1}/{total}: {gap:.1f} m aanloop naar "
            f"{pts[0]}, laat de planner dat doen")
        aankomst = (math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0])
                    if len(pts) > 1 else None)
        ok, msg = drv.nav_to(pts[0][0], pts[0][1], yaw=aankomst)
        if not ok:
            log(f"transit hop {hop + 1}/{total} aanloop faalde: {msg}")
            return False, msg, robot
        robot = drv.robot_xy() or robot
        pts = _trim_to_nearest(read_xy_csv(os.path.join(base, fname)), robot)
        if _dist(robot, pts[0]) > _dist(robot, pts[-1]):
            pts = list(reversed(pts))
            pts = _trim_to_nearest(pts, robot)
    pts = densify(_lead_in(pts, robot))
    ok, msg = drv.follow_path(pts)
    if not ok:
        log(f"transit hop {hop + 1}/{total} ({fname}) failed: {msg}")
        return False, msg, robot
    robot = drv.robot_xy() or pts[-1]
    log(f"transit hop {hop + 1}/{total} done, robot={robot}")
    return True, "", robot


def _drive_hops(drv, base, robot, hops):
    """Drive a route from edge_route(): recorded channels and steps into a
    touching zone, with the transit controller params relaxed and always
    restored. Shared by the edge cut and the night patrol. (ok, msg, robot)."""
    drv.set_params([(n, r) for (n, r, _d) in TRANSIT_PARAMS])
    drv.log_applied_params([n for (n, _r, _d) in TRANSIT_PARAMS])
    try:
        for i, (kind, fname, zone) in enumerate(hops):
            if kind == "channel":
                ok, msg, robot = _drive_channel_hop(drv, base, fname, robot, i, len(hops))
            else:
                target = _entry_point(read_xy_csv(os.path.join(base, f"{zone}_work.csv")), robot)
                if target is None:
                    ok, msg = False, "no_entry_point"
                else:
                    log(f"hop {i + 1}/{len(hops)}: into touching {zone} at {target}")
                    ok, msg = drv.nav_to(target[0], target[1])
                    robot = drv.robot_xy() or target
            if not ok:
                return False, msg, robot
    finally:
        drv.set_params([(n, d) for (n, _r, d) in TRANSIT_PARAMS])
        log("restored controller params")
    return True, "", robot


def _edge_transit(drv, base, robot, from_slot, to_slot, already_in):
    """Edge cut (#148): get into the target zone over recorded channels and
    touching zones, then PHASE edge_ready. extended_commands.py then starts
    the edge cut of that zone from where the mower stands."""
    # Still within the dock disc after the departure: the route starts in the
    # dock's zone.
    route_from = _start_zone(robot, from_slot)
    hops = [] if already_in else edge_route(route_from, to_slot)
    log(f"edge transit: robot={robot} from={from_slot} start zone={route_from} "
        f"to={to_slot} already_in={already_in} hops={[(k, z) for k, _f, z in hops]}")
    if not already_in and route_from != to_slot and not hops:
        log(f"edge: no route from {route_from} to {to_slot}; dock zone={_dock_zone()} "
            f"anchor={_dock_anchor()} zones={sorted(_work_polys())} "
            f"channels={sorted(f for f in os.listdir(base) if f.endswith('_unicom.csv')) if os.path.isdir(base) else []}")
        phase("error", "no_route_to_zone")
        return 1
    if hops:
        log(f"edge route {route_from} -> {to_slot}: {hops}")
        phase("following_unicom" if any(k == "channel" for k, _f, _z in hops) else "entering_zone")
        ok, msg, robot = _drive_hops(drv, base, robot, hops)
        if not ok:
            phase("error", msg)
            return 1
    phase("edge_ready")
    return 0


def do_mow(drv, to_slot, map_ids, cutterhigh, direction, edge=False):
    """Outbound: undock -> follow the unicom to the target zone -> coverage.

    edge=True (#148): the same departure and transit, then stop with PHASE
    edge_ready instead of starting coverage; extended_commands.py starts the
    edge cut of the zone the mower now stands in. An edge cut has no firmware
    task that drives to the zone for us, and a free-planned approach is what
    took mowers through the hedge, so the route uses recorded channels and
    zones that touch (a planner step into the next zone, inside the lawn the
    map holds). A zone reachable neither way is refused instead of guessed."""
    # A live task already owns the wheels (e.g. the app's start_navigation
    # fallback won the race while this process was still starting). Reloading
    # the map and quitting that task left the coverage running without
    # robot_decision supervision (Novabot-7xu, David 2026-10-04): leave it be.
    st = drv.wait_status(lambda tm, ws: True, timeout=5.0)
    if st is not None and task_executing(*st) and not task_parked(*st):
        log(f"live task found (status={st}): not touching it")
        phase("error", "busy_mowing")
        return 1
    # Eerst de kaart die nav2 gebruikt gelijktrekken met de kaart op schijf.
    # Elke navigatie hierna (aanloop, terugweg, het dock) plant op wat
    # map_server nu vasthoudt, en dat was tot nu toe de kaart van het opstarten.
    ok, detail = drv.reload_map()
    log(f"map_server reload: {'ok' if ok else 'MISLUKT'} ({detail})")
    clear_parked_task(drv)
    clear_recharge(drv)
    robot = drv.robot_xy()
    if robot is None or current_zone_slot(robot) == "dock":
        # On the dock (no map->base_link yet after a fresh boot, or localized):
        # the departure is the firmware's own, exactly as stock (QUIT_PILE,
        # robot_decision.yaml quit_pile_distance 1.0 m). We never reverse off
        # the dock ourselves; the 2.25 m open-loop undock we used to do was not
        # stock (Walter, 2026-10-07).
        # Without a channel from the dock's zone to the target, the firmware
        # task IS the mow: hand it over in one go. Starting it only to stop and
        # start it again is what produced "Cannot start a new task when last
        # task is executing" (live .244, 2026-09-14).
        home = _dock_zone()
        log(f"on the dock: dock zone={home} anchor={_dock_anchor()} to={to_slot} edge={edge}")
        if edge:
            if to_slot != home and not edge_route(home, to_slot):
                log(f"edge: on the dock, no channel or touching zones {home}->{to_slot}; "
                    f"zones={sorted(_work_polys())}")
                phase("error", "no_route_to_zone")
                return 1
        elif not _channel_files(home, to_slot):
            log(f"on the dock, no channel {home}->{to_slot}: the firmware runs the whole task")
            return _cover(drv, map_ids, cutterhigh, direction)
        # A channel to drive: the firmware departs, then we take over.
        if drv.localize_via_firmware(map_ids, cutterhigh, direction) is None:
            phase("error", "not_localized")
            return 1
        robot = drv.robot_xy()   # where the departure left it, not the dock pose
        if robot is None:
            phase("error", "not_localized")
            return 1
        from_slot = current_zone_slot(robot)
        log(f"post-departure: robot={robot} from={from_slot}")
    else:
        from_slot = current_zone_slot(robot)
        log(f"mow start: robot={robot} from={from_slot} to={to_slot} map_ids={map_ids}")

    # 2. transit along the recorded unicom, if one exists and we are not
    #    already inside the target zone
    base = _csv_base()
    target_poly = read_xy_csv(os.path.join(base, f"{to_slot}_work.csv"))
    already_in = bool(robot and len(target_poly) >= 3 and
                      point_in_poly(robot[0], robot[1], target_poly))
    if edge:
        return _edge_transit(drv, base, robot, from_slot, to_slot, already_in)
    uni = _channel_files(_start_zone(robot, from_slot), to_slot) if not already_in else []
    if uni:
        log(f"transit route {from_slot} -> {to_slot}: {' + '.join(uni)}")
        phase("following_unicom")
        drv.set_params([(n, r) for (n, r, _d) in TRANSIT_PARAMS])
        drv.log_applied_params([n for (n, _r, _d) in TRANSIT_PARAMS])
        try:
            for hop, fname in enumerate(uni):
                ok, msg, robot = _drive_channel_hop(drv, base, fname, robot, hop, len(uni))
                if not ok:
                    phase("error", msg)
                    return 1
        finally:
            drv.set_params([(n, d) for (n, _r, d) in TRANSIT_PARAMS])
            log("restored controller params")
    else:
        log(f"transit skipped (route={bool(uni)} already_in={already_in})")

    # 3. coverage through robot_decision (keeps the normal state machine)
    return _cover(drv, map_ids, cutterhigh, direction)


def pick_homeward_segment(robot, origin, segs, used):
    """Pure: pick the unused segment whose 'away' end is nearest the robot and
    whose 'home' end (the endpoint nearer origin) actually advances toward home.
    Returns (oriented_pts, filename) with oriented_pts STARTING at the away end
    (near the robot) and ENDING at the home end, or None if nothing applies."""
    best = None   # (away_dist, oriented_pts, filename)
    for pts, f in segs:
        if f in used:
            continue
        if _dist(pts[0], origin) <= _dist(pts[-1], origin):
            home_end, away_end, oriented = pts[0], pts[-1], list(reversed(pts))
        else:
            home_end, away_end, oriented = pts[-1], pts[0], list(pts)
        if _dist(home_end, origin) >= _dist(robot, origin) - 0.2:
            continue                      # hop would not get us closer home
        d_away = _dist(robot, away_end)
        if d_away > 3.0:
            continue                      # entry end not near the robot
        if best is None or d_away < best[0]:
            best = (d_away, oriented, f)
    if best is None:
        return None
    return best[1], best[2]


def do_return(drv):
    """Return: follow the recorded unicom segments back to the dock, then dock.

    Greedy homeward walk over the map<->map unicom segments, independent of
    zone polygons (so it works even when the mower stopped at a zone edge and
    is inside no work polygon, which is exactly how a failed auto-recharge
    leaves it): repeatedly pick the unused segment whose 'away' end is nearest
    the robot and whose 'home' end (the end nearer the map origin = the dock)
    is closer to origin than the robot is now, drive it, and repeat until
    within DOCK_HOME_RADIUS of the dock. Then auto_recharge does the final
    visual dock (NOT nav_to_recharge, which is the goal-based nav that cuts
    across the hedge)."""
    origin = (0.0, 0.0)
    robot = drv.robot_xy()
    if robot is None:
        phase("error", "not_localized")
        return 1
    log(f"return: robot={robot} dist_home={_dist(robot, origin):.2f}")

    if _dist(robot, origin) > DOCK_HOME_RADIUS:
        segs = _transit_unicoms() if USE_TRANSIT else []
        used = set()
        phase("returning")
        drv.set_params([(n, r) for (n, r, _d) in TRANSIT_PARAMS])
        drv.log_applied_params([n for (n, _r, _d) in TRANSIT_PARAMS])
        try:
            for hop in range(6):
                if _dist(robot, origin) <= DOCK_HOME_RADIUS:
                    break
                pick = pick_homeward_segment(robot, origin, segs, used)
                if pick is None:
                    phase("error", f"no_return_segment_near_{robot[0]:.1f}_{robot[1]:.1f}")
                    return 1
                oriented, f = pick
                oriented = _trim_to_nearest(oriented, robot)
                log(f"return hop {hop}: {f} start={oriented[0]} end={oriented[-1]}")
                ok, msg = drv.follow_path(oriented)
                if not ok:
                    phase("error", msg)
                    return 1
                used.add(f)
                robot = drv.robot_xy() or robot
        finally:
            drv.set_params([(n, d) for (n, _r, d) in TRANSIT_PARAMS])
            log("restored controller params")

    phase("docking")
    ok = drv.auto_recharge()
    phase("done" if ok else "error", "" if ok else "auto_recharge_failed")
    return 0 if ok else 1


GOTO_UNICOM_MARGIN = 0.6   # a point this close to a recorded channel counts as on it


def _goto_target_allowed(x, y):
    """Only points the mower is meant to drive on: inside a work zone, or on a
    recorded channel between zones. Anything else (the road, the neighbour's
    garden, the pond) is refused before a single wheel turns."""
    base = _csv_base()
    try:
        names = os.listdir(base)
    except OSError:
        return False
    for f in names:
        if re.fullmatch(r"map\d+_work\.csv", f):
            poly = read_xy_csv(os.path.join(base, f))
            if len(poly) >= 3 and point_in_poly(x, y, poly):
                return True
    for pts, _f in _transit_unicoms():
        for a, b in zip(pts, pts[1:]):
            dx, dy = b[0] - a[0], b[1] - a[1]
            L = dx * dx + dy * dy
            t = 0.0 if L == 0 else max(0.0, min(1.0, ((x - a[0]) * dx + (y - a[1]) * dy) / L))
            if math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) <= GOTO_UNICOM_MARGIN:
                return True
    return False


def do_goto(drv, x, y, yaw):
    """Drive to one point in the map frame and stop there, blades off.

    The stock `navigate_to_position` MQTT command is a stub: mqtt_node parses
    it, prints it and answers result 0 without ever sending a goal (ghidra,
    api_navigate_to_position). This is the real thing: nav2's NavigateToPose,
    the same planner the firmware uses to travel between zones, after the
    same undock the mow orchestrator does.
    """
    if not _goto_target_allowed(x, y):
        phase("error", "target_outside_zones")
        return 1
    st = drv.wait_status(lambda tm, ws: True, timeout=5.0)
    if st is not None and task_executing(*st) and st[1] != WORK_STATUS_USER_STOP:
        # A running mow owns the wheels; taking them away mid-task leaves a
        # half-cut lawn and a confused robot_decision. Stop the mow first.
        phase("error", "busy_mowing")
        return 1
    drv.reload_map()
    clear_parked_task(drv)
    clear_recharge(drv)
    robot = drv.robot_xy()
    if robot is None:
        phase("error", "not_localized")
        return 1
    log(f"goto: robot={robot} target=({x:.2f},{y:.2f}) yaw={yaw}")
    if current_zone_slot(robot) == "dock":
        phase("undocking")
        drv.undock()
        robot = drv.robot_xy() or robot
    weg, note = drv.map_unreachable(robot, [(x, y)])
    if weg:
        phase("error", "target_unreachable")
        log(f"goto: unreachable ({note})")
        return 1
    phase("moving")
    ok, msg = drv.nav_to(x, y, yaw, timeout=600.0)
    phase("done" if ok else "error", "" if ok else msg)
    return 0 if ok else 1


def _probe_photos(run_dir, second):
    for topic in ("front", "tof_gray"):
        jpeg = fetch_snapshot(topic)
        path = os.path.join(run_dir, f"{topic}_{second:02d}.jpg")
        if jpeg:
            with open(path, "wb") as fh:
                fh.write(jpeg)
        log(f"probe photo {topic}: {path if jpeg else 'none'}")


def _stop_on_signal(signum, frame):
    """SIGTERM or SIGHUP during a probe: unwind through do_probe's finally, so
    the lamp goes off even when the SSH session is gone."""
    raise SystemExit(143)


def do_probe(drv, seconds, led):
    """Phase-0 night test. NO motion: cameras and the detection model on,
    headlight at `led`, a photo per camera every 15 s in PROBE_DIR/<run>, taken
    in the background so counting never pauses, and once per second the highest
    patrol counts, timed on the wall clock. The light goes back off, also on an
    error or a SIGTERM/SIGHUP."""
    run_dir = os.path.join(PROBE_DIR, f"{time.strftime('%Y%m%d-%H%M%S')}_led{led}")
    os.makedirs(run_dir, exist_ok=True)
    phase("probing")
    previous = {sig: signal.signal(sig, _stop_on_signal)
                for sig in (signal.SIGTERM, signal.SIGHUP)}
    photos = []
    try:
        if not drv.ensure_perception():
            log("probe: not every perception switch answered, counting anyway")
        if not drv.set_headlight(led):
            log("probe: headlight level not confirmed")
        start = time.monotonic()
        next_mark = 0
        elapsed = 0.0
        while elapsed < seconds:
            while elapsed >= next_mark:
                photo = threading.Thread(
                    target=_probe_photos, args=(run_dir, next_mark), daemon=True)
                photo.start()
                photos.append(photo)
                next_mark += 15
            per_frame, frames = drv.watch_labels(1.0)
            elapsed = time.monotonic() - start
            print("PROBE", json.dumps({
                "t": round(elapsed, 1), "frames": frames,
                "person": max(per_frame["person"] or [0]),
                "animal": max(per_frame["animal"] or [0]),
            }), flush=True)
    finally:
        try:
            for photo in photos:
                photo.join(timeout=30)   # the photos are taken while the lamp is still on
        finally:
            drv.set_headlight(0)
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    phase("done")
    return 0


# ── Nachtpatrouille: rijden ─────────────────────────────────────────────────
PATROL_NAV_TIMEOUT_S = 180.0
PATROL_MAX_NAV_FAILS = 3        # drie controlepunten op rij onbereikbaar: stoppen
# De vertrek-taak van de firmware krijgt het maaidek op zijn hoogst (90 mm);
# de messen draaien nooit (extended_commands.py zet ze uit bij `patrolling`).
PATROL_DEPART_CUTTERHIGH = 7


def upload_checkpoint(url, seq, xy, scores, frames, jpeg, timeout=20.0):
    """POST one checkpoint to the server: the photo, or an empty body, plus
    the scores in the query. False when the server did not take it."""
    import urllib.request
    q = (f"&seq={seq}&x={xy[0]:.3f}&y={xy[1]:.3f}&frames={frames}"
         f"&person={scores['person']}&animal={scores['animal']}")
    req = urllib.request.Request(url + q, data=jpeg or b"", method="POST",
                                 headers={"Content-Type": "application/octet-stream"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return 200 <= r.status < 300
    except Exception as e:
        log(f"patrol upload seq={seq}: {e}")
        return False


def _patrol_look(drv, params, seq, xy):
    """Dwell at a checkpoint: perception on, count, one photo, upload."""
    drv.ensure_perception()
    per_frame, frames = drv.watch_labels(float(params.get("dwell_s", 6)))
    scores = {name: steady_count(per_frame[name]) for name in PATROL_LABELS.values()}
    jpeg = fetch_snapshot(params.get("photo_topic", "front"))
    sent = upload_checkpoint(params["upload"], seq, xy, scores, frames, jpeg)
    print("CHECKPOINT", json.dumps({"seq": seq, "x": round(xy[0], 2), "y": round(xy[1], 2),
                                     "frames": frames, "photo": bool(jpeg), "sent": sent,
                                     **scores}), flush=True)


def do_patrol(drv, params):
    """Night patrol with the blades off: depart like stock, drive the
    server's checkpoints zone by zone, look and photograph at each, come back
    into the dock's zone. The docking is the firmware's: the server sends
    go_to_charge after PHASE done/error (patrolService.ts)."""
    st = drv.wait_status(lambda tm, ws: True, timeout=5.0)
    if st is not None and task_executing(*st) and not task_parked(*st):
        phase("error", "busy_mowing")
        return 1
    ok, detail = drv.reload_map()
    log(f"map_server reload: {'ok' if ok else 'MISLUKT'} ({detail})")
    clear_parked_task(drv)
    clear_recharge(drv)
    home = _dock_zone()
    robot = drv.robot_xy()
    if robot is None or current_zone_slot(robot) == "dock":
        if home is None:
            phase("error", "no_dock_zone")
            return 1
        # Het vertrek is dat van de firmware (QUIT_PILE), nooit ons eigen
        # achteruitrijden (Walter, 2026-10-07).
        if drv.localize_via_firmware(10 ** int(home[3:]), PATROL_DEPART_CUTTERHIGH, None) is None:
            phase("error", "not_localized")
            return 1
        robot = drv.robot_xy()
        if robot is None:
            phase("error", "not_localized")
            return 1
    phase("patrolling")
    base = _csv_base()
    current = _start_zone(robot, current_zone_slot(robot))
    seq, fails, error = 0, 0, None
    for entry in params.get("zones", []):
        zone = entry.get("zone")
        if zone != current:
            hops = edge_route(current, zone)
            if not hops:
                log(f"patrol: no route {current} -> {zone}, zone skipped")
                print("SKIPPED", json.dumps({"zone": zone, "reason": "no_route"}), flush=True)
                seq += len(entry.get("points", []))
                continue
            ok, msg, robot = _drive_hops(drv, base, robot, hops)
            if not ok:
                error = msg
                break
            current = zone
        for x, y in entry.get("points", []):
            seq += 1
            if not _goto_target_allowed(x, y):
                log(f"patrol: checkpoint {seq} ({x:.2f},{y:.2f}) outside every zone, skipped")
                continue
            ok, msg = drv.nav_to(x, y, timeout=PATROL_NAV_TIMEOUT_S)
            robot = drv.robot_xy() or robot
            if not ok:
                fails += 1
                log(f"patrol: checkpoint {seq} unreachable ({msg}), {fails} in a row")
                if fails >= PATROL_MAX_NAV_FAILS:
                    error = "checkpoints_unreachable"
                    break
                continue
            fails = 0
            _patrol_look(drv, params, seq, robot)
        if error:
            break
    # Terug in de zone van het dock, zodat go_to_charge nooit dwars door een
    # heg plant.
    if home and current != home:
        hops = edge_route(current, home)
        if hops:
            phase("returning")
            ok, msg, robot = _drive_hops(drv, base, robot, hops)
            if not ok and not error:
                error = msg
        elif not error:
            error = "no_route_home"
    if error:
        phase("error", error)
        return 1
    phase("done")
    return 0


def check_mow(drv, to_slot):
    """Dry run: say what stands in the way BEFORE the mower drives anywhere.

    Every failure of 2026-09-14 cost a full attempt to discover: a stuck run
    holding the shared-memory pool, a zone with no recorded route to it, a
    channel of two points the controller could not steer on, a target polygon
    the planner had never seen. None of that needs wheels to find out. Prints
    one CHECK line per item and a final verdict, so the caller can show a list
    instead of a mower dancing in the garden.
    """
    findings = []

    def check(name, ok, detail=""):
        findings.append((name, ok, detail))
        print(f"CHECK {'ok ' if ok else 'FAIL'} {name}" + (f" | {detail}" if detail else ""),
              flush=True)

    stale = find_stale_mow_drives()
    check("geen vastgelopen run", not stale, f"pids {stale}" if stale else "")

    # De firmware stuurt zichzelf na een mislukte poging naar het dock, en die
    # navigatie houdt de wielen vast. do_mow breekt dat af, maar hier melden we
    # het alvast: dan weet je waarom de start even duurt.
    rijdt_naar_dock = drv.recharge_active()
    check("firmware rijdt niet zelf", not rijdt_naar_dock,
          "onderweg naar het dock; wordt bij de start afgebroken" if rijdt_naar_dock else "")

    base = _csv_base()
    target = read_xy_csv(os.path.join(base, f"{to_slot}_work.csv"))
    check(f"{to_slot} bestaat", len(target) >= 3, f"{len(target)} punten")

    robot = drv.robot_xy(timeout=8.0)
    # Geen blokker, en dat is geen soepelheid maar de werkelijkheid: do_mow vangt
    # dit allebei af. Zonder kanaal draait de firmware de hele taak, met kanaal
    # start hij de taak om het frame te krijgen en neemt daarna over. Na elke
    # herstart staat hij hier, dus een FAIL zou de dry run wolf laten roepen op
    # precies het moment dat je hem het meest gebruikt.
    check("positie bekend", True,
          f"{robot}" if robot else "nog geen map->base_link, de firmware bouwt dat "
                                   "frame bij de taakstart")

    # Op het dock is `from` geen zone maar "dock". do_mow ondockt eerst en kijkt
    # dán pas waar hij staat, dus de controle moet dat nabootsen: anders meldt
    # hij "geen route" in precies het normale geval, de maaier op zijn lader.
    from_slot = current_zone_slot(robot) if robot else None
    vanaf = from_slot
    if vanaf in (None, "dock"):
        vanaf = _dock_zone()
        if vanaf:
            check("startzone", True, f"op het dock, dat ligt in {vanaf}")
    if robot and from_slot == to_slot:
        check("route", True, "staat al in de doelzone")
        route = []
    else:
        route = _channel_files(vanaf or "map0", to_slot)
        check("route over de kanalen", bool(route) or not USE_TRANSIT,
              " + ".join(route) if route
              else f"geen keten van {vanaf or 'map0'} naar {to_slot}; "
                   "teken een kanaal of laat de firmware plannen")

    proef = []
    for fname in route:
        pts = read_xy_csv(os.path.join(base, fname))
        lengte = sum(_dist(a, b) for a, b in zip(pts, pts[1:]))
        dicht = densify(pts)
        check(f"kanaal {fname}", len(pts) >= 2,
              f"{len(pts)} punten, {lengte:.1f} m, na verdichten {len(dicht)} punten")
        if len(pts) >= 2:
            proef += [pts[0], pts[len(pts) // 2], pts[-1]]

    # De controle die vijftien mislukte pogingen had bespaard: is het kanaal
    # vrij op de kaart die de PLANNER gebruikt, niet op map.pgm op schijf.
    # map_server leest dat bestand alleen bij het opstarten, dus eerst reloaden
    # en dan pas kijken, precies zoals do_mow het straks doet.
    herladen, detail = drv.reload_map()
    check("map_server heeft de actuele kaart", herladen, detail)
    if proef:
        grid = drv.map_grid()
        bezet = drv.map_blocked(proef, grid=grid)
        if bezet is None:
            check("kanalen vrij voor de planner", False, "geen /map ontvangen")
        else:
            check("kanalen vrij voor de planner", not bezet,
                  "; ".join(f"({x:.2f},{y:.2f}) {reden}" for (x, y), reden in bezet)
                  or f"{len(proef)} punten gecontroleerd")
        # Vrij is niet hetzelfde als bereikbaar: een kanaal kan prima open zijn
        # en toch aan de verkeerde kant van een struik liggen.
        #
        # Vlak na een herstart is er nog geen map->base_link en is `robot` leeg.
        # Juist dan wil je deze controle: hij staat dan op het dock, en dat punt
        # staat in de kaart. Anders is de dry run precies onbruikbaar op het
        # moment dat je hem het hardst nodig hebt.
        vanaf_punt = robot or _dock_anchor()
        if vanaf_punt and grid is not None:
            weg, notitie = drv.map_unreachable(vanaf_punt, proef, grid=grid)
            if not robot:
                notitie = f"gemeten vanaf het dock; {notitie}"
            if weg is None:
                check("kanalen bereikbaar", False, notitie)
            else:
                check("kanalen bereikbaar", not weg,
                      "; ".join(f"({x:.2f},{y:.2f})" for x, y in weg) or notitie)

    ok = all(f[1] for f in findings)
    print(f"CHECK {'ok ' if ok else 'FAIL'} eindoordeel | "
          f"{sum(1 for f in findings if f[1])}/{len(findings)} in orde", flush=True)
    phase("done" if ok else "error", "" if ok else "precheck_failed")
    return 0 if ok else 1


def main():
    args = sys.argv[1:]
    mode = args[0] if args else ""
    rclpy.init()
    node = rclpy.create_node("mow_zone_drive")
    drv = Driver(node)
    rc = 2
    try:
        if mode == "check":
            if len(args) < 2 or not re.fullmatch(r"map\d+", args[1]):
                phase("error", "usage: mow_zone_drive.py check <mapN>")
            else:
                rc = check_mow(drv, args[1])
        elif mode == "return":
            rc = do_return(drv)
        elif mode == "goto":
            try:
                gx, gy = float(args[1]), float(args[2])
                gyaw = None if len(args) < 4 or args[3] == "-" else float(args[3])
            except (IndexError, ValueError):
                phase("error", "usage: mow_zone_drive.py goto <x> <y> [yaw|-]")
            else:
                if not all(math.isfinite(v) for v in (gx, gy)) or max(abs(gx), abs(gy)) > 500:
                    phase("error", "invalid_target")
                else:
                    rc = do_goto(drv, gx, gy, gyaw)
        elif mode == "edge":
            if len(args) < 4:
                phase("error", "usage: mow_zone_drive.py edge <to_slot> <map_ids> <cutterhigh>")
            elif not re.fullmatch(r"map\d+", args[1]):
                phase("error", "invalid_map")
            else:
                rc = do_mow(drv, args[1], int(args[2]), int(args[3]), None, edge=True)
        elif mode == "mow":
            if len(args) < 5:
                phase("error", "usage: mow_zone_drive.py mow <to_slot> <map_ids> <cutterhigh> <direction|->")
            elif not re.fullmatch(r"map\d+", args[1]):
                phase("error", "invalid_map")
            else:
                rc = do_mow(drv, args[1], int(args[2]), int(args[3]),
                            None if args[4] == "-" else int(args[4]))
        elif mode == "probe":
            try:
                secs = int(args[1]) if len(args) > 1 else 60
                led = int(args[2]) if len(args) > 2 else 100
            except ValueError:
                phase("error", "usage: mow_zone_drive.py probe [seconds] [led 0-100]")
            else:
                rc = do_probe(drv, max(1, min(600, secs)), max(0, min(100, led)))
        elif mode == "patrol":
            try:
                with open(args[1]) as fh:
                    params = json.load(fh)
            except (IndexError, OSError, ValueError) as e:
                phase("error", f"usage: mow_zone_drive.py patrol <params.json> ({e})")
            else:
                rc = do_patrol(drv, params)
        else:
            phase("error", f"unknown_mode:{mode}")
    except Exception as e:
        phase("error", str(e))
        rc = 1
    finally:
        try:
            node.destroy_node()
        except Exception:
            pass
        try:
            rclpy.shutdown()
        except Exception:
            pass
    return rc


if __name__ == "__main__":
    sys.exit(main())
