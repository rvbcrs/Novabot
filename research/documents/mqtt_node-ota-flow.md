# mqtt_node — OTA flow trace (RE-7)

**Status:** DEFERRED. Live OTA upgrade capture (a 10-min `mqtt_node_capture.py`
window during a dashboard-triggered upgrade) was skipped at user
request on 2026-04-27. The Phase 2 OTA client implementation
(`mower/mqtt_node/ota_client.py`) leans on existing documentation +
the Ghidra decompile rather than a fresh capture.

## Sources we rely on instead

- **`docs/reference/OTA.md`** — primary reference. Documents
  `ota_upgrade_cmd` payload schema, HTTP download flow, MD5 verify,
  `ota_upgrade_state` progress reports, the `tz` strip rule
  (broker fix), the `cmd:"upgrade"` / `type:"full"` / `content:"app"`
  invariants.
- **Memory: `ota-percentage-meaning.md`** — percent-bucket semantics:
  0..62 download, 62..68 unpack, 68..100 install.
- **`CLAUDE.md` "OTA — KRITIEK"** — known-working payload + broker-
  level tz strip in `server/src/mqtt/broker.ts authorizePublish`.
- **Ghidra decompile:** `research/ghidra_output/mqtt_node_decompiled.c`
  lines 350945-350998 — confirms the firmware reads `tz` and forces
  `type:"increment"` when present. This is the precise reason the
  broker strip exists.
- **Memory: `firmware-aes-versions.md`** — v5.x firmware does NOT use
  AES (relevant if a downgrade ever appears in the wild). v6.x always
  uses AES.
- **Existing server-side code path:**
  `server/src/routes/dashboard.ts` `POST /api/dashboard/ota/trigger/:sn`
  emits the exact payload our `ota_client.py` must accept.

## Phase 2 / Phase 4 implementation note

`mower/mqtt_node/ota_client.py` (Phase 2 Task 2.12) implements:
- HTTP download via `requests.get(url)` (no Range yet — the helper can
  add Range support if firmware images grow > a few MB)
- MD5 verify against payload `md5` field
- Atomic install staged at `/userdata/ota/firmware.tar.gz` (real
  unpack + system-path `mv` deferred until after acceptance test)
- Progress reports via `ota_upgrade_state {percent: 0..100}`

The current implementation is sufficient for Phase 0..5 unit tests.
Live OTA on hardware is a Phase-after-acceptance concern.

## Refresh path

When live capture is needed:

```bash
mkdir -p /tmp/mqtt_node_captures
python3 tools/mqtt_node_capture.py \
  --broker 127.0.0.1 --duration-sec 600 \
  --out /tmp/mqtt_node_captures/ota-$(date +%F).jsonl
```

(User triggers OTA from dashboard during the 10-min window.)

Then update this doc with the captured `ota_upgrade_cmd` +
`ota_upgrade_state` JSON examples.
