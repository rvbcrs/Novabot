# Edge Cut via `/robot_decision/start_cov_task` — Design

**Date:** 2026-04-23
**Status:** Proposed
**Target mowers:** LFIN1231000211, LFIN2230700238 (stock v6.0.2-custom-24 firmware)

## Problem

Edge-cut feature currently fails with `NO_VALID_BOUNDARY` ("No valid boundary need robot!!!"). Prior implementation (commit `48d6cc26`) dispatches `/boundary_follow` ROS2 action directly via `ros2 action send_goal`. This bypasses the map-loading and working-zone validation that `robot_decision` performs before dispatching the same action.

## Root Cause

Verified on LFIN1231000211 via binary string analysis and `ros2 node info`:

- Stock MQTT `api_start_patrol` handler in `mqtt_node` is a stub — returns `{result:0}` without calling any ROS service.
- Stock Novabot app v2.4.0 has no edge-cut UI (no `start_patrol`/`startPatrol`/`BOUNDARY_COV` strings in Flutter asm).
- `StartCoverageTask.srv` (`decision_msgs/srv/StartCoverageTask`) defines `cov_mode: 2 = BOUNDARY_COV` = edge-cut mode.
- Service host `/robot_decision/start_cov_task` exists on the mower (stock C++ `robot_decision` binary).
- `robot_decision` string evidence of orchestration: `"Load map successfully!! width %d height %d"`, `"/decision_assistant/load_map"`, `"/map.yaml"`, `"Not in mapping working zone"`, `"Unable to start boundary follow action!!!"`, `"BOUNDARY_COVERING"`. It is a client of `coverage_planner/action/BoundaryFollow`.
- Direct `/boundary_follow` dispatch (current code) skips: map load into `decision_assistant`, polygon validation, state machine setup. Result: `coverage_planner_server` has no boundary data → `NO_VALID_BOUNDARY`.

## Proposed Change

Add a new extended command `start_edge_cut` that makes a `ros2 service call` to `/robot_decision/start_cov_task` with `cov_mode: 2`. Let `robot_decision` do the orchestration.

### Firmware — `research/extended_commands.py`

**New handler `handle_start_edge_cut(params, respond)`:**

- Pre-calls `_kill_ros2_action_clients()` + `_call_cover_task_stop()` + `_clear_costmaps()` (reuse existing helpers) to clear any prior state.
- Builds YAML goal for `decision_msgs/srv/StartCoverageTask`:
  - `cov_mode: 2` (BOUNDARY_COV, hardcoded for this handler)
  - `request_type: 11` (mqtt/app normal start, per `StartCoverageTask.srv` comment)
  - `map_names: [<params.mapName | "map0_work">]`
  - `blade_heights: [<params.bladeHeight | 3>]` (wire value 0..7; cm − 2)
  - `light: <params.light | 0>`
  - `specify_perception_level: false`
  - `blade_info_level: 0`
  - `night_light: false`
  - `enable_loc_weak_mapping: false`
  - `enable_loc_weak_working: false`
  - `specify_direction: false`
  - `cov_direction: 0`
- Uses blocking `subprocess.run` with a 15s timeout. `/robot_decision/start_cov_task` returns quickly (load_map + validate ~1–3s); the long-running BOUNDARY_COVERING loop runs inside `robot_decision` independently of the service reply.
- stdout/stderr captured and parsed: `"response: ... result=True"` → success; `result=False` → service-level error; timeout → `service_timeout`.
- Tee output to `/tmp/edge_cut.log` for post-hoc debugging.
- DDS env: `ROS_DOMAIN_ID=0`, `ROS_LOCALHOST_ONLY=1`, `RMW_IMPLEMENTATION=rmw_cyclonedds_cpp`, `CYCLONEDDS_URI=file:///root/novabot/shm_config/shm_cyclonedds.xml` (mandatory — service discovery fails otherwise).
- On service success responds `{result:0, cov_mode:2, map:<name>, blade:<h>}`; on failure responds `{result:1, error:<class>, detail:<stdout tail>}`.

**Register in `EXTENDED_COMMAND_HANDLERS` dict** (around line 1704).

**Drop `handle_start_boundary_follow`** — superseded. Remove from `EXTENDED_COMMAND_HANDLERS`. Keep `handle_stop_boundary_follow` + `_clear_costmaps` + `_kill_ros2_action_clients` + `_call_cover_task_stop` — still needed for stop path.

### App — `app/src/screens/HomeScreen.tsx` (edge-cut path ~line 1934)

Replace:
```ts
await api.sendExtended(mower.sn, {
  start_boundary_follow: {
    follow_mode: 2,
    enable_coverage: true,
    more_close_to_boundary: false,
    close_loop_stop: true,
    start_follow_wait: false,
    debug_mode: false,
    inflation_radius: 0.0,
    blade_height: bladeIdx,
    max_time: 1800,
  },
});
```

With:
```ts
await api.sendExtended(mower.sn, {
  start_edge_cut: {
    mapName: 'map0_work',
    bladeHeight: bladeIdx,
    light: 0,
  },
});
```

Stop path (`stop_boundary_follow`) stays identical — `cover_task_stop` cancels both entry points.

### Server

No change. Extended-command passthrough already works via existing `/api/dashboard/extended-command/:sn` and `sendExtended` API.

## Data Flow

```
User tap Edge Cut
 → HomeScreen CuttingHeightPickerModal confirm (heightCm → wire bladeIdx)
 → api.sendExtended(sn, { start_edge_cut: {...} })
 → server MQTT extended_command → mower
 → extended_commands.py handle_start_edge_cut
   → _kill_ros2_action_clients() + _call_cover_task_stop() + _clear_costmaps()
   → ros2 service call /robot_decision/start_cov_task {cov_mode:2, map_names:[...], ...}
 → robot_decision:
   → /decision_assistant/load_map "/map.yaml"
   → validate robot inside polygon
   → action client /boundary_follow goal (follow_mode=2 BOUNDARY_CUTTING)
 → coverage_planner BOUNDARY_COVERING → nav2 FollowPath → motors
Stop: HomeScreen Stop
 → sendExtended({ stop_boundary_follow: {} })
 → handle_stop_boundary_follow → /coverage_planner_server/cover_task_stop
```

## Error Modes

| Symptom | Firmware response | App behavior |
|---|---|---|
| `ros2 service call` times out (>10s) | `{result:1, error:"service_timeout"}` | show toast "Edge cut unavailable" |
| robot_decision returns `result:false` (load_map fail) | forward service response in `{result:1, error:"map_load_failed", detail:...}` | show toast, remain idle |
| robot_decision returns `result:false` (robot outside polygon) | `{result:1, error:"robot_outside_zone"}` | show toast "Drive mower into lawn" |
| Anything else | `{result:1, error:<raw>}` | generic "Edge cut failed" |

The handler blocks on the service call up to 15s so the MQTT reply reflects service-level success/failure (see Firmware section). The BOUNDARY_COVERING loop continues in `robot_decision` after the service returns, independent of MQTT.

Live stop safety: existing `handle_stop_boundary_follow` already kills lingering action clients + `cover_task_stop` — stays in. Home-screen red-stop + "End task & return" already wired to it (commit `3d25c2b5`).

## Testing

Live-only, no unit tests (firmware is Python, no test harness).

1. Deploy firmware: `scp extended_commands.py root@192.168.0.100:/root/novabot/extended_commands.py` + restart listener.
2. Mower pre-conditions: off-dock, inside polygon, blade clear, LoRa OK.
3. Tap Edge Cut in app with height = 4 cm (bladeIdx = 2).
4. Expected: MQTT reply `{result:0, dispatched:true, cov_mode:2}` within ~3s, mower enters BOUNDARY_COVERING, drives along perimeter, blade on.
5. Stop: Red Stop button → mower halts within ~2s.
6. Failure probe: dock mower (outside polygon) → Edge Cut → expect `robot_outside_zone` error.

## Out of Scope

- No change to MQTT protocol (`start_patrol` stays stub, ignored).
- No polygon-edit mid-session.
- No dynamic blade-height rewrite during edge run.
- No `cov_mode` value other than 2 — this command is edge-only by design.
- No Novabot-app UI change (app has no edge button; only our custom app hosts it).

## Open Questions

- **Map name parameterization:** currently hardcoded `"map0_work"` in the app call. If a mower has multiple maps the app should pass the selected map id. Tracked as follow-up — today single-map UX is live everywhere.
- **`request_type: 11`** assumption from comment in `.srv` — to be validated on first live run. If robot_decision rejects, try `10`.
