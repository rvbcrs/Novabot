# Bronnen — GLB-modellenset (object-recognition-glb, Task 8)

Alle 9 modellen zijn **programmatisch gegenereerd** met
`scripts/normalize-glb.mjs` (three.js primitieven, low-poly, geen textures —
alleen vertex-kleur via `MeshStandardMaterial.color`).

## Waarom geen gedownloade CC0-assets

Eerst geprobeerd volgens de brief-voorkeur (poly.pizza / Kenney / Quaternius,
allemaal CC0):

- **poly.pizza**: zoek-API (`api.poly.pizza`) vereist een API-key
  (`{"error":"You need an API key to do that dingus"}`); de publieke site is
  een client-side SPA zonder statische zoek-HTML — niet betrouwbaar
  scriptbaar zonder browserautomatisering.
- **kenney.nl**: pack-pagina's (`/assets/nature-kit`, `/assets/furniture-kit`)
  renderen de zip-downloadlink client-side; er staat geen `.zip`-href in de
  ruwe HTML-respons.
- Quaternius-packs zijn zips zonder stabiele directe modelbestand-URL's per
  los object (trampoline zit sowieso in geen enkele standaardpack).

Conclusie (conform de expliciete fallback-instructie): "liever 9 nette
programmatische modellen dan een half gedownloade set". Elk model is een
herkenbaar gestileerd low-poly icoon (torus/cilinder/icosahedron/lathe/box),
geen licentierisico, gegarandeerd < 30 KB per stuk.

## Per model

| Bestand | Bron | Opbouw |
|---|---|---|
| `trampoline.glb` | programmatisch | torus-frame + 6 cilinderpoten + zwart matoppervlak |
| `tree.glb` | programmatisch | cilinder-stam + 2 icosahedron-kronen (loofboom-stijl) |
| `bush.glb` | programmatisch | cluster van 4 overlappende icosahedrons |
| `chair.glb` | programmatisch | box-zitting + rugleuning + 4 cilinderpoten |
| `table.glb` | programmatisch | box-tafelblad + 4 cilinderpoten (picknick-stijl) |
| `flowerpot.glb` | programmatisch | tapse cilinder (pot) + rand + stelen + icosahedron-loof |
| `barrel.glb` | programmatisch | LatheGeometry (tonprofiel) + 2 metalen hoepels (torus) |
| `parasol.glb` | programmatisch | cilinder-paal + conisch dak + kruisvoet |
| `playset.glb` | programmatisch | 2 A-frames + bovenbalk + 2 hangende schommels |

## Normalisatie-contract

Elk model is (via `scripts/normalize-glb.mjs`) getransformeerd naar een
Z-up unit-bbox: X ∈ [-0.5, 0.5], Y ∈ [-0.5, 0.5] (gecentreerd op de
oorsprong), Z ∈ [0, 1] (voet op z=0, top op z=1). De viewers (Task 9/10)
schalen dit non-uniform met de gemeten cluster-voetafdruk (x,y) en -hoogte
(z) — zie header-comment in `scripts/normalize-glb.mjs` voor de volledige
uitleg en het exacte run-commando.

Regenereren: `node scripts/normalize-glb.mjs` (vanuit repo root; three.js
wordt hergebruikt uit `dashboard/node_modules`).
