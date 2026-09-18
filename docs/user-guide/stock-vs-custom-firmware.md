# Stock vs. Custom Firmware

A common question: **can I use the OpenNova app with the factory (stock) firmware on my mower, or do I need to flash custom firmware first?**

Short answer: the OpenNova app works for everyday mowing on a stock-firmware mower, but several advanced features only work after you flash a custom build. This page is the full breakdown, sourced from the app's call sites (`api.sendExtended` for custom-only paths, `api.sendCommand` for stock-compatible paths) and the extra services that custom firmware installs on the mower.

## Three flavours of "stock"

When this page says "stock" it means the **factory LFI firmware** the mower shipped with. Stock main firmware versions look like `v6.0.2` (no suffix); custom builds add a `-custom-NN` suffix (`v6.0.2-custom-44` as of September 2026; the admin panel's Firmware tab lists the current one under *Refresh from manifest*). The factory image is typically `mower_firmware_v5.7.1.deb`; units that took LFI's last beta run `v6.0.2`. The custom builds are all based on `v6.0.2`. The factory image talks to `mqtt.lfibot.com` and `app.lfibot.com`. For the app to reach the mower at all, you also need DNS rewrites on your LAN so those hostnames resolve to your OpenNova server.

Two other firmware layers come up:

- **STM32 secondary firmware** - runs on the small microcontroller that drives the blades and reads encoders. Stock STM32 `v3.6.0` is the working baseline today on shipped units: blade calibration runs at boot and the historical PIN-lock bug from earlier 3.6.x builds is no longer present. (Earlier custom NOP'd builds existed to work around that old bug, but they are no longer required.)
- **Charger firmware** - separate ESP32 microcontroller in the charging station. Not addressed here; both stock and custom versions speak the same MQTT/LoRa surface.

## Works on stock (with DNS rewrites)

| Feature | Why it works |
|---------|--------------|
| Mowing start / pause / stop / go-home | Standard MQTT (`start_navigation`, `pause_navigation`, `stop_navigation`, `go_pile`) — stock `mqtt_node` handles these natively |
| BLE provisioning | Pure Bluetooth protocol baked into the mower image, independent of firmware extensions |
| Mapping (creating / editing maps) | BLE-driven (`start_scan_map`, `add_scan_map`, `save_map`); the mower's BLE stack is identical |
| Schedules | Server-side cron, standard `cutGrassPlan` MQTT command |
| Map viewing in the app | The server stores maps; the app reads them via `queryEquipmentMap` |
| Live status — battery / position / work status | Standard `report_state_robot` and `report_state_timer_data` publishes |
| Work history | Standard `saveCutGrassRecord` HTTP POST plus MQTT |
| Messages tab | Server-side `robot_messages` queue |
| Cutting height | Standard MQTT `cutterhigh` enum (still need to send the correct value — see [cutting height notes](../mqtt/mowing-commands.md)) |
| Multi-mower picker | Server-side filter, no firmware involvement |
| Home Assistant integration | Server-side bridge, listens to standard MQTT topics |
| Push notifications | Server-side dispatcher (Expo / NTFY / HA webhook) |
| Stock-style OTA flow | Standard `ota_upgrade_cmd` MQTT — works as long as the firmware download URL is reachable |
| App self-update | App polls `downloads.ramonvanbruggen.nl` directly; no mower involvement |
| Pattern mowing (dashboard) | A placed pattern is sent as a plain polygon with the standard `start_run` |
| Edge offset (shrink / expand the cut border) | Same mechanism: the adjusted polygon goes with the standard start command |
| Drone photo under the map | Entirely server-side; a tracing aid the mower never sees |
| Connection diagnosis, server side | Disk, brokers, DNS, mDNS, reachability: all measured from the server. Only the mower-side steps need custom firmware |
| Rain pause, return reason, schedules with alternate direction | Server-side logic on top of standard commands |

These are the daily-use features. If all you want is "use my mower without LFI's cloud", stock firmware + DNS rewrites covers it.

## Does **not** work on stock firmware

### Requires `extended_commands.py` (custom-only mower service)

The custom firmware build installs `/root/novabot/scripts/extended_commands.py`, which listens on the `novabot/extended/<SN>` MQTT topic. The app calls these via `api.sendExtended()`. None of them exist on stock firmware.

| Feature | App location | What it does |
|---------|--------------|--------------|
| **Edge cut / boundary mow** | Home → Edge cut | `start_edge_cut` dispatches the `/navigate_through_coverage_paths` NTCP action with `only_edge_mode:true`. Stock has `start_patrol` MQTT but it's a no-op stub. |
| **Stop boundary follow** | Home (kill edge cut) | `stop_boundary_follow` cancels the NTCP goal and any boundary action client |
| **Blade on / off (joystick)** | Joystick screen | `blade_on` / `blade_off` over the serial bus to STM32. No equivalent MQTT command on stock. |
| **Blade speed / blade height direct** | Service tools | Bypasses the standard `cutterhigh` indirection for diagnostics |
| **Camera stream** | Joystick + Camera screens | The MJPEG proxy in the server expects `camera_stream.py` running on the mower — that's also a custom firmware addition |
| **LoRa re-provisioning (server-driven)** | Provision flow fallback | `set_lora_info` when the BLE path fails to push LoRa pair info |
| **Recalibrate charging pose** | Admin → recalibrate | Rewrites three yaml files (`charging_station.yaml`, `auto_recharge_pose.yaml`, `pos.json`) and triggers a node restart |
| **Sync map / apply polygon offset** | Server-side map fixes | Writes the GPS↔map-frame transform into five files so the saved polygon aligns with a freshly-realigned dock |
| **Read / write map files** | Portable map export+import | Direct file IO under `/userdata/lfi/maps/` |
| **Generate empty map / regenerate per-map files** | Map recovery flows | Rebuilds `map.yaml`, `map.pgm`, `map.png` |
| **Get preview cover path / map plan path** | Coverage preview button | Stock `get_preview_cover_path` overruns a buffer on large maps and crashes mqtt_node |
| **Set perception / semantic mode** | Advanced settings | Live-tune obstacle detection level (low/medium/high) |
| **Verify PIN / clear error** | Error recovery | STM32 unlock + chassis-error reset |
| **Get mqtt_node log / ROS logs** | Logs viewer | Tails `/tmp/log_*/log_*.log` over MQTT |
| **Clean OTA cache** | After failed OTA | Wipes `/userdata/ota/cache/` |
| **`is_opennova` detect ping** | Settings → device info | Lets the app auto-detect whether a mower is custom-flashed |
| **Calibration drive** | Initial setup helper | Slow drive-by for heading calibration |
| **Set pos origin** | Map fix tooling | Forces `pos.json` origin to a known point |
| **Reboot mower** | Admin → reboot | `handle_reboot` reboots cleanly through the daemon-node hook |
| **Drawing and editing zones, obstacles and channels in the dashboard** | Dashboard → Edit | The result is written into the mower's map files (`csv_file/`, the per-zone occupancy grids); stock only takes maps driven with the app |
| **More than five work areas** | Dashboard | Stock firmware routes map ids above 60000 into a test task and fails with error 125; from `custom-42` zones are selected by name instead |
| **Autonomous mapping** | Dashboard → Mapping | The mower follows the lawn edge itself and records the boundary, orchestrated through extended commands |
| **Coverage preview and live coverage overlay** | Dashboard → Coverage | Reads the planned path back through the extended channel (the stock path overruns a buffer) |
| **Re-anchor after a map restore** | Dashboard banner / Admin → Maps | Rewrites the map origin from the docked RTK fix |
| **Portable map bundles (export / import)** | Admin → Maps | Direct file IO on the mower |
| **Mower-side connection diagnosis** | Admin → Why is it not coming online? | Logs into the mower to check its config, `mqtt_node` and whether it hears `opennova.local` |
| **Terrain objects** | Dashboard → Terrain | Built from the camera's object detections |

### Legacy STM32 lockup notes

Some older 3.6.x STM32 builds shipped with a PIN-lock that fired shortly after boot and refused motor / blade commands until the user typed an unlock code. That bug is gone on the current stock `v3.6.0` line, which is what every shipped unit runs today: joystick (`start_move` + `mst`), blade calibration, and the manual blade on/off path all work without a NOP'd build. If you happen to be sitting on one of those old 3.6.x images, the symptom was motors going dead a few seconds after boot with `error_status=151`; flashing the current stock 3.6.0 clears it.

The mower's main firmware (the Ubuntu image) and the STM32 firmware are independent. You can mix stock and custom on either side.

### Requires the custom server-pointing hooks

These come from `set_server_urls.sh`, `validate_config.sh`, and the `json_config.json` rewriting that the custom firmware installs.

| Feature | Why stock can't do it natively |
|---------|--------------------------------|
| Talk to OpenNova as the only server | Stock binds `mqtt.lfibot.com` + `app.lfibot.com` literally. Works around the cloud only when you put DNS rewrites in front of it |
| `opennova.local` hostname-based discovery | Stock doesn't know the hostname |
| mDNS auto-discovery of the OpenNova server | Stock doesn't query `_opennova-http._tcp.local` |
| OpenNova-flavoured OTA flashing | Stock's OTA flow expects the LFI CDN's URL format and presence of certain headers |

## What this means in practice

If a friend asks "can I use OpenNova on my factory mower?", the honest answer:

> Yes, for everything you'd do in the LFI app on a typical mowing day. You lose the joystick (which doesn't work right on stock STM32 anyway), the camera (no `camera_stream.py`), edge-cut (NTCP is a custom thing), and all the recovery / debugging tooling. Flash the custom firmware and all of that comes back, including the option to keep using the LFI app side-by-side.

If you already custom-flashed: you get every feature in the OpenNova app, plus the broker reliability and recovery tooling that prevents the "mower offline after restart" class of bugs (see [Troubleshooting](troubleshooting.md)).

## How to check what your mower is running

From the dashboard:

> Devices → click your mower → check the Firmware row.

`v6.0.2` (no `-custom-N` suffix) = stock main firmware. `v6.0.2-custom-44` (or similar) = custom. The STM32 version is on the same panel; current stock builds report `v3.6.0` and work fine. If you see a 3.6.x build older than that on an unflashed unit, that is the legacy PIN-lock window described above.

From the mower itself:

    ssh root@<mower-ip>
    cat /etc/issue   # mower's Ubuntu image version
    cat /userdata/ota/custom_firmware.log | tail -5   # only exists on custom builds
