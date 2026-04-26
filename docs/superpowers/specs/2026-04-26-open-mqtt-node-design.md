# Open `mqtt_node` Drop-in Replacement — Design

**Status:** spec, awaiting user sign-off then writing-plans.
**Branch:** `feat/open-mqtt-node`
**Author flow:** brainstorming skill, 2026-04-26.
**Successor of:** open `robot_decision` (drop-in completed on `master` 2026-04-26, awaits hardware activation).
**Project memory:** `project-open-mqtt-node.md` (currently TODO).

## 1. Goal

100% drop-in Python (`rclpy`) replacement for the proprietary `mqtt_node` ARM64 binary (~6.3 MB) shipped on Novabot mowers. Replaces the MQTT↔ROS2 bridge so we own the full stack between the cloud/app and the robot's ROS 2 graph. Ships without the stock binary's domain whitelist (so any custom MQTT broker is accepted) and with optional AES bypass for debugging.

## 2. Why

- **Stock binary is closed.** Every protocol change today requires Ghidra + binary patching.
- **Domain whitelist** in stock `mqtt_node` rejects `set_mqtt_info` payloads pointing at a direct IP, blocking provisioning against a self-hosted broker without DNS rewrites.
- **Local cloud replacement project** (`server/`) has been functional for over a year, but the mower-side bridge is still the original closed component. Owning both ends closes the open-source loop.
- **Open `robot_decision`** lands on `master` in the same session this spec is written; with both pieces open we can rebuild the entire mower runtime from source.

## 3. Constraints

- **No deploys to the mower until acceptance test signed off** — code lands on a branch, awaits user OK.
- **Same activation gating as open `robot_decision`** — branch + tests green + manual acceptance test runtime.
- **Must coexist with stock `robot_decision` AND with open `robot_decision`** in any combination (both open is the goal but not a precondition).
- **AES still required** by default — protocol parity with the existing app + server. Bypass is per-SN flag for debugging only.
- **No autonomous mower SSH that triggers movement** — research phase is read-only introspection only.
- **Drop-in placement** — the launch file pointer can be flipped to our binary; rollback = revert one launch line.

## 4. Decisions made during brainstorming

| Decision | Choice | Rationale |
|---|---|---|
| Deployment scope | Drop-in on mower (replaces stock binary at runtime) | Domain-whitelist fix only works on the mower side. Other options don't address the actual constraint. |
| Implementation language | Python (`rclpy`) | Matches `mower/robot_decision.py` open implementation. Faster to write, easier to maintain. paho-mqtt + rclpy is robust for the message rate this node handles (≤10 Hz reports + AES). |
| Feature parity | Full drop-in (every API stock exposes) | Nothing should regress when stock binary is replaced. Coexistence guarantees aren't enough — the app + dashboard exercise the entire surface. |
| Research order | Bottom-up (Ghidra + binary strings + live introspection FIRST, code SECOND) | Audited last week that open `robot_decision` shipped 8 fabricated field names because field choices were derived from RE docs not live `.srv/.action/.msg` files. Bottom-up is the discipline that prevents the same regression. |
| Domain whitelist + AES | Whitelist removed entirely; AES optional via per-SN bypass flag | Whitelist removal solves the immediate problem; AES bypass adds a debug knob without forcing the production protocol to change. |
| Branch lifecycle | `feat/open-mqtt-node` from `master` | Isolated from `master` until acceptance. Same pattern as `feat/open-decision-finish`. |

## 5. Architecture

### 5.1 File layout

```
mower/mqtt_node/
├── __init__.py
├── main.py                 # Entry. rclpy.init → wire modules → MultiThreadedExecutor → spin
├── aes.py                  # AES-128-CBC encrypt/decrypt + key derivation. Per-SN bypass flag.
├── mqtt_client.py          # paho-mqtt wrapper. Reconnect, QoS=1, topic management. NO domain whitelist.
├── ros2_bridge.py          # rclpy.Node 'mqtt_node'. Service clients, action clients, topic pubs/subs.
├── ble_handler.py          # Bluez D-Bus GATT server. Provisioning command dispatch.
├── ota_client.py           # HTTP firmware download + MD5 verify + atomic install + progress reporter.
├── http_client.py          # net_check_fun + http_work_fun periodic loops.
├── sensor_aggregator.py    # ROS2 topic state cache → MQTT report builder.
├── command_dispatcher.py   # MQTT inbound JSON → router to handler module.
├── config.py               # /userdata/json_config.json + http_address.txt + env var overrides.
└── tests/
    ├── test_aes_roundtrip.py
    ├── test_field_name_verification.py
    ├── test_command_dispatcher.py
    ├── test_sensor_aggregator.py
    ├── test_mqtt_payload_parity.py
    ├── test_ble_handler.py
    ├── test_ota_client.py
    └── runtime/
        ├── README.md
        ├── parity_capture.sh
        ├── parity_smoke.sh
        └── acceptance_checklist.md
```

Total estimate: ~2760 LOC across 10 source files. Stock binary ~6.3 MB stripped → ~30k LOC C++ guess. Python compaction ~5–10× is normal for ROS bridges.

### 5.2 Process model

- Single Python 3 process.
- `MultiThreadedExecutor` (≥4 threads) to mirror `mower/robot_decision.py` pattern.
- paho-mqtt callback runs on its own thread; protected handoff to `command_dispatcher` via `rclpy` callback group.
- Bluez D-Bus mainloop in its own thread with manual joining on shutdown.

### 5.3 Data flow

**Inbound MQTT → ROS2:**

```
mqtt_client.on_message(topic='Dart/Send_mqtt/<SN>', payload=ciphertext)
  → aes.decrypt(SN, payload) → utf-8 JSON
  → command_dispatcher.dispatch(parsed)
  → ros2_bridge.call_service(<srv>, request)  // or send_action_goal, or topic publish
  → ros2_bridge waits result → returns to dispatcher
  → dispatcher builds <cmd>_respond payload
  → aes.encrypt(SN, payload) → mqtt_client.publish('Dart/Receive_mqtt/<SN>')
```

**Outbound ROS2 → MQTT (sensor reports):**

```
sensor_aggregator subscribes to: battery_message, chassis_incident, motor_current,
                                 /robot_combination_localization/combination_status,
                                 odom_raw, /robot_decision/robot_status, etc.
sensor_aggregator timer (5s) → build report_state_robot JSON from cached state
  → aes.encrypt → mqtt_client.publish('Dart/Receive_server_mqtt/<SN>')
sensor_aggregator timer (5s) → build report_state_timer_data JSON
  → aes.encrypt → mqtt_client.publish('Dart/Receive_mqtt/<SN>')
sensor_aggregator on chassis_incident bit set → build report_state_exception
  → publish event-driven (no timer)
```

**Inbound BLE → MQTT (provisioning):**

```
ble_handler bluez D-Bus GATT char write → frame parser (le_start/le_end)
  → command_dispatcher.dispatch(parsed)  // shared dispatcher
  → if cmd is set_wifi_info / set_mqtt_info / set_lora_info / set_cfg_info:
      handler updates /userdata/json_config.json + http_address.txt
      handler triggers mqtt_client.reconnect() if broker changed
  → response framed back via ble_handler GATT char notify
```

**OTA flow:**

```
mqtt inbound ota_upgrade_cmd → command_dispatcher → ota_client.handle_upgrade
  → ota_client downloads from URL via HTTP Range requests, writes /userdata/ota/firmware.tar.gz
  → ota_client MD5-verifies against payload md5
  → ota_client publishes ota_upgrade_state {percent: 0..62} during download
  → ota_client unpacks (62..68%)
  → ota_client installs (atomic mv) (68..100%)
  → ota_client publishes ota_upgrade_state {percent: 100}
  → caller reboots mower (or signals systemd)
```

### 5.4 Per-module responsibility

| Module | Responsibility | Key APIs | LOC est |
|---|---|---|---|
| `aes.py` | AES-128-CBC encrypt/decrypt; key derivation `"abcdabcd1234"+SN[-4:]`; static IV `"abcd1234abcd1234"`; null-byte padding (NOT PKCS7); per-SN bypass flag | `encrypt(sn,bytes)`, `decrypt(sn,bytes)`, `set_bypass(sn,bool)` | ~80 |
| `mqtt_client.py` | paho-mqtt wrapper. Topics `Dart/Send_mqtt/<SN>` (in), `Dart/Receive_mqtt/<SN>` + `Dart/Receive_server_mqtt/<SN>` (out). Reconnect loop, QoS=1. Reads broker host from `http_address.txt` + `json_config.json`. NO domain whitelist | `connect()`, `publish(topic, payload, encrypted=True)`, `on_message(cb)` | ~200 |
| `ros2_bridge.py` | `rclpy.Node('mqtt_node')`. All service clients (~30: start_run, stop_to_charge, save_map, set_para_info, etc.). All action clients (NavigateThroughCoveragePaths, BoundaryFollow, AutoCharging, NavigateToPose). All topic subs. Pose+heading reads from `/robot_combination_localization`. Wait_for_service patterns | `call_service(name, req)`, `send_action_goal(name, goal)`, `subscribe(topic, cb)` | ~600 |
| `ble_handler.py` | Bluez D-Bus GATT server. Service + char UUIDs from memory `ble-provisioning-protocol.md`. Frame protocol (`le_start`/`le_end`). Commands: `set_wifi_info`, `set_lora_info`, `set_mqtt_info`, `set_cfg_info`, `get_signal_info`, `set_rtk_info`. Per-frame chunking | `start_advertising()`, `on_command(cb)` | ~400 |
| `ota_client.py` | Handle `ota_upgrade_cmd`. HTTP download via Range. MD5 verify. Atomic install (download → unpack → mv). Progress reports as `ota_upgrade_state`. Critical: NO `tz` field in respond per memory `ota-percentage-meaning.md` + CLAUDE.md OTA section | `handle_upgrade(cmd_dict)`, `progress_cb(pct)` | ~250 |
| `http_client.py` | Periodic loops: `net_check_fun` (POST `/api/nova-network/network/connection` every 30 s), `http_work_fun` (sensor sync). `queryEquipmentMap` NOT implemented (closed binary doesn't either) | `start()`, `stop()` | ~150 |
| `sensor_aggregator.py` | Subscribe to ROS2 topics + cache state. Build `report_state_robot` (5 s timer), `report_state_timer_data` (5 s timer), `report_state_exception` (event-driven). Map ROS2 fields → MQTT JSON keys per `docs/reference/MQTT.md` | `start_publishing()`, `add_sensor(topic, type)` | ~400 |
| `command_dispatcher.py` | Parse inbound MQTT JSON → route to handler. Command catalog (~50 commands: `start_run` → ros2_bridge.call('start_cov_task'), `auto_recharge` → action goal, `set_para_info` → param set, etc.). Strip `tz` from `ota_upgrade_cmd` per CLAUDE.md OTA fix | `dispatch(cmd_dict)`, `register(cmd_name, handler)` | ~500 |
| `config.py` | Read `/userdata/json_config.json` mqtt section, `http_address.txt`, `/userdata/lfi/maps/` paths. Env var overrides (`AES_BYPASS=1`, `BROKER_HOST=...`) | `load()` returns `Config` dataclass | ~100 |
| `main.py` | Wire everything: rclpy.init → instantiate modules → register MQTT callbacks → MultiThreadedExecutor → spin. Signal handlers for graceful shutdown | `main()` | ~80 |

### 5.5 Drop-in placement on mower

- Files at `/userdata/open_mqtt_node/` (scp-deployed).
- Activation: edit `/root/novabot/install/novabot_api/share/novabot_api/launch/novabot_api_launch.py` so the `mqtt_node` lifecycle node points at our `main.py` instead of the stock binary.
- Rollback: revert that single launch-file line. Stock binary stays on disk untouched.
- Process supervisor: existing systemd / `respawn=True` in launch file works unchanged for our Python entry point.

## 6. Bottom-up RE phase

These artifacts MUST exist before implementation starts. Each is an output of subagent research work landing on the branch.

| # | Artifact | Source | Output path |
|---|---|---|---|
| RE-1 | Ghidra full decompile (mqtt_node binary → C decomp + functon graph) | `research/firmware/mower_v6.0.0_backup/mqtt_node` | `research/ghidra_output/mqtt_node_decompiled.c` |
| RE-2 | Binary string analysis (categorised: MQTT topics, error msgs, command names, API paths, magic constants) | `strings -a mqtt_node` | `research/documents/mqtt_node-strings.md` |
| RE-3 | Live ROS2 graph snapshot (`ros2 node info /mqtt_node` + service/action/topic types) | SSH READ-ONLY against `192.168.0.100` | `research/documents/mqtt_node-graph-snapshot.txt` |
| RE-4 | MQTT capture catalog (all inbound + outbound payloads during 30 min normal operation: mowing, mapping, dock, idle, error). Per-cmd example JSON | `mosquitto_sub` on broker with `aes.decrypt` | `research/documents/mqtt_node-payload-catalog.md` |
| RE-5 | Command catalog (cmd name → ROS2 service/action/topic + request fields + response fields) | Cross-reference Ghidra + capture + `docs/reference/MQTT.md` | `research/documents/mqtt_node-command-catalog.md` |
| RE-6 | BLE GATT trace (Bluez D-Bus calls + char read/write during provisioning) | `btmon` or bluez logs during a fresh provisioning session | `research/documents/mqtt_node-ble-trace.md` |
| RE-7 | OTA flow trace (captured MQTT + HTTP traffic during one OTA upgrade) | Existing `docs/reference/OTA.md` + one live capture | `research/documents/mqtt_node-ota-flow.md` |
| RE-8 | AES validation (decrypt 100 capture messages via our `aes.py` → diff vs known plaintext) | Captured MQTT traffic + existing `server/src/mqtt/decrypt.ts` reference | `research/documents/mqtt_node-aes-validation.md` |
| RE-9 | Gap analysis (stock binary capability matrix vs current state = 0%) | Cross-reference all of the above | `research/documents/mqtt_node-gap-analysis.md` |
| RE-10 | Field-name cache extension (covering everything `mqtt_node` touches that isn't already in `research/ros2_msg_definitions/`) | SSH dump | extend existing dir |

Estimated effort: 3–5 days of subagent work. Ghidra decompile is the largest single item.

## 7. Test strategy

| # | Test | What | Where | Run |
|---|---|---|---|---|
| T-1 | AST field-name verification | Reuse `mower/tests/test_field_name_verification.py` framework. Cross-check `<Type>.Request()/.Goal()` field assignments in `mower/mqtt_node/*.py` against `research/ros2_msg_definitions/` | `mower/mqtt_node/tests/test_field_name_verification.py` | pytest |
| T-2 | AES round-trip | Encrypt/decrypt sample payloads. Validate against `server/src/mqtt/decrypt.ts` reference + capture-level decrypt | `tests/test_aes_roundtrip.py` | pytest |
| T-3 | MQTT payload parity | Per captured stock-binary payload: feed through our `command_dispatcher` → assert produced response payload byte-equal to stock response (after deterministic JSON key sorting) | `tests/test_mqtt_payload_parity.py` | pytest with fixtures from RE-4 catalog |
| T-4 | Sensor aggregator timing | Mock ROS2 publishers → assert `report_state_robot` builds correct payload at 5 s rate | `tests/test_sensor_aggregator.py` | pytest |
| T-5 | Command dispatcher coverage | For every documented command in catalog → assert handler exists and accepts payload schema | `tests/test_command_dispatcher.py` | pytest |
| T-6 | BLE handler unit | Mock D-Bus connection → assert frame parser + command dispatch work. No live BLE in CI | `tests/test_ble_handler.py` | pytest |
| T-7 | OTA flow unit | Mock HTTP server → assert download → MD5 verify → install path. Skip real unpack | `tests/test_ota_client.py` | pytest |
| T-8 | Endpoint name verification | Reuse framework. Every `create_client/publisher/subscription` literal must appear in `mqtt_node-graph-snapshot.txt` | extend existing framework | pytest |
| T-9 | Runtime parity smoke | SSH script: kill stock mqtt_node → start ours → run 30 min → diff sensor reports + ROS2 graph vs baseline. Manual hardware test | `tests/runtime/parity_smoke.sh` | bash on mower |
| T-10 | Acceptance checklist | Document with 20+ user-confirmation steps for activation (boot, mapping, mowing, dock, OTA, BLE provision). Not autonomous | `tests/runtime/acceptance_checklist.md` | manual |

CI-checkable subset: T-1..T-8 run on Mac dev (no `rclpy` needed — pure Python parsing/AST). T-9, T-10 are hardware. Coverage target: 80%+ unit test coverage on pure-logic modules; 100% AST validation of field names + endpoint names.

## 8. Activation, rollback, branch lifecycle

### 8.1 Branch

- Name: `feat/open-mqtt-node`
- Base: `master` (post merge of open `robot_decision`)
- No merge to `master` until acceptance test passes

### 8.2 Deployment locations on mower

- `/userdata/open_mqtt_node/` — Python files (scp from dev host)
- `/userdata/open_mqtt_node/start.sh` — kill stock mqtt_node, exec our `main.py`
- `/userdata/open_mqtt_node/deploy.sh` — scp from dev host → mower
- `/userdata/open_mqtt_node/rollback.sh` — relaunch stock binary

### 8.3 Activation flow

1. SSH to mower
2. `bash /userdata/open_mqtt_node/start.sh`
3. Verify via `ros2 node info /mqtt_node` — same graph as stock
4. App + dashboard test via cloud flow
5. On failure: `bash /userdata/open_mqtt_node/rollback.sh`

### 8.4 Rollback strategy

- Stock binary stays on disk (no overwrite)
- `start.sh` only does `pkill -f mqtt_node` + start ours
- Mower reboot = stock binary respawns (systemd respawn rule)
- For permanent activation: edit launch file to point at our entry. Only after extended validation.

### 8.5 Activation gates

- Code in branch + tests green + AST framework happy = ready for user OK
- ❌ Never autonomously deploy
- ❌ Never run acceptance checklist without user confirmation per step
- ✅ Tag `pre-open-mqtt-node-activation` at the merge moment, mirroring open `robot_decision` pattern

### 8.6 Coexistence with open `robot_decision`

- Both can be activated independently
- Open `mqtt_node` + stock `robot_decision` = supported (ROS2 graph compatible)
- Stock `mqtt_node` + open `robot_decision` = supported
- Both open + together = end goal but test in isolation first

### 8.7 Post-activation memory updates

- New memory file `open-mqtt-node-status.md` — tracks per-mower activation state
- Update `project-open-mqtt-node.md` from TODO to status

### 8.8 Branch lifecycle

1. RE phase on branch (3–5 days subagent work) → commits = research artifacts
2. Implementation phase on branch (multi-week subagent-driven dev) → 1 commit per task
3. Code review pass → critical fixes
4. AST + unit tests green → merge candidate
5. User pre-acceptance review → spec sign-off
6. Hardware acceptance test → activation OR fix loop
7. Tag + merge to `master`

## 9. Risk register

| Risk | Mitigation |
|---|---|
| Ghidra decompile is incomplete (stripped sections, indirect calls) | Pair with binary string analysis + live introspection. Fall back to live capture for ambiguous flows. |
| Live MQTT capture misses rare error paths | Targeted scenarios: simulate low battery, lost RTK, blade stall, wifi drop, OTA failure. Each has a known stock response we can capture. |
| BLE GATT D-Bus on the mower is more complex than memory `ble-provisioning-protocol.md` shows | RE phase includes a fresh provisioning capture with `btmon`. If D-Bus in Python proves brittle, fall back to `bluetoothctl` shell-out per command (lower performance, simpler). |
| OTA install corrupts firmware on test mower | Test only on the dev mower (LFIN1231000211 — Alain's hardware), atomic mv pattern, MD5 verify before swap. Stock binary stays intact for rollback. |
| Activation breaks stock app + dashboard | Coexistence-by-design (whichever is running serves the same MQTT topics). Activation is reversible by reboot. |
| Field-name fabrications repeat the open `robot_decision` pattern | Mandatory audit rule (gap-analysis section 0) + AST verification framework already in place from prior project. |
| Scope creep | Decomposition: each module is independently testable + reviewable. Commit-per-task pattern lets us pause without leaving branch in a broken state. |

## 10. Open questions deferred to writing-plans

- Concrete task ordering (RE phase tasks vs implementation tasks vs test tasks).
- Subagent dispatch model (one agent per module vs phased).
- Acceptance checklist content (will be drafted during implementation, signed off by user before activation).

## 11. Cross-references

- Successor of: `docs/superpowers/plans/2026-04-26-finish-open-decision.md` (open robot_decision plan)
- Memory: `project-open-mqtt-node.md`, `ble-provisioning-protocol.md`, `ble-provisioning-facts.md`, `firmware-aes-versions.md`, `ota-percentage-meaning.md`, `mqtt-whitelist-flow.md`
- Reference docs: `docs/reference/MQTT.md`, `docs/reference/BLE.md`, `docs/reference/OTA.md`, `docs/reference/MOWER-INTERNALS.md`, `docs/reference/FIRMWARE-MOWER.md`
- Sister project: `mower/` open `robot_decision` (drop-in ready, awaits activation as of 2026-04-26)
