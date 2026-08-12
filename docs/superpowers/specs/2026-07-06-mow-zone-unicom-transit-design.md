# mow_zone: unicom-guided transit in the normal mow flow

**Goal:** A normal "Start Mowing" for any zone follows the recorded map-to-map
unicom exactly through the passage (never cutting into the hedge), then continues
the normal coverage. Surface it in the app as a new "following unicom" state with
a Novabot map-to-map animation.

**Status:** DESIGN. Not committed (standing "no commits" instruction). Builds on
the proven `follow_unicom` extended command (research/documents/
unicom-follow-transit-design.md) and the firmware analysis in bd Novabot-aaj.

## Background (why)

No firmware node follows the unicom as a drive-path. Zone transit runs through
`coverage_planner_server`, which free-plans a goal-based path to the target zone
and can cut a corner into a hedge (the .244 map3 saga). We already have:

- `follow_unicom {from,to,dry_run}` (extended command): loads the recorded
  `map<from>tomap<to>_*_unicom.csv`, orients it toward the destination zone, and
  drives it EXACTLY via nav2 `/follow_path` (FollowPathPurePursuit). It temporarily
  relaxes the controller (speed 0.5->0.6, patience 12->45s, collision
  0.8->0.25s) for the trusted line, then restores the defaults. Proven live on
  .244: reached the map3 entrance, no hedge, params restored.
- `_depart_pile(seconds, linear)` (existing helper): releases the charge lock
  (`/release_charge_lock` UInt8 1) and drives ~1m back off the dock via `/cmd_vel`.
  Already used by the edge-cut/NTCP path.

The missing piece is sequencing undock -> follow_unicom -> coverage inside the
normal mow flow, uniformly, with the state visible in the app.

## Architecture: one mower-side orchestrator

A new extended command **`mow_zone`** in `extended_commands.py` owns the whole
sequence. ALL zone mows (app, dashboard, schedule) send `mow_zone` instead of a
direct `start_navigation`. The orchestration lives in one place on the mower, so
it is uniform and the coverage keeps running through robot_decision (full state
machine + work_status reporting + auto-recharge).

```
mow_zone { map, cutterhigh, area, cmd_num }   (same fields the app puts in start_navigation, + map)
```

### Sequence (background thread; never blocks the MQTT loop)

1. **status: undocking** (only if on the dock). Call `_depart_pile()` (lock
   release + ~1m reverse). Skip if already off-dock.
2. **status: following_unicom** (only if a transit is needed, see Trigger). Run
   the existing `follow_unicom(from=current_zone, to=map)` inline (relax
   controller -> `/follow_path` the recorded line -> restore). On success the
   robot sits at the target-zone entrance.
3. **status: covering**. Re-inject the normal coverage so robot_decision runs its
   standard flow. Robot is now off-dock and in-zone, so its QUIT_PILE is a no-op
   and its move-to-coverage-start is a short in-zone path (no hedge).
4. **status: done** (or **error** at any step -> stop, no coverage).

### Trigger: does step 2 run?

Step 2 runs only when BOTH hold:
- A `map<from>tomap<to>_*_unicom.csv` exists for current-zone -> target (the
  `from` is the zone the robot is currently in; dock counts as `map0`/home).
- The robot is not already inside the target zone polygon (point-in-polygon on
  `<map>_work.csv`).

Otherwise step 2 is skipped and the flow is undock -> coverage (today's behaviour).

## Coverage re-injection (SPIKE in the plan)

The coverage step must go through robot_decision so the state machine, work_status
reporting, and auto-recharge are preserved. Two candidate mechanisms, decided by a
short spike:

- **(a) Direct ROS interface:** find the ROS service/topic mqtt_node calls when it
  receives `start_navigation`, and have the orchestrator call it directly (no
  crypto). Cleanest if it exists.
- **(b) Encrypted MQTT loopback:** publish an AES-encrypted `start_navigation` to
  `Dart/Send_mqtt/<SN>` (key = "abcdabcd1234" + SN[-4:], the standard LFI key) so
  mqtt_node consumes it exactly like an app command.

Prefer (a); fall back to (b).

## Data flow / state reporting

- `mow_zone` streams phase updates on the existing extended_response channel:
  `{ mow_zone_status: { phase, map, detail? } }`, phase in
  `undocking | following_unicom | covering | done | error`.
- The server relays extended responses to the app (existing path). The app maps
  `phase` to UI. During `covering` the app falls back to the normal
  report_state_robot activity (work_status).
- `following_unicom` is an OVERLAY state (not firmware report_state), so the app
  learns it only from `mow_zone_status`. If the app misses it (restart mid-transit)
  it simply shows the generic "mowing/moving" until the next report; acceptable.

## App changes

- New activity **`following_unicom`** in `deriveMower`/HomeScreen, driven by the
  latest `mow_zone_status.phase` (kept in mower state, cleared on `done`/`error`).
- Start Mowing sends `mow_zone` (via the generic extended endpoint) instead of
  `start_navigation`. `from` = the zone the mower is in (dock -> home), `to` = the
  selected map. Dashboard + schedule use `mow_zone` too.
- **Novabot map-to-map animation:** two rounded zone shapes with a mower icon
  moving along a dashed line from zone A to zone B, in Novabot colors (emerald
  lawn, the app's mower silhouette). Lottie or a light React-Native SVG/Reanimated
  loop. Shown in the `following_unicom` state with copy like
  "Moving to {zoneName} through the passage". Inspired by Segway's clip
  (research/segway-analysis/frames/mowgate-flow.png), re-created in our style, no
  Segway assets.

## Error handling

- Undock fails / not localized -> `phase: error`, no coverage, app shows a clear
  message ("Couldn't leave the dock" / "No RTK fix").
- `follow_unicom` aborts (FollowPath aborted, or times out) -> `phase: error`,
  stop, no coverage. Do NOT fall back to the raw coverage transit (that is the
  hedge risk). Surface the abort so the user can retry.
- Controller params are ALWAYS restored (the `finally` in follow_unicom), even on
  abort, so coverage/other nav keep full obstacle sensitivity.

## Components / boundaries

- `extended_commands.py`: `handle_mow_zone` (new) orchestrates; reuses
  `_depart_pile`, the `follow_unicom` internals (refactor its core into a callable
  `_follow_unicom(from,to)` so `handle_follow_unicom` and `handle_mow_zone` share
  it), and the coverage re-injection helper.
- `server`: no logic change needed (generic extended relay already forwards
  `mow_zone`; extended_response already relayed to the app). Optional: a typed
  helper + the schedule path switched to `mow_zone`.
- `app`: `deriveMower` new activity + state field, HomeScreen render + animation,
  StartMowSheet sends `mow_zone`, an i18n string, the animation asset.

## Testing

1. `follow_unicom` refactor: unit-safe (pure path build) + the existing dry-run
   still returns the same 45-pt dock->map3 path.
2. `mow_zone` dry-run mode (echo the plan: would-undock?, from/to, transit needed?,
   coverage payload) before any movement.
3. Live on .244, staged with explicit user go for each first movement:
   undock-only, then undock+follow_unicom, then the full mow_zone (-> coverage
   mows map3 with no hedge and no Error 125/127).
4. App: the `following_unicom` state + animation render from a simulated
   `mow_zone_status` stream (DemoContext), independent of the mower.

## Open decisions deferred to the plan

- Coverage re-injection mechanism (spike a vs b).
- Exact `from`-zone detection (which zone the robot is in at start; dock mapping).
- Animation tech (Lottie vs Reanimated SVG) - pick during the app task.
