# Night Patrol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an OpenNova mower leave its dock on demand or on a schedule, drive checkpoints through the garden with the blades off, look with its camera and detection model at each, notify on a person or animal, keep the photos, and dock like stock.

**Architecture:** The server plans checkpoints from the zone polygons and sends a new extended command `patrol`. `extended_commands.py` secures the blades, switches the costmap detection on and runs `mow_zone_drive.py patrol`, which departs like stock, drives the checkpoints with nav2 `NavigateToPose`, counts detection labels in `/perception/points_labeled`, takes a photo through `camera_stream.py`, and uploads each checkpoint to the server. The server stores the photos, raises `patrol_detection` / `patrol_failed` events, switches the headlight and sends `go_to_charge` at the end.

**Tech Stack:** Python 3 + rclpy (ROS 2 Galactic) on the mower; TypeScript, Express, better-sqlite3 and vitest on the server; React + Vite (dashboard); Expo / React Native (app).

**Spec:** `docs/superpowers/specs/2026-10-14-night-patrol-design.md`

## Global Constraints

- Commit messages in English, conventional style (`feat(server): ...`). NEVER add `Co-Authored-By` or "Generated with" lines (Ramon's CLAUDE.md overrides any harness default).
- Never commit unrelated working-tree changes: stage only the files of the task (`git add <paths>`), never `git add -A`.
- No release, tag, push, Docker build or firmware build unless Ramon explicitly asks. Firmware is built only with `./research/build_custom_firmware.sh`.
- No motion command to any mower (SSH, MQTT or script) without Ramon's explicit OK for that specific test. Phase 0 has no motion.
- Mower scripts are edited in `research/` only; for a live test copy them to `/tmp` on the mower. Never overwrite `/root/novabot/scripts/*` by hand.
- Departure and docking stay stock: never reverse off the dock ourselves; the headlight is 0 before any `go_to_charge` (dock LED = stock).
- Every server sentence a person reads goes through `T\`…\`` / `M\`…\`` with the Dutch sentence as key, and gets `en`, `fr`, `de` entries in `server/src/services/apiText.catalog.ts`; `serverText.coverage.test.ts` must stay green.
- Dashboard text in all four `dashboard/src/i18n/locales/{en,nl,de,fr}.json`; app text in all four `app/src/i18n/{en,nl,de,fr}.ts`.
- No em-dashes in any prose, UI text or comments you add.
- UI changes (Tasks 11, 12): show Ramon the mockup first and get his OK; commit only after Ramon tested it.
- Test commands: Python `python3 research/__tests__/<file>.py`; server `cd server && npx vitest run <path>` and `cd server && npx tsc --noEmit`; dashboard `cd dashboard && npx tsc -p tsconfig.app.json --noEmit`; app `cd app && npx tsc --noEmit`.

## Review Focus

1. A patrol that ends before the mower left the dock (refused at the start, not localized) must not trigger `go_to_charge`: test in Task 7 (`onPatrolStatus` error without `patrolling`).
2. A checkpoint with fewer than two perception frames is "no data": never an alert, never shown as "nothing seen": tests in Task 7 (`onPatrolFrame`) and Task 9 (`seen: null` in the run listing).
3. A patrol schedule never reaches the mower as `timer_task`, never shows up in the stock app's plans and never in the mow schedule list: tests in Task 10 (`stockFirmwareGate.test.ts` for timer_task and send, `scheduleMirror.test.ts` for the lists and app plans).
4. A chosen zone without a recorded channel or touching zone is skipped with a reason while the rest of the patrol continues and ends `done`: test in Task 3.
5. The headlight goes to 0 before `go_to_charge` on every ending (`done`, `error`, `stopped`, and a killed drive): tests in Task 7 (call order) and Task 4 (a killed drive still reports `stopped`).

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `research/mow_zone_drive.py` | modify | label counting, perception switch, snapshot, `probe` and `patrol` modes, `_drive_hops` |
| `research/extended_commands.py` | modify | `validate_patrol_params`, `handle_patrol`, `patrol` in the stale-drive scan |
| `research/__tests__/test_patrol.py` | create | mower-side patrol logic against a fake Driver |
| `research/__tests__/test_patrol_command.py` | create | the extended command against a fake process |
| `research/__tests__/test_stale_mow_drive.py` | modify | patrol counts as a drive |
| `server/src/services/patrolRoute.ts` | create | checkpoints from zone polygons |
| `server/src/services/patrolService.ts` | create | settings, start/stop, status and checkpoint handling |
| `server/src/services/patrolFrames.ts` | create | checkpoint photos and metadata on disk |
| `server/src/cloud-api/routes/patrol.ts` | create | mower upload endpoint |
| `server/src/cloud-api/index.ts` | modify | mount the upload router |
| `server/src/notifications/types.ts`, `eventDetector.ts`, `expoPush.ts` | modify | `patrol_detection`, `patrol_failed`, category `patrol` |
| `server/src/routes/dashboard.ts` | modify | patrol routes, schedule `kind`, guard list |
| `server/src/mqtt/broker.ts` | modify | mirror `patrol_status`, hand it to the service |
| `server/src/services/frameValidation.ts`, `mowerMapOperation.ts` | modify | `patrol` is a navigation command |
| `server/src/db/database.ts`, `db/repositories/schedules.ts` | modify | `dashboard_schedules.kind` |
| `server/src/services/scheduleRunner.ts`, `scheduleMirror.ts` | modify | patrol schedules |
| `server/src/services/apiText.catalog.ts` | modify | translations of new sentences |
| `dashboard/src/api/client.ts`, `dashboard/src/components/drawer/PatrolCard.tsx`, `dashboard/src/shell/DashboardShell.tsx`, locales | modify/create | dashboard UI |
| `app/src/services/api.ts`, `app/src/services/pushNotifications.ts`, `app/src/components/PatrolSection.tsx`, `app/src/screens/CameraScreen.tsx`, `app/src/screens/AppSettingsScreen.tsx`, `app/src/i18n/*.ts` | modify/create | app UI |

---

## Phase 0: night test without driving (gate)

### Task 1: Detection helpers and the night probe

**Files:**
- Modify: `research/mow_zone_drive.py` (imports at the top; new block after `map_names_for`; `Driver.__init__`; new `Driver` methods; `do_probe` before `check_mow`; `main`)
- Create: `research/__tests__/test_patrol.py`

**Interfaces:**
- Produces (module `mow_zone_drive`): `PATROL_LABELS: dict[int, str]` (`{100: "person", 101: "animal"}`), `SNAPSHOT_URL`, `LED_TOPIC`, `PROBE_DIR`, `label_offset(fields) -> int`, `label_counts(data, point_step, offset) -> {"person": int, "animal": int}`, `steady_count(per_frame: list[int]) -> int`, `fetch_snapshot(topic: str, timeout=25.0) -> bytes | None`, `Driver.set_headlight(level: int)`, `Driver.ensure_perception() -> bool`, `Driver.watch_labels(seconds: float) -> (dict[str, list[int]], int)`, `do_probe(drv, seconds: int, led: int) -> int`, CLI `mow_zone_drive.py probe [seconds] [led]`.

- [ ] **Step 1: Write the failing tests**

Create `research/__tests__/test_patrol.py`:

```python
#!/usr/bin/env python3
"""Self-check for the night patrol in research/mow_zone_drive.py.

Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
Run: python3 research/__tests__/test_patrol.py
ROS modules are stubbed; the patrol logic runs against fake Drivers.
"""
import importlib.util
import os
import struct
import sys
import tempfile
import types
import urllib.request

for name in ["rclpy", "rclpy.node", "rclpy.action", "rclpy.qos", "rclpy.time",
             "rcl_interfaces", "rcl_interfaces.srv", "rcl_interfaces.msg",
             "decision_msgs", "decision_msgs.srv", "decision_msgs.msg",
             "std_msgs", "std_msgs.msg", "std_srvs", "std_srvs.srv",
             "geometry_msgs", "geometry_msgs.msg",
             "nav_msgs", "nav_msgs.msg", "nav2_msgs", "nav2_msgs.action",
             "nav2_msgs.srv",
             "coverage_planner", "coverage_planner.action", "action_msgs",
             "action_msgs.msg", "tf2_ros", "builtin_interfaces",
             "builtin_interfaces.msg"]:
    sys.modules.setdefault(name, types.ModuleType(name))
for mod, attrs in {
    "decision_msgs.srv": ["StartCoverageTask"],
    "decision_msgs.msg": ["RobotStatus"],
    "std_srvs.srv": ["Trigger", "SetBool", "Empty"],
    "geometry_msgs.msg": ["PoseStamped", "Point", "Twist"],
    "nav_msgs.msg": ["Path", "Odometry", "OccupancyGrid"],
    "nav2_msgs.action": ["FollowPath", "NavigateToPose"],
    "nav2_msgs.srv": ["LoadMap"],
    "coverage_planner.action": ["NavigateThroughCoveragePaths"],
    "action_msgs.msg": ["GoalStatus"],
    "builtin_interfaces.msg": ["Duration"],
    "rcl_interfaces.srv": ["SetParameters", "GetParameters"],
    "rcl_interfaces.msg": ["Parameter", "ParameterValue", "ParameterType"],
    "std_msgs.msg": ["UInt8"],
    "rclpy.qos": ["QoSProfile"],
    "rclpy.action": ["ActionClient"],
}.items():
    for a in attrs:
        setattr(sys.modules[mod], a, type(a, (), {}))
sys.modules["rclpy.qos"].QoSHistoryPolicy = type("QoSHistoryPolicy", (), {"KEEP_LAST": 1, "KEEP_ALL": 0})
sys.modules["rclpy.qos"].QoSProfile = lambda **kw: kw
sys.modules["rclpy.qos"].QoSReliabilityPolicy = type(
    "QoSReliabilityPolicy", (), {"RELIABLE": 1, "BEST_EFFORT": 2})
sys.modules["rclpy.qos"].QoSDurabilityPolicy = type(
    "QoSDurabilityPolicy", (), {"TRANSIENT_LOCAL": 1, "VOLATILE": 2})

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "mow_zone_drive", os.path.join(HERE, "..", "mow_zone_drive.py"))
mzd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mzd)


def write(path, pts):
    with open(path, "w") as fh:
        fh.write("\n".join(f"{x},{y}" for x, y in pts) + "\n")


def with_maps(files):
    """Point MAPS_HOME at a temp dir holding the given csv_file/ entries."""
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, "csv_file"))
    for name, pts in files.items():
        write(os.path.join(d, "csv_file", name), pts)
    mzd.MAPS_HOME = d
    return d


def cloud(labels):
    """A packed points_labeled buffer: x, y, z float32 and one label byte per point."""
    return b"".join(struct.pack("<fff", 0.0, 0.0, 0.0) + bytes([label]) for label in labels)


class Field:
    def __init__(self, name, offset):
        self.name, self.offset = name, offset


# ── Task 1: looking ─────────────────────────────────────────────────────────

def test_label_offset_reads_the_field_and_defaults_to_12():
    assert mzd.label_offset([Field("x", 0), Field("label", 12)]) == 12
    assert mzd.label_offset([Field("x", 0), Field("label", 16)]) == 16
    assert mzd.label_offset([]) == 12


def test_label_counts_counts_people_and_animals_only():
    assert mzd.label_counts(cloud([100, 100, 101, 2, 5, 100]), 13, 12) == {"person": 3, "animal": 1}
    assert mzd.label_counts(b"", 13, 12) == {"person": 0, "animal": 0}


def test_steady_count_needs_two_frames():
    assert mzd.steady_count([]) == 0
    assert mzd.steady_count([500]) == 0           # one spike is noise
    assert mzd.steady_count([0, 80, 120]) == 80   # reached in two frames


class Resp:
    def __init__(self, body):
        self.body = body

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_fetch_snapshot_accepts_only_a_jpeg():
    real = urllib.request.urlopen
    try:
        urllib.request.urlopen = lambda url, timeout=0: Resp(b"\xff\xd8abc")
        assert mzd.fetch_snapshot("front") == b"\xff\xd8abc"
        urllib.request.urlopen = lambda url, timeout=0: Resp(b"<html>busy</html>")
        assert mzd.fetch_snapshot("front") is None

        def refused(url, timeout=0):
            raise OSError("connection refused")
        urllib.request.urlopen = refused
        assert mzd.fetch_snapshot("front") is None
    finally:
        urllib.request.urlopen = real


class ProbeDriver:
    def __init__(self):
        self.calls = []

    def ensure_perception(self):
        self.calls.append(("perception",))
        return True

    def set_headlight(self, level):
        self.calls.append(("light", level))

    def watch_labels(self, seconds):
        return {"person": [3, 50], "animal": [0, 0]}, 2


def test_probe_takes_photos_and_switches_the_light_back_off():
    mzd.PROBE_DIR = tempfile.mkdtemp()
    real = mzd.fetch_snapshot
    mzd.fetch_snapshot = lambda topic, timeout=25.0: b"\xff\xd8" + topic.encode()
    try:
        drv = ProbeDriver()
        assert mzd.do_probe(drv, 2, 100) == 0
    finally:
        mzd.fetch_snapshot = real
    assert drv.calls[0] == ("perception",)
    assert ("light", 100) in drv.calls and drv.calls[-1] == ("light", 0)
    assert sorted(os.listdir(mzd.PROBE_DIR)) == ["led100_front_00.jpg", "led100_tof_gray_00.jpg"]


def test_probe_switches_the_light_off_when_perception_breaks():
    class Broken(ProbeDriver):
        def watch_labels(self, seconds):
            raise RuntimeError("no perception")
    mzd.PROBE_DIR = tempfile.mkdtemp()
    real = mzd.fetch_snapshot
    mzd.fetch_snapshot = lambda topic, timeout=25.0: None
    drv = Broken()
    try:
        mzd.do_probe(drv, 1, 100)
    except RuntimeError:
        pass
    finally:
        mzd.fetch_snapshot = real
    assert drv.calls[-1] == ("light", 0)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all patrol checks passed")
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `python3 research/__tests__/test_patrol.py`
Expected: `AttributeError: module 'mow_zone_drive' has no attribute 'fetch_snapshot'` (or `label_counts`).

- [ ] **Step 3: Implement**

In `research/mow_zone_drive.py`, add `import json` to the stdlib imports (after `import math`):

```python
import json
import math
```

After the function `map_names_for(...)` (and before `class Driver:`), add:

```python
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
```

In `Driver.__init__`, after `self._recharge = None`, add:

```python
        # Nachtpatrouille: koplamp-publisher, servicecliënten en het
        # points_labeled-abonnement komen lui en precies één keer: elk nieuw
        # ROS-object kost iceoryx-blokken die pas vrijkomen als het proces stopt
        # (zie _probe).
        self._pub_led = None
        self._clients = {}
        self._label_sub = None
        self._label_buf = None
```

Inside `class Driver`, after the method `auto_recharge`, add:

```python
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

    def set_headlight(self, level):
        """Headlight 0..100 on /led_set. Only the Phase-0 probe uses this;
        during a patrol the server switches the light (patrolService.ts)."""
        if self._pub_led is None:
            self._pub_led = self.node.create_publisher(
                UInt8, LED_TOPIC, QoSProfile(depth=1, history=QoSHistoryPolicy.KEEP_LAST))
        m = UInt8()
        m.data = max(0, min(100, int(level)))
        self._pub_led.publish(m)

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
```

Before `def check_mow(drv, to_slot):`, add:

```python
def _probe_photos(led, second):
    for topic in ("front", "tof_gray"):
        jpeg = fetch_snapshot(topic)
        path = os.path.join(PROBE_DIR, f"led{led}_{topic}_{second:02d}.jpg")
        if jpeg:
            with open(path, "wb") as fh:
                fh.write(jpeg)
        log(f"probe photo {topic}: {path if jpeg else 'none'}")


def do_probe(drv, seconds, led):
    """Phase-0 night test. NO motion: cameras and the detection model on,
    headlight at `led`, a photo per camera every 15 s in PROBE_DIR, and once a
    second the highest patrol counts. The light goes back off, also on an error."""
    os.makedirs(PROBE_DIR, exist_ok=True)
    phase("probing")
    if not drv.ensure_perception():
        log("probe: not every perception switch answered, counting anyway")
    drv.set_headlight(led)
    try:
        for second in range(max(1, int(seconds))):
            if second % 15 == 0:
                _probe_photos(led, second)
            per_frame, frames = drv.watch_labels(1.0)
            print("PROBE", json.dumps({
                "t": second, "frames": frames,
                "person": max(per_frame["person"] or [0]),
                "animal": max(per_frame["animal"] or [0]),
            }), flush=True)
    finally:
        drv.set_headlight(0)
    phase("done")
    return 0
```

In `main()`, add before the final `else:` branch:

```python
        elif mode == "probe":
            try:
                secs = int(args[1]) if len(args) > 1 else 60
                led = int(args[2]) if len(args) > 2 else 100
            except ValueError:
                phase("error", "usage: mow_zone_drive.py probe [seconds] [led 0-100]")
            else:
                rc = do_probe(drv, max(1, min(600, secs)), max(0, min(100, led)))
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `python3 research/__tests__/test_patrol.py && python3 research/__tests__/test_mow_zone_handover.py`
Expected: `all patrol checks passed` and `all handover checks passed`.

- [ ] **Step 5: Commit**

```bash
git add research/mow_zone_drive.py research/__tests__/test_patrol.py
git commit -m "feat(firmware): patrol detection helpers and a night probe without motion"
```

- [ ] **Step 6: Night test on the dock (Ramon present, no motion)**

At night, mower on its own dock, Ramon or a helper available to walk in front of it. Use Ramon's own mower (`.100` or `.244`, ask which).

```bash
scp research/mow_zone_drive.py root@<mower-ip>:/tmp/mzd_probe.py
ssh root@<mower-ip>
source /opt/ros/galactic/setup.bash && source /root/novabot/install/setup.bash
python3 /tmp/mzd_probe.py probe 60 0     # nobody in front, light off
python3 /tmp/mzd_probe.py probe 60 100   # nobody in front, light on
python3 /tmp/mzd_probe.py probe 90 100   # person at 4 m (0-29 s), 2 m (30-59 s), 6 m (60-89 s)
python3 /tmp/mzd_probe.py probe 90 0     # the same walk, light off
exit
mkdir -p /tmp/patrol_probe_local && scp -r 'root@<mower-ip>:/tmp/patrol_probe/*' /tmp/patrol_probe_local/   # one folder per run: <time>_led<level>/
```

Expected: `PROBE {"t": ..., "frames": N, "person": ..., "animal": ...}` lines with `frames` above 0 every second. If `frames` stays 0, the perception never came up: stop and report the `LOG` lines to Ramon.

- [ ] **Step 7: Record the result and pass the gate**

Fill in the section "Phase 0 result" of `docs/superpowers/specs/2026-10-14-night-patrol-design.md` with: frames per second, the highest person count with nobody there (light 0 and 100), the steady person count at 2/4/6 m (light 0 and 100), whether the `front` photo at 100 shows the person at 4 m, whether the `tof_gray` photo does, and the chosen `patrol_min_points` (midway between the empty-garden maximum and the 6 m count) and `patrol_photo_topic`. Do not commit the photos (private garden).

If no photo shows the person at 4 m and the counts do not rise above the empty-garden noise, STOP here and report to Ramon.

Otherwise use the measured values as the defaults in `readPatrolSettings` (Task 7: `minPoints` default 40, `photoTopic` default `front`), then:

```bash
git add docs/superpowers/specs/2026-10-14-night-patrol-design.md
git commit -m "docs(patrol): phase 0 night test result"
```

---

## Phase 1: the drive on the mower

### Task 2: One route driver for edge cut and patrol

**Files:**
- Modify: `research/mow_zone_drive.py` (`_edge_transit`, new `_drive_hops` right above it)
- Test: `research/__tests__/test_patrol.py`, `research/__tests__/test_mow_zone_handover.py` (unchanged, must stay green)

**Interfaces:**
- Consumes: `edge_route(from_slot, to_slot) -> list[(kind, fname, zone)]`, `_drive_channel_hop`, `_entry_point`, `TRANSIT_PARAMS`.
- Produces: `_drive_hops(drv, base, robot, hops) -> (ok: bool, msg: str, robot: tuple)`.

- [ ] **Step 1: Write the failing tests**

Append to `research/__tests__/test_patrol.py` (above `if __name__ == "__main__":`):

```python
# ── Task 2: route driver ────────────────────────────────────────────────────

SQ0 = [(0, 0), (10, 0), (10, 10), (0, 10)]
SQ1 = [(10, 0), (20, 0), (20, 10), (10, 10)]    # touches SQ0 along x = 10
SQ6 = [(30, 0), (40, 0), (40, 10), (30, 10)]    # elsewhere


class HopDriver:
    def __init__(self, fail_at=None):
        self.calls, self.params = [], []
        self._loc = (5.0, 5.0)
        self.fail_at = fail_at

    def set_params(self, items):
        self.params.append(list(items))

    def log_applied_params(self, names):
        pass

    def robot_xy(self, timeout=6.0):
        return self._loc

    def nav_to(self, x, y, yaw=None, timeout=120.0):
        self.calls.append(("nav_to", round(x, 2), round(y, 2)))
        if self.fail_at == "nav_to":
            return False, "nav_to_pose_status_6"
        self._loc = (x, y)
        return True, ""

    def follow_path(self, pts):
        self.calls.append(("follow_path",))
        self._loc = pts[-1]
        return True, ""


def test_drive_hops_restores_the_controller_params_also_on_failure():
    with_maps({"map0_work.csv": SQ0, "map1_work.csv": SQ1})
    drv = HopDriver(fail_at="nav_to")
    ok, msg, _robot = mzd._drive_hops(drv, mzd._csv_base(), (5.0, 5.0), [("touch", None, "map1")])
    assert not ok and msg == "nav_to_pose_status_6"
    assert drv.params[-1] == [(n, d) for (n, _r, d) in mzd.TRANSIT_PARAMS]


def test_drive_hops_drives_a_channel_and_reports_where_it_ended():
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6,
               "map0tomap6_0_unicom.csv": [(9, 5), (31, 5)]})
    drv = HopDriver()
    ok, msg, robot = mzd._drive_hops(drv, mzd._csv_base(), (9.0, 5.0),
                                     [("channel", "map0tomap6_0_unicom.csv", "map6")])
    assert ok and msg == "" and robot[0] > 30
```

- [ ] **Step 2: Run to see it fail**

Run: `python3 research/__tests__/test_patrol.py`
Expected: `AttributeError: module 'mow_zone_drive' has no attribute '_drive_hops'`.

- [ ] **Step 3: Implement**

In `research/mow_zone_drive.py`, add right above `def _edge_transit(`:

```python
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
```

In `_edge_transit`, replace the whole block that starts with `if hops:` and ends with `log("restored controller params")` by:

```python
    if hops:
        log(f"edge route {route_from} -> {to_slot}: {hops}")
        phase("following_unicom" if any(k == "channel" for k, _f, _z in hops) else "entering_zone")
        ok, msg, robot = _drive_hops(drv, base, robot, hops)
        if not ok:
            phase("error", msg)
            return 1
```

(The two lines `phase("edge_ready")` and `return 0` that follow stay.)

- [ ] **Step 4: Run all mower tests**

Run: `python3 research/__tests__/test_patrol.py && python3 research/__tests__/test_mow_zone_handover.py`
Expected: both end with `all ... checks passed`.

- [ ] **Step 5: Commit**

```bash
git add research/mow_zone_drive.py research/__tests__/test_patrol.py
git commit -m "refactor(firmware): one route driver for edge cut transits"
```

### Task 3: The `patrol` mode

**Files:**
- Modify: `research/mow_zone_drive.py` (constants and functions after `do_probe`; `find_stale_mow_drives` regex; `main`)
- Test: `research/__tests__/test_patrol.py`

**Interfaces:**
- Consumes: `_drive_hops`, `edge_route`, `_dock_zone`, `_start_zone`, `current_zone_slot`, `_goto_target_allowed`, `Driver.localize_via_firmware(map_ids, cutterhigh, direction)`, `Driver.nav_to(x, y, yaw=None, timeout=...)`, `Driver.ensure_perception()`, `Driver.watch_labels(seconds)`, `fetch_snapshot`, `steady_count`.
- Produces: CLI `mow_zone_drive.py patrol <params.json>`. Params JSON: `{"run": "<digits>", "zones": [{"zone": "mapN", "points": [[x, y], ...]}], "dwell_s": 6, "photo_topic": "front", "upload": "http://<host>/api/nova-file-server/patrol/uploadFrame?sn=<SN>&run=<run>"}`. Stdout: `PHASE patrolling | returning | done | error <msg>`, `CHECKPOINT {"seq", "x", "y", "frames", "photo", "sent", "person", "animal"}`, `SKIPPED {"zone", "reason"}`. Upload query adds `&seq=&x=&y=&frames=&person=&animal=`, body = JPEG or empty. Functions `upload_checkpoint(url, seq, xy, scores, frames, jpeg, timeout=20.0) -> bool`, `do_patrol(drv, params) -> int`.

- [ ] **Step 1: Write the failing tests**

Append to `research/__tests__/test_patrol.py`:

```python
# ── Task 3: patrol mode ─────────────────────────────────────────────────────

DOCK = [(0.5, 0.7), (2, 3)]   # map0tocharge_unicom: anchor inside SQ0


class PatrolDriver(HopDriver):
    def __init__(self, unreachable=(), status=(0, 0)):
        super().__init__()
        self._loc = None                 # on the dock after a boot: no frame yet
        self.unreachable = {tuple(p) for p in unreachable}
        self.status = status

    def wait_status(self, pred, timeout=30.0):
        return self.status

    def reload_map(self, map_yaml=None):
        return True, "ok"

    def recharge_active(self, timeout=4.0):
        return False

    def localize_via_firmware(self, map_ids, cutterhigh, direction, timeout=90.0):
        self.calls.append(("localize", map_ids, cutterhigh))
        self._loc = (1.0, 1.0)
        return self._loc

    def nav_to(self, x, y, yaw=None, timeout=120.0):
        if (x, y) in self.unreachable:
            self.calls.append(("nav_to_fail", x, y))
            return False, "nav_to_pose_status_6"
        return super().nav_to(x, y, yaw, timeout)

    def ensure_perception(self):
        return True

    def watch_labels(self, seconds):
        return {"person": [0, 60, 70], "animal": [0, 0, 0]}, 3


def run_patrol(drv, zones):
    seen, uploads = [], []
    real = (mzd.phase, mzd.fetch_snapshot, mzd.upload_checkpoint)
    mzd.phase = lambda *a: seen.append(a)
    mzd.fetch_snapshot = lambda topic, timeout=25.0: b"\xff\xd8x"
    mzd.upload_checkpoint = (lambda url, seq, xy, scores, frames, jpeg, timeout=20.0:
                             uploads.append((seq, scores, frames, jpeg is not None)) or True)
    try:
        rc = mzd.do_patrol(drv, {"run": "1", "zones": zones, "dwell_s": 1,
                                 "photo_topic": "front", "upload": "http://srv/u?sn=X&run=1"})
    finally:
        mzd.phase, mzd.fetch_snapshot, mzd.upload_checkpoint = real
    return rc, seen, uploads


def test_patrol_departs_like_stock_and_looks_at_every_checkpoint():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = PatrolDriver()
    rc, seen, uploads = run_patrol(drv, [{"zone": "map0", "points": [[3, 3], [7, 7]]}])
    assert rc == 0 and seen[0] == ("patrolling",) and seen[-1] == ("done",), seen
    assert drv.calls[0] == ("localize", 1, mzd.PATROL_DEPART_CUTTERHIGH)
    assert [u[0] for u in uploads] == [1, 2]
    assert uploads[0][1] == {"person": 60, "animal": 0} and uploads[0][2] == 3
    assert ("follow_path",) not in drv.calls          # no transit inside the dock's zone


def test_points_outside_every_zone_are_skipped_not_driven():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = PatrolDriver()
    rc, _seen, uploads = run_patrol(drv, [{"zone": "map0", "points": [[3, 3], [50, 50]]}])
    assert rc == 0 and [u[0] for u in uploads] == [1]
    assert ("nav_to", 50, 50) not in drv.calls


def test_a_zone_without_a_route_is_skipped_and_the_rest_goes_on():
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6, "map0tocharge_unicom.csv": DOCK})
    drv = PatrolDriver()
    rc, seen, uploads = run_patrol(drv, [{"zone": "map6", "points": [[35, 5]]},
                                         {"zone": "map0", "points": [[3, 3]]}])
    assert rc == 0 and seen[-1] == ("done",), seen
    assert [u[0] for u in uploads] == [2]             # map6's point was seq 1, never driven


def test_three_unreachable_checkpoints_in_a_row_end_the_patrol():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = PatrolDriver(unreachable=[(3, 3), (4, 4), (5, 5)])
    rc, seen, uploads = run_patrol(drv, [{"zone": "map0", "points": [[3, 3], [4, 4], [5, 5], [6, 6]]}])
    assert rc == 1 and seen[-1] == ("error", "checkpoints_unreachable"), seen
    assert uploads == []


def test_another_zone_is_reached_over_its_channel_and_left_again():
    with_maps({"map0_work.csv": SQ0, "map6_work.csv": SQ6, "map0tocharge_unicom.csv": DOCK,
               "map0tomap6_0_unicom.csv": [(9, 5), (31, 5)]})
    drv = PatrolDriver()
    rc, seen, uploads = run_patrol(drv, [{"zone": "map0", "points": [[3, 3]]},
                                         {"zone": "map6", "points": [[35, 5]]}])
    assert rc == 0 and ("returning",) in seen and seen[-1] == ("done",), seen
    assert [u[0] for u in uploads] == [1, 2]
    assert drv.calls.count(("follow_path",)) == 2      # out over the channel and back


def test_a_running_mow_is_never_touched():
    with_maps({"map0_work.csv": SQ0, "map0tocharge_unicom.csv": DOCK})
    drv = PatrolDriver(status=(mzd.TASK_MODE_COVERAGE, 60))
    rc, seen, _uploads = run_patrol(drv, [{"zone": "map0", "points": [[3, 3]]}])
    assert rc == 1 and seen == [("error", "busy_mowing")]
    assert not any(c[0] == "localize" for c in drv.calls)


def test_a_patrol_run_counts_as_a_stale_drive():
    root = tempfile.mkdtemp()
    os.makedirs(os.path.join(root, "111"))
    with open(os.path.join(root, "111", "cmdline"), "wb") as fh:
        fh.write(b"python3\0/root/novabot/scripts/mow_zone_drive.py\0patrol\0/tmp/patrol_1.json")
    assert mzd.find_stale_mow_drives(root, self_pid=999) == [111]
```

- [ ] **Step 2: Run to see it fail**

Run: `python3 research/__tests__/test_patrol.py`
Expected: `AttributeError: module 'mow_zone_drive' has no attribute 'do_patrol'` (the stale-drive test fails on the regex once `do_patrol` exists).

- [ ] **Step 3: Implement**

In `research/mow_zone_drive.py`, in `find_stale_mow_drives`, change the regex line to:

```python
        if re.search(r"mow_zone_drive\.py\s+(mow|edge|return|patrol)\b", cmd):
```

After `do_probe(...)`, add:

```python
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
```

Note on `seq` for a skipped zone: its points keep their numbers so the server's sequence (planned order) stays meaningful.

In `main()`, add before the final `else:` branch:

```python
        elif mode == "patrol":
            try:
                with open(args[1]) as fh:
                    params = json.load(fh)
            except (IndexError, OSError, ValueError) as e:
                phase("error", f"usage: mow_zone_drive.py patrol <params.json> ({e})")
            else:
                rc = do_patrol(drv, params)
```

- [ ] **Step 4: Run all mower tests**

Run: `python3 research/__tests__/test_patrol.py && python3 research/__tests__/test_mow_zone_handover.py && python3 research/__tests__/test_stale_mow_drive.py`
Expected: all three end with their "passed" line.

- [ ] **Step 5: Commit**

```bash
git add research/mow_zone_drive.py research/__tests__/test_patrol.py
git commit -m "feat(firmware): patrol mode in mow_zone_drive (checkpoints, blades off, stock departure)"
```

- [ ] **Step 6: First drive, daytime (only with Ramon's explicit OK and Ramon next to the mower)**

Preferably run this after Task 4 is on the mower (a custom build), through the dashboard, so the blade-off guard and the detection switch are active. If you run the script by hand as below, the blade guard of Task 4 is NOT in the chain: watch the deck during the departure. Copy the script to `/tmp/scripts/mow_zone_drive.py` (not another name), so the dashboard stop (`stop_mow_zone`, which matches `scripts/mow_zone_drive.py`) reaches it.

Ask Ramon first. Pick two points about 3 m in front of the dock inside the dock's zone (read `map_position_x/y` from the dashboard while the mower stands there, or click on the map). On the mower:

```bash
ssh root@<mower-ip> mkdir -p /tmp/scripts && scp research/mow_zone_drive.py root@<mower-ip>:/tmp/scripts/mow_zone_drive.py
ssh root@<mower-ip>
cat > /tmp/p.json <<'EOF'
{"run": "1", "zones": [{"zone": "map0", "points": [[<x1>, <y1>], [<x2>, <y2>]]}],
 "dwell_s": 6, "photo_topic": "front",
 "upload": "http://127.0.0.1:9/none?sn=X&run=1"}
EOF
source /opt/ros/galactic/setup.bash && source /root/novabot/install/setup.bash
python3 /tmp/scripts/mow_zone_drive.py patrol /tmp/p.json
```

The upload URL points nowhere on purpose (uploads fail, logged). Watch: the departure is the firmware's own, the blades must NOT spin at any moment (listen and watch the deck), the mower stops at both points, `CHECKPOINT` lines show `frames` above 0. Afterwards send the mower home from the dashboard. Note the result in the spec under "Phase 0 result" as "Phase 1 drive". If the blades spun during the departure, STOP and report: the blade guard of Task 4 must then run before the departure instead of after it.

### Task 4: The `patrol` extended command

**Files:**
- Modify: `research/extended_commands.py` (stale-drive regex in `find_stale_mow_drives`; new block after `handle_nav_to_point`; `COMMANDS`)
- Create: `research/__tests__/test_patrol_command.py`
- Modify: `research/__tests__/test_stale_mow_drive.py`

**Interfaces:**
- Consumes: `mow_zone_drive.py patrol <params.json>` (Task 3), `_apply_edge_perception_low()`, `_restore_edge_perception()`, `_publish_blade_speed(int)`, `_publish_blade_height(int)`, `_server_from_config()`, `_sn_from_config()`, `kill_stale_mow_drives()`, `_register_mow_drive`, `_unregister_mow_drive`, `_ros_env()`.
- Produces: MQTT command `{"patrol": {"run", "zones", "dwell_s", "photo_topic"}}` on `novabot/extended/<SN>`; responses `patrol_respond {result, run | error}`, `patrol_status {phase, run, error?}` (phases `patrolling`, `returning`, `done`, `error`, `stopped`), `patrol_checkpoint {seq, x, y, frames, photo, sent, person, animal, run}`, `patrol_skipped {zone, reason, run}`. Module names `PATROL_DRIVE_SCRIPT`, `PATROL_PHOTO_TOPICS`, `PATROL_MAX_POINTS = 60`, `validate_patrol_params(params) -> (dict | None, str | None)`, `handle_patrol(params, respond)`.

- [ ] **Step 1: Write the failing tests**

Create `research/__tests__/test_patrol_command.py`:

```python
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
```

Append to `research/__tests__/test_stale_mow_drive.py` (above `if __name__ == "__main__":`):

```python
def test_a_patrol_run_counts_too():
    root = fake_proc({111: "python3 /root/novabot/scripts/mow_zone_drive.py patrol /tmp/patrol_1.json"})
    assert ec.find_stale_mow_drives(root, self_pid=999) == [111]
```

- [ ] **Step 2: Run to see them fail**

Run: `python3 research/__tests__/test_patrol_command.py; python3 research/__tests__/test_stale_mow_drive.py`
Expected: `AttributeError: module 'ec' has no attribute 'validate_patrol_params'`, and an AssertionError for `test_a_patrol_run_counts_too`.

- [ ] **Step 3: Implement**

In `research/extended_commands.py`, `find_stale_mow_drives`, change the regex to:

```python
        if re.search(r"mow_zone_drive\.py\s+(mow|edge|return|patrol)\b", cmd):
```

After `handle_nav_to_point`, add:

```python
# ── Nachtpatrouille ──────────────────────────────────────────────────────────
# Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
PATROL_DRIVE_SCRIPT = "/root/novabot/scripts/mow_zone_drive.py"
PATROL_PHOTO_TOPICS = ("front", "front_hd", "tof_gray")
PATROL_MAX_POINTS = 60


def validate_patrol_params(params):
    """(clean, None) or (None, error). The server plans the route; the mower
    still refuses anything but a short list of finite map points."""
    p = params or {}
    run = str(p.get("run", ""))
    if not re.fullmatch(r"\d{1,20}", run):
        return None, "invalid_run"
    zones, total = [], 0
    for z in p.get("zones") or []:
        name = str((z or {}).get("zone", ""))
        if not re.fullmatch(r"map\d+", name):
            return None, "invalid_zone"
        pts = []
        for pt in z.get("points") or []:
            try:
                x, y = float(pt[0]), float(pt[1])
            except (TypeError, ValueError, IndexError):
                return None, "invalid_point"
            if not (math.isfinite(x) and math.isfinite(y)) or max(abs(x), abs(y)) > 500:
                return None, "invalid_point"
            pts.append([x, y])
        total += len(pts)
        zones.append({"zone": name, "points": pts})
    if total == 0:
        return None, "no_points"
    if total > PATROL_MAX_POINTS:
        return None, "too_many_points"
    try:
        dwell = float(p.get("dwell_s", 6))
    except (TypeError, ValueError):
        return None, "invalid_dwell"
    if not 2 <= dwell <= 30:
        return None, "invalid_dwell"
    topic = p.get("photo_topic", "front")
    if topic not in PATROL_PHOTO_TOPICS:
        return None, "invalid_photo_topic"
    return {"run": run, "zones": zones, "dwell_s": dwell, "photo_topic": topic}, None


def handle_patrol(params, respond):
    """Night patrol: mow_zone_drive.py patrol drives the server's checkpoints
    with the blades off, looks and photographs at each and comes back into the
    dock's zone; the server docks it afterwards. While it runs the costmap
    treats people and animals as obstacles (the edge cut's Low setting).
    Streams patrol_status / patrol_checkpoint / patrol_skipped; stopped with
    stop_mow_zone like every other drive."""
    clean, err = validate_patrol_params(params)
    if err:
        respond("patrol_respond", {"result": 1, "error": err})
        return
    if not os.path.isfile(PATROL_DRIVE_SCRIPT):
        respond("patrol_respond", {"result": 1, "error": "drive_script_missing"})
        return
    server, sn = _server_from_config(), _sn_from_config()
    if not server or not sn:
        respond("patrol_respond", {"result": 1, "error": "server_unknown"})
        return
    run = clean["run"]
    clean["upload"] = f"http://{server}/api/nova-file-server/patrol/uploadFrame?sn={sn}&run={run}"
    params_file = f"/tmp/patrol_{run}.json"
    with open(params_file, "w") as fh:
        json.dump(clean, fh)
    _stale = kill_stale_mow_drives()
    if _stale:
        log(f"patrol: {len(_stale)} vastgelopen run(s) opgeruimd voor de start: {_stale}")
    wrapper = (
        "source /opt/ros/galactic/setup.bash && "
        "source /root/novabot/install/setup.bash 2>/dev/null && "
        'exec stdbuf -oL python3 "$1" patrol "$2"'
    )
    argv = ["bash", "-c", wrapper, "patrol", PATROL_DRIVE_SCRIPT, params_file]

    def _run():
        terminal_seen = blades_secured = perception_changed = False
        proc = None
        try:
            perception_changed = _apply_edge_perception_low()
            proc = subprocess.Popen(argv, env=_ros_env(), stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, bufsize=1)
            _register_mow_drive(proc)
            for line in proc.stdout:
                line = line.strip()
                if line.startswith("PHASE "):
                    parts = line.split(" ", 2)
                    ph = parts[1] if len(parts) > 1 else ""
                    if ph == "patrolling" and not blades_secured:
                        # The firmware departure runs a coverage task's init
                        # states; nothing of a patrol may cut.
                        blades_secured = True
                        _publish_blade_speed(0)
                        _publish_blade_height(0)
                    if ph in ("done", "error"):
                        terminal_seen = True
                    msg = {"phase": ph, "run": run}
                    if ph == "error" and len(parts) > 2:
                        msg["error"] = parts[2]
                    respond("patrol_status", msg)
                elif line.startswith("CHECKPOINT ") or line.startswith("SKIPPED "):
                    kind, _, body = line.partition(" ")
                    try:
                        data = json.loads(body)
                    except ValueError:
                        log(f"patrol: bad {kind} line: {body[:120]}")
                        continue
                    respond("patrol_checkpoint" if kind == "CHECKPOINT" else "patrol_skipped",
                            dict(data, run=run))
                elif line:
                    log(f"patrol: {line}")
            proc.wait()
            stopped = _unregister_mow_drive(proc)
            if proc.returncode != 0 and not terminal_seen:
                respond("patrol_status", {"phase": "stopped", "run": run} if stopped else
                        {"phase": "error", "run": run, "error": f"drive_exit_{proc.returncode}"})
        except Exception as e:
            log(f"patrol error: {e}")
            respond("patrol_status", {"phase": "error", "run": run, "error": str(e)})
        finally:
            if proc is not None:
                _unregister_mow_drive(proc)
            if perception_changed:
                _restore_edge_perception()
            try:
                os.remove(params_file)
            except OSError:
                pass

    threading.Thread(target=_run, daemon=True, name="patrol").start()
    respond("patrol_respond", {"result": 0, "run": run})
```

In `COMMANDS`, after `"nav_to_point": handle_nav_to_point,` add:

```python
    "patrol": handle_patrol,
```

- [ ] **Step 4: Run the tests**

Run: `python3 research/__tests__/test_patrol_command.py && python3 research/__tests__/test_stale_mow_drive.py && python3 research/__tests__/test_edge_cut_safety.py && python3 research/__tests__/test_firmware_packaging.py`
Expected: every script ends with all checks ok / passed. (No packaging change is needed: both files are already in the build.)

- [ ] **Step 5: Commit**

```bash
git add research/extended_commands.py research/__tests__/test_patrol_command.py research/__tests__/test_stale_mow_drive.py
git commit -m "feat(firmware): patrol extended command (blades off, detection on, checkpoint stream)"
```

---

## Phase 2: server

### Task 5: Checkpoint planner

**Files:**
- Create: `server/src/services/patrolRoute.ts`
- Test: `server/src/__tests__/services/patrolRoute.test.ts`

**Interfaces:**
- Consumes: `pointInPolygon(p: XY, poly: XY[])` and `XY` from `server/src/maps/editGeometry.ts`.
- Produces: `PATROL_INSET_M = 0.6`, `PATROL_MAX_POINTS = 60`, `interface PatrolZone { zone: string; points: Array<[number, number]> }`, `distToBoundary(p: XY, poly: XY[]): number`, `patrolCheckpoints(poly: XY[], spacingM?: number, insetM?: number): XY[]`, `buildPatrolZones(rows: Array<{ canonical_name: string | null; map_area: string | null }>, wanted: string[], spacingM: number, dock: XY | null, maxPoints?: number): PatrolZone[]`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/services/patrolRoute.test.ts
import { describe, it, expect } from 'vitest';
import { patrolCheckpoints, buildPatrolZones, distToBoundary, PATROL_MAX_POINTS } from '../../services/patrolRoute.js';
import { pointInPolygon } from '../../maps/editGeometry.js';

const SQ = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
const shift = (poly: Array<{ x: number; y: number }>, dx: number) => poly.map(p => ({ x: p.x + dx, y: p.y }));
const row = (zone: string, poly: Array<{ x: number; y: number }>) => ({ canonical_name: zone, map_area: JSON.stringify(poly) });
const key = (ps: Array<{ x: number; y: number }>) => ps.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).sort();

describe('patrol checkpoints', () => {
  it('lie inside the zone, 0.6 m from the border, about every spacing metres', () => {
    const pts = patrolCheckpoints(SQ, 5);
    expect(pts).toHaveLength(8);
    for (const p of pts) {
      expect(pointInPolygon(p, SQ)).toBe(true);
      expect(distToBoundary(p, SQ)).toBeCloseTo(0.6, 5);
    }
  });

  it('do not depend on the winding of the polygon', () => {
    expect(key(patrolCheckpoints([...SQ].reverse(), 5))).toEqual(key(patrolCheckpoints(SQ, 5)));
  });

  it('a strip narrower than twice the inset gets no checkpoint', () => {
    const strip = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 1 }, { x: 0, y: 1 }];
    expect(patrolCheckpoints(strip, 3)).toEqual([]);
  });

  it('a degenerate polygon gets none', () => {
    expect(patrolCheckpoints([{ x: 0, y: 0 }, { x: 1, y: 1 }], 3)).toEqual([]);
  });
});

describe('patrol plan', () => {
  it("without a choice patrols only the dock's zone", () => {
    const plan = buildPatrolZones([row('map0', SQ), row('map1', shift(SQ, 20))], [], 5, { x: 1, y: 1 });
    expect(plan.map(z => z.zone)).toEqual(['map0']);
  });

  it("puts the dock's zone first and the rest by slot", () => {
    const plan = buildPatrolZones([row('map2', shift(SQ, 40)), row('map0', SQ), row('map1', shift(SQ, 20))],
      ['map2', 'map1', 'map0'], 5, { x: 21, y: 1 });
    expect(plan.map(z => z.zone)).toEqual(['map1', 'map0', 'map2']);
  });

  it('skips obstacle rows, broken polygons and zones that do not exist', () => {
    const plan = buildPatrolZones([row('map0_0_obstacle', SQ), { canonical_name: 'map1', map_area: '{oops' }, row('map0', SQ)],
      ['map0', 'map1', 'map7'], 5, null);
    expect(plan.map(z => z.zone)).toEqual(['map0']);
  });

  it('thins a big garden to the cap and keeps every zone', () => {
    const big = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const plan = buildPatrolZones([row('map0', big), row('map1', shift(big, 200))], ['map0', 'map1'], 3, null);
    expect(plan.reduce((n, z) => n + z.points.length, 0)).toBeLessThanOrEqual(PATROL_MAX_POINTS);
    expect(plan.map(z => z.zone)).toEqual(['map0', 'map1']);
    expect(plan.every(z => z.points.length > 0)).toBe(true);
  });

  it('rounds points to centimetres for the wire', () => {
    const plan = buildPatrolZones([row('map0', SQ)], ['map0'], 5, null);
    for (const [x, y] of plan[0].points) {
      expect(Math.round(x * 100) / 100).toBe(x);
      expect(Math.round(y * 100) / 100).toBe(y);
    }
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd server && npx vitest run src/__tests__/services/patrolRoute.test.ts`
Expected: FAIL, cannot find module `../../services/patrolRoute.js`.

- [ ] **Step 3: Implement**

```ts
// server/src/services/patrolRoute.ts
/**
 * Night patrol route: checkpoints along each chosen zone's border, a little
 * inside it. The mower drives them with nav2 (blades off) and re-checks every
 * point against its own zone files, so a point that lands wrong is skipped
 * there, never driven. Pure: no DB, no MQTT.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
import { pointInPolygon, type XY } from '../maps/editGeometry.js';

export const PATROL_INSET_M = 0.6;
/** The mower refuses more (extended_commands.py PATROL_MAX_POINTS). */
export const PATROL_MAX_POINTS = 60;

export interface PatrolZone { zone: string; points: Array<[number, number]> }

function segDist(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

export function distToBoundary(p: XY, poly: XY[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
}

function signedArea(poly: XY[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/**
 * Every `spacingM` metres along the border take the border point, step
 * `insetM` along that edge's inward normal, and keep the point only when it
 * lies inside and at least 0.8 * insetM from every edge. A narrow neck or a
 * sharp corner then gives no checkpoint rather than one in the hedge.
 */
export function patrolCheckpoints(poly: XY[], spacingM = 6, insetM = PATROL_INSET_M): XY[] {
  if (poly.length < 3 || !(spacingM > 0)) return [];
  const ccw = signedArea(poly) > 0;
  const out: XY[] = [];
  let carry = spacingM / 2;   // the first checkpoint half a step along the border
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    // Interior lies left of each edge on a counter-clockwise polygon.
    const nx = (ccw ? -(b.y - a.y) : (b.y - a.y)) / len;
    const ny = (ccw ? (b.x - a.x) : -(b.x - a.x)) / len;
    let s = carry;
    for (; s <= len; s += spacingM) {
      const t = s / len;
      const q = { x: a.x + t * (b.x - a.x) + nx * insetM, y: a.y + t * (b.y - a.y) + ny * insetM };
      if (pointInPolygon(q, poly) && distToBoundary(q, poly) >= 0.8 * insetM) out.push(q);
    }
    carry = s - len;
  }
  return out;
}

/** The zone the dock stands in, or beside within 2 m (the anchor can sit just outside). */
function dockZone(polys: Map<string, XY[]>, dock: XY | null): string | null {
  if (!dock) return null;
  let best: { d: number; zone: string } | null = null;
  for (const [zone, poly] of polys) {
    const d = pointInPolygon(dock, poly) ? 0 : distToBoundary(dock, poly);
    if (d <= 2 && (!best || d < best.d)) best = { d, zone };
  }
  return best?.zone ?? null;
}

/**
 * The plan for the chosen zones: the dock's zone first, then the rest by
 * slot. No choice means the dock's zone only. Above `maxPoints` every zone is
 * thinned by the same stride, so a big garden still gets checkpoints all round.
 */
export function buildPatrolZones(
  rows: Array<{ canonical_name: string | null; map_area: string | null }>,
  wanted: string[], spacingM: number, dock: XY | null, maxPoints = PATROL_MAX_POINTS,
): PatrolZone[] {
  const polys = new Map<string, XY[]>();
  for (const r of rows) {
    const zone = r.canonical_name?.match(/^map\d+$/)?.[0];
    if (!zone || !r.map_area) continue;
    try {
      const poly = JSON.parse(r.map_area) as XY[];
      if (Array.isArray(poly) && poly.length >= 3) polys.set(zone, poly);
    } catch { /* a broken polygon row is skipped */ }
  }
  const home = dockZone(polys, dock);
  const chosen = [...new Set(wanted.length ? wanted : home ? [home] : [])].filter(z => polys.has(z));
  const slot = (z: string) => Number(z.slice(3));
  chosen.sort((a, b) => (a === home ? -1 : b === home ? 1 : slot(a) - slot(b)));
  const zones = chosen.map(zone => ({ zone, pts: patrolCheckpoints(polys.get(zone)!, spacingM) }));
  const kept = (stride: number) => zones.reduce((n, z) => n + Math.ceil(z.pts.length / stride), 0);
  let stride = 1;
  while (kept(stride) > maxPoints) stride++;
  return zones
    .map(z => ({
      zone: z.zone,
      points: z.pts.filter((_, i) => i % stride === 0)
        .map(p => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100] as [number, number]),
    }))
    .filter(z => z.points.length > 0);
}
```

- [ ] **Step 4: Run the test**

Run: `cd server && npx vitest run src/__tests__/services/patrolRoute.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/patrolRoute.ts server/src/__tests__/services/patrolRoute.test.ts
git commit -m "feat(server): patrol checkpoints from zone polygons"
```

### Task 6: Patrol events

**Files:**
- Modify: `server/src/notifications/types.ts`, `server/src/notifications/eventDetector.ts`, `server/src/notifications/expoPush.ts`
- Test: `server/src/__tests__/notifications/patrolEvents.test.ts`, `server/src/__tests__/notifications/pushMuting.test.ts` (its list of allowed categories)

**Interfaces:**
- Produces: `EventType` adds `'patrol_detection' | 'patrol_failed'`; `EventCategory` adds `'patrol'`; `dispatchPatrolDetectionEvent(sn: string, d: { run: string; seq: number; kind: 'person' | 'animal'; points: number; image: boolean }): void`; `dispatchPatrolFailedEvent(sn: string, reason: string, wentHome: boolean): void`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/notifications/patrolEvents.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../notifications/dispatcher.js', () => ({ dispatchEvent: vi.fn() }));

import { dispatchEvent } from '../../notifications/dispatcher.js';
import { dispatchPatrolDetectionEvent, dispatchPatrolFailedEvent } from '../../notifications/eventDetector.js';
import { CATEGORY_BY_TYPE } from '../../notifications/types.js';

describe('patrol events', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a detection is its own event type in the patrol category', () => {
    dispatchPatrolDetectionEvent('LFIN1', { run: '17', seq: 4, kind: 'person', points: 120, image: true });
    const ev = vi.mocked(dispatchEvent).mock.calls[0][0];
    expect(ev.type).toBe('patrol_detection');
    expect(CATEGORY_BY_TYPE[ev.type]).toBe('patrol');
    expect(ev.message).toContain('a person');
    expect(ev.data).toMatchObject({ run: '17', seq: 4, kind: 'person', points: 120, image: true });
  });

  it('a failed patrol says whether the mower was sent home', () => {
    dispatchPatrolFailedEvent('LFIN1', 'checkpoints_unreachable', true);
    dispatchPatrolFailedEvent('LFIN1', 'not_localized', false);
    const [a, b] = vi.mocked(dispatchEvent).mock.calls.map(c => c[0]);
    expect(a.type).toBe('patrol_failed');
    expect(CATEGORY_BY_TYPE[a.type]).toBe('patrol');
    expect(a.message).toContain('sent back to its dock');
    expect(b.message).toContain('did not leave its dock');
  });
});
```

In `server/src/__tests__/notifications/pushMuting.test.ts`, the test 'maps every event type to a category' lists the allowed categories; add `'patrol'`:

```ts
      expect(['activity', 'errors', 'safety', 'battery', 'maintenance', 'patrol']).toContain(cat);
```

- [ ] **Step 2: Run to see it fail**

Run: `cd server && npx vitest run src/__tests__/notifications/patrolEvents.test.ts`
Expected: FAIL, `dispatchPatrolDetectionEvent` is not exported.

- [ ] **Step 3: Implement**

`server/src/notifications/types.ts`: change the end of the `EventType` union and the category list:

```ts
  | 'blade_maintenance'      // mowing hours since the last blade change passed the configured interval
  | 'patrol_detection'       // the night patrol saw a person or an animal at a checkpoint
  | 'patrol_failed';         // the night patrol stopped before it was done
```

```ts
export type EventCategory = 'activity' | 'errors' | 'safety' | 'battery' | 'maintenance' | 'patrol';
```

and in `CATEGORY_BY_TYPE`, after the `dock_drift: ...` line:

```ts
  patrol_detection: 'patrol', patrol_failed: 'patrol',
```

`server/src/notifications/eventDetector.ts`: in `TITLE_BY_TYPE`, after `blade_maintenance: ...`:

```ts
  patrol_detection:     'Patrol alert',
  patrol_failed:        'Patrol stopped',
```

and after `dispatchDockDriftEvent`:

```ts
/** The night patrol saw a person or an animal (patrolService.onPatrolFrame). */
export function dispatchPatrolDetectionEvent(
  sn: string,
  d: { run: string; seq: number; kind: 'person' | 'animal'; points: number; image: boolean },
): void {
  dispatchEvent(makeEvent(
    sn,
    'patrol_detection',
    TITLE_BY_TYPE.patrol_detection,
    `The patrol saw ${d.kind === 'person' ? 'a person' : 'an animal'} at checkpoint ${d.seq}.`
      + (d.image ? ' The photo is in the patrol overview.' : ' No photo was taken there.'),
    { run: d.run, seq: d.seq, kind: d.kind, points: d.points, image: d.image },
  ));
}

/** The night patrol stopped with an error (patrolService.onPatrolStatus). */
export function dispatchPatrolFailedEvent(sn: string, reason: string, wentHome: boolean): void {
  dispatchEvent(makeEvent(
    sn,
    'patrol_failed',
    TITLE_BY_TYPE.patrol_failed,
    `The night patrol stopped (${reason}).`
      + (wentHome ? ' The mower was sent back to its dock.' : ' The mower did not leave its dock.'),
    { reason, went_home: wentHome },
  ));
}
```

`server/src/notifications/expoPush.ts`, in `toMessage`, change the `isAlert` line to:

```ts
  const isAlert = ev.type === 'stuck' || ev.type === 'error' || ev.type === 'low_battery'
    || ev.type === 'patrol_detection';
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd server && npx vitest run src/__tests__/notifications/ && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/notifications/types.ts server/src/notifications/eventDetector.ts server/src/notifications/expoPush.ts server/src/__tests__/notifications/patrolEvents.test.ts server/src/__tests__/notifications/pushMuting.test.ts
git commit -m "feat(server): patrol_detection and patrol_failed events"
```

### Task 7: Patrol service

**Files:**
- Create: `server/src/services/patrolService.ts`
- Modify: `server/src/services/apiText.catalog.ts`
- Test: `server/src/__tests__/services/patrolService.test.ts`

**Interfaces:**
- Consumes: `buildPatrolZones` (Task 5), `dispatchPatrolDetectionEvent`, `dispatchPatrolFailedEvent` (Task 6), `publishExtendedCommand(sn, cmd)`, `publishToTopic(topic, payload)`, `isDeviceOnline(sn)`, `deviceCache`, `deviceSettingsRepo`, `mapRepo.findWorkMaps(sn)`, `isOpenNovaMower(sn, cache)`, `isMowerBusy(sn)`, `goHome(sn)`, `isMowerMapOperationBusy(sn)`, `isFrameUnvalidated(sn)`, `getPolygonAnchor(sn)`, `customBuildNumber(version)`, `mowerSwVersion(sn, live)`, `M`, `renderMsg`.
- Produces: `PATROL_KEYS`, `type PatrolPhotoTopic`, `interface PatrolSettings { zones: string[]; spacingM: number; dwellS: number; headlight: number; minPoints: number; photoTopic: PatrolPhotoTopic }`, `readPatrolSettings(sn): PatrolSettings`, `PATROL_MIN_BUILD = 50`, `PATROL_MIN_BATTERY = 50`, `PATROL_ALERT_GAP_MS = 120_000`, `interface PatrolResult { ok: boolean; run?: string; error?: string; errorMsg?: Msg }`, `startPatrol(sn, now?): PatrolResult`, `stopPatrol(sn): void`, `onPatrolStatus(sn, phase, error?): void`, `interface PatrolFrameReport { run: string; seq: number; person: number; animal: number; frames: number; image: boolean }`, `onPatrolFrame(sn, f, now?): Array<'person' | 'animal'>`, `alertKinds(f, minPoints): Array<'person' | 'animal'> | null`, `_resetPatrolState()`.

`PATROL_MIN_BUILD` must be the number of the first custom build that ships Tasks 1 to 4. custom-49 is the newest today, so 50; adjust if the build that ships it has a different number (Task 13).

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/services/patrolService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../mqtt/extendedCommands.js', () => ({ publishExtendedCommand: vi.fn() }));
vi.mock('../../mqtt/mapSync.js', () => ({ publishToTopic: vi.fn(), publishToDevice: vi.fn() }));
vi.mock('../../mqtt/broker.js', () => ({ isDeviceOnline: vi.fn(() => true) }));
vi.mock('../../mqtt/sensorData.js', () => ({ deviceCache: new Map<string, Map<string, string>>() }));
vi.mock('../../services/mowerFileCapability.js', () => ({ isOpenNovaMower: vi.fn(() => true) }));
vi.mock('../../services/mowingService.js', () => ({ isMowerBusy: vi.fn(() => false), goHome: vi.fn(() => ({ ok: true })) }));
vi.mock('../../services/mowerMapOperation.js', () => ({ isMowerMapOperationBusy: vi.fn(() => false) }));
vi.mock('../../services/frameValidation.js', () => ({ isFrameUnvalidated: vi.fn(() => false) }));
vi.mock('../../services/anchor.js', () => ({ getPolygonAnchor: vi.fn(() => ({ x: 1, y: 1, orientation: 0, orientationSource: 'x' })) }));
vi.mock('../../notifications/eventDetector.js', () => ({
  dispatchPatrolDetectionEvent: vi.fn(), dispatchPatrolFailedEvent: vi.fn(),
}));

import {
  startPatrol, onPatrolStatus, onPatrolFrame, readPatrolSettings, alertKinds, _resetPatrolState,
  PATROL_ALERT_GAP_MS,
} from '../../services/patrolService.js';
import { publishExtendedCommand } from '../../mqtt/extendedCommands.js';
import { publishToTopic } from '../../mqtt/mapSync.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { goHome } from '../../services/mowingService.js';
import { dispatchPatrolDetectionEvent, dispatchPatrolFailedEvent } from '../../notifications/eventDetector.js';
import { mapRepo, deviceSettingsRepo } from '../../db/repositories/index.js';

const SN = 'LFIN_PATROL_0001';
const SQ = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

function mower(fields: Record<string, string>) {
  deviceCache.set(SN, new Map(Object.entries({ sw_version: 'v6.0.2-custom-50', battery_power: '80', ...fields })));
}

describe('patrol service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPatrolState();
    deviceCache.clear();
    for (const m of mapRepo.findByMowerSn(SN)) mapRepo.deleteWithCascade(m.map_id, SN);
    for (const r of deviceSettingsRepo.findBySn(SN)) deviceSettingsRepo.remove(SN, r.key);
    mapRepo.create({ map_id: 'pz0', mower_sn: SN, map_name: 'map0', canonical_name: 'map0',
      map_type: 'work', map_area: JSON.stringify(SQ), file_name: 'map0.csv' });
  });

  it('starts a patrol of the dock zone with the saved settings', () => {
    mower({});
    deviceSettingsRepo.upsert(SN, 'patrol_dwell_s', '8');
    const r = startPatrol(SN, 1000);
    expect(r).toEqual({ ok: true, run: '1000' });
    const cmd = vi.mocked(publishExtendedCommand).mock.calls[0][1] as { patrol: { run: string; zones: Array<{ zone: string; points: number[][] }>; dwell_s: number; photo_topic: string } };
    expect(cmd.patrol.run).toBe('1000');
    expect(cmd.patrol.zones[0].zone).toBe('map0');
    expect(cmd.patrol.zones[0].points.length).toBeGreaterThan(0);
    expect(cmd.patrol.dwell_s).toBe(8);
    expect(cmd.patrol.photo_topic).toBe('front');
  });

  it('refuses a build without patrol, a low battery and a garden without checkpoints', () => {
    mower({ sw_version: 'v6.0.2-custom-49' });
    expect(startPatrol(SN).error).toContain('50');
    mower({ battery_power: '30' });
    expect(startPatrol(SN).ok).toBe(false);
    mower({});
    mapRepo.deleteWithCascade('pz0', SN);
    expect(startPatrol(SN).ok).toBe(false);
    expect(publishExtendedCommand).not.toHaveBeenCalled();
  });

  it('clamps settings and ignores nonsense', () => {
    deviceSettingsRepo.upsert(SN, 'patrol_spacing_m', '100');
    deviceSettingsRepo.upsert(SN, 'patrol_photo_topic', '/etc/passwd');
    deviceSettingsRepo.upsert(SN, 'patrol_zones', '["map1","x;y"]');
    const s = readPatrolSettings(SN);
    expect(s.spacingM).toBe(15);
    expect(s.photoTopic).toBe('front');
    expect(s.zones).toEqual(['map1']);
    expect(s.minPoints).toBe(40);
  });

  it('an error before the mower left the dock turns the light off but sends nobody home', () => {
    onPatrolStatus(SN, 'error', 'busy_mowing');
    expect(publishToTopic).toHaveBeenCalledWith(`novabot/cmd/${SN}`, { led_set: 0 });
    expect(goHome).not.toHaveBeenCalled();
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledWith(SN, 'busy_mowing', false);
  });

  it('a finished patrol: light on while out, off BEFORE go_to_charge', () => {
    onPatrolStatus(SN, 'patrolling');
    expect(publishToTopic).toHaveBeenCalledWith(`novabot/cmd/${SN}`, { led_set: 100 });
    onPatrolStatus(SN, 'done');
    const offCall = vi.mocked(publishToTopic).mock.calls.findIndex(c => (c[1] as { led_set: number }).led_set === 0);
    expect(offCall).toBeGreaterThan(-1);
    expect(vi.mocked(publishToTopic).mock.invocationCallOrder[offCall])
      .toBeLessThan(vi.mocked(goHome).mock.invocationCallOrder[0]);
  });

  it('a stop leaves the mower where it is, light off', () => {
    onPatrolStatus(SN, 'patrolling');
    onPatrolStatus(SN, 'stopped');
    expect(goHome).not.toHaveBeenCalled();
    expect(publishToTopic).toHaveBeenLastCalledWith(`novabot/cmd/${SN}`, { led_set: 0 });
  });

  it('an error out in the garden sends it home and says so', () => {
    onPatrolStatus(SN, 'patrolling');
    onPatrolStatus(SN, 'error', 'checkpoints_unreachable');
    expect(goHome).toHaveBeenCalledWith(SN);
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledWith(SN, 'checkpoints_unreachable', true);
  });

  it('headlight 0 in the settings means no light at all', () => {
    deviceSettingsRepo.upsert(SN, 'patrol_headlight', '0');
    onPatrolStatus(SN, 'patrolling');
    expect(publishToTopic).not.toHaveBeenCalled();
  });

  it('no perception data is never an alert', () => {
    expect(alertKinds({ person: 500, animal: 500, frames: 1 }, 40)).toBeNull();
    expect(onPatrolFrame(SN, { run: '1', seq: 1, person: 500, animal: 0, frames: 1, image: true })).toEqual([]);
    expect(dispatchPatrolDetectionEvent).not.toHaveBeenCalled();
  });

  it('alerts once per class per run within the gap', () => {
    const f = { run: '1', seq: 1, person: 60, animal: 0, frames: 3, image: true };
    expect(onPatrolFrame(SN, f, 0)).toEqual(['person']);
    expect(onPatrolFrame(SN, { ...f, seq: 2 }, 1000)).toEqual([]);
    expect(onPatrolFrame(SN, { ...f, seq: 3 }, PATROL_ALERT_GAP_MS + 1)).toEqual(['person']);
    expect(onPatrolFrame(SN, { ...f, run: '2' }, PATROL_ALERT_GAP_MS + 2)).toEqual(['person']);
    expect(dispatchPatrolDetectionEvent).toHaveBeenCalledTimes(3);
    expect(dispatchPatrolDetectionEvent).toHaveBeenCalledWith(SN, { run: '1', seq: 1, kind: 'person', points: 60, image: true });
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd server && npx vitest run src/__tests__/services/patrolService.test.ts`
Expected: FAIL, cannot find module `../../services/patrolService.js`.

- [ ] **Step 3: Implement**

```ts
// server/src/services/patrolService.ts
/**
 * Night patrol (OpenNova): settings, start/stop, and what the server does with
 * the mower's patrol_status stream and checkpoint reports.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
import { publishExtendedCommand } from '../mqtt/extendedCommands.js';
import { publishToTopic } from '../mqtt/mapSync.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { deviceCache } from '../mqtt/sensorData.js';
import { deviceSettingsRepo } from '../db/repositories/deviceSettings.js';
import { mapRepo } from '../db/repositories/maps.js';
import { isOpenNovaMower } from './mowerFileCapability.js';
import { isMowerBusy, goHome } from './mowingService.js';
import { isMowerMapOperationBusy } from './mowerMapOperation.js';
import { isFrameUnvalidated } from './frameValidation.js';
import { getPolygonAnchor } from './anchor.js';
import { customBuildNumber } from './firmwareAdvisory.js';
import { mowerSwVersion } from './mowingArea.js';
import { buildPatrolZones } from './patrolRoute.js';
import { dispatchPatrolDetectionEvent, dispatchPatrolFailedEvent } from '../notifications/eventDetector.js';
import { M, renderMsg, type Msg } from './serverText.js';

/** device_settings keys, written through POST /sensor-override/:sn. */
export const PATROL_KEYS = {
  zones: 'patrol_zones',            // JSON array of 'mapN'; empty = the dock's zone
  spacing: 'patrol_spacing_m',
  dwell: 'patrol_dwell_s',
  headlight: 'patrol_headlight',
  minPoints: 'patrol_min_points',
  photoTopic: 'patrol_photo_topic',
} as const;

export type PatrolPhotoTopic = 'front' | 'front_hd' | 'tof_gray';

export interface PatrolSettings {
  zones: string[];
  spacingM: number;
  dwellS: number;
  headlight: number;
  minPoints: number;
  photoTopic: PatrolPhotoTopic;
}

function clamp(raw: string | undefined, min: number, max: number, dflt: number): number {
  const n = Number(raw);
  return raw != null && raw !== '' && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}

export function readPatrolSettings(sn: string): PatrolSettings {
  const s = new Map(deviceSettingsRepo.findBySn(sn).map(r => [r.key, r.value] as const));
  let zones: string[] = [];
  try {
    const parsed: unknown = JSON.parse(s.get(PATROL_KEYS.zones) ?? '[]');
    if (Array.isArray(parsed)) zones = parsed.filter((z): z is string => typeof z === 'string' && /^map\d+$/.test(z));
  } catch { /* unreadable: no explicit choice */ }
  const topic = s.get(PATROL_KEYS.photoTopic);
  return {
    zones,
    spacingM: clamp(s.get(PATROL_KEYS.spacing), 3, 15, 6),
    dwellS: clamp(s.get(PATROL_KEYS.dwell), 3, 20, 6),
    headlight: Math.round(clamp(s.get(PATROL_KEYS.headlight), 0, 100, 100)),
    // Default from the Phase-0 night test (spec, "Phase 0 result").
    minPoints: Math.round(clamp(s.get(PATROL_KEYS.minPoints), 5, 2000, 40)),
    photoTopic: topic === 'front_hd' || topic === 'tof_gray' ? topic : 'front',
  };
}

/** First custom build whose extended_commands.py knows `patrol`. */
export const PATROL_MIN_BUILD = 50;
export const PATROL_MIN_BATTERY = 50;

export interface PatrolResult { ok: boolean; run?: string; error?: string; errorMsg?: Msg }

function refuse(msg: Msg): PatrolResult {
  return { ok: false, error: renderMsg('en', msg), errorMsg: msg };
}

export function startPatrol(sn: string, now = Date.now()): PatrolResult {
  if (!isDeviceOnline(sn)) return refuse(M`maaier offline`);
  if (!isOpenNovaMower(sn, deviceCache.get(sn))) return refuse(M`vereist OpenNova custom firmware`);
  const build = customBuildNumber(mowerSwVersion(sn, deviceCache.get(sn)?.get('sw_version')));
  if (build == null || build < PATROL_MIN_BUILD) {
    return refuse(M`patrouille vereist custom firmware ${PATROL_MIN_BUILD} of nieuwer`);
  }
  if (isMowerBusy(sn)) return refuse(M`de maaier is bezig; stop de taak eerst`);
  if (isMowerMapOperationBusy(sn)) return refuse(M`er loopt een kaartbewerking; probeer het straks opnieuw`);
  // publishExtendedCommand would drop it silently in an unvalidated frame.
  if (isFrameUnvalidated(sn)) return refuse(M`het kaartframe is niet gevalideerd; her-anker eerst`);
  const battery = parseInt(deviceCache.get(sn)?.get('battery_power') ?? '', 10);
  if (Number.isFinite(battery) && battery < PATROL_MIN_BATTERY) {
    return refuse(M`accu te leeg voor een patrouille (${battery}%, minimaal ${PATROL_MIN_BATTERY}%)`);
  }
  const s = readPatrolSettings(sn);
  const zones = buildPatrolZones(mapRepo.findWorkMaps(sn), s.zones, s.spacingM, getPolygonAnchor(sn));
  if (!zones.length) return refuse(M`geen controlepunten: kies zones in de patrouille-instellingen`);
  const run = String(now);
  publishExtendedCommand(sn, { patrol: { run, zones, dwell_s: s.dwellS, photo_topic: s.photoTopic } });
  console.log(`[Patrol] start ${sn} run=${run} ${zones.map(z => `${z.zone}:${z.points.length}`).join(',')}`);
  return { ok: true, run };
}

export function stopPatrol(sn: string): void {
  publishExtendedCommand(sn, { stop_mow_zone: {} });
}

// Mowers that left the dock for the current patrol (PHASE patrolling seen).
const outOnPatrol = new Set<string>();

/**
 * The mower's patrol_status stream (broker.ts). On `patrolling` the headlight
 * goes on. On every end it goes off FIRST, so the dock marker always sees the
 * stock light (CLAUDE.md, dock LED = stock); then the firmware docks the mower,
 * but only when it actually left and nobody pressed stop.
 */
export function onPatrolStatus(sn: string, phase: string, error?: string): void {
  const led = (level: number) => publishToTopic(`novabot/cmd/${sn}`, { led_set: level });
  if (phase === 'patrolling') {
    outOnPatrol.add(sn);
    const level = readPatrolSettings(sn).headlight;
    if (level > 0) led(level);
    return;
  }
  if (phase !== 'done' && phase !== 'error' && phase !== 'stopped') return;
  led(0);
  const wasOut = outOnPatrol.delete(sn);
  const goesHome = wasOut && phase !== 'stopped';
  if (goesHome) goHome(sn);
  if (phase === 'error') dispatchPatrolFailedEvent(sn, error || 'unknown', goesHome);
}

export interface PatrolFrameReport {
  run: string; seq: number; person: number; animal: number; frames: number; image: boolean;
}

/** null = no data (fewer than two perception frames), else the classes at or above the threshold. */
export function alertKinds(f: { person: number; animal: number; frames: number }, minPoints: number): Array<'person' | 'animal'> | null {
  if (f.frames < 2) return null;
  return (['person', 'animal'] as const).filter(k => f[k] >= minPoints);
}

export const PATROL_ALERT_GAP_MS = 120_000;
// ponytail: grows by a few keys per patrol night; prune when patrols run hourly.
const lastAlert = new Map<string, number>();

/** A checkpoint report: an alert per class, at most once per class per run per gap. */
export function onPatrolFrame(sn: string, f: PatrolFrameReport, now = Date.now()): Array<'person' | 'animal'> {
  const kinds = alertKinds(f, readPatrolSettings(sn).minPoints) ?? [];
  const out: Array<'person' | 'animal'> = [];
  for (const kind of kinds) {
    const key = `${sn}:${f.run}:${kind}`;
    if (now - (lastAlert.get(key) ?? -Infinity) < PATROL_ALERT_GAP_MS) continue;
    lastAlert.set(key, now);
    out.push(kind);
    dispatchPatrolDetectionEvent(sn, { run: f.run, seq: f.seq, kind, points: f[kind], image: f.image });
  }
  return out;
}

/** Tests only. */
export function _resetPatrolState(): void {
  outOnPatrol.clear();
  lastAlert.clear();
}
```

In `server/src/services/apiText.catalog.ts`, add these entries inside `CATALOG` (next to the other mowing refusals):

```ts
  "patrouille vereist custom firmware {0} of nieuwer": {
    en: "a patrol needs custom firmware {0} or newer",
    fr: "une patrouille nécessite le firmware personnalisé {0} ou plus récent",
    de: "eine Patrouille erfordert Custom-Firmware {0} oder neuer",
  },
  "de maaier is bezig; stop de taak eerst": {
    en: "the mower is busy; stop the task first",
    fr: "la tondeuse est occupée ; arrêtez d'abord la tâche",
    de: "der Mäher ist beschäftigt; stoppen Sie zuerst die Aufgabe",
  },
  "er loopt een kaartbewerking; probeer het straks opnieuw": {
    en: "a map operation is running; try again shortly",
    fr: "une opération sur la carte est en cours ; réessayez dans un instant",
    de: "eine Kartenbearbeitung läuft; versuchen Sie es gleich noch einmal",
  },
  "het kaartframe is niet gevalideerd; her-anker eerst": {
    en: "the map frame is not validated; re-anchor first",
    fr: "le repère de la carte n'est pas validé ; réancrez d'abord",
    de: "der Kartenrahmen ist nicht validiert; zuerst neu verankern",
  },
  "accu te leeg voor een patrouille ({0}%, minimaal {1}%)": {
    en: "battery too low for a patrol ({0}%, at least {1}%)",
    fr: "batterie trop faible pour une patrouille ({0} %, au moins {1} %)",
    de: "Akku zu schwach für eine Patrouille ({0} %, mindestens {1} %)",
  },
  "geen controlepunten: kies zones in de patrouille-instellingen": {
    en: "no checkpoints: choose zones in the patrol settings",
    fr: "aucun point de contrôle : choisissez des zones dans les réglages de la patrouille",
    de: "keine Kontrollpunkte: wählen Sie Zonen in den Patrouille-Einstellungen",
  },
```

Before adding, grep the catalog for each Dutch key (`grep -n "de maaier is bezig; stop de taak eerst" server/src/services/apiText.catalog.ts`): reuse an existing entry instead of duplicating it (a duplicate object key is a TypeScript error).

- [ ] **Step 4: Run tests, the catalog coverage test and typecheck**

Run: `cd server && npx vitest run src/__tests__/services/patrolService.test.ts src/__tests__/services/serverText.coverage.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/patrolService.ts server/src/services/apiText.catalog.ts server/src/__tests__/services/patrolService.test.ts
git commit -m "feat(server): patrol service (start guards, headlight, docking, alerts)"
```

### Task 8: Checkpoint storage and the mower upload endpoint

**Files:**
- Create: `server/src/services/patrolFrames.ts`, `server/src/cloud-api/routes/patrol.ts`
- Modify: `server/src/cloud-api/index.ts`
- Test: `server/src/__tests__/services/patrolFrames.test.ts`, `server/src/cloud-api/__tests__/contract/patrol.upload.test.ts`

**Interfaces:**
- Consumes: `onPatrolFrame(sn, PatrolFrameReport)` (Task 7); mower POST from Task 3 (`?sn&run&seq&x&y&frames&person&animal`, body JPEG or empty).
- Produces: `PATROL_KEEP_RUNS = 10`, `interface PatrolFrameMeta { seq; x; y; person; animal; frames; image: boolean; ts }`, `interface PatrolRun { run: string; startedAt: number; frames: PatrolFrameMeta[] }`, `savePatrolFrame(sn, run, meta, jpeg: Buffer | null)`, `listPatrolRuns(sn): PatrolRun[]` (newest first), `patrolImagePath(sn, run, seq: string): string | null`; route `POST /api/nova-file-server/patrol/uploadFrame`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/__tests__/services/patrolFrames.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { savePatrolFrame, listPatrolRuns, patrolImagePath, PATROL_KEEP_RUNS } from '../../services/patrolFrames.js';

const SN = 'LFIN9990000001';
const ROOT = path.resolve(process.env.STORAGE_PATH ?? './storage', 'patrol', SN);
const meta = (seq: number, over: Partial<{ person: number; image: boolean; frames: number }> = {}) =>
  ({ seq, x: 1, y: 2, person: 0, animal: 0, frames: 3, image: true, ts: 1, ...over });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe('patrol frames on disk', () => {
  beforeEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it('keeps photo and metadata per checkpoint and lists the newest run first', () => {
    savePatrolFrame(SN, '100', meta(1), JPEG);
    savePatrolFrame(SN, '100', meta(2, { image: false }), null);
    savePatrolFrame(SN, '200', meta(1, { person: 60 }), JPEG);
    const runs = listPatrolRuns(SN);
    expect(runs.map(r => r.run)).toEqual(['200', '100']);
    expect(runs[1].frames.map(f => f.seq)).toEqual([1, 2]);
    expect(patrolImagePath(SN, '100', '1')).not.toBeNull();
    expect(patrolImagePath(SN, '100', '2')).toBeNull();
  });

  it(`keeps only the last ${PATROL_KEEP_RUNS} runs, oldest by number`, () => {
    for (let run = 1; run <= PATROL_KEEP_RUNS + 2; run++) savePatrolFrame(SN, String(run), meta(1), JPEG);
    const runs = listPatrolRuns(SN).map(r => r.run);
    expect(runs).toHaveLength(PATROL_KEEP_RUNS);
    expect(runs).not.toContain('1');
    expect(runs).not.toContain('2');
  });

  it('never resolves a path outside the patrol folder', () => {
    expect(patrolImagePath('../etc', '1', '1')).toBeNull();
    expect(patrolImagePath(SN, '../1', '1')).toBeNull();
    expect(patrolImagePath(SN, '1', '../1')).toBeNull();
    expect(listPatrolRuns('../x')).toEqual([]);
    expect(() => savePatrolFrame(SN, '../9', meta(1), JPEG)).toThrow();
  });
});
```

```ts
// server/src/cloud-api/__tests__/contract/patrol.upload.test.ts
/**
 * Contract test: POST /api/nova-file-server/patrol/uploadFrame.
 * mow_zone_drive.py (patrol mode) posts one checkpoint: a JPEG or an empty
 * body, the scores in the query. Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Server } from 'http';
import type { Express } from 'express';
import fs from 'fs';
import path from 'path';

vi.mock('../../../services/patrolService.js', () => ({ onPatrolFrame: vi.fn(() => []) }));

import { buildTestApp } from '../testHarness.js';
import { onPatrolFrame } from '../../../services/patrolService.js';

const openServers: Server[] = [];
function api(app: Express) {
  const server = app.listen(0);
  openServers.push(server);
  return request(server);
}
afterEach(() => {
  for (const s of openServers.splice(0)) s.close();
  vi.clearAllMocks();
});

const SN = 'LFIN2230700238';
const DIR = path.resolve(process.env.STORAGE_PATH ?? './storage', 'patrol', SN, '777');
const Q = `/api/nova-file-server/patrol/uploadFrame?sn=${SN}&run=777&x=1.5&y=-2.25&frames=3&person=60&animal=0`;

describe('POST /api/nova-file-server/patrol/uploadFrame', () => {
  it('keeps the photo and metadata and hands the scores to the service', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9]);
    const res = await api(buildTestApp()).post(`${Q}&seq=1`)
      .set('Content-Type', 'application/octet-stream').send(jpeg);
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(DIR, '1.jpg')).equals(jpeg)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(DIR, '1.json'), 'utf8')))
      .toMatchObject({ seq: 1, x: 1.5, y: -2.25, person: 60, animal: 0, frames: 3, image: true });
    expect(onPatrolFrame).toHaveBeenCalledWith(SN, { run: '777', seq: 1, person: 60, animal: 0, frames: 3, image: true });
  });

  it('a checkpoint without a photo is kept as metadata only', async () => {
    const res = await api(buildTestApp()).post(`${Q}&seq=2`)
      .set('Content-Type', 'application/octet-stream').send(Buffer.alloc(0));
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(DIR, '2.jpg'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(DIR, '2.json'), 'utf8')).image).toBe(false);
  });

  it('refuses bad identifiers, bad numbers and a body that is no JPEG', async () => {
    const app = buildTestApp();
    const send = (url: string, body = Buffer.from([0xff, 0xd8])) =>
      api(app).post(url).set('Content-Type', 'application/octet-stream').send(body);
    expect((await send(`/api/nova-file-server/patrol/uploadFrame?sn=../x&run=1&seq=1&x=0&y=0&frames=0&person=0&animal=0`)).status).toBe(400);
    expect((await send(`/api/nova-file-server/patrol/uploadFrame?sn=${SN}&run=1a&seq=1&x=0&y=0&frames=0&person=0&animal=0`)).status).toBe(400);
    expect((await send(`/api/nova-file-server/patrol/uploadFrame?sn=${SN}&run=1&seq=999&x=0&y=0&frames=0&person=0&animal=0`)).status).toBe(400);
    expect((await send(`/api/nova-file-server/patrol/uploadFrame?sn=${SN}&run=1&seq=1&x=nan&y=0&frames=0&person=0&animal=0`)).status).toBe(400);
    expect((await send(`/api/nova-file-server/patrol/uploadFrame?sn=${SN}&run=1&seq=1&x=0&y=0&frames=0&person=-1&animal=0`)).status).toBe(400);
    expect((await send(`${Q}&seq=3`, Buffer.from('<html>'))).status).toBe(400);
    expect(onPatrolFrame).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd server && npx vitest run src/__tests__/services/patrolFrames.test.ts src/cloud-api/__tests__/contract/patrol.upload.test.ts`
Expected: FAIL, modules not found / 404.

- [ ] **Step 3: Implement**

```ts
// server/src/services/patrolFrames.ts
/**
 * Patrol checkpoints on disk: STORAGE_PATH/patrol/<sn>/<run>/<seq>.json and,
 * when the mower took one, <seq>.jpg. The last PATROL_KEEP_RUNS runs per mower
 * are kept. Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
import fs from 'fs';
import path from 'path';

const PATROL_DIR = path.resolve(process.env.STORAGE_PATH ?? './storage', 'patrol');
export const PATROL_KEEP_RUNS = 10;

export interface PatrolFrameMeta {
  seq: number; x: number; y: number; person: number; animal: number; frames: number; image: boolean; ts: number;
}
export interface PatrolRun { run: string; startedAt: number; frames: PatrolFrameMeta[] }

const SN_RE = /^LFI[A-Z]\d+$/;
const RUN_RE = /^\d{1,20}$/;

export function savePatrolFrame(sn: string, run: string, meta: PatrolFrameMeta, jpeg: Buffer | null): void {
  if (!SN_RE.test(sn) || !RUN_RE.test(run)) throw new Error('invalid sn or run');
  const dir = path.join(PATROL_DIR, sn, run);
  fs.mkdirSync(dir, { recursive: true });
  if (jpeg) fs.writeFileSync(path.join(dir, `${meta.seq}.jpg`), jpeg);
  fs.writeFileSync(path.join(dir, `${meta.seq}.json`), JSON.stringify(meta));
  const runs = fs.readdirSync(path.join(PATROL_DIR, sn)).filter(r => RUN_RE.test(r))
    .sort((a, b) => Number(a) - Number(b));
  for (const old of runs.slice(0, -PATROL_KEEP_RUNS)) {
    fs.rmSync(path.join(PATROL_DIR, sn, old), { recursive: true, force: true });
  }
}

export function listPatrolRuns(sn: string): PatrolRun[] {
  if (!SN_RE.test(sn)) return [];
  const root = path.join(PATROL_DIR, sn);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(r => RUN_RE.test(r))
    .sort((a, b) => Number(b) - Number(a))
    .map(run => {
      const dir = path.join(root, run);
      const frames = fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f))
        .map(f => {
          try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as PatrolFrameMeta; } catch { return null; }
        })
        .filter((m): m is PatrolFrameMeta => m !== null)
        .sort((a, b) => a.seq - b.seq);
      return { run, startedAt: Number(run), frames };
    });
}

export function patrolImagePath(sn: string, run: string, seq: string): string | null {
  if (!SN_RE.test(sn) || !RUN_RE.test(run) || !/^\d{1,3}$/.test(seq)) return null;
  const p = path.join(PATROL_DIR, sn, run, `${seq}.jpg`);
  return fs.existsSync(p) ? p : null;
}
```

```ts
// server/src/cloud-api/routes/patrol.ts
/**
 * Night patrol uploads from the mower (mow_zone_drive.py, patrol mode).
 * POST /api/nova-file-server/patrol/uploadFrame?sn&run&seq&x&y&frames&person&animal
 * Body: raw JPEG (max 3 MB) or empty when the camera gave nothing.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
import express, { Router, Request, Response } from 'express';
import { ok, fail } from '../../types/index.js';
import { savePatrolFrame } from '../../services/patrolFrames.js';
import { onPatrolFrame } from '../../services/patrolService.js';

export const patrolRouter = Router();

patrolRouter.post(
  '/uploadFrame',
  express.raw({ type: 'application/octet-stream', limit: '3mb' }),
  (req: Request, res: Response) => {
    const sn = String(req.query.sn ?? '');
    const run = String(req.query.run ?? '');
    const seqRaw = String(req.query.seq ?? '');
    const x = Number(req.query.x), y = Number(req.query.y);
    const [person, animal, frames] = ['person', 'animal', 'frames'].map(k => Number(req.query[k]));
    if (!/^LFI[A-Z]\d+$/.test(sn) || !/^\d{1,20}$/.test(run)
        || !/^[1-9]\d{0,2}$/.test(seqRaw) || Number(seqRaw) > 200
        || ![x, y].every(Number.isFinite)
        || ![person, animal, frames].every(v => Number.isInteger(v) && v >= 0 && v < 1e7)) {
      res.status(400).json(fail('invalid patrol frame params', 400)); return;
    }
    const body = req.body as unknown;
    const jpeg = Buffer.isBuffer(body) && body.length > 0 ? body : null;
    if (jpeg && !(jpeg[0] === 0xff && jpeg[1] === 0xd8)) {
      res.status(400).json(fail('not a jpeg', 400)); return;
    }
    const seq = Number(seqRaw);
    savePatrolFrame(sn, run, { seq, x, y, person, animal, frames, image: !!jpeg, ts: Date.now() }, jpeg);
    onPatrolFrame(sn, { run, seq, person, animal, frames, image: !!jpeg });
    res.json(ok(null));
  },
);
```

In `server/src/cloud-api/index.ts`: add `import { patrolRouter } from './routes/patrol.js';` next to the `terrainRouter` import, and after `app.use('/api/nova-file-server/terrain', terrainRouter);` add:

```ts
  app.use('/api/nova-file-server/patrol', patrolRouter);
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd server && npx vitest run src/__tests__/services/patrolFrames.test.ts src/cloud-api/__tests__/contract/ && npx tsc --noEmit`
Expected: PASS (including the existing terrain contract tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/patrolFrames.ts server/src/cloud-api/routes/patrol.ts server/src/cloud-api/index.ts server/src/__tests__/services/patrolFrames.test.ts server/src/cloud-api/__tests__/contract/patrol.upload.test.ts
git commit -m "feat(server): store patrol checkpoints uploaded by the mower"
```

### Task 9: Dashboard routes, navigation guards and the status mirror

**Files:**
- Modify: `server/src/routes/dashboard.ts` (the two dead `/patrol` routes near `// POST /api/dashboard/patrol/:sn`; `EXTENDED_MOVEMENT_KEYS`; imports)
- Modify: `server/src/services/frameValidation.ts` (`FRAME_BLOCKED_KEYS`), `server/src/services/mowerMapOperation.ts` (`NAVIGATION_COMMANDS`)
- Modify: `server/src/mqtt/broker.ts` (next to the `nav_to_point_status` mirror)
- Test: `server/src/__tests__/routes/stockFirmwareGate.test.ts`, `server/src/__tests__/mqtt/publishToDeviceGuard.test.ts`, `server/src/__tests__/services/mowerMapOperation.test.ts`

**Interfaces:**
- Consumes: `startPatrol`, `stopPatrol`, `readPatrolSettings`, `alertKinds`, `onPatrolStatus` (Task 7); `listPatrolRuns`, `patrolImagePath` (Task 8).
- Produces: `POST /api/dashboard/patrol/:sn` → `{ ok: true, run }` or 409 `{ ok: false, error }`; `POST /api/dashboard/stop-patrol/:sn` → `{ ok: true }`; `GET /api/dashboard/patrol/:sn/runs` → `{ ok: true, runs: Array<PatrolRun & { frames: Array<PatrolFrameMeta & { seen: Array<'person'|'animal'> | null }> }> }`; `GET /api/dashboard/patrol/:sn/runs/:run/:seq.jpg` → image/jpeg or 404. Device cache keys `patrol_phase`, `patrol_error` (forwarded to dashboards).

- [ ] **Step 1: Write the failing tests**

In `server/src/__tests__/routes/stockFirmwareGate.test.ts`:

1. Next to the other `vi.mock` calls (before the imports of the router), add:

```ts
vi.mock('../../services/patrolService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/patrolService.js')>()),
  startPatrol: vi.fn(() => ({ ok: true, run: '123' })),
  stopPatrol: vi.fn(),
}));
```

2. Add to the imports: `import { startPatrol } from '../../services/patrolService.js';` and `import { savePatrolFrame } from '../../services/patrolFrames.js';`

3. Add to `stockCases`:

```ts
  ['POST /patrol', () => request(server).post(`${B}/patrol/${SN}`).send({})],
  ['POST /stop-patrol', () => request(server).post(`${B}/stop-patrol/${SN}`).send({})],
```

4. Append at the end of the file:

```ts
describe('patrol routes', () => {
  const PSN = 'LFIN2230700999';
  beforeEach(() => { vi.clearAllMocks(); fw.supported = true; });

  it('starts and stops a patrol on OpenNova', async () => {
    const ok = await request(server).post(`${B}/patrol/${PSN}`).send({});
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, run: '123' });
    const stop = await request(server).post(`${B}/stop-patrol/${PSN}`).send({});
    expect(stop.status).toBe(200);
  });

  it('passes a refusal on with its reason', async () => {
    vi.mocked(startPatrol).mockReturnValueOnce({ ok: false, error: 'battery too low for a patrol (30%, at least 50%)' });
    const res = await request(server).post(`${B}/patrol/${PSN}`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('battery');
  });

  it('lists runs with what was seen, and "no data" as null', async () => {
    const meta = { x: 1, y: 2, animal: 0, image: true, ts: 1 };
    savePatrolFrame(PSN, '5', { ...meta, seq: 1, person: 60, frames: 3 }, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    savePatrolFrame(PSN, '5', { ...meta, seq: 2, person: 500, frames: 1 }, null);
    savePatrolFrame(PSN, '5', { ...meta, seq: 3, person: 0, frames: 4 }, null);
    const res = await request(server).get(`${B}/patrol/${PSN}/runs`);
    expect(res.status).toBe(200);
    // By run id: the test storage outlives a test run, so run 6 of the next test may already be there.
    const run5 = (res.body.runs as Array<{ run: string; frames: unknown[] }>).find(r => r.run === '5')!;
    const frames = run5.frames as Array<{ seq: number; seen: string[] | null }>;
    expect(frames.map(f => f.seen)).toEqual([['person'], null, []]);
  });

  it('serves a checkpoint photo and 404s the rest', async () => {
    savePatrolFrame(PSN, '6', { seq: 1, x: 0, y: 0, person: 0, animal: 0, frames: 3, image: true, ts: 1 },
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const img = await request(server).get(`${B}/patrol/${PSN}/runs/6/1.jpg`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/jpeg');
    expect((await request(server).get(`${B}/patrol/${PSN}/runs/6/2.jpg`)).status).toBe(404);
    expect((await request(server).get(`${B}/patrol/${PSN}/runs/x6/1.jpg`)).status).toBe(404);
  });
});
```

In `server/src/__tests__/mqtt/publishToDeviceGuard.test.ts`, inside the `describe`, add:

```ts
  it('blocks a patrol while the frame is unvalidated', () => {
    markFrameUnvalidated(SN);
    expect(isFrameNavBlocked(SN, { patrol: { run: '1', zones: [] } })).toBe(true);
  });
```

In `server/src/__tests__/services/mowerMapOperation.test.ts`, right after `expect(isMapOperationCommandBlocked('A', { go_to_charge: {} })).toBe(true);` add:

```ts
    expect(isMapOperationCommandBlocked('A', { patrol: {} })).toBe(true);
```

- [ ] **Step 2: Run to see them fail**

Run: `cd server && npx vitest run src/__tests__/routes/stockFirmwareGate.test.ts src/__tests__/mqtt/publishToDeviceGuard.test.ts src/__tests__/services/mowerMapOperation.test.ts`
Expected: FAIL (stock `/patrol` answers 200; the runs route is 404; patrol not blocked).

- [ ] **Step 3: Implement**

`server/src/services/frameValidation.ts`: add `'patrol'` to `FRAME_BLOCKED_KEYS`:

```ts
const FRAME_BLOCKED_KEYS = ['go_to_charge', 'start_navigation', 'start_run', 'start_edge_cut', 'mow_zone', 'nav_to_point', 'follow_unicom', 'return_to_dock', 'calibration_drive', 'dock_measurement_move', 'patrol'];
```

`server/src/services/mowerMapOperation.ts`: add `'patrol'` to `NAVIGATION_COMMANDS`:

```ts
const NAVIGATION_COMMANDS = new Set(['go_to_charge', 'start_navigation', 'start_run', 'start_edge_cut', 'mow_zone', 'auto_recharge', 'go_pile', 'nav_to_point', 'follow_unicom', 'return_to_dock', 'calibration_drive', 'patrol']);
```

`server/src/routes/dashboard.ts`:

- Imports (with the other service imports):

```ts
import { startPatrol, stopPatrol, readPatrolSettings, alertKinds } from '../services/patrolService.js';
import { listPatrolRuns, patrolImagePath } from '../services/patrolFrames.js';
```

- Add `'patrol'` to `EXTENDED_MOVEMENT_KEYS`:

```ts
const EXTENDED_MOVEMENT_KEYS = ['mow_zone', 'follow_unicom', 'start_edge_cut', 'return_to_dock', 'calibration_drive', 'nav_to_point', 'patrol'];
```

- Replace the two routes that start with `// POST /api/dashboard/patrol/:sn — start randmaaien (patrol mode)` and `// POST /api/dashboard/stop-patrol/:sn — stop randmaaien` by:

```ts
// Night patrol (OpenNova extended `patrol`; the stock start_patrol is a stub
// in mqtt_node). Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
dashboardRouter.post('/patrol/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  if (rejectUnlessOpenNova(sn, req, res, M`Patrouille`)) return;
  disarmEdgeWatch(sn, 'patrouille via dashboard');
  const r = startPatrol(sn);
  if (!r.ok) {
    res.status(409).json({ ok: false, error: r.errorMsg ? renderMsg(langOf(req), r.errorMsg) : r.error });
    return;
  }
  res.json({ ok: true, run: r.run });
});

dashboardRouter.post('/stop-patrol/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  if (rejectUnlessOpenNova(sn, req, res, M`Patrouille`)) return;
  stopPatrol(sn);
  res.json({ ok: true });
});

dashboardRouter.get('/patrol/:sn/runs', (req: Request, res: Response) => {
  const { sn } = req.params;
  const min = readPatrolSettings(sn).minPoints;
  const runs = listPatrolRuns(sn).map(r => ({
    ...r,
    frames: r.frames.map(f => ({ ...f, seen: alertKinds(f, min) })),
  }));
  res.json({ ok: true, runs });
});

dashboardRouter.get('/patrol/:sn/runs/:run/:seq.jpg', (req: Request, res: Response) => {
  const file = patrolImagePath(req.params.sn, req.params.run, req.params.seq);
  if (!file) { res.status(404).end(); return; }
  res.type('image/jpeg').sendFile(file);
});
```

Check `grep -n '"Patrouille"' server/src/services/apiText.catalog.ts`; if absent add:

```ts
  "Patrouille": { en: "Patrol", fr: "Patrouille", de: "Patrouille" },
```

`server/src/mqtt/broker.ts`: directly after the `if (extSn && cmdName === 'nav_to_point_status') { ... }` block, add:

```ts
        // Night patrol: mirror the phase for the dashboard and the app, and
        // let the service switch the headlight and dock the mower at the end.
        if (extSn && cmdName === 'patrol_status') {
          const body = parsed[cmdName] as { phase?: string; error?: string };
          if (body?.phase) {
            if (!deviceCache.has(extSn)) deviceCache.set(extSn, new Map());
            const cache = deviceCache.get(extSn)!;
            const changes = new Map<string, string>([
              ['patrol_phase', body.phase],
              ['patrol_error', body.phase === 'error' ? (body.error || 'unknown') : ''],
            ]);
            for (const [k, v] of changes) cache.set(k, v);
            forwardToDashboard(extSn, changes);
            const sn = extSn, phase = body.phase, error = body.error;
            void import('../services/patrolService.js').then(m => m.onPatrolStatus(sn, phase, error));
          }
        }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd server && npx vitest run src/__tests__/routes/stockFirmwareGate.test.ts src/__tests__/mqtt/publishToDeviceGuard.test.ts src/__tests__/services/mowerMapOperation.test.ts src/__tests__/services/serverText.coverage.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Full server suite**

Run: `cd server && npx vitest run`
Expected: everything green (the suite runs sequentially; a few minutes).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/dashboard.ts server/src/services/frameValidation.ts server/src/services/mowerMapOperation.ts server/src/mqtt/broker.ts server/src/services/apiText.catalog.ts server/src/__tests__/routes/stockFirmwareGate.test.ts server/src/__tests__/mqtt/publishToDeviceGuard.test.ts server/src/__tests__/services/mowerMapOperation.test.ts
git commit -m "feat(server): patrol routes, navigation guards and status mirror"
```

---

## Phase 3: schedules

### Task 10: Patrol schedules

**Files:**
- Modify: `server/src/db/database.ts` (migration after the `edge_days` one), `server/src/db/repositories/schedules.ts` (`ScheduleRow`, `create`)
- Modify: `server/src/routes/dashboard.ts` (`POST /schedules/:sn`, `GET /schedules/:sn`, `scheduleRowToDto`, `POST /schedules/:sn/:scheduleId/send`)
- Modify: `server/src/services/scheduleMirror.ts` (`mirrorScheduleToPlan`), `server/src/services/scheduleRunner.ts` (`checkWeatherAndTrigger`, `triggerSchedule`)
- Test: `server/src/__tests__/services/scheduleRunnerPatrol.test.ts`, `server/src/__tests__/routes/stockFirmwareGate.test.ts` (timer_task and send; broker online), `server/src/__tests__/routes/scheduleMirror.test.ts` (list filter and app plans; this file runs the real sensor cache, which `GET /schedules` needs)

**Interfaces:**
- Consumes: `startPatrol(sn)` (Task 7).
- Produces: column `dashboard_schedules.kind TEXT NOT NULL DEFAULT 'mow'` (`'mow' | 'patrol'`), `ScheduleRow.kind: string`, schedule DTO field `kind`, `POST /schedules/:sn` body field `kind`, `GET /schedules/:sn?kind=patrol`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/__tests__/services/scheduleRunnerPatrol.test.ts
/**
 * A patrol schedule starts a patrol, not a mow, and is exactly what the night
 * guard keeps mowing from: it must run at night.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../mqtt/broker.js', () => ({ isDeviceOnline: vi.fn(() => true) }));
vi.mock('../../mqtt/mapSync.js', () => ({ publishToDevice: vi.fn(), publishToTopic: vi.fn() }));
vi.mock('../../dashboard/socketHandler.js', () => ({ emitScheduleEvent: vi.fn(), pushMqttLog: vi.fn() }));
vi.mock('../../services/mowingService.js', () => ({
  startMowing: vi.fn(() => ({ ok: true })),
  edgeBladeHeightMm: vi.fn(() => 40),
  getMowerPhase: vi.fn(() => 'idle'),
  startEdgeCut: vi.fn(() => ({ ok: true })),
  EDGE_ALWAYS_KEY: 'edge_always',
  edgeAlways: vi.fn(() => false),
}));
vi.mock('../../services/patrolService.js', () => ({ startPatrol: vi.fn(() => ({ ok: true, run: '1' })) }));
vi.mock('../../services/weatherService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/weatherService.js')>()),
  getWeatherForecast: vi.fn(),
}));

import { startScheduleRunner, stopScheduleRunner } from '../../services/scheduleRunner.js';
import { scheduleRepo, rainSettingsRepo, mapRepo } from '../../db/repositories/index.js';
import { db } from '../../db/database.js';
import { startMowing } from '../../services/mowingService.js';
import { startPatrol } from '../../services/patrolService.js';
import { getWeatherForecast } from '../../services/weatherService.js';

const NOW = new Date('2026-08-05T23:00:30');
const SN = 'LFIN1231000211';
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function due(id: string, kind: 'mow' | 'patrol') {
  scheduleRepo.create({
    schedule_id: id, mower_sn: SN, start_time: '23:00', kind,
    weekdays: JSON.stringify([NOW.getDay()]), enabled: 1, rain_pause: 0,
  });
}

describe('patrol schedules', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM dashboard_schedules').run();
    rainSettingsRepo.set(SN, { nightGuard: true });
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(mapRepo, 'getChargerGps').mockReturnValue({ lat: 52, lng: 6 });
    vi.mocked(getWeatherForecast).mockResolvedValue({
      hourly: [], sunriseMs: NOW.getTime() - 16 * 3_600_000, sunsetMs: NOW.getTime() - 4 * 3_600_000, cachedAt: 0,
    });
  });
  afterEach(() => {
    stopScheduleRunner();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a patrol at night starts a patrol; a mow at night is still skipped', async () => {
    due('p-23', 'patrol');
    due('m-23', 'mow');
    startScheduleRunner();
    await flush();
    expect(startPatrol).toHaveBeenCalledWith(SN);
    expect(startMowing).not.toHaveBeenCalled();
    expect(scheduleRepo.findById('p-23')!.last_result).toBe('started');
    expect(scheduleRepo.findById('m-23')!.last_result).toBe('skipped');
  });

  it('a refused patrol is recorded as not started', async () => {
    vi.mocked(startPatrol).mockReturnValueOnce({ ok: false, error: 'battery too low' });
    due('p-23', 'patrol');
    startScheduleRunner();
    await flush();
    expect(scheduleRepo.findById('p-23')!.last_result).not.toBe('started');
  });
});
```

Append to the `describe('patrol routes', ...)` block in `server/src/__tests__/routes/stockFirmwareGate.test.ts` (the broker is mocked online here, so a mow schedule WOULD get a timer_task):

```ts
  it('a patrol schedule never goes to the mower as timer_task and cannot be sent', async () => {
    for (const s of scheduleRepo.findByMowerSn(PSN)) scheduleRepo.deleteByIdAndMower(s.schedule_id, PSN);
    const created = await request(server).post(`${B}/schedules/${PSN}`)
      .send({ kind: 'patrol', startTime: '23:30', weekdays: [0, 1, 2, 3, 4, 5, 6], rainPause: true });
    expect(created.status).toBe(200);
    expect(created.body.schedule.kind).toBe('patrol');
    expect(created.body.schedule.rainPause).toBe(false);
    expect(publishToDevice).not.toHaveBeenCalledWith(PSN, expect.objectContaining({ timer_task: expect.anything() }));
    const send = await request(server).post(`${B}/schedules/${PSN}/${created.body.schedule.scheduleId}/send`).send({});
    expect(send.status).toBe(409);
    expect(publishToDevice).not.toHaveBeenCalled();
  });
```

In `server/src/__tests__/routes/scheduleMirror.test.ts` (real sensor cache, which `GET /schedules` needs), add to the imports:

```ts
import { deviceCache } from '../../mqtt/sensorData.js';
```

and append at the end of the file:

```ts
describe('patrol schedules stay out of the mow lists and the app', () => {
  it('a patrol schedule is listed only with ?kind=patrol and never becomes an app plan', async () => {
    deviceCache.set(SN, new Map([['sw_version', 'v6.0.2-custom-50']]));   // OpenNova
    const res = await request(app).post(`/api/dashboard/schedules/${SN}`)
      .send({ kind: 'patrol', startTime: '23:30', weekdays: [0, 1, 2, 3, 4, 5, 6] });
    expect(res.status).toBe(200);
    const scheduleId = res.body.schedule.scheduleId as string;
    expect((await request(app).get(`/api/dashboard/schedules/${SN}`)).body.schedules).toHaveLength(0);
    const patrols = (await request(app).get(`/api/dashboard/schedules/${SN}?kind=patrol`)).body.schedules;
    expect(patrols.map((p: { scheduleId: string }) => p.scheduleId)).toEqual([scheduleId]);
    expect(cutGrassPlanRepo.findById(scheduleId)).toBeFalsy();
    deviceCache.delete(SN);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd server && npx vitest run src/__tests__/services/scheduleRunnerPatrol.test.ts src/__tests__/routes/stockFirmwareGate.test.ts src/__tests__/routes/scheduleMirror.test.ts`
Expected: FAIL (no `kind` column / field; the mow path runs).

- [ ] **Step 3: Implement**

`server/src/db/database.ts`, right after the `edge_days` migration block:

```ts
  // Nachtpatrouille: een schema is een maaibeurt ('mow') of een patrouille
  // ('patrol'). Patrouilleschema's draait alleen de server (spec 2026-10-14).
  try {
    db.exec(`ALTER TABLE dashboard_schedules ADD COLUMN kind TEXT NOT NULL DEFAULT 'mow'`);
    console.log('[DB] Migrated: added dashboard_schedules.kind');
  } catch {
    // Kolom bestaat al
  }
```

`server/src/db/repositories/schedules.ts`: in `interface ScheduleRow`, after `edge_days` (optional, because tests build `ScheduleRow` literals without it):

```ts
  /** 'mow' (default) or 'patrol' (night patrol, server-run only). */
  kind?: string;
```

`server/src/routes/dashboard.ts` has its OWN local `interface ScheduleRow` (above `scheduleRowToDto`); add the same optional field there, after `edge_days: string | null;`:

```ts
  kind?: string;
```

and in `create(...)` add `kind` as the 25th column and value:

```ts
        interval_days, interval_anchor_date, timezone, edge_days, kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

```ts
      data.timezone ?? null, data.edge_days ?? null, data.kind ?? 'mow',
```

`server/src/services/scheduleMirror.ts`, `mirrorScheduleToPlan`: change the first guard to:

```ts
  const row = scheduleRepo.findById(scheduleId);
  // A patrol is no mowing plan; the stock app would show it as one.
  if (!row || row.kind === 'patrol') return;
```

`server/src/routes/dashboard.ts`:

- `scheduleRowToDto`: add `kind: r.kind ?? 'mow',` after `scheduleId: r.schedule_id,`.
- `GET /schedules/:sn`: replace `const rows = scheduleRepo.findByMowerSnOrderByStartTime(sn) as ScheduleRow[];` by:

```ts
  // Patrol schedules live in the patrol panel; the mow lists never show them.
  const kind = req.query.kind === 'patrol' ? 'patrol' : 'mow';
  const rows = (scheduleRepo.findByMowerSnOrderByStartTime(sn) as ScheduleRow[])
    .filter(r => (r.kind ?? 'mow') === kind);
```

- `POST /schedules/:sn`: add `kind?: 'mow' | 'patrol';` to the body type; after the `edgeDays` OpenNova check add:

```ts
  const isPatrol = body.kind === 'patrol';
  if (isPatrol && rejectUnlessOpenNova(sn, req, res, M`Patrouille`)) return;
```

  pass `kind: isPatrol ? 'patrol' : 'mow',` to `scheduleRepo.create({...})`, change `rain_pause: body.rainPause ? 1 : 0,` to `rain_pause: !isPatrol && body.rainPause ? 1 : 0,`, and change the `timer_task` condition to:

```ts
  if (!isPatrol && isDeviceOnline(sn) && !body.rainPause && !(body.intervalDays && body.intervalDays > 0)) {
```

- `POST /schedules/:sn/:scheduleId/send`: right after the `if (!row) {...}` block:

```ts
  if (row.kind === 'patrol') {
    res.status(409).json({ error: T`Een patrouilleschema draait op de server en gaat niet naar de maaier.` });
    return;
  }
```

  and add to `apiText.catalog.ts`:

```ts
  "Een patrouilleschema draait op de server en gaat niet naar de maaier.": {
    en: "A patrol schedule runs on the server and is not sent to the mower.",
    fr: "Un programme de patrouille tourne sur le serveur et n'est pas envoyé à la tondeuse.",
    de: "Ein Patrouillenplan läuft auf dem Server und wird nicht an den Mäher gesendet.",
  },
```

`server/src/services/scheduleRunner.ts`:

- import: `import { startPatrol } from './patrolService.js';`
- `checkWeatherAndTrigger`: change the night line to:

```ts
  if (guards.nightGuard && row.kind !== 'patrol' && isNight(forecast, now)) {
```

- at the top of `triggerSchedule(row, warning)`:

```ts
  if (row.kind === 'patrol') {
    triggerPatrolSchedule(row, warning);
    return;
  }
```

- and add below `triggerSchedule`:

```ts
/** A patrol schedule: start the patrol; the frost guard applies, the night guard not. */
function triggerPatrolSchedule(row: ScheduleRow, warning?: Msg) {
  const result = startPatrol(row.mower_sn);
  if (result.ok) {
    scheduleRepo.incrementTriggerCount(row.schedule_id);
    logScheduleDecision(row, !warning, 'STARTED', warning ?? `patrol run=${result.run}`);
  } else {
    logScheduleDecision(row, false, 'NOT STARTED', result.errorMsg ?? (result.error ?? 'patrol refused'));
  }
  scheduleRepo.updateLastTriggered(row.schedule_id);
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd server && npx vitest run src/__tests__/services/scheduleRunnerPatrol.test.ts src/__tests__/routes/stockFirmwareGate.test.ts src/__tests__/routes/scheduleMirror.test.ts src/__tests__/services/ && npx tsc --noEmit`
Expected: PASS, no type errors. (A single 403 in a supertest-based test that passes when rerun alone is the known ephemeral-port collision described in those files, not a failure of this task.)

- [ ] **Step 5: Commit**

```bash
git add server/src/db/database.ts server/src/db/repositories/schedules.ts server/src/routes/dashboard.ts server/src/services/scheduleMirror.ts server/src/services/scheduleRunner.ts server/src/services/apiText.catalog.ts server/src/__tests__/services/scheduleRunnerPatrol.test.ts server/src/__tests__/routes/stockFirmwareGate.test.ts server/src/__tests__/routes/scheduleMirror.test.ts
git commit -m "feat(server): patrol schedules, server-run and allowed at night"
```

---

## Phase 4: user interface (gate: Ramon's OK on the mockup; Ramon tests before commit)

### Task 11: Dashboard patrol card

**Files:**
- Modify: `dashboard/src/api/client.ts` (replace `startPatrol` / `stopPatrol`; add types and helpers)
- Create: `dashboard/src/components/drawer/PatrolCard.tsx`
- Modify: `dashboard/src/shell/DashboardShell.tsx` (mount next to `DockDriftCard`)
- Modify: `dashboard/src/i18n/locales/{en,nl,de,fr}.json` (new `drawer.patrol` block)

**Interfaces:**
- Consumes: the Task 9 and Task 10 routes; `fetchDeviceSettings(sn)`, `setSensorOverride(sn, fields)`, `fetchMaps(sn)`.
- Produces: `startPatrol(sn)`, `stopPatrol(sn)`, `fetchPatrolRuns(sn): Promise<PatrolRunDto[]>`, `fetchPatrolPhoto(sn, run, seq): Promise<string>` (blob URL), `fetchPatrolSchedule(sn)`, `savePatrolSchedule(sn, startTime, enabled, existingId)`; component `PatrolCard({ sn, phase, error })`.

- [ ] **Step 1: Mockup for Ramon (get his OK before writing code)**

```
┌ Night patrol ─────────────────────────────┐
│ On patrol                    [ Stop ]     │   ← phase; button Start/Stop
│ Zones: [x] Achtertuin [ ] Voortuin        │   ← none ticked = dock's zone
│ Headlight during the patrol   [on]        │
│ Every night at [23:30] [on]               │   ← one patrol schedule
│ Last patrol (14 Oct, 23:30)               │
│ ┌────┐┌────┐┌────┐┌────┐                  │
│ │img ││img ││ -- ││img │  ...             │   ← photo per checkpoint
│ └────┘└────┘└────┘└────┘                  │
│ person  nothing  no camera  animal        │   ← per checkpoint
└───────────────────────────────────────────┘
```

- [ ] **Step 2: Client functions**

In `dashboard/src/api/client.ts`, replace the existing `startPatrol` and `stopPatrol` functions by:

```ts
export interface PatrolFrameDto {
  seq: number; x: number; y: number; person: number; animal: number; frames: number;
  image: boolean; ts: number; seen: Array<'person' | 'animal'> | null;
}
export interface PatrolRunDto { run: string; startedAt: number; frames: PatrolFrameDto[] }

/** Night patrol (OpenNova). Refusals come back with the server's reason. */
export async function startPatrol(sn: string): Promise<{ ok: boolean; run?: string; error?: string }> {
  const res = await apiFetch(`${BASE}/patrol/${encodeURIComponent(sn)}`, { method: 'POST' });
  return res.json().catch(() => ({ ok: false }));
}

export async function stopPatrol(sn: string): Promise<{ ok: boolean }> {
  return (await post(`${BASE}/stop-patrol/${encodeURIComponent(sn)}`)).json();
}

export async function fetchPatrolRuns(sn: string): Promise<PatrolRunDto[]> {
  const data = await (await get(`${BASE}/patrol/${encodeURIComponent(sn)}/runs`)).json();
  return data.runs ?? [];
}

/** Blob URL of one checkpoint photo (fetched with the bearer token); revoke it when done. */
export async function fetchPatrolPhoto(sn: string, run: string, seq: number): Promise<string> {
  const res = await get(`${BASE}/patrol/${encodeURIComponent(sn)}/runs/${run}/${seq}.jpg`);
  return URL.createObjectURL(await res.blob());
}

/** The one patrol schedule of this mower, or null. */
export async function fetchPatrolSchedule(sn: string): Promise<Schedule | null> {
  const data = await (await get(`${BASE}/schedules/${encodeURIComponent(sn)}?kind=patrol`)).json();
  return (data.schedules ?? [])[0] ?? null;
}

export async function savePatrolSchedule(sn: string, startTime: string, enabled: boolean, existingId: string | null): Promise<void> {
  if (existingId) {
    await updateSchedule(sn, existingId, { startTime, enabled });
    return;
  }
  await post(`${BASE}/schedules/${encodeURIComponent(sn)}`, {
    kind: 'patrol', startTime, enabled, weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: browserTimezone(),
  });
}
```

Make sure `Schedule` is imported in `client.ts` (it is used by `fetchSchedules`).

- [ ] **Step 3: The card**

```tsx
// dashboard/src/components/drawer/PatrolCard.tsx
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  fetchDeviceSettings, setSensorOverride, fetchMaps, startPatrol, stopPatrol,
  fetchPatrolRuns, fetchPatrolPhoto, fetchPatrolSchedule, savePatrolSchedule,
  type PatrolRunDto, type PatrolFrameDto,
} from '../../api/client';

/**
 * Night patrol: start/stop, the zones, the headlight, one nightly schedule and
 * the photos of the last run. Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
export function PatrolCard({ sn, phase, error }: { sn: string | null; phase?: string; error?: string }) {
  const { t, i18n } = useTranslation();
  const [zones, setZones] = useState<Array<{ slot: string; name: string }>>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [headlight, setHeadlight] = useState(true);
  const [runs, setRuns] = useState<PatrolRunDto[]>([]);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [time, setTime] = useState('23:30');
  const [nightly, setNightly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!sn) return;
    const [settings, maps, list, schedule] = await Promise.all([
      fetchDeviceSettings(sn), fetchMaps(sn), fetchPatrolRuns(sn), fetchPatrolSchedule(sn),
    ]);
    setZones(maps.maps
      .filter(m => m.mapType === 'work' && /^map\d+$/.test(m.canonicalName ?? ''))
      .map(m => ({ slot: m.canonicalName as string, name: m.mapName || (m.canonicalName as string) })));
    try { setChosen(JSON.parse(settings.patrol_zones ?? '[]')); } catch { setChosen([]); }
    setHeadlight((settings.patrol_headlight ?? '100') !== '0');
    setRuns(list);
    setScheduleId(schedule?.scheduleId ?? null);
    setTime(schedule?.startTime ?? '23:30');
    setNightly(schedule?.enabled ?? false);
  }, [sn]);

  // Reload on every phase change: a finished patrol brings new photos.
  useEffect(() => { reload().catch(e => setMessage(e instanceof Error ? e.message : String(e))); }, [reload, phase]);

  if (!sn) return null;
  const active = phase === 'patrolling' || phase === 'returning';
  const save = (fields: Record<string, string>) =>
    setSensorOverride(sn, fields).catch(() => setMessage(t('drawer.patrol.saveFailed')));

  const toggleZone = (slot: string) => {
    const next = chosen.includes(slot) ? chosen.filter(z => z !== slot) : [...chosen, slot];
    setChosen(next);
    void save({ patrol_zones: JSON.stringify(next) });
  };
  const toggleHeadlight = () => {
    const next = !headlight;
    setHeadlight(next);
    void save({ patrol_headlight: next ? '100' : '0' });
  };
  const saveSchedule = async (nextTime: string, nextOn: boolean) => {
    setTime(nextTime);
    setNightly(nextOn);
    try {
      await savePatrolSchedule(sn, nextTime, nextOn, scheduleId);
      await reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  const onStartStop = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (active) await stopPatrol(sn);
      else {
        const r = await startPatrol(sn);
        if (!r.ok) setMessage(r.error ?? t('drawer.patrol.startFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const phaseText = !phase || phase === 'idle' ? t('drawer.patrol.phase.idle')
    : phase === 'error' ? t('drawer.patrol.phase.error', { error: error || '?' })
    : t(`drawer.patrol.phase.${phase}`, phase);
  const last = runs[0];

  return (
    <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 mb-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-zinc-300">{t('drawer.patrol.title')}</h3>
        <button
          onClick={() => void onStartStop()}
          disabled={busy}
          className="text-[11px] px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white"
        >
          {active ? t('drawer.patrol.stop') : t('drawer.patrol.start')}
        </button>
      </div>
      <p className="text-[11px] text-zinc-400 mb-2">{phaseText}</p>
      {message && <p className="text-[11px] text-red-400 mb-2">{message}</p>}

      <div className="text-[11px] text-zinc-400 mb-1">{t('drawer.patrol.zones')}</div>
      <div className="flex flex-wrap gap-2 mb-1">
        {zones.map(z => (
          <label key={z.slot} className="flex items-center gap-1 text-[11px] text-zinc-300">
            <input type="checkbox" checked={chosen.includes(z.slot)} onChange={() => toggleZone(z.slot)} />
            {z.name}
          </label>
        ))}
      </div>
      <p className="text-[10px] text-zinc-500 mb-2">{t('drawer.patrol.zonesHint')}</p>

      <label className="flex items-center justify-between text-[11px] text-zinc-300 mb-2">
        {t('drawer.patrol.headlight')}
        <input type="checkbox" checked={headlight} onChange={toggleHeadlight} />
      </label>

      <div className="flex items-center justify-between text-[11px] text-zinc-300 mb-3">
        <span>{t('drawer.patrol.nightly')}</span>
        <span className="flex items-center gap-2">
          <input type="time" value={time} onChange={e => void saveSchedule(e.target.value, nightly)}
            className="bg-zinc-800 rounded px-1 text-zinc-200" />
          <input type="checkbox" checked={nightly} onChange={() => void saveSchedule(time, !nightly)} />
        </span>
      </div>

      {!last ? (
        <p className="text-[11px] text-zinc-500">{t('drawer.patrol.noRuns')}</p>
      ) : (
        <>
          <div className="text-[11px] text-zinc-400 mb-1">
            {t('drawer.patrol.lastRun', { date: new Date(last.startedAt).toLocaleString(i18n.language) })}
          </div>
          <div className="grid grid-cols-4 gap-1">
            {last.frames.map(f => (
              <div key={f.seq} className="text-[10px] text-zinc-400">
                <div className="aspect-[4/3] bg-zinc-800 rounded overflow-hidden mb-0.5">
                  {f.image && <PatrolPhoto sn={sn} run={last.run} seq={f.seq} />}
                </div>
                <span className={f.seen && f.seen.length ? 'text-amber-400' : ''}>{frameLabel(f, t)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function frameLabel(f: PatrolFrameDto, t: TFunction): string {
  if (f.seen === null) return t('drawer.patrol.noData');
  if (!f.seen.length) return t('drawer.patrol.nothingSeen');
  return f.seen.map(k => t(`drawer.patrol.${k}`)).join(', ');
}

function PatrolPhoto({ sn, run, seq }: { sn: string; run: string; seq: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    fetchPatrolPhoto(sn, run, seq)
      .then(u => { url = u; if (!cancelled) setSrc(u); })
      .catch(() => { /* no photo: the grey box stays */ });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [sn, run, seq]);
  return src ? <img src={src} alt="" className="w-full h-full object-cover" /> : null;
}
```

- [ ] **Step 4: Mount it and add the texts**

`dashboard/src/shell/DashboardShell.tsx`: add `import { PatrolCard } from '../components/drawer/PatrolCard';` and below `<DockDriftCard sn={activeMowerSn} />`:

```tsx
        <PatrolCard
          sn={activeMowerSn}
          phase={activeMower?.sensors.patrol_phase}
          error={activeMower?.sensors.patrol_error}
        />
```

In each locale file, inside the existing `"drawer"` object, add a `"patrol"` object:

`en.json`:
```json
"patrol": {
  "title": "Night patrol",
  "start": "Start patrol",
  "stop": "Stop",
  "phase": { "idle": "Ready", "patrolling": "On patrol", "returning": "Coming back", "done": "Back, docking", "error": "Stopped: {{error}}", "stopped": "Stopped" },
  "zones": "Zones",
  "zonesHint": "None ticked: only the dock's zone.",
  "headlight": "Headlight during the patrol",
  "nightly": "Every night at",
  "lastRun": "Last patrol ({{date}})",
  "noRuns": "No patrol yet.",
  "nothingSeen": "nothing seen",
  "noData": "no camera data",
  "person": "person",
  "animal": "animal",
  "startFailed": "Could not start the patrol",
  "saveFailed": "Could not save the patrol settings"
}
```

`nl.json`:
```json
"patrol": {
  "title": "Nachtpatrouille",
  "start": "Patrouille starten",
  "stop": "Stop",
  "phase": { "idle": "Klaar", "patrolling": "Op patrouille", "returning": "Komt terug", "done": "Terug, dockt", "error": "Gestopt: {{error}}", "stopped": "Gestopt" },
  "zones": "Zones",
  "zonesHint": "Niets aangevinkt: alleen de zone van het dock.",
  "headlight": "Koplamp tijdens de patrouille",
  "nightly": "Elke nacht om",
  "lastRun": "Laatste patrouille ({{date}})",
  "noRuns": "Nog geen patrouille.",
  "nothingSeen": "niets gezien",
  "noData": "geen camerabeeld",
  "person": "persoon",
  "animal": "dier",
  "startFailed": "Patrouille starten mislukt",
  "saveFailed": "Patrouille-instellingen opslaan mislukt"
}
```

`de.json`:
```json
"patrol": {
  "title": "Nachtpatrouille",
  "start": "Patrouille starten",
  "stop": "Stopp",
  "phase": { "idle": "Bereit", "patrolling": "Auf Patrouille", "returning": "Kommt zurück", "done": "Zurück, dockt an", "error": "Gestoppt: {{error}}", "stopped": "Gestoppt" },
  "zones": "Zonen",
  "zonesHint": "Nichts angehakt: nur die Zone der Ladestation.",
  "headlight": "Scheinwerfer während der Patrouille",
  "nightly": "Jede Nacht um",
  "lastRun": "Letzte Patrouille ({{date}})",
  "noRuns": "Noch keine Patrouille.",
  "nothingSeen": "nichts gesehen",
  "noData": "keine Kameradaten",
  "person": "Person",
  "animal": "Tier",
  "startFailed": "Patrouille konnte nicht gestartet werden",
  "saveFailed": "Patrouille-Einstellungen konnten nicht gespeichert werden"
}
```

`fr.json`:
```json
"patrol": {
  "title": "Patrouille de nuit",
  "start": "Lancer la patrouille",
  "stop": "Arrêter",
  "phase": { "idle": "Prête", "patrolling": "En patrouille", "returning": "Revient", "done": "De retour, se recharge", "error": "Arrêtée : {{error}}", "stopped": "Arrêtée" },
  "zones": "Zones",
  "zonesHint": "Rien de coché : seulement la zone de la station.",
  "headlight": "Phare pendant la patrouille",
  "nightly": "Chaque nuit à",
  "lastRun": "Dernière patrouille ({{date}})",
  "noRuns": "Pas encore de patrouille.",
  "nothingSeen": "rien vu",
  "noData": "pas d'image caméra",
  "person": "personne",
  "animal": "animal",
  "startFailed": "Impossible de lancer la patrouille",
  "saveFailed": "Impossible d'enregistrer les réglages de la patrouille"
}
```

Remove the now unused `controls.patrol` / `controls.stopPatrol` keys ("Edge patrol") from all four locale files (`grep -n '"stopPatrol"\|"patrol": "' dashboard/src/i18n/locales/*.json`).

- [ ] **Step 5: Typecheck and build**

Run: `cd dashboard && npx tsc -p tsconfig.app.json --noEmit && npm run build`
Expected: no type errors, build succeeds.

- [ ] **Step 6: Ramon tests in the browser, then commit**

Ramon opens the drawer on his own server with his mower, toggles a zone and the headlight, sets a time, and (with his OK, mower watched) starts and stops a patrol. Only after his OK:

```bash
git add dashboard/src/api/client.ts dashboard/src/components/drawer/PatrolCard.tsx dashboard/src/shell/DashboardShell.tsx dashboard/src/i18n/locales/en.json dashboard/src/i18n/locales/nl.json dashboard/src/i18n/locales/de.json dashboard/src/i18n/locales/fr.json
git commit -m "feat(dashboard): night patrol card"
```

### Task 12: App patrol section and push category

**Files:**
- Modify: `app/src/services/api.ts` (types and four methods in `ApiClient`)
- Create: `app/src/components/PatrolSection.tsx`
- Modify: `app/src/screens/CameraScreen.tsx` (render the section)
- Modify: `app/src/services/pushNotifications.ts` (`PushCategory`, `PUSH_CATEGORIES`), `app/src/screens/AppSettingsScreen.tsx` (`NOTIFY_ICON`)
- Modify: `app/src/i18n/{en,nl,de,fr}.ts`

**Interfaces:**
- Consumes: Task 9 routes; `getServerUrl()`; `useActiveMower()`; `useMowerState()` (sensors with `patrol_phase`, `patrol_error`).
- Produces: `ApiClient.startPatrol(sn)`, `ApiClient.stopPatrol(sn)`, `ApiClient.getPatrolRuns(sn)`, `ApiClient.patrolPhotoSource(sn, run, seq)`; component `PatrolSection({ sn, phase, error })`; push category `patrol`.

- [ ] **Step 1: Mockup for Ramon (get his OK before writing code)**

```
Camera tab, under the camera view:
┌ Night patrol ──────────── [ Start ] ┐
│ Ready                               │
│ Last patrol 14 Oct 23:30            │
│ [img][img][ -- ][img]  →  scroll    │
│ person nothing no-data animal       │
└─────────────────────────────────────┘
Settings → Notifications: new row "Patrol: people and animals at night"
```

- [ ] **Step 2: API methods**

In `app/src/services/api.ts`, next to the other exported interfaces:

```ts
export interface PatrolFrame {
  seq: number; x: number; y: number; person: number; animal: number; frames: number;
  image: boolean; ts: number; seen: Array<'person' | 'animal'> | null;
}
export interface PatrolRun { run: string; startedAt: number; frames: PatrolFrame[] }
```

and inside `class ApiClient`, after `startEdgeCuts`:

```ts
  async startPatrol(sn: string): Promise<{ ok: boolean; run?: string; error?: string }> {
    return this.request('POST', `/api/dashboard/patrol/${encodeURIComponent(sn)}`);
  }

  async stopPatrol(sn: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/api/dashboard/stop-patrol/${encodeURIComponent(sn)}`);
  }

  async getPatrolRuns(sn: string): Promise<{ ok: boolean; runs: PatrolRun[] }> {
    return this.request('GET', `/api/dashboard/patrol/${encodeURIComponent(sn)}/runs`);
  }

  /** Image source for one checkpoint photo, with the token for the external auth gate. */
  async patrolPhotoSource(sn: string, run: string, seq: number): Promise<{ uri: string; headers?: Record<string, string> }> {
    const token = tokenProvider ? await tokenProvider() : null;
    return {
      uri: `${this.baseUrl}/api/dashboard/patrol/${encodeURIComponent(sn)}/runs/${run}/${seq}.jpg`,
      headers: token ? { Authorization: token } : undefined,
    };
  }
```

- [ ] **Step 3: The section**

```tsx
// app/src/components/PatrolSection.tsx
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Image, ActivityIndicator } from 'react-native';
import { ApiClient, type PatrolRun, type PatrolFrame } from '../services/api';
import { getServerUrl } from '../services/auth';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';

/** Night patrol on the Camera tab: start/stop and the photos of the last run.
 *  Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md */
export function PatrolSection({ sn, phase, error }: { sn: string; phase?: string; error?: string }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const [api, setApi] = useState<ApiClient | null>(null);
  const [runs, setRuns] = useState<PatrolRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => { void getServerUrl().then(url => url && setApi(new ApiClient(url))); }, []);

  const reload = useCallback(async () => {
    if (!api) return;
    try { setRuns((await api.getPatrolRuns(sn)).runs ?? []); }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
  }, [api, sn]);
  useEffect(() => { void reload(); }, [reload, phase]);

  const active = phase === 'patrolling' || phase === 'returning';
  const onPress = async () => {
    if (!api) return;
    setBusy(true);
    setMessage(null);
    try {
      if (active) await api.stopPatrol(sn);
      else {
        const r = await api.startPatrol(sn);
        if (!r.ok) setMessage(r.error ?? t('patrol_start_failed'));
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t('patrol_start_failed'));
    } finally {
      setBusy(false);
    }
  };

  const phaseText = !phase || phase === 'idle' ? t('patrol_phase_idle')
    : phase === 'error' ? `${t('patrol_phase_error')}: ${error ?? '?'}`
    : t(`patrol_phase_${phase}`);
  const last = runs[0];

  return (
    <View style={{ margin: 12, padding: 12, borderRadius: 10, backgroundColor: colors.card }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ color: colors.text, fontWeight: '600' }}>{t('patrol_title')}</Text>
        <TouchableOpacity onPress={() => void onPress()} disabled={busy}
          style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.emerald }}>
          {busy ? <ActivityIndicator color="#fff" /> :
            <Text style={{ color: '#fff' }}>{active ? t('patrol_stop') : t('patrol_start')}</Text>}
        </TouchableOpacity>
      </View>
      <Text style={{ color: colors.textMuted, marginTop: 4 }}>{phaseText}</Text>
      {message && <Text style={{ color: colors.red, marginTop: 4 }}>{message}</Text>}
      {!last ? (
        <Text style={{ color: colors.textMuted, marginTop: 8 }}>{t('patrol_no_runs')}</Text>
      ) : (
        <>
          <Text style={{ color: colors.textMuted, marginTop: 8 }}>
            {t('patrol_last_run')} {new Date(last.startedAt).toLocaleString()}
          </Text>
          <ScrollView horizontal style={{ marginTop: 6 }}>
            {last.frames.map(f => (
              <View key={f.seq} style={{ width: 120, marginRight: 6 }}>
                {f.image && api ? <PatrolPhoto api={api} sn={sn} run={last.run} seq={f.seq} />
                  : <View style={{ width: 120, height: 90, borderRadius: 6, backgroundColor: colors.cardBorder }} />}
                <Text style={{ color: f.seen && f.seen.length ? colors.amber : colors.textMuted, fontSize: 12 }}>
                  {frameLabel(f, t)}
                </Text>
              </View>
            ))}
          </ScrollView>
        </>
      )}
    </View>
  );
}

function frameLabel(f: PatrolFrame, t: (k: string) => string): string {
  if (f.seen === null) return t('patrol_no_data');
  if (!f.seen.length) return t('patrol_nothing_seen');
  return f.seen.map(k => t(`patrol_${k}`)).join(', ');
}

function PatrolPhoto({ api, sn, run, seq }: { api: ApiClient; sn: string; run: string; seq: number }) {
  const [source, setSource] = useState<{ uri: string; headers?: Record<string, string> } | null>(null);
  useEffect(() => { void api.patrolPhotoSource(sn, run, seq).then(setSource); }, [api, sn, run, seq]);
  return source ? <Image source={source} style={{ width: 120, height: 90, borderRadius: 6 }} /> : null;
}
```

(The colors `card`, `text`, `textMuted`, `emerald`, `amber`, `red`, `cardBorder` exist in both palettes of `app/src/theme/colors.ts`.)

- [ ] **Step 4: Wire it in, push category, texts**

`app/src/screens/CameraScreen.tsx`: add `import { PatrolSection } from '../components/PatrolSection';`. The screen already returns early for stock firmware (`if (activeMower && !isOpenNovaFirmware(...))`), and it has `sn`, `sensors` and `isLandscape`. In the main `return (`, after the `{!isLandscape && mower?.online && streamUrl && ( ... infoBar ... )}` block and before the final closing `</View>`, add:

```tsx
      {!isLandscape && sn ? (
        <PatrolSection sn={sn} phase={sensors?.patrol_phase} error={sensors?.patrol_error} />
      ) : null}
```

`app/src/services/pushNotifications.ts`:

```ts
export type PushCategory = 'activity' | 'errors' | 'safety' | 'battery' | 'maintenance' | 'patrol';
export const PUSH_CATEGORIES: PushCategory[] = ['activity', 'errors', 'safety', 'battery', 'maintenance', 'patrol'];
```

`app/src/screens/AppSettingsScreen.tsx`, `NOTIFY_ICON`: add `patrol: 'moon-outline',`.

App texts (add next to `notify_maintenance_sub` in each file):

`en.ts`:
```ts
  notify_patrol: 'Night patrol',
  notify_patrol_sub: 'People and animals the patrol saw, a stopped patrol',
  patrol_title: 'Night patrol',
  patrol_start: 'Start',
  patrol_stop: 'Stop',
  patrol_phase_idle: 'Ready',
  patrol_phase_patrolling: 'On patrol',
  patrol_phase_returning: 'Coming back',
  patrol_phase_done: 'Back, docking',
  patrol_phase_stopped: 'Stopped',
  patrol_phase_error: 'Stopped',
  patrol_last_run: 'Last patrol',
  patrol_no_runs: 'No patrol yet.',
  patrol_nothing_seen: 'nothing seen',
  patrol_no_data: 'no camera data',
  patrol_person: 'person',
  patrol_animal: 'animal',
  patrol_start_failed: 'Could not start the patrol',
```

`nl.ts`:
```ts
  notify_patrol: 'Nachtpatrouille',
  notify_patrol_sub: 'Mensen en dieren die de patrouille zag, een gestopte patrouille',
  patrol_title: 'Nachtpatrouille',
  patrol_start: 'Start',
  patrol_stop: 'Stop',
  patrol_phase_idle: 'Klaar',
  patrol_phase_patrolling: 'Op patrouille',
  patrol_phase_returning: 'Komt terug',
  patrol_phase_done: 'Terug, dockt',
  patrol_phase_stopped: 'Gestopt',
  patrol_phase_error: 'Gestopt',
  patrol_last_run: 'Laatste patrouille',
  patrol_no_runs: 'Nog geen patrouille.',
  patrol_nothing_seen: 'niets gezien',
  patrol_no_data: 'geen camerabeeld',
  patrol_person: 'persoon',
  patrol_animal: 'dier',
  patrol_start_failed: 'Patrouille starten mislukt',
```

`de.ts`:
```ts
  notify_patrol: "Nachtpatrouille",
  notify_patrol_sub: "Menschen und Tiere, die die Patrouille sah, eine gestoppte Patrouille",
  patrol_title: "Nachtpatrouille",
  patrol_start: "Start",
  patrol_stop: "Stopp",
  patrol_phase_idle: "Bereit",
  patrol_phase_patrolling: "Auf Patrouille",
  patrol_phase_returning: "Kommt zurück",
  patrol_phase_done: "Zurück, dockt an",
  patrol_phase_stopped: "Gestoppt",
  patrol_phase_error: "Gestoppt",
  patrol_last_run: "Letzte Patrouille",
  patrol_no_runs: "Noch keine Patrouille.",
  patrol_nothing_seen: "nichts gesehen",
  patrol_no_data: "keine Kameradaten",
  patrol_person: "Person",
  patrol_animal: "Tier",
  patrol_start_failed: "Patrouille konnte nicht gestartet werden",
```

`fr.ts`:
```ts
  notify_patrol: "Patrouille de nuit",
  notify_patrol_sub: "Personnes et animaux vus par la patrouille, une patrouille arrêtée",
  patrol_title: "Patrouille de nuit",
  patrol_start: "Lancer",
  patrol_stop: "Arrêter",
  patrol_phase_idle: "Prête",
  patrol_phase_patrolling: "En patrouille",
  patrol_phase_returning: "Revient",
  patrol_phase_done: "De retour, se recharge",
  patrol_phase_stopped: "Arrêtée",
  patrol_phase_error: "Arrêtée",
  patrol_last_run: "Dernière patrouille",
  patrol_no_runs: "Pas encore de patrouille.",
  patrol_nothing_seen: "rien vu",
  patrol_no_data: "pas d'image caméra",
  patrol_person: "personne",
  patrol_animal: "animal",
  patrol_start_failed: "Impossible de lancer la patrouille",
```

- [ ] **Step 5: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: no type errors (if the i18n files are typed against `en.ts`, all four must have every key).

- [ ] **Step 6: Ramon tests in the app (Expo), then commit**

No APK build (only on "release app"). Ramon runs it in Expo against his server. After his OK:

```bash
git add app/src/services/api.ts app/src/components/PatrolSection.tsx app/src/screens/CameraScreen.tsx app/src/services/pushNotifications.ts app/src/screens/AppSettingsScreen.tsx app/src/i18n/en.ts app/src/i18n/nl.ts app/src/i18n/de.ts app/src/i18n/fr.ts
git commit -m "feat(app): night patrol on the camera tab and its push category"
```

---

## Phase 5: docs, leftovers, handover

### Task 13: Documentation and the release handover

**Files:**
- Modify: `docs/mqtt/navigation-commands.md` (the `start_patrol` section), `docs/mqtt/overview.md`, `docs/mqtt/mowing-commands.md`, `docs/firmware/lora-commands.md`, `docs/user-guide/opennova-app.md`, `docs/user-guide/troubleshooting.md`, `docs/user-guide/stock-vs-custom-firmware.md` (every place that calls `start_patrol` edge cutting)
- Modify: `docs/user-guide/dashboard.md` (new section "Night patrol")
- Modify: `research/documents/robot_decision_reverse_engineering.md`, `research/documents/edge-cut-flow.md`, `docs/firmware/ai-perception.md` (corrections found during the survey)
- Modify: `app/src/screens/HomeScreen.tsx` (stale comments mentioning patrol as edge cut, around lines 3020-3196; comments only)

- [ ] **Step 1: Correct the patrol mislabels**

In every file listed above, replace the claim that `start_patrol` / `stop_patrol` is edge cutting or boundary patrol with: "`start_patrol` / `stop_patrol` are stubs in stock mqtt_node (they only answer). OpenNova's night patrol is the extended command `patrol`; see docs/superpowers/specs/2026-10-14-night-patrol-design.md." Find them with:

```bash
grep -rn -i "patrol" docs/mqtt docs/firmware docs/user-guide app/src/screens/HomeScreen.tsx | grep -v night
```

- [ ] **Step 2: Corrections from the firmware survey**

- `research/documents/robot_decision_reverse_engineering.md`: the "Task Modes" table (FREE…STOP) is the `merged_work_status` enum; `PATROLLING` is task type 3, only a name in `robot_status::TaskTypeString`, never set.
- `research/documents/edge-cut-flow.md:153`: the stub addresses are `0x2c2db8` / `0x2c32b8`.
- `docs/firmware/ai-perception.md`: `/perception/pedestrian_detect` is advertised but never published (its publisher functions have no callers); detections reach other nodes only as labels 100+ in `/perception/points_labeled`.

- [ ] **Step 3: User guide section**

Add to `docs/user-guide/dashboard.md` a section "Night patrol" (plain English, no em-dashes): what it does; that it needs custom firmware 50 or newer; the drawer card (zones, headlight, nightly time); that the blades never turn and it docks like after mowing; that photos of the last 10 patrols are kept on your own server; that "no camera data" means the camera saw nothing usable, not that the garden was empty; that it drives at night, so keep the garden clear and know that hedgehogs are treated as obstacles.

- [ ] **Step 4: Commit**

```bash
git add docs/mqtt docs/firmware docs/user-guide research/documents/robot_decision_reverse_engineering.md research/documents/edge-cut-flow.md app/src/screens/HomeScreen.tsx
git commit -m "docs: night patrol, and start_patrol is a stub, not edge cutting"
```

- [ ] **Step 5: Handover to Ramon (no release without his request)**

Report to Ramon:
- which commits exist, and that `PATROL_MIN_BUILD` is 50;
- that the firmware part (Tasks 1 to 4) only reaches a mower with a new custom build (`./research/build_custom_firmware.sh`, his call), and the server part with a server release (`./release.sh`, his call);
- the first full night test to run after both: start a patrol from the dashboard with Ramon present, check headlight on/off, the blades, the photos in the card, one push notification with a person walking past, and the docking at the end.
