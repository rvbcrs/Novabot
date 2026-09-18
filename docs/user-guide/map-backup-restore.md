# Map Backup + Restore Flow (Authoritative)

> Live-verified end-to-end on LFIN2230700238 (custom firmware v6.0.2-custom-33), 2026-05-21.
> Supersedes: `recovery-playbook-maps.md`, `map-zip-flow.md`, `sync-map-anchor-flow.md`,
> `map-frame-realign-after-reboot.md`, `polygon-rotation-bug.md`, the apply-polygon-offset
> recovery procedure — those covered ad-hoc patches; this is the structured flow.

> **⚠️ Re-anchor step: see `docs/reference/REANCHOR.md` (authoritative).**
> The descriptions in this file of the post-restore frame fix as an *"ArUco
> re-alignment / ArUco snap"* are **WRONG and superseded**. Localization is
> GPS/RTK only and has no ArUco input; ArUco only drives the final visual dock
> approach. Re-anchoring re-derives the UTM origin in `pos.json` from the dock's
> RTK-**Fixed** GPS (`reanchor_pos` + `/load_utm_origin_info`) and lets the mower
> re-lock by driving — it is NOT an ArUco trick and does NOT recalibrate the
> charger marker. The `refresh-dock-anchor` endpoint below is the older flow;
> the current one-button path is `POST /api/dashboard/reanchor/:sn` (`auto`).

## What this covers

A complete backup of all map state (polygons, raster, dock pose, UTM anchor) and
restore that brings the mower back to a usable mowing state, even when the
local map frame has shifted between export and restore.

## Glossary

- **Bundle** (`.novabotmap`): zip with `metadata.json`, `polygon.json`, `polygons.json`,
  `obstacles.json`, `unicom.json`, geojson exports, plus a `mower/` tree mirroring
  the mower's on-disk state at export time (csv_file/, charging_station.yaml,
  pos.json, map.yaml/pgm/png, map0/1/2.yaml/pgm/png).
- **csv_file/** and **x3_csv_file/**: same CSV polygon files in two directories
  on the mower. Firmware reads from both depending on code path; always write
  both.
- **charging_pose**: the dock's pose `(x, y, theta_rad)` in the mower's local
  map frame. Stored in `map_info.json` (inside csv_file/) and in
  `/userdata/lfi/charging_station_file/charging_station.yaml`.
- **pos.json** (`/userdata/pos.json`): UTM ↔ local frame anchor. Sets where the
  local frame's `(0,0)` sits in world coordinates.
- **Local map frame**: the coordinate system in which all polygons and dock
  poses are expressed on the mower. Its world anchor is the UTM origin in
  `pos.json`. Re-anchoring after a restore re-derives that origin from the
  dock's RTK-Fixed GPS (`reanchor_pos`); see `docs/reference/REANCHOR.md`. (It
  is NOT pulled back by "ArUco re-alignment" — localization has no ArUco input.)

## Endpoints (server side)

| Endpoint | Purpose |
|---|---|
| `GET /api/admin-status/maps/:sn/export-portable` | Download a one-off bundle |
| `POST /api/admin-status/maps/:sn/portable-backups` | Create + retain (auto on every save_map) |
| `GET /api/admin-status/maps/:sn/portable-backups` | List retained snapshots |
| `POST /api/admin-status/maps/:sn/portable-backups/:filename/restore` | One-click restore an existing snapshot (auto-picks verbatim if same SN, else exact) |
| `POST /api/admin-status/maps/:sn/import-portable` | Multipart upload a bundle |
| `POST /api/admin-status/maps/:sn/import-portable/:stagingId/apply-verbatim` | Same-SN restore. Pushes csv_file/, charging_station.yaml, map.yaml/pgm/png + per-slot rasters, **without** touching pos.json. Polygons stay in the bundle's original frame. |
| `POST /api/admin-status/maps/:sn/import-portable/:stagingId/apply-exact` | Cross-frame restore. Reads live `map_position`, computes Δ vs the bundle's `originalChargingPose`, rewrites every CSV point + charging_station.yaml in the current frame. **Does not ship raster** — relies on save_map type:1 (currently broken without an active mapping session, see Known Issues). |
| `POST /api/admin-status/maps/:sn/refresh-dock-anchor` | Trigger dock-cycle to refresh UTM anchor. Modes: `manual` (instruction text) or `auto` (server drives mower 1m back + go_to_charge). |

## The complete restore flow

```
┌───────────────────────────────────────────────────────────────────┐
│ 1. EXPORT (anytime the mower has a known-good state)              │
│   POST /maps/:sn/portable-backups  → bundle saved server-side     │
│   Auto-triggered on each successful save_map (last 20 retained).  │
└───────────────────────────────────────────────────────────────────┘
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│ 2. (optional) WIPE — for a clean-slate restore test               │
│   ssh root@<mower>                                                │
│     mv /userdata/lfi/maps/home0 /userdata/lfi/maps/home0.bak.$(date +%s) │
│     mkdir -p /userdata/lfi/maps/home0/csv_file                    │
│     mkdir -p /userdata/lfi/maps/home0/x3_csv_file                 │
│   server DB: DELETE FROM maps WHERE mower_sn = ?                  │
└───────────────────────────────────────────────────────────────────┘
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│ 3. RESTORE                                                        │
│   Admin page → Map tab → Restore on a snapshot                    │
│   Server auto-picks verbatim (same SN) or exact (cross-frame).    │
│   - VERBATIM: ships full mower tree 1:1 except pos.json.          │
│     restart_mapping: false — touching novabot_mapping mid-flight  │
│     leaks iceoryx shm chunks (pool=50) and triggers Error 140     │
│     after a few cycles. Refresh of caches happens via the         │
│     save_map type:1 + regenerate_per_map_files trigger fired      │
│     after write_map_files lands.                                  │
│   - EXACT: Δ-transforms each polygon point + writes new           │
│     charging_station.yaml from current dock pose.                 │
└───────────────────────────────────────────────────────────────────┘
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│ 4. DOCK ANCHOR REFRESH (REQUIRED before mowing)                   │
│   After restore the admin page shows a 3-choice modal. Pick one:  │
│   - Manual: lift the mower off the dock briefly and place it      │
│     back, OR use the joystick to drive 1m off and re-dock.        │
│   - Auto: server sends start_move:4 → 5s mst back velocity →      │
│     stop_move:{} → go_to_charge:{}. Mower drives 1m, then         │
│     navigates back through the full ArUco docking sequence.       │
│   - Skip: do later. Do not mow until completed.                   │
│                                                                   │
│   The redock re-locks localization; it is NOT an "ArUco snap".    │
│   Localization is GPS/RTK only. Reliable path: the auto re-anchor │
│   (reanchor_pos = pos.json origin from the Fixed dock GPS, then    │
│   drive to re-lock). See docs/reference/REANCHOR.md.              │
└───────────────────────────────────────────────────────────────────┘
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│ 5. MOW                                                            │
│   Start mow on a map. Coverage planner reads CSVs from disk on    │
│   each new task, so the freshly-restored polygons are used        │
│   without further restarts.                                       │
└───────────────────────────────────────────────────────────────────┘
```

## Why the dock cycle is the whole game

`pos.json` defines the UTM ↔ local-frame anchor. On any `novabot_launch`
restart `robot_combination_localization` rebuilds its TF graph from scratch
(fresh GPS, fresh IMU bias). The resulting local frame's `(0,0)` may end up
shifted by a meter or two from where it was at export time.

The bundle restore puts polygon CSVs back in their EXPORT-TIME frame. If the
current local frame disagrees, polygons drawn on disk no longer map to the
physical garden the mower is in.

The fix re-anchors the UTM origin in `pos.json` to the dock's true RTK-**Fixed**
GPS, then lets the mower re-lock by driving. **This is GPS/RTK, not ArUco** —
localization has no ArUco input (ArUco only drives the final visual dock
approach). The reliable, explicit version is `reanchor_pos` +
`/load_utm_origin_info`, orchestrated by `POST /api/dashboard/reanchor/:sn`
(`auto`). See `docs/reference/REANCHOR.md` for the full mechanism, the
debunked theories, and why the marker must NOT be recalibrated to chase a bad
frame.

Verified 2026-05-21 on LFIN2230700238: after verbatim restore the mower
reported `map_position = (-2.02, 0.35, -1.59)`; bundle charging_pose was
`(0, 0.06, -1.518)`. After a dock cycle: `map_position = (0.004, 0.110, -1.643)`
≈ origin. **Why it worked (correct attribution):** the drive-off re-init let
`gpsCallback` re-derive the origin from the live GPS — the implicit version of
what `reanchor_pos` now does explicitly. It was NOT an "ArUco snap". (And on a
day the rover was on RTK Float, that same drive re-anchored onto a ~2 m-off fix
— which is the whole reason `reanchor_pos` now gates on a real Fixed.)

## Why we do not ship pos.json in apply-verbatim

Earlier versions shipped bundle pos.json. Problem: bundle pos.json captures
the UTM anchor that was correct AT EXPORT TIME. The mower may have docked
several times since (each rewriting pos.json with newer anchors). Restoring
the old pos.json clobbers progress and creates an immediate frame
inconsistency.

Apply-verbatim now skips pos.json. The mower's own next dock event refreshes
it. Apply-exact has never shipped pos.json (it writes a fresh
charging_station.yaml from live map_position; pos.json stays whatever the
mower already has).

## Why we do not restart novabot_mapping after write_map_files

iceoryx is configured for 50 chunks in the shm pool. Killing
novabot_mapping (and coverage_planner_server, which it depends on) without
clean shutdown leaves chunks stranded. After a couple of restore cycles the
pool fills (50/50 in_use), new processes can't acquire chunks on init, they
crash silently, and robot_decision's health check raises Error 140 every
5 seconds. Recovery requires `systemctl restart novabot_launch` (drains
iox-roudi + restarts every ROS node).

Apply-verbatim and apply-exact both use `restart_mapping: false`. The
firmware's own save_map type:1 + regenerate_per_map_files combo refreshes
caches without bouncing the process.

## Known issues

### A cloud import/restore does NOT preserve inter-map channels

Inter-map channels (the `mapXtomapY_..._unicom.csv` connectors between work
areas) are stored as metadata-only / 0-byte files. When two zones touch the
firmware writes the connector with no geometry; it only records that the zones
are connected (no driveable corridor is needed when they touch). See
`portableBackup.ts` ("legitimately metadata-only (0-byte)... regeneration needs
every unicom file present to connect the zones").

The LFI cloud does not carry these empty connector files across an export, so a
**cloud import + push to the mower loses every inter-map channel**. The app then
reports a missing channel and the mower cannot route between zones. There is no
way to recover the channels from the cloud, because they were never stored there
with any content to restore.

What works:

- The channels are intact in the mower's **original** files. As long as you do
  not overwrite the mower with a cloud restore, multi-zone mowing keeps working.
- To preserve channels across a wipe/restore, use an OpenNova **portable
  snapshot**. The portable backup keeps every connector file present (including
  the 0-byte ones), which is what the regeneration needs to reconnect the zones.
  A cloud import does not.

This is a cloud-storage limitation, not an OpenNova restore bug. (GitHub #81.)

### Apply-exact does not ship raster

Apply-exact pushes only CSVs (Δ-transformed). It expects `save_map type:1`
to regenerate `map.yaml/pgm/png` from the freshly written CSVs, then
`regenerate_per_map_files` mirrors that into `map0/1/2.yaml/pgm/png`. Live
test 2026-05-21: `save_map type:1` outside an active mapping session
returns `"all the edge data is empty, please recording edge before"` and
writes nothing. After apply-exact from a wiped state the raster files are
missing → Nav2 has no costmap → start_navigation fails.

Workaround: use apply-verbatim (which ships raster directly) for now. To
make apply-exact self-sufficient, server-side raster generation from the
new CSV coordinates would be needed.

### Apply-verbatim must be on same SN

Cross-mower restore via apply-verbatim is blocked unless `?force=1` is
passed. Without the guard the source mower's pos.json (and identity
implications further down the stack) would clobber the target. Use
apply-exact for cross-mower migration — its Δ-rotation produces a
correctly-framed result regardless of source SN.

### Dock-anchor auto mode requires mower already on dock

`refresh-dock-anchor mode=auto` returns 409 if `battery_state != Charging`.
The sequence needs to start from a known-good baseline (mower at dock,
about to drive 1m back). If the mower is already off-dock, just use the
app to send go_to_charge directly.

### Stock binary does not write pos.json on docking

Our open `mower/robot_decision.py:2309` calls `save_utm_origin()` on
`result.code == 100` SUCCESS. The stock binary has the
`save_utm_origin_info` ROS service registered but our live test on
LFIN2230700238 (stock binary) showed pos.json mtime unchanged across a
manual dock cycle. The frame still came back to ~origin — **not via an
"ArUco snap"** (localization has no ArUco input) but because the drive-off
re-init let `gpsCallback` re-derive the origin from the live GPS. The current
re-anchor does this explicitly and works on the stock binary too:
`reanchor_pos` writes pos.json + calls `/load_utm_origin_info` directly, so it
does not depend on the open-decision drop-in. See `docs/reference/REANCHOR.md`.

## Quick reference

```bash
# Sanity check before restoring
curl -s http://<server>/api/dashboard/devices | jq '.[] | select(.sn=="<SN>") | .sensors | {error_status,battery_state,map_position_x,map_position_y}'

# After restore, modal asks for refresh. Manual instructions:
#   Pick the mower up briefly and place it back on the dock, OR use the
#   joystick to drive ~1m off and back.

# Verify after redock
curl -s http://<server>/api/dashboard/devices | jq '.[] | select(.sn=="<SN>") | .sensors | {map_position_x,map_position_y,map_position_orientation}'
# map_position should be within ~10cm of charging_station.yaml charging_pose
```

## Files touched on the mower

After a successful verbatim restore + dock cycle:

| Path | Source |
|---|---|
| `/userdata/lfi/maps/home0/csv_file/{map0_work,map1_work,...}.csv` | bundle |
| `/userdata/lfi/maps/home0/csv_file/map_info.json` | bundle |
| `/userdata/lfi/maps/home0/x3_csv_file/...` | mirror of csv_file |
| `/userdata/lfi/maps/home0/map.{yaml,pgm,png}` | bundle |
| `/userdata/lfi/maps/home0/map0.{yaml,pgm,png}` | bundle |
| `/userdata/lfi/maps/home0/map1.{yaml,pgm,png}` | bundle |
| `/userdata/lfi/charging_station_file/charging_station.yaml` | bundle (verbatim) or live map_position (exact) |
| `/userdata/pos.json` | **untouched by restore**, refreshed by mower's own dock flow on next save_utm_origin |
