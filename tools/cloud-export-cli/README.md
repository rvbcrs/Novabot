# Cloud Export CLI

Standalone command-line tool to export your Novabot cloud account data and restore maps after a base station swap. Zero dependencies beyond Node.js.

This is the CLI counterpart to the web-based [cloud-export](../cloud-export/) tool. It talks directly to the LFI cloud API — no OpenNova server required.

## Map Backup & Restore

> **This solves a commonly requested feature:** when you replace your base station (warranty swap, defect, upgrade), the Novabot app deletes your maps. Re-mapping a yard can take 30+ minutes and requires good GPS conditions. This tool lets you back up your maps *before* the swap and restore them to the cloud afterward — no re-mapping required.
>
> **Important details:**
> - Maps are stored in the cloud by **mower serial number**, not charger SN. Replacing the charger doesn't inherently erase them, but the app's unbind/rebind flow often does.
> - The mower also stores maps locally. In many cases it re-uploads them automatically after rebinding. The restore command is your safety net if that doesn't happen.
> - A charger must be **unbound from its current account** before it can be added to a new account. The cloud enforces single-owner binding.
> - **Back up your maps before you unbind.** Once you delete the base station in the app, cloud map data may be gone.

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

## Base Station Swap Workflow

If you need to replace your charging station (e.g., warranty swap, upgrade):

1. **Export** your cloud data while the old station is still set up
2. **Delete** the old base station in the Novabot app
3. **Add** the new base station and bind it to your mower
4. **Check** if maps survived — they usually do since they're stored on the mower itself
5. **Restore** maps if they're missing from the cloud: `node cloud-export-cli.mjs restore-maps ...`

Maps are stored by mower SN in the cloud, not charger SN. In most cases the mower retains its maps locally and re-uploads them automatically. The restore command is a safety net.

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
