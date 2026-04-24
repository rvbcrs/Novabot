# Edge-cut (boundary cutting) — final flow

**Status:** Live-verified on LFIN1231000211 on 2026-04-24.
**Target firmware:** `v6.0.2-custom-24` stock robot_decision + stock coverage_planner.

## TL;DR

Dispatch the `/navigate_through_coverage_paths` ROS 2 action with
`only_edge_mode: true` and `include_edge: true` — nothing else is required.
There is **no** stock MQTT verb and **no** stock service-level call that
triggers edge cutting; the app doesn't ship an edge button either. The
goal is sent directly to `coverage_planner_server`, which owns the action
server and drives the mower along the boundary that `coverage_by_file`
has already baked into its internal state.

```
Goal = coverage_planner/action/NavigateThroughCoveragePaths
  map_yaml:            /userdata/lfi/maps/home0/map0.yaml
  coverage_type:       0       # COVERAGE_BY_FILE
  reset_coverage_map:  true
  return_to_start:     false
  include_edge:        true
  only_edge_mode:      true    # ← the one field that flips normal mow to edge-only
  setting_blade_height:true
  blade_height:        40      # mm
  adaptive_mode:       1       # reciprocal speed
  target_repeat_times: 1
  # everything else: false/zero
```

Result log on the mower:

```
coverage_planner_server: Plan successfully with total area: 29.33
coverage_planner_server: Only edge mode, only covering boundary path !!!!
coverage_planner_server: Boundary id: 0,  path size: 479
coverage_planner_server: ------ Current work status: BOUNDARY_COVERING
coverage_planner_server: Setting blade height to : 40
coverage_planner_server: Current task coverage area: 1.219  covered_ratio: 0.042
```

Blades on, mower physically tracking the perimeter.

## Architecture

```
App / dashboard
    │
    │ MQTT extended command:
    │ { start_edge_cut: { mapName:"map0", bladeHeight:40 } }
    ▼
extended_commands.py (mower, Python listener)
    │
    │ ros2 action send_goal /navigate_through_coverage_paths
    │   coverage_planner/action/NavigateThroughCoveragePaths
    │   { coverage_type:0, map_yaml:".../map0.yaml",
    │     include_edge:true, only_edge_mode:true,
    │     setting_blade_height:true, blade_height:40, ... }
    ▼
coverage_planner_server (C++, stock)
    ├─ Plans full coverage path internally (cell sweep + edge rings)
    ├─ `only_edge_mode` branch skips the fill path, keeps the edge rings
    ├─ Dispatches nav2 FollowPath per segment
    └─ Publishes feedback (work_status 150 = BOUNDARY_COVERING)
    ▼
nav2 controller → chassis_control → wheels + blade
```

No `robot_decision` involvement. We bypass it intentionally — robot_decision
doesn't have a code path that reaches `only_edge_mode:true` for an existing
saved map (see "dead ends" below).

## MQTT wire

- App sends extended command on `novabot/extended/<SN>` with payload
  `{"start_edge_cut":{"mapName":"map0","bladeHeight":40}}`.
- Firmware handler `research/extended_commands.py::handle_start_edge_cut`
  parses + dispatches the NTCP action via `subprocess.Popen` (fire-and-forget;
  the action runs for the full mow duration inside coverage_planner_server).
- Handler responds on `novabot/extended_response/<SN>` with
  `{"result":0,"map":"<name>","blade_mm":<h>}` once the dispatch is in flight.
- Stop path: existing `stop_boundary_follow` handler still applies — it
  fires `/coverage_planner_server/cover_task_stop`, which cancels the
  in-flight NTCP action.

## Params

| App param    | Firmware param    | Downstream effect                              |
|--------------|-------------------|------------------------------------------------|
| `mapName`    | `mapName`         | Used to build `/userdata/lfi/maps/home0/<mapName>.yaml`. Whitelisted to `[A-Za-z0-9_\-]+`. |
| `bladeHeight`| `bladeHeight`     | mm, clamped 20..90. Fed into `blade_height` (uint8 mm) in the NTCP goal. Coverage_planner server itself clamps to ≥20mm. |
| -            | `only_edge_mode`  | Hardcoded true in the handler.                 |
| -            | `include_edge`    | Hardcoded true in the handler.                 |
| -            | `coverage_type`   | Hardcoded 0 (COVERAGE_BY_FILE).                |
| -            | `reset_coverage_map` | Hardcoded true (so planner doesn't resume partial coverage across calls). |
| -            | `return_to_start` | Hardcoded false (pure edge pass, no return leg). |

The app's cutting-height picker still exposes cm; `cm*10` = mm goes on
the wire.

## Why the NTCP action (and not `/boundary_follow`)

coverage_planner has TWO action servers:

1. **`/boundary_follow`** — operates on the **LOCAL** cost map. Its
   `BoundaryFollowPlannerRos2Adapter::makePlan(pose, inflation_radius,
   local_cost_map, out_path)` scans for lethal cells within the
   inflation radius of the robot. Used by robot_decision's
   `handleAssistantMapping` during manual boundary-mapping flows, where
   the robot is driven by-hand along the perimeter and the camera's
   perception pipeline paints lethal cells as the boundary. Dispatching
   this action standalone against a saved map fails with
   `"No valid boundary need robot!!!"` because the local cost map has
   no lethal cells at the robot's current position.

2. **`/navigate_through_coverage_paths`** — operates on the map yaml
   file via `coverage_by_file` internally. When `coverage_type=0` +
   `include_edge=true` + `only_edge_mode=true` are all set, the
   planner generates an edge-only path (the log line
   `"Only edge mode, only covering boundary path !!!!"` is emitted
   from `CoverageServer::makeCoveragePlan` at this branch) and
   drives FollowPath along it. This works stand-alone without any
   up-front local-costmap priming.

We use #2. The stock app's "start mowing" also goes through #2 (but
with `only_edge_mode:false`, so it does the full cover).

## Dead ends we walked

Documenting the paths we tried and abandoned so we don't re-try them:

### A. `/robot_decision/start_cov_task` + `cov_mode:2` (BOUNDARY_COV)

- StartCoverageTask.srv lists `cov_mode:2` = BOUNDARY_COV as "贴边割草模式".
- We sent this. robot_decision accepted, ran its normal state machine
  (INIT_SUCCESS → MOVING → **COVERING**), never **BOUNDARY_COVERING**.
- Disasm confirmed: `handleStartCoverageTask` (0x69a78) copies
  `cov_mode` into `this+0xd61` and sets a pending flag, but
  `coverStartDeal` (0x91a28) branches on `task_type` (0x380), which
  `coverRequestDataInit` always sets to 1 (COVERING). `cov_mode` is
  plumbed into per-task `CovTaskInfo` but never reaches the NTCP
  `only_edge_mode` field; it's effectively dead in this firmware build
  for start_cov_task.
- Attempting `map_names:["map0_work"]` with `map_ids:0` hit
  Error_code 118 ("Input data for coverage action is wrong, maybe file
  not exists!") because robot_decision built the path
  `/userdata/lfi/maps/home0/map0_work` which does not exist. Correct
  form is `map_ids:1` with `map_names:[]` (robot_decision uses the
  numeric id to resolve `map0.yaml`).

### B. Stock MQTT `start_patrol`

- mqtt_node binary has `api_start_patrol` (at 0x1c2db8) and
  `api_stop_patrol` (at 0x1c32b8) handlers.
- Live test: app → `{start_patrol:null}` → mqtt_node responds
  `{result:0}` immediately, robot_decision log shows **nothing**.
- Disasm of mqtt_node's `api_start_patrol` (follow-up disasm pass):
  **pure JSON echo stub, no ROS call at all.** The function takes the
  incoming JSON, builds a canned `start_patrol_respond`, publishes it,
  returns. No service call, no topic publication. Same for
  `api_stop_patrol`.
- The stock Novabot app v2.4.0 Flutter bundle has no `start_patrol`
  reference (confirmed via blutter pp.txt + asm grep) — no edge button
  in the official UI either. The handler is dead code in the firmware.

### C. `/robot_decision/start_assistant_mapping` (std_srvs/SetBool)

- robot_decision's `handleAssistantMapping` (0x7c728) is the ONLY
  site that dispatches the `/boundary_follow` action in the binary.
- Live test: SetBool{data:true} in cold-idle → rejected
  `"Not in mapping working zone or mapping obstable mode!!!"`.
  Same in COVERING state → rejected (different message but rejected).
- Disasm: the handler gates on a `work_status` byte at `this+0x3d9`;
  only values `0x82, 0x83, 0x8d, 0x8e` (all `MANUAL_MAPPING_*`
  / `ASSISTANT_MAPPING_MAPPING_*` states) reach the dispatch. From
  `WorkStatus=0` (idle) the gate rejects.
- The only code paths that write `0x82/0x83/0x8d/0x8e` are
  `handleStartMapping` (`start_scan_map`) and `handleAddArea`
  (`add_scan_map`) — both of which **wipe the current map** as part
  of starting a fresh mapping session. Not usable for edge-cutting a
  pre-recorded map.

### D. Direct `/boundary_follow` action dispatch (after `coverage_by_file`)

- After `coverage_by_file include_edge:true` returns success, we
  tried dispatching the `/boundary_follow` action directly. The
  action accepted, transitioned BOUNDARY_MOVING → BOUNDARY_FOLLOWING
  for ~2 seconds, then aborted with
  `"No valid boundary find!!!"` → PLANNING_FAILED. Tried every goal
  variant (`follow_mode` 0/1/2, `more_close_to_boundary`,
  `start_follow_wait`, zeroed inflation). All failed the same way.
- Root cause: `BoundaryFollowPlannerRos2Adapter::makePlan` uses
  the LOCAL costmap, not the map file. The polygon from
  `coverage_by_file` doesn't rasterize into `/local_costmap/costmap`
  — that's populated by nav2's static_layer (from the saved map
  OccupancyGrid), but only near the robot. With the robot sitting
  in the middle of the polygon at startup, there are no lethal cells
  within the inflation radius for the planner to latch onto.
- Even if you could prime the local costmap, robot_decision's
  `handleAssistantMapping` is still the only sanctioned dispatcher,
  and its `work_status` gate blocks uninvited callers.

### E. Binary patching robot_decision

- Offered as a valid option (NOP the `b.ne` at file offset `0x7c798`
  in `handleAssistantMapping` plus fake-set `work_status=0x82` at
  function entry — about 8 bytes of patch).
- Not needed once we discovered option F below. Kept as a fallback if
  we ever need to enable the mapping-oriented `/boundary_follow`
  semantics (e.g. auto-mapping during a patrol).

### F. `/navigate_through_coverage_paths` with `only_edge_mode:true` ← **THE ANSWER**

- Discovered by grepping our own `open_decision/service_handlers.py`
  line 545: `include_edge=bool(request.cov_mode == 2)`. Our Python
  replacement for the C++ robot_decision already had the right idea
  but wired `only_edge_mode:false` always (line 1277 of
  `robot_decision.py`).
- Flipping `only_edge_mode` to `true` + `include_edge:true` gives pure
  edge-only coverage. No robot_decision gate. No local-costmap priming.
  Just works.

## Why this was hard to find

1. **Wrong disasm scope.** First disasm pass asked "how does robot_decision
   dispatch `/boundary_follow`?" — the agent correctly found
   `handleAssistantMapping` and concluded that's the edge-cut trigger.
   True but incomplete: edge cut is ALSO done via NTCP with a goal flag,
   from a different robot_decision function (`coverStartDeal`), into a
   different action. The right question was "how does coverage_planner
   produce the 'Only edge mode, only covering boundary path' log line?".

2. **Same log string, two code paths.** The string
   `"Only edge mode, only covering boundary path !!!!"` appears in the
   coverage_planner binary, but is emitted from
   `CoverageServer::makeCoveragePlan` (the NTCP code path), not from
   anywhere in BoundaryFollow's handling. I conflated the two.

3. **Our own open_decision had the answer.** `service_handlers.py`
   explicitly wires `cov_mode==2 → include_edge=true` and routes through
   `start_coverage()` which dispatches NTCP. It just needed
   `only_edge_mode:true` flipped on. We weren't checking our own code —
   all the reverse-engineering was on stock binaries.

4. **The disasm agent's "missing local_costmap lethal cells" finding
   was correct for /boundary_follow — but irrelevant because NTCP is a
   different pipeline that doesn't rely on that state.** I chased the
   BoundaryFollow dead end for ~2h before the open_decision suggestion
   surfaced the right action.

## Firmware code

`research/extended_commands.py`:

- `handle_start_edge_cut(params, respond)` — single ros2 action send_goal
  to `/navigate_through_coverage_paths` with the fixed goal above.
  Whitelists `mapName` to prevent shell injection. Responds immediately
  with `result:0` on dispatch; the action runs long.
- Clears costmaps via `_clear_costmaps()` helper before dispatch (safe,
  non-blocking).
- `handle_stop_boundary_follow(params, respond)` — kept; `cover_task_stop`
  cancels NTCP just as it cancels BoundaryFollow.
- `handle_start_boundary_follow` — removed (was the first approach; never
  reached motion).

`app/src/screens/HomeScreen.tsx`:

- Edge-cut branch of `CuttingHeightPickerModal.onConfirm` sends
  `{ start_edge_cut: { mapName:'map0', bladeHeight: heightCm*10 } }`.

`server/`:

- No changes. Extended-command passthrough already worked.

## Live-verified behaviour

- Trigger: extended command from server → mower listener.
- coverage_planner_server within ~500 ms logs
  `Only edge mode, only covering boundary path !!!!` + `Boundary id: 0, path size: 479`.
- `work_status` in feedback transitions to 150 (BOUNDARY_COVERING).
- `blade_height_set` topic publishes `40`; chassis lowers blades; user
  observes cutting along the perimeter.
- Coverage area feedback increments 0 → 1.2 m² within a minute.

## Known caveats

- Robot must be localized (TF `map → base_link` valid) before dispatch.
  Not localization-specific to edge cut; any coverage task needs it.
- `reset_coverage_map:true` drops any partial normal-coverage progress
  the mower had. If we want to run edge as a "finishing pass" we should
  set `reset_coverage_map:false` and sequence it after the main mow.
- Tight/complex polygons may trigger BOUNDARY_AVOIDING substates; the
  planner recovers via nav2 FollowPath retries. Observed benign.
- If another coverage action is already running, NTCP goal is queued or
  rejected. Our handler preemptively fires `cover_task_stop` via the
  clear-costmaps path — stop handler is same `stop_boundary_follow`
  we already had.
