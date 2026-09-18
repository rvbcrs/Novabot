# Walker firmware updates (OTA)

The RTK walker can update its own firmware over the air. Once the walker
has been flashed once via USB with an OTA-capable build, all subsequent
firmware updates can be pushed without touching the cable.

## Prerequisites

- Walker firmware built from `feat/rtk-walker-map-import` (or a successor)
  that contains the walker_ota module. Earlier walker firmware does NOT
  have OTA; one USB flash is needed to bootstrap.
- The walker has a working WiFi connection to the same LAN as the OpenNova
  server.
- The walker's settings have a valid `serverUrl`, `mowerSn`, and
  `adminToken` configured (these come from T10 of the RTK walker plan).

## Publishing a new build

1. Build with a fresh date-based version:
   ```bash
   cd tools/rtk-walker
   ./scripts/release.sh
   ```
   This produces `walker_firmware_YYYY.MMDD.HHMM.bin` in the walker dir
   and prints the MD5 + size + the scp/docker commands.

2. Copy BOTH the .bin AND its companion .json to the OpenNova server's
   firmware dir. The .json tells the server's auto-registration that this
   is a walker build; without it the file is registered as charger
   firmware and the walker will never see the update:
   ```bash
   scp walker_firmware_*.bin walker_firmware_*.json <user>@<server>:/tmp/
   ssh <user>@<server> 'sudo docker cp /tmp/walker_firmware_*.bin opennova:/data/firmware/ && sudo docker cp /tmp/walker_firmware_*.json opennova:/data/firmware/'
   ```
   The `release.sh` script emits both files and prints the exact scp
   command tailored to that build's version.

3. In the admin page Firmware Updates card, expand "Walker firmware" and
   click "Refresh from manifest". The new file should appear under
   "Installed locally".

## Walker fetches the update

There are three triggers:

- **Auto-check on boot** (default). On WiFi connect, walker hits
  `GET /api/walker-firmware/latest?currentVersion=<current>`. If a newer
  version exists, walker downloads + applies + reboots silently.
- **TFT Settings > Firmware tab > "Check + Update"** button. Same flow,
  on demand.
- **Web UI Firmware card** at `http://<walker-ip>/`. Same flow.

The update process:
1. Walker queries the server's `/api/walker-firmware/latest` endpoint.
2. If `updateAvailable`, walker GETs the `.bin` from
   `/api/admin-status/walker-firmware/binary/<filename>` with the
   admin Bearer token.
3. ESP32 `Update` class streams the bytes to the inactive OTA partition.
4. MD5 verification.
5. ESP.restart(). Walker reboots into the new firmware.

## Disabling auto-check

If you want manual-only updates, send a config update with
`otaAutoCheck: false`:

```bash
curl -X POST http://<walker-ip>/api/config/server \
  -H 'Content-Type: application/json' \
  -d '{"otaAutoCheck": false}'
```

Auto-check is then off until you set it back to true.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Walker boots normally, no OTA attempt | serverUrl not configured | Set serverUrl via TFT Settings or web UI |
| OTA check shows "HTTP 404" | Server endpoint not deployed | Pull latest server image: `docker compose pull && docker compose up -d` on .247 |
| Apply shows "HTTP 401" | adminToken invalid/expired | Refresh token in walker config (admin page, grab new JWT, paste into walker settings) |
| Apply fails with "Update.begin: not enough space" | Partition layout missing dual OTA slots | Walker must be on default_16MB.csv partitions (auto since the partition fix commit). If walker still has huge_app.csv, USB-flash a new build to bootstrap |
| Walker reboots into the old firmware | Update applied but new firmware crashed on boot | ESP32 OTA automatically rolls back to the previous slot. Check serial logs for crash cause |
| Walker says "Up to date" even though new firmware exists on server | scp'd .bin but no companion .json, so server auto-registered the build as charger firmware and the walker's `findLatestByDeviceType('walker')` lookup returns nothing | Use `release.sh` which emits both files and prints the exact scp command, or use the admin page "Download to server" button which writes a proper metadata file. As a one-off recovery, edit the row in `ota_versions` to set `device_type='walker'` |

### Boot stalls about 30 seconds when server is unreachable

If the OpenNova server is powered off, on a different VLAN, or otherwise
unreachable when the walker boots, the boot itself appears to hang for
roughly 30 seconds before the TFT becomes responsive. This is the
auto-OTA check waiting for its HTTP connect to time out. The relevant
code is `walkerOtaAutoTick(false)` running synchronously on the main
loop's first pass after WiFi connect: the HTTP client uses the default
connect timeout, and there is no early-exit if the host fails DNS or
TCP. Once the timeout elapses, the main loop resumes normally and the
walker is fully usable; nothing is broken. To avoid the stall when you
know the server is down, set `otaAutoCheck: false` via the web UI
before powering down the server, then re-enable it later.

## First-time OTA gate

The original walker firmware was built with `huge_app.csv` (single app
slot) which cannot do OTA. The OTA-capable build uses `default_16MB.csv`
(dual app slots). The transition between these requires **one USB flash**
of the OTA-capable build. After that, all updates go via OTA.

## Rollback

ESP32 partitions support automatic rollback: if the newly-flashed firmware
crashes during boot, the bootloader reverts to the previous partition.
For manual rollback, USB-flash the older build.

## Implementation references

- Walker module: `tools/rtk-walker/src/walker_ota.{h,cpp}`
- Server endpoints: `server/src/routes/adminStatus.ts` plus
  `server/src/index.ts` (public `/api/walker-firmware/latest`)
- Admin UI: `server/src/routes/adminPage.ts` > Firmware Updates >
  Walker firmware
- Release script: `tools/rtk-walker/scripts/release.sh`
