# Design: drive the unicom exactly on inter-zone transit (approach A)

Status: DESIGN (not implemented). Fixes the "drives into the hedge between zones"
class of bug by making the mower follow the recorded unicom line during transit
instead of letting nav2 free-plan to the target zone.

## Why (from the firmware analysis, Novabot-aaj)

No firmware node follows the unicom as a drive-path. The unicom is consumed only by
`novabot_mapping` (56 refs) to shape the pgm corridor. Zone transit runs through
`NavigateThroughCoveragePaths` -> `coverage_planner_server`, which has no `unicom`
reference and free-plans a goal-based path to the target zone on the pgm. If that
corridor is too wide/wrong (e.g. .244's manually ICP-edited map3), nav2 takes the
shortest path and cuts a corner into the hedge.

We already HAVE the correct line (the recorded `map<X>tomap<Y>_<n>_unicom.csv`). This
design drives it exactly via the existing `/follow_path` action, then hands back to
coverage. No change to stock map generation.

## Verified integration points

- `/follow_path` is live: `nav2_msgs/action/FollowPath`. Controller plugin is
  `FollowPathPurePursuit` (seen in coverage_planner_server strings).
- `extended_commands.py` already dispatches ros2 actions via
  `ros2 action send_goal ... /navigate_through_coverage_paths` (edge-cut). Same
  pattern for `/follow_path`.
- Unicom CSV is local x,y in the `map` frame (charger = 0,0). `map0tomap3_0_unicom.csv`
  is ordered map3 -> dock (first point ~(-10.82, 6.26) at the map3 entrance, last
  ~(-0.01, 0.78) at the dock), so it must be oriented from the robot's current end.

## Core mechanism: new extended command `follow_unicom`

Mower-side handler in `extended_commands.py` (local-first, then build + deploy):

```
follow_unicom { from: "map0", to: "map3" }   ->  drives map0tomap3_0_unicom.csv
```

Steps:
1. Resolve the CSV: `map<from>tomap<to>_<n>_unicom.csv` in
   `/userdata/lfi/maps/home0/x3_csv_file/` (fall back to csv_file). If several
   `_<n>_` segments exist, concatenate in index order.
2. Load points. Orient the path so index 0 is the END NEAREST the robot's current
   `map->base_link` pose (so it always drives forward from where it stands). Reverse
   if needed.
3. Build a `nav_msgs/Path` (frame_id `map`): one `PoseStamped` per point, position
   from the CSV, orientation = heading toward the next point (yaw from atan2 of the
   segment; last pose reuses the previous heading). Pure pursuit tolerates rough
   headings, but per-point yaw keeps it smooth.
4. Dispatch:
   `ros2 action send_goal /follow_path nav2_msgs/action/FollowPath
     "{path: {header: {frame_id: map}, poses: [...]}, controller_id: FollowPathPurePursuit}"`
   via the existing `start_ext.sh` ROS env (threading.Lock around the send, like the
   other action dispatchers).
5. Await result; return `{result: 0}` on FollowPath success, non-zero + reason on
   abort/timeout. Timeout ~ path_length / 0.2 m/s + margin.

### Safety gates (movement command)
- Refuse unless localized + RTK fixed and `map->base_link` TF is fresh (avoid the
  degenerate-pose case that gave Error 124).
- Refuse if the robot is already inside the target zone polygon (no transit needed).
- Refuse if a coverage/other task is already MOVING (no double-driver).
- Hard timeout + cancel; on abort, do NOT auto-retry into the hedge, report and stop.

## Orchestration: when does `follow_unicom` fire?

The transit must run BEFORE coverage_planner gets its goal, so the robot is already
at the target-zone entrance when coverage plans (its move-to-start is then a short
in-zone path, no hedge).

- **Phase 1 (MVP, dashboard-initiated mows):** the OpenNova server owns the start.
  On "mow zone N" where the mower is not in zone N: (1) call `follow_unicom {from:
  current_zone, to: N}` and await success, (2) then send the normal coverage start.
  Current zone from the mower's reported position (which zone polygon it is in; dock
  = map0).
- **Phase 2 (app-initiated mows):** the app sends start over MQTT directly (broker
  relays). Options: (a) broker `authorizePublish` intercepts the zone-start, injects
  `follow_unicom` first, then releases the start (mirrors the existing OTA-tz
  intercept); or (b) a mower-side watcher that pre-empts when it sees a coverage task
  begin for a zone the robot is not in. (a) is closer to how we already intercept.

Ship Phase 1 first (server pre-drive), measure on .244 + David, then decide Phase 2.

## Handoff to coverage

After `follow_unicom` success the robot sits at the target-zone entrance (inside the
zone polygon). Coverage's move-to-coverage-start is then within the zone, so nav2's
free-plan can't reach the hedge. No coverage_planner change needed.

## Test plan

1. Dry-run the path build: dump the generated `nav_msgs/Path` for
   map0->map3 and overlay on map3 + the hedge (like the .244 corridor plots) to
   confirm it traces the gap, before ever sending it.
2. `follow_unicom` alone on .244 (mower at dock, RTK fixed): confirm it drives the
   gap and stops at the map3 entrance, no hedge contact. Explicit user go for the
   first live movement (safety rule).
3. Full flow: server pre-drive + coverage; confirm map3 mows without Error 125/127
   and without the hedge dive.

## Open decisions for the user

- Phase-1 only for now (dashboard), or also design the Phase-2 app-path intercept?
- Concatenation rule when a transit has multiple unicom segments (e.g. dock->map0
  ->map3): follow each in order, or require a single end-to-end unicom?
- Do we gate this behind a per-mower toggle (like seam-fix) so it is opt-in?
```
