# Husqvarna Automower Connect — Map Polygon Alignment Analyse

**Bron:** `com_husqvarna_automowerconnect_v2026.2.1.apk` (jadx decompilatie, maart 2026)

---

## 1. Kaart provider

**Google Maps** met `MAP_TYPE_SATELLITE`.

Bewijs: `com/google/maps/android/compose/` package, `GoogleMapKt.java`, `PolygonKt.java`, `MapType.java`.

---

## 2. Coördinatensysteem

De maaier slaat polygon-vertices op als **lokale x,y in millimeters** (`long`), relatief aan een origin punt.

- `u8/LocalCoordinate.java`: `x: long`, `y: long` — millimeters, oost/noord
- `u8/GlobalPosition.java`: `latitude: double`, `longitude: double` — WGS84 graden

**De maaier slaat NOOIT GPS-coördinaten op voor polygon vertices.** Alleen het origin punt is WGS84.

---

## 3. Referentiestation als Anker

Het **EPOS referentiestation** (laadstation = RTK base station) is het ankerpunt.

GPS positie wordt opgeslagen als `ReferenceStation.InstalledPosition` — een BLE TIF attribuut:

```java
latitude  = attribute("latitude")  / 1_000_000_0.0   // opgeslagen als lat * 1e7
longitude = attribute("longitude") / 1_000_000_0.0   // opgeslagen als lon * 1e7
altitude  = attribute("altitude")  / 1000.0           // opgeslagen als alt * 1000
```

`GetOriginPointUseCase.java` haalt dit origin op via `LocalPositionRepository.getOrigin()`.

---

## 4. Polygon Rendering Pipeline

### Stap 1: Polygon data laden

`LoadMapDataUseCase.java` laadt `EposMapData` (RTK) of `LonaMapData` (LoNa boundary):
- `originPoint: GlobalPosition` — referentiestation GPS positie
- `siteMap: SiteMap` — polygon data met vertices als lokale `(x, y)` mm

### Stap 2: User-adjustable map offset toepassen

`MapUiModelConverter` past de opgeslagen offset toe op ELKE vertex vóór GPS-conversie:

```java
private final Point d(Point point, LocalCoordinate localCoordinate) {
    return new Point(
        point.a() + localCoordinate.getX(),   // x_mm + offset_x_mm
        point.b() + localCoordinate.getY()    // y_mm + offset_y_mm
    );
}
```

Offset opslag:
- `GET/PUT app/v1/mowers/{mowerid}/metadata/mapoffset` → `{x: Long, y: Long}` (mm)
- Joystick widget: **250 mm per druk** (25 cm stappen)

### Stap 3: Lokaal (x,y mm) + origin → WGS84 GPS

Twee methoden, gekozen via `useECEFMethod` flag:

**Methode A — ECEF (nauwkeurig, voor EPOS/RTK kaarten):**

`s8/C5141g.java` (`GetGlobalPositionUsingECEF.kt`):
- WGS84 ellipsoïde: semi-major axis = 6378137.0 m
- Stappen: origin WGS84 → ECEF XYZ → ENU unit vectors → `ECEF_new = ECEF_origin + east*x + north*y` → terug naar WGS84

**Methode B — Equirectangular (snelle benadering, voor LoNa kaarten):**

```java
// MM_TO_LAT_CONSTANT = 1.5696123057604772E-10  (graden per mm bij evenaar)
// = 1.0 / (111_319_488 mm) ≈ graden per mm langs een meridiaan
new GlobalPosition(
    origin.latitude  + (point.y * d10),
    origin.longitude + (point.x * (d10 / Math.cos(Math.toRadians(origin.latitude))))
)
```

**Inverse (tik op kaart → lokaal punt):**

```java
new Point(
    round(((tapLon - refLon) / MM_TO_LAT_CONSTANT) * cos(toRadians(refLat))),
    round( (tapLat - refLat) / MM_TO_LAT_CONSTANT)
)
```

### Stap 4: Tekenen op Google Maps

De `LatLng` lijst gaat naar Google Maps Compose `Polygon` API.

---

## 5. Samenvatting

| Aspect | Husqvarna | Novabot (huidig) |
|--------|-----------|-------------------|
| Kaart provider | Google Maps (satellite) | PDOK luchtfoto / OSM |
| Maaier coördinaten | Lokaal x,y in **millimeters** | Lokaal x,y in **meters** (CSV) |
| Origin/anker | EPOS referentiestation GPS (BLE attribuut) | Charger GPS (auto-saved van maaier) |
| Offset opslag | Backend: `{x, y}` mm per maaier | DB: `map_calibration` (offset_lat/lng in graden) |
| Offset stap | 250 mm (25 cm) per joystick druk | ~0.55m per nudge (NUDGE_STEP) |
| Projectie (RTK) | ECEF 3D math, WGS84 ellipsoïde | UTM zone 32 → WGS84 |
| Projectie (simpel) | Equirectangular: `cos(lat)` correctie | `cos(lat)` correctie (mapConverter.ts) |
| Uitlijning correctie | User-adjustable offset in lokale mm | Anchor offset (charger visual vs GPS) + nudge |

---

## 6. Conclusie voor Novabot

### Waarom Husqvarna het "perfect" kan:

1. **Alles is lokaal**: Polygon vertices zijn mm relatief aan het laadstation — er is geen GPS-meetfout in de vertices zelf
2. **Eén GPS-punt**: Alleen het origin (laadstation) wordt in WGS84 opgeslagen — als dat punt klopt, klopt de hele kaart
3. **User offset**: Een simpele joystick (25cm stappen) om het origin te verschuiven als het satellietbeeld niet perfect matcht

### Wat wij al hebben:

- **Anchor offset systeem** (net geïmplementeerd): vergelijkbaar met Husqvarna's `mapoffset` — verschil tussen visuele en GPS charger positie
- **Nudge controls**: vergelijkbaar met Husqvarna's joystick, maar in GPS-graden i.p.v. mm
- **`mapConverter.ts`**: GPS ↔ lokale meters conversie (equivalent aan hun equirectangular methode)

### Wat we eventueel kunnen verbeteren:

1. **Offset in lokale meters i.p.v. GPS-graden**: Onze nudge (NUDGE_STEP in lat/lng graden) is minder intuïtief dan Husqvarna's mm offset. Beter: offset in meters opslaan, dan converteren.
2. **ECEF projectie**: Voor cm-nauwkeurigheid zou ECEF beter zijn dan equirectangular, maar op tuinschaal (~50m) maakt het <1cm verschil.
3. **Maaier CSV al lokaal**: Onze maaier CSV-bestanden zijn al in lokale meters — we zouden direct die lokale coords kunnen gebruiken (zoals Husqvarna) i.p.v. ze eerst naar GPS te converteren en dan weer terug.
