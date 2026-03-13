<\!-- Referentiebestand — gebruik @FIRMWARE-MOWER.md.md om dit te laden in een sessie -->
## Maaier Firmware Analyse (v5.7.1, februari 2026)

De maaier firmware is een **Debian pakket** (`mvp` v5.7.1, 35MB, 7570 bestanden) dat een
compleet **ROS 2 Galactic** systeem bevat op een **Horizon Robotics X3 SoC** met ARM aarch64.

**Dit is fundamenteel anders dan de charger** (ESP32-S3 microcontroller) — de maaier draait
volwaardig Linux met een complete navigatie- en perceptiestack.

### Hardware platform

| Component | Type | Details |
|-----------|------|---------|
| **SoC** | Horizon Robotics X3 | ARM aarch64 + BPU AI accelerator |
| **AI chip** | Horizon BPU | Dedicated neural network inference engine |
| **Front camera** | Sony IMX307 | 1920x1080, MIPI CSI-2, 25fps |
| **Depth camera** | PMD Royale (ToF) | Depth, point cloud, grayscale |
| **GPS** | RTK via charger relay | cm-nauwkeurig via LoRa NMEA relay |
| **DDS middleware** | CycloneDDS + iceoryx | Zero-copy shared memory IPC |

### ROS 2 pakketstructuur

Geëxtraheerd uit `/tmp/mower_firmware/install/`:

**Perceptie & Camera:**
| Pakket | Beschrijving |
|--------|-------------|
| `perception_node` | AI-perceptie: obstakeldetectie + segmentatie (2.6MB binary) |
| `camera_307_cap` | IMX307 front camera driver (MIPI, GDC undistortion) |
| `royale_platform_driver` | PMD ToF depth camera driver |
| `horizon_wrapper` | Horizon BPU DNN inference wrapper |
| `percep_srv` | Perception service interfaces |
| `take_picture_manager` | Foto-opname manager |

**Navigatie (Nav2 stack):**
| Pakket | Beschrijving |
|--------|-------------|
| `nav2_single_node_navigator` | Hoofd navigator |
| `nav2_controller` | Pad-volg controller |
| `nav2_costmap_2d` | Costmap met obstakellagen |
| `nav2_navfn_planner` | A* global planner |
| `nav2_theta_star_planner` | Theta* planner |
| `nav2_smac_planner` | State lattice planner |
| `nav2_dwb_controller` | Dynamic Window controller |
| `nav2_regulated_pure_pursuit_controller` | Pure Pursuit controller |
| `teb_local_planner` | Timed Elastic Band local planner |
| `costmap_converter` | Costmap naar polygonen converter |

**Kernfunctionaliteit:**
| Pakket | Beschrijving |
|--------|-------------|
| `novabot_api` | MQTT ↔ ROS 2 bridge (API service) |
| `novabot_mapping` | Kaart bouwen en beheren |
| `coverage_planner` | Maaipatroon generatie |
| `coverage_map_2d` | 2D dekkingskaart |
| `compound_decision` | Beslissingslogica (autonome taken) |
| `chassis_control` | Wielaansturing, motoren |
| `robot_combination_localization` | GPS + ArUco + odometrie fusie |
| `aruco_localization` | ArUco marker lokalisatie (laadstation QR code) |
| `automatic_recharge` | Automatisch terugkeren naar charger |
| `daemon_process` | Systeem daemon (watchdog) |
| `ota_client` | OTA firmware update client |
| `x3_running_check` | Horizon X3 health monitoring |
| `x3_boot_check` | Boot verificatie |

### AI Perceptie Systeem — VOLLEDIG GEÏMPLEMENTEERD

De maaier heeft een **werkend AI-obstakeldetectiesysteem** met twee neurale netwerken
die draaien op de Horizon BPU AI-accelerator.

#### AI modellen

| Model | Bestand | Grootte | Invoer | Architectuur |
|-------|---------|---------|--------|-------------|
| **Detectie** | `novabot_detv2_11_960_512.bin` | 8.1 MB | 960x512 RGB | YOLO-variant (HZ quantized) |
| **Segmentatie** | `bisenetv2-seg_2023-11-27_512-960_vanilla.bin` | 3.6 MB | 960x512 RGB | BiSeNet-v2 (HZ quantized) |

Beide modellen in Horizon quantized formaat (.bin), geoptimaliseerd voor BPU inference.
Locatie: `install/perception_node/share/perception_node/perception_conf/`

#### Detectie klassen (uit `infer_class.json`)

**Object detectie model (9 klassen):**
| ID | Klasse | Beschrijving |
|----|--------|-------------|
| 100 | `person` | Personen |
| 101 | `animal` | Dieren |
| 102 | `obstacle` | Generieke obstakels |
| 103 | `shoes` | Schoenen |
| 104 | `wheel` | Wielen |
| 105 | `leaf debris` | Bladafval |
| 106 | `faeces` | Uitwerpselen |
| 107 | `rock` | Stenen |
| 108 | `background` | Achtergrond |

**Segmentatie model (14 klassen):**
| ID | Klasse | Beschrijving |
|----|--------|-------------|
| 0 | `unlabeled` | Ongelabeld |
| 1 | `background` | Achtergrond |
| 2 | `lawn` | **Gazon** (hoofddoel) |
| 3 | `road` | Weg/pad |
| 4 | `terrain` | Terrein |
| 5 | `fixed obstacle` | Vast obstakel |
| 6 | `static obstacle` | Statisch obstakel |
| 7 | `dynamic obstacle` | Dynamisch obstakel |
| 8 | `bush` | Struik |
| 9 | `faeces` | Uitwerpselen |
| 10 | `charging station` | Laadstation |
| 11 | `dirt` | Vuil |
| 12 | `sunlight` | Zonlicht (reflectie) |
| 13 | `glass` | Glas |

#### Inference modes (runtime selecteerbaar)

| Mode | Beschrijving | Service call |
|------|-------------|-------------|
| 1 | Alleen segmentatie | `/perception/do_perception` (SetBool) |
| 2 | Alleen detectie | |
| 3 | Detectie + segmentatie (fusie) | |

#### Perceptie pipeline

```
IMX307 Camera (1920x1080 @ 25fps)
    │
    ▼ /camera/preposition/image
Resize → 960x512
    │
    ├──────────────────────┐
    ▼                      ▼
Detectie Model         Segmentatie Model
(8.1MB DNN)            (3.6MB BiSeNet-v2)
BBox + confidence      Pixel-wise labels
    │                      │
    └──────────┬───────────┘
               ▼
    Fusie & Post-processing
    - KDtree ruis filtering
    - Kleine regio suppressie (min 3px)
    - Morfologische sluiting
    - Hoogte filtering (0-50cm)
    - Groei drempel: 0.05
               │
    ┌──────────┴──────────┐
    ▼                      ▼
ToF Point Cloud        RGB Point Cloud
(diepte-gebaseerd)     (segmentatie labels)
    │                      │
    └──────────┬───────────┘
               ▼
/perception/points_labeled (PointCloud2)
    Met semantische labels
               │
               ▼
Nav2 Costmap Obstacle Layer
    min_obstacle_height: 0.35m
    max_obstacle_height: 0.50m
    obstacle_max_range: 1.49m
    observation_persistence: 2.0s
               │
               ▼
Path Planning & Obstacle Avoidance
```

#### Perception node configuratie

```yaml
det_model_name: "novabot_detv2_11_960_512.bin"
seg_model_name: "bisenetv2-seg_2023-11-27_512-960_vanilla.bin"
detec_threshold: 0.61          # Detectie confidence drempel
infer_mode: 1                  # 1=seg, 2=det, 3=beide
suppress_size: 3               # Min regio grootte (pixels)
timer_rate: 100.0              # Inference frequentie (Hz)
dirty_frame: 60                # Vuile lens detectie drempel
pub_debug_image: False         # Debug visualisatie
```

#### ROS 2 topics (perceptie)

| Topic | Type | Beschrijving |
|-------|------|-------------|
| `/camera/preposition/image` | Image | RGB input van IMX307 |
| `/camera/tof/depth_image` | Image | Depth map van ToF |
| `/camera/tof/point_cloud` | PointCloud2 | 3D point cloud van ToF |
| `/perception/points_labeled` | PointCloud2 | **Hoofd output**: gelabelde obstakels |
| `/perception/labeled_img/compressed` | CompressedImage | Debug: gesegmenteerd beeld |
| `/perception/pedestrian_detect` | - | Gedetecteerde personen/dieren |
| `/perception/dirty_detect` | - | Camera vuil/beslagen status |

#### Camera vuil detectie

Aparte ML-module die detecteert of de cameralens vuil/beslagen is:
- Klassen: `clean`, `transparent`, `semi_transparent`, `opaque`
- Entropie-gebaseerde analyse + ML inference
- Service: `/start_dirty_detection`

#### Perception node versiegeschiedenis (uit `perception_node_version.json`)

| Versie | Datum | Wijzigingen |
|--------|-------|-------------|
| V0.2.0 | - | Initieel: dual-model support, camera data alignment verwijderd |
| V0.2.1 | - | Model switching, fusie modes, nieuw detectie model |
| V0.3.0 | - | Single-model inference, morfologische post-processing |
| V0.3.3 | - | KDtree ruis filtering, 10% CPU reductie |
| V0.4.0 | - | Data recording capability |
| V0.4.7 | - | Camera vuil detectie toegevoegd |
| V0.5.2b | - | Z-filter van 0.35→0.50m, groei drempel 0.08 (hoog gras fix) |
| V0.5.3 | - | Groei drempel naar 0.05, laadstation kleur distinctie |
| **V0.5.3d** | **2024/06/12** | **Huidige versie** — input size filter tegen crashes |

Eigenaar: `youfeng` (LFI developer). Design docs op Feishu (Lark) intern wiki.

### Maaier systeem startup volgorde

Uit `debug_sh/run_all_perception.sh`:
```
1. iox-roudi          (shared memory daemon)
2. camera_307_cap     (IMX307 front camera)
3. perception_node    (AI inference)
4. royale_platform    (ToF depth camera)
5. robot_combination_localization (GPS/ArUco/odometrie fusie)
6. nav2_single_node   (navigatie)
7. coverage_planner   (maaipatroon)
```

### Debug scripts (firmware)

In `debug_sh/` staan 100+ scripts voor ontwikkeling en testen:
- `enable_perception.sh` / `disable_perception.sh` — AI aan/uit schakelen
- `start_front_camera.sh` — Camera starten met parameters
- `demo_tof.sh` — ToF camera demonstratie
- `open_collision.sh` / `close_collision.sh` — Botsingsdetectie aan/uit
- `mapping_*.sh` — Kaart bouwen scripts
- `test_coverage_cutting.sh` — Maaitests
- `chassis_factory_test.py` — Factory testscript (14KB Python)
- `novabot_keyboard.py` — Keyboard teleop (15KB Python)
- `topic_points_labeled.sh` — Live obstakel output bekijken

### Shared memory architectuur

DDS middleware met iceoryx voor zero-copy IPC:
- Configuratie: `shm_config/shm_cyclonedds.xml`
- Sub-queue capacity: 128 berichten
- History: 16 samples
- Alternatief: FastRTPS met `shm_fastdds.xml`

### Conclusie AI obstakeldetectie

**VOLLEDIG GEÏMPLEMENTEERD EN ACTIEF** — dit is geen scaffolding of belofte:
- Twee productie AI modellen (8.1MB detectie + 3.6MB segmentatie)
- Horizon BPU hardware-acceleratie (`hbDNNInfer`, `libdnn.so`)
- Real-time inference op 100 Hz
- Volledige integratie met Nav2 costmap en padplanning
- Versiegeschiedenis toont actieve doorontwikkeling (V0.2.0 → V0.5.3d)
- Detecteert: personen, dieren, schoenen, stenen, bladafval, uitwerpselen, struiken, glas
- Segmenteert: gazon vs obstakel grenzen, terrein types, laadstation

### Camera systeem en video streaming analyse (februari 2026)

**Camera hardware:**
| Camera | Sensor | Resolutie | Interface | Doel |
|--------|--------|-----------|-----------|------|
| Front (preposition) | Sony IMX307 | 1920×1080 @25fps | MIPI CSI-2 | RGB navigatie, obstakeldetectie |
| Panoramic | Sony IMX307 | 1920×1080 | MIPI CSI-2 | Breed overzicht |
| Depth/ToF | PMD Royale (IRS2875C) | Point cloud + grayscale | Geïntegreerd | 3D diepte, obstakel vermijding |

**Camera ISP libraries (in `ota_lib/lib/`):**
- `libimx307preposition.so` / `libimx307preposition_linear.so` — Front camera ISP
- `libimx307panoramic.so` / `libimx307panoramic_linear.so` — Panoramic camera ISP
- `libirs2875c_pmd.so` — PMD ToF sensor driver

**Image processing pipeline:**
1. IMX307 → MIPI CSI-2 → Horizon SIF (sensor interface)
2. ISP (auto-exposure, white balance)
3. GDC (fisheye undistortion via custom distortion map, 180° FOV)
4. VPU (H.264 encoding, semiplanar420 YUV)
5. ROS 2 Topic publish (`/camera/preposition/image/compressed`)

**Camera calibratie bestanden (`ota_lib/camera_params/`):**
- `preposition_intrinsic.json` — Fisheye K-matrix (~1129-1205px focal length)
- `layout_preposition.json` — GDC layout (180° FOV, 1080px diameter)
- `preposition_tof_extrinsic.json` — RGB↔ToF rotatiematrix + translatie
- `gdc_map.py` — Python GDC distortion map generator (OpenCV fisheye)

**ROS 2 camera topics:**
| Topic | Beschrijving |
|-------|-------------|
| `/camera/preposition/image` | RGB image (1920×1080) |
| `/camera/preposition/image/compressed` | Gecomprimeerde RGB stream |
| `/camera/preposition/image_half/compressed` | Halve resolutie stream |
| `/camera/panoramic/image/compressed` | Panoramic camera stream |
| `/camera/tof/depth_image` | Depth map |
| `/camera/tof/gray_image` | Grayscale van ToF |
| `/camera/tof/point_cloud` | 3D point cloud |

**Camera aan/uit via ROS 2 services:**
```bash
ros2 service call /camera/preposition/start_camera std_srvs/srv/SetBool "data: true"
ros2 service call /camera/tof/start_camera std_srvs/srv/SetBool "data: true"
```

**Foto opslaan:** `ros2 service call /camera/preposition/save_camera std_srvs/srv/Empty`

**Video streaming status: NIET GEÏMPLEMENTEERD**
- Camera's zijn puur voor **autonome navigatie** — niet voor remote viewing
- Geen RTSP server, WebRTC, MJPEG server, of P2P library (TUTK/Kalay)
- Geen MQTT camera commando's (van de 40+ commando's is er geen camera-gerelateerd)
- App `video_player` is alleen voor tutorial video's (`assembly2.mp4`, `plan1-4.mp4`)
- ROS 2 is `ROS_LOCALHOST_ONLY=1` — camera data verlaat de maaier nooit
- Live camera was een **selling point** van Novabot maar is nooit geïmplementeerd in software
- Debug mode (uitgecommentarieerd in `run_all.sh`) had een optie voor netwerk-exposed ROS 2

### Maaier netwerk services en remote toegang (februari 2026)

**Status: GEEN remote toegang mogelijk zonder fysieke interventie**

| Service | Status | Details |
|---------|--------|---------|
| SSH/SSHD | **Niet geïnstalleerd** | Geen openssh-server of dropbear aanwezig |
| Telnet | **Niet geïnstalleerd** | |
| VNC | **Expliciet verwijderd** | `apt purge -y x11vnc` in `start_service.sh` |
| ADB | **Niet gevonden** | |
| HTTP server | **Niet aanwezig** | Geen webserver voor camera/API |
| UDP broadcast | **Uitgeschakeld** | Factory test tool (`udp_client`), uitgecommentarieerd |
| ROS 2 | **Localhost only** | `export ROS_LOCALHOST_ONLY=1` in alle startup scripts |
| dnsmasq | **Actief** | DHCP/DNS voor WiFi AP modus |

**Startup services (systemd):**
- `novabot_launch.service` → `/root/novabot/scripts/run_novabot.sh start`
- `novabot_ota_launch.service` → `/userdata/ota/run_ota.sh start` (OTA + mqtt_node)

**WiFi configuratie in firmware:**
| Netwerk | SSID | Wachtwoord | Type |
|---------|------|-----------|------|
| LFI intern | `lfi-abc` / `LFI_TEST` | `nlfi@upenn123` / `lfi@upenn123` | Development |
| Factory default | `abcd1234` | `12345678` | Test |
| Maaier AP | `<SN>` | `12345678` | Eigen access point |

**Debug mode (uitgecommentarieerd in `debug_sh/run_all.sh`):**
```bash
#export DEBUG=ON
#export NETWORK_INTERFACE=wlan0
#export IPAddress=$(ifconfig $NETWORK_INTERFACE | grep -o 'inet [^ ]*' | cut -d ":" -f2)
```
Bevestigt dat netwerktoegang **gepland was** maar nooit in productie gezet.

**Fysieke toegangsmogelijkheden (voor SSH installatie / video streaming):**
1. **UART console** — GND/TX/RX/3V3 header op X3A board, 115200 baud → root shell
2. **HDMI + USB keyboard** — Micro-HDMI "DEBUG" poort + USB 3.0 → Linux console
3. Eenmaal ingelogd: `apt install -y openssh-server` (maaier heeft apt + internet via WiFi)
4. Dan `ROS_LOCALHOST_ONLY=0` zetten voor camera access via netwerk

**Let op bij openen behuizing**: Maaier is IP56 waterdicht. Rubber gaskets/O-ringen rondom de naad.
Voorzichtig openen om waterproof seals niet te beschadigen.

---

