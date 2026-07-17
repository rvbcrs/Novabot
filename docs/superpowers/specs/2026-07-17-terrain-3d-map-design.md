# 3D-terreinkaart van de tuin (ToF + pose) — ontwerp

**Datum:** 2026-07-17
**Status:** ontwerp goedgekeurd door Ramon (aanpak A)
**Doel:** een 2.5D-hoogtekaart van de tuin, passief opgebouwd tijdens het maaien,
gevisualiseerd als 3D-terrein in het dashboard.

## Beslissingen (met Ramon afgestemd)

| Vraag | Keuze |
|---|---|
| Primair doel | Visualisatie in dashboard/app (geen navigatie-input, geen meetinstrument) |
| Capture | Passief tijdens elke maaibeurt (geen aparte scan-run) |
| Vorm | 2.5D-heightmap-terrein (geen volledige point cloud) |
| Kleur | Hoogte-shading eerst; echte RGB-projectie is een latere upgrade |
| Viewer | Dashboard eerst (three.js); app later eventueel |
| Architectuur | **A: grid-accumulator op de maaier**, merge op de server |

Afgevallen alternatieven: (B) ruwe point-cloud-uploads met server-fusie — te
zwaar voor X3-disk/CPU en netwerk voor wat een heightmap nodig heeft; (C) live
streamen — fragiel, realtime is nergens voor nodig.

## Hardware / bestaande feiten

- ToF-camera: PMD Royale IRS2875C. ROS2-topics: `/camera/tof/point_cloud`
  (PointCloud2), `/camera/tof/depth_image`, `/camera/tof/gray_image`.
  Camera aan/uit: service `/camera/tof/start_camera`.
- RGB↔ToF extrinsics staan op de maaier (`preposition_tof_extrinsic.json`) —
  pas relevant bij de latere RGB-upgrade.
- Pose: `robot_combination_localization` fuseert GPS/RTK + ArUco + odometrie →
  2D-pose (x, y, orientation) in het kaartframe (charger ≈ origin).
  Exacte topicnaam wordt in fase 0 geverifieerd.
- Perceptie gebruikt de ToF al voor obstakels tijdens het maaien (costmap
  obstacle_max_range 1.49 m), dus de camera draait tijdens een maaibeurt.

## Componenten

### 1. Maaier: `research/terrain_scan.py` (capture-daemon)

Sidecar-proces naast `extended_commands.py`. Lokaal in `research/`,
gedeployed via `build_custom_firmware.sh` + scp (mower-scripts local-first),
gestart via een ROS-env-wrapper (nooit kaal `python3` — RtkRelay-les).

- Abonneert op `/camera/tof/point_cloud` + het pose-topic.
- Verwerkt max ~2 frames/s. Per frame: punten filteren op bereik
  (0,3–1,5 m), transformeren via vaste camera-montage (hoogte + kanteling,
  eenmalig gekalibreerd in fase 0) naar het maaier-frame, dan via de
  2D-pose (x, y, θ) naar het kaartframe.
- Accumuleert in een in-memory grid van **5 cm-cellen**: per cel gemiddelde
  hoogte + sample-count, met outlier-afwijzing. Harde cap op het aantal
  cellen (geheugen-plafond; de X3 heeft een OOM-geschiedenis).
- Alleen actief tijdens een taak (work_status = maaien); gedockt idle.
- Bij taakeinde: sessie-grid (orde 100 KB) naar
  `/userdata/lfi/terrain/session_<ts>` op disk, HTTP-POST naar de server
  (zelfde stijl als map-uploads), lokaal verwijderen na ack. Maximaal 5
  sessiebestanden bewaren als de server onbereikbaar is (oudste eerst weg).

### 2. Server: upload + merge

- Cloud-api endpoint voor de sessie-upload (mower → server).
- Opslag: grid-blobs op disk in de data-dir; metadata in nieuwe tabel
  `terrain_grids` (mower_sn, bounds, cell_size, sessie-info, updated_at).
- Merge: per cel **mediaan over sessies** (dempt hellings-/ruisfouten),
  sample-counts opgeteld. Het persistente terrein verbetert elke beurt.
- `GET /api/dashboard/terrain/:sn` → gemergd grid als gzip-binary voor de
  viewer.

### 3. Dashboard: 3D-viewer

- Nieuw paneel, **lazy-loaded** (three.js komt niet in de hoofdbundle).
- Heightmap-mesh uit het grid, hoogte-shading (topografische colormap).
- Bestaande werk-/obstakel-polygonen als lijnen over het terrein
  geprojecteerd voor oriëntatie. Orbit-controls.

## Fase 0 — verificatie vóór de bouw (op .100, via SSH)

1. Publiceert `/camera/tof/point_cloud` tijdens het maaien, en op welke Hz?
2. Exacte pose-topicnaam + frame-conventie (komt dit overeen met het
   kaartframe dat de server kent?).
3. Enkele ruwe frames vangen op vlakke grond → camera-montagehoogte en
   -kanteling kalibreren (eenmalige constanten in de daemon).
4. CPU/RAM-impact meten van een proef-subscriber tijdens het maaien;
   kill-switch bepalen.

Pas als 1–4 kloppen wordt de daemon gebouwd.

## Risico's / beperkingen (bewust geaccepteerd)

- **2D-pose zonder pitch/roll**: hoogte vertekent op hellingen. Mediaan
  over sessies dempt dit. Het is een visualisatie, geen waterpas.
- **Korte ToF-range (~1,5 m), vooruit-omlaag**: dekking volgt het
  maaipatroon; de kaart is pas gevuld na meerdere beurten. Feature, geen bug.
- **OTA wist het script**: meebakken in `build_custom_firmware.sh`, zelfde
  mechaniek als extended_commands en de night-docking-patch.
- Ruwe data wordt weggegooid (grid-accumulatie): andere fusie later =
  opnieuw verzamelen. Geaccepteerd voor de kleine uploads.

## Latere upgrades (expliciet buiten scope v1)

RGB-kleurprojectie via de extrinsics; viewer in de app; losse
object-clusters (hybride weergave); export (glTF).

## Fasering

| Fase | Inhoud |
|---|---|
| 0 | Verificatie + kalibratie op .100 (geen productcode) |
| 1 | terrain_scan.py + upload-endpoint + serveropslag/merge |
| 2 | Dashboard 3D-viewer |
| later | RGB, app, objecten |
