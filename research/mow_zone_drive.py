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
import math
import os
import re
import sys
import time

import rclpy
from rclpy.action import ActionClient
from rcl_interfaces.srv import SetParameters, GetParameters
from rcl_interfaces.msg import Parameter, ParameterValue, ParameterType
from geometry_msgs.msg import Twist, PoseStamped
from nav_msgs.msg import Path
from std_msgs.msg import UInt8
from std_srvs.srv import Trigger
from nav2_msgs.action import FollowPath
from decision_msgs.srv import StartCoverageTask
from rclpy.qos import QoSProfile, QoSHistoryPolicy
import tf2_ros

MAPS_HOME = "/userdata/lfi/maps/home0"
NAV_NODE = "/nav2_single_node_navigator"
DECISION = "/robot_decision"
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
    if _dist(xy, (0.0, 0.0)) <= DOCK_RADIUS:
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

    def spin(self, sec):
        rclpy.spin_once(self.node, timeout_sec=sec)

    def robot_xy(self, timeout=6.0):
        """Read map -> base_link ONCE via a throwaway probe node, then destroy
        it so its /tf subscriptions (and their shm chunks) are released before
        the drive. Returns (x, y), or None if TF never resolves (which doubles
        as a not-localized guard: callers refuse to move on None)."""
        probe = rclpy.create_node("mzd_tf_probe")
        buf = tf2_ros.Buffer()
        tf2_ros.TransformListener(buf, probe)
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
            probe.destroy_node()
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
        req = StartCoverageTask.Request()
        req.cov_mode = 0            # NORMAL: select map(s) by id
        req.request_type = 11       # normal mqtt/app start
        req.map_ids = int(map_ids)  # decimal positional bitmask (map3 -> 1000)
        req.map_names = []          # empty: map_names + map_ids:0 -> Error 118
        req.blade_heights = [int(cutterhigh)]
        req.specify_direction = direction is not None
        req.cov_direction = int(direction) if direction is not None else 0
        fut = cli.call_async(req)
        rclpy.spin_until_future_complete(self.node, fut, timeout_sec=15.0)
        r = fut.result()
        return bool(r and r.result)

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


DOCK_HOME_RADIUS = 1.2   # within this of the map origin counts as "home"


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


def do_mow(drv, to_slot, map_ids, cutterhigh, direction):
    """Outbound: undock -> follow the unicom to the target zone -> coverage."""
    robot = drv.robot_xy()
    if robot is None:
        # After a reboot the localization has its RTK origin but the map frame
        # is "confirmed, but not aligned": map->odom (hence map->base_link) is
        # only published once the mower MOVES and gives it a heading. A reboot
        # leaves the mower on the dock, so undock open-loop (no tf needed) to
        # self-init localization, then re-read the position.
        log("not localized (map frame not aligned, post-reboot?): undock to self-init")
        phase("undocking")
        drv.undock()
        robot = drv.robot_xy(timeout=20)
        if robot is None:
            phase("error", "not_localized")
            return 1
        from_slot = current_zone_slot(robot)
        log(f"post-undock (self-init): robot={robot} from={from_slot}")
    else:
        from_slot = current_zone_slot(robot)
        log(f"mow start: robot={robot} from={from_slot} to={to_slot} map_ids={map_ids}")
        # 1. undock if on the pile
        if from_slot == "dock":
            phase("undocking")
            drv.undock()
            robot = drv.robot_xy()
            from_slot = current_zone_slot(robot)
            log(f"post-undock: robot={robot} from={from_slot}")

    # 2. transit along the recorded unicom, if one exists and we are not
    #    already inside the target zone
    base = _csv_base()
    target_poly = read_xy_csv(os.path.join(base, f"{to_slot}_work.csv"))
    already_in = bool(robot and len(target_poly) >= 3 and
                      point_in_poly(robot[0], robot[1], target_poly))
    uni = []
    if from_slot and from_slot != to_slot:
        uni = [f for f in os.listdir(base)
               if re.match(rf"^{from_slot}to{to_slot}_\d+_unicom\.csv$", f)]
    if uni and not already_in:
        pts = read_xy_csv(os.path.join(base, sorted(uni)[0]))
        if len(pts) < 2:
            phase("error", "unicom_empty")
            return 1
        if _dist(robot, pts[0]) > _dist(robot, pts[-1]):
            pts = list(reversed(pts))   # start at the robot's end
        # Drop the points BEHIND the mower (between it and the dock end). After
        # the ~1m undock the mower sits ~1m along the line but still near the
        # dock; without trimming, the controller first heads back to the dock
        # end, hits the dock (lethal cost 255 in the costmap) and aborts with
        # "collision ahead". Starting the path at the nearest point makes it
        # drive forward from where it actually is.
        pts = _trim_to_nearest(pts, robot)
        phase("following_unicom")
        drv.set_params([(n, r) for (n, r, _d) in TRANSIT_PARAMS])
        drv.log_applied_params([n for (n, _r, _d) in TRANSIT_PARAMS])
        try:
            ok, msg = drv.follow_path(pts)
        finally:
            drv.set_params([(n, d) for (n, _r, d) in TRANSIT_PARAMS])
            log("restored controller params")
        if not ok:
            phase("error", msg)
            return 1
    else:
        log(f"transit skipped (uni={bool(uni)} already_in={already_in})")

    # 3. coverage through robot_decision (keeps the normal state machine)
    phase("covering")
    ok = drv.start_cov(map_ids, cutterhigh, direction)
    phase("done" if ok else "error", "" if ok else "start_cov_task_failed")
    return 0 if ok else 1


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
        segs = _transit_unicoms()
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


def main():
    args = sys.argv[1:]
    mode = args[0] if args else ""
    rclpy.init()
    node = rclpy.create_node("mow_zone_drive")
    drv = Driver(node)
    rc = 2
    try:
        if mode == "return":
            rc = do_return(drv)
        elif mode == "mow":
            if len(args) < 5:
                phase("error", "usage: mow_zone_drive.py mow <to_slot> <map_ids> <cutterhigh> <direction|->")
            elif not re.fullmatch(r"map\d+", args[1]):
                phase("error", "invalid_map")
            else:
                rc = do_mow(drv, args[1], int(args[2]), int(args[3]),
                            None if args[4] == "-" else int(args[4]))
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
