<\!-- Referentiebestand — gebruik @BLE.md.md om dit te laden in een sessie -->
## BLE Provisioning Protocol

De app configureert apparaten via BLE GATT (niet via WiFi AP HTTP of MQTT).
Commando's worden verstuurd als JSON over een GATT characteristic.

### Provisioning commando's (app → apparaat via BLE)
| Commando               | Beschrijving                             |
|------------------------|------------------------------------------|
| `get_signal_info`      | Lees WiFi RSSI + GPS kwaliteit           |
| `get_wifi_rssi`        | Lees WiFi signaalsterkte                 |
| `set_wifi_info`        | Stuur WiFi SSID + wachtwoord             |
| `set_mqtt_info`        | Stuur MQTT broker host/port             |
| `set_lora_info`        | LoRa configuratie (charger ↔ mower)      |
| `set_rtk_info`         | RTK GPS configuratie                     |
| `set_para_info`        | Overige parameters                       |
| `set_cfg_info`         | Algemene configuratie / commit           |

Elk commando heeft een bijbehorend `*_respond` van apparaat → app.

### Exacte BLE payload structuren (gecaptured uit Novabot.pklg)

BLE frames worden gesplitst in chunks van ~27 bytes, omgeven door `ble_start`/`ble_end` markers.

```json
// get_signal_info — lees WiFi RSSI + GPS satellieten
{"get_signal_info":0}
// Response:
{"type":"get_signal_info_respond","message":{"result":0,"value":{"wifi":0,"rtk":17}}}
// wifi = RSSI (0 = sterk), rtk = aantal GPS satellieten (17 = goed)

// set_wifi_info — thuisnetwerk + charger eigen AP instellen
{
  "set_wifi_info": {
    "sta": {"ssid":"<thuisnetwerk>","passwd":"<wachtwoord>","encrypt":0},
    "ap":  {"ssid":"<SN>",          "passwd":"12345678",    "encrypt":0}
  }
}
// Response:
{"type":"set_wifi_info_respond","message":{"result":0,"value":null}}

// set_mqtt_info — alleen host + port (geen credentials via BLE!)
{"set_mqtt_info":{"addr":"mqtt.lfibot.com","port":1883}}
// Response:
{"type":"set_mqtt_info_respond","message":{"result":0,"value":null}}

// set_lora_info — LoRa parameters
{"set_lora_info":{"addr":718,"channel":16,"hc":20,"lc":14}}
// Response: value = TOEGEWEZEN kanaal (niet null!)
{"type":"set_lora_info_respond","message":{"value":15}}

// set_rtk_info — RTK GPS configuratie
{"set_rtk_info":0}
// Response:
{"type":"set_rtk_info_respond","message":{"result":0,"value":null}}

// set_cfg_info — commit/activeer configuratie
{"set_cfg_info":1}
// Response:
{"type":"set_cfg_info_respond","message":{"result":0,"value":null}}
```

**Belangrijke observaties:**
- `set_mqtt_info` stuurt GEEN credentials — die worden apart geconfigureerd (via MQTT zelf of hardcoded)
- `set_wifi_info` bevat altijd twee sub-objecten: `sta` (thuisnet) + `ap` (charger's eigen AP met passwd=`12345678`)
- `set_lora_info_respond.value` = het werkelijk **toegewezen** LoRa kanaal (kan afwijken van gevraagd `channel`)
- `bindingEquipment` — de app stuurt ALLEEN `sn`, `appUserId`, `userCustomDeviceName` (GEEN `chargerChannel`!)
- Cloud slaat `chargerChannel: 16` op (het GEVRAAGDE kanaal, niet het toegewezen kanaal 15)

### chargerAddress en chargerChannel — herkomst en correcte waarden (februari 2026)

| Veld | Waarde | Herkomst | Opmerking |
|------|--------|----------|-----------|
| `chargerAddress` | `718` | BLE `set_lora_info.addr` (hardcoded in app) | Zelfde voor alle chargers |
| `chargerChannel` | `16` | BLE `set_lora_info.channel` (gevraagd door app) | Cloud slaat GEVRAAGDE waarde op, niet toegewezen (15) |

**Belangrijk**: De app stuurt `chargerAddress` en `chargerChannel` NIET mee in `bindingEquipment`.
De cloud (en onze server) moet deze waarden zelf bewaren. Herkomst:
- `chargerAddress`: hardcoded `718` in app (`_writeSetLoraInfo`, blutter adres 0x91bebc)
- `chargerChannel`: gelezen uit charger equipment record (`userEquipmentList`) voor maaier provisioning

**Cloud vs mower responses** (bevestigd uit cloud proxy logs):
- **Charger** `getEquipmentBySN`/`userEquipmentList`: `chargerAddress: 718, chargerChannel: 16`
- **Mower** `getEquipmentBySN`/`userEquipmentList`: `chargerAddress: null, chargerChannel: null`

De maaier krijgt NOOIT chargerAddress/chargerChannel in API responses. De app leest het LoRa kanaal
uit de charger record en stuurt het via BLE `set_lora_info` naar de maaier.

**`rowToCloudDto()` code** (equipment.ts):
```typescript
chargerAddress: isCharger ? (r.charger_address ? Number(r.charger_address) : 718) : null,
chargerChannel: isCharger ? (r.charger_channel ? Number(r.charger_channel) : 16) : null,
```

### "Add Charging Station" flow (stappen in app)
1. Voer SN in van het laadstation
2. Voer thuisnetwerk WiFi in (SSID + wachtwoord)
3. BLE connect → `get_signal_info` → toont WiFi=Sterk, GPS=Sterk
4. Klik Next → BLE commando's in volgorde:
   - `set_wifi_info` (sta + ap)
   - `set_mqtt_info` (addr + port)
   - `set_lora_info` → response geeft `chargerChannel`
   - `set_rtk_info`
   - `set_cfg_info` (commit)
5. Charger herverbindt met WiFi + MQTT (disconnect + reconnect zichtbaar in logs)
6. App doet `getEquipmentBySN` → krijgt `chargerAddress` + MQTT credentials terug
7. App doet `bindingEquipment` met ALLEEN `sn`, `appUserId`, `userCustomDeviceName` (GEEN chargerChannel!)
8. App doet `userEquipmentList` → laadstation verschijnt op startscherm

### "Add Mower" BLE provisioning flow (gecaptured via cloud, februari 2026)

Capture bestanden: `Novabot-Mower-cloud.pklg` (BLE) + `ConsoleLogMower.txt` (MQTT/HTTP proxy)

**Belangrijke verschillen met charger flow:**
- BLE device naam: `Novabot` (niet `CHARGER_PILE`)
- `set_wifi_info` bevat ALLEEN `ap` sub-object (geen `sta`!) — maaier verbindt via charger AP, niet direct met thuisnetwerk
- Commando volgorde: wifi → lora → mqtt → cfg (geen `set_rtk_info`!)
- `set_cfg_info` bevat extra veld `tz` (timezone)
- `set_lora_info_respond` geeft `value: null` (niet een kanaalnummer zoals bij charger)

**BLE commando's (exacte payloads uit Novabot-Mower-cloud.pklg):**
```json
// set_wifi_info — ALLEEN ap (maaier verbindt via charger AP)
{"set_wifi_info":{"ap":{"ssid":"<thuisnetwerk>","passwd":"<wachtwoord>","encrypt":0}}}
// Response:
{"type":"set_wifi_info_respond","message":{"result":0,"value":null}}

// set_lora_info — zelfde parameters als charger
{"set_lora_info":{"addr":718,"channel":15,"hc":20,"lc":14}}
// Response: value = null (NIET een kanaalnummer!)
{"type":"set_lora_info_respond","message":{"result":0,"value":null}}

// set_mqtt_info — host + port
{"set_mqtt_info":{"addr":"mqtt.lfibot.com","port":1883}}
// Response:
{"type":"set_mqtt_info_respond","message":{"result":0,"value":null}}

// set_cfg_info — met timezone!
{"set_cfg_info":{"cfg_value":1,"tz":"Europe/Amsterdam"}}
// Response:
{"type":"set_cfg_info_respond","message":{"result":0,"value":null}}
```

**Stappen:**
1. Voer SN in van de maaier (of scan QR code)
2. Voer thuisnetwerk WiFi in (SSID + wachtwoord)
3. BLE connect → `get_signal_info`
4. BLE commando's in volgorde:
   - `set_wifi_info` (alleen `ap`!)
   - `set_lora_info` → response `value: null`
   - `set_mqtt_info` (addr + port)
   - `set_cfg_info` (met timezone)
5. Maaier herverbindt met WiFi + MQTT
6. App doet `getEquipmentBySN` + `bindingEquipment`

### `POST /api/nova-network/network/connection` — connectivity check

Nieuw endpoint ontdekt in ConsoleLogMower.txt. De app roept dit elke ~5 seconden aan.
Cloud response: `{"success":true,"code":200,"message":"request success","value":1}`
Geïmplementeerd in `novabot-server/src/routes/nova-network/network.ts`.

### Mogelijke oorzaak "Network configuration error"
- App (MQTT client) kan port 1883 niet bereiken op de Mac (macOS firewall!)
- BLE verbinding valt weg tijdens WiFi herverbinding (ESP32 instabiliteit)
- Charger subscribeert niet op `Dart/Send_mqtt/LFIC1230700004` na MQTT reconnect

---
