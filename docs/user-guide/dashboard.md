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

**Base layer** (button in the map toolbar): satellite (default), your uploaded
drone photo, or a **3D render** of the real garden built from the mower's map,
with a day and an evening version picked by the clock. See
[3D Garden Render](../guide/garden-render.md).

## Editing maps

!!! warning "Custom firmware"
    Drawing and editing areas needs custom firmware: the changes are written
    to the mower's map files, and stock firmware only accepts maps driven
    with the app. On stock you can still look, place the drone photo, and
    export.

Edit menu → **Draw a new work area**, or click an existing area, obstacle or
channel to select it. Then:

- **Paint / erase** with an adjustable brush, **expand** and **shrink** by a
  margin, **copy / paste** an obstacle, **undo / redo**.
- **Nudge** a work area or obstacle that sits a little off: drive the mower
  onto a corner of it, press Pick a point and click that corner of the shape.
  The mower's measured position is the truth, so there is no dragging on the
  photo; two corners also show the residual. A zone and its obstacles shift
  together as a draft; Apply to mower sends it. A pasted obstacle opens Nudge
  right away, and a copied zone re-runs its copy from the corrected source
  dock.
- **New obstacle**: draw a no-go zone inside an area. **Delete** an obstacle,
  a channel, or a whole area (the mower confirms it actually removed the
  files; the dashboard only forgets it after that).
- **Channels**: the corridors between areas and to the dock. A drawn channel
  becomes a real corridor in the mower's navigation map.
- **Copy zone from another mower**: put a work area (with its obstacles)
  that another mower on this server drove onto this mower's map. Pick the
  source mower and zone, then drag the orange marker to where the *source
  mower's* charging station really stands on this map; the zone follows.
  Two mowers never share a GPS frame (each charger broadcasts its own
  surveyed RTK base position), so this one physical reference is what
  places the copy. The preview shows the zone dashed, with the dock
  channel or the proposed channel to a neighbouring zone. A first zone must
  lie within 3 m of the dock; a later zone that overlaps or sits within
  1.5 m of an existing zone gets a channel proposed, otherwise the usual
  "draw a channel" prompt follows. After placing, check the coverage
  preview before the first mow.
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

## Night patrol

The Patrol button appears in the control bar once you enable **Experimental
features** under Settings. With that switch off, the button and its panel are
hidden and nothing else changes: the server still runs a patrol schedule that
is on, and patrol events still show in the notification bell.

!!! warning "Custom firmware 50 or newer"
    Night patrol needs OpenNova custom firmware **50 or newer**. On stock
    firmware, or on an older custom build, the dashboard refuses to start it
    and says why. (Stock firmware has a `start_patrol` command, but it only
    answers and does nothing.)

On a button press, or every night on a schedule, the mower leaves its dock,
drives a route through the garden and stops at checkpoints to look with its
camera. When it sees a person or an animal, the server sends you a
notification. It takes a photo at every checkpoint it reaches, so you can look
through the round afterwards; a checkpoint can lack a photo when the camera
gave nothing. At the end the mower drives back and docks the same way it does
after mowing.

A patrol never mows. The mower leaves the dock the normal way, with the
cutting deck raised to its highest position, and the blades are switched off
as soon as that departure is done.

The server plans the route: a checkpoint about every 6 m along the inside of
each chosen work area, 60 at most. Between work areas the mower only drives
over a recorded channel or where two areas touch, like the edge cut does; an
area it cannot reach that way is skipped.

The **Patrol** button sits in the control bar over the map, right of the home
button (on a narrow screen it is just the moon icon). A click starts a patrol.
The small chevron next to it opens the **patrol panel** under the bar, the way
the Mapping button opens its panel. Opening one of the bar's panels closes the
others.

- **The Patrol button.** Idle, one click starts the patrol. As soon as the
  mower has accepted it, which is before it leaves the dock, the button turns
  into a red **Stop patrol**, and it stays that until the mower is back. A
  refusal comes up as the bar's usual red message, with the reason. Stop ends
  the drive where the mower stands and does not send it home; use *Go to
  charger* for that. The normal stop and go-to-charger buttons, in the apps
  too, end a patrol as well. So do the STOP button on the mower and lifting or
  tilting it: the patrol then ends where the mower stands, and you get a
  *Patrol stopped* notification. The docking at the end of a round raises no *Mower
  docked* notification: with a window of rounds that would ring every half
  hour. While a patrol drives, the button's tooltip
  says what it is doing.
- **Greyed out.** While an edge cut or a drive to a zone holds the wheels, the
  button is greyed out, and its tooltip and an amber line in the panel say why.
  Wait until that drive is over, or stop it first. While the mower is offline
  the button is greyed out too, and only its tooltip says so. After a start was
  accepted the button also stays off for a few seconds, until the mower
  reports in.
- **Phase line.** The panel opens with it. It says what the patrol is doing:
  ready, starting, finding its position, on patrol, coming back, back and
  docking, stopped, or the reason that stopped it, in words (the STOP button was
  pressed, it was lifted, no zone is recorded around the charging station, and
  so on). After a finished patrol, once the mower stands on the dock again, it
  says ready.
- **Skipped areas and checkpoints.** When the mower cannot reach a chosen work
  area it leaves that area out, and the panel shows *Skipped: area (reason)*
  under the phase line. A single checkpoint it cannot reach is listed as
  *Skipped checkpoints: 3, 7 (unreachable)*. These come from live reports from
  the mower, so you only see them when the dashboard was open while the patrol
  ran, and they are gone after a reload.
- **Zones.** One checkbox per work area. With none ticked, the patrol covers
  the area the dock stands in.
- **Headlight.** A switch for the mower's headlight during the patrol, on by
  default. The light goes on once the mower drives and goes off again before
  it docks; while it docks the mower uses its own low docking light, so the
  dock marker is never overexposed by the patrol light. The mower
  switches it off itself at the end of a patrol too, also when the server
  misses that end.
- **Detection alerts.** *Every round* (the default): every round that sees a
  person or an animal sends a notification. *Once a night per checkpoint*: the
  same kind at the same checkpoint is reported once a night (12 hours), so a
  statue or a cat that stays put does not ring every round; another
  checkpoint, or the other kind, is still reported. The report shows every
  photo either way.
- **Every night from HH:MM until HH:MM, every N min.** One patrol schedule per
  mower: a window, an interval and an on/off switch. *Once* is a single round
  at the start time. With an interval the server starts a round at the start
  time and then every N minutes while the round's start lies before the end
  time (an end at or before the start means the next morning). The server
  starts them by itself, so no app needs to be open. A later round is skipped,
  and the schedule says why, when the previous round is still out, the mower is
  not charging on the dock, or its battery is under 50 %. A round that failed
  or was stopped does not end the night: once the mower charges on the dock
  again, the next round starts. A mower that did not get back on the dock is
  not sent out. To end the night, switch the schedule off. Patrol schedules do not appear in the
  Schedule tab or in the stock app's plans. *No mowing after dark* does not
  hold them back; *No mowing in frost* does (Settings → Weather & time). Rain
  does not pause them.
- **Last patrol.** The latest patrol, with the photo of each checkpoint (a
  checkpoint can lack a photo), labelled *person*, *animal*, *nothing* or
  *no camera data*. The **Report** button beside it opens the full report of
  that patrol.
- **Last patrols.** One line for each of the last 30 patrols, grouped per
  night (a night runs from one noon to the next): when it started, how many
  checkpoints it reached (out of how many were planned), how many it skipped,
  how many checkpoints showed a person and how many an animal, and how it
  ended: done, stopped, failed or still running. A click on a line opens the
  report of that patrol.

*No camera data* means the camera gave nothing usable at that checkpoint
(fewer than two detection readings), so nobody knows what was there. It does
not mean the garden was empty. Such a checkpoint never raises a notification
and is never counted as all clear.

### The route on the map

While the patrol panel is open, and while a patrol is out, the map shows the
route as numbered circles in driving order, with a dashed line through the
checkpoints of each work area. A second dashed line joins the last checkpoint
of one area to the first of the next, along the channel recorded between them.
The colour says where the patrol is:

- grey: not visited yet
- blue and pulsing: the checkpoint the mower is heading for (none while it is
  coming back, since the round is over by then)
- green: reached
- red with a cross: skipped, because the mower could not reach it or left its
  whole area out

The dashed line is the order in which the mower visits the checkpoints. It
stays inside the work area and is drawn around the recorded obstacles (the red
areas, by their outline with a margin), because the mower plans in the mapped
area and around them, but it is not the exact path the mower's navigation
takes. Between two work areas it follows the channel recorded between them;
two areas that touch need none. Without a channel or a shared border the
dashboard draws no line between the two areas, and a checkpoint it cannot
place inside its area (an older report of an area that has since changed, or
an area that no longer exists) gets no line either; the numbers still give the
order. The solid cyan line is where the mower actually drove. The dashboard draws it
while a patrol is out, ending at the mower, and leaves a gap where the position
jumps by more than 5 m between two reports (a dropout), instead of a straight
line across it. It can only
draw what it sees while the page is open: it keeps the lines of the last 6
patrols of the mower you have selected, and the report of a patrol shows its
line only if that patrol's checkpoint reports reached the page. A reload clears
them.

With the panel open and no patrol out, the circles show the route a patrol
started now would drive, all grey. They change when you tick or clear a zone.
While a patrol is out they follow the mower's reports, so you can watch it
work through the route, also with the panel closed. While a report is open,
the map shows the checkpoints of the patrol you picked, as that patrol ended.
Closing the panel, with no patrol out, takes the circles away again. They
never move or zoom the map. Like the rest of the patrol, they need the
Experimental features switch.

### The patrol report

The report opens as a large dialog, and full screen on a phone. At the top is
a summary: when the patrol started, how many checkpoints it reached (out of how
many were planned), how many it skipped, how many showed a person and how many
an animal, and how it ended. When the patrol failed, or the mower stopped it
itself (the STOP button, a lift or a tilt), the reason is there in words. If
the mower did not manage to dock after the patrol, the summary says so, with
the time.

Under the summary is the photo of the selected checkpoint, large. Next to it
(below it on a phone) are the details: the checkpoint number out of the total,
what was seen, the time, the work area, the position in metres, the person and
animal points (the scores the camera gave there), the number of camera frames
behind them, and whether it raised an alert. A checkpoint without a photo
shows a placeholder. The report opens on the first checkpoint that showed a
person or an animal, or on the first checkpoint when nothing was seen.

Step through the checkpoints with the arrows beside the photo or with the left
and right arrow keys; Home and End jump to the first and the last. Escape
closes the report. A strip of thumbnails under the photo lists every
checkpoint of the route. Its border shows what was seen: red for a person,
amber for an animal, green for nothing and grey for no camera data. A
checkpoint the mower skipped has a red cross, and one it never got to has a
dashed outline. The menu at the top picks another of the last 30 patrols, and
the map follows the choice.

A server that does not record the route yet still gives the panel and the
report, but without the circles on the map, without the *out of* and *skipped*
counts, without how a patrol ended, and with only the checkpoints that left a
photo or a result in the strip.

The photos and results of the last 30 patrols are kept on your own server;
older ones are deleted. A notification is text only, the photo is in the panel
and the report.
A person or an animal gives a *Patrol alert* (at most one per kind every two
minutes during a patrol), and a patrol that stops with an error gives
*Patrol stopped*. See [Notifications & Push](../guide/notifications.md).

The dashboard refuses to start a patrol, and says why, when the mower is
offline or busy with a task, an edge cut or a map operation, when its map frame
is not validated yet, when the battery is below 50%, or when there is no
checkpoint to visit. An edge cut, in turn, does not start while a patrol drives.

!!! warning "It drives at night"
    Keep the garden clear of anything the mower should not meet. During a
    patrol the camera's detection layer is on, so a person or an animal such
    as a hedgehog is treated as an obstacle that the mower plans around. That
    helps the route planner; it is not a guarantee.

## Settings

Obstacle sensitivity, maximum speed and handling, headlight, speaker,
default cutting height and direction, timezone (must match the app, or
schedules shift), rain auto-pause thresholds, week start, 24-hour clock,
the mower's nickname, and the anti-theft **PIN** (query, set, verify).
*Save to mower* writes the mower-side settings; the rest is server-side.

**Weather & time** also holds two guards for scheduled runs, both off by
default: *No mowing after dark* skips a run between sunset and sunrise
(hedgehogs), *No mowing in frost* skips it when the forecast for the current
or next hour is below the chosen temperature. Manual starts are never
blocked. **Help → Report a problem** opens a GitHub bug report with the
server version, mower SN, firmware and last error filled in.

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
  cutting height. Above the list: totals for this week, month and year, and
  a **Blades** card counting mowing hours since the last blade change
  against a reminder interval (default 60 h); *Mark replaced* resets it.
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
where the server is, is done with the [OpenNova app](opennova-app.md).
