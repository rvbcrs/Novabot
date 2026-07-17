# AI-objectherkenning + GLB-weergave voor de 3D-tuinkaart — ontwerp

**Datum:** 2026-07-18
**Status:** ontwerp gepresenteerd; wacht op Ramons spec-review
**Bouwt voort op:** terrain-pipeline (spec 2026-07-17) en object-lagen/live-groei
(spec 2026-07-17-terrain-objects). Beide live sinds 2026-07-17.

## Waarom

Het firmware-segmentatiemodel kent objecten praktisch alleen als "background"
(fase-0-meting: 38% background, ~0% bush/fixed) — het is getraind op
gazon/niet-gazon, fijnere klassen zijn onbruikbaar. Ramon wil objecten
(trampoline, bomen, struiken) herkend en als échte 3D-modellen (.glb) op de
kaart. Gekozen route: RGB-crop per object-cluster + zero-shot classificatie
server-side (optie C uit het gesprek), mét voxel-vangnet.

## Kerninzicht

Wij hoeven GEEN objectdetectie te doen: het 3D-cluster geeft de plaats, de
pose vertelt wanneer de camera ernaar kijkt. Er hoeft alleen een uitsnede
GECLASSIFICEERD te worden — dat kan met een klein zero-shot model op CPU.

## Beslissingen (met Ramon afgestemd)

| Vraag | Keuze |
|---|---|
| Model-plek | **On-demand download** naar het data-volume (Docker-image blijft slank); feature-toggle, standaard aan |
| RGB-foto's | **Bewaren, één beste crop per cluster** (lokaal op de server; tik-op-object toont naam + foto + correctie) |
| Weergave | **Echte .glb-modellen** (gebundelde low-poly CC0-set), automatisch geschaald op cluster-voetafdruk/-hoogte; voxels als vangnet |

## Architectuur

### 1. Fase 0 — RGB-verificatie (op .100)
- Publiceert `/camera/preposition/image` (IMX307 RGB) tijdens het maaien?
  Formaat (Image/CompressedImage), resolutie, rate.
- Testcapture rijdend: is de kwaliteit bruikbaar (bewegingsonscherpte, licht)?

### 2. Maaier-daemon: frame-capture (geen crops op de X3)
- Per sessie max **20 volledige JPEG-frames** (±100 KB/st), alléén op
  momenten dat er object-punten in beeld zijn, elk met pose-stempel.
- Upload mee met de sessie (zelfde levenscyclus/retry als .tgr/.tgo);
  ~2 MB per beurt, verwaarloosbaar op LAN.

### 3. Server: clusteren → croppen → classificeren
- **Clustering**: connected components over aangrenzende object-cellen →
  tabel `terrain_clusters` (id, mower_sn, bbox, hoogteprofiel-samenvatting,
  class, confidence, crop-pad, user_override, updated_at).
- **Beste frame per cluster**: pose het dichtst bij + camera gericht op het
  cluster-centrum; **ruwe crop** via kijkrichting (ruime marge — voor
  classificatie hoeft dit niet pixel-perfect; geen RGB-intrinsics nodig).
- **Classificatie**: SigLIP/MobileCLIP **image-encoder als ONNX op CPU**
  (~100 MB, on-demand gedownload). Tekst-embeddings van de vaste labellijst
  worden VOORAF berekend en als klein JSON meegeleverd — er draait dus geen
  text-encoder in de container. Zero-shot: cosine tegen de lijst.
- Batch-job na de sessie-fold; enkele clusters per beurt = seconden werk.
- API: `GET /api/dashboard/terrain-clusters/:sn` (clusters + klasse +
  confidence + foto-URL), `POST .../override` (correctie).

### 4. Viewers: GLB's met voxel-vangnet
- **Gebundelde CC0 low-poly set** (Kenney/Quaternius-stijl):
  trampoline, boom, struik/haag, tuinstoel, tafel, bloempot/plantenbak,
  speeltoestel. Zelfde set = zelfde labellijst voor het model.
- Plaatsing: geschaald naar cluster-bbox (voetafdruk + hoogte), op het
  terrein gezet. Cluster onder de confidence-drempel of zonder model →
  **blijft voxels** (het model vervangt alleen wat zeker is).
- **Correctie-UI**: tik op object → naam + foto + keuzelijst; override
  wisselt direct het model. Dashboard eerst; app volgt.
- App: GLB via expo-asset + GLTFLoader; metro-config voor `.glb`-assets.

## Verwachtingen (bewust geaccepteerd)
- Zero-shot op rijdende-camera-crops: ~80-90% raak voor duidelijke objecten;
  ambigue begroeiing (struik vs boompje) vaker mis → vangnet + correctie.
- GLB's zijn stilistisch ("een" trampoline, niet jouw exemplaar).
- Foto's blijven lokaal op de eigen server (decentraal model), verlaten die
  nooit.

## Fasering
| Fase | Inhoud |
|---|---|
| 0 | RGB-verificatie + rijdende testcapture (.100) |
| 1 | Daemon frame-capture + upload |
| 2 | Server: clustering + crop + ONNX-classificatie + API |
| 3 | Dashboard: GLB's + correctie-UI |
| 4 | App: GLB's (+ correctie later) |
