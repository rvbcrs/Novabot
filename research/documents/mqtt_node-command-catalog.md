# mqtt_node — Command catalog (RE-5)

**Cross-references:**
- Decompile: `research/ghidra_output/mqtt_node_decompiled.c` (752,374 lines, 11,659 functions)
- Live capture (idle only): `research/documents/mqtt_node-payload-catalog.md`
- Graph snapshot: `research/documents/mqtt_node-graph-snapshot.txt`
- Strings: `research/documents/mqtt_node-strings.md`
- Pre-existing docs: `docs/reference/MQTT.md`

> Every entry below cites the source line(s) it was derived from.
> The 2026-04-26 audit of the open robot_decision project surfaced 8
> fabricated field names because field choices were derived from RE
> docs not live `.srv/.action/.msg` files. Citation discipline here
> prevents the same regression in mqtt_node.

> **Capture scope warning**: Live capture is IDLE-ONLY. Mower was sitting
> on charger. Sections A and C commands marked "(no live example)" were
> NOT observed in the 30-min idle window. Their MQTT JSON shapes are
> derived from Ghidra decompile (`Json::Value::operator[]` call sites).

---

## Section A — App → Mower commands (`Dart/Send_mqtt/<SN>`)

### `start_run` (alias: `start_navigation`)

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "start_navigation": { "cmd_num": <int>, "area": <int>, "cutterhigh": <uint8> } }` |
| ROS 2 endpoint | `/robot_decision/start_cov_task` |
| Endpoint type | `decision_msgs/srv/StartCoverageTask` |
| Source — graph | `mqtt_node-graph-snapshot.txt:66` (`/robot_decision/start_cov_task: decision_msgs/srv/StartCoverageTask`) |
| Source — decompile | `mqtt_node_decompiled.c:12874` (client init: `"/robot_decision/start_cov_task"`); `mqtt_node_decompiled.c:347684` (`operator[](...,"start_navigation")`); `mqtt_node_decompiled.c:347740-347744` (`area`, `cutterhigh` fields extracted) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:59-64` |

**Notes:** `start_navigation` is the MQTT key for the start-mowing command (confirmed via decompile — function name `api_start_navigation` at line 347625 processes JSON key `"start_navigation"`, allocates a `StartCoverageTask_Request_`, then calls `/robot_decision/start_cov_task`). The MQTT docs call it `start_run` but the binary uses `start_navigation`.

**Field mapping (request):**
| MQTT JSON key | ROS2 field | Notes |
|---|---|---|
| `area` | `request.map_ids` | uint32 — map id (scalar, NOT array per schema) |
| `cutterhigh` | `request.blade_heights[0]` | uint8 0-7; formula: `cutterhigh = user_cm − 2`; firmware writes to vector |
| `cmd_num` | _(dedup guard)_ | Checked against `novabot_cmd_num`; if equal, command is ignored as duplicate |

**Other StartCoverageTask fields populated from globals:**
| Source | ROS2 field | Notes |
|---|---|---|
| `g_path_direction` | `request.specify_direction` + `request.cov_direction` | Set if `g_path_direction != -1`; `mqtt_node_decompiled.c:347776-347780` |
| `g_obstacle_avoidance_sensitivity` | `request.perception_level` | `mqtt_node_decompiled.c:347783-347784` |
| `g_sound` / `g_headlight` | `request.blade_info_level` | LED/buzzer combo; `mqtt_node_decompiled.c:347760-347775` |
| `request_type` hardcoded | `request.request_type` | Hardcoded `0xb` (=11 = MQTT normal start); `mqtt_node_decompiled.c:347738` |

**Field mapping (response):**
| ROS2 response field | MQTT JSON key | Notes |
|---|---|---|
| `response.result` | included in `start_navigation_respond` | `bool` |

**Schema:** `research/ros2_msg_definitions/decision_msgs/srv/StartCoverageTask.srv`

---

### `stop_run` / `stop_task`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "stop_task": <any> }` |
| ROS 2 endpoint | `/robot_decision/stop_task` |
| Endpoint type | `std_srvs/srv/SetBool` |
| Source — graph | `mqtt_node-graph-snapshot.txt:69` (`/robot_decision/stop_task: std_srvs/srv/SetBool`) |
| Source — decompile | `mqtt_node_decompiled.c:12902` (client init: `"/robot_decision/stop_task"`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:63-64` (`stop_run` / `stop_run_respond`) |

**Notes:** Strings doc shows `stop_task` as the MQTT key (`mqtt_node-strings.md:120`). ROS2 service is `SetBool` — the `data` bool value sent is `<unknown — needs Ghidra deep-dive>` (likely `true` = stop).

**Schema:** `research/ros2_msg_definitions/std_srvs/srv/SetBool.srv`

---

### `pause_run`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "pause_run": <any> }` |
| ROS 2 endpoint | `/MidPauseTask` |
| Endpoint type | `novabot_msgs/srv/Common` |
| Source — graph | `mqtt_node-graph-snapshot.txt:47` (`/MidPauseTask: novabot_msgs/srv/Common`) |
| Source — decompile | `mqtt_node_decompiled.c:12930` (client init: `"MidPauseTask"`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:65` (`pause_run` / `pause_run_respond`) |

**Field mapping (request):**
| MQTT JSON key | ROS2 field | Notes |
|---|---|---|
| _(body)_ | `request.data` | `string`; exact payload `<unknown — needs Ghidra deep-dive>` |

**Schema:** `research/ros2_msg_definitions/novabot_msgs/srv/Common.srv`

---

### `resume_run`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "resume_run": <any> }` |
| ROS 2 endpoint | `/ResumeTask` (primary) and `/MidResumeTask` (secondary) |
| Endpoint type | `novabot_msgs/srv/Common` |
| Source — graph | `mqtt_node-graph-snapshot.txt:49` (`/ResumeTask: novabot_msgs/srv/Common`); `mqtt_node-graph-snapshot.txt:48` (`/MidResumeTask: novabot_msgs/srv/Common`) |
| Source — decompile | `mqtt_node_decompiled.c:12958` (client init: `"ResumeTask"`); `mqtt_node_decompiled.c:12987` (client init: `"MidResumeTask"`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:66` (`resume_run` / `resume_run_respond`) |

**Schema:** `research/ros2_msg_definitions/novabot_msgs/srv/Common.srv`

---

### `go_to_charge`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "go_to_charge": <any> }` |
| ROS 2 endpoint | `/robot_decision/nav_to_recharge` |
| Endpoint type | `decision_msgs/srv/Charging` |
| Source — graph | `mqtt_node-graph-snapshot.txt:62` (`/robot_decision/nav_to_recharge: decision_msgs/srv/Charging`) |
| Source — decompile | `mqtt_node_decompiled.c:12790` (client init: `"/robot_decision/nav_to_recharge"`); `mqtt_node_decompiled.c:350102` (`operator[](...,"go_to_charge")`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:87` (`go_to_charge` / `go_to_charge_respond`) |

**Notes:** `api_go_to_charge` function at line 350041. The ROS2 request fields (`name`, `pose_x`, `pose_y`, `pose_theta`, `mode`) are populated from internal state — exact mapping `<unknown — needs Ghidra deep-dive>` beyond the MQTT key name.

**Field mapping (response):**
| ROS2 response field | MQTT JSON key | Notes |
|---|---|---|
| `response.result` | in `go_to_charge_respond` | uint8 |

**Schema:** `research/ros2_msg_definitions/decision_msgs/srv/Charging.srv`

---

### `go_pile`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "go_pile": <any> }` |
| ROS 2 endpoint | `<unknown — needs Ghidra deep-dive>` |
| Endpoint type | `<unknown — needs Ghidra deep-dive>` |
| Source — decompile | Not found as separate api_ function; may share `go_to_charge` handler or be a distinct path |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:88` (`go_pile` / `go_pile_respond`) |
| Source — strings | `mqtt_node-strings.md` (`go_pile`, `go_pile_respond`) |

---

### `stop_to_charge`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "stop_to_charge": <any> }` |
| ROS 2 endpoint | `/robot_decision/cancel_recharge` |
| Endpoint type | `std_srvs/srv/Trigger` |
| Source — graph | `mqtt_node-graph-snapshot.txt:55` (`/robot_decision/cancel_recharge: std_srvs/srv/Trigger`) |
| Source — decompile | `mqtt_node_decompiled.c:12818` (client init: `"/robot_decision/cancel_recharge"`); `mqtt_node_decompiled.c:349576` (`operator[](...,"stop_to_charge")`); `mqtt_node_decompiled.c:349527` (function `api_stop_to_charge`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:89` (`stop_to_charge` / `stop_to_charge_respond`) |

**Notes:** Trigger service has no request fields. Response wraps `stop_to_charge_respond`.

**Schema:** `research/ros2_msg_definitions/std_srvs/srv/Trigger.srv`

---

### `auto_recharge`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "auto_recharge": <any> }` |
| ROS 2 endpoint | `/robot_decision/auto_recharge` |
| Endpoint type | `std_srvs/srv/Trigger` |
| Source — graph | `mqtt_node-graph-snapshot.txt:54` (`/robot_decision/auto_recharge: std_srvs/srv/Trigger`) |
| Source — decompile | `mqtt_node_decompiled.c:12846` (client init: `"/robot_decision/auto_recharge"`); `mqtt_node_decompiled.c:349064` (`operator[](...,"auto_recharge")`); `mqtt_node_decompiled.c:349015` (function `api_auto_recharge`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:90` (`auto_recharge` / `auto_recharge_respond`) |

**Schema:** `research/ros2_msg_definitions/std_srvs/srv/Trigger.srv`

---

### `start_scan_map`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "start_scan_map": { "cmd_num": <int>, "model": "<string>", "mapName": "<string>", "type": <int> } }` |
| ROS 2 endpoint | `/robot_decision/start_mapping` |
| Endpoint type | `decision_msgs/srv/StartMap` |
| Source — graph | `mqtt_node-graph-snapshot.txt:68` (`/robot_decision/start_mapping: decision_msgs/srv/StartMap` — via client init at line 12537) |
| Source — decompile | `mqtt_node_decompiled.c:12537` (client init: `"/robot_decision/start_mapping"`); `mqtt_node_decompiled.c:341434` (`operator[](...,"start_scan_map")`); `mqtt_node_decompiled.c:341485-341504` (`cmd_num`, `model`, `mapName`, `type` extracted); `mqtt_node_decompiled.c:341580` (sends to `decision_msgs::srv::StartMap`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:97` (`start_scan_map` / `start_scan_map_respond`) |

**Field mapping (request):**
| MQTT JSON key | ROS2 field | Notes |
|---|---|---|
| `model` | `request.model` | `string` — mapping model name |
| `mapName` | `request.mapname` | `string` — map file name |
| `type` | `request.type` | `uint8` — 0 = work map, 1 = obstacle map |
| `cmd_num` | _(dedup guard)_ | Not forwarded to ROS2; used to deduplicate requests |

**Schema:** `research/ros2_msg_definitions/decision_msgs/srv/StartMap.srv`

---

### `add_scan_map`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "add_scan_map": { "cmd_num": <int>, "mapName": "<string>", "type": <int> } }` |
| ROS 2 endpoint | `/robot_decision/add_area` |
| Endpoint type | `decision_msgs/srv/StartMap` |
| Source — graph | `mqtt_node-graph-snapshot.txt:53` (`/robot_decision/add_area: decision_msgs/srv/StartMap`) |
| Source — decompile | `mqtt_node_decompiled.c:12565` (client init: `"/robot_decision/add_area"`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:99` (`add_scan_map` / `add_scan_map_respond`) |

**Notes:** `add_scan_map` uses `type:0` for unicom (work boundary), `type:1` for obstacle. Confirmed in `research/documents/novabot-ble-mapping-protocol.md` (MAPPING-FLOW reference doc). Function `api_add_scan_map` at decompile line 340269.

**Field mapping (request):**
| MQTT JSON key | ROS2 field | Notes |
|---|---|---|
| `mapName` | `request.mapname` | `string` |
| `type` | `request.type` | `uint8`; 0 = unicom/work, 1 = obstacle |
| `cmd_num` | _(dedup guard)_ | Not forwarded |

**Schema:** `research/ros2_msg_definitions/decision_msgs/srv/StartMap.srv`

---

### `stop_scan_map`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "stop_scan_map": { "cmd_num": <int>, "mapName": "<string>", "value": <bool> } }` |
| ROS 2 endpoint | `/robot_decision/map_stop_record` |
| Endpoint type | `std_srvs/srv/SetBool` |
| Source — graph | `mqtt_node-graph-snapshot.txt:63` (`/robot_decision/map_stop_record: std_srvs/srv/SetBool`) |
| Source — decompile | `mqtt_node_decompiled.c:12593` (client init: `"/robot_decision/map_stop_record"`); function `api_stop_scan_map` at line 341927 |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:98` (`stop_scan_map` / `stop_scan_map_respond`) |

**Notes:** `value: false` (NOT `true`) for obstacle mapping stop — confirmed in `docs/reference/MAPPING-FLOW.md`.

**Schema:** `research/ros2_msg_definitions/std_srvs/srv/SetBool.srv`

---

### `save_map`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "save_map": { "cmd_num": <int>, "mapName": "<string>", "type": <int> } }` |
| ROS 2 endpoint | `/robot_decision/save_map` |
| Endpoint type | `decision_msgs/srv/SaveMap` |
| Source — graph | `mqtt_node-graph-snapshot.txt:64` (`/robot_decision/save_map: decision_msgs/srv/SaveMap`) |
| Source — decompile | `mqtt_node_decompiled.c:12649` (client init: `"/robot_decision/save_map"`); `mqtt_node_decompiled.c:339763` (`operator[](...,"save_map")`); `mqtt_node_decompiled.c:339821-339830` (`mapName`, `type` extracted, `type` stored as `int64`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:114` (`save_map` / `save_map_respond`) |

**Notes:** Sent TWICE per mapping session: `type:0` (sub map, writes CSV) and `type:1` (total map, generates `map.pgm/png/yaml`). See `CLAUDE.md` "BLE Mapping — save_map type:0 vs type:1".

**Field mapping (request):**
| MQTT JSON key | ROS2 field | Notes |
|---|---|---|
| `mapName` | `request.mapname` | `string` |
| `type` | `request.type` | `int64`; 0 = sub map, 1 = total map |
| `cmd_num` | _(dedup guard)_ | `resolution` uses ROS2 default (0.0) |

**Field mapping (response):**
| ROS2 response field | MQTT JSON key | Notes |
|---|---|---|
| `response.result` | in `save_map_respond` | uint8 |
| `response.error_code` | in `save_map_respond` | uint8; 1=overlap other map, 2=overlap unicom, 3=cross multi maps |

**Schema:** `research/ros2_msg_definitions/decision_msgs/srv/SaveMap.srv`

---

### `delete_map`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "delete_map": { "mapName": "<string>", "maptype": <uint8> } }` |
| ROS 2 endpoint | `/robot_decision/delete_map` |
| Endpoint type | `decision_msgs/srv/DeleteMap` |
| Source — graph | `mqtt_node-graph-snapshot.txt:57` (`/robot_decision/delete_map: decision_msgs/srv/DeleteMap`) |
| Source — decompile | `mqtt_node_decompiled.c:12706` (client init: `"/robot_decision/delete_map"`); `mqtt_node_decompiled.c:345258` (`operator[](...,"delete_map")`); `mqtt_node_decompiled.c:345201` (function `api_delete_map`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:115` (`delete_map` / `delete_map_respond`) |

**Field mapping (request):**
| MQTT JSON key | ROS2 field | Notes |
|---|---|---|
| `mapName` | `request.mapname` | `string` |
| `maptype` | `request.maptype` | `uint8` — `<unknown — needs Ghidra deep-dive>` for exact enum values |

**Field mapping (response):**
| ROS2 response field | MQTT JSON key | Notes |
|---|---|---|
| `response.result` | in `delete_map_respond` | uint8 |
| `response.description` | in `delete_map_respond` | string |

**Schema:** `research/ros2_msg_definitions/decision_msgs/srv/DeleteMap.srv`

---

### `get_map_list`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "get_map_list": <any> }` |
| ROS 2 endpoint | _(no ROS2 service call — reads CSV files directly)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:321444` (function `api_get_map_list`); `mqtt_node_decompiled.c:321525` (`operator[](...,"get_map_list")`); `mqtt_node_decompiled.c:321982` (`get_map_list_respond` response key built) |
| Source — capture | No live example (idle-only catalog); sent by server at connect per `onMowerConnected()` |
| Source — docs | `docs/reference/MQTT.md:108` (`get_map_list` / `get_map_list_respond`) |

**Notes:** `api_get_map_list` directly reads files from `/userdata/lfi/maps/home0/csv_file/` — no ROS2 service call. Response is built locally and published back on `Dart/Receive_mqtt/<SN>`.

---

### `save_recharge_pos`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "save_recharge_pos": { "cmd_num": <int>, "mapName": "<string>" } }` |
| ROS 2 endpoint | `/robot_decision/save_charging_pose` |
| Endpoint type | `mapping_msgs/srv/SetChargingPose` |
| Source — graph | `mqtt_node-graph-snapshot.txt:64` (via decompile: `mqtt_node_decompiled.c:12762` init: `"/robot_decision/save_charging_pose"`) |
| Source — decompile | `mqtt_node_decompiled.c:12762` (client init); `mqtt_node_decompiled.c:346293` (function `api_save_recharge_pos`); `mqtt_node_decompiled.c:346414` (`wait_for_service_nanoseconds(save_charging_pose_client,2000000000)`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:92` (`save_recharge_pos` / `save_recharge_pos_respond`) |

**Notes:** Writes charging pose to map; triggers `save_map type:1` 500ms later. `SetChargingPose` fields: `control_mode` (1 = write), `map_file_name`, `child_map_file_name` — exact MQTT→ROS2 field mapping `<unknown — needs Ghidra deep-dive>`.

**Schema:** `research/ros2_msg_definitions/mapping_msgs/srv/SetChargingPose.srv`

---

### `get_recharge_pos`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "get_recharge_pos": <any> }` |
| ROS 2 endpoint | `/robot_decision/save_charging_pose` (control_mode=0 = read) |
| Endpoint type | `mapping_msgs/srv/SetChargingPose` |
| Source — decompile | `mqtt_node_decompiled.c:351987` (function `api_get_recharge_pos`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:91` (`get_recharge_pos` / `get_recharge_pos_respond`) |

**Notes:** Same ROS2 endpoint as `save_recharge_pos` but with `control_mode=0` (read operation per schema comment).

**Schema:** `research/ros2_msg_definitions/mapping_msgs/srv/SetChargingPose.srv`

---

### `quit_mapping_mode`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "quit_mapping_mode": <any> }` |
| ROS 2 endpoint | `/robot_decision/quit_mapping_mode` |
| Endpoint type | `std_srvs/srv/Empty` |
| Source — graph | `mqtt_node-graph-snapshot.txt:65` (via decompile: client init at line 13073) |
| Source — decompile | `mqtt_node_decompiled.c:13073` (client init: `"/robot_decision/quit_mapping_mode"`); `mqtt_node_decompiled.c:338506` (`operator[](...,"quit_mapping_mode")`); `mqtt_node_decompiled.c:338564` (`wait_for_service_nanoseconds(quit_mapping_mode_client,...)`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:103` (`quit_mapping_mode`) |

**Notes:** No-request service. Empty request, firmware quits mapping mode.

**Schema:** `research/ros2_msg_definitions/std_srvs/srv/Empty.srv`

---

### `start_erase_map`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "start_erase_map": { "cmd_num": <int>, "mapName": "<string>" } }` |
| ROS 2 endpoint | `/robot_decision/start_erase` |
| Endpoint type | `std_srvs/srv/SetBool` |
| Source — graph | `mqtt_node-graph-snapshot.txt:67` (`/robot_decision/start_erase: std_srvs/srv/SetBool`) |
| Source — decompile | `mqtt_node_decompiled.c:12734` (client init: `"/robot_decision/start_erase"`); `mqtt_node_decompiled.c:342998` (`operator[](...,"start_erase_map")`); `mqtt_node_decompiled.c:342948` (function `api_start_erase_map`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:100-101` (`start_erase_map` / `start_erase_map_respond`) |

**Schema:** `research/ros2_msg_definitions/std_srvs/srv/SetBool.srv`

---

### `stop_erase_map`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "stop_erase_map": <any> }` |
| ROS 2 endpoint | `/robot_decision/start_erase` (SetBool data=false) |
| Endpoint type | `std_srvs/srv/SetBool` |
| Source — decompile | `mqtt_node_decompiled.c:343451` (function `api_stop_erase_map`); `mqtt_node_decompiled.c:343449` |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:101` (`stop_erase_map` / `stop_erase_map_respond`) |

**Schema:** `research/ros2_msg_definitions/std_srvs/srv/SetBool.srv`

---

### `start_assistant_build_map`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "start_assistant_build_map": { "cmd_num": <int>, "value": <bool> } }` |
| ROS 2 endpoint | `/robot_decision/start_assistant_mapping` |
| Endpoint type | `std_srvs/srv/SetBool` |
| Source — graph | `mqtt_node-graph-snapshot.txt:66` (`/robot_decision/start_assistant_mapping: std_srvs/srv/SetBool`) |
| Source — decompile | `mqtt_node_decompiled.c:342434` (function `api_start_assistant_build_map`); `mqtt_node_decompiled.c:342428` |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:102` (`start_assistant_build_map` / `start_assistant_build_map_respond`) |

**Schema:** `research/ros2_msg_definitions/std_srvs/srv/SetBool.srv`

---

### `generate_preview_cover_path`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "generate_preview_cover_path": { "map_ids": <uint32>, "cov_direction": <uint8>, "specify_direction": <bool> } }` |
| ROS 2 endpoint | `/robot_decision/generate_preview_cover_path` |
| Endpoint type | `decision_msgs/srv/GenerateCoveragePath` |
| Source — graph | `mqtt_node-graph-snapshot.txt:58` (`/robot_decision/generate_preview_cover_path: decision_msgs/srv/GenerateCoveragePath`) |
| Source — decompile | `mqtt_node_decompiled.c:13044` (client init: `"/robot_decision/generate_preview_cover_path"`); `mqtt_node_decompiled.c:345801` (`operator[](...,"generate_preview_cover_path")`); `mqtt_node_decompiled.c:345748` (function `api_generate_preview_cover_path`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:112` (`generate_preview_cover_path` / `generate_preview_cover_path_respond`) |

**Notes:** WARNING: `get_preview_cover_path` (Section A below) causes a buffer overflow in stock mqtt_node when coverage path is large. See `research/memory/get-preview-cover-path-crash.md`.

**Field mapping (request):**
| MQTT JSON key | ROS2 field | Notes |
|---|---|---|
| `map_ids` | `request.map_ids` | uint32 scalar |
| `specify_direction` | `request.specify_direction` | bool |
| `cov_direction` | `request.cov_direction` | uint8, 0-180 degrees |

**Schema:** `research/ros2_msg_definitions/decision_msgs/srv/GenerateCoveragePath.srv`

---

### `get_preview_cover_path`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "get_preview_cover_path": <any> }` |
| ROS 2 endpoint | _(no ROS2 call — reads from `/userdata/lfi/maps/home0/planned_path/preview_planned_path.json`)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:319628` (function `api_get_preview_cover_path`); `mqtt_node_decompiled.c:319658` (`puts("api_get_preview_cover_path\r")`); `mqtt_node_decompiled.c:319662` (`operator[](...,"get_preview_cover_path")`) |
| Source — strings | `mqtt_node-strings.md:115-116` (`get_preview_cover_path`, `get_preview_cover_path_respond`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:111` |

**CRITICAL:** Buffer overflow in stock mqtt_node when path data is large — see `research/memory/get-preview-cover-path-crash.md`.

---

### `start_patrol`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "start_patrol": <any> }` |
| ROS 2 endpoint | _(JSON-echo stub — NO ROS2 call)_ |
| Endpoint type | N/A — stub |
| Source — decompile | `mqtt_node_decompiled.c:321148` (function `api_start_patrol`); `mqtt_node_decompiled.c:321175` (`puts("api_start_patrol\r")`); `mqtt_node_decompiled.c:321179-321204` (`operator[](...,"start_patrol")`); function ends by publishing `start_patrol_respond` with no ROS2 calls |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md` — mentioned but noted as stub in CLAUDE.md |
| Source — CLAUDE.md | "Not via: stock MQTT start_patrol (is JSON-echo stub in mqtt_node, geen ROS call)" |

**Notes:** Confirmed as a stub via decompile. When `start_patrol=null` is received, it logs `"start_patrol=null\r"` and replies with `start_patrol_respond`. No ROS2 endpoint is called. Use `start_navigation` (`/robot_decision/start_cov_task`) for actual mowing.

---

### `stop_patrol`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "stop_patrol": <any> }` |
| ROS 2 endpoint | _(JSON-echo stub — NO ROS2 call)_ |
| Endpoint type | N/A — stub |
| Source — decompile | `mqtt_node_decompiled.c:321296` (function `api_stop_patrol`); `mqtt_node_decompiled.c:321327-321332` (`operator[](...,"stop_patrol")`); no ROS2 calls before `stop_patrol_respond` |
| Source — capture | No live example (idle-only catalog) |

---

### `start_move`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "start_move": <int> }` |
| ROS 2 endpoint | Topic publish `/cloud_move_cmd` |
| Endpoint type | Topic: `novabot_msgs/msg/CloudMoveCmd` (Publisher) |
| Source — graph | `mqtt_node-graph-snapshot.txt:28` (`/cloud_move_cmd: novabot_msgs/msg/CloudMoveCmd` — Publisher) |
| Source — decompile | `mqtt_node_decompiled.c:309062` (function `api_start_move`); `mqtt_node_decompiled.c:309092-309095` (`operator[](...,"start_move")`, value = `asInt()`); `mqtt_node_decompiled.c:309099-309113` (direction decode: 1=left rotate, 2=right rotate, 3=forward, 4=backward); `mqtt_node_decompiled.c:309126-309135` (publishes to `cloud_move_cmd`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:76-82` |

**Notes:** `start_move` MUST be an integer (1-4). Empty object `{}` does NOT work (confirmed in CLAUDE.md). Direction from `start_move` value sets initial motor direction. Follow-up `mst` command (Section A) provides speed magnitude.

**Field mapping (request):**
| MQTT JSON key | ROS2 field | Notes |
|---|---|---|
| _(integer value)_ | `CloudMoveCmd.angular_wheel` | Direction encoded: 1=left(+), 2=right(-), 3=forward(+), 4=backward(-); float constants `0x3eb33333` (≈0.35) |

**Response:** `start_move_respond` with `{ "type": "start_move_respond", "message": { "result": 0, "value": 0 } }` — `mqtt_node_decompiled.c:309177-309187`.

**Schema:** `research/ros2_msg_definitions/novabot_msgs/msg/CloudMoveCmd.msg` (fields: `stamp`, `linear_x` float32, `angular_wheel` float32)

---

### `stop_move`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "stop_move": {} }` |
| ROS 2 endpoint | Topic publish `/cloud_move_cmd` (zero velocity) |
| Endpoint type | `novabot_msgs/msg/CloudMoveCmd` |
| Source — decompile | `mqtt_node_decompiled.c:324363` (function `api_stop_move`); `mqtt_node_decompiled.c:324398` (`operator[](...,"stop_move")`); `mqtt_node_decompiled.c:324461` (`stop_move_respond` key) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:78` |

---

### `ota_upgrade_cmd`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "ota_upgrade_cmd": { "cmd": "upgrade", "type": "full", "content": "app", "url": "http://...", "version": "<string>", "md5": "<string>" } }` |
| ROS 2 endpoint | `/ota_upgrade_srv` (service call — deferred, executes async) |
| Endpoint type | `platform_msgs/srv/OtaUpgradeSys` |
| Source — graph | `mqtt_node-graph-snapshot.txt:51` (`/ota_upgrade_srv: platform_msgs/srv/OtaUpgradeSys`) |
| Source — decompile | `mqtt_node_decompiled.c:350879` (function `api_ota_upgrade_cmd`); `mqtt_node_decompiled.c:350924` (`operator[](...,"ota_upgrade_cmd")`); `mqtt_node_decompiled.c:350945-350998` (`tz` field processing — writes to `/userdata/ota/novabot_timezone.txt` then modifies type to "increment") |
| Source — capture | No live example (idle-only catalog) |
| Source — CLAUDE.md | Critical OTA section — `tz` must be stripped by broker before forwarding |

**CRITICAL:** The `tz` field causes mqtt_node to change `type` from `"full"` to `"increment"` and write `/userdata/ota/novabot_timezone.txt`. The broker (`broker.ts` `authorizePublish`) MUST strip `tz` from the payload before forwarding to the mower. See CLAUDE.md "OTA — KRITIEK".

**Schema:** `platform_msgs/srv/OtaUpgradeSys` — `<schema not yet captured — see Task 1.10 (RE-10)>`

---

### `ota_version_info`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "ota_version_info": null }` |
| ROS 2 endpoint | _(reads local version file — no ROS2 call)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:325157` (function `api_ota_version_info`) |
| Source — strings | `mqtt_node-strings.md:117-118` (`ota_version_info`, `ota_version_info_respond`) |
| Source — capture | No live example; sent by `onMowerConnected()` at server connect |
| Source — docs | `docs/reference/MQTT.md:137` |

**Notes:** Server sends `{ "ota_version_info": null }` at connect. Mower reads its own version from `/userdata/lfi/system_version.txt` and replies with `ota_version_info_respond`.

---

### `get_para_info`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "get_para_info": <any> }` |
| ROS 2 endpoint | _(reads from globals/persistent config — no ROS2 call)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:330596` (function `api_get_para_info`); `mqtt_node_decompiled.c:330633` (`puts("api_get_para_info\r")`); `mqtt_node_decompiled.c:330645` (`operator[](...,"get_para_info")`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:121-125` (parameters: `obstacle_avoidance_sensitivity`, `target_height`, `defaultCuttingHeight`, `path_direction`, `cutGrassHeight`) |

---

### `set_para_info`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "set_para_info": { "obstacle_avoidance_sensitivity": <int>, "target_height": <int>, ... } }` |
| ROS 2 endpoint | _(writes to globals/persistent config — no ROS2 call)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:330288` (function `api_set_para_info`); `mqtt_node_decompiled.c:330325` (`puts("api_set_para_info\r")`); `mqtt_node_decompiled.c:330337` (`operator[](...,"set_para_info")`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:122-123` |

---

### `get_cfg_info`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "get_cfg_info": <any> }` |
| ROS 2 endpoint | _(reads `/userdata/lfi/json_config.json` — no ROS2 call)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:330061` (function `api_get_cfg_info`); `mqtt_node_decompiled.c:330100` (`puts("api_get_cfg_info\r")`); `mqtt_node_decompiled.c:330104` (`operator[](...,"get_cfg_info")`); `mqtt_node_decompiled.c:330129` (`filebuf::open(..."/userdata/lfi/json_config.json"...)`) |
| Source — capture | No live example (idle-only catalog) |
| Source — strings | `mqtt_node-strings.md:83-84` (`get_cfg_info`, `get_cfg_info_respond`) |

---

### `set_cfg_info`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "set_cfg_info": { "tz": "<timezone_string>", ... } }` |
| ROS 2 endpoint | _(writes to `/userdata/lfi/json_config.json` and `/userdata/ota/novabot_timezone.txt`)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:338966` (function `api_set_cfg_info`); `mqtt_node_decompiled.c:338954` |
| Source — strings | `mqtt_node-strings.md:94-95` (`set_cfg_info`, `set_cfg_info_respond`) |
| Source — capture | No live example (idle-only catalog) |

**Notes:** The `tz` field in `set_cfg_info` (BLE provisioning path) is SAFE and works correctly. Only the `tz` field in `ota_upgrade_cmd` causes the OTA type bug. See CLAUDE.md.

---

### `set_lora_info`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "set_lora_info": { "addr": <int>, "channel": <int> } }` |
| ROS 2 endpoint | Action client `/chassis_lora_set` (via pthread) |
| Endpoint type | `novabot_msgs/action/ChassisLoraSet` |
| Source — graph | `mqtt_node-graph-snapshot.txt:73` (`/chassis_lora_set: novabot_msgs/action/ChassisLoraSet`) |
| Source — decompile | `mqtt_node_decompiled.c:308872` (function `api_set_lora_info`); `mqtt_node_decompiled.c:308888` (`operator[](...,"set_lora_info")`); `mqtt_node_decompiled.c:308891-308898` (`addr` and `channel` extracted, stored in `p_addr` / `p_channel` globals); `mqtt_node_decompiled.c:308899` (`pthread_create(...,lora_set_fun,...)`) |
| Source — capture | No live example (idle-only catalog) |
| Source — strings | `mqtt_node-strings.md:98-99` (`set_lora_info`, `set_lora_info_respond`) |

**Field mapping (request):**
| MQTT JSON key | ROS2 field | Notes |
|---|---|---|
| `addr` | `goal.addr` | uint16 stored as `p_addr` global before async thread |
| `channel` | `goal.channel` | uint8 stored as `p_channel` global |

**Schema:** `research/ros2_msg_definitions/novabot_msgs/action/ChassisLoraSet.action` (fields: `channel` uint8, `addr` uint16, `val` uint8)

---

### `dev_pin_info`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "dev_pin_info": { "type": <uint8>, "code": "<string>" } }` |
| ROS 2 endpoint | Action client `/chassis_pin_code_set` |
| Endpoint type | `novabot_msgs/action/ChassisPinCodeSet` |
| Source — graph | `mqtt_node-graph-snapshot.txt:74` (`/chassis_pin_code_set: novabot_msgs/action/ChassisPinCodeSet`) |
| Source — decompile | `mqtt_node_decompiled.c:324554` (function `api_dev_pin_info`) |
| Source — strings | `mqtt_node-strings.md:130-131` (`dev_pin_info`, `dev_pin_info_respond`) |
| Source — capture | No live example (idle-only catalog) |

**Field mapping (request):**
| MQTT JSON key | ROS2 field | Notes |
|---|---|---|
| `type` | `goal.type` | uint8 |
| `code` | `goal.code` | string |

**Schema:** `research/ros2_msg_definitions/novabot_msgs/action/ChassisPinCodeSet.action`

---

### `set_control_mode`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "set_control_mode": { "mode": <int> } }` |
| ROS 2 endpoint | _(no ROS2 call — sets internal g_sound / g_headlight globals)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:320841` (function `api_set_control_mode`) |
| Source — strings | `mqtt_node-strings.md:107-108` (`set_control_mode`, `set_control_mode_respond`) |
| Source — capture | No live example (idle-only catalog) |

---

### `get_version_info`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "get_version_info": <any> }` |
| ROS 2 endpoint | _(reads version files — no ROS2 call)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:324179` (function `api_get_version_info`) |
| Source — strings | `mqtt_node-strings.md:121-122` (`get_version_info`, `get_version_info_respond`) |
| Source — capture | No live example (idle-only catalog) |

---

### `get_dev_info`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "get_dev_info": <any> }` |
| ROS 2 endpoint | _(reads from internal state — no ROS2 call)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:319249` (function `api_get_dev_info`) |
| Source — strings | `mqtt_node-strings.md:87-88` (`get_dev_info`, `get_dev_info_respond`) |
| Source — capture | No live example (idle-only catalog) |

---

### `get_map_plan_path`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "get_map_plan_path": <any> }` |
| ROS 2 endpoint | _(reads from `/userdata/lfi/maps/home0/planned_path/planned_path.json`)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:319427` (function `api_get_map_plan_path`) |
| Source — strings | `mqtt_node-strings.md:110-111` (`get_map_plan_path`, `get_map_plan_path_respond`) |
| Source — capture | No live example (idle-only catalog) |

---

### `get_map_outline`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "get_map_outline": <any> }` |
| ROS 2 endpoint | _(reads CSV files — no ROS2 call)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:323141` (function `api_get_map_outline`) |
| Source — strings | `mqtt_node-strings.md:112-113` (`get_map_outline`, `get_map_outline_respond`) |
| Source — capture | No live example (idle-only catalog) |

---

### `start_time_navigation`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "start_time_navigation": { ... } }` |
| ROS 2 endpoint | `<unknown — needs Ghidra deep-dive>` (likely `/robot_decision/start_cov_task` with timer request_type) |
| Endpoint type | `<unknown — needs Ghidra deep-dive>` |
| Source — decompile | `mqtt_node_decompiled.c:346911` (function `api_start_time_navigation`) |
| Source — strings | `mqtt_node-strings.md:122-123` (`start_time_navigation`, `start_time_navigation_respond`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:143` (`timer_task`) |

---

### `stop_time_navigation`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "stop_time_navigation": <any> }` |
| ROS 2 endpoint | `<unknown — needs Ghidra deep-dive>` |
| Endpoint type | `<unknown — needs Ghidra deep-dive>` |
| Source — decompile | `mqtt_node_decompiled.c:325477` (function `api_stop_time_navigation`); `mqtt_node_decompiled.c:325509` (`operator[](...,"stop_time_navigation")`) |
| Source — strings | `mqtt_node-strings.md:133-134` (`stop_time_navigation`, `stop_time_navigation_respond`) |
| Source — capture | No live example (idle-only catalog) |

---

### `start_navigation` (stop_navigation)

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | _(see `start_run`/`start_navigation` entry above — same command)_ |
| ROS 2 endpoint | `/robot_decision/start_cov_task` |
| Source — decompile | `mqtt_node_decompiled.c:347625` |

**Note:** `stop_navigation` uses `/robot_decision/stop_task`. Function at `mqtt_node_decompiled.c:348340`.

---

### `set_wifi_info`

| Property | Value |
|---|---|
| Direction | app → mower (BLE provisioning path only) |
| MQTT JSON | `{ "set_wifi_info": { "ssid": "<string>", "pwd": "<string>" } }` |
| ROS 2 endpoint | _(writes to `/userdata/lfi/json_config.json` — no ROS2 call)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:332586` (function `api_set_wifi_info`) |
| Source — strings | `mqtt_node-strings.md:103-104` (`set_wifi_info`, `set_wifi_info_respond`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/BLE.md` |

---

### `set_mqtt_info`

| Property | Value |
|---|---|
| Direction | app → mower (BLE provisioning path only) |
| MQTT JSON | `{ "set_mqtt_info": { "host": "<string>", "port": <int>, "username": "<string>", "password": "<string>" } }` |
| ROS 2 endpoint | _(writes to `/userdata/lfi/json_config.json` — no ROS2 call)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:333265` (function `api_set_mqtt_info`) |
| Source — strings | `mqtt_node-strings.md:101-102` (`set_mqtt_info`, `set_mqtt_info_respond`) |
| Source — capture | No live example (idle-only catalog) |

---

### `get_wifi_rssi`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "get_wifi_rssi": <any> }` |
| ROS 2 endpoint | _(reads from system WiFi interface — no ROS2 call)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:331713` (function `api_get_wifi_rssi`) |
| Source — strings | `mqtt_node-strings.md:119-120` (`get_wifi_rssi`, `get_wifi_rssi_respond`) |
| Source — capture | No live example (idle-only catalog) |

---

### `get_current_pose`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "get_current_pose": <any> }` |
| ROS 2 endpoint | _(reads from cached `map_position` sub data — no synchronous ROS2 call)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:320306` (function `api_get_current_pose`) |
| Source — strings | `mqtt_node-strings.md:85-86` (`get_current_pose`, `get_current_pose_respond`) |
| Source — capture | No live example (idle-only catalog) |

---

### `get_vel_odom`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "get_vel_odom": <any> }` |
| ROS 2 endpoint | _(reads from cached odometry data — no synchronous ROS2 call)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:320681` (function `api_get_vel_odom`) |
| Source — strings | `mqtt_node-strings.md:117-118` (`get_vel_odom`, `get_vel_odom_respond`) |
| Source — capture | No live example (idle-only catalog) |

---

### `get_log_info`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "get_log_info": <any> }` |
| ROS 2 endpoint | _(reads log files — no ROS2 call)_ |
| Endpoint type | N/A |
| Source — decompile | `mqtt_node_decompiled.c:325322` (function `api_get_log_info`) |
| Source — strings | `mqtt_node-strings.md:90-92` (`get_log_info`, `get_log_info_pub`, `get_log_info_respond`) |
| Source — capture | No live example (idle-only catalog) |

---

### `reset_map`

| Property | Value |
|---|---|
| Direction | app → mower |
| MQTT JSON | `{ "reset_map": { "mapName": "<string>" } }` |
| ROS 2 endpoint | `/robot_decision/reset_mapping` |
| Endpoint type | `decision_msgs/srv/StartMap` |
| Source — graph | `mqtt_node-graph-snapshot.txt:65` (via decompile line 12621) |
| Source — decompile | `mqtt_node_decompiled.c:12621` (client init: `"/robot_decision/reset_mapping"`); `mqtt_node_decompiled.c:340826` (function `api_reset_map`) |
| Source — strings | `mqtt_node-strings.md:116` (`reset_map`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:116` (`reset_map` / `reset_map_respond`) |

**Schema:** `research/ros2_msg_definitions/decision_msgs/srv/StartMap.srv`

---

### `get_lora_info` (server → charger)

| Property | Value |
|---|---|
| Direction | server → charger |
| MQTT JSON | `{ "get_lora_info": null }` |
| ROS 2 endpoint | N/A (charger ESP32 command) |
| Endpoint type | N/A |
| Source — capture | `mqtt_node-payload-catalog.md:24-36` (LIVE CAPTURE — observed 30×/charger in 30-min idle) |
| Source — docs | `docs/reference/MQTT.md:55` |

---

## Section B — Mower → App reports (`Dart/Receive_mqtt/<SN>`)

### `report_state_robot`

| Property | Value |
|---|---|
| Direction | mower → app |
| MQTT JSON | See live capture example below |
| Period | ~2.3 s |
| ROS 2 source | Subscriber `/robot_decision/robot_status: decision_msgs/msg/RobotStatus` + `/robot_decision/map_position: geometry_msgs/msg/Pose` |
| Source — graph | `mqtt_node-graph-snapshot.txt:20-21` (subscribers) |
| Source — capture | `mqtt_node-payload-catalog.md:53-122` (LIVE CAPTURE) |
| Source — decompile | `mqtt_node_decompiled.c:307941` (function `api_report_state_robot`) |

**Key fields (live example):**
```json
{
  "report_state_robot": {
    "work_status": 9, "task_mode": 2, "recharge_status": 9,
    "error_status": 0, "battery_power": 99, "target_height": 1,
    "loc_quality": 80, "map_num": 1, "current_map_ids": 1,
    "x": -0.94, "y": -0.94, "theta": 1.645,
    "cov_area": 1.27, "cov_remaining_area": 11.57,
    "cpu_temperature": 46, "cpu_usage": 48, "light": 0,
    "perception_level": 0, "finished_num": 0
  }
}
```

**Field mapping (ROS2 → MQTT):**
| ROS2 source | MQTT JSON key | Notes |
|---|---|---|
| `RobotStatus.work_status` | `work_status` | uint8 — 9 = CHARGING_RECHARGE |
| `RobotStatus.task_mode` | `task_mode` | uint8 — 2 = MAPPING |
| `RobotStatus.recharge_status` | `recharge_status` | uint8 |
| `RobotStatus.error_status` | `error_status` | uint8 |
| `RobotStatus.battery_power` | `battery_power` | uint8 percentage |
| `RobotStatus.target_height` | `target_height` | uint8 0-7; display = `target_height + 2` cm |
| `RobotStatus.loc_quality` | `loc_quality` | uint8 0-100 |
| `RobotStatus.map_num` | `map_num` | uint8 = active task count |
| `RobotStatus.current_map_ids` | `current_map_ids` | uint32 |
| `RobotStatus.cov_area` | `cov_area` | float32 m² |
| `RobotStatus.cov_remaining_area` | `cov_remaining_area` | float32 m² |
| `RobotStatus.cov_estimate_time` | `cov_estimate_time` | float32 |
| `RobotStatus.cov_ratio` | `cov_ratio` | float32 |
| `RobotStatus.cov_work_time` | `cov_work_time` | float32 |
| `RobotStatus.valid_cov_work_time` | `valid_cov_work_time` | float32 |
| `RobotStatus.avoiding_obstacle_time` | `avoiding_obstacle_time` | float32 |
| `RobotStatus.cpu_usage` | `cpu_usage` | uint8 |
| `RobotStatus.cpu_temperature` | `cpu_temperature` | uint8 Celsius |
| `RobotStatus.light` | `light` | uint8 |
| `RobotStatus.perception_level` | `perception_level` | uint8 |
| `RobotStatus.finished_num` | `finished_num` | uint8 |
| `RobotStatus.msg` | `msg` | string |
| `RobotStatus.error_msg` | `error_msg` | string |
| `RobotStatus.request_map_ids` | `request_map_ids` | uint32 |
| `RobotStatus.prev_work_status` | `prev_work_status` | uint8 |
| `RobotStatus.prev_recharge_status` | `prev_recharge_status` | uint8 |
| `RobotStatus.prev_task_mode` | `prev_task_mode` | uint8 |
| `Pose.position.x` | `x` | float32 local map x (m) |
| `Pose.position.y` | `y` | float32 local map y (m) |
| `Pose` orientation → yaw | `theta` | float32 heading (rad) |

**Schema:** `research/ros2_msg_definitions/decision_msgs/msg/RobotStatus.msg`

---

### `report_state_timer_data`

| Property | Value |
|---|---|
| Direction | mower → app |
| Period | ~2.3 s (emitted in sync with `report_state_robot`) |
| ROS 2 source | Subscribers: `/robot_decision/covered_path_json`, `/robot_decision/planned_json`, `/robot_decision/preview_planned_json`; `/gps_raw: sensor_msgs/msg/NavSatFix`; internal state |
| Source — graph | `mqtt_node-graph-snapshot.txt:22-23` (subscribers) |
| Source — capture | `mqtt_node-payload-catalog.md:125-196` (LIVE CAPTURE) |
| Source — decompile | `mqtt_node_decompiled.c:329185` (function `api_report_state_timer_data`) |

**Key fields (live example):**
```json
{
  "report_state_timer_data": {
    "battery_capacity": 99, "battery_state": "CHARGING",
    "localization": {
      "gps_position": { "latitude": 52.14, "longitude": 6.23, "altitude": 10.26, "state": "ENABLE" },
      "localization_state": "RUNNING",
      "map_position": { "x": -0.947, "y": 0.260, "orientation": 1.645 }
    },
    "cover_path": { "map_id": "1", "finished_maps": "1", "covered": { "missed": "-0.55 -1.53;" } },
    "if_scan_unicom_obstacle": 16, "timer_task": 0, "plan_path": 0, "preview_cover_path": 0,
    "if_mower_can_finish": false, "if_closed_cycle": 0, "start_edit_or_assistant_map_flag": 16
  }
}
```

**Selected field sources:**
| ROS2 source | MQTT JSON key | Notes |
|---|---|---|
| `ChassisBatteryMessage.battery_rsoc_percent` | `battery_capacity` | uint8 |
| Derived from charging state | `battery_state` | "CHARGING" / "DISCHARGING" / "FULL" |
| `NavSatFix.latitude` | `localization.gps_position.latitude` | float64 WGS84 |
| `NavSatFix.longitude` | `localization.gps_position.longitude` | float64 WGS84 |
| `NavSatFix.altitude` | `localization.gps_position.altitude` | float64 m |
| Coverage JSON string | `cover_path` | Parsed from `covered_path_json` topic |
| `novabot_mapping/if_closed_cycle` | `if_closed_cycle` | bool |
| `novabot_mapping/if_unicom_can_stop` | `if_scan_unicom_obstacle` bitmask | Combined with obstacle flag |
| Internal flag | `start_edit_or_assistant_map_flag` | uint8 bitmask |

---

### `report_exception_state`

| Property | Value |
|---|---|
| Direction | mower → app |
| Period | ~2.3 s (emitted in sync with above) |
| ROS 2 source | Subscriber `/chassis_incident: novabot_msgs/msg/ChassisIncident` |
| Source — graph | `mqtt_node-graph-snapshot.txt:6` (`/chassis_incident: novabot_msgs/msg/ChassisIncident`) |
| Source — capture | `mqtt_node-payload-catalog.md:199-227` (LIVE CAPTURE) |
| Source — decompile | `mqtt_node_decompiled.c:308183` (function `api_report_state_exception`) |

**Key fields (live example):**
```json
{
  "report_exception_state": {
    "button_stop": false, "chassis_err": 0, "no_set_pin_code": false,
    "rtk": true, "rtk_sat": 31, "wifi_rssi": 54
  }
}
```

**Field mapping (ROS2 → MQTT):**
| ROS2 source | MQTT JSON key | Notes |
|---|---|---|
| `ChassisIncident.warning_push_button_stop` | `button_stop` | bool |
| `ChassisIncident.error_set_flag` (bitmask) | `chassis_err` | uint32 bitmask of all chassis errors |
| `ChassisIncident.error_no_set_pin_code` | `no_set_pin_code` | bool |
| GPS subscriber (BestPos) | `rtk` | bool — RTK fix active |
| `BestPos` satellite count | `rtk_sat` | int — RTK satellite count |
| WiFi RSSI (system) | `wifi_rssi` | int |

**Schema:** `research/ros2_msg_definitions/novabot_msgs/msg/ChassisIncident.msg`

---

### `report_state_map_outline`

| Property | Value |
|---|---|
| Direction | mower → app |
| Period | event-driven (on map change) |
| ROS 2 source | _(reads CSV files and publishes on MQTT)_ |
| Source — decompile | `mqtt_node_decompiled.c:323402` (function `api_report_state_map_outline`) |
| Source — strings | `mqtt_node-strings.md:80` (`report_state_map_outline`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:157` |

---

### `report_state_map_path_list`

| Property | Value |
|---|---|
| Direction | mower → app |
| Period | event-driven |
| Source — decompile | `mqtt_node_decompiled.c:319830` (function `api_report_state_map_path_list`) |
| Source — strings | `mqtt_node-strings.md:81` (`report_state_map_path_list`) |
| Source — capture | No live example (idle-only catalog) |

---

### `report_state_unbind`

| Property | Value |
|---|---|
| Direction | mower → app |
| Period | event-driven (on unbind) |
| Source — decompile | `mqtt_node_decompiled.c:319973` (function `api_report_state_unbind`) |
| Source — strings | `mqtt_node-strings.md:82` (`report_state_unbind`) |
| Source — capture | No live example (idle-only catalog) |

---

### `up_status_info` (charger → app)

| Property | Value |
|---|---|
| Direction | charger → app |
| Period | ~2.0 s per charger |
| Source — capture | `mqtt_node-payload-catalog.md:232-276` (LIVE CAPTURE — 894 per charger in 30-min window) |
| Source — docs | `docs/reference/MQTT.md:168-178` (`up_status_info` field table) |

**Key fields:** `charger_status` (bitfield, bits 24-31 = GPS sat count), `mower_status`, `mower_x/y/z`, `mower_info`, `mower_info1`, `mower_error` (LoRa heartbeat fail counter).

---

### `get_map_list_respond`

| Property | Value |
|---|---|
| Direction | mower → app |
| Period | Response to `get_map_list` command |
| ROS 2 source | _(file system read of CSV directory)_ |
| Source — decompile | `mqtt_node_decompiled.c:321982` (`get_map_list_respond` response key built) |
| Source — capture | No live example (idle-only catalog) |

---

### `ota_upgrade_state`

| Property | Value |
|---|---|
| Direction | mower → app |
| Period | event-driven during OTA |
| ROS 2 source | Subscriber `/ota/upgrade_status: std_msgs/msg/String` |
| Source — graph | `mqtt_node-graph-snapshot.txt:15` (`/ota/upgrade_status: std_msgs/msg/String`) |
| Source — decompile | `mqtt_node_decompiled.c:325014` (function `api_ota_upgrade_state`) |
| Source — strings | `mqtt_node-strings.md:109` (`ota_upgrade_state`) |
| Source — capture | No live example (idle-only catalog) |
| Source — docs | `docs/reference/MQTT.md:138` |

---

## Section C — Mower → Server reports (`Dart/Receive_server_mqtt/<SN>`)

### `report_state_to_server_work_respond`

| Property | Value |
|---|---|
| Direction | mower → server (NOT forwarded to app) |
| Period | ~60 s |
| Source — capture | `mqtt_node-payload-catalog.md:326-392` (LIVE CAPTURE — 30 in 30-min window) |
| Source — decompile | `mqtt_node_decompiled.c:310257` (function `api_report_state_to_server_work`) |

**Key fields (live example):**
```json
{
  "type": "report_state_to_server_work_respond",
  "message": {
    "result": 0,
    "value": {
      "sv": "v6.0.2-custom-24", "hv": "v0.0.1", "ov": "V0.3.2",
      "battery_power": 99, "work_status": 9, "task_mode": 2,
      "error_status": 0, "gps_latitude": 52.14, "gps_longitude": 6.23,
      "disk_remaining": 7910, "memory_remaining": 2357,
      "cpu_temperature": 46, "cpu_usage": 44, "wifi_rssi": 54,
      "working_time": 1591
    }
  }
}
```

---

### `report_state_to_server_exception_respond`

| Property | Value |
|---|---|
| Direction | mower → server (NOT forwarded to app) |
| Period | event-driven (on exception state change) |
| Source — capture | `mqtt_node-payload-catalog.md:396-433` (LIVE CAPTURE — 1 event in 30-min window, LoRa disconnect) |
| Source — decompile | `mqtt_node_decompiled.c:309961` (function `api_report_state_to_server_exception`) |

**Key fields (live example):**
```json
{
  "type": "report_state_to_server_exception_respond",
  "message": {
    "result": 0,
    "value": {
      "robot_error_status": 8, "robot_error_msg": "Error_code: 8 Lora disconnect...",
      "robot_button_stop": false, "robot_collision": false,
      "robot_overturn": false, "robot_tilt": false,
      "robot_upraise": false, "robot_wheel_stall": 0
    }
  }
}
```

---

## Section D — Commands referenced in decompile but not yet captured

The following commands are confirmed present in the binary (strings and/or decompile citations) but have NOT been observed in any live capture session. Phase 2 implementations will need targeted captures or live testing.

| Command | Direction | Decompile line | Notes |
|---|---|---|---|
| `report_state_all_by_ble` | mower → app | `mqtt_node_decompiled.c:306222` | BLE state report; only during BLE session |
| `mst` (velocity) | app → mower | N/A (not found as api_ function) | Joystick continuous velocity; `{ "mst": { "x_w": <float>, "y_v": <float>, "z_g": 0 } }` — documented in CLAUDE.md |
| `get_map_info` | app → mower | `mqtt_node_decompiled.c:322091` | Read map metadata; `api_get_map_info` confirmed |
| `start_scan_map_respond` | mower → app | `mqtt_node-strings.md:117` | Response to `start_scan_map` |
| `stop_scan_map_respond` | mower → app | `mqtt_node-strings.md:127` | Response to `stop_scan_map` |
| `add_scan_map_respond` | mower → app | — | Response to `add_scan_map` |
| `save_map_respond` | mower → app | `mqtt_node_decompiled.c:339699` | Response to `save_map` |
| `save_recharge_pos_respond` | mower → app | `mqtt_node-strings.md:93` | Response to `save_recharge_pos` |
| `report_work_start_respond` | mower → app | Not in strings | Mow session start ack — may not exist in v6 |
| `report_work_stop_respond` | mower → app | Not in strings | Mow session stop ack — may not exist in v6 |
| `get_lora_data` | app → charger | `mqtt_node-strings.md:92` | Raw LoRa telemetry request; exact payload unknown |
| `get_lora_info_respond` | charger → app | `mqtt_node-payload-catalog.md:280-322` | LIVE CAPTURE (charger side); not mqtt_node generated |
| `start_cov_task_result` (topic) | mower → internal | `mqtt_node-graph-snapshot.txt:19` | `/robot_decision/cov_task_result` subscriber; triggers `report_state_robot` update |
| `cov_task_result` (topic) | ROS2 internal | `mqtt_node-graph-snapshot.txt:19` | `decision_msgs/msg/CovTaskResult` used to update mow session completion state |
| `wifi_list_cmd` | — | `mqtt_node-strings.md:238` | Listed as `wifi_list_cmd` — likely BLE WiFi scan |
| `get_sn_para_info` | app → mower | `mqtt_node_decompiled.c:12329` (`get_sn_para_info_abi_cxx11_()`) | Runs at startup; reads SN-specific parameters |
| `start_edge_cut` | app → mower | Custom firmware only | `{ "start_edge_cut": { "mapName": "map0", "bladeHeight": <mm> } }` — server-side handler in `research/extended_commands.py`; NTCP action |
| `timer_task` (outbound) | server → mower | `mqtt_node_decompiled.c:310185` | Scheduled task trigger; payload format `<unknown — needs Ghidra deep-dive>` |
| `auto_connect` | app → mower | `docs/reference/MQTT.md:148` | Auto-connect command; no decompile function found |
| `reset_utm_origin_info` | internal | `mqtt_node-graph-snapshot.txt:52` | Service client: `/reset_utm_origin_info: std_srvs/srv/Empty` — triggered when? |
| `local_costmap_clear` | internal | `mqtt_node-graph-snapshot.txt:50` | `/local_costmap/clear_around_local_costmap: nav2_msgs/srv/ClearCostmapAroundRobot` — triggered when? |
| `PlanCheckTask` | server/app → mower | `mqtt_node-graph-snapshot.txt:39` | Service server: `/PlanCheckTask: get_plan_interfaces/srv/PlanData` — schema not in cache |
| `pipe_charge_status` (sub) | ROS2 → internal | `mqtt_node-graph-snapshot.txt:16` | `/pipe_charge_status: std_msgs/msg/UInt8` subscriber — triggers deblocking in `start_move` backward (line 309112-309114) |
| `release_charge_lock` (pub) | internal | `mqtt_node-graph-snapshot.txt:31` | Published `std_msgs/msg/UInt8` on dock events |

---

## Schema coverage summary

| Package | Schemas in cache | Schemas missing (needed for Phase 2) |
|---|---|---|
| `decision_msgs/srv` | StartCoverageTask, StartMap, SaveMap, DeleteMap, Charging, GenerateCoveragePath, Common ✓ | (complete for known commands) |
| `std_srvs/srv` | SetBool, Trigger, Empty ✓ | — |
| `novabot_msgs/action` | ChassisLoraSet, ChassisPinCodeSet ✓ | — |
| `novabot_msgs/msg` | CloudMoveCmd, ChassisIncident, ChassisBatteryMessage ✓ | — |
| `mapping_msgs/srv` | SetChargingPose ✓ | — |
| `decision_msgs/msg` | RobotStatus, CovTaskResult ✓ | — |
| `platform_msgs/srv` | — | `OtaUpgradeSys` — **NOT IN CACHE** (needed for OTA command) |
| `get_plan_interfaces/srv` | — | `PlanData` — **NOT IN CACHE** (`/PlanCheckTask` server) |
| `novabot_msgs/srv` | Common, NaviTo, CloudMove ✓ | — |

**Systemic gap:** `platform_msgs/srv/OtaUpgradeSys` is missing from the schema cache. This is the ROS2 service used by `ota_upgrade_cmd` (graph snapshot line 51). Phase 2 OTA implementation must either skip the ROS2 call (OTA is initiated by the binary itself, not bridged via ROS2 in the same way) or obtain this schema via Task 1.10 (RE-10). `get_plan_interfaces/srv/PlanData` for `/PlanCheckTask` is also absent.

---

## Work_status and task_mode enum reference

From `decision_msgs/msg/RobotStatus.msg` (`research/ros2_msg_definitions/decision_msgs/msg/RobotStatus.msg`):

| `merged_work_status` | Name |
|---|---|
| 0 | FREE |
| 1 | COVER |
| 2 | RECHARGING |
| 3 | MAPPING |
| 4 | CHARGING |
| 5 | STOP |

Common `work_status` values observed:
- 9 = CHARGING_RECHARGE (on dock, charging)

Common `task_mode` values observed:
- 2 = MAPPING (last active mode was mapping)

---

**Generated:** 2026-04-26
**Capture:** idle-only (mower on charger, 30 min, `mqtt_node-payload-catalog.md`)
**Author:** RE-5 cross-reference synthesis
