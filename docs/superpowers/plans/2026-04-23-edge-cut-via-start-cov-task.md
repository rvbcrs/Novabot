# Edge Cut via `/robot_decision/start_cov_task` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the currently broken direct `/boundary_follow` action dispatch with a new extended MQTT command `start_edge_cut` that calls `/robot_decision/start_cov_task` (StartCoverageTask, `cov_mode: 2` BOUNDARY_COV) so `robot_decision` orchestrates map load + working-zone validation + action dispatch.

**Architecture:** A new Python handler in `research/extended_commands.py` executes a blocking `ros2 service call` to the stock `robot_decision` service. The app's Edge Cut button sends this extended command instead of the existing (broken) `start_boundary_follow`. The stop path (`stop_boundary_follow` → `cover_task_stop`) is unchanged.

**Tech Stack:** Python 3 (mower, Galactic-ROS env), TypeScript/React Native (app), ROS 2 Galactic, CycloneDDS shared-memory config, MQTT.

**Testing note:** Firmware is Python on the mower with no unit-test harness, and the app has no E2E harness for this flow. Verification is live-only against LFIN1231000211 per the spec's Testing section.

**Spec:** `docs/superpowers/specs/2026-04-23-edge-cut-via-start-cov-task-design.md`

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `research/extended_commands.py` | Modify (add handler, drop old handler, update `COMMANDS` dict) | MQTT→ROS2 bridge on the mower; single-responsibility handler per extended command |
| `app/src/screens/HomeScreen.tsx` | Modify (edge-cut `sendExtended` payload around line 1935) | App UI dispatch for Edge Cut button |

No server changes. No new files.

Note on the handler-registry name: the dict in `extended_commands.py` is called `COMMANDS` (line 1689), not `EXTENDED_COMMAND_HANDLERS` (spec typo). Use `COMMANDS`.

Note on blade-height encoding: the existing `start_boundary_follow` path used a chassis-inverted index `9 - heightCm` that feeds `/blade_height_set` directly through the `BoundaryFollow` action. `StartCoverageTask.blade_heights` uses the stock encoding where `mm = (level + 2) * 10`, i.e. `level = userCm − 2`. The existing HomeScreen block already computes this as `wire = Math.max(0, heightCm − 2)` for the `set_para_info` pre-call — reuse `wire` for the new payload. Do **not** reuse `bladeIdx` (`9 - heightCm`) — that is a different encoding and produces the wrong physical height.

---

## Task 1: Add `handle_start_edge_cut` to firmware

**Files:**
- Modify: `research/extended_commands.py` (insert new handler near the other boundary handlers, around line 1075)

- [ ] **Step 1: Read existing helpers and handler style**

Read `research/extended_commands.py` lines 869-1075 to confirm the exact signatures and patterns of `_clear_costmaps()`, `_kill_ros2_action_clients()`, `_call_cover_task_stop()`, and `handle_start_boundary_follow()`. The new handler reuses the first three helpers and mirrors the subprocess/env style of `_call_cover_task_stop`.

- [ ] **Step 2: Insert new handler just after `handle_start_boundary_follow`**

Add the following function immediately after the closing block of `handle_start_boundary_follow` (around line 1076, before `def handle_recalibrate_charging_pose`). Use an `Edit` with a unique anchor like the `handle_recalibrate_charging_pose` signature line.

```python
def handle_start_edge_cut(params, respond):
    """Start real edge-cutting via the stock orchestrator.

    Calls `/robot_decision/start_cov_task` (decision_msgs/srv/StartCoverageTask)
    with `cov_mode: 2` (BOUNDARY_COV). robot_decision then:
      1. Loads the work map via `/decision_assistant/load_map "/map.yaml"`.
      2. Validates the robot is inside the polygon ("working zone").
      3. Dispatches the `coverage_planner/action/BoundaryFollow` action with
         a fully populated coverage_planner context.

    This replaces the earlier direct `/boundary_follow` dispatch which failed
    with NO_VALID_BOUNDARY because the coverage_planner_server had no map
    loaded.

    Params (all optional):
      mapName:      default "map0_work"
      bladeHeight:  wire value 0..7 (userCm − 2), default 3 (= 50 mm)
      light:        0..255, default 0

    Response:
      success → {result: 0, cov_mode: 2, map: <name>, blade: <h>}
      failure → {result: 1, error: <class>, detail: <stdout tail>}

    The service call is blocking with a 15 s timeout so the MQTT reply
    reflects service-level success/failure. The BOUNDARY_COVERING loop
    runs inside robot_decision after the service returns, independent of
    the MQTT round-trip.
    """
    # Defensive prelude — same cleanup the direct-action path used.
    _kill_ros2_action_clients()
    _call_cover_task_stop()
    _clear_costmaps()

    try:
        map_name = str((params or {}).get("mapName", "map0_work"))
        blade = int((params or {}).get("bladeHeight", 3))
        if blade < 0: blade = 0
        if blade > 7: blade = 7
        light = int((params or {}).get("light", 0))
        if light < 0: light = 0
        if light > 255: light = 255
    except (TypeError, ValueError) as e:
        respond("start_edge_cut_respond", {"result": 1, "error": f"param type error: {e}"})
        return

    # YAML goal for decision_msgs/srv/StartCoverageTask. Bash single-quoting
    # keeps the braces and array literals intact on the ros2 CLI.
    req_yaml = (
        "'{"
        "cov_mode: 2, "
        "request_type: 11, "
        f"map_names: [\"{map_name}\"], "
        f"blade_heights: [{blade}], "
        f"light: {light}, "
        "specify_perception_level: false, "
        "perception_level: 0, "
        "blade_info_level: 0, "
        "night_light: false, "
        "enable_loc_weak_mapping: false, "
        "enable_loc_weak_working: false, "
        "specify_direction: false, "
        "cov_direction: 0, "
        "map_ids: 0"
        "}'"
    )

    cmd = (
        "source /opt/ros/galactic/setup.bash && "
        "source /root/novabot/install/setup.bash 2>/dev/null && "
        "timeout 15 ros2 service call /robot_decision/start_cov_task "
        "decision_msgs/srv/StartCoverageTask " + req_yaml +
        " 2>&1 | tee -a /tmp/edge_cut.log"
    )

    # Match the DDS transport used by the running ROS nodes — without the
    # shared-memory CYCLONEDDS_URI the CLI client can't discover
    # /robot_decision/start_cov_task.
    env = {
        **os.environ,
        "ROS_DOMAIN_ID": "0",
        "ROS_LOCALHOST_ONLY": "1",
        "RMW_IMPLEMENTATION": "rmw_cyclonedds_cpp",
        "CYCLONEDDS_URI": "file:///root/novabot/shm_config/shm_cyclonedds.xml",
    }

    try:
        proc = subprocess.run(
            ["bash", "-c", cmd], env=env,
            capture_output=True, text=True, timeout=20,
        )
        out = (proc.stdout or "") + (proc.stderr or "")
    except subprocess.TimeoutExpired:
        log("start_edge_cut: ros2 service call timed out")
        respond("start_edge_cut_respond", {"result": 1, "error": "service_timeout"})
        return
    except Exception as e:
        log(f"start_edge_cut subprocess error: {e}")
        respond("start_edge_cut_respond", {"result": 1, "error": f"subprocess: {e}"})
        return

    tail = out[-400:] if len(out) > 400 else out
    log(f"start_edge_cut out: {tail}")

    # ros2 service call prints either "response:\n  ... result=True" on
    # success or "result=False" on service-level failure. We classify the
    # common failure modes so the app can show a useful toast.
    lowered = out.lower()
    if "result=true" in lowered:
        respond("start_edge_cut_respond", {
            "result": 0,
            "cov_mode": 2,
            "map": map_name,
            "blade": blade,
        })
    elif "result=false" in lowered:
        if "working zone" in lowered or "not in mapping" in lowered:
            err = "robot_outside_zone"
        elif "load map" in lowered or "error_load_map" in lowered:
            err = "map_load_failed"
        else:
            err = "service_rejected"
        respond("start_edge_cut_respond", {"result": 1, "error": err, "detail": tail})
    else:
        # e.g. "Waiting for service..." (service not found)
        respond("start_edge_cut_respond", {"result": 1, "error": "no_service_response", "detail": tail})
```

- [ ] **Step 3: Verify the handler compiles (Python syntax)**

Run from the repo root:
```bash
python3 -c "import ast, sys; ast.parse(open('research/extended_commands.py').read())"
```
Expected: no output, exit code 0. A `SyntaxError` traceback means the insertion broke the file — fix the offending lines before proceeding.

- [ ] **Step 4: Commit**

```bash
git add research/extended_commands.py
git commit -m "feat(firmware): add handle_start_edge_cut (cov_mode=2 via start_cov_task)"
```

---

## Task 2: Wire the new handler into `COMMANDS` and drop the broken one

**Files:**
- Modify: `research/extended_commands.py` (the `COMMANDS` dict at line 1689-1719)
- Modify: `research/extended_commands.py` (remove `handle_start_boundary_follow` definition around line 965-1075)

- [ ] **Step 1: Register `start_edge_cut`, remove `start_boundary_follow`**

Edit the `COMMANDS` dict. Replace the line:
```python
    "start_boundary_follow": handle_start_boundary_follow,
```
with:
```python
    "start_edge_cut": handle_start_edge_cut,
```

Leave the `stop_boundary_follow` entry as-is — the stop handler still applies to the new flow (it calls `cover_task_stop`, which cancels the goal regardless of which entry point dispatched it).

- [ ] **Step 2: Delete `handle_start_boundary_follow` function body**

Remove the entire `def handle_start_boundary_follow(params, respond): ...` function (spec says this handler is superseded; leaving it in dead code invites confusion). Keep `_clear_costmaps`, `_kill_ros2_action_clients`, `_call_cover_task_stop`, and `handle_stop_boundary_follow` — they remain in use.

Concretely: delete from the line `def handle_start_boundary_follow(params, respond):` (around line 965) down to (but not including) the next `def` (`def handle_recalibrate_charging_pose(...)` around line 1078). If the newly inserted `handle_start_edge_cut` sits between the two from Task 1, delete only the old `handle_start_boundary_follow` block and leave `handle_start_edge_cut` in place.

- [ ] **Step 3: Verify Python parse again**

```bash
python3 -c "import ast; ast.parse(open('research/extended_commands.py').read())"
```
Expected: exit 0.

- [ ] **Step 4: Verify the expected handler set**

```bash
python3 - <<'PY'
import ast, sys
tree = ast.parse(open("research/extended_commands.py").read())
for node in tree.body:
    if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "COMMANDS" for t in node.targets):
        keys = [k.value for k in node.value.keys]
        assert "start_edge_cut" in keys, "start_edge_cut missing"
        assert "stop_boundary_follow" in keys, "stop_boundary_follow missing"
        assert "start_boundary_follow" not in keys, "start_boundary_follow should be gone"
        print("COMMANDS ok:", [k for k in keys if "boundary" in k or "edge" in k])
        break
else:
    sys.exit("COMMANDS dict not found")
PY
```
Expected: prints something like `COMMANDS ok: ['start_edge_cut', 'stop_boundary_follow']` and exits 0.

- [ ] **Step 5: Commit**

```bash
git add research/extended_commands.py
git commit -m "refactor(firmware): drop broken start_boundary_follow, register start_edge_cut"
```

---

## Task 3: Switch app Edge Cut button to `start_edge_cut`

**Files:**
- Modify: `app/src/screens/HomeScreen.tsx:1935-1947` (inside the `CuttingHeightPickerModal` `onConfirm` callback, `picked.mode === 'edge'` branch)

- [ ] **Step 1: Read the surrounding context**

Read `app/src/screens/HomeScreen.tsx` lines 1900-1970. Confirm that `wire = Math.max(0, heightCm - 2)` is already computed at line ~1914 (used in the `set_para_info` pre-call). That same `wire` value is the correct `bladeHeight` for the new call.

- [ ] **Step 2: Replace the sendExtended payload**

Apply an `Edit` replacing the following block:

Old (exact match, keep surrounding comments as-is):
```ts
                const bladeIdx = Math.max(0, Math.min(7, 9 - heightCm));
                await api.sendExtended(mower.sn, {
                  start_boundary_follow: {
                    follow_mode: 2,           // BOUNDARY_CUTTING_MODE
                    enable_coverage: true,
                    more_close_to_boundary: false,
                    close_loop_stop: true,
                    start_follow_wait: false,
                    debug_mode: false,
                    inflation_radius: 0.0,
                    blade_height: bladeIdx,
                    max_time: 1800,
                  },
                }).catch(() => { /* non-fatal, optimistic UI still set */ });
```

New:
```ts
                await api.sendExtended(mower.sn, {
                  start_edge_cut: {
                    mapName: 'map0_work',
                    bladeHeight: wire,
                    light: 0,
                  },
                }).catch(() => { /* non-fatal, optimistic UI still set */ });
```

Also update the preceding comment (lines 1927-1933) from the old text describing `start_patrol` → `start_boundary_follow` to reflect the new flow. Replace:
```ts
                // Stock `start_patrol` MQTT handler is a stub — it only
                // returns result:0 without triggering any action. Real edge
                // cutting goes through the `/boundary_follow` ROS action
                // (coverage_planner/action/BoundaryFollow). Our extended
                // commands handler dispatches the action goal directly.
                // Convert user cm → chassis blade index (9 - userCm), same
                // mapping as the blade_on flow (JoystickScreen / CuttingHeightModal).
```
With:
```ts
                // Stock `start_patrol` MQTT handler is a stub. Stock `start_run`
                // also can't reach cov_mode=2 (BOUNDARY_COV). We instead send the
                // extended command `start_edge_cut`, which makes a service call
                // to `/robot_decision/start_cov_task` so robot_decision loads
                // the map, validates the working zone, and dispatches the
                // `/boundary_follow` action with a populated context.
                // `wire = heightCm - 2` is the stock level encoding used by
                // StartCoverageTask.blade_heights (mm = (level + 2) * 10).
```

- [ ] **Step 3: Type-check the app**

```bash
cd app && npx tsc --noEmit 2>&1 | tail -40
```
Expected: no new errors referencing `HomeScreen.tsx:~1935`. Pre-existing unrelated warnings can be ignored.

- [ ] **Step 4: Commit**

```bash
git add app/src/screens/HomeScreen.tsx
git commit -m "feat(app): Edge Cut uses start_edge_cut (cov_mode=2) instead of start_boundary_follow"
```

---

## Task 4: Deploy firmware + live smoke test

This task is **manual** — the user operates the physical mower. The implementer should drive the steps, relay commands, and interpret results. Do not proceed past a failing step without user acknowledgement.

**Pre-conditions (user responsibility, confirm before starting):**
- LFIN1231000211 is off-dock, sitting inside its home polygon, with at least 30 cm of clear space around the blade deck.
- Network: mower reachable at 192.168.0.100 from the dev laptop. `sshpass -p 'novabot' ssh root@192.168.0.100 echo ok` returns `ok`.
- The app on the dev device is connected to the Novabot server and shows LFIN1231000211 as active + online.

- [ ] **Step 1: Copy the patched handler onto the mower**

```bash
sshpass -p 'novabot' scp -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
  research/extended_commands.py root@192.168.0.100:/root/novabot/extended_commands.py
```
Expected: file transferred silently, exit 0.

- [ ] **Step 2: Restart the extended-command listener**

The listener runs as a systemd-adjacent python process. Restart it:
```bash
sshpass -p 'novabot' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@192.168.0.100 \
  "pkill -f 'python3.*extended_commands' 2>/dev/null; sleep 1; nohup python3 /root/novabot/extended_commands.py >> /tmp/extended_commands.log 2>&1 &"
```
Expected: exit 0. Verify it came back:
```bash
sshpass -p 'novabot' ssh root@192.168.0.100 "pgrep -af extended_commands | head -3"
```
Expected: one `python3 /root/novabot/extended_commands.py` process listed.

- [ ] **Step 3: Tail the mower-side log in a second terminal (background)**

Start a monitored tail so we capture the handler's output live:
```bash
sshpass -p 'novabot' ssh root@192.168.0.100 \
  "tail -F /tmp/extended_commands.log /tmp/edge_cut.log 2>/dev/null"
```
(Run this via a second shell or the Bash tool with `run_in_background: true`.) Leave it running for the rest of this task.

- [ ] **Step 4: Trigger Edge Cut from the app at 4 cm**

User action: in the app, pick Edge Cut on LFIN1231000211 and confirm at height 4 cm. App should dispatch `start_edge_cut` with `{mapName:"map0_work", bladeHeight:2, light:0}`.

- [ ] **Step 5: Read the success criteria off the log**

In the tail from step 3 look for:
- `start_edge_cut out: ... result=True` within ~3 s of the tap.
- Subsequent mower behavior: blade spins up and the mower begins following the polygon perimeter.
- No `NO_VALID_BOUNDARY` message in `/tmp/edge_cut.log`.

If the log shows `result=False` with `working zone`: robot was outside the polygon — reposition and retry step 4.
If it shows `result=False` with `load map`: map file is missing or corrupt — out of scope for this plan; capture the log and stop.
If it shows `no_service_response`: `robot_decision` isn't running or DDS config is wrong — check `ps aux | grep robot_decision` on the mower.

- [ ] **Step 6: Verify Stop**

User action: tap the red Stop button in the app. The existing `stop_boundary_follow` extended command already wires through (commit `3d25c2b5`); the mower must halt within ~2 s and the blade stop.

Expected log entry: `stop_boundary_follow: dispatched`.

- [ ] **Step 7: Negative test — robot outside polygon**

With the mower docked (which places it *outside* the polygon), user taps Edge Cut again. The MQTT response should come back `{result:1, error:"robot_outside_zone"}` and the mower must not move.

- [ ] **Step 8: Capture evidence**

Save the relevant section of `/tmp/edge_cut.log` plus the MQTT responses (visible in the app network log or the server's MQTT admin page) into the PR description. Include at least: one success response, the matching `BOUNDARY_COVERING` log line from `robot_decision` if available, and the negative-test response.

- [ ] **Step 9: Release-note commit**

Append a short note to the top of `CLAUDE.md` under the existing "Kritieke implementatiedetails" section — one line under a new sub-heading or appended to a nearby entry — documenting that edge-cut is now `start_edge_cut` → `/robot_decision/start_cov_task` with `cov_mode:2`, and that direct `/boundary_follow` dispatch is forbidden.

```bash
git add CLAUDE.md
git commit -m "docs: edge-cut via start_edge_cut (cov_mode=2), not /boundary_follow direct"
```

---

## Self-Review Notes

- **Spec coverage:** firmware new handler (Task 1), firmware registry + drop old handler (Task 2), app payload switch (Task 3), live deploy + testing (Task 4). Out-of-scope items in the spec stay out-of-scope — no server change, no polygon edit, no dynamic blade height, no stock-app UI change.
- **Open question from spec — `request_type: 11`:** the plan hardcodes `11`; if live step 5 returns `result=False` with a params-rejected message, retry with `10` and update the handler literal in `handle_start_edge_cut`.
- **Open question from spec — map name:** currently hardcoded `"map0_work"` in both the app call and the handler default. Multi-map parameterization is deferred per spec.
- **Blade encoding:** plan explicitly uses `wire` (`userCm − 2`), not `bladeIdx` (`9 − userCm`). Failure to heed this produces visibly-wrong heights (user 4 cm → blades at 70 mm) — Task 3 step 1/2 calls this out.
