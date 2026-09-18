# Troubleshooting

Common problems and how to fix them. If your symptom isn't here, search [GitHub issues](https://github.com/rvbcrs/Novabot/issues?q=is%3Aissue) before filing a new one — there's a good chance someone hit the same thing.

## Start here: "Why is it not coming online?"

Every device in the [admin panel](admin-panel.md) (and on the dashboard) has
this button. It runs the checks below for you: the server (disk, a competing
MQTT broker, the container's network, whether `opennova.local` is answered by
the `opennova-mdns` helper), reachability (does `mqtt.lfibot.com` point at
your server, does the device answer on its ports, Wi-Fi), the connection
history, and on custom firmware it logs into the mower and checks from that
side. It names the first blocking step and what to do. Paste its output into
any issue you open.

The rest of this page is for when you want to check by hand.

## My mower shows up as "offline" in the app

Most common cause by far. The mower's `mqtt_node` can't reach your MQTT broker.

**Check in this order:**

1. **Is the OpenNova server itself running?**
   ```
   docker ps | grep opennova
   ```
   Should show `opennova` with status `Up` (on Linux also `opennova-mdns`, the discovery helper; it is fine for that one to be stopped on Docker Desktop). If it says `Restarting`, run `docker logs opennova 2>&1 | tail -50` to see why.

2. **Can the mower reach the server on port 1883?**
   ```
   ssh root@<mower-ip>
   nc -zv <server-ip> 1883
   ```
   Connection refused / timeout = your network is blocking traffic between mower and server. Most likely culprits: a VLAN/firewall split between WiFi devices, or Mac/Windows Docker Desktop where the container is hidden behind a VM.

3. **What does the mower think the server address is?**
   ```
   cat /userdata/lfi/json_config.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('mqtt',{}).get('value',{}))"
   cat /userdata/lfi/http_address.txt
   ```
   The `addr` field should be your server's LAN IP. If it says `mqtt.lfibot.com` or `127.0.0.1` or an unrelated IP, the mower never picked up the local-cloud config. Re-run the discovery script:
   ```
   bash /root/novabot/scripts/set_server_urls.sh
   ```

4. **Is DNS set up?** If the mower resolves `mqtt.lfibot.com` to LFI's old cloud IP (or NXDOMAIN), it'll never even try your server. The admin page has a "Network & DNS" card that tests this for you.

5. **Did the MQTT broker get stuck?** Specific symptom: `mqtt_node` is alive on the mower, but logs show endless `MQTT_EVENT_INIT_NET_ERROR`. The ESP-IDF MQTT stack inside the firmware can get into a stuck state after the server restarts. Fix:
   ```
   ssh root@<mower-ip> 'bash /root/novabot/scripts/set_server_urls.sh'
   ```
   Re-running the script clears the stuck state without rebooting.

## Reconnect the mower to WiFi (re-provision with the app)

Use this when the mower lost its WiFi (shows offline, changed router/password, or the app still thinks it is working and won't let you delete it).

**Do NOT delete the mower or the station to fix this.** Deleting wipes the saved map and forces a full remap. The map lives on the mower itself and does not depend on WiFi or the app binding, so re-sending the WiFi settings over Bluetooth brings it back online with everything intact. No reset, no remap.

**Before you start**

1. Put the mower on (or right next to) its charging station so it is within Bluetooth range of your phone.
2. Make sure the mower is powered on.
3. On your phone, turn on Bluetooth and allow the OpenNova app to use it.

**Steps**

1. Open the **OpenNova app**.
2. Go to **Settings** → **Provision Devices**.
3. Confirm your OpenNova **server address** if it is asked (usually already filled in), then continue.
4. Choose the **mower** (a charger that is already online does not need to be done again).
5. Enter your **WiFi network name (SSID)** and **WiFi password**, then tap **Next**.
     - Use the 2.4 GHz network. Double-check the password. A wrong password is the most common cause of a failed reconnect.
6. The app scans over Bluetooth and finds the mower. Select it and tap **Start Provisioning**.
7. On the next screen tap **Start provisioning** and wait while it sends the settings ("Configuring WiFi").
8. When it finishes the mower reconnects and comes back **online** in the app within a minute. Your map and settings are still there.

**If the app doesn't find the mower in step 6:** make sure it is close enough (next to the dock), then power-cycle the mower and scan again.

## The app shows "No map!" even though I made a map

The map upload completed on the mower side, but `queryEquipmentMap` returned an empty array.

- Check the admin panel → **Maps** tab and pick the mower. It reads straight from the database. If the dashboard sees maps but the app doesn't, it's an app-side filter — usually because the work map has a `mapArea` of zero or canonical_name is missing. Map again with the mower idle on flat ground.
- If the dashboard also shows no maps: the mower never finished the upload. Look at the mower log around the moment you finished mapping — search for `uploadEquipmentMap`. If you don't see that POST hitting the server, the mower didn't try; if you see it but the response was non-2xx, the server rejected it — file a bug with the log.

## Mower won't accept the cutting height I set

The mower uses a wire-level enum, not centimeters. The display you see (e.g. "4 cm") is `wire + 2`. So:

- App sends user-cm = 4 → server / firmware stores `cutterhigh = 2` → blades land at 40 mm.
- Valid range: 2-9 cm in the app (wire 0-7 in firmware).
- If you set 10 cm or higher, the firmware silently rejects it and the blades stay where they were.

If your blade height "doesn't change", check the mower SSH log:
```
grep BLADE_HEIGHT_GET /tmp/log_*/log_mqtt_node.log
```
The number printed there is the actual height in millimeters. If it stays at the previous value across multiple BLADE_HEIGHT_GET lines, the firmware rejected your value.

## "Edge cut" or "Boundary cut" never starts

Use the dashboard or app's "Edge cut" button, not "Start patrol". Stock `start_patrol` MQTT is a no-op stub in `mqtt_node` — it returns "OK" but does nothing.

If the button is there and you click it but the mower stays put:
- Make sure the mower is on the map you want to edge (not just near it).
- Look at the mower log for `Only edge mode, only covering boundary path` — that line means the firmware accepted the command. If you don't see it, the request never reached the action server.
- A `localization not initialized` warning right after pressing the button is OK — the firmware does a 1-metre drive-back to self-initialize before starting.

## OTA update fails ("download failed", percentage stuck below 62%)

Things to check:

1. The firmware download URL must be **http://** (not https://). The mower's downloader does not do TLS.
2. The download URL must be reachable from the mower:
   ```
   ssh root@<mower-ip>
   curl -I http://<server-ip>:<port>/api/dashboard/firmware/<file>.deb
   ```
   You should see `HTTP/1.1 200 OK` or `206 Partial Content`. A 404 means the file isn't where the server says it is.
3. The OTA payload **must not** contain a `tz` field. If you see `"type":"increment"` in your MQTT log instead of `"type":"full"`, something is injecting `tz` and breaking the parse. The server's MQTT broker has a guard for this; if you bypassed it, payloads will fail.

Percentage meaning so you know which phase failed:

| % | Phase |
|---|-------|
| 0 – 62 | Download |
| 62 – 68 | Unpacking |
| 68 – 100 | Installing |

The 62 → 68 jump is suspicious if it happens too fast — that usually means the .deb is corrupt.

## "Charger offline" but the LED on the charger is solid green

The charger's LoRa link with the mower is working but its WiFi/MQTT link to the server isn't.

- Check the charger MQTT address — same `json_config.json` flow as the mower but on the charger's ESP32. The factory address is `mqtt.lfibot.com`; OpenNova re-provisions it during pairing.
- If the charger was paired before but stopped reporting, re-do BLE provisioning from the OpenNova / Novabot app and pick the same network.

## After OTA the mower drives but won't cut

Most likely the STM32 (the secondary microcontroller that runs the blades) got into PIN-lock mode. Symptoms: motors work, drive works, but blades never spin and the dashboard shows `error_status=151`.

Power-cycle the mower (not just reboot, full power off, wait 10 s, power on). The PIN lock clears at cold boot. Current stock STM32 `v3.6.0` does not have the PIN-lock bug, so if blades still refuse to spin after a cold boot the cause is elsewhere (look at the mower log for the actual error rather than chasing the STM32).

## "Localization not initialized" before the first mow of the day

Not a bug. The mower drives back ~1 m on startup to acquire GPS heading. Once it logs `LOC_SUCCESS` the warning goes away — usually within a few seconds. If it stays warning for minutes:

- GPS view of the sky is blocked (under a deck, indoor, dense trees).
- RTK correction stream from the charger isn't reaching it. Check the charger is online and that the RTK link is healthy (LoRa packet rate visible on the admin page).

## I bricked something and the mower won't boot

Two recovery levers:

1. **Ethernet fallback**. The custom firmware sets `eth0` to `192.168.1.10/24` every boot. Plug an Ethernet cable into the mower, set your laptop to `192.168.1.20/24`, and SSH to `192.168.1.10`.
2. **Reinstall a known-good `.deb`**. Either re-flash via the ESP32 OTA tool (puts a `.deb` on the SD card and pushes it over MQTT), or SSH in and `dpkg -i` a manually-uploaded firmware package:
   ```
   scp mower_firmware_v6.0.2-custom-NN.deb root@<mower-ip>:/tmp/
   ssh root@<mower-ip> 'dpkg -i /tmp/mower_firmware_v6.0.2-custom-NN.deb'
   ```
   The mower keeps no built-in factory backup, so always hold onto a working `.deb` somewhere off the device.

If neither works: open an issue with the symptoms and `dmesg | tail -100`. Don't reflash blindly — the wrong firmware on the wrong hardware (LFIN1 vs LFIN2 platforms) can semi-brick the unit.

## How to gather logs to attach to a bug report

First the output of **Why is it not coming online?** (above). Then, if
someone is helping you live, the **Remote Debug** card in the admin panel →
"Start Sharing" → paste the relay URL they gave you. That streams your live
MQTT log to them without giving up control of the container. Mower-side logs
on custom firmware are in the admin panel's **Mower Debug** tab, no SSH
needed.

For a static snapshot:
```
docker logs opennova 2>&1 | tail -500 > /tmp/opennova-server.log
ssh root@<mower-ip> 'tail -200 /tmp/log_*/log_mqtt_node.log' > /tmp/opennova-mower.log
```
Attach both files to the GitHub issue. Redact email addresses and serial numbers if you don't want them public — the issue template has a checkbox reminder for this.
