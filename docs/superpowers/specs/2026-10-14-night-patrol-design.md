# Night Patrol: Design

Date: 2026-10-14. Status: draft for review by Ramon.

## Goal

The mower leaves its dock (on demand or on a schedule, typically at night),
drives a route through the garden with the blades off, stops at checkpoints to
look with its camera and its detection model, and sends a notification when it
sees a person or an animal. The photo of every checkpoint is kept for review.
Afterwards it docks exactly like stock.

## What LFI left in the firmware

Established 2026-10-14 (Ghidra, objdump, the shipped install tree):

- `start_patrol` / `stop_patrol` in mqtt_node are JSON-echo stubs, no ROS call
  (`research/ghidra_output/mqtt_node_decompiled.c:321141-321411`).
- robot_decision task type 3 = `PATROLLING` is only a name in
  `robot_status::TaskTypeString`; every `updateTaskType` caller passes 1 or 2.
- STM32 v3.6.0 screen 0x24 only shows "Please set the security patrol time on the APP".
- `novabot_patrol` / `novabot_patrol_msgs` are referenced in the build prefix
  path but not shipped in any firmware we have (5.7.1, 6.0.2, 6.0.3).
- `/perception/pedestrian_detect` is advertised but never published.

So there is nothing to finish. We build it from parts that do work:

| Part | Where |
|---|---|
| Drive to a point, blades off | nav2 `NavigateToPose` via `Driver.nav_to` (`research/mow_zone_drive.py`) |
| Drive between zones without crossing hedges | `edge_route()` + recorded channels / touching zones (`mow_zone_drive.py`) |
| Stock departure | `Driver.localize_via_firmware` (firmware QUIT_PILE) |
| Stock docking | server `goHome()` (go_pile + go_to_charge) |
| Detection model | perception_node classes 100 = person, 101 = animal in `/perception/points_labeled` (`perception_conf/infer_class.json`) |
| Detection on outside a task | `start_camera` x2, `/perception/do_perception`, `set_infer_model 2` (`research/auto_map_node.py:319-335`) |
| Costmap sees people/animals | `_apply_edge_perception_low()` / `_restore_edge_perception()` (`research/extended_commands.py`) |
| Photo | `camera_stream.py` `/snapshot?topic=` on port 8000 |
| Headlight 0..100 | `/led_set` via `led_bridge.py` (MQTT `novabot/cmd/<SN>` `{led_set: N}`) |
| Blades off, deck up | `_publish_blade_speed(0)` + `_publish_blade_height(7)` (`extended_commands.py`; mm = (level + 2) * 10, so 7 = 90 mm) |
| Notifications | `dispatchEvent` (ntfy, HA webhook, Expo push, MQTT, dashboard socket) |

## Decisions

1. **New OpenNova extended command `patrol`**, run by `mow_zone_drive.py patrol <params.json>`.
   The stock `start_patrol` stays a stub; the dead `/patrol` dashboard route that
   sent it is replaced.
2. **Route planned on the server.** From the zone polygons in the DB (local map
   metres, the same frame `nav_to_point` uses): every `spacing` metres along the
   border (default 6 m), step 1.0 m inward, keep the point only when it lies at
   least 0.8 m inside. (The first live patrol, with 0.6 m, had its checkpoints
   on occupied costmap cells, hedge overhang and the edge of the pool; the main
   cause was a map frame 1.57 m off its map, and 1.0 m is a mitigation for
   hedges and pool edges, not a fix for that.) At most 60
   checkpoints per patrol. The dock's zone first, the other chosen zones after
   it. The mower re-checks every point against its own zone files and skips
   points outside them.
3. **Between zones only over recorded channels or touching zones** (`edge_route`),
   like the edge cut. A zone without such a route is skipped and reported.
4. **Departure and docking are stock.** Docked: the firmware departs
   (`localize_via_firmware`, deck at its highest). Afterwards the drive returns into
   the dock's zone over channels, and the server sends `goHome()`, but only when the
   mower actually left (`PHASE patrolling` seen) and the user did not press stop.
5. **Blades never cut.** The extended handler sends blade speed 0 and deck level 7
   (90 mm, the highest; level 0 would be 20 mm, the lowest) the moment the patrol
   phase starts, as a guard behind the firmware departure. A guard that still fails
   after three attempts ends the patrol. A stopped or failed drive also releases its
   nav2 goal and the relaxed transit params; a drive taken over by a newer drive
   reports `stopped`. The drive owns the coverage task of its firmware departure:
   killed (SIGTERM) or failed before its handover, it stops and clears that task
   itself (`stop_task` + `quit_mapping_mode`), unless robot_decision is already in
   a recharge, and on its way out it cancels its own nav2 goal. The stop cleanup
   cancels only the goals accepted up to the stop (CancelGoal stamp), so the docking
   goal that follows survives it.
   Before its departure (on the dock nothing drives, so any is a leftover), after
   its handover and after clearing a parked task the drive also cancels the
   `navigate_through_coverage_paths` goals accepted so far (CancelGoal stamp, now):
   `quit_mapping_mode` clears robot_decision but leaves that goal paused in
   coverage_planner_server, and every coverage start after it was refused with
   error 125 until a refusal cancelled it (Walter, 2026-10-21: every departure left
   one for hours, the round of 21:30 never left the dock).
   Checkpoints, settle legs and the approach to a channel end once the mower is
   within `ARRIVE_M` (0.35 m) of the goal: the drive cancels the goal itself. nav2's
   own end asks for 0.1 m and a yaw; it ran 15-23 cm past the goal and then spun a
   wheel for minutes trying to turn there (Walter, 2026-10-21, at the channel
   map0->map1 and at a checkpoint). The mower looks in the direction it drove.
   After such a cancel the drive waits for nav2's result of the goal and 0.5 s
   more before its next goal: nav2 cancels its own FollowPath while it winds the
   goal down, and once took the channel's FollowPath sent in that gap with it
   (Walter, 2026-10-22, `followpath_aborted_status_5` on the way home).
6. **Headlight is set by the server** (`novabot/cmd/<SN>` `{led_set}`) on
   `patrolling`, and switched off (0) on every terminal phase before go_to_charge,
   so the patrol's bright light never reaches the dock marker; the mower then
   sets its own low docking light while the recharge runs (safety rules below;
   the dock LED itself stays stock, CLAUDE.md).
   The mower switches it off as well: the drive before it reports `done` or `error`
   and on a killed drive's way out, the handler when its drive did not end by
   itself. A stop, go-home or start during a patrol sends `led_set 0` before
   `stop_mow_zone` and the command.
7. **Looking.** At each checkpoint: perception re-asserted (idempotent), dwell
   `dwell_s` seconds (default 6) collecting points_labeled messages, per class the
   count reached in at least two messages ("steady count"), then one photo
   (`photo_topic`, default `front`).
8. **Reporting.** The mower POSTs every checkpoint (photo or empty body, scores,
   frame count, pose) to `/api/nova-file-server/patrol/uploadFrame`. The server
   keeps the last 30 runs (two nights of half-hour rounds) under `STORAGE_PATH/patrol/<sn>/<run>/`. A score at or
   above `patrol_min_points` (default 40) raises `patrol_detection` (category
   `patrol`), at most once per class per run per 2 minutes. A checkpoint with fewer
   than 2 perception frames is "no data": never an alert, never shown as all clear.
   A failed run raises `patrol_failed`.
   Every patrol run gets a random token (32 hex characters) from the server; the
   mower sends it with every upload, and the server only accepts uploads for the
   run it started, with the right token, within 6 hours (otherwise 403, nothing
   stored, no alert). The upload path is not behind the login gate, so without this
   anyone who knows a serial number could raise false alerts or push genuine runs out.
   The run, token and start time are on disk (`patrol_runs`), so a server restart
   in the middle of a patrol keeps taking that run's uploads.
   The end of a patrol survives a lost message: the mower re-sends its last
   `patrol_status` after every MQTT (re)connect while it is younger than 6 hours,
   and keeps it in `/userdata`; a patrol that was still running when the mower
   restarted is reported once as `error` `mower_restarted`. The server ignores a
   report of a run older than its current one and a phase on the way that arrives
   after its run's end, handles each run's end once, and takes a checkpoint of the
   current run as proof that it is `patrolling`. A
   `patrol_respond` with `result: 1` (refused before anything moved) is an `error`
   with `patrol_failed`, never a docking, and a schedule that started it shows it
   as failed.
   The text of `patrol_failed` says the mower *is being* sent to its dock: the
   go home has only started then. The server watches that drive home for 15
   minutes (until the mower charges, at most): a recharge that fails
   (`Recharge: FAILED` in the status, or error 126 coming up) while the
   mower is not charging raises one `dock_failed` with the patrol's context
   ("Docking after the patrol failed; the mower is standing still in the
   garden."), whichever signal comes first, and the run records the time
   (`patrol_runs.dock_failed_at`). Error 113 ("no aruco code find") raises
   nothing by itself: it comes up while the firmware retries the alignment at
   the dock and goes away again. The docking after a patrol raises no `docked`
   event either (within ten minutes of its first docked report): the run says
   how it went, and a window of rounds would otherwise ring the phone every
   half hour.
9. **Starting.** Dashboard and app button, and patrol schedules
   (`dashboard_schedules.kind = 'patrol'`). Patrol schedules are run by the server
   only: never sent to the mower as `timer_task` (the firmware would mow), never
   mirrored into the stock app's plans, not listed among mow schedules, they ignore
   the night guard and keep the frost guard. No rain pause for patrol.
   A patrol schedule is a **window with an interval** (added 2026-10-19): it
   starts a round at `start_time`, then one every `interval_min` minutes while
   the round's slot (`start_time + k * interval_min`) lies before `end_time`
   (`end_time` at or before `start_time` means the next day). `interval_min = 0`
   or no `end_time` is "once", the behaviour before this change. Each round is a
   normal patrol run. The weekday rule applies to the day the window starts.
   A later slot of the night is **skipped** (logged on the schedule, never an
   error) when: the previous round of this schedule tonight is still out; the
   mower is not charging on the dock; or the battery is below the patrol minimum
   (50 %). A round that ended in `error`, was `stopped`, or did not dock does
   **not** end the night (changed 2026-10-22, Walter: one round that failed at a
   channel ended the night at 22:00): a mower back on the dock goes out again at
   the next slot, a stranded one fails the dock check and stays where it is. A
   failure every round sends its notification every round; switching the
   schedule off ends the night. The first slot of a window keeps today's rules (the start guards
   only). A slot missed because the server was down is logged `missed` once,
   like a single start.
10. **Guards before a start:** online, OpenNova firmware whose
    `extended_commands` announces `patrol` (it publishes `ext_hello` with its
    command list after every connect; the server caches it per mower) or, when no
    announcement is cached, a build at or above `PATROL_MIN_BUILD` (the first
    build that ships `patrol`); not busy, no zone drive or edge cut running, no map
    operation, frame validated, battery at least 50 %, at least one checkpoint.
11. **Settings** (device_settings, written through the existing
    `POST /sensor-override/:sn`): `patrol_zones` (JSON array, empty = dock zone),
    `patrol_spacing_m` (3..15, 6), `patrol_dwell_s` (3..20, 6), `patrol_headlight`
    (0..100, 100), `patrol_min_points` (5..2000, 40), `patrol_photo_topic`
    (`front` | `front_hd` | `tof_gray`, `front`), `patrol_alert_repeat`
    (`round` | `night`, `round`: with `night` a kind at a checkpoint raises
    `patrol_detection` once in 12 hours, added 2026-10-20).

## Phase 0 gate: night test without driving

Before any driving code ships, `mow_zone_drive.py probe` runs on the dock at night
(no motion): cameras and the detection model on, headlight at 0 and at 100, a person
walking past at about 2, 4 and 6 m. It prints the per-second counts of labels 100/101
and saves one `front` and one `tof_gray` photo per light level.

Record in this file (section "Phase 0 result"):
- whether the `front` photo at 100 shows a person at 4 m;
- the steady counts for the person at 2/4/6 m, and the highest count with nobody there;
- the chosen `patrol_min_points` (midway between the empty-garden maximum and the
  6 m count) and `patrol_photo_topic`.

If neither photo nor counts show a person at 4 m, stop and report to Ramon: the
feature would be a blind drive.

## Safety rules

- No motion command to any mower without Ramon's explicit OK for that test.
- Blades off throughout; deck at its highest during the departure.
- Departure and docking are stock; we never reverse off the dock ourselves.
- Headlight at docking: the mower sets its headlight to a low docking value (1,
  the owner's decision; 30 was the value tested) as soon as a recharge runs and
  restores it afterwards. The server still sends `led_set 0` before every
  `go_to_charge`.
- Patrol only in a validated frame; frame-blocked like every other drive.
- Costmap detection layer on during the patrol, so people and animals (hedgehogs)
  are obstacles to the planner, and restored afterwards.
- Stop = `stop_navigation` (ends a firmware departure still under way) plus the
  existing `stop_mow_zone` (kills the drive, cancels the goal). The mower reports
  `starting` as soon as it accepts a patrol. While a patrol drives (`starting`,
  `localizing`, `patrolling`, `returning`), every stop, go-home or start command
  from the stock app, the dashboard, the OpenNova app or the server also sends
  `stop_mow_zone` first, as for a zone drive.
- The STOP button, lifting or tilting the mower end a patrol as `stopped` with that
  flag as its error (the edge cut's `/chassis_incident` watcher); the mower stays
  where it is, and the owner gets `patrol_failed` with the flag. The owner's own
  stop carries no flag and notifies nobody.
- A patrol and an edge cut never run together: a patrol is refused while an edge
  cut runs (by the server, and by the mower from the edge cut's start until its
  goal process ends), an edge cut while a patrol drives, and the mower's
  `start_edge_cut` ends a running drive first. The rain monitor and the mowing
  pushes leave alone a patrol that is out (a driving phase and a live run) and
  the drive home after it (until docked, at most 15 minutes). The always-edge
  watcher never arms while the cached patrol phase is a driving phase, with or
  without a run on the server.
- A patrol starts only through `POST /api/dashboard/patrol/:sn` (startPatrol,
  which records its run and upload token); a raw `patrol` on
  `POST /api/dashboard/extended/:sn` is refused with 409.

## Out of scope for this plan

SigLIP second opinion on photos, images inside push notifications (ntfy attach,
Expo rich content), siren/buzzer, live video during patrol, user-drawn routes,
theft/lift alarm, tap-to-open from a notification, rain pause for patrol.

## Known unknowns (verified in the live tests of the plan)

- Whether robot_decision's low-power mode switches the cameras off between
  checkpoints (mitigated: perception re-asserted at every checkpoint).
- Whether the firmware departure briefly spins the blades before our stop lands
  (mitigated: blade-off guard; watched in the first live test).
- Detection quality at night (Phase 0).
- Whether the release of a drive killed during its departure (`stop_task` +
  `quit_mapping_mode` in the init states) clears the departure task, or leaves it
  parked as USER_STOP (then a Resume could mow it until the next drive start
  clears it).
- That nav2 stamps goal acceptance in system time, which the CancelGoal stamp of
  the stop cleanup relies on (a docking goal accepted after the kill survives).
- That chassis_control reacts to `/led_set` from the blade relay's publisher (the
  handler's headlight-off when a drive did not end by itself).
- The memory cost of the `/chassis_incident` echo process for a whole patrol (a
  ros2 CLI process, 6 h timeout).
- A Home pressed while a zone drive or a patrol is still departing (`starting`,
  `localizing`) kills the drive, and the drive's release of its departure task
  (`stop_task`) may then cancel that Home; the owner presses Home again. To be
  checked in the live test.
- Whether headlight 1 gives the camera enough light for the marker at night (30
  did).

## First live tests

In this order, with Ramon present and his OK for each test. The mower side only
reaches a mower through a custom build (first build that ships `patrol`: 50).

1. Phase 0 night probe on the dock, no motion (section above); fill in "Phase 0 result".
2. First daytime patrol of the dock zone, watched. Stop at once if the blades spin
   during the firmware departure. Check that the photos and scores appear in the run
   listing, that the headlight is off before the docking, that the mower docks at the
   end, and that no "Mowing started" push arrives.
3. Stops, for a patrol and for a zone drive:
   - Stop during `localizing`: the release appears in the log within 3 s, robot_status
     is not executing afterwards, and a Resume in the app does not mow.
   - Home during `localizing`: note whether the mower docks or stays about 1 m out; if
     it stays, a second Home must dock it. The same with a Start.
   - Stop during `patrolling`: the mower brakes, and a Home afterwards docks (the
     docking goal survives the stamped goal cancel).
   - A stop while the drive still waits for the `start_cov` reply: the release still
     ends within 3 s.
4. STOP button, lifting, tilting: each ends the patrol as `stopped` with its flag, the
   mower stays, the light goes off, and the "stays where it stopped" push arrives. No
   flag is latched while the mower idles on the dock, and no tilt flag fires on slopes
   or in channels.
5. Headlight after `kill -9` of the drive: off through the blade relay's `/led_set`.
6. `ps` after a patrol and after an edge cut: no `ros2 topic echo /chassis_incident`
   left after about 2 s; the echo's memory over a whole patrol is acceptable.
7. Zone edge cut after a channel transit: `start_edge_cut` follows `edge_ready` promptly.
8. A patrol started during an edge cut's departure: refused with `edge_cut_running`, and
   the schedule shows it as failed.
9. Mower reboot mid-patrol: exactly one `mower_restarted`, and the docking decision is
   right (also for a mower carried back onto its dock). A status file older than 6 h
   reports nothing.
10. Server restart mid-patrol: the phase comes back through the re-announce, uploads
    are still accepted, and the end is handled once.
11. Far-zone Wi-Fi gap at the end of a patrol: the `done` arrives after the reconnect.
12. A drive under an `extended_commands` started with nohup over SSH survives the logout.
13. Occupied checkpoints: a checkpoint that nav2 refuses as occupied (hedge
    overhang, the edge of the pool) is retried once 0.6 m further inward; when
    that fails as well the point is skipped and the patrol goes on with the next
    one. Five unreachable checkpoints in a row end the run
    (`checkpoints_unreachable`). Check that a run with one blocked checkpoint
    skips it and finishes, and that the hedge side and the pool edge of the
    first live patrol (2026-10-15) no longer end the run.
14. Docking light: as soon as a recharge runs after a patrol the headlight goes
    to the docking value 1, and afterwards it is back at its earlier value. At
    night: the mower still finds the marker with 1 (30 did), and docks.

## Phase 0 result

(To be filled in by the Phase 0 test.)
