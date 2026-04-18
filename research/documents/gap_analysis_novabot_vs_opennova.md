# Novabot ↔ OpenNova Gap Analysis (2026-04-18)

> Sources: `research/blutter_output_v2.4.0/pp.txt`, `research/blutter_output_v2.4.0/asm/flutter_novabot/pages/**/*.dart`,
> `app/src/screens/*.tsx`, `app/src/components/*.tsx`, `app/src/services/*.ts`, `server/src/routes/**/*.ts`

---

## TL;DR

- **Scheduling is partially implemented** — OpenNova has the UI (create/edit/delete/enable toggle, rain detection toggle, zone selection) but does NOT yet send `timer_task` MQTT commands itself; the server handles that. The Novabot app sends `timer_task` directly. Functionally equivalent for now, but the mower-side flow differs.
- **Live mapping is volledig op pariteit** — work area, obstacles én map channels worden in OpenNova via dezelfde BLE joystick flow opgenomen als in Novabot v2.4.0 (eerdere claim van een gap was incorrect; geen freehand draw UI in Novabot zelf).
- **Camera works differently** — Novabot uses the `video_player` package (likely RTSP/HLS via the cloud relay); OpenNova uses MJPEG via direct mower IP (on-LAN only). Cloud camera relay is missing in OpenNova.
- **User account management is thin in OpenNova** — no password reset, no profile rename, no delete account UI in the app (exist server-side only).
- **Push notifications (Firebase) are absent in OpenNova** — Novabot uses Firebase Messaging + crash reporting; OpenNova has no push at all.
- **Store/webview tab is intentionally skipped** — Novabot has a WebView tab pointing to the LFI shop; OpenNova correctly omits this.

---

## Per Feature Gebied

### 1. Mowing Control (Start / Pause / Resume / Stop / Go Home)

**Novabot heeft:**
- `start_navigation` (primary, v2.4.0) with `{mapName, cutterhigh, area, cmd_num}` — `area` param: 1=map0, 10=map1, 200=map2
- Fallback: `start_run` (older protocol) — `pp.txt:18229`
- `pause_navigation` / `resume_navigation` — `pp.txt:46341,46313`
- `pause_run` / `resume_run` — `pp.txt:46338,46309`
- `stop_run` / `stop_navigation` — `pp.txt:46362,46365`
- `auto_recharge` (go home) — `pp.txt:20515`
- Pre-start interceptors: low battery (<20%), no map, no channel, mower busy

**OpenNova heeft:**
- `start_navigation` with fallback to `start_run` — `StartMowSheet.tsx:203-219`
- `pause_navigation` — `HomeScreen.tsx:1148`
- `resume_navigation` — `HomeScreen.tsx:1225`
- `stop_run` — via server dashboard.ts:1193
- `auto_recharge` — in MappingScreen for post-map docking only
- All pre-start interceptors matched — `StartMowSheet.tsx:94-155`

**Gap:** `stop_navigation` MQTT command exists in Novabot but OpenNova sends `stop_run`. Both are accepted by v6.x firmware. Pause/resume use `_navigation` variants in both apps. No functional gap.

**Prioriteit:** P3 (geen actie nodig)

---

### 2. Mapping (Work Area, Obstacle, Channel, Charger Position)

> **Toegevoegd 2026-04-18 (Retract feature, gemist door eerste analyse)**:
> - Novabot heeft een **"Retract" knop** in het mapping scherm (`pp.txt:0x19da0`).
> - Help text: *"Click the Retract Button, the machine will move backwards and clean its path."* (`pp.txt:0x1a558`).
> - MQTT: `start_erase_map` om te beginnen, `stop_erase_map` om te stoppen. Responds: `start_erase_map_respond` (`pp.txt:0x1a3b8`), `stop_erase_map_respond` (`pp.txt:0x1a3e0`).
> - **OpenNova heeft `stop_erase_map` wel** (in cancel/discard flow, [MappingScreen.tsx:1008](app/src/screens/MappingScreen.tsx:1008)) **maar geen `start_erase_map` en geen Retract knop**. Gebruiker kan dus niet terug-rijden + opname-correctie tijdens mapping.
> - **Prioriteit: P1** — handige fout-correctie zonder restart van de hele mapping sessie. Implementatie: simpel (~1-2u: knop in mapping toolbar + 2 MQTT commands).

**Novabot heeft:**
- Live BLE joystick mapping — mower driven via `start_move`/`mst`/`stop_move` over BLE during `build_map_page`
- Mapping page has BLE data handler: `pages/build_map/build_map_page/utils/ble_data_handler.dart`
- Can create up to 3 work maps + 3 channel areas — `pp.txt:20124`
- Types: `work`, `obstacle`, `channel` — `pp.txt:18285,18497,19577`
- Map management: `delete_map` / `delete_map_respond` — `pp.txt:18283`
- `get_map_list` / `get_map_outline` / `report_state_map_outline` — `pp.txt:18300,18288,13719`
- `get_map_plan_path` / `get_map_plan_path_respond` — `pp.txt:13583,13740`
- Rename map areas via `updateEquipmentMapAlias` — `pp.txt:18507`
- Map area alias per-zone label editing

**OpenNova heeft:**
- Live BLE joystick mapping (en MQTT als fallback) — `MappingScreen.tsx` via `bleJoystickStart/Move/Stop` services
- Drie mapping types via tile-selectie: Work Area / Obstacle / Map Channel — `MapBuildType: 'work' | 'obstacle' | 'unicom' | 'charge_unicom'` (`MappingScreen.tsx:81`)
- `add_scan_map` met `type: 2` voor obstacle/unicom, `type: 0` voor work — verified tegen Novabot live log
- `start_scan_map` voor het allereerste work area, `add_scan_map` voor extra werk- of obstacle-/channel-zones
- `save_map` met dual-pattern (sub + total) voor work; single total voor obstacle/unicom
- Mandatory channel-creation blocker na map1+ (forceert dat de gebruiker een unicom kanaal tekent)
- Live unicom-scan banner die toont in welke work-polygon de mower zich bevindt
- Map import from ZIP file — `MapScreen.tsx:41`
- Cloud import from Novabot cloud — `MapScreen.tsx` (uses `fragmentUploadEquipmentMap`)
- Zone selection (work maps) for start mowing — `StartMowSheet.tsx`
- Map display with obstacles/unicom rendered — `MapScreen.tsx:160-163`
- Delete map met cascade (obstacles/channels van die work map gaan mee) — `MapScreen.tsx:465`
- Rename map — `MapScreen.tsx` (via `updateEquipmentMapAlias`)
- `get_map_list`, `get_map_outline`, `save_map` — `MappingScreen.tsx:799`
- `report_state_map_outline` handled by server

**Gap (gecorrigeerd 2026-04-18):**
- ~~OpenNova cannot draw NEW obstacle/channel polygons during mapping~~ — **VERKEERD.** OpenNova heeft volledige obstacle + channel mapping support via dezelfde BLE joystick flow als Novabot. Beide apps rijden de mower fysiek rondom het object/kanaal en de mower's odometry levert de polygon. Geen "freehand draw op de kaart" UI in Novabot v2.4.0 — de aanname van de eerste analyse klopt niet.
- OpenNova joystick werkt zowel via BLE (primair, exact als Novabot) als via MQTT relay (server-side fallback). On-LAN werken beide; outside LAN werkt MQTT relay via VPN.
- `get_map_plan_path` (mow path preview) wordt door Novabot opgehaald om het geplande maai-patroon over de kaart te leggen; OpenNova vraagt 'm niet op (we tonen de stripes alleen tijdens mowing zelf).

**Prioriteit:** Mow path preview: **P2** (simpel — request `get_map_plan_path` voor het zone plan voordat starten).

---

### 3. Scheduling (Timer Tasks, Rain Pause, Zone Assignment)

**Novabot heeft:**
- `timer_task` MQTT command — sent directly from app to mower — `pp.txt:13558`
- `report_state_timer_data` subscription — `pp.txt:13553`
- `workTime` + `workDay` fields in schedule entity — `pp.txt:17587,17601`
- Timezone-aware: `timezone` field, `getLocalTimezone` — `pp.txt:17583,19571`
- `defaultCuttingHeight` per schedule — `pp.txt:18088`
- Rain pause toggle per schedule — `pp.txt:17585 (schedule_painter.dart), Schedule UI`
- Deleting schedule while active warns user — `pp.txt:17661`
- Multi-zone schedule: single schedule can span multiple maps (with channels)
- Schedule confirms if same schedule exists for other days before delete — `pp.txt:17568`
- CRUD via cloud API: `saveCutGrassPlan`, `updateCutGrassPlan`, `deleteCutGrassPlan`, `queryCutGrassPlan` — `pp.txt:17787,17788,17574,17577`

**OpenNova heeft:**
- Full schedule UI: create, edit, delete, enable/disable toggle — `ScheduleScreen.tsx`
- Rain detection toggle per schedule — `ScheduleScreen.tsx:464,518`
- `rainPausedAt` badge on schedule cards — `ScheduleScreen.tsx:259,272`
- Days-of-week multi-select, start/end time picker — `ScheduleScreen.tsx`
- Zone assignment per schedule — (inferred from `editorPrefill.mapId`)
- Cutting height per schedule (HEIGHT_OPTIONS 2-9 cm) — `ScheduleScreen.tsx:22`
- Rain forecast banner on home/schedule — `RainOverlay.tsx`
- Server sends `timer_task` to mower when schedule triggers — `server/src/routes/dashboard.ts:1813-1914`
- CRUD via server REST API — `ApiClient.getSchedules`, `updateSchedule`, etc.

**Gap:**
- OpenNova does NOT send `timer_task` directly from app — server handles it. This means if server is down, schedules don't fire (same limitation as cloud). For a local setup this is acceptable.
- `report_state_timer_data` GPS position extraction is done server-side but not surfaced in app UI.
- No conflict warning for duplicate schedules across days (Novabot warns — `pp.txt:17568`).

**Prioriteit:** Conflict warning: **P3** (nice-to-have). Server-side dispatch: **intentional design, P3**.

---

### 4. Manual Control (Joystick, Headlight, Sound)

**Novabot heeft:**
- Dedicated `manul_controller_page` (note: Novabot typo) — `pages/home_page/manul_controller_page/`
- Also in mapping page: `build_map_page/widget/joystick.dart`
- `start_move: <int>` (JoystickHoldType: 1=left,2=right,3=fwd,4=back) — `pp.txt:19190`
- `mst: {x_w, y_v, z_g:0}` velocity at 200ms intervals — `pp.txt:19219`
- `stop_move` — `pp.txt:18692`
- `set_para_info: {headlight: 0|2}` — `pp.txt:22403`
- `set_para_info: {sound: 0|2}` — `pp.txt:161`
- `manual_controller_v` (max linear speed) — `pp.txt:22406`
- `manual_controller_w` (max angular speed) — `pp.txt:22407`

**OpenNova heeft:**
- `JoystickScreen.tsx` with full joystick UI
- `JoystickControl.tsx` component (reused in AppSettingsScreen)
- `start_move`, `mst`, `stop_move` via server MQTT relay — `JoystickScreen.tsx`
- Headlight toggle in JoystickScreen — `JoystickScreen.tsx:331`
- Headlight + sound toggles in `MowerSettingsScreen.tsx:128,209,213`
- `manual_controller_v` / `manual_controller_w` sliders — `MowerSettingsScreen.tsx:101-106`

**Gap:** None significant. OpenNova routes joystick via server MQTT relay instead of direct BLE (same trade-off as mapping).

**Prioriteit:** P3 (geen actie nodig)

---

### 5. Mower Settings (set_para_info Parameters)

**Novabot heeft (Advanced Settings page):**
- `path_direction` (degrees) — `pp.txt:22404`
- `obstacle_avoidance_sensitivity` (1=low, 2=medium, 3=high) — `pp.txt:22405`
- `manual_controller_v` (linear speed max) — `pp.txt:22406`
- `manual_controller_w` (angular speed max) — `pp.txt:22407`
- `headlight` (0=off, 2=on) — `pp.txt:22403`
- `sound` (0=off, 2=on) — `pp.txt:161`
- Cutting height in `start_navigation` as `cutterhigh` parameter
- `defaultCuttingHeight` stored per schedule — `pp.txt:18088`
- `set_para_info_respond` acknowledged — `pp.txt:22410`

**OpenNova heeft:**
- All of the above — `MowerSettingsScreen.tsx:78-213`
- Sends full bundle via `set_para_info` — `MowerSettingsScreen.tsx:124-138`
- Also sends single-field updates without overriding others — `MowerSettingsScreen.tsx:188-213`
- Cutting height via stepper in `StartMowSheet.tsx`
- Edge offset (shrink/expand polygon) — `StartMowSheet.tsx` (OpenNova-only feature)
- Mow pattern picker — `PatternPicker.tsx` (OpenNova-only feature)

**Gap:** None for standard parameters. OpenNova has additional features Novabot lacks.

**Prioriteit:** P3 (geen actie nodig)

---

### 6. Camera / Video Streaming

**Novabot heeft:**
- `video_player` Flutter package (RTSP or HLS) — `pp.txt:21797`
- `video_page.dart` — dedicated screen, landscape orientation forced
- Video URL source: not found in pp.txt directly (likely fetched from cloud API or equipment info) — "not found in decompilation for URL format, needs runtime trace"
- `videoEventsFor()` error string found — `pp.txt:21852`

**OpenNova heeft:**
- `CameraScreen.tsx` — MJPEG via WebView on direct mower IP
- 4 camera topics: front, tof_gray, tof_depth, aruco — `CameraScreen.tsx:23-28`
- Landscape mode via `expo-screen-orientation` — `CameraScreen.tsx`
- Headlight toggle in camera screen — `CameraScreen.tsx:115`
- Requires mower on same WiFi network (direct IP access)
- Uses server's `/camera/:sn/info` endpoint for URL resolution

**Gap:**
- Novabot likely supports cloud-relayed video (accessible outside home network). OpenNova camera only works on-LAN.
- Novabot probably shows a single camera feed; OpenNova exposes all 4 debug camera streams.
- OpenNova's multi-stream selection is actually more useful for debugging.

**Prioriteit:** Cloud video relay: **P2** (complex). Multiple streams: OpenNova already better.

---

### 7. OTA Updates (Mower + Charger)

**Novabot heeft:**
- `ota_version_info` / `ota_version_info_respond` MQTT — `pp.txt:14758,13483`
- `ota_upgrade_cmd` / `ota_upgrade_state` — `pp.txt:22086,22088`
- Check via REST: `checkOtaNewVersion?version=...&upgradeType=serviceUpgrade&equipmentType=...` — `pp.txt:13495`
- `upgradeFlag` field in response — `pp.txt:13506`
- Reports `mowerVersion` + `chargerVersion` + `appVersion` back to cloud — `pp.txt:14761-14763`
- `updateEquipmentVersion` REST call — `pp.txt:14765`
- `launch_app_store` for app self-update — `pp.txt:55916`

**OpenNova heeft:**
- `OtaScreen.tsx` — shows firmware versions, triggers OTA per device
- `getOtaVersions()` API call — `OtaScreen.tsx:43`
- OTA trigger via server route — triggers `ota_upgrade_cmd` MQTT
- Shows current version from sensor data (`sw_version`, `version`)
- Both mower and charger OTA supported

**Gap:**
- OpenNova has no "app self-update" check (not relevant for local deployment).
- No `report_state_timer_data` GPS location display during OTA progress.
- OTA percentage tracking exists server-side; app could show progress bar.

**Prioriteit:** OTA progress bar in app: **P2** (simpel). App self-update: **P3** (skip).

---

### 8. BLE Provisioning (Add Charger / Add Mower)

**Novabot heeft:**
- `add_charger_page` — BLE scan, WiFi config, charger SN, MQTT server push — `pages/equipment/add_charger_page/`
- `add_mower_page` — similar flow — `pages/equipment/add_mower_page/`
- BLE frame format: `ble_start` + data chunks (20 bytes each) + `ble_end` — `ble_tools.dart`
- `qrview_page` — QR code scanner to auto-fill SN — `pages/equipment/qrview_page.dart`
- `view_pin_page` — shows PIN code for device — `pages/equipment/view_pin_page.dart`
- Equipment fields sent via BLE: `wifiName`, `wifiPassword`, `account`, `password`, `chargerAddress`, `chargerChannel` — `pp.txt:11334-11339`

**OpenNova heeft:**
- `BleScanScreen.tsx` — BLE scan with device type picker
- `ProvisionScreen.tsx` — multi-device provisioning with phases: connecting, discovering, wifi, rtk, lora, mqtt, commit
- `ble.ts` — full BLE provisioning service with `provisionDevice()`
- 2-phase flow for RPi: charger first, then mower (see `rpi-provisioning-flow.md`)
- WiFi + MQTT server config sent
- `DeviceChoiceScreen.tsx` — charger/mower/both selection

**Gap:**
- OpenNova has no QR code scanner for SN auto-fill — user must scan manually or know SN
- OpenNova has no PIN viewer page — relevant for debugging only
- Novabot's `add_charger_page` shows a tip dialog; OpenNova shows step-by-step progress which is clearer

**Prioriteit:** QR scan for SN: **P2** (simpel). PIN viewer: **P3** (skip).

---

### 9. User Account Management

**Novabot heeft:**
- Login / Register / Forgot password / Reset password — `pages/user/login_page/`, `signup_page/`, `forgot_password_page/`
- Profile page: rename nickname — `pages/user/profile/`
- Settings: About, Language picker, OTA, Reset password, Delete account — `pages/user/settings/`
- Password rules enforced: uppercase + lowercase + number + symbol — `pp.txt:13008`
- Message center (separate page): robot messages + work records — `pages/user/message_page/`
- Firebase Cloud Messaging for push notifications — `pp.txt:56219`
- `updateAppUserMachineToken` (FCM token registration) — `pp.txt:56205`
- App crash reporting via Firebase Crashlytics — `pp.txt:6857`
- Language picker with 9 locales: en, de, es, fr, it, nl, sv + 2 more — `pp.txt:12436`
  - Confirmed: en, de, es, fr, it, nl, sv — `pp.txt:17189-17219`
  - 2 remaining locales unknown (not decoded from Locale objects)

**OpenNova heeft:**
- `LoginScreen.tsx` + `RegisterScreen.tsx` — login + register
- Logout in `AppSettingsScreen.tsx`
- Email display in settings (from JWT)
- Language picker: en, nl, de, fr — `app/src/i18n/` (4 languages)
- No password reset UI in app
- No profile rename in app
- No delete account in app
- No Firebase / push notifications
- No crash reporting (Expo handles basic crash logs)
- `MessagesScreen.tsx` — shows current live errors from sensor data (NOT historical cloud messages)

**Gap:**
- Password reset: not in app (must use web/email) — **P1** (simpel)
- Profile nickname rename: missing — **P2** (simpel)
- Delete account: server endpoint exists, needs app UI — **P2** (simpel)
- Firebase push notifications: major feature gap — **P1** (complex — requires Expo Push or native Firebase)
- Historical robot messages (cloud-sourced): `queryRobotMsgPageByUserId` server route exists, app doesn't use it — **P2** (simpel)
- Missing languages: es, it, sv — **P2** (community contribution)

**Prioriteit:** Push: P1. Password reset: P1. Profile/delete: P2. Languages: P2.

---

### 10. Equipment Detail / Device Management

**Novabot heeft:**
- `equipment_detail_page.dart` — shows device info (SN, firmware version, WiFi SSID, RSSI, charger address/channel)
- Rename device nickname — `rename_device_page.dart` + `updateEquipmentNickName` API
- Unbind device — `unboundEquipment` API — `pp.txt:19456`
- Bind device — `bindingEquipment` API — `pp.txt:19537`
- `get_wifi_rssi` / `get_wifi_rssi_respond` MQTT — `pp.txt:13690,13736`
- View PIN code page — `view_pin_page.dart`

**OpenNova heeft:**
- Device info shown in `AppSettingsScreen.tsx` (SN, online status)
- Unbind via server (`unboundEquipment` route exists)
- No dedicated device detail screen
- No rename device in app (API exists server-side)
- No WiFi RSSI display
- No PIN viewer

**Gap:** Device detail page missing. Rename + unbind: server-side only. WiFi RSSI: not shown.

**Prioriteit:** Device detail screen: **P2** (medium). WiFi RSSI display: **P2** (simpel).

---

### 11. Notifications / Messages / Work Records

> **Correctie 2026-04-18**: OpenNova heeft wél een bell-icoon op het home screen (`notifications-outline` op [HomeScreen.tsx:895](app/src/screens/HomeScreen.tsx:895)) dat opent de [MessagesScreen.tsx](app/src/screens/MessagesScreen.tsx) modal. Die screen toont echter alleen LIVE alerts die hij zelf afleidt uit huidige sensor waarden (error_status, low battery, weak WiFi, offline). De **persisted message history** uit de `robot_messages` DB tabel wordt niet opgehaald. **Novabot zelf is hier momenteel ook stuk** — een gemeld issue dat we naast het oplossen voor onszelf óók bewust beter kunnen doen.

**Novabot heeft:**
- Push via Firebase Messaging — `pp.txt:56219`
- `queryRobotMsgPageByUserId` — robot error/event messages — `pp.txt:22271`
- `queryCutGrassRecordPageByUserId` — work history with area/time — `pp.txt:22194`
- `queryMsgMenuByUserId` — unread count badge — `pp.txt:56063`
- Mark as read / delete — `updateMsgByUserId`, `deleteMsgByUserId` — `pp.txt:17416,17423`
- Message page has 2 tabs: robot messages + work records — `pages/user/message_page/`

**OpenNova heeft:**
- `MessagesScreen.tsx` — shows live sensor errors (local, not cloud-sourced)
- `HistoryScreen.tsx` — work records from `queryCutGrassRecordPageByUserId` — `HistoryScreen.tsx:45`
- Server routes: `queryRobotMsgPageByUserId`, `queryCutGrassRecordPageByUserId` both implemented
- No unread badge/count
- No mark-as-read / delete
- No push notifications

**Gap:** Robot messages screen not implemented in app (server-side route exists). Mark-as-read, delete missing. Unread badge missing.

**Prioriteit:** Robot messages screen: **P2** (simpel — server route exists). Badge: **P3**.

---

### 12. Maps — Format, Import/Export, Live View

**Novabot heeft:**
- Map display: polygon painter (`build_map_painter.dart`, `map_paint.dart`)
- GPS trail overlay during mowing (`covering_data.dart`)
- Map list: `get_map_list` / `get_map_list_respond` — `pp.txt:18300,13708`
- `get_map_plan_path` — planned mow path from firmware — `pp.txt:13583`
- Area types: work, obstacle, channel (unicom) — rendered in distinct colors
- Live map outline: `report_state_map_outline` subscription — `pp.txt:13719`
- Cloud map upload: `fragmentUploadEquipmentMap` — `pp.txt:20422`

**OpenNova heeft:**
- Full SVG map rendering with GPS trail — `MapScreen.tsx`
- Mowing progress overlay — `MowingProgressMap.tsx`
- Area type coloring: work (green), obstacle (red), unicom/channel (blue) — `MapScreen.tsx:160-163`
- Live mower position (GPS converted to local meters) — `MapScreen.tsx:76`
- Import from ZIP file — `MapScreen.tsx:41`
- Cloud import (`fragmentUploadEquipmentMap` flow) — `MapScreen.tsx`
- Delete + rename maps — `MapScreen.tsx:465`
- `report_state_map_outline` handled server-side
- Edge offset polygon preview — `StartMowSheet.tsx`
- Mow pattern overlay (unique to OpenNova)

**Gap:** `get_map_plan_path` (planned mow path preview from firmware) not subscribed in app. This would show the exact coverage lines planned by Nav2.

**Prioriteit:** `get_map_plan_path` display: **P2** (simpel).

---

### 13. Localization / i18n

| Language | Novabot | OpenNova |
|----------|---------|----------|
| English  | Yes     | Yes      |
| Dutch (nl) | Yes   | Yes      |
| German (de) | Yes  | Yes      |
| French (fr) | Yes  | Yes      |
| Spanish (es) | Yes | No       |
| Italian (it) | Yes | No       |
| Swedish (sv) | Yes | No       |
| 2 unknown | Yes  | No       |

Source: Novabot locales list — `pp.txt:12436` (9 locales). OpenNova i18n files: `app/src/i18n/` (4 files: en, nl, de, fr).

**Gap:** es, it, sv and 2 unknown languages. (The 2 unknown locale objects at `pp+0xdac8` and one more need runtime inspection.)

**Prioriteit:** P2 — community contribution, low effort per language.

---

### 14. Store / Shop / Webview

**Novabot heeft:**
- `store_view.dart` — WebView tab loading LFI shop URL
- `webview_page.dart` — generic webview for help/legal content
- YouTube tutorial links — `pp.txt:19941,22556`
- Zendesk support link: `https://lfibot.zendesk.com/hc/en-gb` — `pp.txt:22557`

**OpenNova heeft:**
- No store tab (intentional — we are not LFI)
- No webview for help (could link to GitHub docs)

**Gap:** Support/help link missing. A "Documentation" link to project GitHub is **P3** (nice-to-have).

---

### 15. Diagnostics / Debug

**Novabot heeft:**
- `view_pin_page.dart` — shows device PIN code
- `get_wifi_rssi` MQTT command
- Firebase Crashlytics — `pp.txt:6857`
- App operation log upload: `uploadAppOperateLog` — `pp.txt:16933`

**OpenNova heeft:**
- Dev mode toggle in AppSettingsScreen
- Experimental features context
- Admin dashboard (web-based, not in app)
- No PIN viewer
- No WiFi RSSI command
- No crash reporting

**Gap:** All diagnostic features are low-priority for production users.

**Prioriteit:** P3.

---

## Volledige Feature Matrix

| Feature | Novabot | OpenNova | Gap | Prio |
|---------|---------|----------|-----|------|
| Start mowing (zone select, height, direction) | Yes | Yes | None | P3 |
| Pause / Resume navigation | Yes | Yes | None | P3 |
| Stop / Go home | Yes | Yes | None | P3 |
| Live joystick (MQTT) | Yes (BLE) | Yes (MQTT relay) | Design choice | P3 |
| Headlight control | Yes | Yes | None | P3 |
| Sound control | Yes | Yes | None | P3 |
| Obstacle avoidance sensitivity | Yes | Yes | None | P3 |
| Manual controller speed params | Yes | Yes | None | P3 |
| Mapping — work area boundary | Yes | Yes | None | P3 |
| Mapping — obstacle drawing | Yes (live BLE) | Yes (live BLE) | None | P3 |
| Mapping — channel drawing | Yes (live BLE) | Yes (live BLE) | None | P3 |
| Mapping — auto charger position | Yes | Yes | None | P3 |
| Mapping — Retract (back up + erase path) | Yes (`start_erase_map`/`stop_erase_map`) | Partial (alleen `stop_erase_map` in cancel) | Missing UI + start command | P1 |
| Map import from ZIP | No | Yes | OpenNova extra | — |
| Map cloud import | Yes | Yes | None | P3 |
| Map delete / rename | Yes | Yes | None | P3 |
| Mow path preview (get_map_plan_path) | Yes | No | Missing | P2 |
| Live mower position on map | Yes | Yes | None | P3 |
| GPS trail overlay | Yes | Yes | None | P3 |
| Edge offset (shrink/expand polygon) | No | Yes | OpenNova extra | — |
| Mow pattern picker | No | Yes | OpenNova extra | — |
| Camera — MJPEG on-LAN | Probably not | Yes | OpenNova extra | — |
| Camera — cloud relay | Likely yes | No | Missing | P2 |
| Camera — multi-stream (front/ToF/ArUco) | No | Yes | OpenNova extra | — |
| Scheduling — create/edit/delete | Yes | Yes | None | P3 |
| Scheduling — rain pause toggle | Yes | Yes | None | P3 |
| Scheduling — duplicate day warning | Yes | No | Missing | P3 |
| Rain forecast banner (home screen) | No | Yes | OpenNova extra | — |
| Push notifications (Firebase) | Yes | No | Major gap | P1 |
| Historical robot messages | Yes | No (route exists) | Missing app UI | P2 |
| Work records history | Yes | Yes | None | P3 |
| OTA — mower + charger trigger | Yes | Yes | None | P3 |
| OTA — progress bar in app | Yes (state) | No | Missing | P2 |
| BLE provisioning — charger | Yes | Yes | None | P3 |
| BLE provisioning — mower | Yes | Yes | None | P3 |
| BLE provisioning — QR scan for SN | Yes | No | Missing | P2 |
| Login / Register | Yes | Yes | None | P3 |
| Password reset | Yes | No | Missing | P1 |
| Profile nickname rename | Yes | No | Missing | P2 |
| Delete account | Yes | No | Missing | P2 |
| WiFi RSSI display | Yes | No | Missing | P2 |
| Device detail page | Yes | No | Missing | P2 |
| Device unbind | Yes | Server only | Missing app UI | P2 |
| PIN viewer | Yes | No | Skip | P3 |
| Language: en, nl, de, fr | Yes | Yes | None | P3 |
| Language: es, it, sv | Yes | No | Missing | P2 |
| Store / Shop webview | Yes | No | Intentional | P3 |
| Zendesk / Help link | Yes | No | P3 | P3 |
| Firebase Crashlytics | Yes | No | Skip | P3 |
| App log upload | Yes | No | Skip | P3 |
| Multi-mower picker | Unclear | Partial (DeviceChoice) | TBD | — |
| mDNS auto-discovery of server | No | Yes | OpenNova extra | — |
| Rain forecast (Open-Meteo) | No | Yes | OpenNova extra | — |
| ArUco camera stream | No | Yes | OpenNova extra | — |
| Demo mode | No | Yes | OpenNova extra | — |

---

## Wat OpenNova Al Beter Doet

1. **Lokale MQTT broker** — geen cloud dependency; werkt zonder internet
2. **mDNS auto-discovery** — `opennovabot.local` IP-detectie, geen handmatig invullen
3. **Rain forecast overlay** — Open-Meteo integratie met aankomende regen warning (niet in Novabot)
4. **Multi-camera streams** — front, ToF gray, ToF depth, ArUco (Novabot toont waarschijnlijk alleen front)
5. **Edge offset** — polygon inkrimpen/uitbreiden voor rand-maaien aanpassing
6. **Mow pattern picker** — geometrische patronen (cirkel, diamant, etc.) als gras-ontwerp
7. **Demo mode** — zonder maaier de app demonstreren
8. **Map import van ZIP** — bruikbaar voor overzetten van Novabot cloud maps naar OpenNova
9. **Open source + zelf te hosten** — privacy, geen vendor lock-in, werkt na LFI cloud shutdown
10. **Decentralized per-user** — elke gebruiker eigen database en container

---

## Aanbevolen Volgorde van Implementatie (Top 10)

| # | Feature | Motivatie | Inschatting |
|---|---------|-----------|-------------|
| 1 | **Push notifications (Expo Push / FCM)** | Gebruikers missen alerts voor fouten, batterij leeg, taak klaar — dit is de meest missende "consumer" feature | Complex (4-8h: Expo push setup + server worker) |
| 2 | **Password reset (in-app)** | Nieuwe gebruikers kunnen zonder dit niet zelfstandig herstellen; server-side al klaar | Simpel (2-3h: email flow UI) |
| 2b | **Retract knop tijdens mapping** (`start_erase_map`/`stop_erase_map`) | Gebruikers die net iets verkeerd rijden moeten anders de hele mapping opnieuw beginnen — Novabot heeft 'm, wij niet | Simpel (1-2h: knop in toolbar + 2 MQTT commands, `stop_erase_map` send hebben we al) |
| 3 | **Device detail screen** (WiFi SSID, RSSI, versies, unbind) | Nodig voor troubleshooting; server-side al volledig | Simpel (3-4h: scherm + API calls) |
| 4 | **Robot messages history wiring** | Bell icoon → MessagesScreen bestaat, toont nu alleen LIVE alerts uit sensor data. Persisted historie (`robot_messages` table) wordt niet opgehaald. **Novabot zelf is hier ook stuk** (bekend issue) — wij kunnen 'm wel beter doen | Simpel (2-3h: fetch + render lijst, gelezen markering) |
| 5 | **Profile rename + delete account** | Basisgebruikersbeheer; server-side klaar | Simpel (2h) |
| 6 | **Mow path preview** (`get_map_plan_path`) | Visuele bevestiging van de geplande rijpaden voor de gebruiker | Simpel (3-4h: subscribe + render lines) |
| 7 | **QR code scanner voor provisioning** | Versnelt setup; SN staat op device label als QR | Simpel (2h: expo-camera QR scan) |
| 8 | **OTA progress indicator in app** | Gebruikers zien nu niets tijdens OTA (kan 5-10 min duren); `ota_upgrade_state` bestaat server-side | Simpel (2-3h: polling + progress bar) |
| 9 | **Camera cloud-relay voor remote (buiten LAN)** | Nu werkt camera alleen op het thuisnetwerk; relay zou via server proxyen | Medium (4-8h: WebRTC of MJPEG-tunnel) |
| 10 | **Taalondersteuning: es, it, sv** | Uitbreiding bereik voor Europese gebruikers | Medium (2h per taal — community bijdrage) |

---

## Source References

- `research/blutter_output_v2.4.0/pp.txt` — alle MQTT command strings, API endpoints, locale objecten, feature strings
- `research/blutter_output_v2.4.0/asm/flutter_novabot/pages/` — schermstructuur, logica, BLE data handlers
- `research/blutter_output_v2.4.0/asm/flutter_novabot/mqtt/mqtt_data_handler.dart` — inkomende MQTT message routing
- `app/src/screens/` — alle OpenNova schermen (18 bestanden)
- `app/src/components/StartMowSheet.tsx` — start mowing flow met interceptors
- `app/src/components/RainOverlay.tsx` — rain forecast + pause banner
- `server/src/routes/` — server API endpoints en MQTT command dispatch
- `server/src/mqtt/sensorData.ts` — sensor field mapping

## Unknown / To Investigate

- [ ] Novabot video streaming URL format — not found in pp.txt; needs runtime trace (Frida hook on `VideoPlayerController.initialize`)
- [ ] 2 remaining locale codes in the 9-locale list (`a41c51` and `a41c11` objects not decoded)
- [ ] Whether Novabot app supports multi-mower from a single account
- [ ] Exact store/shop WebView URL loaded in `store_view.dart` — not found in decompilation
- [ ] Whether Novabot `cov_mode` / `border_mode` parameters exist in set_para_info (strings not found in pp.txt — may be firmware-only)
