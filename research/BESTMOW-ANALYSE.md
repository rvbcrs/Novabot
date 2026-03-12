# BestMow APK Analyse (v1.12.0) — Vergelijking met Novabot

**Geanalyseerd:** 11 maart 2026
**APK:** `research/com_bestmow_mower_v1.12.0.apk` (141MB)
**Package:** `com.bestmow.mower`, intern `com.example.flutter_bestmow`
**Developer build path:** `file:///Users/kosongou/Desktop/workspace/project/flutter/flutter_bestmow/`

---

## Conclusie

**BestMow is DUIDELIJK een fork van de Novabot codebase:**

1. **API endpoints 95% identiek** — dezelfde `/api/nova-user/`, `/api/nova-data/`, `/api/nova-file-server/` namespaces. Ze hebben zelfs de "nova" prefix behouden.
2. **AES encryptie zelfde algoritme** — AES-128-CBC met NoPadding (null-bytes). Key/IV licht gewijzigd.
3. **MQTT topics hernoemd** — `Dart/Send_mqtt/` → `bestmow/request/`, `Dart/Receive_mqtt/` → `bestmow/respond/`
4. **BLE UUIDs gewijzigd** — `0x0201/0x0011/0x0021` → `0xFFF0/0xFFF1/0xFFF2`
5. **12-18 maanden extra ontwikkeling** — RTK, remote video maaien, activatiecodes, cloud backup, etc.
6. **Zelfde cloud provider** — Aliyun/Alibaba Cloud OSS

**Voor OpenNovabot:** Onze API structuur is bewezen correct — BestMow gebruikt exact dezelfde endpoints. BestMow-hardware is NIET wire-compatible met Novabot (andere MQTT topics, BLE UUIDs, AES keys).

---

## 1. App Architectuur

| Kenmerk | BestMow | Novabot |
|---------|---------|---------|
| Framework | Flutter/Dart | Flutter/Dart |
| Package | `com.bestmow.mower` | `com.inovabot.mower` |
| State management | GetX | ? |
| MQTT client | `mqtt_client` (Dart) | `mqtt_client` (Dart) |
| BLE library | `flutter_blue_plus` | vergelijkbaar |
| Video | Agora RTC SDK | Geen |
| Support | Zendesk SDK | Geen |
| Auth | Facebook + Google + Firebase | Email only |
| compileSdk | 36 | ? |
| minSdk | 23 | ? |
| cleartext HTTP | Ja | Ja |

---

## 2. Cloud Infrastructuur

| Omgeving | Type | Domein |
|----------|------|--------|
| Productie (US) | API/HTTP | `https://cluster-us.bestmow.net` |
| Productie (US) | MQTT | `mqtt-us.bestmow.net` |
| Productie (US) | NTRIP | `ns-us.bestmow.net` |
| Testing (CNSIT) | API/HTTP | `https://cluster-cnsit.bestmow.net` |
| Testing (CNSIT) | MQTT | `mqtt-cnsit.bestmow.net` |
| Testing (CNSIT) | NTRIP NS | `ns-cnsit.bestmow.net` |
| Testing (CNSIT) | NTRIP NC | `nc-cnsit.bestmow.net` |
| Website | Web | `https://www.bestmow.com/` |
| Support | Email | `support@bestmow.com` |
| Static assets | Aliyun OSS | `bestmow-public.oss-us-east-1.aliyuncs.com` |
| 3D HDR assets | Aliyun OSS | `watch-oss.oss-cn-hongkong.aliyuncs.com` |

**Firebase:** project `bestmow-8758e`
**Google API key:** `AIzaSyBijxxrcJepQ1MwFOzIs5o3SCaznCRG3WY`
**Facebook App ID:** `940771424646518`

App heeft dev page met environment switching: Production / Testing / Factory Test Mode.

---

## 3. API Endpoints — Volledige Lijst

### `/api/nova-user/` (identiek aan Novabot + uitbreidingen)

**Identiek aan Novabot:**
- `appUser/authLogin`, `login8`, `loginOut`, `regist`, `codeEmailLogin`
- `appUser/initFirstPassword`, `appUserInfo`, `appUserInfoUpdate`, `appUserPwdUpdate`
- `appUser/deleteAccount`, `queryUserSetting`, `updateAdvancedSetting`
- `appUser/updateAppUserMachineToken`, `updateMsgSetting`
- `equipment/bindingEquipment`, `unboundEquipment`, `userEquipmentList`
- `equipment/getMowerAndChargerByMac`, `updateEquipmentNickName`, `saveOrUpdateWifi`
- `validate/sendAppRegistEmailCode`, `sendAppResetPwdEmailCode`, `sendCodeForEmailAuth`
- `validate/validAppRegistEmailCode`, `verifyAndResetAppPwd`

**Nieuw in BestMow:**
- `appUser/updateUserEquipmentPermission`
- `equipment/bindingRtk`, `unboundRtk`, `getRtkByMac`, `transferRtkByWorker`
- `equipment/bindingRoamRelay`, `unboundRoamRelay`, `getRoamRelayByMac`
- `transferEquipment/submitByWorker`, `previewByWorker`, `revokedByWorker`, `pageRecordByWorker`
- `zendeskUser/generateJwt`

### `/api/nova-data/` (identiek aan Novabot)

- `appManage/queryCutGrassPlan`, `saveCutGrassPlan`, `updateCutGrassPlan`, `deleteCutGrassPlan`
- `appManage/queryNewVersion`
- `equipmentOta/checkOtaNewVersion`, `pushEquipmentOta`
- `equipmentState/mowerLastStatus/`
- `systemConfig/appGet?prefix=setting`

### `/api/nova-file-server/` (identiek + uitbreidingen)

**Identiek:** `map/queryEquipmentMap`, `map/updateEquipmentMapAlias`

**Nieuw:** `map/getBackupBySn`, `map/getUserDataRecoveryCompletedBySn`, `map/restoreMap`,
`images/getOutOfBoundsImages`, `log/uploadAppOperateLog`, `appGuidePage/getListByApp`,
`faq/getCategoryMenu`, `faq/getFaqListByMenuId`

### `/api/nova-message/` (GEHEEL NIEUW)

- **Activatiecodes:** `authCode/add`, `available`, `remove`, `status`, `update`
- **Amazon/Appstle:** `amazon/order/getAuthCodeByOrderNum`, `appstle/sendAuthCodeEmailByOrderName`
- **Advertenties:** `advertisement/active`, `advertisement/click`
- **Berichten:** `message/pageListMsgByUserId`, `queryRobotMsgPageByUserId`, `queryCutGrassRecordPageByUserId`, `queryUnreadCount`, `updateMsgToRead`, `deleteMsgByUser`, `deleteMsgByUserId`
- **Onderhoud:** `message/getMaintenanceCenterList`, `updateMaintenanceToDo`
- **Alarm:** `message/getMovingAlertBySn`
- **Remote maaien:** `remoteMower/requestRemote`, `cancelRemote`, `evaluateRemote`, `queryTrimControlStatusByUser`, `updateTrimControlStatusByUser`
- **Foutstatussen:** `robotErrorStatus/list`
- **Schema's:** `timingMowing/savePlan`, `queryPlan`, `updatePlan`, `deletePlan`, `updatePlanStatus`
- **Weer:** `weather/queryPreMowingCondition`
- **Orders:** `order/queryTrackingByEmail`, `queryTrackingByNumber`
- **Tijd schatting:** `timingTask/getTimeByArea`

### `/api/ntrip-center/` (GEHEEL NIEUW)

- `link/queryUsableRtkByApp`

---

## 4. MQTT Protocol

| Richting | BestMow | Novabot |
|----------|---------|---------|
| App → Apparaat | `bestmow/request/<SN>` | `Dart/Send_mqtt/<SN>` |
| Apparaat → App | `bestmow/respond/<SN>` | `Dart/Receive_mqtt/<SN>` |
| Status reports | `bestmow/status_report/<SN>` | via `Dart/Receive_mqtt/<SN>` |
| RTK status | `RTK/STATUS/<SN>` | n.v.t. |

- BestMow heeft apart status_report topic (Novabot mixt alles via Receive_mqtt)
- MQTT brokers: `mqtt-us.bestmow.net` (prod), `mqtt-cnsit.bestmow.net` (test)
- Zowel plain als TLS poorten beschikbaar

---

## 5. BLE Protocol

| Kenmerk | BestMow | Novabot Maaier | Novabot Charger |
|---------|---------|----------------|-----------------|
| Service | `0xFFF0` | `0x0201` | `0x1234` |
| Write char | `0xFFF1` | `0x0011` | `0x2222` |
| Notify char | `0xFFF2` | `0x0021` | `0x2222` |

**RTK apparaat (nieuw):**
- `36000001-0001-0002-0003-010203040506`
- `36000002-0001-0002-0003-010203040506`
- `36000003-0001-0002-0003-010203040506`

BLE commando's zijn identiek: `set_mqtt_info`, `set_para_info`, `charger_pile_detection`, etc.

---

## 6. AES Encryptie

| Kenmerk | BestMow | Novabot |
|---------|---------|---------|
| Algoritme | AES-128-CBC | AES-128-CBC |
| Padding | NoPadding (null-bytes) | NoPadding (null-bytes) |
| Mogelijke IV | `1234123412ABCDEF` | `abcd1234abcd1234` |
| Key derivatie | Custom per apparaat | `abcdabcd1234` + SN[-4:] |

Source: `package:flutter_bestmow/common/aes.dart`
Methoden: `_aesEncrypt`, `_encryptDataByCustom`, `_generateInitVector`
Debug tool: `pages/user/dev_page/widget/decryption_page.dart`

---

## 7. Nieuwe Features (niet in Novabot)

### RTK (Real-Time Kinematic)
- Eigen BLE UUIDs, NTRIP servers, MQTT topic `RTK/STATUS/<SN>`
- MQTT commando `set_ntrip`, API `bindingRtk/unboundRtk/getRtkByMac`
- RTK fix kwaliteit drempels: normal/bad/weak thresholds
- RTK guide video's

### WiFi Extender ("Roaming Device")
- "BestMow Wi-Fi Extender" — apart apparaat
- BLE provisioning + API endpoints

### Activatiecode Systeem
- Amazon order → activatiecode koppeling
- Appstle (Shopify) integratie
- Maximum apparaten per code, expiratie

### Remote Video Maaien
- Agora RTC SDK voor live video streaming
- Remote aanvragen/annuleren/evalueren
- Joystick besturing

### Anti-theft
- Bewegingsalarm bij ongeautoriseerd optillen/verplaatsen
- Out-of-bounds foto capture
- Alarm pauzeren (30 min)

### Cloud Backup
- Kaart backup + restore vanuit andere account

### Diagnostisch Centrum
- MQTT connectivity check
- DNS resolutie test
- Apparaat diagnostiek met statuslevels

### Weer Controle
- Regen/wind check voor maaien starten

### Geavanceerde Lawn Features
- 24 voorgedefinieerde maaipatronen
- Area merge/split, edge trim/adjustment
- Fixed point driving, forbidden zones
- Zone mowing, passage mapping

### 3D Model Viewer
- GLTF/GLB modellen van maaier
- HDR environment mapping

### Device Transfer
- Apparaat overdragen naar andere gebruiker

### Extra Talen
- EN, DE, NL, FR, IT, ES, SV (minstens 7 talen)

---

## 8. Bruikbaar voor OpenNovabot Dashboard

### 8a. Maaipatronen — CLIENT-SIDE feature, geen firmware nodig!

**Hoe het werkt:**
1. 24 JSON patronen in `assets/json/pattern_1.json` t/m `pattern_24.json`
2. Elk patroon bevat `contours` met x,y coördinaten (pixel-space ~2048x2048)
3. App plaatst patroon op kaart → gebruiker kan slepen, draaien, schalen
4. `generateStripes()` berekent parallelle maailijnen BINNEN de contour
5. `computePatternScreenPoints()` transformeert pixel→GPS coördinaten
6. Resultaat wordt als normale `polygon_area` GPS coverage task naar de maaier gestuurd

**Patroon vormen:** ster, hart, klaver, cirkel, vierkant, driehoek, pentagon, bliksem, zigzag, golf, vogel, 3D-box, etc.
**Max 10 patronen per taak.**
**Tekst/emoji ook mogelijk:** `convertTextToContours()` zet tekst om naar contour outlines.

**Conclusie:** De maaier hoeft NIETS te weten over patronen — hij krijgt gewoon GPS coördinaten. Dit is 100% dashboard-side implementeerbaar.

### 8b. Weer-controle — simpele API call

- `/api/nova-message/weather/queryPreMowingCondition` checkt regen/wind
- Dashboard kan een publieke weer-API gebruiken (OpenWeather, etc.)
- Velden: `rainSnow`, `skipRainSnow`, `enable_night_working`, `enable_rain_return`
- `enable_rain_return` is een MQTT instelling die naar maaier gestuurd kan worden

### 8c. Kaart backup/restore — we hebben dit al!

- Onze server slaat kaarten al op in SQLite + disk
- Cloud backup = simpelweg export/import van kaartdata
- BestMow endpoints: `getBackupBySn`, `restoreMap`, `getUserDataRecoveryCompletedBySn`

### 8d. MQTT commando's die mogelijk OOK op Novabot werken

| Commando | Functie | Kans |
|----------|---------|------|
| `mow_go_to_pos` | Navigeer naar punt op kaart | Hoog — zelfde firmware basis |
| `generate_preview_cover_path` | Preview maaipad voor start | Hoog |
| `map_no_go_zone` | Verboden zones definiëren | Hoog |
| `save_all_camera_image` | Camera snapshot opslaan | Medium |
| `mow_enable_remote_rtsp` | RTSP video stream | Medium — hebben we al via camera_node |
| `set_robot_reboot` | Reboot maaier | Hoog — testen! |
| `set_debug` | Debug mode | Medium |
| `boundary_offset` | Rand-offset instellen | Hoog — in set_para_info |
| `only_boundary_mode` | Alleen randen maaien | Hoog |
| `mowing_twice` | Dubbel maaien | Hoog |
| `collision_sensitive` | Botsing gevoeligheid | Hoog |
| `enable_ai_learning` | AI learning mode | Medium |

### 8e. Joystick control velden — BEVESTIGD identiek

- `manual_controller_v` = lineaire snelheid (voor/achter)
- `manual_controller_w` = hoeksnelheid (links/rechts draaien)
- Exact dezelfde veldnamen als ons dashboard al gebruikt

---

## 9. Developer Artifacts

- **Build path:** `/Users/kosongou/Desktop/workspace/project/flutter/flutter_bestmow/`
- **Developer:** `kosongou` (macOS user)
- **Firebase:** project `bestmow-8758e`
- **Geen VCS:** `generate_error_reason: NO_SUPPORTED_VCS_FOUND`
- **DRM:** Google Play `com.pairip.licensecheck`
- **Dart code niet geobfusceerd** — volledige pakket-paden leesbaar in `libapp.so`
