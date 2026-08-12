# mow_zone Unicom-Transit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A normal "Start Mowing" for any zone drives the recorded map-to-map unicom exactly through the passage (never the hedge), then runs the normal coverage, shown in the app as a "following unicom" state with a Novabot map-to-map animation.

**Architecture:** One mower-side orchestrator extended-command `mow_zone` sequences undock (`_depart_pile`) -> `follow_unicom` (if a transit is needed) -> coverage via the `/robot_decision/start_cov_task` service, streaming phase status back on the extended_response channel. The app sends `mow_zone` instead of `start_navigation` and renders a new `following_unicom` activity + animation from the streamed phase.

**Tech Stack:** Python (mower `research/extended_commands.py`, ROS 2 Galactic via `ros2` CLic), TypeScript/React Native (app), vitest (server/app tests), pytest-free Python `assert` self-checks (no test framework on the mower).

## Global Constraints

- Mower scripts are edited LOCAL-FIRST in `research/extended_commands.py`, then scp'd to `/root/novabot/scripts/extended_commands.py` and restarted via `/root/start_ext.sh` (never bare python3). Deploy target SN `LFIN2230700238` at `192.168.0.244` (`sshpass -p novabot ssh root@192.168.0.244`).
- DO NOT COMMIT anything until the user explicitly says so. Every "Commit" step below is staged but HELD; run `git add` only, no `git commit`, until the user green-lights.
- No em-dashes in any prose or code comments.
- ALWAYS Dutch to the user; code/comments/docs in English.
- Movement on the mower requires explicit user confirmation before the FIRST run of each new movement path (safety). Live steps below are gated on that.
- The `follow_unicom` controller relaxation must ALWAYS restore defaults (max_allowed_time_to_collision 0.8, movement_time_allowance 12.0, required_movement_radius 0.2, desired_linear_vel 0.5) via the `finally` block.
- Coverage MUST run through `/robot_decision/start_cov_task` (not a direct NTCP call), so robot_decision keeps the work_status state machine + auto-recharge.

---

## File Structure

- `research/extended_commands.py` (modify): add `_follow_unicom(from_slot, to_slot)` refactor, `_current_zone_slot()`, `_start_cov_task(...)`, `handle_mow_zone`; register `mow_zone` in `COMMANDS`.
- `research/__tests__/test_extended_helpers.py` (create): standalone `assert`-based self-check for the pure helpers (path orientation, zone detection, blade mapping), runnable with `python3`.
- `app/src/screens/HomeScreen.tsx` (modify): `following_unicom` activity in `deriveMower`, render branch, consume `mow_zone_status`.
- `app/src/components/StartMowSheet.tsx` (modify): send `mow_zone` instead of `start_navigation`.
- `app/src/components/UnicomTransitAnimation.tsx` (create): the Novabot map-to-map animation component.
- `app/src/context/DemoContext.tsx` (modify): a demo `mow_zone_status` stream so the animation renders without a mower.
- `app/src/services/api.ts` (modify): typed `mowZone(sn, payload)` helper (posts to the generic extended endpoint).

---

## Task 1: Refactor follow_unicom core into a reusable `_follow_unicom`

**Files:**
- Modify: `research/extended_commands.py` (the body of `handle_follow_unicom`)
- Test: `research/__tests__/test_extended_helpers.py`

**Interfaces:**
- Produces: `_follow_unicom(from_slot: str, to_slot: str, dry_run: bool=False) -> dict` returning `{"result":0,"points":N,"oriented":str,"path":[[x,y],...]}` or `{"result":1,"error":str}`. It does NOT call `respond`; callers do. `handle_follow_unicom` becomes a thin wrapper that calls it and responds.

- [ ] **Step 1: Write the failing self-check** (append to `research/__tests__/test_extended_helpers.py`)

```python
# Run: python3 research/__tests__/test_extended_helpers.py
import importlib.util, os
spec = importlib.util.spec_from_file_location("ec", os.path.join(os.path.dirname(__file__), "..", "extended_commands.py"))
# NOTE: importing ec starts nothing (guarded by __name__=="__main__"). Monkeypatch the
# mower-only pieces the pure path builder does not need.
ec = importlib.util.module_from_spec(spec); spec.loader.exec_module(ec)

def test_orient_dock_to_map3(tmp_csv_dir):
    # tmp_csv_dir has map0tomap3_0_unicom.csv (ordered map3->dock) + map3_work.csv
    r = ec._follow_unicom("map0", "map3", dry_run=True)  # uses the real csv_dir path; see fixture note
    assert r["result"] == 0
    assert r["oriented"] == "reversed"          # dock end must be first
    assert r["path"][0][1] < r["path"][-1][1]   # y increases dock(0.8) -> map3(6.2)
```

Note: the mower CSVs live at `/userdata/lfi/maps/home0/x3_csv_file/`. For the local self-check, `_follow_unicom` reads `csv_dir` from a module-level `MAPS_HOME` constant (default `/userdata/lfi/maps/home0`); the test sets `ec.MAPS_HOME = <fixture dir>` before calling. Add that constant in Step 3.

- [ ] **Step 2: Run to verify it fails**

Run: `python3 research/__tests__/test_extended_helpers.py`
Expected: FAIL with `AttributeError: module 'ec' has no attribute '_follow_unicom'`.

- [ ] **Step 3: Extract `_follow_unicom`**

Move the CSV-find + orient + path-build + relax-controller + `/follow_path` dispatch logic out of `handle_follow_unicom` into a new module-level `def _follow_unicom(from_slot, to_slot, dry_run=False)`. Add `MAPS_HOME = "/userdata/lfi/maps/home0"` near the other constants and use `csv_dir = f"{MAPS_HOME}/x3_csv_file" if os.path.isdir(...) else f"{MAPS_HOME}/csv_file"`. Return the dict shown in Interfaces instead of calling `respond`. Keep the existing dry_run early-return returning the `path`. `handle_follow_unicom` becomes:

```python
def handle_follow_unicom(params, respond):
    r = _follow_unicom(str(params.get("from", "map0")), str(params.get("to", "")),
                       dry_run=bool(params.get("dry_run", False)))
    respond("follow_unicom_respond", r)
```

- [ ] **Step 4: Run to verify it passes**

Run: `python3 research/__tests__/test_extended_helpers.py`
Expected: PASS.

- [ ] **Step 5: Verify no regression on the mower** (deploy + on-mower dry-run)

```bash
python3 -m py_compile research/extended_commands.py
sshpass -p novabot scp research/extended_commands.py root@192.168.0.244:/root/novabot/scripts/extended_commands.py
sshpass -p novabot ssh root@192.168.0.244 'for p in $(ps -eo pid,args | grep "[p]ython3 /root/novabot/scripts/extended_commands.py" | awk "{print \$1}"); do kill -9 $p; done; sleep 3; nohup setsid /root/start_ext.sh >> /tmp/ext_follow.log 2>&1 & disown'
# trigger dry-run via the generic endpoint, expect 45 pts oriented=reversed in /tmp/ext_follow.log
```

- [ ] **Step 6: Stage (HELD, no commit)**

```bash
git add research/extended_commands.py research/__tests__/test_extended_helpers.py
# DO NOT git commit until the user says so.
```

---

## Task 2: `_current_zone_slot` (from-zone detection)

**Files:**
- Modify: `research/extended_commands.py`
- Test: `research/__tests__/test_extended_helpers.py`

**Interfaces:**
- Produces: `_current_zone_slot(robot_xy: tuple|None) -> str`. Returns `"mapN"` for the first `mapN_work.csv` polygon that contains `robot_xy`, else `"dock"` when `robot_xy` is None or inside the dock disc (within 1.2 m of origin), else `"dock"` as the safe default. Reuses `read_xy_csv` and a local point-in-polygon.

- [ ] **Step 1: Write the failing self-check**

```python
def test_zone_detection():
    assert ec._current_zone_slot(None) == "dock"
    assert ec._current_zone_slot((0.0, 0.5)) == "dock"          # on dock disc
    assert ec._current_zone_slot((-17.0, 8.0)) == "map3"        # inside map3 polygon (fixture)
    assert ec._current_zone_slot((2.0, 3.0)) == "map0"          # inside map0
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 research/__tests__/test_extended_helpers.py`
Expected: FAIL `AttributeError: ... '_current_zone_slot'`.

- [ ] **Step 3: Implement**

```python
def _point_in_poly(x, y, poly):
    n = len(poly); inside = False; j = n - 1
    for i in range(n):
        xi, yi = poly[i]; xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside

def _current_zone_slot(robot_xy):
    if robot_xy is None:
        return "dock"
    x, y = robot_xy
    if (x * x + y * y) <= 1.2 ** 2:          # dock disc
        return "dock"
    base = f"{MAPS_HOME}/x3_csv_file" if os.path.isdir(f"{MAPS_HOME}/x3_csv_file") else f"{MAPS_HOME}/csv_file"
    for f in sorted(os.listdir(base)):
        m = re.match(r"^(map\d+)_work\.csv$", f)
        if not m:
            continue
        poly = read_xy_csv(os.path.join(base, f))
        if len(poly) >= 3 and _point_in_poly(x, y, poly):
            return m.group(1)
    return "dock"
```

- [ ] **Step 4: Run to verify it passes**

Run: `python3 research/__tests__/test_extended_helpers.py`
Expected: PASS.

- [ ] **Step 5: Stage (HELD)**

```bash
git add research/extended_commands.py research/__tests__/test_extended_helpers.py
```

---

## Task 3: `_start_cov_task` (coverage injection via robot_decision service)

**Files:**
- Modify: `research/extended_commands.py`
- Test: `research/__tests__/test_extended_helpers.py` (pure request-YAML builder only)

**Interfaces:**
- Produces: `_cov_task_yaml(map_slot: str, cutterhigh: int, direction: int|None) -> str` (pure, testable) building the `decision_msgs/srv/StartCoverageTask` request YAML; and `_start_cov_task(map_slot, cutterhigh, direction)` which `ros2 service call /robot_decision/start_cov_task decision_msgs/srv/StartCoverageTask <yaml>` in the shared DDS env and returns bool result.

Service fields (from `ros2 interface show decision_msgs/srv/StartCoverageTask`): `cov_mode` (1 = SPECIFIED_AREA, we mow a named map), `request_type` (11 = normal mqtt/app start), `map_names` (`["mapN"]`), `blade_heights` (`[cutterhigh]`, the 0..7 wire enum = user_cm-2), `specify_direction`+`cov_direction` (0..180) when a direction is given, `specify_perception_level` false (keep device setting).

- [ ] **Step 1: Write the failing self-check**

```python
def test_cov_task_yaml():
    y = ec._cov_task_yaml("map3", 2, 90)
    assert "cov_mode: 1" in y and "request_type: 11" in y
    assert "map_names: [map3]" in y or 'map_names: ["map3"]' in y
    assert "blade_heights: [2]" in y
    assert "specify_direction: true" in y and "cov_direction: 90" in y
    y2 = ec._cov_task_yaml("map0", 3, None)
    assert "specify_direction: false" in y2
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 research/__tests__/test_extended_helpers.py`
Expected: FAIL `... '_cov_task_yaml'`.

- [ ] **Step 3: Implement**

```python
def _cov_task_yaml(map_slot, cutterhigh, direction):
    d = "true" if direction is not None else "false"
    cd = int(direction) if direction is not None else 0
    return ("'{"
            "cov_mode: 1, request_type: 11, map_ids: 0, "
            f"map_names: [{map_slot}], polygon_area: [], "
            f"blade_heights: [{int(cutterhigh)}], "
            f"specify_direction: {d}, cov_direction: {cd}, light: 0, "
            "specify_perception_level: false, perception_level: 0, "
            "blade_info_level: 0, night_light: false, "
            "enable_loc_weak_mapping: false, enable_loc_weak_working: false"
            "}'")

def _start_cov_task(map_slot, cutterhigh, direction):
    cmd = ("source /opt/ros/galactic/setup.bash && "
           "source /root/novabot/install/setup.bash 2>/dev/null && "
           "timeout 20 ros2 service call /robot_decision/start_cov_task "
           "decision_msgs/srv/StartCoverageTask " + _cov_task_yaml(map_slot, cutterhigh, direction))
    try:
        out = subprocess.run(["bash", "-c", cmd], env=_ros_env(),
                             capture_output=True, text=True, timeout=30).stdout
    except Exception as e:
        log(f"start_cov_task error: {e}"); return False
    return "result=True" in out or "result: true" in out.lower()
```

- [ ] **Step 4: Run to verify it passes**

Run: `python3 research/__tests__/test_extended_helpers.py`
Expected: PASS.

- [ ] **Step 5: Stage (HELD)**

```bash
git add research/extended_commands.py research/__tests__/test_extended_helpers.py
```

---

## Task 4: `handle_mow_zone` orchestrator + register in COMMANDS

**Files:**
- Modify: `research/extended_commands.py`

**Interfaces:**
- Consumes: `_depart_pile`, `_robot_map_xy`, `_current_zone_slot`, `_follow_unicom`, `_start_cov_task`, `read_xy_csv`, `_point_in_poly`.
- Produces: `mow_zone` command. Streams `respond("mow_zone_status", {"phase": ..., "map": to_slot})` for `undocking | following_unicom | covering | done | error`.

- [ ] **Step 1: Implement `handle_mow_zone`** (no unit test; validated live in Step 3 and via app in Task 6)

```python
def handle_mow_zone(params, respond):
    """Orchestrate a normal mow: undock -> (follow_unicom if a transit is needed)
    -> coverage via /robot_decision/start_cov_task. Streams phase status so the
    app can show the following_unicom animation. Params: map (e.g. 'map3'),
    cutterhigh (0..7 wire enum), direction (0..180 or null)."""
    to_slot = str(params.get("map", ""))
    if not re.fullmatch(r"map\d+", to_slot):
        respond("mow_zone_status", {"phase": "error", "error": "invalid_map"}); return
    cutterhigh = int(params.get("cutterhigh", 2))
    direction = params.get("direction", None)

    def _run():
        try:
            robot = _robot_map_xy()
            from_slot = _current_zone_slot(robot)
            # 1. undock if on the pile
            if from_slot == "dock":
                respond("mow_zone_status", {"phase": "undocking", "map": to_slot})
                _depart_pile()
                robot = _robot_map_xy()
                from_slot = _current_zone_slot(robot)
            # 2. transit if a unicom exists and we are not already inside the target
            already_in = False
            base = f"{MAPS_HOME}/x3_csv_file" if os.path.isdir(f"{MAPS_HOME}/x3_csv_file") else f"{MAPS_HOME}/csv_file"
            tp = read_xy_csv(os.path.join(base, f"{to_slot}_work.csv"))
            if robot and len(tp) >= 3:
                already_in = _point_in_poly(robot[0], robot[1], tp)
            uni = [f for f in os.listdir(base) if re.match(rf"^{from_slot}to{to_slot}_\d+_unicom\.csv$", f)]
            if uni and not already_in:
                respond("mow_zone_status", {"phase": "following_unicom", "map": to_slot})
                r = _follow_unicom(from_slot, to_slot, dry_run=False)
                if r.get("result") != 0:
                    respond("mow_zone_status", {"phase": "error", "map": to_slot, "error": r.get("error", "follow_unicom_failed")}); return
                _wait_follow_path_done(timeout_s=600)   # blocks until /follow_path idle again
            # 3. coverage through robot_decision (normal state machine)
            respond("mow_zone_status", {"phase": "covering", "map": to_slot})
            ok = _start_cov_task(to_slot, cutterhigh, direction)
            respond("mow_zone_status", {"phase": "done" if ok else "error", "map": to_slot})
        except Exception as e:
            log(f"mow_zone error: {e}")
            respond("mow_zone_status", {"phase": "error", "map": to_slot, "error": str(e)})

    threading.Thread(target=_run, daemon=True, name="mow-zone").start()
    respond("mow_zone_respond", {"result": 0, "map": to_slot})
```

Also add `_wait_follow_path_done(timeout_s)`: poll `ros2 action list`/the running `ros2 action send_goal` PID until the FollowPath client exits (the `_follow_unicom` dispatch runs in its own thread and returns immediately; the orchestrator must wait for it to actually finish before starting coverage). Simplest: have `_follow_unicom(dry_run=False)` return the dispatched `subprocess`/thread handle and `join()` it. Adjust the Task 1 interface so `_follow_unicom` in non-dry-run returns `{"result":0,...,"join": <callable>}` and `handle_mow_zone` calls `r["join"]()` instead of a separate `_wait_follow_path_done`. (Pick this join-callable approach; drop `_wait_follow_path_done`.)

- [ ] **Step 2: Register in COMMANDS**

```python
    "follow_unicom": handle_follow_unicom,
    "mow_zone": handle_mow_zone,
    "stop_boundary_follow": handle_stop_boundary_follow,
```

- [ ] **Step 3: Deploy + LIVE staged test on .244** (explicit user go before each first movement)

```
# a) dry-ish: mower already off-dock in map0 -> {mow_zone:{map:"map3",cutterhigh:2}}; expect
#    phases undocking(skip) -> following_unicom -> covering, robot reaches map3 + mows, no hedge.
# b) from the dock: {mow_zone:{map:"map3",cutterhigh:2}}; expect undocking -> following_unicom
#    -> covering. Watch /tmp/ext_follow.log phases + nav2 "Reached the goal!" + robot_decision COVERING.
```

- [ ] **Step 4: Stage (HELD)**

```bash
git add research/extended_commands.py
```

---

## Task 5: App `mowZone` api + StartMowSheet sends `mow_zone`

**Files:**
- Modify: `app/src/services/api.ts`, `app/src/components/StartMowSheet.tsx`

**Interfaces:**
- Consumes: the generic extended endpoint `POST /api/dashboard/extended/:sn`.
- Produces: `api.mowZone(sn, { map, cutterhigh, area, direction })`. StartMowSheet calls it instead of `start_navigation`.

- [ ] **Step 1: Add `mowZone` to api.ts** (mirror `sendExtended`)

```ts
async mowZone(sn: string, payload: { map: string; cutterhigh: number; area?: number; direction?: number | null }): Promise<{ ok: boolean }> {
  return this.request('POST', `/api/dashboard/extended/${enc(sn)}`, { body: { mow_zone: payload } });
}
```

- [ ] **Step 2: Switch StartMowSheet to `mow_zone`**

In `app/src/components/StartMowSheet.tsx` replace the `start_navigation` send (around line 434) with:

```ts
const mapSlot = selectedMap?.canonicalName ?? selectedMap?.mapName ?? 'map0';
const navResult = await api.mowZone(sn, { map: mapSlot, cutterhigh: wireHeight, area: areaParam, direction: pathDirection ?? null });
```

Keep the `start_run` fallback removed (the orchestrator owns coverage now); if `mowZone` fails, surface an error toast (existing pattern) rather than a raw start.

- [ ] **Step 3: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Stage (HELD)**

```bash
git add app/src/services/api.ts app/src/components/StartMowSheet.tsx
```

---

## Task 6: App `following_unicom` activity + animation

**Files:**
- Create: `app/src/components/UnicomTransitAnimation.tsx`
- Modify: `app/src/screens/HomeScreen.tsx`, `app/src/context/DemoContext.tsx`

**Interfaces:**
- Consumes: `mow_zone_status.phase` from the mower state (added to the sensor/status stream the app already reads via socket; the server relays extended_response, see note).
- Produces: `MowerActivity` gains `'following_unicom'`; `UnicomTransitAnimation` component.

Note on the state source: `mow_zone_status` arrives on the extended_response channel. The server already relays extended responses to the app socket. Add a small server passthrough only if the app does not already receive extended_response events (verify: `grep -rn "extended_response\|mow_zone_status" server/src app/src`). If a passthrough is needed it is a one-liner in the socket handler; include it in this task.

- [ ] **Step 1: Build the animation component** (Reanimated SVG loop, Novabot colors)

```tsx
// app/src/components/UnicomTransitAnimation.tsx
// Two rounded zone blobs (emerald) with a dashed connector; the mower silhouette
// (reuse MOWER_SVG_PATH from HomeScreen or components/mower) loops A -> B along the
// dashes. ~2s loop, respects light/dark. No Segway assets.
```

- [ ] **Step 2: Add the activity + render branch to HomeScreen**

Add `'following_unicom'` to the `MowerActivity` union. In `deriveMower`, read the latest `mow_zone_status.phase` (threaded through mower state); when `phase === 'following_unicom'` set `activity = 'following_unicom'` (highest priority after error/edge_cut, before generic mowing). Render `UnicomTransitAnimation` + copy `t('followingUnicom', { zone })` in that state. Add the `followingUnicom` key to the app i18n files.

- [ ] **Step 3: Demo stream for visual test**

In `DemoContext.tsx` add a scripted `mow_zone_status` sequence (undocking -> following_unicom -> covering -> done over ~8s) so the state + animation can be seen in demo mode without a mower.

- [ ] **Step 4: Typecheck + manual visual check (Expo)**

Run: `cd app && npx tsc --noEmit` (expect 0). Then Expo hot-reload, demo mode, confirm the animation + copy render and clear on `done`.

- [ ] **Step 5: Stage (HELD)**

```bash
git add app/src/components/UnicomTransitAnimation.tsx app/src/screens/HomeScreen.tsx app/src/context/DemoContext.tsx app/src/i18n/locales/*.json
```

---

## Task 7: End-to-end live validation + docs

- [ ] **Step 1: Full flow on .244** (user watching, explicit go): app Start Mowing on map3 from the dock -> app shows undocking -> following_unicom (animation) -> covering; mower drives the gap and mows map3 with no hedge, no Error 124/125/127; controller params restored afterwards (`ros2 param get ... max_allowed_time_to_collision` == 0.8).
- [ ] **Step 2: Regression** the non-unicom case: Start Mowing on map0 (no transit) -> undocking -> covering (following_unicom skipped), mows normally.
- [ ] **Step 3: Update `research/documents/unicom-follow-transit-design.md`** with the shipped `mow_zone` flow + the `/robot_decision/start_cov_task` field mapping, and bd `Novabot-aaj` notes. Update the auto-memory index if a new memory is warranted.
- [ ] **Step 4: Stage everything (HELD).** Present the full staged diff to the user and wait for the explicit commit + release go.

---

## Self-Review notes

- Spec coverage: undock (Task 4/_depart_pile), follow_unicom-in-flow (Task 1+4), coverage via start_cov_task (Task 3+4), trigger detection (Task 2+4), phase streaming (Task 4), app state+animation (Task 6), error handling + param restore (Task 4 + Global Constraints), testing (Tasks 1-3 self-checks + 4/6/7 live/visual). All spec sections mapped.
- Both spikes resolved before planning: coverage injection = `/robot_decision/start_cov_task` (decision_msgs/srv/StartCoverageTask); from-zone = point-in-polygon (`_current_zone_slot`).
- Type consistency: `_follow_unicom(from_slot, to_slot, dry_run)` returns a dict with `result/points/oriented/path` and, in non-dry-run, a `join` callable (Task 1 note + Task 4 use). `_cov_task_yaml`/`_start_cov_task`/`_current_zone_slot`/`_point_in_poly` names are used identically in Tasks 2-4.
