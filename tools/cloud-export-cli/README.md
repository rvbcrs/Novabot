# Cloud Export CLI

Standalone command-line tool to export your Novabot cloud account data and restore maps after a base station swap. Zero dependencies beyond Node.js.

This is the CLI counterpart to the web-based [cloud-export](../cloud-export/) tool. It talks directly to the LFI cloud API — no OpenNova server required.

## Map Backup & Restore

> **Background:** when you replace your base station (warranty swap, defect, upgrade), the Novabot app's unbind/rebind flow often deletes your cloud maps. Re-mapping a yard can take 30+ minutes and requires good GPS conditions. This tool backs up your maps and can restore the **cloud copy** afterward.
>
> **Important: cloud-only restore.** This tool restores maps to the **LFI cloud** only. It cannot push maps to the mower itself. The Novabot app's map display is **mower-authoritative** — the app queries the mower via MQTT (`get_map_list`), and if the mower has no maps locally, the app shows "Map list is null" regardless of what's in the cloud.
>
> **When restore works:**
> - The mower still has maps on its local filesystem (most common after a charger swap — you replaced the charger, not the mower). The mower re-uploads to the cloud automatically, or you restore the cloud copy and the app displays maps from the mower.
> - You want a cloud backup for archival purposes (CSV files, obstacle boundaries, channel paths).
>
> **When restore is NOT enough:**
> - The mower has lost its maps (factory reset, firmware wipe, mower replacement). The cloud copy will be restored, but the app won't display maps because the mower responds with `zip_dir_empty`. In this case you'll need to re-map, or use SSH/SCP to push CSVs directly to the mower at `/userdata/lfi/maps/home0/csv_file/`.
>
> **Other details:**
> - Maps are stored in the cloud by **mower serial number**, not charger SN.
> - A charger must be **unbound from its current account** before it can be added to a new account.
> - **Back up your maps before you unbind.** Once you delete the base station in the app, cloud map data may be gone.
> - The cloud's `fragmentUploadEquipmentMap` endpoint does not populate the `mapArea` field from uploaded data. After a restore, map areas will show as unknown in the cloud. This is a server-side limitation.

## Requirements

- Node.js 18+

## Usage

### Export

Download all your cloud data (account info, devices, maps, work records, messages, schedules, firmware info) to a local folder:

```bash
node cloud-export-cli.mjs export \
  -e 'your@email.com' \
  -p 'yourpassword' \
  -o ./my-export
```

Options:
- `--include-firmware` — also download firmware binaries (large files)
- `--include-secrets` — keep WiFi passwords and MQTT credentials in the export (redacted by default)
- `--force` — overwrite an existing export without prompting

### Restore Maps

Upload backed-up maps to the cloud after replacing your base station:

```bash
node cloud-export-cli.mjs restore-maps \
  -e 'your@email.com' \
  -p 'yourpassword' \
  -o ./my-export
```

Options:
- `--sn LFIN2XXXXXXXXX` — restore maps for a specific mower (auto-detected if omitted)
- `--dry-run` — show what would be uploaded without doing it
- `--yes` / `-y` — skip the confirmation prompt
- `--force` — overwrite existing cloud maps (by default, restore skips mowers that already have maps)

## Base Station Swap Workflow

If you need to replace your charging station (e.g., warranty swap, upgrade):

1. **Export** your cloud data while the old station is still set up
2. **Delete** the old base station in the Novabot app
3. **Add** the new base station and bind it to your mower
4. **Check** if maps survived — they usually do since they're stored on the mower itself
5. **Restore** maps if they're missing from the cloud: `node cloud-export-cli.mjs restore-maps ...`

Maps are stored by mower SN in the cloud, not charger SN. In most cases the mower retains its maps locally and re-uploads them automatically. The restore command is a safety net for the cloud copy.

### How Map Display Works (App Architecture)

The Novabot app's map display works as follows:

1. **Cloud download** — on launch, the app downloads CSV files from cloud URLs for initial rendering
2. **Mower query** — the app sends MQTT `get_map_list` to the mower
3. **Mower response** — if the mower has maps, the app displays them; if `zip_dir_empty`, the app shows "Map list is null" and returns to the main screen

The mower is the **authoritative source** for map display. Cloud data alone is not sufficient — the mower must also have the maps on its local filesystem (`/userdata/lfi/maps/home0/csv_file/`). Map data flows **one way**: mower → cloud. There is no MQTT command or cloud API to push maps from the cloud back to the mower.

### Verified Against LFI Cloud

The restore flow has been tested against the real LFI cloud (April 2026). A backup with 3 work areas, 5 obstacles, and 3 channels (11 CSV files) was successfully restored and verified via `queryEquipmentMap`. The cloud accepted and stored all files correctly. However, the app only displays maps when the mower also has them locally.

## Exported Data

```
my-export/
  account.json           # User profile
  devices.json           # Device list
  devices/
    LFIC1XXXXXXXXX.json  # Charger details (secrets redacted by default)
    LFIN2XXXXXXXXX.json  # Mower details
  maps/
    LFIN2XXXXXXXXX.json  # Map metadata
    LFIN2XXXXXXXXX/
      map0_work.csv      # Work area boundary
      map0_0_obstacle.csv
      map0tocharge_unicom.csv
  schedules/
    LFIN2XXXXXXXXX.json  # Mowing schedules
  work-records-LFIN2XXXXXXXXX.json
  messages.json
  firmware.json
  export-summary.json
  novabot-export.zip     # Everything bundled
```

## Security Notes

- **Sensitive fields** (WiFi passwords, MQTT credentials) are redacted by default. Use `--include-secrets` only if you need the raw values, and protect the export folder accordingly.
- **TLS**: The LFI cloud is accessed via IP address (no valid hostname certificate). Connections are encrypted but the server certificate is not validated. See the source code for details.
- **Password on CLI**: Your password is visible in `ps` output. If this is a concern, consider changing your Novabot password after use.
