# Randmaaien per schema plannen — ontwerp

**Datum:** 2026-08-02
**Status:** goedgekeurd ontwerp, klaar voor implementatieplan
**Probleem:** de maaier doet nú aan het einde van ELKE maaibeurt een randmaai (edge cut). Dat hoeft niet elke dag. De gebruiker wil per maaischema kunnen aangeven op welke dagen er wél een randmaai plaatsvindt.

---

## Achtergrond: waar komt de randmaai vandaan (geverifieerd)

De randmaai zit in de firmware, niet in server of app. Bij een `start_navigation` bouwt de stock `robot_decision`-node (C++, `compound_decision`) zelf het coverage-goal en zet daarin `include_edge = true`. De planner (`coverage_planner_server`) draait daarna automatisch de randfase (feedback `work_status = 150 = BOUNDARY_COVERING`). Server en app sturen géén apart randmaai-commando bij een gewone beurt.

Onderzocht en uitgesloten als aanpasknop (live op .244 + disassembly van `robot_decision.bin`, 2026-08-02):

- **ROS-parameter `include_edge`.** `robot_decision` declareert die parameter (staat live op `1`), maar de disassembly toont dat de returnwaarde van `declare_parameter` direct wordt weggegooid en de string `"include_edge"` exact één keer in de binary voorkomt (in `declareParam`, nergens anders). De parameter wordt gedeclareerd en nooit gelezen. `ros2 param set` doet niets. Dood overblijfsel.
- **Config-bestanden.** `robot_decision.yaml` en `coverage_planner_params.yaml` bevatten alleen `boundary_offset`, `boundary_inflation_radius`, `boundary_covering_speed` — hóe de rand gemaaid wordt, niet óf.
- **`cov_mode` in `StartCoverageTask`.** Belandt in member `this+0xd61` en raakt `include_edge` niet.

Wél gevonden: in `RobotDecision::coverStartDeal` zet één instructie de vlag onvoorwaardelijk:

```
92188: mov  w3, #0x1
921a8: strb w3, [sp, #0xae]     ← goal.include_edge = true   (goal-base = sp+0x88, veld-offset 0x26)
```

Offset-mapping onafhankelijk bevestigd: `sp+0xb1` (offset 0x29 = `blade_height`) draagt `10*x + 20`, exact de bekende `(cutterhigh+2)*10`-formule. Klopt de ene offset, dan klopt de andere.

---

## Gekozen mechanisme: firmware-default UIT, randmaai TOEVOEGEN op rand-dagen

De gebruiker wil randmaaien **zelden**. Daarom houden we het frequente pad (een gewone maaidag) schoon en verplaatsen we het extra werk naar de zeldzame rand-dag.

1. **Firmware-patch (build-time):** `strb w3` → `strb wzr` op offset `0x921a8` (`3902bbe3` → `3902bbff`), 4 bytes. Daarmee is `include_edge` permanent `false` en doet een gewone maaibeurt nooit meer de randfase. Patch komt in `research/build_custom_firmware.sh` naast de LED-fix, dus overleeft OTA.
2. **Rand-dag toevoegen (server):** op een dag die volgens het schema een rand-dag is, stuurt de server na afloop van de maaibeurt een losse `start_edge_cut`-sessie (het bestaande commando dat de app ook gebruikt en dat al werkt via `extended_commands.py`).

Waarom deze richting en niet "firmware-default AAN + onderbreken op niet-rand-dagen":

| | Gewone dag (frequent) | Rand-dag (zeldzaam) |
|---|---|---|
| **Gekozen: patch + toevoegen** | schone stock-beurt, geen onderbreking, 1 record | maaibeurt + losse randsessie (1 extra dock-cyclus, 2 records) |
| Alternatief: onderbreken bij BOUNDARY_COVERING | elke dag stop+dock-interceptie, "interrupted"-record, multi-zone-risico | schone inline maaibeurt+rand, 1 record |

Het onderbreek-alternatief maakt het frequente pad rommelig (elke dag interceptie + multi-zone-timingrisico). De gekozen richting laat het frequente pad met rust.

---

## Componenten

### 1. Data — kolom `edge_days`

`dashboard_schedules` krijgt kolom `edge_days TEXT DEFAULT NULL` (JSON-array weekdagen `[0-6]`, 0=zondag, zelfde formaat als `weekdays`).

- `NULL` = **huidig gedrag**: geen server-gestuurde randmaai. Bestaande schema's veranderen niet; geen migratie-verrassing.
- `[]` = expliciet nooit randmaaien.
- `[5]` = randmaaien alleen op vrijdag (mits vrijdag ook een maaidag is).

De set is bedoeld als **subset** van de maaidagen: randmaaien gebeurt alleen ná een maaibeurt, dus een rand-dag die geen maaidag is doet niets. De UI dwingt de subset af (alleen gekozen maaidagen zijn selecteerbaar).

Migratie via `ALTER TABLE dashboard_schedules ADD COLUMN edge_days TEXT` in een try/catch, exact het bestaande patroon in `database.ts`.

### 2. Repo — `ScheduleRow.edge_days`

`edge_days: string | null` toevoegen aan `ScheduleRow`, plus meenemen in `create()` en `update()`-mappers in `server/src/db/repositories/schedules.ts`.

### 3. REST — `server/src/routes/dashboard.ts`

- GET-mapper (`rowToDto`): `edgeDays: r.edge_days ? JSON.parse(r.edge_days) : null`.
- POST/PUT-body: `edgeDays?: number[] | null` → opgeslagen als `edge_days: body.edgeDays != null ? JSON.stringify(body.edgeDays) : null`.

### 4. Server-trigger — randmaai na de maaibeurt

**Nieuwe functie** `startEdgeCut(sn, bladeHeightMm)` in `mowingService.ts`: stuurt `{ start_edge_cut: { mapName, bladeHeight } }` via `publishToDevice` (dezelfde payload die de app stuurt; `extended_commands.py` clamt 20..90 mm server-side op de maaier). `mapName` = de actieve/geselecteerde work-map (`map0` als default, zoals de app).

**Trigger in `scheduleRunner.ts`:** wanneer een schema wordt getriggerd waarvan `edge_days` de dag van vandaag bevat, wordt een in-memory `pendingEdge` per SN geregistreerd (`{ sn, bladeHeightMm, armedAt }`). Een waker (in de bestaande 30s-`checkSchedules`-tick) detecteert de overgang van "was aan het maaien" naar "gedockt/idle" voor die SN en vuurt dan éénmalig `startEdgeCut`, waarna `pendingEdge` wordt gewist. Guard: `pendingEdge` vervalt na een timeout (bv. 3 uur) zodat een mislukte of afgebroken maaibeurt nooit uren later een losse randsessie triggert.

Mow-completion-detectie gebruikt de bestaande sensor-cache (`work_status` / `battery_state = CHARGING` / `msg`), zelfde signalen als `deriveMowerActivity`. Alleen een start via dit schema (niet een handmatige start) zet `pendingEdge`.

### 5. Firmware — `research/build_custom_firmware.sh`

Sectie "Edge-cut default off" toevoegen: patch de 4 bytes in `robot_decision` (`compound_decision/lib/compound_decision/robot_decision`). Vóór het patchen verifiëren dat de patch-offset klopt (verwacht byte-patroon `e3 bb 02 39` op de file-offset die overeenkomt met VMA `0x921a8`) zodat een toekomstige firmware-revisie met verschoven code niet stil de verkeerde bytes overschrijft — bij mismatch faalt de build hard.

### 6. UI — `dashboard/src/components/schedule/Scheduler.tsx`

Onder de bestaande maaidag-knoppenrij een tweede, kleinere rij "Randmaaien op": alleen de gekozen maaidagen zijn selecteerbaar. Leeg/niet-getoond → `edgeDays: null` (huidig gedrag). Form-state `edgeDays: number[] | null`, meegestuurd in create/update. Kiest de gebruiker geen enkele rand-dag terwijl de rij zichtbaar is → `[]` (expliciet nooit).

### 7. i18n

Nieuwe keys (`schedule.edgeDays.*`) in `en/nl/de/fr.json`.

---

## Scope-afbakening

**Binnen scope:** dashboard-schema's (`dashboard_schedules`) via de scheduleRunner.

**Buiten scope (bewust):**
- Handmatige starts (app + dashboard-knop) houden het huidige gedrag — met de firmware-patch betekent dat: geen automatische randmaai meer bij een handmatige start. Wie handmatig wil randmaaien gebruikt de bestaande "Randmaaien"-knop.
- App-interne schema's (`cut_grass_plans`) en de app-schema-UI blijven ongemoeid.
- De randmaai combineren in dezelfde maaitaak (één undock/dock i.p.v. twee) — dat zou een runtime-configureerbare `include_edge` vergen (complexe binary-injectie i.p.v. een 4-byte NOP); niet nu.

---

## Open verificatiepunten (Fase 0 van het plan, go/no-go)

1. **`start_edge_cut` vanaf het dock.** De app triggert `start_edge_cut` vanuit een niet-gedockte toestand. Verifiëren dat de maaier vanuit gedockt zelf uitrijdt en de rand maait. Zo niet: eerst een korte undock/`quit_pile` sturen, of het ontwerp herzien naar het onderbreek-alternatief.
2. **VMA = file-offset.** Bevestigen dat VMA `0x921a8` overeenkomt met de ELF-file-offset vóór het patchen (standaard bij deze PIE-layout, maar checken). De build-patch doet dit met een byte-patroon-assertie.
3. **Multi-zone randmaai** (informatief, raakt de gekozen richting niet): weten of `start_edge_cut` bij een multi-zone-tuin alle zones randmaait of één map. Zo niet, per zone een `start_edge_cut`. Te bepalen bij de eerste multi-zone-rand-dag.

---

## Bekende consequenties

- Op rand-dagen: twee werkrecords (maaien + randmaaien) en één extra dock-cyclus.
- Alleen actief op maaiers met de custom firmware (de patch). Stock-firmware-maaiers houden randmaai-elke-beurt; de `edge_days`-UI heeft dan geen effect — te documenteren.
- Volledig terug te draaien: `edge_days = NULL` op alle schema's + stock firmware = exact het oude gedrag.
