# Admin Panel

The admin panel is the server's own management page, at
**http://TARGET_IP/admin** (the dashboard is at `/`). Log in with the
account from first-time setup. Where the [dashboard](dashboard.md) is for
mowing, the admin panel is for the server: devices, firmware, maps as files,
diagnostics, and the settings that only the person running the server should
touch.

Seven tabs: **Devices**, **Console**, **Mower Debug**, **Maps**, **Firmware**,
**Experimental**, **Settings**. The **? Help** button on the top right explains
every button on the page in Dutch.

## Devices

Every mower and charger the server knows, with an online pill (driven by
MQTT), serial number, nickname, firmware, and last seen. Per device:

- **Why is it not coming online?** The connection diagnosis: server checks
  (disk, a competing MQTT broker, the container's network, mDNS),
  reachability (does `mqtt.lfibot.com` point here, does the device answer,
  Wi-Fi), the connection history, and on custom firmware a login into the
  mower itself to check its configuration, `mqtt_node`, and whether it hears
  `opennova.local`. The first blocking step is named, with what to do. Its
  language follows the panel's. Paste it into a bug report.
- **Edit** the nickname; **Bind** a charger to a mower; **Remove** a device
  from the server.
- **Connect & Import from Cloud** if your Novabot account still has your
  devices. Adding one by hand (serial number and BLE MAC) is done in the
  [dashboard](dashboard.md#adding-a-device).

## Console

The live server log, the same lines as `docker logs opennova -f`, with a
filter and a pause for copying. Reproduce a problem with this open and you
have the exact lines for an issue.

## Mower Debug

Reads from a mower on custom firmware, without SSH. Pick the mower, then:

- **System info** and **Path files info**: what is on the mower's disk and
  which map files it currently has.
- **Fetch log lines** from a chosen source: `mqtt_node` (info, or the
  stderr/crash log), `robot_decision`, `chassis_control`,
  `coverage_planner`, `nav2`, `timer_record`, `novabot_mapping`,
  `localization`; filtered by level. This is where "why did it stop" is
  answered when the dashboard's return reason is not enough.

## Maps

The maps as the server stores them, per mower: work areas, obstacles and
channels, with area and canonical name, and the coverage preview the mower
planned.

- **Map viewer** with **Edit**: new obstacle, delete obstacle, move a vertex,
  **Push/pull** the boundary, **Apply to mower**, **Revert**. The same editing
  as the dashboard, here as a fallback.
- **Portable bundle**: **Export bundle** writes everything the mower needs
  (CSV files, occupancy grids, the charging pose) as one file; **Import
  bundle** puts it back on the same or another mower, and starts the
  dock-anchor refresh that a restore needs. **Import CSV zip** takes a plain
  set of CSVs. **Rebuild bundle (DB)** regenerates the mower files from what
  the server has. The full flow, with what each step checks, is in
  [Map Backup & Restore](map-backup-restore.md) and
  [Portable Map Export / Import](../portable-map-export-import.md).
- **Coverage radius**: the mower's own setting for how far apart its passes
  are; **Snapshot now** asks for a fresh coverage preview.

## Firmware

Over-the-air updates for mowers.

- **Available firmware**: what the server has in `/data/firmware/`. **Refresh
  from manifest** fetches the list of released custom builds from the
  OpenNova download server; **Check for updates** compares with what your
  mowers run.
- **Update device**: pick a mower and a version, **Start update**. Progress
  comes from the mower over MQTT: 0 to 62% is the download, 62 to 68%
  unpacking, 68 to 100% installing. Custom builds show a warning first, in
  the panel's language: they can brick the mower or lose maps, and a fresh
  backup is taken before flashing.
- **Revert to stock firmware**: flash the factory image back. You lose SSH
  and everything else custom; see [Revert to Stock](../firmware/revert-to-stock.md).

## Experimental

A deck.gl rendering of the selected mower's maps with extra layers, such as
the Wi-Fi signal heat map from positioned samples. Nothing here changes the
mower.

## Settings

- **Account**: your email, role, password, and the server version.
- **Resources & Help**: the wiki, GitHub, Docker Hub, releases.
- **Network & DNS**: whether `app.lfibot.com` and `mqtt.lfibot.com` resolve
  to this server, with **Re-check DNS**, and the built-in dnsmasq toggle if
  your router cannot do DNS rewrites.
- **System Tools → mDNS advertiser**: restart the discovery service without
  restarting the container. With the standard compose the advertising is done
  by the `opennova-mdns` helper instead; the card says so and the button is
  off, because there is nothing in this container to restart.
- **Certificate setup**: **Download iOS profile** (`.mobileconfig`, with the
  DNS settings) or the **Android certificate**. Required for the Novabot
  app on iOS.
- **Cloud import**: pull your devices from your Novabot account. One-shot.
- **Remote debug**: send your live MQTT log to someone helping you, or
  receive theirs.
- **Remote support**: opt in to let the maintainer open a shell into your
  container for one approved session; every keystroke is logged to your disk.
  **Approve**, **Decline**, **End session now**.
- **Support OpenNova**: donation links.
- **Danger zone**: wipe the database, force re-pair, **Factory reset**. Each
  asks twice.

## When the admin panel itself does not load

Check that the container runs (`docker ps`); `docker compose up -d` brings it
back. Container up but the page gives 502: your reverse proxy lost the route.
Page loads but every login fails after a restore or a `factory_reset`: the
JWT secret was regenerated; log in again and, on the phone, log out of the
app and back in.
