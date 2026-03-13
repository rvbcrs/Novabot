<!-- Referentiebestand — gebruik @MOWER-INTERNALS.md om dit te laden in een sessie -->
# Mower Internals — Startup, Services & Map Flow

Gedetailleerde documentatie van de maaier's interne architectuur, boot sequence,
ROS2 node communicatie, en map-herkenningsflow. Gebaseerd op SSH analyse en
binary string analyse van mqtt_node (maart 2026).

---

## Boot Sequence (Systemd Services)

De maaier start twee systemd services, in volgorde:

### 1. `novabot_ota_launch.service` (EERST)

```
[Unit]
Description=/userdata/ota/run_ota.sh start
After=network.target

[Service]
ExecStart=/userdata/ota/run_ota.sh
```

**Start:** `mqtt_node` + `ota_client`
**Script:** `/userdata/ota/run_ota.sh`

Dit script:
- Source't ROS2 setup: `/opt/ros/galactic/setup.bash` + `/root/novabot/install/setup.bash`
- Zet LD_LIBRARY_PATH voor hbmedia/hbbpu/sensorlib/opencv
- `export ROS_LOCALHOST_ONLY=1`
- Start `mqtt_node` via `ros2 launch novabot_api novabot_api_node.py`
- Start `ota_client` daarna

### 2. `novabot_launch.service` (DAARNA)

```
[Unit]
Description=/root/novabot/scripts/run_novabot.sh
After=novabot_ota_launch.service

[Service]
ExecStart=/root/novabot/scripts/run_novabot.sh
```

**Start:** Alle overige ROS2 nodes (mapping, navigatie, camera, etc.)
**Script:** `/root/novabot/scripts/run_novabot.sh`

Belangrijke nodes:
- `novabot_mapping` — kaartbeheer, leest CSV/map_info.json
- `robot_decision` — navigatie/taken/status
- `perception_node` — AI obstakeldetectie
- `camera_307_cap` + `royale_platform_driver` — camera drivers
- `nav2_*` — navigatie stack
- `robot_combination_localization` — GPS/RTK/IMU fusion
- `daemon_monitor.sh` — monitort camera nodes (NIET novabot_mapping!)

---

## ROS2 Environment

| Variabele | Waarde |
|-----------|--------|
| `RMW_IMPLEMENTATION` | `rmw_cyclonedds_cpp` (default) |
| `ROS_LOCALHOST_ONLY` | `1` |
| `ROS_LOG_DIR` | `/root/novabot/data/ros2_log` |
| DDS middleware | CycloneDDS (GEEN iceoryx voor mqtt_node) |
| Iceoryx (iox-roudi) | Alleen voor camera/perception nodes |

---

## mqtt_node — Startup Configuratie

Bij startup logt mqtt_node deze configuratiewaarden:

```
SYSTEM_VERSION = V0.3.0
novabot_version=v6.0.2-custom-8
novabot_delete_map_flag=1
novabot_night_work_flag=0
novabot_test_night_pm_flag=0
novabot_test_night_am_flag=0
novabot_sn_code=LFIN2230700238
```

- `novabot_delete_map_flag=1` — persistente vlag, gelezen bij startup.
  Mogelijke betekenis: "maps mogen gewist worden" of "delete was in progress".
  NIET gevonden in `json_config.json` — waarschijnlijk een interne default of
  opgeslagen in een apart bestand dat niet gevonden is.
- Bronbestanden: `novabot_mqtt.cpp` regels ~13758-13784

---

## mqtt_node — ROS2 Subscriptions (Kaart-gerelateerd)

Uit `ros2 node info /mqtt_node`:

| Topic | Type | Functie |
|-------|------|---------|
| `/novabot_mapping/save_csv_file` | `std_msgs/msg/String` | Ontvangt pad naar opgeslagen CSV bestanden |
| `/novabot_mapping/close_map` | `std_msgs/msg/Bool` | Kaart sluiten signaal |
| `/novabot_mapping/if_closed_cycle` | `std_msgs/msg/Bool` | Gesloten lus detectie |
| `/novabot_mapping/if_unicom_can_stop` | `std_msgs/msg/Bool` | Unicom stop conditie |
| `/novabot_mapping/in_map_area` | `std_msgs/msg/Bool` | In kaartgebied detectie |
| `/novabot_mapping/start_build_unicom_area` | `std_msgs/msg/Bool` | Unicom area building |
| `/robot_decision/robot_status` | `decision_msgs/msg/RobotStatus` | Robot status updates |
| `/robot_decision/map_position` | `geometry_msgs/msg/Pose` | Huidige positie op kaart |
| `/ota/upgrade_status` | `std_msgs/msg/String` | OTA upgrade voortgang |

### Belangrijk: `save_csv_file` → `generate_map_file_name_SubCallback`

De callback `generate_map_file_name_SubCallback` in de C++ code is gebonden aan het
**ROS2 topic `/novabot_mapping/save_csv_file`** (NIET aan een topic genaamd `generate_map_file_name`!).

Wanneer een bericht binnenkomt:
1. Callback ontvangt pad als string
2. Logt: `generate_map_file_name = <pad>`
3. Checkt of bestand bestaat via `access()` (`access_generate_map_file_name_exist` / `_not_exist`)
4. Verwerkt het pad (details onbekend zonder Ghidra decompilatie)

Bewezen werkend: `ros2 topic pub --once /novabot_mapping/save_csv_file std_msgs/msg/String "{data: '<pad>'}"`
triggert de callback succesvol.

---

## Map Filesystem Layout

```
/userdata/lfi/maps/home0/
├── LFIN2230700238.zip          ← ZIP van csv_file/, gemaakt door get_map_list
├── covered_path/               ← Trail/pad data
├── csv_file/                   ← Kaart CSV bestanden
│   ├── map_info.json           ← Charging pose + area sizes
│   ├── map0_work.csv           ← Werkgebied 0
│   ├── map0_1_obstacle.csv     ← Obstakels in werkgebied 0
│   └── map0tocharge_unicom.csv ← Route naar laadstation
├── planned_path/               ← Geplande paden
└── x3_csv_file/                ← Onbekend (mogelijk X3 SoC specifiek)
```

---

## `get_map_list` Flow (MQTT → Maaier)

Wanneer het commando `{"get_map_list":{}}` binnenkomt via MQTT:

1. `api_get_map_list` in mqtt_node (cpp:~5789-5945)
2. Werkt in directory `/userdata/lfi/maps/home0/`
3. **Verwijdert oude ZIPs**: `rm -rf ./csv_file/*.zip`
4. **Maakt nieuwe ZIP**: `zip -r -q ./LFIN2230700238.zip ./csv_file/`
5. **Berekent MD5**: `md5sum LFIN2230700238.zip | awk -F " " '{print $1}'`
6. **Checkt of leeg**: `ls -A csv_file/` → `zip_dir_empty`
7. **Stuurt MQTT respond**:
   ```json
   {"message":{"result":0,"value":{"md5":"<hash>","name":"LFIN2230700238.zip","zip_dir_empty":0}},"type":"get_map_list_respond"}
   ```
8. **Uploadt ZIP naar server**: POST naar `/api/nova-file-server/map/uploadEquipmentTrack`
   (functie: `updata_file_fun_map_list_strJson_send`)

### Bewezen werkend (maart 2026)
Na SSH upload van CSV bestanden → `get_map_list` retourneert correct de ZIP met MD5.
Dit betekent dat mqtt_node de CSV bestanden WEL ziet, maar `map_num` in statusrapporten
blijft `0` (map_num = coverage task maps, niet filesystem maps).

### Volledige kaart-flow (upload → app weergave)

De kaart-flow is **upload-only** — de maaier uploadt naar de server, nooit andersom:

1. **Maaier → Server**: `POST /api/nova-file-server/map/uploadEquipmentMap` (multipart ZIP)
   - Server parseert ZIP → extraheert GPS polygonen → slaat op in DB + `_latest.zip`
2. **App → Server**: `GET /api/nova-file-server/map/queryEquipmentMap?sn=<SN>`
   - Server bouwt gestructureerd JSON uit DB: `{ data: { work: [...], unicom: [...] } }`
   - App doet `data as Map<String, dynamic>` typecheck — data MOET JSON object zijn, geen base64!
3. **Dashboard → Server**: kaarten gemaakt in dashboard worden opgeslagen in DB
   - Bij "Push to mower" wordt ZIP gegenereerd en ook als `_latest.zip` opgeslagen

De maaier heeft GEEN download functionaliteit — string `queryEquipmentMap` komt niet voor in `mqtt_node`.

---

## `map_num` vs `get_map_list` — Verschil

| Concept | `map_num` | `get_map_list` |
|---------|-----------|----------------|
| Bron | `robot_decision/robot_status` topic | Filesystem scan |
| Betekenis | Aantal kaarten in **actieve coverage task** | Aantal beschikbare kaart-ZIPs |
| Waarde `0` | Geen actieve maaier-taak met kaarten | csv_file/ is leeg |
| Verandert door | Start coverage task | Bestanden toevoegen/verwijderen |

---

## novabot_mapping Node

**Launch file:** `/root/novabot/install/novabot_mapping/share/novabot_mapping/launch/novabot_mapping_launch.py`

Configuratie:
- `data_dir: "/userdata/lfi/"` — hoofd data directory
- `map_area_file` — UITGECOMMENTARIEERD in launch file
- `respawn=True` — UITGECOMMENTARIEERD (node herstart NIET automatisch na crash!)
- Bij startup: leest `map_info.json` + CSV bestanden → logt `updateMonitorMapData succeed`

**Daemon monitoring:** `daemon_monitor.sh` monitort ALLEEN camera/perception nodes,
NIET novabot_mapping. Als novabot_mapping crasht, wordt het NIET automatisch herstart.

---

## Proces-architectuur bij boot

```
systemd
├── novabot_ota_launch.service (EERST)
│   └── run_ota.sh
│       ├── ros2 launch novabot_api novabot_api_node.py
│       │   └── mqtt_node (PID ~2693, respawn=True, delay=5s)
│       └── ota_client
│
├── novabot_launch.service (DAARNA)
│   └── run_novabot.sh
│       ├── ros2 launch novabot_mapping novabot_mapping_launch.py
│       │   └── novabot_mapping (respawn UITGECOMMENTARIEERD!)
│       ├── ros2 launch ... (navigation, perception, etc.)
│       └── daemon_monitor.sh (monitort camera nodes)
│
└── iox-roudi (iceoryx, alleen voor camera/perception)
```

---

## Config Bestanden op Maaier

| Bestand | Locatie | Inhoud |
|---------|---------|--------|
| `json_config.json` | `/userdata/lfi/json_config.json` | MQTT, SN, WiFi, LoRa, para, config (timezone) |
| `http_address.txt` | `/userdata/lfi/http_address.txt` | HTTP server adres (ZONDER http://) |
| `system_version.txt` | `/userdata/lfi/system_version.txt` | Firmware versie string |
| `ble_mac.txt` | `/userdata/lfi/ble_mac.txt` | BLE MAC adres |
| `mcu_message.json` | `/userdata/lfi/mcu_message.json` | MCU communicatie data |
| `novabot_timezone.txt` | `/userdata/ota/novabot_timezone.txt` | Timezone (geschreven door mqtt_node bij tz commando) |

---

## Log Bestanden

| Locatie | Inhoud |
|---------|--------|
| `/root/novabot/data/ros2_log/mqtt_node_*.log` | mqtt_node applicatie log (bevat binary data!) |
| `/root/novabot/data/ros2_log/mqtt_error_*.log` | mqtt_node error log |
| `/root/novabot/data/ros2_log/mqtt_reconnect.txt` | WiFi reconnect pogingen |
| `/root/novabot/data/ros2_log/aruco_localization_*.log` | ArUco marker localisatie |
| `/root/novabot/data/ros2_log/auto_recharge_server_*.log` | Auto-recharge service |
| `/userdata/ota/start_service.log` | OTA service startup |
| `/userdata/ota/ota_client.log` | OTA client download logs |
| `journalctl -u novabot_ota_launch.service` | Systemd service logs |

**Let op:** mqtt_node logs bevatten binary data. Gebruik `strings` om te lezen:
```bash
strings /root/novabot/data/ros2_log/mqtt_node_*.log | grep -i "<zoekterm>"
```

---

## ROS2 Services (Kaart-gerelateerd)

| Service | Type | Gebruik |
|---------|------|---------|
| `/robot_decision/delete_map` | `decision_msgs/srv/DeleteMap` | Kaart verwijderen |
| `/novabot_mapping/save_map` | | Mapping sessie opslaan (GEEN coördinaten!) |
| `/robot_decision/start_coverage_task` | `decision_msgs/srv/StartCoverageTask` | Maaier starten met polygon_area |

### MQTT commando's (kaart-gerelateerd)

| Commando | Richting | Functie |
|----------|----------|---------|
| `get_map_list` | Server→Maaier | Vraag kaartlijst op |
| `get_map_list_respond` | Maaier→Server | Antwoord met ZIP naam + MD5 |
| `novabot_delete_map` | Server→Maaier | Verwijder kaart (met `map_type`) |
| `delete_map_respond` | Maaier→Server | Bevestiging verwijdering |
| `save_map` | Server→Maaier | Sluit mapping sessie af |
| `area_set` | Server→Maaier | GPS bounding box sturen |
