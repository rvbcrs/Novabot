# OpenNova App

The OpenNova app is the community-built replacement for the stock Novabot app. It connects to your OpenNova server (not the LFI cloud) and gives you everything the original app does — pairing, mapping, mowing, schedules, history — plus what the stock app does not: it points your devices straight at your server over Bluetooth, so you need no DNS tricks; map editing on the phone; a multi-mower picker; joystick and camera; rain pause; push notifications.

Where a feature needs custom firmware on the mower, the app says so with *Requires OpenNova custom firmware* instead of sending a command the mower would ignore. The split is on [Stock vs. Custom Firmware](stock-vs-custom-firmware.md).

Install on Android: download the APK from [downloads.ramonvanbruggen.nl/app](https://downloads.ramonvanbruggen.nl/app/opennova-v1.1.29.apk) (the app updates itself from there afterwards). Install on iOS: TestFlight invite from the maintainer; Apple does not allow direct installs.

This page walks through what each screen does. Screens appear in the order you'd typically use them.

## Login

Email + password (the same account you created on the OpenNova server admin page). After first login the app remembers you — you only see this screen again if you log out or change devices.

If login fails with "network connection abnormal":
- The server's URL in app settings is wrong, or
- DNS isn't routing `app.lfibot.com` (or your custom hostname) to your server.

The OpenNova app talks plain HTTP to your server, so it needs no certificate
on Android or iOS. The certificate steps on the [Docker page](../guide/docker.md#5-log-in-with-the-app)
are for the original Novabot app only.

## Device picker (top of Home)

Tap the chevron next to your mower's name to switch between paired mowers. The picker shows online state with a dot — green = receiving status, grey = offline.

If you only have one mower, the picker shows that mower's name as a static title.

## Provisioning: pointing a device at your server

Settings → **Provision Devices**. This is what makes DNS rewrites unnecessary
with this app: over Bluetooth it writes your server's address into the
charger and the mower, the same way the factory app wrote the cloud's.

1. **Scan** for nearby devices. The charger and the mower advertise over BLE
   when powered on; stand next to them.
2. **Charger first**, then the mower. The app insists: the mower's LoRa link
   is paired to the charger, and a mower provisioned before its charger ends
   up with a LoRa mismatch.
3. Per device: Wi-Fi network and password, then the server. The steps show
   as they run: connecting, discovering services, configuring Wi-Fi, setting
   MQTT, saving. *Server not reachable* at the end means the device joined
   Wi-Fi but cannot reach the address you gave; check `TARGET_IP` and port
   1883.

Changed router or Wi-Fi password? Run exactly this again, charger first;
nothing is deleted and the map stays. Step by step in
[Reconnect to Wi-Fi](reconnect-wifi.md).

The protocol behind it, for the curious: [BLE Provisioning](../ble/overview.md).

## Home

The default screen after login. Shows everything happening with the active mower right now:

- **Battery ring** — current % and a thin coloured arc indicating charge state.
- **Mower scene** — a stylised top-down picture of the mower with status indicators (motors running, blades spinning, error states overlay).
- **Action row** — large buttons for the common operations:
  - **Start mowing** — opens the StartMowSheet (pick which map, blade height, edge-only mode).
  - **Pause / Resume** — only enabled mid-session.
  - **Go home / Charge** — sends the mower back to the charger.
  - **Edge cut** — boundary-only mowing pass (uses the NTCP action behind the scenes; "start_patrol" in the stock app does *not* do this — that's a no-op).
- **Schedule chip** — shows the next scheduled mow. Tap to jump to the Schedule screen.
- **Live updates** — battery, position, work status all refresh from MQTT every couple of seconds while the screen is open.
- **Time left** — a chip while mowing (`~23m left`) from the firmware's own estimate (`cov_estimate_time`), next to the elapsed time. Hidden while returning, docking or idle because the estimate is stale there.

Pull down to manually refresh the whole screen.

## Start Mowing sheet

Slides up from the bottom when you tap **Start mowing**. Choose:

- **Map** — pick one of your work maps or "All maps" (selects every work area on the mower).
- **Cutting height** — slider in cm. Valid range 2-9 cm. Values outside this range are silently rejected by the firmware, so the slider clamps for you.
- **Advanced** — tap to reveal path direction, edge offset and the mow pattern. Collapsed by default; the app remembers your choice.
- **Edge first** — toggle to mow the boundary before filling the interior.
- **Rain delay** — if enabled, the mower won't start while the rain sensor is wet.

Hit **Confirm** and the mower starts within a few seconds (the command goes via MQTT, then ROS).

## Map

Live position view. Your mower's last known location is plotted on top of the work map polygons. Tracks the mower's path during an active mowing session.

- **Switch map** — pick which work map to display.
- **Manual control** — opens the Joystick screen (see below).
- **Mapping** — opens the Mapping flow to add / edit a map.

## Mapping

Walks you through creating a new map (or editing an existing one). Steps:

1. **Pair via BLE** — app talks directly to the mower over Bluetooth for the duration of the mapping session. Make sure your phone is within range.
2. **Drive the boundary** — joystick controls; trace the outer edge of the area you want mowed.
3. **Add obstacles** — pause-resume cycles to mark trees, beds, statues. Each obstacle is a closed polygon inside the work area.
4. **Add unicom channels** (optional) — narrow paths the mower uses to travel between work areas without mowing.
5. **Set charger position** — drive the mower onto the charger and confirm; this becomes the reference point for the map's GPS-to-local coordinate transform.
6. **Save** — sends two `save_map` calls (sub map + total map) and uploads the resulting CSV to the server. Don't close the app between the two sends.

While you drive, the live map shows the boundary so far next to your
existing areas. It is zoomed to about eight metres around the mower by
default, which is the view you need to judge the gap to a neighbouring
area; the button in its corner switches to *fit all*. The app warns when
localization is lost (stop driving until it is back, or the loop will not
close), when the boundary touches an existing area (the mower may refuse to
save it), and it tells you when the boundary is closed and you can stop.

The full BLE protocol details (for debugging) live at [BLE → Mower Provisioning](../ble/mower-provisioning.md), but you don't need to read it for normal use.

## Editing a map

Map → **Edit map** (custom firmware). Points, **push/pull** the boundary with
a brush, **new obstacle** (tap points, close it), **delete obstacle**. **Apply
to mower** rewrites the map files on the mower; **Undo last apply** restores
the previous version; **Re-sync** pushes again after a failed push. The app
refuses while the mower is busy or offline.

## Re-anchor after a restore

After a map restore the mower has to re-learn where its dock is, and the app
blocks *go home* until it has: a banner says *Frame not anchored*. Put the
mower on the dock, wait for RTK Fixed, tap **Re-anchor**. The mower saves the
dock position, drives back about a metre to re-lock, and pauses; sometimes it
asks you to drive it half a metre in front of the dock and tap *Start
docking*, or to dock by hand and tap *Verify*. Background in
[Map Backup & Restore](map-backup-restore.md).

## Rain

Settings → **Rain detection**: pause mowing when rain is forecast and resume
when it is dry, with a threshold. When you start a mow with rain expected
within a few hours the app asks first, and lets you ignore rain for that
session. A mower that came home for rain shows why, with *Ignore rain &
resume*.

## Schedule

Recurring mowing schedules per map. Each schedule has:

- Days of week (any combination).
- Start time.
- Map(s) to mow.
- Cutting height.
- Edge-first toggle.
- Optional rain pause.

Add, edit, delete from the same screen. Schedules execute server-side — the mower keeps mowing on schedule even if your phone is asleep or the app is closed.

## History (Work records)

At the top: totals for this week, this month and this year (runs, hours, m²), and a **Blades** card that counts mowing hours since the last blade change against a reminder interval (default 60 h, pick 30/60/90/120). Tap **Mark replaced** after changing the blades. When the interval is reached the card turns amber and a `blade_maintenance` notification is sent once (see [Notifications](../guide/notifications.md)).

Past mowing sessions. Each row:

- Date & time (in your phone's timezone).
- Duration (minutes).
- Area mowed (m²).
- Map(s) used.
- Status (completed / interrupted / cancelled).
- Start method (manual / scheduled / app).

Tap a row to see the path the mower took during that session, plotted on the map.

## Messages

Robot messages + alerts: low battery, blade stuck, lifted off ground, lost localization, recharge requested. The Messages tab is a **poll-based inbox** (the app fetches the server's stored `robot_messages` queue on open / refresh); it is not a push channel. For real-time push (the OS-level pop-up while the app is closed), see the Notifications section below and the [Notifications setup](../guide/notifications.md) page.

Tap a message to see full detail. Swipe to delete. "Mark all read" button at the top.

## Joystick

Manual remote control. The mower must be in manual mode (which the app sets via `start_move`).

- Left stick — forward / back.
- Right stick — turn.
- Tap-to-stop — instant stop.
- Blade toggle — turn blades on/off independently of motion (so you can spot-trim).

Lose connection mid-control and the mower auto-stops within a couple of seconds — there's no runaway risk.

## Camera

Live camera feed from the mower's onboard camera. Only available on hardware revisions that have a camera fitted.

## OTA

Firmware updates from inside the app. Lists available versions with changelog, picks the latest by default, "Update" button kicks off the OTA.

The OpenNova server (not the LFI cloud) serves the firmware files. Watch the percentage — see [Troubleshooting → OTA failures](troubleshooting.md#ota-update-fails-download-failed-percentage-stuck-below-62) if it gets stuck.

## Settings

App-level settings (different from mower settings):

- **Server URL** — which OpenNova server the app talks to. Default is `https://app.lfibot.com` (auto-discovered if your DNS is set up); override manually for non-standard setups.
- **Language** — UI language.
- **Theme** — light / dark / system.
- **Notifications** — opt-in for push notifications via Expo (mowing started/finished, low battery, errors). Requires the server's notification dispatcher to be configured ([Notifications setup](../guide/notifications.md)).
- **Demo mode** — fake mower + map for screenshots / testing. Does not touch real hardware.
- **About / Logout** — version info, log out, support links.
- **Help → Report a problem** — opens a GitHub bug report with the app version, server version, mower SN, mower and charger firmware and the last error already filled in. Add what happened and submit.

## Mower Settings (per-device)

Reached from the device picker or the gear icon on the device card. Per-device knobs:

- **Nickname** — what the mower shows up as in the app.
- **Auto-recharge threshold** — battery % at which the mower returns to base.
- **Rain delay** — how long to wait after rain before resuming.
- **No mowing after dark** (Weather & time) — scheduled runs between sunset and sunrise are skipped, so hedgehogs and other nocturnal animals stay safe. Off by default; manual starts are never blocked.
- **No mowing in frost** (Weather & time) — scheduled runs are skipped when the forecast for the current or next hour is below the chosen temperature (default 3 °C).
- **Mowing speed** — slider (clamped by firmware).
- **Blade calibration** — if your blades drift left/right, nudge here.

Changes save instantly via MQTT — no separate "Save" button.

## App updates

The Android app polls `downloads.ramonvanbruggen.nl` every time it foregrounds and every 12 hours in the background for new releases. When one is available, you get a one-tap install prompt with the changelog.

iOS users get the same prompt but it links to TestFlight / the GitHub release page — Apple doesn't allow auto-install from outside the App Store.

## When the app can't connect

In order from "most common" to "least":

1. Server URL or DNS isn't pointing at your OpenNova instance. Open Settings → Server URL and check.
2. Your phone is on a different VLAN than the server (guest WiFi often does this).
3. Server container is down (`docker ps` on the host).

No certificate is involved: the OpenNova app uses plain HTTP. If it is the
**original Novabot app** that cannot connect, that one does need your
server's certificate trusted on the phone, Android and iOS alike; the steps
are under [Log in with the app](../guide/docker.md#5-log-in-with-the-app).

The [Troubleshooting page](troubleshooting.md) has a deeper dive into each.
