# BoundaryFollow "No valid boundary find!!!!" — exacte voorwaarde (binary-analyse)

**Datum:** 2026-07-23
**Binary's:** firmware v6.0.2, ARM64, niet gestript
- `research/firmware/mower_firmware_v6.0.2/install/coverage_planner/lib/libcoverage_planner_ros2.so` (bevat de planner + WARN-string)
- `research/firmware/mower_firmware_v6.0.2/install/coverage_planner/lib/coverage_planner/coverage_planner_server` (action server, bevat result-string "No valid boundary need robot!!!")

Bronbestand (uit rcutils-locatiestrings in .rodata): `/root/novabot/src/coverage_planner/src/boundary_follow_planner.cpp`
- regel 86: "Map is empty or too small!!!!"
- regel 90: **"No valid boundary find!!!!"**
- regel 101: "No valid contour find!!!!"
- regel 170: "Need to reverse contour !!!"

---

## 1. Het criterium (kort)

**"No valid boundary find!!!!" wordt gelogd precies wanneer `inTaskCurrentPositionOK()` false teruggeeft.** Die functie doet niets anders dan:

```cpp
// gereconstrueerd uit 0x183620, libcoverage_planner_ros2.so
bool BoundaryFollowPlanner::inTaskCurrentPositionOK(const cv::Mat& map,
                                                    const StatusGridPos& pos) const {
    int r = this->win_radius_;                     // member this+0x8 = 16 (cellen)
    cv::Rect roi(pos.x - r, pos.y - r, 2*r + 1, 2*r + 1);   // 33x33 venster
    return cv::countNonZero(cv::Mat(map, roi)) != 0;
}
```

De `map` is hier de local costmap, omgezet door `OccupancyGridToImageMap()` (0x1e3bd0) met deze harde regel per cel:

```cpp
pixel = (occupancy_value > 99) ? 255 : 0;   // cmp w2,#0x63 ; alleen 100 telt
```

Dus: **-1 (unknown), 0 (vrij) én 1..99 (inflation, inclusief 99 inscribed) worden allemaal 0. Alleen kale LETHAL (occupancy == 100) wordt 255.** Geen semantic-categorie, geen kostendrempel, puur waarde 100.

**Praktisch criterium: er moet minimaal 1 cel met occupancy == 100 liggen binnen een venster van 33x33 cellen (±16 cellen, Chebyshev-afstand) gecentreerd op de robotcel.** Bij de live gemeten local costmap-resolutie van 0,1 m/cel is dat **±1,6 m**. Robot op 2-3 m van de rand ⇒ geen lethal cel in het venster ⇒ WARN ⇒ na 3 s PLANNING_FAILED. Dit verklaart de live meting exact (730 lethal cellen aanwezig maar allemaal buiten 1,6 m).

Er is **geen** contourlengte-eis, geen minimum-celaantal, geen work-status-check en geen kaartvereiste in dit pad. De enige andere gate ervoor is de afmeting van de grid zelf.

---

## 2. Volledige beslisketen in `BoundaryFollowPlanner::makePlan` (0x1863f8)

Signature: `makePlan(const cv::Mat& map, int inflation_cells, const StatusGridPos& start, std::vector<StatusGridPos>* out)`

| Stap | Adres | Check / actie | Bij falen |
|------|-------|---------------|-----------|
| 1 | 0x186434-0x1865dc | `map.data != null`, `total() > 0`, `rows > 19` én `cols > 19` (cmp #0x13) | WARN "Map is empty or too small!!!!" (regel 86), return false |
| 2 | 0x1865ec | `inTaskCurrentPositionOK(map, start)` | **WARN "No valid boundary find!!!!"** (regel 90, string 0x353e40, xref 0x186a68), return false |
| 3 | 0x1867b4 | `preprocessMap(map, 2*inflation_cells+1, 2, &processed)`: `cv::threshold(...,30,255,THRESH_BINARY)` + `morphologyEx(MORPH_DILATE, rect-kernel (2n+1)x(2n+1), 1 iteratie)`; zie sectie "Vervolg: preprocessMap-morfologie" | n.v.t. |
| 4 | 0x186824 | `cv::findContours(processed, contours, hierarchy, mode=3, method=2)` | contours leeg → WARN "No valid contour find!!!!" (regel 101, 0x186ee0-pad), return false |
| 5 | 0x186858-0x1868fc | Per contour: min over alle segmenten van `pointToLineMinGridDis(seg, robotcel)`; kies contour met kleinste minimum (init-constanten 1e7f / 1e9f). **Geen afstandsdrempel**, dichtstbijzijnde wint altijd | n.v.t. |
| 6 | 0x186954 | `cv::approxPolyDP(bestContour, poly, epsilon=1.2, closed=true)` | poly leeg → zelfde "No valid contour find!!!!" (0x186b98-pad) |
| 7 | 0x186964-0x186a30 | Polygon omkeren (in-place reverse), dichtstbijzijnd segment zoeken (init 1e4f), pad opbouwen; evt. "Need to reverse contour !!!" (regel 170) | — |
| 8 | 0x186ec4 | `moreCloseBoundary(...)` op het resultaatpad | — |

---

## 3. Waar komt venster-radius 16 vandaan?

`CoverageServer::CoverageServer()` (server-binary, call op 0x594e4) construeert:

```cpp
BoundaryFollowPlannerRos2Adapter(1.5, 0.4, 0.8, 0.05);
// literal pool: 0x1581b8=0.4, 0x158140=0.8, 0x1581a0=0.05, fmov d0=#1.5
```

De adapter-ctor (0x1e3d28) deelt de eerste drie door de vierde (nominale resolutie 0,05 m) en maakt:

```cpp
BoundaryFollowPlanner((int)(1.5/0.05),   // this+0x0 = 30 cellen  → gebruikt in getNearestPosNearObstacle (zoekradius)
                      (int)(0.4/0.05),   // this+0x4 =  8 cellen  → gebruikt in initialStartPosOK (zelfde venstertruc, 17x17)
                      (int)(0.8/0.05));  // this+0x8 = 16 cellen  → venster inTaskCurrentPositionOK (33x33)
```

**Let op de bug/nuance:** de 0,05 is hardcoded in de server. De bedoelde straal was dus 0,8 m, maar het venster is 16 *cellen* ongeacht de echte gridresolutie. Bij een local costmap van 0,1 m/cel wordt de effectieve straal 1,6 m (ruimer dan bedoeld, maar nog steeds de harde grens die wij live zagen).

`initialStartPosOK` (0x183998) doet exact dezelfde countNonZero-venstercheck maar met member +0x4 (8 cellen, dus 17x17 venster, nominaal 0,4 m). Dit is de strengere variant voor de SEARCHING_START/mapping-flow. `inTaskCurrentPositionOK` (16 cellen) is degene in het makePlan/volg-pad.

---

## 4. Call-keten van action-goal tot WARN

1. **Goal accept** → `CoverageServer::readyForBoundaryFollowTask()` (0x4d100): cancelt lopende FollowPath-goals en zet `this+0xec8 = max(goal.inflation_radius, 0.2)` (default 0.2 uit rodata 0x158138). Het goal-veld `inflation_radius` (float32, offset 8 in BoundaryFollow_Goal) mag dus meegegeven worden maar wordt geklemd op minimaal 0,2 m.
2. **Tick-loop** → `CoverageServer::noCoverBoundaryFollowDeal()` (0x67ae0):
   - throttle: nieuwe poging pas als er ≥ 0,8 s (rodata 0x158140) verstreken is sinds de vorige;
   - `checkAndGetLocalPose()` → `updateLocalCostMap()`;
   - `generateLocalBoundaryPlan(this->0xec8, &path)` (0x678b8);
   - bij falen: als verstreken tijd sinds start > **3,0 s** (fmov d0,#3.0 op 0x67cc4) → opgeven, plus een retry-teller op this+0xdf0 (max 2). Dit verklaart de ~2,5-3 s tot abort die live is gemeten.
3. `generateLocalBoundaryPlan` → `BoundaryFollowPlannerRos2Adapter::makePlan(pose, dist, grid, path)` (0x1e3e88):
   - **frame-check**: `pose.header.frame_id` moet byte-gelijk zijn aan `grid.header.frame_id` (memcmp op 0x1e3f28), anders faalt hij vóór alles;
   - `inflation_cells = (int)(dist / grid.info.resolution)` (0x1e3f50); bij default: 0,2/0,1 = 2;
   - `OccupancyGridToImageMap` (255 alleen bij occupancy==100, beeld verticaal gespiegeld);
   - `worldToTopLeftOriginMap(pose.x, pose.y)` → robotcel; buiten de grid → WARN + false;
   - `planner->makePlan(img, inflation_cells, robotcel, &gridpad)`.
4. Falen van makePlan bubbelt terug; na de 3 s-timeout stuurt de server result `status: 1` (= `NO_VALID_BOUNDARY` uit BoundaryFollow.action: `uint8 NO_VALID_BOUNDARY=1`) met msg "No valid boundary need robot!!!" (string 0x138ee0 in server-binary).

---

## 5. Wat betekent dit praktisch voor de startpositie

- **Zet de robot binnen ±16 costmap-cellen (Chebyshev) van een cel die in de local costmap letterlijk waarde 100 heeft.** Bij 0,1 m resolutie: binnen een blok van 3,3 x 3,3 m gecentreerd op de robot moet minstens één lethal cel liggen, oftewel maximaal ~1,6 m van de dichtstbijzijnde lethal cel (hoek-afstand telt ook, het is een vierkant venster, geen cirkel).
- **Inflation telt niet mee.** Ook al staat de robot midden in de inflatiezone (kosten 1..99), dat is voor deze check onzichtbaar. Alleen de kale lethal kern (100) telt.
- De **frame_id van de gepubliceerde robotpose en de local costmap moeten identiek zijn**, anders faalt de adapter al eerder (zonder de "No valid boundary"-WARN).
- De local costmap moet minstens 20x20 cellen zijn (triviaal waar bij 80x80).
- Verder is er niets: geen werkstatus, geen kaartbestand, geen contour-minimumlengte. Zodra één lethal cel in het venster ligt, pakt de planner altijd de dichtstbijzijnde contour (ongeacht afstand) en maakt hij een pad.
- Wil je de rand-volging vanaf een grotere afstand starten, dan zijn de opties: de robot eerst binnen 1,6 m van een obstakel/rand navigeren, of zorgen dat er binnen het venster lethal cellen in de costmap staan (bijv. door de saved-polygon als lethal in de local costmap te injecteren, zoals in het edge-cut-onderzoek al geconcludeerd).
- Het goal-veld `inflation_radius` verandert NIET het zoekvenster (dat is hardcoded 16 cellen); het stuurt alleen de morfologie-kernel in `preprocessMap` (kernel = 2*(inflation/resolutie)+1) en daarmee hoe strak het gevolgde pad om de obstakelcontour ligt.

## Vervolg: preprocessMap-morfologie (2026-07-23, hypothese opgelost)

Vraag uit de live meting (lethal band op ~1,15 m, cellen vervallen binnen seconden): helpt het verhogen van goal-veld `inflation_radius` om de 255-band richting de robot te laten groeien tot binnen de poort van ±16 cellen?

**Antwoord: nee, voor de poort helpt de knop niet.** De poortcheck draait op de rauwe map, vóór preprocessMap.

### Wat preprocessMap exact doet (0x183c98, libcoverage_planner_ros2.so)

Gereconstrueerd, nu volledig gelezen (niet langer hypothese):

```cpp
bool BoundaryFollowPlanner::preprocessMap(const cv::Mat& in, int ksize /*=2n+1*/,
                                          int unused /*=2*/, cv::Mat* out) {
    cv::threshold(in, *out, 30.0, 255.0, cv::THRESH_BINARY);          // 0x183d38; feitelijk no-op, beeld is al 0/255
    cv::Mat k = getStructuringElement(MORPH_RECT, Size(unused, unused));   // 0x183d54; 2x2, wordt direct weggegooid
    k = getStructuringElement(MORPH_RECT, Size(ksize, ksize));             // 0x183d70; (2n+1)x(2n+1)
    cv::morphologyEx(*out, *out, /*op=*/1 /*MORPH_DILATE*/, k,
                     Point(-1,-1), /*iterations=*/1, /*borderType=*/0);    // 0x183ea8
    // DEBUG "Preprocess time cost: %.4f" (regel 65) ; return true (0x184020)
}
```

Bewijs voor de argumentdecodering: deze OpenCV-build geeft `Size_`/`Point_` door via invisible reference (zichtbaar bij beide `getStructuringElement`-calls: Size en anchor staan als stackadressen in x1/x2). Bij de `morphologyEx`-call: x0 = src-InputArray om `*out`, x1 = dst-OutputArray om `*out` (in-place), **w2 = op = 1 = MORPH_DILATE** (MORPH_ERODE=0, DILATE=1, OPEN=2, CLOSE=3), x3 = kernel-InputArray om de (2n+1)x(2n+1) rect-kernel (het 2x2-kerneltje van de eerste call wordt op 0x183dc4-0x183e04 overschreven en gefreed), x4 = &Point(-1,-1), w5 = iterations = 1, w6 = borderType = 0, x7 = &borderValue.

**Dus: cv::dilate met vierkante kernel, 1 iteratie. De 255-band groeit met n cellen in alle richtingen (Chebyshev), met n = (int)(max(goal.inflation_radius, 0.2) / grid.resolution).**

### (a) Ziet de poortcheck de gedilateerde map?

**Nee.** Registerbewijs in `makePlan` (0x1863f8):
- 0x186414: `mov x19, x1` → x19 = de rauwe input-map;
- 0x1865e4/0x1865ec: `inTaskCurrentPositionOK(x19, start)` → poortcheck op de **rauwe** map;
- 0x1867b4 (pas daarna): `preprocessMap(x19, 2n+1, 2, &lokale_Mat)` → dilatatie naar een lokale Mat op sp+0x140;
- 0x186824: `findContours` leest uitsluitend die lokale Mat.

De gedilateerde map voedt dus alleen de contour-extractie (stap 3-8). De poort blijft een 33x33-venster op kale lethal (occupancy==100) cellen. `inflation_radius` verhogen verandert daar niets aan; het schuift wel de gevolgde contour n cellen naar de robot toe zodra de poort eenmaal open is (het pad ligt op de rand van de gedilateerde blob).

### (b) Kernelgrootte bij inflation_radius 0.6

n wordt berekend met de **echte** gridresolutie (adapter 0x1e3f50: `n = (int)(dist / grid.info.resolution)`), niet met de nominale 0,05:
- resolutie 0,05 m: n = 12 → kernel 25x25 → band groeit 0,6 m;
- resolutie 0,10 m (live gemeten local costmap): n = 6 → kernel 13x13 → band groeit 0,6 m.

De groei is in meters dus resolutie-onafhankelijk, maar bereikt de poort niet omdat die vóór de dilatatie zit. Wil je de poort openen dan blijft gelden: echte lethal cellen binnen ±16 cellen van de robot krijgen (robot dichterbij, of lethal injecteren in de local costmap).

## 6. Zekerheid / hypotheses

**Zeker (direct uit assembly gelezen):**
- WARN-conditie = `countNonZero(33x33-venster) == 0`; venster-radius member = 16; drempel occupancy > 99; ctor-doubles 1.5/0.4/0.8/0.05; map-minimum 20x20; approxPolyDP epsilon 1.2; retry-throttle 0.8 s; timeout 3.0 s; default inflation 0.2 m; frame-gelijkheid via memcmp; result-enum NO_VALID_BOUNDARY=1.

**Hypothese (aannemelijk, niet regel-voor-regel geverifieerd):**
- member +0x0 (30 cellen) als zoekradius van `getNearestPosNearObstacle` (de functie laadt this+0, de precieze lus is niet uitgeplozen);
- findContours mode=3/method=2 interpretatie (RETR_TREE / CHAIN_APPROX_SIMPLE).
