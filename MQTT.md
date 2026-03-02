<\!-- Referentiebestand — gebruik @MQTT.md.md om dit te laden in een sessie -->
## MQTT Protocol

### Broker
- Extern adres: `mqtt.lfibot.com:1883`
- Lokaal: onze aedes broker op `0.0.0.0:1883`
- DNS redirect: `mqtt.lfibot.com` → Mac IP (via router of Pi-hole)

### Topic structuur
| Richting       | Topic patroon                    |
|----------------|----------------------------------|
| Apparaat → App | `Dart/Receive_mqtt/<SN>`         |
| App → Apparaat | `Dart/Send_mqtt/<SN>`            |

Apparaten gebruiken hun SN als topic-suffix. De app subscribeert op `Dart/Receive_mqtt/<SN>`
en publiceert commando's op `Dart/Send_mqtt/<SN>`.

### MQTT authenticatie
- Devices: username = SN, password = (onbekend, wij accepteren alles)
- App: clientId = appUserId (UUID), credentials via login session

### MQTT cloud credentials (uit getEquipmentBySN / userEquipmentList response)
| Apparaat | `account`    | `password`   |
|----------|-------------|-------------|
| Charger  | `li9hep19`  | `jzd4wac6`  |
| Maaier   | `null`      | `null`      |

De charger krijgt MQTT credentials mee van de cloud; de maaier **niet**.
Dit is bevestigd via cloud proxy capture (`ConsoleLogMower.txt`).
De maaier verbindt met de MQTT broker via een ander mechanisme (waarschijnlijk hardcoded in firmware).
Onze lokale broker accepteert alles, dus credentials hoeven niet gecheckt te worden.

### MQTT CONNECT flags bug (app) — sanitizeConnectFlags fix
De Novabot app stuurt een MQTT CONNECT packet met **Will QoS=1** terwijl **Will Flag=0**.
Dit is een schending van de MQTT 3.1.1 specificatie (sectie 3.1.2.6):
> "If the Will Flag is set to 0, then the Will QoS MUST be set to 0 (0x00)"

Aedes (onze MQTT broker) weigert deze verbinding met de foutmelding:
`Will QoS must be set to zero when Will Flag is set to 0`

**Fix**: `sanitizeConnectFlags()` in `broker.ts` (line 36) patcht de raw TCP bytes
van het CONNECT packet **voordat** aedes het parst. Het wist de Will QoS bits (3-4)
en Will Retain (bit 5) wanneer Will Flag (bit 2) niet gezet is.
De functie wordt aangeroepen op het eerste TCP chunk in de `socket.once('data', ...)` handler.

### MAC-adres in cloud response = BLE MAC (niet WiFi STA)
De cloud retourneert het **BLE MAC** adres in `macAddress`, niet het WiFi STA MAC:
- Charger: `48:27:E2:1B:A4:0A` (BLE MAC, WiFi STA = `...08`)
- Maaier:  `50:41:1C:39:BD:C1` (BLE MAC, WiFi STA = `...BF`)

De app matcht dit MAC-adres tegen BLE manufacturer data tijdens scanning.
Onze `device_registry` en `equipment` tabellen moeten daarom het BLE MAC bevatten.

### Compleet MQTT commando protocol (uit APK analyse)

Alle commando's worden gepubliceerd als JSON op `Dart/Send_mqtt/<SN>` (app→apparaat)
en ontvangen op `Dart/Receive_mqtt/<SN>` (apparaat→app).

**Maaien:**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `start_run` | `start_run_respond` | Start maaien |
| `stop_run` | `stop_run_respond` | Stop maaien |
| `pause_run` | `pause_run_respond` | Pauzeer maaien |
| `resume_run` | `resume_run_respond` | Hervat maaien |

**Navigatie:**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `start_navigation` | `start_navigation_respond` | Start punt-naar-punt navigatie |
| `stop_navigation` | `stop_navigation_respond` | Stop navigatie |
| `pause_navigation` | `pause_navigation_respond` | Pauzeer navigatie |
| `resume_navigation` | `resume_navigation_respond` | Hervat navigatie |

**Handmatige besturing (joystick, app route `/manulController`):**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `start_move` | _(geen)_ | Start handmatige beweging (joystick data) |
| `stop_move` | _(geen)_ | Stop handmatige beweging |

De joystick-pagina (`ManulControllerPageLogic`) stuurt continue positie-updates via `start_move`.
De `writeDataForMove` methode berekent richting/snelheid vanuit de joystick offset.

**Opladen / docking:**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `go_to_charge` | `go_to_charge_respond` | Ga naar laadstation |
| `go_pile` | `go_pile_respond` | Ga naar laadpaal |
| `stop_to_charge` | `stop_to_charge_respond` | Stop opladen |
| `auto_recharge` | `auto_recharge_respond` | Automatisch herladen |
| `get_recharge_pos` | `get_recharge_pos_respond` | Haal laadstation positie op |
| `save_recharge_pos` | `save_recharge_pos_respond` | Sla laadstation positie op |

**Kaart bouwen (mapping):**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `start_scan_map` | `start_scan_map_respond` | Start handmatig grens scannen |
| `stop_scan_map` | `stop_scan_map_respond` | Stop scannen |
| `add_scan_map` | `add_scan_map_respond` | Voeg scan-datapunt toe |
| `start_erase_map` | `start_erase_map_respond` | Start kaartgebied wissen |
| `stop_erase_map` | `stop_erase_map_respond` | Stop wissen |
| `start_assistant_build_map` | `start_assistant_build_map_respond` | Start automatisch kaart bouwen |
| `quit_mapping_mode` | _(geen)_ | Verlaat mapping modus |

**Kaart beheer:**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `get_map_list` | `get_map_list_respond` | Haal lijst van alle kaarten op |
| `get_map_outline` | _(via report)_ | Haal kaartgrens op |
| `get_map_plan_path` | `get_map_plan_path_respond` | Haal gepland maaipad op |
| `get_preview_cover_path` | `get_preview_cover_path_respond` | Haal coverage preview op |
| `generate_preview_cover_path` | `generate_preview_cover_path_respond` | Genereer coverage preview |
| `request_map_ids` | _(geen)_ | Verzoek beschikbare kaart-IDs |
| `save_map` | `save_map_respond` | Sla kaart op |
| `delete_map` | `delete_map_respond` | Verwijder kaart |
| `reset_map` | `reset_map_respond` | Reset kaart |

**Apparaat parameters (via BLE én MQTT):**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `get_para_info` | `get_para_info_respond` | Haal geavanceerde instellingen op |
| `set_para_info` | `set_para_info_respond` | Wijzig geavanceerde instellingen |

Parameters: `obstacle_avoidance_sensitivity`, `target_height`, `defaultCuttingHeight`,
`path_direction`, `cutGrassHeight`

**PIN code:**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `dev_pin_info` | `dev_pin_info_respond` | PIN code opvragen/instellen |
| `no_set_pin_code` | _(flag)_ | Geeft aan dat geen PIN code is ingesteld |

**OTA firmware update:**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `ota_version_info` | `ota_version_info_respond` | Firmware versie opvragen |
| `ota_upgrade_cmd` | _(via state)_ | Start OTA upgrade |
| `ota_upgrade_state` | _(unsolicited)_ | OTA voortgang (apparaat pusht dit) |

**Timer/planning:**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `timer_task` | _(geen)_ | Timer/gepland taak commando |

**Overig:**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `auto_connect` | _(geen)_ | Auto-connect commando |

### Status reports (apparaat → app, unsolicited)

Deze berichten worden periodiek door het apparaat gepusht (niet op verzoek):

| Report type | Beschrijving |
|-------------|-------------|
| `up_status_info` | Hoofd-statusupdate van charger (bevat alle charger/mower velden) |
| `report_state_robot` | Robot status rapport |
| `report_state_battery` | Batterij status rapport |
| `report_state_work` | Werk/maai status rapport |
| `report_state_map_outline` | Kaartgrens data |
| `report_state_timer_data` | Timer/planning data rapport |
| `report_exception_state` | Fout/uitzondering rapport |
| `ota_upgrade_state` | OTA upgrade voortgang |
| `connection_state` | Verbindingsstatus wijziging |

### MQTT payload velden

**`up_status_info` velden (charger → app):**
| Veld | Beschrijving |
|------|-------------|
| `charger_status` | Charger status bitfield (zie hieronder) |
| `mower_status` | Maaier operationele status |
| `mower_x` | Maaier X positie |
| `mower_y` | Maaier Y positie |
| `mower_z` | Maaier Z positie / heading |
| `mower_info` | Maaier info veld 1 |
| `mower_info1` | Maaier info veld 2 |
| `mower_error` | Fout-teller / error code |
| `battery_capacity` | Batterij percentage |

**Werk/status velden:**
| Veld | Beschrijving |
|------|-------------|
| `work_mode` | Huidige werkmodus |
| `work_state` | Huidige werkstatus |
| `work_status` | Werkstatus |
| `task_mode` | Taakmodus |
| `recharge_status` | Oplaadstatus |
| `prev_state` | Vorige status |
| `mowing_progress` | Maaivoortgang (percentage) |
| `error_code` | Numerieke foutcode |
| `error_msg` | Foutmelding tekst |
| `error_status` | Foutstatus |
| `cmd_num` | Commando volgnummer |

**Kaart-gerelateerde velden:**
| Veld | Beschrijving |
|------|-------------|
| `map_id` | Kaart identifier |
| `map_ids` | Lijst van kaart-IDs |
| `map_name` | Kaart naam |
| `map_type` | Kaart type (werkgebied, obstakel, kanaal) |
| `map_position` | Kaart positie data |
| `plan_path` | Gepland maaipad |
| `cover_path` | Coverage pad |
| `preview_cover_path` | Preview coverage pad |
| `path_direction` | Maaipad richting |
| `covering_area` | Huidig dekkingsgebied |
| `finished_area` | Afgewerkt gebeid |
| `cov_direction` | Coverage richting |

**Positie velden:**
| Veld | Beschrijving |
|------|-------------|
| `longitude` | GPS lengtegraad |
| `latitude` | GPS breedtegraad |
| `orient_flag` | Oriëntatie vlag |

### charger_status bitfield (volledig gedecodeerd uit firmware decompilatie)

| Bit(s) | Mask | Bron | Betekenis |
|--------|------|------|-----------|
| Bit 0 | `0x00000001` | GPS NMEA parser | GPS valid (< 5 opeenvolgende GNGGA parse failures) |
| Bit 8 | `0x00000100` | RTK quality check | RTK quality OK (< 5 opeenvolgende altitude deviaties) |
| Midden bits | `DAT_420013b8` | LoRa RSSI | OR'd wanneer LoRa RSSI in valid range (1-145) |
| **Bits 24-31** | `0xFF000000` | GNGGA veld 8 | **GPS satelliet-aantal** (verschoven << 24) |

**Reconstructie van geobserveerde waarden:**
| Waarde (hex)   | Byte 3 (sats) | Bits | Betekenis |
|----------------|--------------|------|-----------|
| `0x00000000`   | 0 sats       | geen | Geen GPS, geen RTK, geen LoRa |
| `0x0E000101`   | **14 sats**  | GPS + RTK | 14 satellieten, GPS en RTK OK |
| `0x10000101`   | **16 sats**  | GPS + RTK | 16 satellieten, GPS en RTK OK |
| `0x11000101`   | **17 sats**  | GPS + RTK | 17 satellieten, GPS en RTK OK |

Het hoge byte is letterlijk het GPS satelliet-aantal uit de GNGGA NMEA zin!

### mower_error gedrag (opgehelderd uit firmware decompilatie)

`mower_error` is **geen fout-teller van de maaier**, maar een **LoRa heartbeat failure counter** op de charger:

1. Charger pollt de maaier met LoRa pakket `[0x34, 0x01]` elke ~1.5 seconden
2. Als maaier antwoordt met `[0x34, 0x02, ...]` (status report) → counter reset naar **0**
3. Als maaier niet antwoordt → counter **increment met 1**
4. In `up_status_info` wordt `mower_error` alleen gerapporteerd als counter **>= 2** (om korte onderbrekingen te filteren)
5. Bij counter < 2 wordt `mower_error: 0` gerapporteerd

De counter stijgt continu zolang de maaier niet bereikbaar is via LoRa (bijv. uit bereik, uitgeschakeld, of LoRa kanaal mismatch).

---
