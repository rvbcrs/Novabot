# Mowing Flow — Complete Reference

Gebaseerd op Flutter Novabot app v2.4.0 decompilatie (blutter).

## Protocol Selectie

De app ondersteunt twee protocollen, geselecteerd op basis van een bit flag in de mower status controller:

| Protocol | Wanneer | Start | Pauze | Hervat | Stop |
|----------|---------|-------|-------|--------|------|
| **Oud** (bit 4 CLEAR) | Oudere modellen | `start_run` | `pause_run` | `resume_run` | `stop_run` |
| **Nieuw** (bit 4 SET) | Nieuwere modellen | `start_navigation` | `pause_navigation` | `resume_navigation` | `stop_navigation` |

> **Onze aanpak**: We sturen altijd het nieuwe protocol (`start_navigation` etc.) omdat onze maaiers v6.x firmware draaien. Als dat niet werkt, fallback naar het oude protocol.

---

## Pre-Start Checks

Worden **in volgorde** uitgevoerd. Elk kan het starten blokkeren.

| # | Check | Blokkeerend? | Onze implementatie |
|---|-------|-------------|-------------------|
| 1 | `backingIntercept()` — maaier rijdt achteruit | Ja (wacht) | Popup: "Mower is backing up, please wait" |
| 2 | `lowBatteryIntercept()` — batterij < 20% | Ja (blokkeer) | Popup: "Battery too low (X%), please wait for charging" |
| 3 | `pinCodeIntercept()` — PIN niet ingesteld | Ja (blokkeer) | Skip — niet relevant voor onze setup |
| 4 | `noMap0Intercept()` — geen map0 aanwezig | Ja (blokkeer) | Popup: "No map found. Create a map first." |
| 5 | `noCharingUnicomIntercept()` — geen channel | Waarschuwing | Popup met 3 opties: Create / Cancel / Start Anyway |
| 6 | `workingIntercept()` — maaier al bezig | Ja (blokkeer) | Popup: "Mower is currently working" |

---

## Start Mowing Flow

### Stap 1: Snijhoogte instellen
```json
{"set_para_info": {"cutGrassHeight": 40, "defaultCuttingHeight": 40, "target_height": 40, "path_direction": 45}}
```
Response: `set_para_info_respond` met `result: 0`

### Stap 2: Start commando (500ms na set_para_info)

**Nieuw protocol:**
```json
{"start_navigation": {"mapName": "test", "cutterhigh": 40, "area": 1, "cmd_num": 12345}}
```
- `mapName`: altijd `"test"` (hardcoded in Flutter app)
- `area`: **1** = map0, **10** = map1, **200** = map2
- `cutterhigh`: snijhoogte (mm)
- `cmd_num`: auto-incrementing counter
- Response: `start_navigation_respond`

**Oud protocol:**
```json
{"start_run": {"mapName": null, "area": 1, "cutterhigh": 40}, "targetIsMower": false}
```
- `mapName`: null (niet "map0"!)
- `targetIsMower`: false (altijd)
- Response: `start_run_respond`

---

## Active Mowing Controls

### Pauze
**Nieuw:** `{"pause_navigation": {"cmd_num": N}}`
**Oud:** `{"pause_run": {}, "targetIsMower": false}`

### Hervat
**Nieuw:** `{"resume_navigation": {"cmd_num": N}}`
**Oud:** `{"resume_run": {}, "targetIsMower": false}`

### Stop
**Nieuw:** `{"stop_navigation": {"cmd_num": N}}`
**Oud:** `{"stop_run": {}, "targetIsMower": false}`

> **Let op:** Stop stuurt GEEN automatisch `go_to_charge`. Dat is een aparte actie.

---

## Go To Charge Flow

De app stuurt TWEE commando's in volgorde:

### Stap 1: go_pile
```json
{"go_pile": {}}
```
Response: `go_pile_respond`

### Stap 2: go_to_charge (na go_pile_respond)
```json
{"go_to_charge": {"cmd_num": N, "chargerpile": {"latitude": 200, "longitude": 200}}}
```
- `latitude: 200, longitude: 200` = **sentinel waarde** (niet echte GPS)
- Response: `go_to_charge_respond`

---

## Error Handling

| error_status | Betekenis | App gedrag |
|-------------|-----------|------------|
| 0 | Geen fout | Normaal |
| 124 | Robot buiten werkgebied | Popup + stop mowing |
| 126 | Recharging failed | Popup |
| 151 | Boot PIN lock | Popup (NIET onderdrukken) |

---

## Snijhoogte Berekening

Flutter app slaat snijhoogte op als: `(parameter + 2) * 10.0`

Voorbeeld: parameter 3 → opgeslagen als 50.0mm

De `cutterhigh` in het MQTT commando is de directe waarde (bijv. 40 = 40mm).

---

## Map Area Parameter Mapping

| Waarde | Map |
|--------|-----|
| 1 | map0 |
| 10 | map1 |
| 200 | map2 |

---

## Relevante MQTT Responses

| Response | Velden |
|----------|--------|
| `report_state_robot` | `work_status`, `task_mode`, `error_status`, `error_msg`, `cov_ratio`, `cov_area`, `recharge_status` |
| `report_state_timer_data` | `localization.map_position`, `battery_capacity`, `cover_path` |
| `report_exception_state` | `button_stop`, `chassis_err`, `rtk`, `rtk_sat` |
