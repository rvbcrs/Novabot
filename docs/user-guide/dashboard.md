# The Dashboard

The dashboard is the web front end of your OpenNova server: the map, the
controls, schedules, settings, and everything the server knows about your
mower. Open **http://TARGET_IP/** (with `ENABLE_DASHBOARD: "true"` in your
compose, which the standard compose has). On a phone it switches to a
mobile layout with tabs for home, map, camera, schedules and history.

Most of it works on stock firmware. Where a feature needs custom firmware it
says so; the dashboard itself tells you too, and refuses with a clear message
rather than sending a command the mower would ignore. See
[Stock vs. Custom Firmware](stock-vs-custom-firmware.md) for the full split.

## Layout

- **Sidebar**: your devices. Click a mower to select it; the chips show
  battery, Wi-Fi (as a percentage, higher is better), RTK satellites and
  localization quality. Hover a chip for the last-seen time.
- **Header**: connection to the server, notifications (the bell), and the
  language.
- **Tabs**: Map, Schedule, Settings, Terrain, Work records.

## The map

Satellite imagery by default (in the Netherlands that is PDOK's aerial
photography, 8 cm per pixel); switch to a street map with the toggle. What is
drawn on it comes from the mower: work areas (green), obstacles (red), and
channels (the paths the mower drives between areas and to the dock).

**View menu**: show or hide the GPS trail, the Wi-Fi heat map, the coverage
overlay, and your own drone photo (below). The trail can be cleared.

**Dock menu**: the charging station's position. If it was never set, click
*Set charger position* and click the map. If you move it later the dashboard
asks a question that matters: *has the charger physically moved* (the maps
stay where they are on the ground) or *are you correcting its position on the
map* (the maps move along with it). *Calibrate charger* lets the mower
determine the dock position itself: it drives off, mows for about eight
seconds with the blades on, and parks again.

**Export**: all maps as an OpenNova ZIP, for backup or for another server.

### A drone photo under the map

Open aerial imagery is sharp enough to find your garden, not to trace a lawn
edge to the centimetre: it is taken at an angle and rectified against a
terrain model, so a hedge leans away from where it stands. A photo from your
own drone, straight down, has none of that. The dashboard can lay it under
the map as a tracing aid. It is only that: the mower never uses it.

View → **Drone photo** → *Upload*. A JPEG or PNG from a DJI or similar drone
lands roughly in the right place by itself: position from the photo's GPS,
size from the flight height and the lens, heading from the gimbal. A plain
screenshot lands at the map centre, 60 m wide.

Then **Place**: a panel you can drag out of the way, and three ways to get
the photo exactly right.

1. **Drag** the photo, and the sliders for rotation and width. They pivot on
   the charging station when it is in the photo, so the one point you know
   stays put while the rest swings around it.
2. **Pick points**. Click the charging station in the photo (the photo jumps
   so it sits on the dock), then a recognisable spot in the photo and where
   that spot really is on the map. Two points fix shift, rotation and scale.
   With **four or more**, spread far apart, the dashboard also straightens a
   photo taken with the camera not quite straight down. Every picked point is
   drawn: where the photo point currently lies, a line to where it belongs,
   and its deviation in centimetres. One point with a large deviation is a
   misclick, a roof, or a treetop; remove it with its ×.
3. **Save**. Opacity is a slider too.

What "where it really is" means: the mower's own lines. Zones, obstacles and
channels were driven with RTK to a few centimetres; that is the frame you
will trace in. Do not align to the aerial imagery.

!!! note
    The mower's lines sit about 20 cm inside a lawn edge and 20 cm outside an
    obstacle: they are the path of the mower's centre. A single photo also
    cannot put a roof on its footprint. Expect a few centimetres, not zero.

## Mowing

The control panel for the selected mower.

- **Start**, with a work area (one, or all), the cutting height (2 to 9 cm)
  and the mowing direction (eight compass headings; the stripes on the map
  show how the mower will drive). Then **Pause**, **Resume**, **Stop**, and
  **Go to charger**, which asks whether to end the task or only pause it.
- **Edge offset**: shrink or expand the area the mower cuts along the border,
  in centimetres, without redrawing the zone.
- **Edge cut** (custom firmware): mow only the boundary of a zone, the
  trimming pass.
- **Pattern**: pick a pattern, click the map to place it, set its size and
  rotation, and mow that shape instead of the whole area. Works on stock
  firmware: it is sent as a plain polygon.
- **Emergency stop**: always visible, stops everything.
- **Why is it on the dock?** appears when the mower returned by itself:
  rain, low battery, time limit, a fault, sent home by hand, or simply done.
  With a *Resume* that fits the reason, including *ignore rain and resume*.

While it mows, the status card shows progress, area covered, blade speed,
elapsed time and the estimate for what is left.

## Editing maps

!!! warning "Custom firmware"
    Drawing and editing areas needs custom firmware: the changes are written
    to the mower's map files, and stock firmware only accepts maps driven
    with the app. On stock you can still look, place the drone photo, and
    export.

Edit menu → **Draw a new work area**, or click an existing area, obstacle or
channel to select it. Then:

- **Paint / erase** with an adjustable brush, **expand** and **shrink** by a
  margin, **copy / paste**, **move** the whole shape, **undo / redo**.
- **New obstacle**: draw a no-go zone inside an area. **Delete** an obstacle,
  a channel, or a whole area (the mower confirms it actually removed the
  files; the dashboard only forgets it after that).
- **Channels**: the corridors between areas and to the dock. A drawn channel
  becomes a real corridor in the mower's navigation map.
- **Apply to mower** sends the result; **Revert** throws the edits away. The
  panel says when something is pending or needs a resync.
- **Coverage preview**: ask the mower how it would cover the area and see the
  planned path. There is also a live coverage overlay while it mows.
- **Shift mowing area**: nudge everything a few centimetres north, south,
  east or west. This moves where the mower cuts, not just the picture. For a
  picture-only correction use **Display alignment** (satellite view only).

The app and stock firmware cap the number of work areas at five. Custom
firmware from `custom-42` lifts that; *Why is it not coming online?* warns
when a mower has more zones than its firmware can run.

## Manual control

- **Joystick**: drag to drive, three speeds. Unavailable while a task runs;
  stop it first.
- **Blade** on/off (custom firmware) with a cutting height chosen first; not
  on the dock.
- **Headlight**, **sound**, **snapshot**, **reboot**.
- **Camera** (custom firmware): front, front HD, ToF grey and ToF depth from
  the obstacle sensor, and the ArUco view the docking uses.

## Mapping

Maps are normally driven with the app over Bluetooth (see
[Map Building](../flows/map-building.md)). The dashboard adds:

- **Start mapping** from here, with GPS and localization checked first.
- **Autonomous mapping** (custom firmware): the mower follows the lawn edge
  by itself, within a geofence radius you set, and records the boundary. A
  *test drive* mode drives without recording. When it finishes you review
  the map on the map view and accept or reject it. See
  [Autonomous Mapping](autonomous-mapping.md).

## Re-anchor after a restore

After a map restore the map frame must be re-anchored on the dock, and the
dashboard says so with a banner. One button runs the sequence: dock the mower
(charging), wait for RTK Fixed, start. Sometimes it needs you: drive about a
metre straight back with the joystick, or put the mower half a metre in front
of the dock and press *Start docking*. Details in
[Map Backup & Restore](map-backup-restore.md).

## Schedules

Schedule tab → **New**: a name, start and end time, days, work area, cutting
height and direction. Then the parts that make it useful:

- **Alternate direction** every *n* runs, so the lawn is not always striped
  the same way.
- **Edge days**: which days the run includes the edge pass.
- **Pause on rain**: the server watches the forecast for your location and
  pauses a run when rain is expected, with a threshold in mm/h or chance, and
  how many hours ahead to look. The mower returns to the dock and resumes
  when it is dry; you can override per session.
- **Skip next run**, and a timeline of what will run when.
- Overlapping schedules are flagged.

Schedules are server-side: the server starts the mower, so they work on stock
firmware and do not depend on the app being open.

## Settings

Obstacle sensitivity, maximum speed and handling, headlight, speaker,
default cutting height and direction, timezone (must match the app, or
schedules shift), rain auto-pause thresholds, week start, 24-hour clock,
the mower's nickname, and the anti-theft **PIN** (query, set, verify).
*Save to mower* writes the mower-side settings; the rest is server-side.

**AI perception** (custom firmware): the camera model's mode. *Segment*
classifies every pixel (lawn, path, obstacle) and is the default; *Detect*
looks for people, animals and objects; the high and low sensitivity variants
trade caution for closeness to edges. The navigation mode chooses between
*lawn only*, *free move* (drives over paths, for crossing a driveway) and
*boundary follow*.

## Terrain

A 3D view of the garden built from what the mower's sensors saw: detected
objects (trees, bushes, furniture, a trampoline, the charging station and so
on) with a confidence, which you can correct or remove, and your own objects
with a footprint and height. Models can be swapped for a custom `.glb`. The
camera can follow the mower.

## History and diagnostics

- **Work records**: every mowing session with date, duration, area and
  cutting height.
- **Signal history**: battery, Wi-Fi, RTK satellites and CPU temperature
  over hours or days.
- **Notifications**: what the server pushed (the bell in the header).
- **MQTT log**: the live traffic between server, mower and charger, with a
  filter. Useful when reporting a problem.
- **Why is it not coming online?** on every device card: the connection
  diagnosis. It checks the server (disk, a competing MQTT broker, the
  container's network, mDNS), reachability (whether `mqtt.lfibot.com` points
  here, whether the device answers, Wi-Fi), and the connection itself, and
  names the first thing that blocks, with what to do about it. On custom
  firmware it also logs into the mower and checks from that side, including
  whether the mower hears `opennova.local`. Attach its output to a bug
  report.

## Adding a device

Sidebar → **Add device**: the serial number and the BLE MAC address. The
dashboard can scan for nearby devices over Bluetooth when the server has a
Bluetooth adapter (a Raspberry Pi does; a container on a NAS usually does
not), or you enter the MAC by hand. Provisioning itself, telling the device
where the server is, is done with the [OpenNova app](opennova-app.md) or the
[bootstrap tool](../guide/bootstrap.md).
