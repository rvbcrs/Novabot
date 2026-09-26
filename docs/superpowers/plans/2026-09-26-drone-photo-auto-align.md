# Dronefoto automatisch uitlijnen: implementatieplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** na een ruwe plaatsing van een dronefoto stelt de server een plaatsing voor die op de luchtfoto is uitgelijnd (PDOK 2025 in Nederland, Esri/USGS elders, met veilige afwijzing), die de gebruiker bevestigt. Dockpins bewegen mee met de foto.

**Architecture:** een gedeelde luchtfotomodule (`aerialTiles.ts`) levert een georeferentiebeeld met geldigheidsmasker. Een pure pijplijn (`droneAlign/alignPipeline.ts` met `alignGeometry.ts` en `alignImage.ts`) rendert de foto op twee resoluties, laat een matcher overeenkomsten zoeken, en past RANSAC plus Tukey-IRLS toe voor een similariteit. De matcher is DISK+LightGlue in onnxruntime-node, in een apart proces (`worker.ts`), aangestuurd door een jobservice (`droneAlign/index.ts`) met geheugenbewaking en een slot tegen de terreinherkenning. Routes in `droneOverlay.ts` en het plaatspaneel in `MowerMap.tsx` ronden het af.

**Tech Stack:** Node 20 / TypeScript (ESM, Express, better-sqlite3, sharp 0.35, onnxruntime-node 1.24.3, vitest + supertest) in `server/`; React + react-leaflet + i18next in `dashboard/`.

**Spec:** `docs/superpowers/specs/2026-09-25-drone-photo-auto-align-design.md`. Lees die eerst; dit plan verwijst ernaar voor het waarom.

## Global Constraints

- Werk alleen in de worktree `.worktrees/drone-auto-align` op branch `feat/drone-auto-align`. De hoofdmap is van een andere sessie; niets daar aanraken. `server/node_modules` en `dashboard/node_modules` zijn symlinks naar de hoofdmap: **nooit** `npm install` zonder `--package-lock-only` draaien.
- onnxruntime-node **exact `1.24.3`** (dezelfde versie die `@huggingface/transformers` vastpint); nooit een tweede kopie.
- Matcher: `disk_lightglue_pipeline.ort.onnx`, URL `https://github.com/fabio-sim/LightGlue-ONNX/releases/download/v2.0/disk_lightglue_pipeline.ort.onnx`, grootte `50161858` bytes, sha256 `20b35e9d3c4e505ae718f25fc4a95a5ec666c001f18308e600a93d158b43b5a8`. Download bij eerste gebruik naar `STORAGE_PATH/models/`; tests downloaden **nooit** een model.
- Sessie-opties: `intraOpNumThreads: 1`, `interOpNumThreads: 1`, `enableCpuMemArena: false`, `executionMode: 'sequential'`. Het model draait alleen in een `child_process.fork` met `serialization: 'advanced'`.
- Pijplijnknoppen, exact: `coarseMPerPx 0.15`, `fineMPerPx 0.075`, `tile 384`, `overlap 64`, `coarseThrM 0.5`, `fineThrM 0.25`, `erodeM 1.0`, zoekmarge `12` m.
- Afwijzingsregels, exact: grof ≥ `30` overeenkomsten en bedekking ≥ `0.3`; fijn ≥ `100` en bedekking ≥ `0.35`; schaal `0.85..1.15`; draaiing ≤ `12`°; verschuiving ≤ `12` m.
- Omgeving: `DRONE_ALIGN=0` schakelt uit; `DRONE_ALIGN_MIN_FREE_MB` standaard `900`; `DRONE_ALIGN_TIMEOUT_MS` standaard `600000`; `PDOK_ALIGN_LAYER` standaard `2025_orthoHR`.
- De uitlijning gebruikt Esri tot z20; de 3D-render houdt zijn huidige bronnen (PDOK `Actueel_orthoHR`, Esri tot z19).
- Uitlijncode schrijft **nooit** `maps.map_area` en publiceert **nooit** via MQTT. Alleen `device_settings` (`drone_overlay`) en, bij bevestigen met `pinsFollow`, `map_calibration.charger_lat/lng` via `mapRepo.setCalibration` (merge).
- `pinsFollow` wordt geweigerd (409) zolang `posJsonRequested(sn)` waar is voor een van de betrokken maaiers.
- Nieuwe servertekst (`T\`...\``) krijgt een entry in `server/src/services/apiText.catalog.ts` (nl-sleutel, en/fr/de), anders faalt `serverText.coverage.test.ts`.
- Dashboardteksten in `nl.json`, `en.json`, `de.json`, `fr.json` onder `map.*`. Geen `window.alert`/`confirm`.
- Commit-berichten in het Engels, **zonder** Co-Authored-By of andere AI-attributie. Geen `./release-beta.sh` zonder expliciete vraag van de gebruiker.
- Dashboard type-check: `cd dashboard && npx tsc -p tsconfig.app.json --noEmit` (de root-tsconfig checkt niets). Server: `cd server && npx tsc --noEmit` en `npx vitest run`.

## Rulings ten opzichte van de spec

1. **Voortgang via polling, niet via Socket.io.** Het paneel vraagt `GET /overlay/:sn/align` elke seconde. Het is één job per server, en polling scheelt een socket-event en de bijbehorende state. Kost als het fout is: 1 request per seconde tijdens een uitlijning.
2. **Geen pin-snapshots in de history.** "Vorige plaatsing" slaat op met `pinsFollow`, zodat de pins de foto terug volgen naar hun vorige plek. Dat is hetzelfde resultaat, zonder extra velden. Kost als het fout is: een pin die tussendoor met de hand is verplaatst, volgt de foto terug in plaats van terug te springen.
3. **Gedeelde foto's herkennen via identieke afmetingen, bestandsgrootte en hoeken, zonder `sharedWith`-veld.** `copy-from` kopieert die precies. Kost als het fout is: twee maaiers die toevallig dezelfde foto los uploaden en exact gelijk plaatsen, worden als gedeeld behandeld. Dat is ook wat je dan wilt.
4. **De luchtfoto-uitsnede wordt niet bewaard** (`<sn>.aerial.jpg`). Niets leest hem; de blijvende controle is geometrisch. Kost als het fout is: later geen offline uitleg van een oude uitlijning.
5. **`pinsFollow` bij elke opslag vanuit het plaatspaneel,** niet alleen na een voorstel. De pin hoort bij de foto; een handmatige correctie van de foto moet de pin ook meenemen. Kost als het fout is: wie de foto met de hand op de zones legt, ziet de zones meeschuiven. Dat is precies de oude, foute werkwijze die de spec afschaft.
6. **Smoke-test alleen op de host-architectuur** (arm64 op de Mac), wel met een echte `InferenceSession`. Een amd64-smoke vraagt een tweede build onder emulatie. Kost als het fout is: een amd64-specifieke onnxruntime-fout valt pas op de server op.
7. **De afwijzingsregels worden getest met synthetische uitkomsten,** niet met vastgelegde overeenkomsten uit de proef. De proefdata staan in een scratchpad buiten de repo en horen daar niet in. De echte toets is Task 12 stap 2 plus de release-gates. Kost als het fout is: een drempel die op echte data verkeerd uitvalt, wordt pas daar zichtbaar.

## Review Focus

1. **Foto deels buiten de dekking of lege tegels** (PDOK wit over de grens, Esri-placeholder): terugvallen op de volgende bron of een reden, nooit een crash. Tests in Task 2 (`fetchAerial` valt van lege PDOK terug op Esri) en Task 8 (`fetchAerial` → `null` geeft `rejected` met `no_aerial`).
2. **Heel grote upload** (50 MB, 8000 px): decoderen met een resize, geheugen begrensd. Test in Task 4 (`decodeScaled` van 6000×4000 levert ≤ `maxSide`).
3. **Gedeelde foto met één pin buiten de foto:** alleen pins binnen de foto bewegen, de plaatsing van de andere maaier volgt wel. Test in Task 9.
4. **Twee keer klikken, annuleren, andere maaier tegelijk:** één job, idempotent per maaier, 409 voor een tweede maaier, slot altijd vrijgegeven. Tests in Task 8.
5. **Ruwe start ver buiten bereik** (bijv. 90° gedraaid): de afwijzingsregels geven `implausible`, nooit een wild voorstel. Test in Task 5.

---

### Task 1: Eén zware modeltaak tegelijk, en de echte geheugenruimte van de container

**Files:**
- Create: `server/src/services/heavyWork.ts`
- Modify: `server/src/services/terrainClassifier.ts` (`initClassifier` weigert tijdens een uitlijning; nieuw `isClassifierLoaded()`)
- Test: `server/src/__tests__/services/heavyWork.test.ts`

**Interfaces:**
- Produces: `tryAcquireHeavy(name: string): boolean`, `releaseHeavy(name: string): void`, `heavyHolder(): string | null`, `containerHeadroomMb(read?: (path: string) => string | null): number | null`; in terrainClassifier: `isClassifierLoaded(): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/services/heavyWork.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { tryAcquireHeavy, releaseHeavy, heavyHolder, containerHeadroomMb } from '../../services/heavyWork.js';
import { initClassifier, isClassifierLoaded, _setPipelineForTest } from '../../services/terrainClassifier.js';

afterEach(() => { releaseHeavy('drone-align'); releaseHeavy('other'); _setPipelineForTest(null); });

describe('heavy work lock', () => {
  it('lets one job hold it and refuses a second', () => {
    expect(tryAcquireHeavy('drone-align')).toBe(true);
    expect(tryAcquireHeavy('drone-align')).toBe(true);   // re-entrant for the holder
    expect(tryAcquireHeavy('other')).toBe(false);
    expect(heavyHolder()).toBe('drone-align');
    releaseHeavy('other');                                  // not the holder: no effect
    expect(heavyHolder()).toBe('drone-align');
    releaseHeavy('drone-align');
    expect(heavyHolder()).toBeNull();
  });
});

describe('containerHeadroomMb', () => {
  const files = (m: Record<string, string>) => (p: string) => m[p] ?? null;
  const meminfo = 'MemTotal: 4000000 kB\nMemAvailable:    2621440 kB\n';   // 2560 MB

  it('takes the cgroup v2 headroom when it is smaller than the host', () => {
    const read = files({ '/proc/meminfo': meminfo, '/sys/fs/cgroup/memory.max': '2147483648\n', '/sys/fs/cgroup/memory.current': '1610612736\n' });
    expect(containerHeadroomMb(read)).toBe(512);
  });
  it('ignores an unlimited cgroup v2 and uses the host', () => {
    const read = files({ '/proc/meminfo': meminfo, '/sys/fs/cgroup/memory.max': 'max\n', '/sys/fs/cgroup/memory.current': '100\n' });
    expect(containerHeadroomMb(read)).toBe(2560);
  });
  it('reads cgroup v1 and ignores its "unlimited" huge number', () => {
    const v1 = files({ '/proc/meminfo': meminfo, '/sys/fs/cgroup/memory/memory.limit_in_bytes': '1073741824', '/sys/fs/cgroup/memory/memory.usage_in_bytes': '536870912' });
    expect(containerHeadroomMb(v1)).toBe(512);
    const unlimited = files({ '/proc/meminfo': meminfo, '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712', '/sys/fs/cgroup/memory/memory.usage_in_bytes': '1' });
    expect(containerHeadroomMb(unlimited)).toBe(2560);
  });
  it('is null when nothing is known', () => {
    expect(containerHeadroomMb(() => null)).toBeNull();
  });
});

describe('terrain classifier and the lock', () => {
  it('does not load while a drone alignment holds the lock', async () => {
    expect(tryAcquireHeavy('drone-align')).toBe(true);
    expect(await initClassifier()).toBe(false);          // must not start a model download
    expect(isClassifierLoaded()).toBe(false);
  });
  it('reports a loaded model', () => {
    _setPipelineForTest(async () => []);
    expect(isClassifierLoaded()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/services/heavyWork.test.ts`
Expected: FAIL with "Failed to resolve import ../../services/heavyWork.js" (module does not exist).

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/heavyWork.ts
/**
 * Heavy on-device model work: the terrain classifier and the drone photo
 * alignment. Only one at a time: two models in a 2 GiB container is how the
 * server got killed before (2026-09-14), and with it the mowers' broker.
 */
import fs from 'fs';

let holder: string | null = null;

/** Take the lock; true for the current holder too. */
export function tryAcquireHeavy(name: string): boolean {
  if (holder && holder !== name) return false;
  holder = name;
  return true;
}

export function releaseHeavy(name: string): void {
  if (holder === name) holder = null;
}

export function heavyHolder(): string | null {
  return holder;
}

function safeRead(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/**
 * Memory in MB this process can still take: the smaller of the container's
 * cgroup headroom (limit minus usage) and the host's MemAvailable. /proc/meminfo
 * alone shows the host, which can have room while the container sits at its
 * cap, and then the OOM killer takes the whole server down. Null when unknown.
 */
export function containerHeadroomMb(read: (p: string) => string | null = safeRead): number | null {
  const mem = read('/proc/meminfo')?.match(/^MemAvailable:\s+(\d+) kB$/m);
  const host = mem ? Math.floor(Number(mem[1]) / 1024) : null;
  let cgroup: number | null = null;
  const max2 = read('/sys/fs/cgroup/memory.max')?.trim();
  const cur2 = read('/sys/fs/cgroup/memory.current')?.trim();
  if (max2 && cur2 && max2 !== 'max') {
    cgroup = Math.floor((Number(max2) - Number(cur2)) / 1048576);
  } else {
    const max1 = read('/sys/fs/cgroup/memory/memory.limit_in_bytes')?.trim();
    const cur1 = read('/sys/fs/cgroup/memory/memory.usage_in_bytes')?.trim();
    // v1 reports an unlimited cgroup as a number near 2^63.
    if (max1 && cur1 && Number(max1) < 2 ** 60) cgroup = Math.floor((Number(max1) - Number(cur1)) / 1048576);
  }
  const known = [host, cgroup].filter((v): v is number => v !== null && Number.isFinite(v));
  return known.length ? Math.min(...known) : null;
}
```

In `server/src/services/terrainClassifier.ts`, add the import next to the other imports:

```ts
import { heavyHolder } from './heavyWork.js';
```

Add this export directly below the `let inFlight = 0;` line:

```ts
/** True while the model is loaded or loading (a drone alignment waits for it to go). */
export function isClassifierLoaded(): boolean {
  return currentPipeline !== null || loading !== null;
}
```

In `initClassifier()`, directly after the `TERRAIN_CLASSIFY === '0'` check, add:

```ts
  // A drone alignment holds the heavy-work lock: two models at once do not
  // fit a 2 GiB container. Skip this batch; the next session tries again.
  const heavy = heavyHolder();
  if (heavy && heavy !== 'terrain') {
    console.warn(`[terrainClassifier] ${heavy} loopt, model niet geladen, batch wordt overgeslagen`);
    return false;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/services/heavyWork.test.ts src/__tests__/services/terrainClassifier.test.ts`
Expected: PASS (all tests), and the existing terrainClassifier tests still pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/heavyWork.ts server/src/services/terrainClassifier.ts server/src/__tests__/services/heavyWork.test.ts
git commit -m "feat(server): one heavy model job at a time, and the container's real memory headroom"
```

### Task 2: Gedeelde luchtfotomodule met tegelcontrole (ook voor de 3D-render)

**Files:**
- Create: `server/src/services/aerialTiles.ts`
- Modify: `server/src/services/gardenRender.ts` (tegelhulpjes en `stitchAndCrop` uit `aerialTiles`; `aerialBase` probeert bronnen op volgorde en slaat lege tegels over)
- Test: `server/src/__tests__/services/aerialTiles.test.ts`

**Interfaces:**
- Produces:
  - `type SourceKey = 'pdok' | 'usgs' | 'satellite'`; `interface TileSource { key; url; maxZoom; attribution; layer: string | null; bounds? }`
  - `PDOK_ALIGN_LAYER: string`; `tileSources(opts?: { pdokLayer?: string; esriMaxZoom?: number }): Record<SourceKey, TileSource>`; `sourcesFor(lat, lng, opts?): TileSource[]`
  - `lngToTileX(lng, z)`, `latToTileY(lat, z)`, `tileXToLng(x, z)`, `tileYToLat(y, z)`, `groundMPerPx(lat, z)`
  - `isBlankTile(buf: Buffer, etag?: string | null): Promise<boolean>`
  - `type FetchLike`; `fetchTiles(src, z, tiles: {tx,ty}[], opts?): Promise<TileResult[]>` met `TileResult { tx; ty; png: Buffer | null; failed: boolean }`
  - `stitchAndCrop(tiles, canvasW, canvasH, box): Promise<Buffer>` (verhuisd, gardenRender her-exporteert)
  - `interface AerialImage { rgb: Buffer; width; height; valid: Uint8Array; zoom; x0; y0; mPerPx; source: SourceKey; layer: string | null; attribution }`
  - `aerialToPx(img, ll): [number, number]`, `aerialToLatLng(img, x, y): LatLng`
  - `fetchAerial(sw, ne, opts?): Promise<{ image: AerialImage } | { image: null; reason: 'offline' | 'no_imagery' | 'too_large' }>`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/services/aerialTiles.test.ts
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  sourcesFor, lngToTileX, latToTileY, tileXToLng, tileYToLat, groundMPerPx, isBlankTile,
  fetchTiles, fetchAerial, aerialToPx, aerialToLatLng, tileSources, type FetchLike,
} from '../../services/aerialTiles.js';

const white = () => sharp({ create: { width: 256, height: 256, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
const noise = () => sharp({ create: { width: 256, height: 256, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).jpeg().toBuffer();

describe('tile maths', () => {
  it('goes from lat/lng to tile units and back', () => {
    for (const [lat, lng] of [[52.1409, 6.2311], [-33.87, 151.21], [40.71, -74.0]]) {
      const z = 21;
      expect(tileYToLat(latToTileY(lat, z), z)).toBeCloseTo(lat, 9);
      expect(tileXToLng(lngToTileX(lng, z), z)).toBeCloseTo(lng, 9);
    }
    expect(groundMPerPx(52.14, 21)).toBeCloseTo(0.0457, 3);
  });
});

describe('sourcesFor', () => {
  it('orders the regional source first and always ends with Esri', () => {
    expect(sourcesFor(52.14, 6.23).map(s => s.key)).toEqual(['pdok', 'satellite']);
    expect(sourcesFor(40.71, -74.0).map(s => s.key)).toEqual(['usgs', 'satellite']);
    expect(sourcesFor(-33.87, 151.21).map(s => s.key)).toEqual(['satellite']);
  });
  it('uses the requested PDOK year and Esri zoom for alignment, the render defaults otherwise', () => {
    expect(tileSources().pdok.url).toContain('/Actueel_orthoHR/');
    expect(tileSources().satellite.maxZoom).toBe(19);
    const a = tileSources({ pdokLayer: '2025_orthoHR', esriMaxZoom: 20 });
    expect(a.pdok.url).toContain('/2025_orthoHR/');
    expect(a.pdok.layer).toBe('2025_orthoHR');
    expect(a.satellite.maxZoom).toBe(20);
  });
});

describe('isBlankTile', () => {
  it('recognises a uniform tile, the Esri placeholder, and passes real imagery', async () => {
    expect(await isBlankTile(await white())).toBe(true);
    expect(await isBlankTile(await noise())).toBe(false);
    expect(await isBlankTile(await noise(), '"vvvvvvvvvvvvf"')).toBe(true);
    expect(await isBlankTile(Buffer.from('not an image'))).toBe(true);
  });
});

describe('fetchTiles', () => {
  it('marks failures, blanks and timeouts, and keeps real tiles', async () => {
    const real = await noise(); const blank = await white();
    const f: FetchLike = async (url, init) => {
      if (url.endsWith('/1/1')) return new Response(real, { status: 200 });
      if (url.endsWith('/1/2')) return new Response(blank, { status: 200 });
      if (url.endsWith('/1/3')) return new Response('x', { status: 500 });
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    };
    const src = { key: 'satellite' as const, layer: null, url: 'https://t/{z}/{y}/{x}', maxZoom: 20, attribution: '' };
    const r = await fetchTiles(src, 20, [{ tx: 1, ty: 1 }, { tx: 2, ty: 1 }, { tx: 3, ty: 1 }, { tx: 4, ty: 1 }], { fetchImpl: f, timeoutMs: 50, concurrency: 2 });
    expect(r.map(t => [!!t.png, t.failed])).toEqual([[true, false], [false, false], [false, true], [false, true]]);
  });
});

describe('fetchAerial', () => {
  const sw = { lat: 52.1406, lng: 6.2305 }; const ne = { lat: 52.1412, lng: 6.2316 };

  it('falls back from a blank PDOK to Esri and returns a georeferenced image', async () => {
    const real = await noise(); const blank = await white();
    const f: FetchLike = async (url) => new Response(url.includes('pdok') ? blank : real, { status: 200 });
    const r = await fetchAerial(sw, ne, { pdokLayer: '2025_orthoHR', esriMaxZoom: 20, fetchImpl: f });
    expect(r.image).not.toBeNull();
    const img = r.image!;
    expect(img.source).toBe('satellite');
    expect(img.zoom).toBe(20);
    expect(img.rgb.length).toBe(img.width * img.height * 3);
    expect(img.valid.every(v => v === 1)).toBe(true);
    const [x, y] = aerialToPx(img, sw);
    expect(aerialToLatLng(img, x, y).lat).toBeCloseTo(sw.lat, 9);
    // The crop starts on a whole pixel, so the box corner lies within half a pixel of it.
    expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(y - img.height)).toBeLessThanOrEqual(1);
  });

  it('says offline when nothing answers, and no_imagery when every source is blank or broken', async () => {
    const down: FetchLike = async () => { throw new Error('ECONNREFUSED'); };
    expect(await fetchAerial(sw, ne, { fetchImpl: down })).toEqual({ image: null, reason: 'offline' });
    const blank = await white();
    const empty: FetchLike = async (url) => url.includes('pdok') ? new Response(blank, { status: 200 }) : new Response('x', { status: 404 });
    expect(await fetchAerial(sw, ne, { fetchImpl: empty })).toEqual({ image: null, reason: 'no_imagery' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/services/aerialTiles.test.ts`
Expected: FAIL with "Failed to resolve import ../../services/aerialTiles.js".

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/aerialTiles.ts
/**
 * Aerial tiles for the 3D render and the drone photo alignment: which source
 * covers a place, fetching with a timeout and a small pool, and recognising
 * tiles without imagery. PDOK answers plain white just across the border and
 * Esri a grey "Map data not yet available" picture, both with HTTP 200.
 */
import sharp, { type OverlayOptions } from 'sharp';

export interface LatLng { lat: number; lng: number }
export type SourceKey = 'pdok' | 'usgs' | 'satellite';
export interface TileSource {
  key: SourceKey; url: string; maxZoom: number; attribution: string; layer: string | null;
  bounds?: [number, number, number, number];
}

/** The PDOK year used for alignment: a fixed one, so the reference does not change by itself. */
export const PDOK_ALIGN_LAYER = process.env.PDOK_ALIGN_LAYER ?? '2025_orthoHR';
const UA = 'OpenNova/1.0 (+https://github.com/rvbcrs/Novabot)';

/** Mirrors the dashboard's TILE_LAYERS by default (what the 3D render shows). */
export function tileSources(opts: { pdokLayer?: string; esriMaxZoom?: number } = {}): Record<SourceKey, TileSource> {
  const pdokLayer = opts.pdokLayer ?? 'Actueel_orthoHR';
  return {
    pdok: {
      key: 'pdok', layer: pdokLayer, maxZoom: 21, bounds: [50.7, 3.2, 53.7, 7.3],
      url: `https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/${pdokLayer}/EPSG:3857/{z}/{x}/{y}.jpeg`,
      attribution: 'PDOK / Beeldmateriaal Nederland',
    },
    usgs: {
      key: 'usgs', layer: null, maxZoom: 20, bounds: [24.5, -125, 49.5, -66.9],
      url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
      attribution: 'USGS / The National Map',
    },
    satellite: {
      key: 'satellite', layer: null, maxZoom: opts.esriMaxZoom ?? 19,
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Esri, Maxar, Earthstar Geographics',
    },
  };
}

/** Sources that may cover this spot, regional first; Esri always last. */
export function sourcesFor(lat: number, lng: number, opts: { pdokLayer?: string; esriMaxZoom?: number } = {}): TileSource[] {
  const s = tileSources(opts);
  const covers = (t: TileSource) => !t.bounds
    || (lat >= t.bounds[0] && lat <= t.bounds[2] && lng >= t.bounds[1] && lng <= t.bounds[3]);
  return [s.pdok, s.usgs].filter(covers).concat(s.satellite);
}

/** Web-Mercator helpers, the projection every XYZ tile service uses. */
export function lngToTileX(lng: number, z: number): number { return ((lng + 180) / 360) * 2 ** z; }
export function latToTileY(lat: number, z: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
}
export function tileXToLng(x: number, z: number): number { return (x / 2 ** z) * 360 - 180; }
export function tileYToLat(y: number, z: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
}
/** Ground metres per pixel of a 256 px tile at this latitude and zoom. */
export function groundMPerPx(lat: number, z: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

const ESRI_PLACEHOLDER_ETAGS = new Set(['"vvvvvvvvvvvvf"']);

/** A tile that carries no imagery: uniform, Esri's placeholder, or not an image at all. */
export async function isBlankTile(buf: Buffer, etag: string | null = null): Promise<boolean> {
  if (etag && ESRI_PLACEHOLDER_ETAGS.has(etag.replace(/^W\//, ''))) return true;
  try {
    const { channels } = await sharp(buf).stats();
    return channels.slice(0, 3).every(c => c.stdev < 3);
  } catch {
    return true;
  }
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
/** png null and failed false: the source answered but had no imagery here. */
export interface TileResult { tx: number; ty: number; png: Buffer | null; failed: boolean }

export async function fetchTiles(
  src: TileSource, z: number, tiles: Array<{ tx: number; ty: number }>,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number; concurrency?: number } = {},
): Promise<TileResult[]> {
  const f = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const out: TileResult[] = new Array(tiles.length);
  let next = 0;
  const one = async (i: number): Promise<void> => {
    const { tx, ty } = tiles[i];
    const url = src.url.replace('{z}', String(z)).replace('{x}', String(tx)).replace('{y}', String(ty));
    try {
      const res = await f(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) { out[i] = { tx, ty, png: null, failed: true }; return; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (await isBlankTile(buf, res.headers.get('etag'))) { out[i] = { tx, ty, png: null, failed: false }; return; }
      out[i] = { tx, ty, png: await sharp(buf).png().toBuffer(), failed: false };
    } catch {
      out[i] = { tx, ty, png: null, failed: true };
    }
  };
  const workers = Math.max(1, Math.min(opts.concurrency ?? 4, tiles.length));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < tiles.length) { const i = next++; await one(i); }
  }));
  return out;
}

/**
 * Paste tiles onto a blank sheet, then cut the requested box out of it.
 *
 * Two pipelines on purpose. sharp orders operations by kind, not by call
 * order: on one pipeline `extract` runs BEFORE `composite`, so the tiles land
 * on the already-cut canvas at their sheet offsets and the whole picture
 * shifts by (left, top). That put a garden's zone on the neighbour's roof
 * (2026-09-23) while the zone maths was right all along.
 */
export async function stitchAndCrop(
  tiles: OverlayOptions[], canvasW: number, canvasH: number,
  box: { left: number; top: number; width: number; height: number },
): Promise<Buffer> {
  const sheet = await sharp({ create: { width: canvasW, height: canvasH, channels: 3, background: '#000' } })
    .composite(tiles).png().toBuffer();
  return sharp(sheet).extract(box).png().toBuffer();
}

export interface AerialImage {
  /** Raw RGB, 3 bytes per pixel, north up. */
  rgb: Buffer; width: number; height: number;
  /** 1 where a real tile covers the pixel. */
  valid: Uint8Array;
  /** Top-left of the crop in tile units at `zoom`. */
  zoom: number; x0: number; y0: number;
  mPerPx: number; source: SourceKey; layer: string | null; attribution: string;
}

export function aerialToPx(img: Pick<AerialImage, 'zoom' | 'x0' | 'y0'>, ll: LatLng): [number, number] {
  return [(lngToTileX(ll.lng, img.zoom) - img.x0) * 256, (latToTileY(ll.lat, img.zoom) - img.y0) * 256];
}
export function aerialToLatLng(img: Pick<AerialImage, 'zoom' | 'x0' | 'y0'>, x: number, y: number): LatLng {
  return { lat: tileYToLat(img.y0 + y / 256, img.zoom), lng: tileXToLng(img.x0 + x / 256, img.zoom) };
}

/**
 * A north-up aerial image of the box at the sharpest zoom that fits, from the
 * first source with imagery there. A source counts when at least `minValid`
 * of its tiles carry imagery; otherwise the next one is tried.
 */
export async function fetchAerial(
  sw: LatLng, ne: LatLng,
  opts: { pdokLayer?: string; esriMaxZoom?: number; maxTiles?: number; maxSide?: number; minValid?: number; fetchImpl?: FetchLike } = {},
): Promise<{ image: AerialImage } | { image: null; reason: 'offline' | 'no_imagery' | 'too_large' }> {
  const maxTiles = opts.maxTiles ?? 100; const maxSide = opts.maxSide ?? 4096; const minValid = opts.minValid ?? 0.7;
  const lat = (sw.lat + ne.lat) / 2; const lng = (sw.lng + ne.lng) / 2;
  let answered = false; let tooLarge = false;
  for (const src of sourcesFor(lat, lng, opts)) {
    let z = src.maxZoom;
    for (; z > 12; z--) {
      const cols = Math.floor(lngToTileX(ne.lng, z)) - Math.floor(lngToTileX(sw.lng, z)) + 1;
      const rows = Math.floor(latToTileY(sw.lat, z)) - Math.floor(latToTileY(ne.lat, z)) + 1;
      const w = (lngToTileX(ne.lng, z) - lngToTileX(sw.lng, z)) * 256;
      const h = (latToTileY(sw.lat, z) - latToTileY(ne.lat, z)) * 256;
      if (w <= maxSide && h <= maxSide && cols * rows <= maxTiles) break;
    }
    if (z <= 12) { tooLarge = true; continue; }
    const x0 = lngToTileX(sw.lng, z); const x1 = lngToTileX(ne.lng, z);
    const y0 = latToTileY(ne.lat, z); const y1 = latToTileY(sw.lat, z);
    const tx0 = Math.floor(x0); const ty0 = Math.floor(y0);
    const list: Array<{ tx: number; ty: number }> = [];
    for (let ty = ty0; ty <= Math.floor(y1); ty++) for (let tx = tx0; tx <= Math.floor(x1); tx++) list.push({ tx, ty });
    const tiles = await fetchTiles(src, z, list, { fetchImpl: opts.fetchImpl });
    if (tiles.some(t => !t.failed)) answered = true;
    const good = tiles.filter(t => t.png);
    if (good.length === 0 || good.length < minValid * tiles.length) continue;

    const cols = Math.floor(x1) - tx0 + 1; const rows = Math.floor(y1) - ty0 + 1;
    const canvasW = cols * 256; const canvasH = rows * 256;
    const left = Math.round((x0 - tx0) * 256); const top = Math.round((y0 - ty0) * 256);
    const width = Math.min(Math.max(1, Math.round((x1 - x0) * 256)), canvasW - left);
    const height = Math.min(Math.max(1, Math.round((y1 - y0) * 256)), canvasH - top);
    const png = await stitchAndCrop(good.map(t => ({ input: t.png!, left: (t.tx - tx0) * 256, top: (t.ty - ty0) * 256 })),
      canvasW, canvasH, { left, top, width, height });
    const rgb = await sharp(png).removeAlpha().raw().toBuffer();
    const valid = new Uint8Array(width * height);
    for (const t of good) {
      const cx0 = Math.max(0, (t.tx - tx0) * 256 - left); const cy0 = Math.max(0, (t.ty - ty0) * 256 - top);
      const cx1 = Math.min(width, (t.tx - tx0 + 1) * 256 - left); const cy1 = Math.min(height, (t.ty - ty0 + 1) * 256 - top);
      for (let y = cy0; y < cy1; y++) valid.fill(1, y * width + cx0, y * width + cx1);
    }
    return {
      image: {
        rgb, width, height, valid, zoom: z, x0: tx0 + left / 256, y0: ty0 + top / 256,
        mPerPx: groundMPerPx(lat, z), source: src.key, layer: src.layer, attribution: src.attribution,
      },
    };
  }
  return { image: null, reason: tooLarge ? 'too_large' : answered ? 'no_imagery' : 'offline' };
}
```

In `server/src/services/gardenRender.ts`:

1. Delete the local `lngToTileX`, `latToTileY`, `TileSource`, `TILE_SOURCES`, `pickTileSource` and `stitchAndCrop` definitions, and add:

```ts
import { sourcesFor, fetchTiles, lngToTileX, latToTileY, stitchAndCrop } from './aerialTiles.js';
export { stitchAndCrop } from './aerialTiles.js';
```

2. Replace the body of `aerialBase` from the line `const [, src] = pickTileSource(b.origin.lat, b.origin.lng);` down to its `return { png, ... }` with:

```ts
  for (const src of sourcesFor(b.origin.lat, b.origin.lng)) {
    // Highest zoom whose stitched image stays under MAX_PX.
    let z = src.maxZoom;
    for (; z > 12; z--) {
      const w = (lngToTileX(b.ne.lng, z) - lngToTileX(b.sw.lng, z)) * 256;
      const h = (latToTileY(b.sw.lat, z) - latToTileY(b.ne.lat, z)) * 256;
      if (w <= MAX_PX && h <= MAX_PX) break;
    }
    const x0 = lngToTileX(b.sw.lng, z); const x1 = lngToTileX(b.ne.lng, z);
    const y0 = latToTileY(b.ne.lat, z); const y1 = latToTileY(b.sw.lat, z);
    const tx0 = Math.floor(x0); const tx1 = Math.floor(x1);
    const ty0 = Math.floor(y0); const ty1 = Math.floor(y1);
    const cols = tx1 - tx0 + 1; const rows = ty1 - ty0 + 1;
    if (cols * rows > 64) { console.warn(`${TAG} ${sn}: ${cols}x${rows} tiles is too many, giving up`); return null; }
    const list: Array<{ tx: number; ty: number }> = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) list.push({ tx, ty });
    const tiles = await fetchTiles(src, z, list);
    const good = tiles.filter(t => t.png);
    // A source that answers with blank tiles here (PDOK across the border) is
    // not this garden's imagery: try the next one instead of rendering white.
    if (good.length === 0 || good.length < 0.7 * tiles.length) {
      console.warn(`${TAG} ${sn}: ${src.key} has no imagery here (${good.length}/${tiles.length} tiles), trying the next source`);
      continue;
    }
    const composites: OverlayOptions[] = good.map(t => ({ input: t.png!, left: (t.tx - tx0) * 256, top: (t.ty - ty0) * 256 }));
    const canvasW = cols * 256; const canvasH = rows * 256;
    // Crop the stitched sheet back to the requested bbox.
    const left = Math.round((x0 - tx0) * 256); const top = Math.round((y0 - ty0) * 256);
    const width = Math.max(64, Math.round((x1 - x0) * 256)); const height = Math.max(64, Math.round((y1 - y0) * 256));
    const png = await stitchAndCrop(composites, canvasW, canvasH,
      { left, top, width: Math.min(width, canvasW - left), height: Math.min(height, canvasH - top) });
    const meta = await sharp(png).metadata();
    const W = meta.width ?? width; const H = meta.height ?? height;
    // The crop is axis-aligned in Web Mercator, so the mapping is a plain scale.
    const project = (p: LatLng): [number, number] => [
      (lngToTileX(p.lng, z) - x0) * 256,
      (latToTileY(p.lat, z) - y0) * 256,
    ];
    return { png, width: W, height: H, project, source: 'aerial', attribution: src.attribution };
  }
  return null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx tsc --noEmit && npx vitest run src/__tests__/services/aerialTiles.test.ts src/__tests__/services/gardenRender.test.ts`
Expected: tsc clean; PASS for both files (the render tests import `stitchAndCrop` from gardenRender through the re-export).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/aerialTiles.ts server/src/services/gardenRender.ts server/src/__tests__/services/aerialTiles.test.ts
git commit -m "feat(server): shared aerial tile module that skips blank tiles and falls back to the next source

PDOK answers plain white tiles just across the Dutch border and Esri a grey
placeholder, both with HTTP 200, so the 3D render showed white there. The
render now tries the regional source, then Esri, and the drone photo
alignment gets the same module with a fixed PDOK year and a validity mask."
```

### Task 3: Pure geometrie: similariteit, RANSAC met Tukey-IRLS, parameters, omhullende

**Files:**
- Create: `server/src/services/droneAlign/alignGeometry.ts`
- Test: `server/src/__tests__/services/droneAlign/alignGeometry.test.ts`

**Interfaces:**
- Produces:
  - `interface Pt { x: number; y: number }`; `interface Sim { a; b; tx; ty }` (pixelframe, y omlaag: `x' = a·x − b·y + tx`, `y' = b·x + a·y + ty`); `IDENTITY`
  - `applySim(s, p)`, `invertSim(s)`, `composeSim(s2, s1)` (= s2∘s1), `fitSimilarity(src, dst, w?): Sim | null`
  - `mulberry32(seed): () => number`
  - `ransacSimilarity(src, dst, thrPx, opts?): RansacResult | null` met `RansacResult { sim; inliers: boolean[]; count; rmsPx: number | null }`
  - `simParams(s, about: Pt, mPerPx): { rotDegCcw; scale; shiftE; shiftN }` (draaiing tegen de klok in, gezien met noord boven)
  - `convexHullArea(pts)`, `polygonArea(pts)`, `dedupIndices(src, dst, cell): number[]`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/services/droneAlign/alignGeometry.test.ts
import { describe, it, expect } from 'vitest';
import {
  applySim, invertSim, composeSim, fitSimilarity, ransacSimilarity, simParams, convexHullArea, polygonArea,
  dedupIndices, mulberry32, type Pt, type Sim,
} from '../../../services/droneAlign/alignGeometry.js';

const rot = (deg: number, scale: number, tx: number, ty: number): Sim => {
  // CCW on a north-up map is clockwise in pixel coordinates (y down): b = -sin.
  const t = (deg * Math.PI) / 180;
  return { a: scale * Math.cos(t), b: -scale * Math.sin(t), tx, ty };
};
const cloud = (n: number, seed: number): Pt[] => {
  const r = mulberry32(seed);
  return Array.from({ length: n }, () => ({ x: r() * 800, y: r() * 600 }));
};

describe('similarity algebra', () => {
  it('fits an exact similarity from clean pairs', () => {
    const s = rot(3, 0.97, 5, -2); const src = cloud(20, 1); const dst = src.map(p => applySim(s, p));
    const f = fitSimilarity(src, dst)!;
    expect(f.a).toBeCloseTo(s.a, 9); expect(f.b).toBeCloseTo(s.b, 9);
    expect(f.tx).toBeCloseTo(s.tx, 6); expect(f.ty).toBeCloseTo(s.ty, 6);
  });
  it('inverts and composes', () => {
    const s = rot(-7, 1.04, 30, 12); const p = { x: 123, y: 45 };
    const back = applySim(invertSim(s), applySim(s, p));
    expect(back.x).toBeCloseTo(p.x, 9); expect(back.y).toBeCloseTo(p.y, 9);
    const two = composeSim(rot(2, 1, 1, 1), s);
    const q = applySim(two, p); const r = applySim(rot(2, 1, 1, 1), applySim(s, p));
    expect(q.x).toBeCloseTo(r.x, 9); expect(q.y).toBeCloseTo(r.y, 9);
  });
  it('returns null for degenerate input', () => {
    expect(fitSimilarity([{ x: 1, y: 1 }, { x: 1, y: 1 }], [{ x: 2, y: 2 }, { x: 3, y: 3 }])).toBeNull();
  });
});

describe('ransacSimilarity', () => {
  it('recovers the model through 40% outliers and noise, deterministically', () => {
    const s = rot(2.9, 0.974, -6, 11);
    const r = mulberry32(7);
    const src = cloud(100, 3); const dst = src.map(p => { const q = applySim(s, p); return { x: q.x + (r() - 0.5) * 0.4, y: q.y + (r() - 0.5) * 0.4 }; });
    const outSrc = cloud(70, 5); const outDst = cloud(70, 6);
    const A = src.concat(outSrc); const B = dst.concat(outDst);
    const res = ransacSimilarity(A, B, 1.0, { seed: 1 })!;
    expect(res.sim.a).toBeCloseTo(s.a, 3); expect(res.sim.b).toBeCloseTo(s.b, 3);
    expect(res.count).toBeGreaterThanOrEqual(95);
    expect(res.inliers.slice(0, 100).filter(Boolean).length).toBeGreaterThanOrEqual(95);
    expect(res.rmsPx!).toBeLessThan(0.5);
    expect(ransacSimilarity(A, B, 1.0, { seed: 1 })!.sim).toEqual(res.sim);
  });
  it('gives up with fewer than three pairs', () => {
    expect(ransacSimilarity([{ x: 0, y: 0 }, { x: 1, y: 0 }], [{ x: 0, y: 0 }, { x: 1, y: 0 }], 1)).toBeNull();
  });
});

describe('simParams', () => {
  it('reports CCW rotation on a north-up map, scale and the shift in metres east and north', () => {
    const p = simParams(rot(5, 1.02, 0, 0), { x: 0, y: 0 }, 0.05);
    expect(p.rotDegCcw).toBeCloseTo(5, 9); expect(p.scale).toBeCloseTo(1.02, 9);
    const shift = simParams({ a: 1, b: 0, tx: 20, ty: -10 }, { x: 100, y: 100 }, 0.05);
    expect(shift.shiftE).toBeCloseTo(1.0, 9);   // 20 px east
    expect(shift.shiftN).toBeCloseTo(0.5, 9);   // -10 px in y is north
  });
});

describe('areas and dedup', () => {
  it('measures a convex hull and a polygon', () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }];
    expect(convexHullArea(sq)).toBeCloseTo(100, 9);
    expect(polygonArea(sq.slice(0, 4))).toBeCloseTo(100, 9);
    expect(convexHullArea(sq.slice(0, 2))).toBe(0);
  });
  it('keeps one of each pair of matches that land in the same cell on both sides', () => {
    const a = [{ x: 1, y: 1 }, { x: 1.1, y: 1.1 }, { x: 5, y: 5 }];
    const b = [{ x: 2, y: 2 }, { x: 2.1, y: 2.1 }, { x: 2, y: 2 }];
    expect(dedupIndices(a, b, 0.5)).toEqual([0, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/services/droneAlign/alignGeometry.test.ts`
Expected: FAIL with "Failed to resolve import ../../../services/droneAlign/alignGeometry.js".

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/droneAlign/alignGeometry.ts
/**
 * Geometry for aligning a drone photo to an aerial image: a similarity
 * (rotation, uniform scale, shift), fitted robustly from matched points.
 * Pixel coordinates with y pointing down, like the images themselves.
 */
export interface Pt { x: number; y: number }
/** x' = a·x − b·y + tx, y' = b·x + a·y + ty. */
export interface Sim { a: number; b: number; tx: number; ty: number }
export const IDENTITY: Sim = { a: 1, b: 0, tx: 0, ty: 0 };

export function applySim(s: Sim, p: Pt): Pt {
  return { x: s.a * p.x - s.b * p.y + s.tx, y: s.b * p.x + s.a * p.y + s.ty };
}

export function invertSim(s: Sim): Sim {
  const d = s.a * s.a + s.b * s.b;
  const a = s.a / d; const b = -s.b / d;
  return { a, b, tx: -(a * s.tx - b * s.ty), ty: -(b * s.tx + a * s.ty) };
}

/** s2 after s1. */
export function composeSim(s2: Sim, s1: Sim): Sim {
  const t = applySim(s2, { x: s1.tx, y: s1.ty });
  return { a: s2.a * s1.a - s2.b * s1.b, b: s2.a * s1.b + s2.b * s1.a, tx: t.x, ty: t.y };
}

/** Weighted least-squares similarity src → dst; null when the points do not span anything. */
export function fitSimilarity(src: Pt[], dst: Pt[], w?: number[]): Sim | null {
  let sw = 0, msx = 0, msy = 0, mdx = 0, mdy = 0;
  for (let i = 0; i < src.length; i++) {
    const wi = w ? w[i] : 1; if (!(wi > 0)) continue;
    sw += wi; msx += wi * src[i].x; msy += wi * src[i].y; mdx += wi * dst[i].x; mdy += wi * dst[i].y;
  }
  if (sw <= 0) return null;
  msx /= sw; msy /= sw; mdx /= sw; mdy /= sw;
  let na = 0, nb = 0, den = 0;
  for (let i = 0; i < src.length; i++) {
    const wi = w ? w[i] : 1; if (!(wi > 0)) continue;
    const xs = src[i].x - msx, ys = src[i].y - msy, xd = dst[i].x - mdx, yd = dst[i].y - mdy;
    na += wi * (xs * xd + ys * yd); nb += wi * (xs * yd - ys * xd); den += wi * (xs * xs + ys * ys);
  }
  if (den < 1e-12) return null;
  const a = na / den; const b = nb / den;
  return { a, b, tx: mdx - (a * msx - b * msy), ty: mdy - (b * msx + a * msy) };
}

/** Small seeded PRNG, so a run can be repeated exactly. */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RansacResult { sim: Sim; inliers: boolean[]; count: number; rmsPx: number | null }

const resid = (s: Sim, p: Pt, q: Pt): number => { const r = applySim(s, p); return Math.hypot(r.x - q.x, r.y - q.y); };

/**
 * RANSAC over two-point samples, then Tukey-weighted refits (the offline
 * analysis did the same with OpenCV plus IRLS). Null below three consistent pairs.
 */
export function ransacSimilarity(
  src: Pt[], dst: Pt[], thrPx: number,
  opts: { maxIters?: number; confidence?: number; seed?: number } = {},
): RansacResult | null {
  const n = src.length;
  if (n < 3) return null;
  const rnd = mulberry32(opts.seed ?? 1);
  const maxIters = opts.maxIters ?? 20000; const conf = opts.confidence ?? 0.9999;
  let best: Sim | null = null; let bestCount = 0; let iters = maxIters;
  for (let k = 0; k < iters; k++) {
    const i = Math.floor(rnd() * n); let j = Math.floor(rnd() * (n - 1)); if (j >= i) j++;
    const s = fitSimilarity([src[i], src[j]], [dst[i], dst[j]]);
    if (!s) continue;
    let c = 0; for (let m = 0; m < n; m++) if (resid(s, src[m], dst[m]) < thrPx) c++;
    if (c > bestCount) {
      best = s; bestCount = c;
      const w = c / n; const denom = Math.log(1 - w * w);
      if (denom < 0) iters = Math.min(maxIters, Math.ceil(Math.log(1 - conf) / denom));
    }
  }
  if (!best || bestCount < 3) return null;
  let sim = best;
  for (let it = 0; it < 20; it++) {
    const w = src.map((p, m) => { const r = resid(sim, p, dst[m]); return r < thrPx ? (1 - (r / thrPx) ** 2) ** 2 : 0; });
    if (w.filter(v => v > 0).length < 3) break;
    const next = fitSimilarity(src, dst, w); if (!next) break;
    sim = next;
  }
  const inliers = src.map((p, m) => resid(sim, p, dst[m]) < thrPx);
  let sq = 0, count = 0;
  for (let m = 0; m < n; m++) if (inliers[m]) { sq += resid(sim, src[m], dst[m]) ** 2; count++; }
  return { sim, inliers, count, rmsPx: count ? Math.sqrt(sq / count) : null };
}

/** Rotation (CCW with north up), scale, and the shift of `about` in metres east and north. */
export function simParams(s: Sim, about: Pt, mPerPx: number): { rotDegCcw: number; scale: number; shiftE: number; shiftN: number } {
  const q = applySim(s, about);
  return {
    rotDegCcw: (-Math.atan2(s.b, s.a) * 180) / Math.PI,
    scale: Math.hypot(s.a, s.b),
    shiftE: (q.x - about.x) * mPerPx,
    shiftN: -(q.y - about.y) * mPerPx,
  };
}

export function polygonArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i]; const q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
  return Math.abs(a) / 2;
}

/** Area of the convex hull (Andrew's monotone chain); 0 below three points. */
export function convexHullArea(pts: Pt[]): number {
  if (pts.length < 3) return 0;
  const p = [...pts].sort((u, v) => u.x - v.x || u.y - v.y);
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = []; const upper: Pt[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return polygonArea(lower.slice(0, -1).concat(upper.slice(0, -1)));
}

/** Indices of pairs to keep: the first of every pair that falls in the same cell on both sides (overlapping tiles). */
export function dedupIndices(src: Pt[], dst: Pt[], cell: number): number[] {
  const seen = new Set<string>(); const keep: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const k = [src[i].x, src[i].y, dst[i].x, dst[i].y].map(v => Math.round(v / cell)).join(',');
    if (seen.has(k)) continue;
    seen.add(k); keep.push(i);
  }
  return keep;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/services/droneAlign/alignGeometry.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/droneAlign/alignGeometry.ts server/src/__tests__/services/droneAlign/alignGeometry.test.ts
git commit -m "feat(server): similarity fitting with RANSAC and Tukey refinement for drone photo alignment"
```

### Task 4: Beeldbewerking en fotogeometrie

**Files:**
- Create: `server/src/services/homography.ts` (verhuisd uit gardenRender, zodat de uitlijnservice gardenRender niet hoeft te importeren; gardenRender importeert `routes/droneOverlay.js`, en die routes gaan de service importeren: dat zou een importcirkel zijn)
- Modify: `server/src/services/gardenRender.ts` (homografiefuncties importeren en her-exporteren)
- Create: `server/src/services/droneAlign/photoGeometry.ts`
- Create: `server/src/services/droneAlign/alignImage.ts`
- Test: `server/src/__tests__/services/droneAlign/alignImage.test.ts`

**Interfaces:**
- Produces:
  - `homography.ts`: `type Homography = number[]`, `solveHomography(src, dst)`, `applyHomography(h, x, y)`, `invertHomography(h)`
  - `photoGeometry.ts`: `type Corners = [LatLng, LatLng, LatLng, LatLng]` (TL, TR, BR, BL), `photoToLatLng(corners, size, px: {u, v}): LatLng`, `latLngToPhoto(corners, size, ll): {u, v}`, `insidePhoto(px, size): boolean`, `photoWidthM(corners): number`
  - `alignImage.ts`: `interface Rgb { data: Uint8Array; width; height }`, `decodeScaled(input, targetWidth): Promise<Rgb & { scale: number }>`, `warpInto(photo, photoToLevel, width, height, erodePx): { img: Rgb; valid: Uint8Array }`, `erode(mask, w, h, r)`, `resizeRgb(src, w, h): Promise<Rgb>`, `resizeMask(mask, w, h, nw, nh)`, `cropRgb(src, x, y, w, h)`, `tileOrigins(valid, w, h, tile, overlap, minValid?)`, `pairTensor(a, b, mul?): { data: Float32Array; dims: [2, 3, number, number] }`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/services/droneAlign/alignImage.test.ts
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { warpInto, erode, tileOrigins, pairTensor, decodeScaled, resizeMask, cropRgb, type Rgb } from '../../../services/droneAlign/alignImage.js';
import { photoToLatLng, latLngToPhoto, insidePhoto, photoWidthM, type Corners } from '../../../services/droneAlign/photoGeometry.js';
import { solveHomography } from '../../../services/homography.js';

const rand = (w: number, h: number): Rgb => {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) % 251;
  return { data, width: w, height: h };
};
const px = (img: Rgb, x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 3, (y * img.width + x) * 3 + 3));

describe('warpInto', () => {
  it('reproduces the photo through the identity and marks it valid', () => {
    const p = rand(40, 30);
    const H = solveHomography([[0, 0], [40, 0], [40, 30], [0, 30]], [[0, 0], [40, 0], [40, 30], [0, 30]]);
    const { img, valid } = warpInto(p, H, 40, 30, 0);
    expect(px(img, 17, 11)).toEqual(px(p, 17, 11));
    expect(valid.every(v => v === 1)).toBe(true);
  });
  it('shifts content and leaves the uncovered part grey and invalid', () => {
    const p = rand(40, 30);
    const H = solveHomography([[0, 0], [40, 0], [40, 30], [0, 30]], [[10, 0], [50, 0], [50, 30], [10, 30]]);
    const { img, valid } = warpInto(p, H, 50, 30, 0);
    expect(px(img, 27, 5)).toEqual(px(p, 17, 5));
    expect(px(img, 3, 5)).toEqual([128, 128, 128]);
    expect(valid[5 * 50 + 3]).toBe(0);
    expect(valid[5 * 50 + 27]).toBe(1);
  });
});

describe('erode, resizeMask, cropRgb', () => {
  it('erodes a square window', () => {
    const m = new Uint8Array(25).fill(1);
    const e = erode(m, 5, 5, 1);
    expect(Array.from(e)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
  });
  it('resizes a mask by nearest sample and crops an image', () => {
    const m = new Uint8Array([1, 0, 0, 1]);
    expect(Array.from(resizeMask(m, 2, 2, 4, 4))).toEqual([1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1]);
    const c = cropRgb(rand(10, 10), 2, 3, 4, 4);
    expect(c.width).toBe(4);
    expect(px(c, 0, 0)).toEqual(px(rand(10, 10), 2, 3));
  });
});

describe('tileOrigins', () => {
  it('covers the image to its far edges with overlapping tiles', () => {
    const v = new Uint8Array(1000 * 700).fill(1);
    const t = tileOrigins(v, 1000, 700, 384, 64);
    expect(t.map(o => o.x).sort((a, b) => a - b).at(-1)).toBe(616);
    expect(t.map(o => o.y).sort((a, b) => a - b).at(-1)).toBe(316);
    expect(tileOrigins(new Uint8Array(1000 * 700), 1000, 700, 384, 64)).toEqual([]);   // nothing valid
    expect(tileOrigins(new Uint8Array(100 * 80).fill(1), 100, 80, 384, 64)).toEqual([{ x: 0, y: 0 }]);
  });
});

describe('pairTensor', () => {
  it('stacks two RGB images as (2,3,H,W) in [0,1], zero-padded to a multiple of 16', () => {
    const a = rand(3, 2); const b = rand(3, 2);
    const { data, dims } = pairTensor(a, b, 16);
    expect(dims).toEqual([2, 3, 16, 16]);
    expect(data[((0 * 3 + 2) * 16 + 0) * 16 + 1]).toBeCloseTo(px(a, 1, 0)[2] / 255, 6);
    expect(data[((1 * 3 + 0) * 16 + 1) * 16 + 2]).toBeCloseTo(px(b, 2, 1)[0] / 255, 6);
    expect(data[((0 * 3 + 0) * 16 + 5) * 16 + 5]).toBe(0);
  });
});

describe('decodeScaled', () => {
  it('decodes a large upload straight to the working width', async () => {
    const big = await sharp({ create: { width: 6000, height: 4000, channels: 3, background: '#406040' } }).png().toBuffer();
    const d = await decodeScaled(big, 800);
    expect(d.width).toBe(800);
    expect(d.height).toBe(533);
    expect(d.scale).toBeCloseTo(800 / 6000, 9);
    expect(d.data.length).toBe(800 * 533 * 3);
  });
});

describe('photoGeometry', () => {
  const corners: Corners = [
    { lat: 52.141106206, lng: 6.230654518 }, { lat: 52.141079422, lng: 6.231540836 },
    { lat: 52.140769495, lng: 6.231515970 }, { lat: 52.140796280, lng: 6.230629652 },
  ];
  const size = { width: 1720, height: 980 };
  it('goes from photo pixel to lat/lng and back', () => {
    const ll = photoToLatLng(corners, size, { u: 984.1, v: 801.6 });
    const back = latLngToPhoto(corners, size, ll);
    expect(back.u).toBeCloseTo(984.1, 4); expect(back.v).toBeCloseTo(801.6, 4);
    const tl = photoToLatLng(corners, size, { u: 0, v: 0 });
    expect(tl.lat).toBeCloseTo(corners[0].lat, 9); expect(tl.lng).toBeCloseTo(corners[0].lng, 9);
    expect(insidePhoto({ u: 5, v: 5 }, size)).toBe(true);
    expect(insidePhoto({ u: -1, v: 5 }, size)).toBe(false);
  });
  it('measures the top edge in metres', () => {
    expect(photoWidthM(corners)).toBeCloseTo(60.6, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/services/droneAlign/alignImage.test.ts`
Expected: FAIL with "Failed to resolve import ../../../services/droneAlign/alignImage.js".

- [ ] **Step 3: Write minimal implementation**

Move the three functions and the type out of `gardenRender.ts` into `server/src/services/homography.ts` unchanged:

```ts
// server/src/services/homography.ts
/**
 * Plane homographies (3x3, row-major, h33 = 1). Shared by the 3D render and
 * the drone photo alignment; kept out of gardenRender so the alignment does
 * not import the render (which imports the drone overlay routes).
 */
export type Homography = number[];
type Pt = readonly [number, number];

/** The homography taking src[i] to dst[i], from four point pairs (DLT). */
export function solveHomography(src: Pt[], dst: Pt[]): Homography {
  const A: number[][] = []; const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]; const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gauss-Jordan with partial pivoting; 8x8, so speed is irrelevant here.
  const n = 8;
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    [A[i], A[piv]] = [A[piv], A[i]]; [b[i], b[piv]] = [b[piv], b[i]];
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = A[r][i] / A[i][i];
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  return [...A.map((row, i) => b[i] / row[i]), 1];
}

export function applyHomography(h: Homography, x: number, y: number): [number, number] {
  const d = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
}

export function invertHomography(h: Homography): Homography {
  const [a, b, c, d, e, f, g, k, i] = h;
  const A = e * i - f * k, B = -(d * i - f * g), C = d * k - e * g;
  const det = a * A + b * B + c * C;
  const m = [
    A, -(b * i - c * k), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * k - b * g), a * e - b * d,
  ].map(v => v / det);
  return m.map(v => v / m[8]);
}
```

In `gardenRender.ts`, delete the local `Homography` type, `solveHomography`, `applyHomography` and `invertHomography`, and add:

```ts
import { solveHomography, applyHomography, invertHomography, type Homography } from './homography.js';
export { solveHomography, applyHomography, invertHomography, type Homography } from './homography.js';
```

```ts
// server/src/services/droneAlign/photoGeometry.ts
/**
 * Photo pixel <-> lat/lng for a drone photo placed by its four corners
 * (top-left, top-right, bottom-right, bottom-left), on the server. Same
 * mapping as the dashboard's droneOverlayMath: a homography in a local metric
 * plane around the corners.
 */
import { solveHomography, applyHomography, invertHomography } from '../homography.js';

export interface LatLng { lat: number; lng: number }
export type Corners = [LatLng, LatLng, LatLng, LatLng];
export interface PhotoPx { u: number; v: number }
export interface PhotoSize { width: number; height: number }
const M_PER_DEG_LAT = 111_320;

function frame(corners: Corners) {
  const lat0 = corners.reduce((s, c) => s + c.lat, 0) / 4;
  const lng0 = corners.reduce((s, c) => s + c.lng, 0) / 4;
  const k = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return {
    toXY: (ll: LatLng): [number, number] => [(ll.lng - lng0) * k, (ll.lat - lat0) * M_PER_DEG_LAT],
    toLL: (x: number, y: number): LatLng => ({ lat: lat0 + y / M_PER_DEG_LAT, lng: lng0 + x / k }),
  };
}

function photoToPlane(corners: Corners, size: PhotoSize) {
  const f = frame(corners);
  const h = solveHomography(
    [[0, 0], [size.width, 0], [size.width, size.height], [0, size.height]],
    corners.map(c => f.toXY(c)),
  );
  return { f, h };
}

export function photoToLatLng(corners: Corners, size: PhotoSize, px: PhotoPx): LatLng {
  const { f, h } = photoToPlane(corners, size);
  const [x, y] = applyHomography(h, px.u, px.v);
  return f.toLL(x, y);
}

export function latLngToPhoto(corners: Corners, size: PhotoSize, ll: LatLng): PhotoPx {
  const { f, h } = photoToPlane(corners, size);
  const [x, y] = f.toXY(ll);
  const [u, v] = applyHomography(invertHomography(h), x, y);
  return { u, v };
}

export function insidePhoto(px: PhotoPx, size: PhotoSize): boolean {
  return px.u >= 0 && px.v >= 0 && px.u <= size.width && px.v <= size.height;
}

/** Ground length of the top edge in metres. */
export function photoWidthM(corners: Corners): number {
  const f = frame(corners);
  const [ax, ay] = f.toXY(corners[0]); const [bx, by] = f.toXY(corners[1]);
  return Math.hypot(bx - ax, by - ay);
}
```

```ts
// server/src/services/droneAlign/alignImage.ts
/**
 * Image plumbing for the drone photo alignment, on raw RGB buffers. The
 * photo is decoded straight to the working size (sharp shrinks on load), so a
 * 50 MB upload never sits in memory at full size. EXIF orientation is not
 * applied, matching how the overlay stores width and height.
 */
import sharp from 'sharp';
import { applyHomography, invertHomography, type Homography } from '../homography.js';

export interface Rgb { data: Uint8Array; width: number; height: number }

export async function decodeScaled(input: string | Buffer, targetWidth: number): Promise<Rgb & { scale: number }> {
  const meta = await sharp(input).metadata();
  const W = meta.width ?? 0;
  const width = Math.max(1, Math.min(W, Math.round(targetWidth)));
  const { data, info } = await sharp(input, { limitInputPixels: false })
    .resize({ width, kernel: 'lanczos3' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height, scale: info.width / W };
}

export async function resizeRgb(src: Rgb, width: number, height: number): Promise<Rgb> {
  const buf = await sharp(Buffer.from(src.data.buffer, src.data.byteOffset, src.data.length), { raw: { width: src.width, height: src.height, channels: 3 } })
    .resize(width, height, { kernel: 'lanczos3', fit: 'fill' }).raw().toBuffer();
  return { data: new Uint8Array(buf.buffer, buf.byteOffset, buf.length), width, height };
}

export function resizeMask(mask: Uint8Array, w: number, h: number, nw: number, nh: number): Uint8Array {
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / nh));
    for (let x = 0; x < nw; x++) out[y * nw + x] = mask[sy * w + Math.min(w - 1, Math.floor(((x + 0.5) * w) / nw))];
  }
  return out;
}

export function cropRgb(src: Rgb, x0: number, y0: number, w: number, h: number): Rgb {
  const cw = Math.max(0, Math.min(w, src.width - x0)); const ch = Math.max(0, Math.min(h, src.height - y0));
  const data = new Uint8Array(cw * ch * 3);
  for (let y = 0; y < ch; y++) data.set(src.data.subarray(((y0 + y) * src.width + x0) * 3, ((y0 + y) * src.width + x0 + cw) * 3), y * cw * 3);
  return { data, width: cw, height: ch };
}

/** Square-window erosion, separable. */
export function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h); const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 1;
    for (let k = -r; k <= r; k++) { const xx = x + k; if (xx < 0 || xx >= w || !mask[y * w + xx]) { m = 0; break; } }
    tmp[y * w + x] = m;
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = 1;
    for (let k = -r; k <= r; k++) { const yy = y + k; if (yy < 0 || yy >= h || !tmp[yy * w + x]) { m = 0; break; } }
    out[y * w + x] = m;
  }
  return out;
}

/**
 * Render the photo into a level grid. photoToLevel maps photo pixel-edge
 * coordinates to level ones; each level pixel centre is sampled bilinearly.
 * Outside the photo: grey 128 and invalid. The valid mask is eroded so
 * matches right at the photo edge (resampling seams) are not used.
 */
export function warpInto(photo: Rgb, photoToLevel: Homography, width: number, height: number, erodePx: number): { img: Rgb; valid: Uint8Array } {
  const inv = invertHomography(photoToLevel);
  const out = new Uint8Array(width * height * 3).fill(128);
  const valid = new Uint8Array(width * height);
  const W = photo.width; const H = photo.height; const src = photo.data;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [u, v] = applyHomography(inv, x + 0.5, y + 0.5);
    const fu = u - 0.5; const fv = v - 0.5;
    if (!(fu >= 0 && fv >= 0 && fu <= W - 1 && fv <= H - 1)) continue;
    const u0 = Math.floor(fu); const v0 = Math.floor(fv);
    const du = fu - u0; const dv = fv - v0;
    const u1 = Math.min(u0 + 1, W - 1); const v1 = Math.min(v0 + 1, H - 1);
    const o = (y * width + x) * 3;
    for (let c = 0; c < 3; c++) {
      const p00 = src[(v0 * W + u0) * 3 + c]; const p10 = src[(v0 * W + u1) * 3 + c];
      const p01 = src[(v1 * W + u0) * 3 + c]; const p11 = src[(v1 * W + u1) * 3 + c];
      out[o + c] = Math.round(p00 * (1 - du) * (1 - dv) + p10 * du * (1 - dv) + p01 * (1 - du) * dv + p11 * du * dv);
    }
    valid[y * width + x] = 1;
  }
  return { img: { data: out, width, height }, valid: erodePx > 0 ? erode(valid, width, height, erodePx) : valid };
}

/** Tile origins covering the image to its far edges; tiles with less than minValid valid pixels are skipped. */
export function tileOrigins(valid: Uint8Array, w: number, h: number, tile: number, overlap: number, minValid = 0.3): Array<{ x: number; y: number }> {
  const step = tile - overlap;
  const starts = (n: number) => {
    if (n <= tile) return [0];
    const s: number[] = []; for (let v = 0; v <= n - tile; v += step) s.push(v);
    if (s[s.length - 1] + tile < n) s.push(n - tile);
    return s;
  };
  const out: Array<{ x: number; y: number }> = [];
  for (const y0 of starts(h)) for (const x0 of starts(w)) {
    let c = 0; let t = 0;
    for (let y = y0; y < Math.min(h, y0 + tile); y++) for (let x = x0; x < Math.min(w, x0 + tile); x++) { t++; c += valid[y * w + x]; }
    if (t && c / t >= minValid) out.push({ x: x0, y: y0 });
  }
  return out;
}

/** Model input for a pair: (2,3,H,W) float32 in [0,1], zero-padded to a multiple of mul. */
export function pairTensor(a: Rgb, b: Rgb, mul = 16): { data: Float32Array; dims: [2, 3, number, number] } {
  const H = Math.ceil(Math.max(a.height, b.height) / mul) * mul;
  const W = Math.ceil(Math.max(a.width, b.width) / mul) * mul;
  const data = new Float32Array(2 * 3 * H * W);
  [a, b].forEach((img, n) => {
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) for (let c = 0; c < 3; c++) {
      data[((n * 3 + c) * H + y) * W + x] = img.data[(y * img.width + x) * 3 + c] / 255;
    }
  });
  return { data, dims: [2, 3, H, W] };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx tsc --noEmit && npx vitest run src/__tests__/services/droneAlign/alignImage.test.ts src/__tests__/services/gardenRender.test.ts`
Expected: tsc clean; PASS for both files.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/homography.ts server/src/services/gardenRender.ts server/src/services/droneAlign/photoGeometry.ts server/src/services/droneAlign/alignImage.ts server/src/__tests__/services/droneAlign/alignImage.test.ts
git commit -m "feat(server): image plumbing and photo geometry for drone photo alignment"
```

### Task 5: De uitlijnpijplijn en de afwijzingsregels

**Files:**
- Create: `server/src/services/droneAlign/alignPipeline.ts`
- Test: `server/src/__tests__/services/droneAlign/alignPipeline.test.ts`

**Interfaces:**
- Consumes: Task 2 `AerialImage`, `aerialToPx`, `aerialToLatLng`, `groundMPerPx`, `lngToTileX`, `latToTileY`; Task 3 geometrie; Task 4 `warpInto`, `resizeRgb`, `resizeMask`, `cropRgb`, `tileOrigins`, `Rgb`, `Corners`, `photoWidthM`, `solveHomography`.
- Produces:
  - `type Matcher = (ref: Rgb, photo: Rgb) => Promise<{ pa: Pt[]; pb: Pt[] }>`: coördinaten in pixelrand-conventie (pixelmidden op +0,5); `pa` in de referentie, `pb` in de foto.
  - `interface AlignParams`, `DEFAULT_PARAMS`
  - `interface PassStats { inliers: number; hull: number; rmsM: number | null }`
  - `interface AlignOutput { corners: Corners | null; coarse: PassStats | null; fine: PassStats | null; correction: { rotDegCcw; scale; shiftE; shiftN } | null }`
  - `runAlignPipeline(inp: AlignInput): Promise<AlignOutput>` met `AlignInput { photo: Rgb; corners: Corners; aerial: AerialImage; matcher: Matcher; params?: Partial<AlignParams>; onProgress?: (phase: 'coarse' | 'fine', done: number, total: number) => void }`
  - `GUARDS`, `type RejectReason = 'no_match' | 'few_matches' | 'small_overlap' | 'implausible'`, `checkGuards(o, g?): RejectReason | null`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/services/droneAlign/alignPipeline.test.ts
import { describe, it, expect } from 'vitest';
import { runAlignPipeline, checkGuards, type Matcher, type AlignOutput } from '../../../services/droneAlign/alignPipeline.js';
import { warpInto, type Rgb } from '../../../services/droneAlign/alignImage.js';
import { aerialToLatLng, aerialToPx, groundMPerPx, lngToTileX, latToTileY, type AerialImage } from '../../../services/aerialTiles.js';
import { solveHomography, invertHomography } from '../../../services/homography.js';
import { mulberry32, type Pt } from '../../../services/droneAlign/alignGeometry.js';
import type { Corners } from '../../../services/droneAlign/photoGeometry.js';

// A synthetic aerial: dark ground with 64 coloured 16 px blocks, one per cell.
const palette = (i: number) => [30 + (i % 8) * 30, 30 + Math.floor(i / 8) * 30];
function scene(): AerialImage {
  const W = 800, H = 600; const rgb = Buffer.alloc(W * H * 3, 40); const r = mulberry32(11);
  for (let i = 0; i < 64; i++) {
    const cx = (i % 8) * 100 + 42 + Math.floor(r() * 16); const cy = Math.floor(i / 8) * 75 + 30 + Math.floor(r() * 14);
    const [pr, pg] = palette(i);
    for (let y = cy; y < cy + 16; y++) for (let x = cx; x < cx + 16; x++) { const o = (y * W + x) * 3; rgb[o] = pr; rgb[o + 1] = pg; rgb[o + 2] = 255; }
  }
  const lat = 52.14, lng = 6.23, z = 21;
  return { rgb, width: W, height: H, valid: new Uint8Array(W * H).fill(1), zoom: z, x0: lngToTileX(lng, z), y0: latToTileY(lat, z), mPerPx: groundMPerPx(lat, z), source: 'pdok', layer: '2025_orthoHR', attribution: '' };
}
// Pairs blocks by colour; blocks touching the image border are skipped (cut by a tile edge).
function blobs(img: Rgb): Map<number, Pt> {
  const acc = new Map<number, { x: number; y: number; n: number; edge: boolean }>();
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const o = (y * img.width + x) * 3; const rr = img.data[o], gg = img.data[o + 1], bb = img.data[o + 2];
    if (bb < 230) continue;
    const i = Math.round((rr - 30) / 30) + 8 * Math.round((gg - 30) / 30);
    const [pr, pg] = palette(i); if (Math.abs(rr - pr) > 8 || Math.abs(gg - pg) > 8) continue;
    const a = acc.get(i) ?? { x: 0, y: 0, n: 0, edge: false };
    // Cut blocks give a skewed centre: skip those touching the image border or
    // the grey (128) outside of a rendered photo.
    const grey = (xx: number, yy: number) => { const q = (yy * img.width + xx) * 3; return img.data[q] === 128 && img.data[q + 1] === 128 && img.data[q + 2] === 128; };
    a.x += x + 0.5; a.y += y + 0.5; a.n++;
    a.edge ||= x === 0 || y === 0 || x === img.width - 1 || y === img.height - 1
      || grey(x - 1, y) || grey(x + 1, y) || grey(x, y - 1) || grey(x, y + 1);
    acc.set(i, a);
  }
  const out = new Map<number, Pt>();
  for (const [i, a] of acc) if (a.n >= 4 && !a.edge) out.set(i, { x: a.x / a.n, y: a.y / a.n });
  return out;
}
const colourMatcher = (outliers: number): Matcher => async (ref, photo) => {
  const A = blobs(ref); const B = blobs(photo); const pa: Pt[] = []; const pb: Pt[] = [];
  for (const [i, p] of A) { const q = B.get(i); if (q) { pa.push(p); pb.push(q); } }
  const r = mulberry32(pa.length + 3);
  for (let k = 0; k < outliers; k++) { pa.push({ x: r() * ref.width, y: r() * ref.height }); pb.push({ x: r() * photo.width, y: r() * photo.height }); }
  return { pa, pb };
};
// Corners from a rectangle in base pixels, turned `deg` CCW on the map, scaled and shifted, about its centre.
function placed(aerial: AerialImage, deg: number, s: number, dx: number, dy: number): Corners {
  const cx = 400, cy = 300; const t = (deg * Math.PI) / 180;
  return ([[100, 80], [700, 80], [700, 520], [100, 520]] as const).map(([x, y]) => {
    const u = (x - cx) * s, v = (y - cy) * s;
    // CCW on a north-up map = clockwise in pixel y-down
    const px = cx + u * Math.cos(t) + v * Math.sin(t) + dx; const py = cy - u * Math.sin(t) + v * Math.cos(t) + dy;
    return aerialToLatLng(aerial, px, py);
  }) as Corners;
}
function photoFrom(aerial: AerialImage, corners: Corners): Rgb {
  const W = 600, H = 440;
  const photoToBase = solveHomography([[0, 0], [W, 0], [W, H], [0, H]], corners.map(c => aerialToPx(aerial, c)));
  const src: Rgb = { data: new Uint8Array(aerial.rgb), width: aerial.width, height: aerial.height };
  return warpInto(src, invertHomography(photoToBase), W, H, 0).img;
}
const P = (a: AerialImage) => ({ coarseMPerPx: a.mPerPx, fineMPerPx: a.mPerPx, tile: 256, overlap: 32, coarseThrM: 0.25, fineThrM: 0.12, erodeM: 0.2 });

describe('runAlignPipeline', () => {
  it('moves a rough placement onto the aerial within centimetres, through outliers', async () => {
    const aerial = scene();
    const truth = placed(aerial, 3, 1, 0, 0);
    const photo = photoFrom(aerial, truth);
    const rough = placed(aerial, 7, 1.04, 25, -15);
    const progress: string[] = [];
    const out = await runAlignPipeline({ photo, corners: rough, aerial, matcher: colourMatcher(8), params: P(aerial), onProgress: (ph, d, t) => progress.push(`${ph}:${d}/${t}`) });
    expect(out.corners).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      const [x, y] = aerialToPx(aerial, out.corners![i]); const [tx, ty] = aerialToPx(aerial, truth[i]);
      expect(Math.hypot(x - tx, y - ty) * aerial.mPerPx).toBeLessThan(0.05);
    }
    expect(out.correction!.rotDegCcw).toBeCloseTo(-4, 1);
    expect(out.correction!.scale).toBeCloseTo(1 / 1.04, 2);
    expect(out.coarse!.inliers).toBeGreaterThan(15);
    expect(progress[0]).toBe('coarse:1/1');
    expect(progress.some(p => p.startsWith('fine:'))).toBe(true);
  });

  it('returns no corners when the matcher finds nothing', async () => {
    const aerial = scene(); const truth = placed(aerial, 0, 1, 0, 0);
    const out = await runAlignPipeline({ photo: photoFrom(aerial, truth), corners: truth, aerial, matcher: async () => ({ pa: [], pb: [] }), params: P(aerial) });
    expect(out.corners).toBeNull();
    expect(checkGuards(out)).toBe('no_match');
  });
});

describe('checkGuards', () => {
  const ok: AlignOutput = {
    corners: [{ lat: 0, lng: 0 }, { lat: 0, lng: 0 }, { lat: 0, lng: 0 }, { lat: 0, lng: 0 }],
    coarse: { inliers: 90, hull: 0.5, rmsM: 0.1 }, fine: { inliers: 190, hull: 0.6, rmsM: 0.08 },
    correction: { rotDegCcw: 2.9, scale: 1.026, shiftE: 0.3, shiftN: 0.5 },
  };
  it('accepts a sound result', () => { expect(checkGuards(ok)).toBeNull(); });
  it('rejects too few matches, a small overlap, and an implausible correction such as 90 degrees', () => {
    expect(checkGuards({ ...ok, fine: { inliers: 60, hull: 0.6, rmsM: 0.1 } })).toBe('few_matches');
    expect(checkGuards({ ...ok, coarse: { inliers: 90, hull: 0.1, rmsM: 0.1 } })).toBe('small_overlap');
    expect(checkGuards({ ...ok, correction: { ...ok.correction!, rotDegCcw: 90 } })).toBe('implausible');
    expect(checkGuards({ ...ok, correction: { ...ok.correction!, scale: 1.3 } })).toBe('implausible');
    expect(checkGuards({ ...ok, correction: { ...ok.correction!, shiftE: 20 } })).toBe('implausible');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/services/droneAlign/alignPipeline.test.ts`
Expected: FAIL with "Failed to resolve import ../../../services/droneAlign/alignPipeline.js".

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/droneAlign/alignPipeline.ts
/**
 * Align a roughly placed drone photo to an aerial image. Coarse pass on the
 * whole image, fine pass in overlapping tiles, each: render the photo with
 * the current placement into the level grid, match, fit a similarity
 * (true -> placed) with RANSAC and Tukey refinement, and undo it on the
 * corners. Same protocol as the offline spike (spec, feit 5).
 */
import { aerialToPx, aerialToLatLng, type AerialImage } from '../aerialTiles.js';
import { solveHomography } from '../homography.js';
import { applySim, invertSim, fitSimilarity, ransacSimilarity, simParams, convexHullArea, polygonArea, dedupIndices, type Pt } from './alignGeometry.js';
import { warpInto, resizeRgb, resizeMask, cropRgb, tileOrigins, type Rgb } from './alignImage.js';
import { photoWidthM, type Corners } from './photoGeometry.js';

export type Matcher = (ref: Rgb, photo: Rgb) => Promise<{ pa: Pt[]; pb: Pt[] }>;
export interface AlignParams { coarseMPerPx: number; fineMPerPx: number; tile: number; overlap: number; coarseThrM: number; fineThrM: number; erodeM: number }
export const DEFAULT_PARAMS: AlignParams = { coarseMPerPx: 0.15, fineMPerPx: 0.075, tile: 384, overlap: 64, coarseThrM: 0.5, fineThrM: 0.25, erodeM: 1.0 };
export interface PassStats { inliers: number; hull: number; rmsM: number | null }
export interface AlignOutput {
  corners: Corners | null;
  coarse: PassStats | null; fine: PassStats | null;
  correction: { rotDegCcw: number; scale: number; shiftE: number; shiftN: number } | null;
}
export interface AlignInput {
  photo: Rgb; corners: Corners; aerial: AerialImage; matcher: Matcher;
  params?: Partial<AlignParams>;
  onProgress?: (phase: 'coarse' | 'fine', done: number, total: number) => void;
}

export const GUARDS = { coarseMinInliers: 30, coarseMinHull: 0.3, fineMinInliers: 100, fineMinHull: 0.35, scaleMin: 0.85, scaleMax: 1.15, maxRotDeg: 12, maxShiftM: 12 } as const;
export type RejectReason = 'no_match' | 'few_matches' | 'small_overlap' | 'implausible';

/** Provisional thresholds from one garden (spec, afwijzingsregels). */
export function checkGuards(o: AlignOutput, g: typeof GUARDS = GUARDS): RejectReason | null {
  if (!o.corners || !o.coarse || !o.fine || !o.correction) return 'no_match';
  if (o.coarse.inliers < g.coarseMinInliers || o.fine.inliers < g.fineMinInliers) return 'few_matches';
  if (o.coarse.hull < g.coarseMinHull || o.fine.hull < g.fineMinHull) return 'small_overlap';
  const c = o.correction;
  if (c.scale < g.scaleMin || c.scale > g.scaleMax || Math.abs(c.rotDegCcw) > g.maxRotDeg || Math.hypot(c.shiftE, c.shiftN) > g.maxShiftM) return 'implausible';
  return null;
}

interface Level { kx: number; ky: number; mPerPx: number; ref: Rgb; refValid: Uint8Array; photo: Rgb }

async function makeLevel(inp: AlignInput, mPerPx: number): Promise<Level> {
  const a = inp.aerial;
  const w = Math.max(16, Math.round((a.width * a.mPerPx) / mPerPx));
  const h = Math.max(16, Math.round((a.height * a.mPerPx) / mPerPx));
  const base: Rgb = { data: new Uint8Array(a.rgb.buffer, a.rgb.byteOffset, a.rgb.length), width: a.width, height: a.height };
  const ref = w === a.width && h === a.height ? base : await resizeRgb(base, w, h);
  const refValid = w === a.width && h === a.height ? a.valid : resizeMask(a.valid, a.width, a.height, w, h);
  // Shrink the photo to about this level's ground resolution first (lanczos),
  // so the bilinear warp does not alias fine texture.
  const photoMPerPx = photoWidthM(inp.corners) / inp.photo.width;
  const f = Math.min(1, photoMPerPx / mPerPx);
  const photo = f < 0.95
    ? await resizeRgb(inp.photo, Math.max(1, Math.round(inp.photo.width * f)), Math.max(1, Math.round(inp.photo.height * f)))
    : inp.photo;
  return { kx: w / a.width, ky: h / a.height, mPerPx: (a.mPerPx * a.width) / w, ref, refValid, photo };
}

async function onePass(
  inp: AlignInput, L: Level, corners: Corners, tiled: boolean, thrM: number, P: AlignParams,
  progress: (done: number, total: number) => void,
): Promise<{ corners: Corners; stats: PassStats } | null> {
  const W = L.ref.width; const H = L.ref.height;
  const toLevel = (c: { lat: number; lng: number }): Pt => { const [x, y] = aerialToPx(inp.aerial, c); return { x: x * L.kx, y: y * L.ky }; };
  const lc = corners.map(toLevel);
  const pw = L.photo.width; const ph = L.photo.height;
  const hm = solveHomography([[0, 0], [pw, 0], [pw, ph], [0, ph]], lc.map(p => [p.x, p.y] as const));
  const { img: D, valid: V0 } = warpInto(L.photo, hm, W, H, Math.max(1, Math.round(P.erodeM / L.mPerPx)));
  const V = V0.map((v, i) => v & L.refValid[i]);

  let pa: Pt[] = []; let pb: Pt[] = [];
  if (!tiled) {
    ({ pa, pb } = await inp.matcher(L.ref, D));
    progress(1, 1);
  } else {
    const tiles = tileOrigins(V, W, H, P.tile, P.overlap);
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const m = await inp.matcher(cropRgb(L.ref, t.x, t.y, P.tile, P.tile), cropRgb(D, t.x, t.y, P.tile, P.tile));
      for (let k = 0; k < m.pa.length; k++) {
        pa.push({ x: m.pa[k].x + t.x, y: m.pa[k].y + t.y }); pb.push({ x: m.pb[k].x + t.x, y: m.pb[k].y + t.y });
      }
      progress(i + 1, tiles.length);
    }
  }
  // Keep pairs whose photo point lies on the (eroded) photo and whose aerial point on real imagery.
  const at = (m: Uint8Array, p: Pt) => { const x = Math.floor(p.x), y = Math.floor(p.y); return x >= 0 && y >= 0 && x < W && y < H && m[y * W + x] === 1; };
  const keep0 = pa.map((p, i) => at(V, pb[i]) && at(L.refValid, p));
  pa = pa.filter((_, i) => keep0[i]); pb = pb.filter((_, i) => keep0[i]);
  const keep = dedupIndices(pa, pb, 0.5);
  pa = keep.map(i => pa[i]); pb = keep.map(i => pb[i]);

  const r = ransacSimilarity(pa, pb, thrM / L.mPerPx);
  if (!r) return null;
  const inv = invertSim(r.sim);   // r.sim: true -> placed; undo it on the corners
  const out = lc.map(p => applySim(inv, p)).map(p => aerialToLatLng(inp.aerial, p.x / L.kx, p.y / L.ky)) as Corners;
  const hull = convexHullArea(pa.filter((_, i) => r.inliers[i])) / Math.max(1e-9, polygonArea(lc));
  return { corners: out, stats: { inliers: r.count, hull, rmsM: r.rmsPx === null ? null : r.rmsPx * L.mPerPx } };
}

export async function runAlignPipeline(inp: AlignInput): Promise<AlignOutput> {
  const P: AlignParams = { ...DEFAULT_PARAMS, ...inp.params };
  const none: AlignOutput = { corners: null, coarse: null, fine: null, correction: null };
  const coarse = await onePass(inp, await makeLevel(inp, P.coarseMPerPx), inp.corners, false, P.coarseThrM, P,
    (d, t) => inp.onProgress?.('coarse', d, t));
  if (!coarse) return none;
  const fine = await onePass(inp, await makeLevel(inp, P.fineMPerPx), coarse.corners, true, P.fineThrM, P,
    (d, t) => inp.onProgress?.('fine', d, t));
  if (!fine) return { ...none, coarse: coarse.stats };
  // The whole correction, start corners -> final corners, about the photo centre.
  const a = inp.corners.map(c => { const [x, y] = aerialToPx(inp.aerial, c); return { x, y }; });
  const b = fine.corners.map(c => { const [x, y] = aerialToPx(inp.aerial, c); return { x, y }; });
  const s = fitSimilarity(a, b)!;
  const centre = { x: a.reduce((t, p) => t + p.x, 0) / 4, y: a.reduce((t, p) => t + p.y, 0) / 4 };
  return { corners: fine.corners, coarse: coarse.stats, fine: fine.stats, correction: simParams(s, centre, inp.aerial.mPerPx) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/services/droneAlign/alignPipeline.test.ts`
Expected: PASS (4 tests). If the first test's rotation sign is off by a sign, the test is right: the rough placement is 4° further CCW than the truth, so the correction is −4° (clockwise). Fix the sign in the code, not the test.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/droneAlign/alignPipeline.ts server/src/__tests__/services/droneAlign/alignPipeline.test.ts
git commit -m "feat(server): drone photo alignment pipeline with coarse and tiled fine passes and guards"
```

### Task 6: Het model downloaden, controleren en bewaren

**Files:**
- Create: `server/src/services/droneAlign/alignModel.ts`
- Test: `server/src/__tests__/services/droneAlign/alignModel.test.ts`

**Interfaces:**
- Produces: `interface ModelSpec { file; url; size; sha256 }`, `DISK_MODEL: ModelSpec`, `modelsDir(): string`, `ensureModel(dir?, spec?, fetchImpl?): Promise<string>` (pad naar het gecontroleerde bestand).

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/services/droneAlign/alignModel.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { ensureModel, DISK_MODEL } from '../../../services/droneAlign/alignModel.js';

const body = Buffer.from('fake model bytes '.repeat(1000));
const sha = createHash('sha256').update(body).digest('hex');
let hits = 0; let server: http.Server; let url = '';
beforeAll(async () => {
  server = http.createServer((_req, res) => { hits++; res.writeHead(200, { 'content-length': body.length }); res.end(body); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/m.onnx`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

describe('ensureModel', () => {
  it('pins the published DISK model', () => {
    expect(DISK_MODEL.sha256).toBe('20b35e9d3c4e505ae718f25fc4a95a5ec666c001f18308e600a93d158b43b5a8');
    expect(DISK_MODEL.size).toBe(50161858);
  });

  it('downloads once, checks size and sha256, and reuses the verified file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'));
    const spec = { file: 'm.onnx', url, size: body.length, sha256: sha };
    const p = await ensureModel(dir, spec);
    expect(fs.readFileSync(p).equals(body)).toBe(true);
    const before = hits;
    expect(await ensureModel(dir, spec)).toBe(p);
    expect(hits).toBe(before);
  });

  it('refuses a file with the wrong checksum and leaves nothing behind', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'));
    await expect(ensureModel(dir, { file: 'm.onnx', url, size: body.length, sha256: '0'.repeat(64) })).rejects.toThrow(/checksum/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/services/droneAlign/alignModel.test.ts`
Expected: FAIL with "Failed to resolve import ../../../services/droneAlign/alignModel.js".

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/droneAlign/alignModel.ts
/**
 * The matcher model: downloaded on first use to STORAGE_PATH/models, like the
 * terrain model, never baked into the image. Checked against a pinned size
 * and sha256; written as .part and renamed, so a broken download never looks
 * like a model.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

export interface ModelSpec { file: string; url: string; size: number; sha256: string }

/** DISK + LightGlue, fabio-sim/LightGlue-ONNX v2.0 (Apache-2.0). */
export const DISK_MODEL: ModelSpec = {
  file: 'disk_lightglue_pipeline.ort.onnx',
  url: 'https://github.com/fabio-sim/LightGlue-ONNX/releases/download/v2.0/disk_lightglue_pipeline.ort.onnx',
  size: 50161858,
  sha256: '20b35e9d3c4e505ae718f25fc4a95a5ec666c001f18308e600a93d158b43b5a8',
};

export function modelsDir(): string {
  return path.resolve(process.env.STORAGE_PATH ?? './storage', 'models');
}

let pending: Promise<string> | null = null;

export function ensureModel(dir: string = modelsDir(), spec: ModelSpec = DISK_MODEL, fetchImpl: typeof fetch = fetch): Promise<string> {
  pending ??= download(dir, spec, fetchImpl).finally(() => { pending = null; });
  return pending;
}

async function download(dir: string, spec: ModelSpec, fetchImpl: typeof fetch): Promise<string> {
  const file = path.join(dir, spec.file);
  const marker = `${file}.sha256`;
  if (fs.existsSync(file) && fs.statSync(file).size === spec.size
    && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === spec.sha256) return file;
  fs.mkdirSync(dir, { recursive: true });
  const part = `${file}.part`;
  const res = await fetchImpl(spec.url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`model download failed: HTTP ${res.status}`);
  const hash = createHash('sha256');
  let size = 0;
  const out = fs.createWriteStream(part);
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk); size += chunk.length;
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
    }
    await new Promise<void>((resolve, reject) => { out.once('error', reject); out.end(() => resolve()); });
  } catch (e) {
    out.destroy(); fs.rmSync(part, { force: true });
    throw e;
  }
  const digest = hash.digest('hex');
  if (size !== spec.size || digest !== spec.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`model checksum mismatch (${size} bytes, sha256 ${digest})`);
  }
  fs.renameSync(part, file);
  fs.writeFileSync(marker, spec.sha256);
  return file;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/services/droneAlign/alignModel.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/droneAlign/alignModel.ts server/src/__tests__/services/droneAlign/alignModel.test.ts
git commit -m "feat(server): download the drone alignment model once, pinned by size and sha256"
```

### Task 7: ONNX-matcher, het werkproces en de starter

**Files:**
- Modify: `server/package.json`, `server/package-lock.json` (onnxruntime-node exact `1.24.3` als directe dependency)
- Create: `server/src/services/droneAlign/onnxMatcher.ts`
- Create: `server/src/services/droneAlign/worker.ts`
- Create: `server/src/services/droneAlign/runner.ts`
- Test: `server/src/__tests__/services/droneAlign/worker.test.ts`

**Interfaces:**
- Consumes: Task 5 `runAlignPipeline`, `Matcher`, `AlignOutput`, `AlignParams`; Task 4 `pairTensor`, `Rgb`.
- Produces:
  - `parseMatches(kp: TensorLike, matches: TensorLike): { pa: Pt[]; pb: Pt[] }`, `createDiskMatcher(modelPath): Promise<{ match: Matcher; release(): Promise<void> }>`
  - `interface WorkerRequest { type: 'run'; modelPath: string; photo: Rgb; corners: Corners; aerial: AerialImage; params?: Partial<AlignParams> }`
  - `type WorkerMessage = { type: 'progress'; phase: 'coarse' | 'fine'; done: number; total: number } | { type: 'result'; output: AlignOutput; maxRssKb: number; ms: number } | { type: 'error'; message: string }`
  - `handleRequest(req, send, makeMatcher): Promise<void>`
  - `interface RunHandle { promise: Promise<{ output: AlignOutput; maxRssKb: number; ms: number }>; cancel(): void }`, `workerEntry(): string`, `runInChild(req, onProgress, timeoutMs): RunHandle`

- [ ] **Step 1: Pin onnxruntime-node as a direct dependency, without touching node_modules**

Run: `cd server && npm install --package-lock-only --save-exact onnxruntime-node@1.24.3`
Expected: `package.json` gains `"onnxruntime-node": "1.24.3"`; `package-lock.json` changes only in the root package's dependency list (the package is already in the tree at 1.24.3). Check: `git diff --stat server/package-lock.json` shows a small diff, and `grep -c '"node_modules/onnxruntime-node"' server/package-lock.json` prints `1`.

- [ ] **Step 2: Write the failing test**

```ts
// server/src/__tests__/services/droneAlign/worker.test.ts
import { describe, it, expect, vi } from 'vitest';
import { parseMatches } from '../../../services/droneAlign/onnxMatcher.js';
import { handleRequest, type WorkerMessage, type WorkerRequest } from '../../../services/droneAlign/worker.js';
import { workerEntry } from '../../../services/droneAlign/runner.js';

describe('parseMatches', () => {
  it('pairs keypoints of image 0 and 1 by the match rows, in pixel-edge coordinates', () => {
    const kp = { data: new Float32Array([10, 20, 30, 40, /* image 1 */ 11, 21, 31, 41]), dims: [2, 2, 2] };
    const matches = { data: new BigInt64Array([0n, 1n, 0n, 0n, 0n, 1n]), dims: [2, 3] };
    expect(parseMatches(kp, matches)).toEqual({
      pa: [{ x: 30.5, y: 40.5 }, { x: 10.5, y: 20.5 }],
      pb: [{ x: 11.5, y: 21.5 }, { x: 31.5, y: 41.5 }],
    });
  });
});

describe('handleRequest', () => {
  const req = {
    type: 'run', modelPath: '/x.onnx',
    photo: { data: new Uint8Array(16 * 16 * 3), width: 16, height: 16 },
    corners: [{ lat: 52.1, lng: 6.2 }, { lat: 52.1, lng: 6.2001 }, { lat: 52.0999, lng: 6.2001 }, { lat: 52.0999, lng: 6.2 }],
    aerial: { rgb: Buffer.alloc(64 * 64 * 3), width: 64, height: 64, valid: new Uint8Array(64 * 64).fill(1), zoom: 21, x0: 1084000, y0: 691000, mPerPx: 0.046, source: 'pdok', layer: '2025_orthoHR', attribution: '' },
  } as unknown as WorkerRequest;

  it('sends one result and releases the session', async () => {
    const sent: WorkerMessage[] = []; const release = vi.fn(async () => {});
    await handleRequest(req, m => sent.push(m), async () => ({ match: async () => ({ pa: [], pb: [] }), release }));
    expect(sent.at(-1)!.type).toBe('result');
    expect(release).toHaveBeenCalledOnce();
  });
  it('sends an error when the model cannot be loaded', async () => {
    const sent: WorkerMessage[] = [];
    await handleRequest(req, m => sent.push(m), async () => { throw new Error('bad model'); });
    expect(sent).toEqual([{ type: 'error', message: 'bad model' }]);
  });
});

describe('workerEntry', () => {
  it('points next to the runner, in the same language', () => {
    expect(workerEntry()).toMatch(/droneAlign[/\\]worker\.(ts|js)$/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/services/droneAlign/worker.test.ts`
Expected: FAIL with "Failed to resolve import ../../../services/droneAlign/onnxMatcher.js".

- [ ] **Step 4: Write minimal implementation**

```ts
// server/src/services/droneAlign/onnxMatcher.ts
/**
 * DISK + LightGlue as one ONNX graph (fabio-sim/LightGlue-ONNX v2.0). Input:
 * a pair as (2,3,H,W) RGB in [0,1], H and W multiples of 16. Outputs:
 * keypoints (2,K,2) in pixel indices, matches (M,3) = [batch, idxA, idxB].
 */
import type { Matcher } from './alignPipeline.js';
import type { Pt } from './alignGeometry.js';
import { pairTensor } from './alignImage.js';

export interface TensorLike { data: ArrayLike<number | bigint>; dims: readonly number[] }

/** Matched keypoints, +0.5 so they use the pipeline's pixel-edge convention. */
export function parseMatches(kp: TensorLike, matches: TensorLike): { pa: Pt[]; pb: Pt[] } {
  const K = kp.dims[1]; const M = matches.dims[0];
  const at = (img: number, i: number, c: number) => Number(kp.data[(img * K + i) * 2 + c]);
  const pa: Pt[] = []; const pb: Pt[] = [];
  for (let m = 0; m < M; m++) {
    if (Number(matches.data[m * 3]) !== 0) continue;
    const i = Number(matches.data[m * 3 + 1]); const j = Number(matches.data[m * 3 + 2]);
    pa.push({ x: at(0, i, 0) + 0.5, y: at(0, i, 1) + 0.5 });
    pb.push({ x: at(1, j, 0) + 0.5, y: at(1, j, 1) + 0.5 });
  }
  return { pa, pb };
}

export async function createDiskMatcher(modelPath: string): Promise<{ match: Matcher; release(): Promise<void> }> {
  const mod = await import('onnxruntime-node');
  const ort = ((mod as { default?: typeof mod }).default ?? mod) as typeof mod;
  const session = await ort.InferenceSession.create(modelPath, {
    intraOpNumThreads: 1, interOpNumThreads: 1, enableCpuMemArena: false,
    executionMode: 'sequential', graphOptimizationLevel: 'all', logSeverityLevel: 3,
  });
  const match: Matcher = async (ref, photo) => {
    const { data, dims } = pairTensor(ref, photo, 16);
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, dims) });
    return parseMatches(out[session.outputNames[0]] as unknown as TensorLike, out[session.outputNames[1]] as unknown as TensorLike);
  };
  return { match, release: () => session.release() };
}
```

```ts
// server/src/services/droneAlign/worker.ts
/**
 * Child process for one drone photo alignment (child_process.fork with
 * serialization 'advanced'). The ONNX session blocks its thread for seconds
 * and takes about 0.6 GB; in a child neither touches the server or the
 * mowers' broker, and all of it goes back to the OS when the job ends.
 */
import { runAlignPipeline, type AlignOutput, type AlignParams, type Matcher } from './alignPipeline.js';
import type { AerialImage } from '../aerialTiles.js';
import type { Rgb } from './alignImage.js';
import type { Corners } from './photoGeometry.js';

export interface WorkerRequest { type: 'run'; modelPath: string; photo: Rgb; corners: Corners; aerial: AerialImage; params?: Partial<AlignParams> }
export type WorkerMessage =
  | { type: 'progress'; phase: 'coarse' | 'fine'; done: number; total: number }
  | { type: 'result'; output: AlignOutput; maxRssKb: number; ms: number }
  | { type: 'error'; message: string };

export async function handleRequest(
  req: WorkerRequest, send: (m: WorkerMessage) => void,
  makeMatcher: (modelPath: string) => Promise<{ match: Matcher; release(): Promise<void> }>,
): Promise<void> {
  const t0 = Date.now();
  try {
    const m = await makeMatcher(req.modelPath);
    try {
      const output = await runAlignPipeline({
        photo: req.photo, corners: req.corners, aerial: req.aerial, matcher: m.match, params: req.params,
        onProgress: (phase, done, total) => send({ type: 'progress', phase, done, total }),
      });
      send({ type: 'result', output, maxRssKb: process.resourceUsage().maxRSS, ms: Date.now() - t0 });
    } finally {
      await m.release();
    }
  } catch (e) {
    send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

// Only when started by runInChild: a test runner that forks its own workers
// also has process.send, and must not have its messages taken here.
if (process.env.OPENNOVA_ALIGN_WORKER === '1' && process.send) {
  process.once('message', (req: WorkerRequest) => {
    void (async () => {
      const { createDiskMatcher } = await import('./onnxMatcher.js');
      await handleRequest(req, m => process.send!(m), createDiskMatcher);
      process.exit(0);
    })();
  });
}
```

```ts
// server/src/services/droneAlign/runner.ts
/** Starts the alignment worker in a child process and follows it to one result. */
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import type { WorkerMessage, WorkerRequest } from './worker.js';
import type { AlignOutput } from './alignPipeline.js';

export interface RunHandle { promise: Promise<{ output: AlignOutput; maxRssKb: number; ms: number }>; cancel(): void }

/** worker.ts under tsx (dev), worker.js in the built server. */
export function workerEntry(): string {
  return fileURLToPath(import.meta.url).replace(/runner\.(ts|js)$/, 'worker.$1');
}

export function runInChild(
  req: WorkerRequest,
  onProgress: (m: Extract<WorkerMessage, { type: 'progress' }>) => void,
  timeoutMs: number,
): RunHandle {
  const child = fork(workerEntry(), [], {
    serialization: 'advanced',
    env: { ...process.env, OPENNOVA_ALIGN_WORKER: '1' },
    execArgv: process.execArgv,
  });
  let cancel: () => void = () => {};
  const promise = new Promise<{ output: AlignOutput; maxRssKb: number; ms: number }>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timer); fn();
      if (child.exitCode === null) child.kill('SIGKILL');
    };
    const timer = setTimeout(() => done(() => reject(new Error('timeout'))), timeoutMs);
    cancel = () => done(() => reject(new Error('cancelled')));
    child.on('message', (m: WorkerMessage) => {
      if (m.type === 'progress') onProgress(m);
      else if (m.type === 'result') done(() => resolve({ output: m.output, maxRssKb: m.maxRssKb, ms: m.ms }));
      else done(() => reject(new Error(m.message)));
    });
    child.on('exit', code => done(() => reject(new Error(`worker exited (${code})`))));
    child.on('error', e => done(() => reject(e)));
    child.send(req);
  });
  return { promise, cancel: () => cancel() };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx tsc --noEmit && npx vitest run src/__tests__/services/droneAlign/worker.test.ts`
Expected: tsc clean; PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json server/src/services/droneAlign/onnxMatcher.ts server/src/services/droneAlign/worker.ts server/src/services/droneAlign/runner.ts server/src/__tests__/services/droneAlign/worker.test.ts
git commit -m "feat(server): run the DISK+LightGlue matcher in a child process for drone photo alignment"
```

### Task 8: De uitlijnjob: geheugen, slot, voortgang, annuleren

**Files:**
- Create: `server/src/services/droneAlign/index.ts`
- Test: `server/src/__tests__/services/droneAlign/alignJob.test.ts`

**Interfaces:**
- Consumes: Task 1 `tryAcquireHeavy`, `releaseHeavy`, `containerHeadroomMb`, `isClassifierLoaded`, `unloadClassifier`; Task 2 `fetchAerial`, `PDOK_ALIGN_LAYER`; Task 4 `decodeScaled`, `photoWidthM`; Task 5 `checkGuards`, `DEFAULT_PARAMS`; Task 6 `ensureModel`; Task 7 `runInChild`, `RunHandle`, `WorkerRequest`.
- Produces:
  - `type AlignPhase = 'model' | 'aerial' | 'coarse' | 'fine' | 'done' | 'rejected' | 'error' | 'cancelled'`
  - `type AlignFailure = RejectReason | 'offline' | 'no_imagery' | 'too_large' | 'model_download' | 'worker' | 'timeout'`
  - `interface AlignProposal { corners: Corners; correction: { rotDegCcw: number; scalePct: number; shiftM: number }; inliers: number; hull: number; source: string; layer: string | null; zoom: number; mPerPx: number; attribution: string; capturedAt: string }`
  - `interface AlignJob { sn; phase: AlignPhase; progress: number; startedAt: number; endedAt?: number; result?: AlignProposal; reason?: AlignFailure; stats?: { maxRssKb: number; ms: number } }`
  - `type StartResult = { ok: true; job: AlignJob } | { ok: false; status: 404 | 409 | 503; reason: 'disabled' | 'busy' | 'busy_model' | 'low_memory' | 'no_photo' }`
  - `startAlign(sn, photo: { file: string; width: number; height: number } | null, corners, deps?): Promise<StartResult>`, `getAlign(sn): AlignJob | null`, `cancelAlign(sn): boolean`, `interface AlignDeps`, `_resetAlignForTest()`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/services/droneAlign/alignJob.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startAlign, getAlign, cancelAlign, _resetAlignForTest, type AlignDeps } from '../../../services/droneAlign/index.js';
import { heavyHolder, releaseHeavy } from '../../../services/heavyWork.js';
import type { AlignOutput } from '../../../services/droneAlign/alignPipeline.js';
import type { Corners } from '../../../services/droneAlign/photoGeometry.js';

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'align-')), 'p.png');
fs.writeFileSync(file, 'x');
const photo = { file, width: 1720, height: 980 };
const corners: Corners = [
  { lat: 52.141106206, lng: 6.230654518 }, { lat: 52.141079422, lng: 6.231540836 },
  { lat: 52.140769495, lng: 6.231515970 }, { lat: 52.140796280, lng: 6.230629652 },
];
const good: AlignOutput = {
  corners, coarse: { inliers: 95, hull: 0.55, rmsM: 0.1 }, fine: { inliers: 190, hull: 0.6, rmsM: 0.08 },
  correction: { rotDegCcw: 2.9, scale: 1.026, shiftE: -0.3, shiftN: -0.5 },
};
const aerial = { rgb: Buffer.alloc(3), width: 1, height: 1, valid: new Uint8Array(1), zoom: 21, x0: 0, y0: 0, mPerPx: 0.046, source: 'pdok' as const, layer: '2025_orthoHR', attribution: 'PDOK' };

function deps(over: Partial<AlignDeps> = {}): AlignDeps & { cancelSpy: ReturnType<typeof vi.fn> } {
  const cancelSpy = vi.fn();
  return {
    headroomMb: () => 1500, unloadClassifier: async () => {}, isClassifierLoaded: () => false,
    ensureModel: async () => '/m.onnx', fetchAerial: async () => ({ image: aerial }),
    decodePhoto: async () => ({ data: new Uint8Array(3), width: 1, height: 1 }),
    run: () => ({ promise: Promise.resolve({ output: good, maxRssKb: 1, ms: 1 }), cancel: cancelSpy }),
    now: () => Date.now(), cancelSpy, ...over,
  };
}
const settle = (sn: string, phase: string) => vi.waitFor(() => expect(getAlign(sn)?.phase).toBe(phase));

beforeEach(() => { _resetAlignForTest(); delete process.env.DRONE_ALIGN; });
afterEach(() => { releaseHeavy('drone-align'); });

describe('startAlign', () => {
  it('runs to a proposal and releases the heavy-work lock', async () => {
    const r = await startAlign('A', photo, corners, deps());
    expect(r.ok).toBe(true);
    await settle('A', 'done');
    const j = getAlign('A')!;
    expect(j.result!.correction.scalePct).toBeCloseTo(2.6, 1);
    expect(j.result!.source).toBe('pdok');
    expect(j.result!.layer).toBe('2025_orthoHR');
    expect(heavyHolder()).toBeNull();
  });

  it('rejects with the guard reason, or the aerial reason when there is no imagery', async () => {
    await startAlign('A', photo, corners, deps({ run: () => ({ promise: Promise.resolve({ output: { ...good, fine: { inliers: 50, hull: 0.6, rmsM: 0.1 } }, maxRssKb: 1, ms: 1 }), cancel() {} }) }));
    await settle('A', 'rejected');
    expect(getAlign('A')!.reason).toBe('few_matches');
    _resetAlignForTest();
    await startAlign('A', photo, corners, deps({ fetchAerial: async () => ({ image: null, reason: 'offline' }) }));
    await settle('A', 'rejected');
    expect(getAlign('A')!.reason).toBe('offline');
  });

  it('is one job per server: same mower gets the running job, another mower a 409', async () => {
    const hang = deps({ run: () => ({ promise: new Promise(() => {}), cancel() {} }) });
    const first = await startAlign('A', photo, corners, hang);
    expect((await startAlign('A', photo, corners, hang))).toEqual(first);
    expect(await startAlign('B', photo, corners, hang)).toEqual({ ok: false, status: 409, reason: 'busy' });
  });

  it('cancels a running job and frees the lock', async () => {
    let reject!: (e: Error) => void;
    const d = deps({ run: () => ({ promise: new Promise((_, rj) => { reject = rj; }), cancel: () => reject(new Error('cancelled')) }) });
    await startAlign('A', photo, corners, d);
    await settle('A', 'coarse');
    expect(cancelAlign('A')).toBe(true);
    await vi.waitFor(() => expect(heavyHolder()).toBeNull());
    expect(getAlign('A')!.phase).toBe('cancelled');
    expect(cancelAlign('B')).toBe(false);
  });

  it('refuses when memory is short, the terrain model will not go, it is disabled, or there is no photo', async () => {
    expect(await startAlign('A', photo, corners, deps({ headroomMb: () => 100 }))).toEqual({ ok: false, status: 409, reason: 'low_memory' });
    expect(await startAlign('A', photo, corners, deps({ isClassifierLoaded: () => true }))).toEqual({ ok: false, status: 409, reason: 'busy_model' });
    expect(heavyHolder()).toBeNull();
    process.env.DRONE_ALIGN = '0';
    expect(await startAlign('A', photo, corners, deps())).toEqual({ ok: false, status: 503, reason: 'disabled' });
    delete process.env.DRONE_ALIGN;
    expect(await startAlign('A', null, corners, deps())).toEqual({ ok: false, status: 404, reason: 'no_photo' });
  });

  it('reports a failed model download as an error', async () => {
    await startAlign('A', photo, corners, deps({ ensureModel: async () => { throw new Error('HTTP 404'); } }));
    await settle('A', 'error');
    expect(getAlign('A')!.reason).toBe('model_download');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/services/droneAlign/alignJob.test.ts`
Expected: FAIL with "Failed to resolve import ../../../services/droneAlign/index.js".

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/droneAlign/index.ts
/**
 * One drone photo alignment at a time: check memory, take the heavy-work
 * lock (the terrain model must be gone), download the model once, fetch the
 * aerial, decode the photo at working size, run the matcher in a child
 * process, and turn its output into a proposal or a reason.
 */
import fs from 'fs';
import { tryAcquireHeavy, releaseHeavy, containerHeadroomMb } from '../heavyWork.js';
import { isClassifierLoaded, unloadClassifier } from '../terrainClassifier.js';
import { fetchAerial, PDOK_ALIGN_LAYER, type LatLng } from '../aerialTiles.js';
import { ensureModel } from './alignModel.js';
import { decodeScaled, type Rgb } from './alignImage.js';
import { photoWidthM, type Corners } from './photoGeometry.js';
import { checkGuards, DEFAULT_PARAMS, type RejectReason } from './alignPipeline.js';
import { runInChild, type RunHandle } from './runner.js';
import type { WorkerRequest } from './worker.js';

export type AlignPhase = 'model' | 'aerial' | 'coarse' | 'fine' | 'done' | 'rejected' | 'error' | 'cancelled';
export type AlignFailure = RejectReason | 'offline' | 'no_imagery' | 'too_large' | 'model_download' | 'worker' | 'timeout';
export interface AlignProposal {
  corners: Corners;
  correction: { rotDegCcw: number; scalePct: number; shiftM: number };
  inliers: number; hull: number;
  source: string; layer: string | null; zoom: number; mPerPx: number; attribution: string; capturedAt: string;
}
export interface AlignJob {
  sn: string; phase: AlignPhase; progress: number; startedAt: number; endedAt?: number;
  result?: AlignProposal; reason?: AlignFailure;
  /** The worker's peak memory and run time, for the Pi measurement (Task 12). */
  stats?: { maxRssKb: number; ms: number };
}
export type StartResult =
  | { ok: true; job: AlignJob }
  | { ok: false; status: 404 | 409 | 503; reason: 'disabled' | 'busy' | 'busy_model' | 'low_memory' | 'no_photo' };
export interface AlignDeps {
  headroomMb: () => number | null;
  unloadClassifier: () => Promise<void>;
  isClassifierLoaded: () => boolean;
  ensureModel: () => Promise<string>;
  fetchAerial: typeof fetchAerial;
  decodePhoto: (file: string, targetWidth: number) => Promise<Rgb>;
  run: (req: WorkerRequest, onProgress: (phase: 'coarse' | 'fine', done: number, total: number) => void, timeoutMs: number) => RunHandle;
  now: () => number;
}

const defaultDeps: AlignDeps = {
  headroomMb: () => containerHeadroomMb(),
  unloadClassifier, isClassifierLoaded,
  ensureModel: () => ensureModel(),
  fetchAerial,
  decodePhoto: (file, w) => decodeScaled(file, w),
  run: (req, onProgress, t) => runInChild(req, m => onProgress(m.phase, m.done, m.total), t),
  now: () => Date.now(),
};

const TERMINAL = new Set<AlignPhase>(['done', 'rejected', 'error', 'cancelled']);
const MIN_FREE_MB = Number(process.env.DRONE_ALIGN_MIN_FREE_MB ?? 900);
const TIMEOUT_MS = Number(process.env.DRONE_ALIGN_TIMEOUT_MS ?? 600_000);
const MARGIN_M = 12;
const KEEP_FINISHED_MS = 10 * 60_000;

let job: AlignJob | null = null;
let handle: RunHandle | null = null;

export function _resetAlignForTest(): void { job = null; handle = null; }

function boxAround(corners: Corners, marginM: number): { sw: LatLng; ne: LatLng } {
  const lat0 = corners.reduce((s, c) => s + c.lat, 0) / 4;
  const dLat = marginM / 111_320; const dLng = marginM / (111_320 * Math.cos((lat0 * Math.PI) / 180));
  return {
    sw: { lat: Math.min(...corners.map(c => c.lat)) - dLat, lng: Math.min(...corners.map(c => c.lng)) - dLng },
    ne: { lat: Math.max(...corners.map(c => c.lat)) + dLat, lng: Math.max(...corners.map(c => c.lng)) + dLng },
  };
}

export async function startAlign(
  sn: string, photo: { file: string; width: number; height: number } | null, corners: Corners, deps: AlignDeps = defaultDeps,
): Promise<StartResult> {
  if (process.env.DRONE_ALIGN === '0') return { ok: false, status: 503, reason: 'disabled' };
  if (job && !TERMINAL.has(job.phase)) return job.sn === sn ? { ok: true, job } : { ok: false, status: 409, reason: 'busy' };
  if (!photo || !fs.existsSync(photo.file)) return { ok: false, status: 404, reason: 'no_photo' };
  const free = deps.headroomMb();
  if (free !== null && free < MIN_FREE_MB) return { ok: false, status: 409, reason: 'low_memory' };
  if (!tryAcquireHeavy('drone-align')) return { ok: false, status: 409, reason: 'busy_model' };
  await deps.unloadClassifier();
  if (deps.isClassifierLoaded()) { releaseHeavy('drone-align'); return { ok: false, status: 409, reason: 'busy_model' }; }
  const j: AlignJob = { sn, phase: 'model', progress: 0, startedAt: deps.now() };
  job = j;
  void runJob(j, photo, corners, deps).finally(() => { releaseHeavy('drone-align'); handle = null; j.endedAt = deps.now(); });
  return { ok: true, job: j };
}

async function runJob(j: AlignJob, photo: { file: string }, corners: Corners, deps: AlignDeps): Promise<void> {
  const fail = (phase: 'rejected' | 'error', reason: AlignFailure) => {
    if (j.phase === 'cancelled') return;
    j.phase = phase; j.reason = reason;
  };
  try {
    let modelPath: string;
    try { modelPath = await deps.ensureModel(); } catch (e) {
      console.warn('[drone-align] model download failed:', e instanceof Error ? e.message : e);
      return fail('error', 'model_download');
    }
    if (j.phase === 'cancelled') return;
    j.phase = 'aerial';
    const { sw, ne } = boxAround(corners, MARGIN_M);
    const aerial = await deps.fetchAerial(sw, ne, { pdokLayer: PDOK_ALIGN_LAYER, esriMaxZoom: 20 });
    if (!aerial.image) return fail('rejected', aerial.reason);
    if (j.phase === 'cancelled') return;
    const img = await deps.decodePhoto(photo.file, Math.ceil(photoWidthM(corners) / DEFAULT_PARAMS.fineMPerPx));
    j.phase = 'coarse';
    handle = deps.run({ type: 'run', modelPath, photo: img, corners, aerial: aerial.image }, (phase, done, total) => {
      if (TERMINAL.has(j.phase)) return;
      j.phase = phase; j.progress = total ? done / total : 0;
    }, TIMEOUT_MS);
    let out;
    try {
      const done = await handle.promise;
      out = done.output;
      j.stats = { maxRssKb: done.maxRssKb, ms: done.ms };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== 'cancelled') console.warn('[drone-align] worker failed:', msg);
      return fail('error', msg === 'timeout' ? 'timeout' : 'worker');
    }
    const why = checkGuards(out);
    if (why) return fail('rejected', why);
    const c = out.correction!;
    j.result = {
      corners: out.corners!,
      correction: { rotDegCcw: c.rotDegCcw, scalePct: (c.scale - 1) * 100, shiftM: Math.hypot(c.shiftE, c.shiftN) },
      inliers: out.fine!.inliers, hull: out.fine!.hull,
      source: aerial.image.source, layer: aerial.image.layer, zoom: aerial.image.zoom,
      mPerPx: aerial.image.mPerPx, attribution: aerial.image.attribution,
      capturedAt: new Date(deps.now()).toISOString(),
    };
    j.phase = 'done'; j.progress = 1;
  } catch (e) {
    console.warn('[drone-align] failed:', e instanceof Error ? e.message : e);
    fail('error', 'worker');
  }
}

export function getAlign(sn: string): AlignJob | null {
  if (!job || job.sn !== sn) return null;
  if (TERMINAL.has(job.phase) && job.endedAt && Date.now() - job.endedAt > KEEP_FINISHED_MS) { job = null; return null; }
  return job;
}

export function cancelAlign(sn: string): boolean {
  if (!job || job.sn !== sn || TERMINAL.has(job.phase)) return false;
  job.phase = 'cancelled';
  handle?.cancel();
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx tsc --noEmit && npx vitest run src/__tests__/services/droneAlign/alignJob.test.ts`
Expected: tsc clean; PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/droneAlign/index.ts server/src/__tests__/services/droneAlign/alignJob.test.ts
git commit -m "feat(server): drone photo alignment job with memory check, heavy-work lock and cancel"
```

### Task 9: Routes: uitlijnjob, meeschuivende pins, gedeelde foto's

**Files:**
- Modify: `server/src/routes/droneOverlay.ts` (`OverlayMeta.alignment`, `POST/GET/DELETE /:sn/align`, `PUT /:sn` met `pinsFollow` en `alignment`)
- Modify: `server/src/services/apiText.catalog.ts` (vijf nieuwe zinnen)
- Test: `server/src/__tests__/routes/droneOverlayAlign.test.ts`

**Interfaces:**
- Consumes: Task 8 `startAlign`, `getAlign`, `cancelAlign`, `AlignJob`; Task 4 `photoToLatLng`, `latLngToPhoto`, `insidePhoto`; `posJsonRequested` (`services/posJsonGate.js`); `mapRepo.getCalibration`/`setCalibration`; `deviceSettingsRepo.listAll()`.
- Produces (HTTP):
  - `POST /api/dashboard/overlay/:sn/align` met body `{ corners, opacity? }` geeft 202 `{ phase, progress, startedAt, result?, reason? }`, of `{ status, error, reason }` met 400/404/409/503.
  - `GET /api/dashboard/overlay/:sn/align` geeft 200 met dezelfde vorm, of 404 `{ phase: 'none' }`.
  - `DELETE /api/dashboard/overlay/:sn/align` geeft `{ cancelled: boolean }`.
  - `PUT /api/dashboard/overlay/:sn` met body `{ corners, opacity, pinsFollow?: boolean, alignment?: { source, layer, zoom, capturedAt } }` geeft `{ sn, ...meta, movedPins: [{ sn, from, to }], updated: string[] }`, of 409 als een betrokken maaier in het posJsonGate-venster zit.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/routes/droneOverlayAlign.test.ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const align = vi.hoisted(() => ({ start: vi.fn(), get: vi.fn(), cancel: vi.fn() }));
vi.mock('../../services/droneAlign/index.js', () => ({ startAlign: align.start, getAlign: align.get, cancelAlign: align.cancel }));

import { droneOverlayRouter, similarityCorners } from '../../routes/droneOverlay.js';
import { photoToLatLng } from '../../services/droneAlign/photoGeometry.js';
import { mapRepo } from '../../db/repositories/index.js';
import { db } from '../../db/database.js';
import { requestPosJsonWrite } from '../../services/posJsonGate.js';

const storage = mkdtempSync(path.join(tmpdir(), 'overlay-align-'));
process.env.STORAGE_PATH = storage;
afterAll(() => rmSync(storage, { recursive: true, force: true }));

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12);
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b;
}
const app = express(); app.use(express.json()); app.use('/overlay', droneOverlayRouter);
const A = 'LFIN_ALIGN_A'; const B = 'LFIN_ALIGN_B'; const C = 'LFIN_ALIGN_C';
const size = { width: 1720, height: 980 };
const placedAt = (w: number, rot = 0) => ({ corners: similarityCorners({ lat: 52.1409, lng: 6.2311 }, w, rot, 1720 / 980), opacity: 0.8 });

beforeEach(() => {
  db.prepare('DELETE FROM device_settings WHERE key = ?').run('drone_overlay');
  for (const f of readdirSync(storage)) rmSync(path.join(storage, f), { recursive: true, force: true });
  align.start.mockReset(); align.get.mockReset(); align.cancel.mockReset();
});

async function sharedPhoto() {
  await request(app).put(`/overlay/${A}/image`).set('Content-Type', 'image/png').send(png(1720, 980));
  await request(app).put(`/overlay/${A}`).send(placedAt(60));
  await request(app).post(`/overlay/${B}/copy-from/${A}`);
  // C has a photo of its own: different size, never "shared".
  await request(app).put(`/overlay/${C}/image`).set('Content-Type', 'image/png').send(png(1000, 500));
  await request(app).put(`/overlay/${C}`).send(placedAt(60));
}

describe('align routes', () => {
  it('starts a job with the photo file and the draft corners', async () => {
    await sharedPhoto();
    align.start.mockResolvedValue({ ok: true, job: { sn: A, phase: 'model', progress: 0, startedAt: 1 } });
    const draft = placedAt(62, 3);
    const r = await request(app).post(`/overlay/${A}/align`).send(draft);
    expect(r.status).toBe(202);
    expect(r.body.phase).toBe('model');
    const [sn, photo, corners] = align.start.mock.calls[0];
    expect(sn).toBe(A);
    expect(photo.file).toMatch(/overlays[/\\]LFIN_ALIGN_A\.png$/);
    expect(photo.width).toBe(1720);
    expect(corners).toEqual(draft.corners);
  });

  it('passes a refusal on with its reason, reports a missing job and cancels', async () => {
    await sharedPhoto();
    align.start.mockResolvedValue({ ok: false, status: 409, reason: 'busy' });
    const r = await request(app).post(`/overlay/${A}/align`).send(placedAt(60));
    expect(r.status).toBe(409); expect(r.body.reason).toBe('busy'); expect(r.body.error).toBeTruthy();
    align.get.mockReturnValue(null);
    expect((await request(app).get(`/overlay/${A}/align`)).status).toBe(404);
    align.cancel.mockReturnValue(true);
    expect((await request(app).delete(`/overlay/${A}/align`)).body).toEqual({ cancelled: true });
  });

  it('refuses a malformed draft without starting anything', async () => {
    await sharedPhoto();
    expect((await request(app).post(`/overlay/${A}/align`).send({ corners: [] })).status).toBe(400);
    expect(align.start).not.toHaveBeenCalled();
  });
});

describe('PUT /overlay/:sn with pinsFollow', () => {
  it('moves the photo on every mower that shares it and carries each pin inside it along', async () => {
    await sharedPhoto();
    const old = placedAt(60).corners;
    const pinA = photoToLatLng(old, size, { u: 1306, v: 224 });
    const pinB = photoToLatLng(old, size, { u: 984, v: 802 });
    mapRepo.setCalibration(A, { charger_lat: pinA.lat, charger_lng: pinA.lng });
    mapRepo.setCalibration(B, { charger_lat: pinB.lat, charger_lng: pinB.lng });
    const next = { corners: similarityCorners({ lat: 52.14092, lng: 6.23112 }, 61.5, 2.9, 1720 / 980), opacity: 0.8 };
    const zonesBefore = JSON.stringify(db.prepare('SELECT map_id, map_area FROM maps ORDER BY map_id').all());
    const r = await request(app).put(`/overlay/${A}`).send({
      ...next, pinsFollow: true,
      alignment: { source: 'pdok', layer: '2025_orthoHR', zoom: 21, capturedAt: '2026-09-26T10:00:00.000Z' },
    });
    expect(r.status).toBe(200);
    expect([...r.body.updated].sort()).toEqual([A, B].sort());
    expect(r.body.movedPins).toHaveLength(2);
    for (const [sn, px] of [[A, { u: 1306, v: 224 }], [B, { u: 984, v: 802 }]] as const) {
      const cal = mapRepo.getCalibration(sn)!;
      const want = photoToLatLng(next.corners, size, px);
      expect(cal.charger_lat).toBeCloseTo(want.lat, 9);
      expect(cal.charger_lng).toBeCloseTo(want.lng, 9);
      const meta = (await request(app).get(`/overlay/${sn}`)).body;
      expect(meta.placement.corners).toEqual(next.corners);
      expect(meta.history.at(-1).corners).toEqual(old);
    }
    expect((await request(app).get(`/overlay/${C}`)).body.placement.corners).toEqual(old);
    expect((await request(app).get(`/overlay/${A}`)).body.alignment).toMatchObject({ source: 'pdok', zoom: 21, corners: next.corners });
    // Never touches the zones.
    expect(JSON.stringify(db.prepare('SELECT map_id, map_area FROM maps ORDER BY map_id').all())).toBe(zonesBefore);
  });

  it('leaves a pin outside the photo where it is', async () => {
    await sharedPhoto();
    mapRepo.setCalibration(A, { charger_lat: 52.2, charger_lng: 6.3 });
    await request(app).put(`/overlay/${A}`).send({ ...placedAt(61), pinsFollow: true });
    expect(mapRepo.getCalibration(A)!.charger_lat).toBe(52.2);
  });

  it('keeps the old behaviour without pinsFollow: this mower only, no pin moves', async () => {
    await sharedPhoto();
    mapRepo.setCalibration(A, { charger_lat: 52.1409, charger_lng: 6.2311 });
    await request(app).put(`/overlay/${A}`).send(placedAt(61));
    expect((await request(app).get(`/overlay/${B}`)).body.placement.corners).toEqual(placedAt(60).corners);
    expect(mapRepo.getCalibration(A)!.charger_lat).toBe(52.1409);
  });

  // Last in this file: the gate stays open for two minutes.
  it('refuses while a mower sharing the photo is rewriting its pos.json', async () => {
    await sharedPhoto();
    requestPosJsonWrite(B);
    const r = await request(app).put(`/overlay/${A}`).send({ ...placedAt(61), pinsFollow: true });
    expect(r.status).toBe(409);
    expect((await request(app).get(`/overlay/${A}`)).body.placement.corners).toEqual(placedAt(60).corners);
  });
});

describe('the alignment code stays away from the mower', () => {
  it('imports nothing from the MQTT layer', () => {
    const dir = fileURLToPath(new URL('../../services/droneAlign/', import.meta.url));
    const files = readdirSync(dir).map(f => path.join(dir, f))
      .concat(fileURLToPath(new URL('../../routes/droneOverlay.ts', import.meta.url)));
    for (const f of files) expect(readFileSync(f, 'utf8')).not.toMatch(/from '(\.\.\/)+mqtt\//);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/routes/droneOverlayAlign.test.ts`
Expected: FAIL: the POST returns 404 (no route), and the PUT test finds `updated` undefined.

- [ ] **Step 3: Write minimal implementation**

In `server/src/routes/droneOverlay.ts`, add the imports:

```ts
import { mapRepo } from '../db/repositories/index.js';
import { db } from '../db/database.js';
import { posJsonRequested } from '../services/posJsonGate.js';
import { startAlign, getAlign, cancelAlign, type AlignJob } from '../services/droneAlign/index.js';
import { photoToLatLng, latLngToPhoto, insidePhoto } from '../services/droneAlign/photoGeometry.js';
```

(`deviceSettingsRepo` already comes from `../db/repositories/index.js`; extend that import instead of adding a second line for `mapRepo`.)

Add to `OverlayMeta`, below `history?`:

```ts
  /** The last placement confirmed from an alignment to aerial imagery: the reference for the deviation warning. */
  alignment?: { corners: Corners; source: string; layer: string | null; zoom: number; capturedAt: string } | null;
```

Add these helpers below `snOr400`:

```ts
function parseAlignment(v: unknown): { source: string; layer: string | null; zoom: number; capturedAt: string } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.source !== 'string' || o.source.length > 20) return null;
  if (!(o.layer === null || (typeof o.layer === 'string' && o.layer.length <= 40))) return null;
  if (typeof o.zoom !== 'number' || !Number.isInteger(o.zoom) || o.zoom < 10 || o.zoom > 23) return null;
  if (typeof o.capturedAt !== 'string' || Number.isNaN(Date.parse(o.capturedAt))) return null;
  return { source: o.source, layer: o.layer as string | null, zoom: o.zoom, capturedAt: o.capturedAt };
}

const sameCorners = (a: Corners, b: Corners) => a.every((c, i) => Math.abs(c.lat - b[i].lat) < 1e-9 && Math.abs(c.lng - b[i].lng) < 1e-9);

/** This mower plus every other mower carrying the same photo in the same place (copy-from makes those). */
function sharingMowers(sn: string, meta: OverlayMeta): string[] {
  const out = [sn];
  if (!meta.placement) return out;
  for (const row of deviceSettingsRepo.listAll()) {
    if (row.key !== SETTING_KEY || row.sn === sn) continue;
    const other = readMeta(row.sn);
    if (other?.placement && other.width === meta.width && other.height === meta.height && other.size === meta.size
      && sameCorners(other.placement.corners, meta.placement.corners)) out.push(row.sn);
  }
  return out;
}

function publicJob(j: AlignJob) {
  return { phase: j.phase, progress: j.progress, startedAt: j.startedAt, result: j.result, reason: j.reason };
}
```

Replace the whole `droneOverlayRouter.put('/:sn', ...)` handler with:

```ts
// PUT /overlay/:sn — placement. With pinsFollow the photo moves on every mower
// that shares it, and each mower's dock pin inside the photo moves along, so
// it stays on the same spot of the photo. The pin is display-only for the
// mower (posJsonGate), so this never changes where a mower mows.
droneOverlayRouter.put('/:sn', (req, res) => {
  const sn = snOr400(req, res); if (!sn) return;
  const T = reqT(req);
  const meta = readMeta(sn);
  if (!meta) { res.status(404).json({ error: T`upload eerst een foto` }); return; }
  const placement = parsePlacement(req.body);
  if (!placement) { res.status(400).json({ error: T`plaatsing vereist hoeken (4 x lat/lng, 1 tot 3000 m uit elkaar) en dekking (0 tot 1)` }); return; }
  const body = (req.body ?? {}) as { pinsFollow?: unknown; alignment?: unknown };
  const follow = body.pinsFollow === true;
  const alignment = parseAlignment(body.alignment);
  const affected = follow ? sharingMowers(sn, meta) : [sn];
  if (follow && affected.some(s => posJsonRequested(s))) {
    res.status(409).json({ error: T`De maaier herschrijft nu zijn kaartoorsprong; probeer het over twee minuten opnieuw` });
    return;
  }
  const movedPins: Array<{ sn: string; from: LatLng; to: LatLng }> = [];
  db.transaction(() => {
    for (const s of affected) {
      const m = s === sn ? meta : readMeta(s);
      if (!m) continue;
      const nextPlacement: OverlayPlacement = s === sn ? placement : { corners: placement.corners, opacity: m.placement?.opacity ?? placement.opacity };
      const history = [...(m.history ?? []), ...(m.placement ? [m.placement] : [])].slice(-HISTORY_MAX);
      writeMeta(s, { ...m, placement: nextPlacement, history, alignment: alignment ? { corners: placement.corners, ...alignment } : m.alignment ?? null });
      if (!follow || !m.placement) continue;
      const cal = mapRepo.getCalibration(s);
      if (cal?.charger_lat == null || cal?.charger_lng == null) continue;
      const photoSize = { width: m.width, height: m.height };
      const from = { lat: cal.charger_lat, lng: cal.charger_lng };
      const px = latLngToPhoto(m.placement.corners, photoSize, from);
      if (!insidePhoto(px, photoSize)) continue;
      const to = photoToLatLng(placement.corners, photoSize, px);
      mapRepo.setCalibration(s, { charger_lat: to.lat, charger_lng: to.lng });
      movedPins.push({ sn: s, from, to });
    }
  })();
  const { file: _f, ...pub } = readMeta(sn)!;
  res.json({ sn, ...pub, movedPins, updated: affected });
});

// POST /overlay/:sn/align — start aligning the draft placement to aerial imagery.
droneOverlayRouter.post('/:sn/align', async (req, res) => {
  const sn = snOr400(req, res); if (!sn) return;
  const T = reqT(req);
  const placement = parsePlacement(req.body);
  if (!placement) { res.status(400).json({ error: T`plaatsing vereist hoeken (4 x lat/lng, 1 tot 3000 m uit elkaar) en dekking (0 tot 1)` }); return; }
  const meta = readMeta(sn);
  const photo = meta ? { file: path.join(storageDir(), meta.file), width: meta.width, height: meta.height } : null;
  const r = await startAlign(sn, photo, placement.corners);
  if (!r.ok) {
    const error = {
      disabled: T`Automatisch uitlijnen staat uit op deze server`,
      busy: T`Er loopt al een uitlijning voor een andere maaier; probeer het straks opnieuw`,
      busy_model: T`De terreinherkenning gebruikt het geheugen nu; probeer het over een minuut opnieuw`,
      low_memory: T`Te weinig vrij geheugen om de foto uit te lijnen`,
      no_photo: T`geen luchtfoto voor deze maaier`,
    }[r.reason];
    res.status(r.status).json({ error, reason: r.reason });
    return;
  }
  res.status(202).json(publicJob(r.job));
});

// GET /overlay/:sn/align — the running or last job for this mower.
droneOverlayRouter.get('/:sn/align', (req, res) => {
  const sn = snOr400(req, res); if (!sn) return;
  const j = getAlign(sn);
  if (!j) { res.status(404).json({ phase: 'none' }); return; }
  res.json(publicJob(j));
});

// DELETE /overlay/:sn/align — cancel.
droneOverlayRouter.delete('/:sn/align', (req, res) => {
  const sn = snOr400(req, res); if (!sn) return;
  res.json({ cancelled: cancelAlign(sn) });
});
```

In `server/src/services/apiText.catalog.ts`, add before the final `};`:

```ts
  "Automatisch uitlijnen staat uit op deze server": {
    en: "Automatic alignment is switched off on this server",
    fr: "L'alignement automatique est désactivé sur ce serveur",
    de: "Die automatische Ausrichtung ist auf diesem Server ausgeschaltet",
  },
  "Er loopt al een uitlijning voor een andere maaier; probeer het straks opnieuw": {
    en: "An alignment for another mower is running; try again shortly",
    fr: "Un alignement pour une autre tondeuse est en cours ; réessayez dans un instant",
    de: "Für einen anderen Mäher läuft bereits eine Ausrichtung; versuchen Sie es gleich noch einmal",
  },
  "De terreinherkenning gebruikt het geheugen nu; probeer het over een minuut opnieuw": {
    en: "Terrain recognition is using the memory right now; try again in a minute",
    fr: "La reconnaissance du terrain utilise la mémoire en ce moment ; réessayez dans une minute",
    de: "Die Geländeerkennung belegt gerade den Speicher; versuchen Sie es in einer Minute noch einmal",
  },
  "Te weinig vrij geheugen om de foto uit te lijnen": {
    en: "Not enough free memory to align the photo",
    fr: "Pas assez de mémoire libre pour aligner la photo",
    de: "Nicht genug freier Speicher, um das Foto auszurichten",
  },
  "De maaier herschrijft nu zijn kaartoorsprong; probeer het over twee minuten opnieuw": {
    en: "The mower is rewriting its map origin right now; try again in two minutes",
    fr: "La tondeuse réécrit en ce moment l'origine de sa carte ; réessayez dans deux minutes",
    de: "Der Mäher schreibt gerade seinen Kartenursprung neu; versuchen Sie es in zwei Minuten noch einmal",
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx tsc --noEmit && npx vitest run src/__tests__/routes/droneOverlayAlign.test.ts src/__tests__/routes/droneOverlay.test.ts src/__tests__/services/serverText.coverage.test.ts`
Expected: tsc clean; PASS for all three (the existing overlay tests still pass; the coverage test finds the five new sentences in every language).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/droneOverlay.ts server/src/services/apiText.catalog.ts server/src/__tests__/routes/droneOverlayAlign.test.ts
git commit -m "feat(server): align-to-aerial routes, and dock pins that follow a shared drone photo"
```

### Task 10: Release-smoke maakt echt een onnxruntime-sessie aan

**Files:**
- Modify: `release-beta.sh`, `release.sh` (smoke-regel)
- Test: `server/src/__tests__/releaseScript.test.ts`

**Interfaces:** geen code-interfaces; de smoke draait in de verse image vóór de push.

- [ ] **Step 1: Write the failing test**

Add to `server/src/__tests__/releaseScript.test.ts`, inside the file's top-level scope:

```ts
describe('release smoke', () => {
  it('creates and runs an onnxruntime session in the fresh image, in both release scripts', () => {
    for (const name of ['release.sh', 'release-beta.sh']) {
      const script = readFileSync(resolve(repoRoot, name), 'utf8');
      expect(script).toContain("import('onnxruntime-node')");
      expect(script).toContain('InferenceSession.create');
      expect(script).toContain("import('@huggingface/transformers')");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/releaseScript.test.ts -t "release smoke"`
Expected: FAIL: `expected ... to contain "import('onnxruntime-node')"`.

- [ ] **Step 3: Write minimal implementation**

In both `release-beta.sh` and `release.sh`, replace the `-e "import('@huggingface/transformers').then(...)"` line of the `docker run ... opennova-smoke` command with (one line; the base64 is a 79-byte ONNX Identity model, checked to run on onnxruntime-node 1.24.3):

```bash
  -e "Promise.all([import('@huggingface/transformers'),import('onnxruntime-node')]).then(async([,m])=>{const ort=m.default??m;const s=await ort.InferenceSession.create(Buffer.from('CAgSCG9wZW5ub3ZhOjsKEAoBeBIBeSIISWRlbnRpdHkSBXNtb2tlWg8KAXgSCgoICAESBAoCCAFiDwoBeRIKCggIARIECgIIAUIECgAQDQ==','base64'),{intraOpNumThreads:1});const r=await s.run({x:new ort.Tensor('float32',new Float32Array([7]),[1])});if(r.y.data[0]!==7)throw new Error('identity model gave '+r.y.data[0]);console.log('smoke OK');process.exit(0)}).catch(e=>{console.error('smoke FAALT:',e.message);process.exit(1)})"
```

Also update the comment above the smoke in `release-beta.sh` to say it now also loads onnxruntime and runs a tiny model (the drone photo alignment needs a real session, not only the import).

- [ ] **Step 4: Verify**

Run: `cd server && npx vitest run src/__tests__/releaseScript.test.ts`
Expected: PASS.
Run the new `-e` command on the host once: `cd server && node -e "<the same string>"`.
Expected: `smoke OK`.

- [ ] **Step 5: Commit**

```bash
git add release.sh release-beta.sh server/src/__tests__/releaseScript.test.ts
git commit -m "chore(release): smoke-test an onnxruntime session in the fresh image, not only the import"
```

### Task 11: Dashboard: uitlijnknop, voortgang, voorstel, afwijkingswaarschuwing

**Files:**
- Modify: `dashboard/src/api/client.ts`
- Modify: `dashboard/src/utils/droneOverlayMath.ts` (`placementDeviation`)
- Modify: `dashboard/src/components/map/MowerMap.tsx`
- Modify: `dashboard/src/i18n/locales/{nl,en,de,fr}.json`
- Test: `server/src/__tests__/services/droneOverlayMath.test.ts` (de dashboard-rekenkunde wordt daar getest)

**Interfaces:**
- Consumes: Task 9 HTTP-routes.
- Produces (client): `DroneAlignment`, `DroneAlignProposal`, `DroneAlignJob`, `startDroneAlign(sn, placement)`, `fetchDroneAlign(sn)`, `cancelDroneAlign(sn)`, `saveDroneOverlayPlacement(sn, placement, opts?)`; math: `placementDeviation(ref, cur): { rotDeg; scalePct; shiftM }`.

- [ ] **Step 1: Write the failing test**

Add to `server/src/__tests__/services/droneOverlayMath.test.ts` (extend the import from `droneOverlayMath.js` with `placementDeviation`):

```ts
describe('placementDeviation', () => {
  it('is zero for the same placement and reads rotation, scale and shift back', () => {
    expect(placementDeviation(rect, rect)).toEqual({ rotDeg: 0, scalePct: 0, shiftM: 0 });
    const turned = placementDeviation(rect, rotateCorners(rect, 2));
    expect(turned.rotDeg).toBeCloseTo(2, 6); expect(turned.shiftM).toBeCloseTo(0, 6);
    expect(placementDeviation(rect, scaleCorners(rect, 1.026)).scalePct).toBeCloseTo(2.6, 6);
    expect(placementDeviation(rect, translateCorners(rect, 1 / M_PER_DEG_LAT, 0)).shiftM).toBeCloseTo(1, 3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/services/droneOverlayMath.test.ts -t placementDeviation`
Expected: FAIL with "placementDeviation is not a function".

- [ ] **Step 3: Implement the math helper**

Add to `dashboard/src/utils/droneOverlayMath.ts`:

```ts
/**
 * How far a placement lies from a reference placement: rotation in degrees
 * (positive clockwise on screen, like rotateCorners), scale in percent and the
 * centre's shift in metres. Least squares over the four corners.
 */
export function placementDeviation(ref: DroneCorners, cur: DroneCorners): { rotDeg: number; scalePct: number; shiftM: number } {
  const f = frameAt(centroid(ref));
  const a = ref.map(c => toXY(f, c)); const b = cur.map(c => toXY(f, c));
  const mean = (p: XY[]) => ({ x: p.reduce((s, q) => s + q.x, 0) / p.length, y: p.reduce((s, q) => s + q.y, 0) / p.length });
  const ma = mean(a); const mb = mean(b);
  let na = 0, nb = 0, den = 0;
  for (let i = 0; i < 4; i++) {
    const xs = a[i].x - ma.x, ys = a[i].y - ma.y, xd = b[i].x - mb.x, yd = b[i].y - mb.y;
    na += xs * xd + ys * yd; nb += xs * yd - ys * xd; den += xs * xs + ys * ys;
  }
  const sa = na / den; const sb = nb / den;
  const r = (v: number) => Math.round(v * 1e9) / 1e9;
  return {
    rotDeg: r((Math.atan2(sb, sa) * 180) / Math.PI),
    scalePct: r((Math.hypot(sa, sb) - 1) * 100),
    shiftM: r(Math.hypot(mb.x - ma.x, mb.y - ma.y)),
  };
}
```

Run: `cd server && npx vitest run src/__tests__/services/droneOverlayMath.test.ts`
Expected: PASS.

- [ ] **Step 4: Client API**

In `dashboard/src/api/client.ts`, next to the drone overlay types:

```ts
export interface DroneAlignment { corners: DroneCorners; source: string; layer: string | null; zoom: number; capturedAt: string }
export interface DroneAlignProposal {
  corners: DroneCorners;
  correction: { rotDegCcw: number; scalePct: number; shiftM: number };
  inliers: number; hull: number;
  source: string; layer: string | null; zoom: number; mPerPx: number; attribution: string; capturedAt: string;
}
export type DroneAlignPhase = 'model' | 'aerial' | 'coarse' | 'fine' | 'done' | 'rejected' | 'error' | 'cancelled';
export interface DroneAlignJob { phase: DroneAlignPhase; progress: number; startedAt: number; result?: DroneAlignProposal; reason?: string }
```

Add to `DroneOverlayMeta`, below `history?`:

```ts
  /** The last placement confirmed from an alignment to aerial imagery. */
  alignment?: DroneAlignment | null;
```

Replace `saveDroneOverlayPlacement` and add the three job calls:

```ts
export async function saveDroneOverlayPlacement(
  sn: string, placement: DroneOverlayPlacement,
  opts: { pinsFollow?: boolean; alignment?: Omit<DroneAlignment, 'corners'> } = {},
): Promise<DroneOverlayMeta> {
  const res = await apiFetch(`${BASE}/overlay/${encodeURIComponent(sn)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...placement, ...opts }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<DroneOverlayMeta>;
}

/** Start aligning this draft placement to aerial imagery. Throws with the server's sentence when it refuses. */
export async function startDroneAlign(sn: string, placement: DroneOverlayPlacement): Promise<DroneAlignJob> {
  const res = await apiFetch(`${BASE}/overlay/${encodeURIComponent(sn)}/align`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(placement),
  });
  const data = await res.json().catch(() => ({})) as DroneAlignJob & { error?: string };
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

/** The running or last alignment of this mower; null when there is none. */
export async function fetchDroneAlign(sn: string): Promise<DroneAlignJob | null> {
  const res = await apiFetch(`${BASE}/overlay/${encodeURIComponent(sn)}/align`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<DroneAlignJob>;
}

export async function cancelDroneAlign(sn: string): Promise<void> {
  await apiFetch(`${BASE}/overlay/${encodeURIComponent(sn)}/align`, { method: 'DELETE' });
}
```

- [ ] **Step 5: Panel state, polling, save with pinsFollow**

In `MowerMap.tsx`:

1. Extend the client import with `startDroneAlign, fetchDroneAlign, cancelDroneAlign, type DroneAlignJob, type DroneAlignProposal`, and the `droneOverlayMath` import with `placementDeviation`.

2. Replace `saveDronePlacement` with:

```ts
  const [droneAlign, setDroneAlign] = useState<DroneAlignJob | null>(null);
  const [droneProposal, setDroneProposal] = useState<DroneAlignProposal | null>(null);
  const saveDronePlacement = useCallback(async () => {
    if (!sn || !droneDraft) return;
    setDroneBusy(true);
    try {
      // The alignment is only the reference when the draft is still exactly the proposal.
      const fromProposal = droneProposal !== null
        && droneDraft.corners.every((c, i) => c.lat === droneProposal.corners[i].lat && c.lng === droneProposal.corners[i].lng);
      setDroneMeta(await saveDroneOverlayPlacement(sn, droneDraft, {
        pinsFollow: true,
        alignment: fromProposal ? { source: droneProposal.source, layer: droneProposal.layer, zoom: droneProposal.zoom, capturedAt: droneProposal.capturedAt } : undefined,
      }));
      setDroneDraft(null); setDroneProposal(null); setDroneAlign(null);
      // Dock pins on the photo moved with it: redraw zones and the charger icon from them.
      void reloadMaps();
      fetchCalibration(sn).then(setSavedCal).catch(() => {});
    } catch (e) {
      void dialog.alert({ title: t('map.dronePlaceFailed', 'Plaatsing niet opgeslagen'), message: e instanceof Error ? e.message : String(e), variant: 'danger' });
    } finally { setDroneBusy(false); }
  }, [sn, droneDraft, droneProposal, reloadMaps, dialog, t]);
  const alignRunning = droneAlign !== null && !['done', 'rejected', 'error', 'cancelled'].includes(droneAlign.phase);
  const alignDrone = useCallback(async () => {
    if (!sn || !droneDraft) return;
    setDroneProposal(null);
    try { setDroneAlign(await startDroneAlign(sn, droneDraft)); }
    catch (e) { setDroneAlign({ phase: 'error', progress: 0, startedAt: Date.now(), reason: e instanceof Error ? e.message : String(e) }); }
  }, [sn, droneDraft]);
  const cancelDroneAlignJob = useCallback(() => {
    if (sn) cancelDroneAlign(sn).catch(() => {});
    setDroneAlign(null);
  }, [sn]);
  useEffect(() => {
    if (!sn || !alignRunning) return;
    const id = setInterval(() => {
      fetchDroneAlign(sn).then(j => {
        if (!j) { setDroneAlign(null); return; }
        setDroneAlign(j);
        if (j.phase === 'done' && j.result) {
          const r = j.result;
          setDroneProposal(r);
          setDroneDraft(d => (d ? { ...d, corners: r.corners } : d));
        }
      }).catch(() => {});
    }, 1000);
    return () => clearInterval(id);
  }, [sn, alignRunning]);
  // Closing the panel drops a proposal that was not saved.
  useEffect(() => { if (droneDraft === null) setDroneProposal(null); }, [droneDraft]);
  const droneDeviation = useMemo(() => {
    const ref = droneMeta?.alignment?.corners; const cur = droneDraft?.corners;
    if (!ref || !cur) return null;
    const d = placementDeviation(ref, cur);
    return Math.abs(d.rotDeg) > 1 || Math.abs(d.scalePct) > 1.5 || d.shiftM > 1 ? d : null;
  }, [droneMeta, droneDraft]);
```

3. Point picking no longer anchors the first point on the dock pin (the aerial is the reference now; the pin follows the photo). In `onDronePick`, delete these two lines:

```ts
      // Eerste punt is het laadstation; waar dat op de kaart ligt weten we al.
      if (pointMode.pairs.length === 0 && dockLatLng) { applyPairs([{ px, ll: dockLatLng, dock: true }]); return; }
```

remove `dockLatLng` from its dependency array, and in the panel replace

```tsx
                    : pointMode.pairs.length === 0 && dockLatLng
                      ? t('map.dronePointFirst', 'Klik in de foto op het laadstation.')
                      : t('map.dronePointPhoto', 'Klik in de foto op een herkenbare plek: een obstakel, een hoek van het terras, een put.')}
```

with

```tsx
                    : t('map.dronePointPhoto', 'Klik in de foto op een herkenbare plek: een obstakel, een hoek van het terras, een put.')}
```

Update the comment above `pointMode` to say the points are matched against the map's aerial layer, not the dock.

- [ ] **Step 6: Panel block**

Directly after the closing `)}` of the `{pointMode ? (...) : (<button ...>{t('map.dronePoints', 'Punten aanwijzen')}</button>)}` block, insert:

```tsx
            {!pointMode && (
              <div className="rounded-lg bg-sky-500/10 border border-sky-500/30 p-2 space-y-1 text-[11px]">
                {alignRunning ? (
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-sky-200">
                      {t(`map.droneAlignPhase.${droneAlign!.phase}`)}
                      {droneAlign!.phase === 'fine' ? ` ${Math.round(droneAlign!.progress * 100)}%` : ''}
                    </span>
                    <button onClick={cancelDroneAlignJob} className="text-gray-300 hover:text-white underline">{t('map.droneCancel', 'Annuleren')}</button>
                  </div>
                ) : (
                  <button onClick={() => void alignDrone()} disabled={droneBusy}
                          className="w-full py-1.5 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 text-sky-100 font-medium disabled:opacity-50">
                    {t('map.droneAlign', 'Uitlijnen op luchtfoto')}
                  </button>
                )}
                {droneProposal && !alignRunning && (
                  <p className="text-sky-100">{t('map.droneAlignResult', {
                    rot: Math.abs(droneProposal.correction.rotDegCcw).toFixed(1),
                    pct: Math.abs(droneProposal.correction.scalePct).toFixed(1),
                    m: droneProposal.correction.shiftM.toFixed(2),
                    n: droneProposal.inliers,
                    source: `${droneProposal.source === 'pdok' ? 'PDOK' : droneProposal.source === 'usgs' ? 'USGS' : 'Esri'}${/^\d{4}/.test(droneProposal.layer ?? '') ? ` ${droneProposal.layer!.slice(0, 4)}` : ''}, ${Math.round(droneProposal.mPerPx * 100)} cm`,
                  })}</p>
                )}
                {droneAlign && (droneAlign.phase === 'rejected' || droneAlign.phase === 'error') && (
                  <p className="text-amber-300">{t(`map.droneAlignReason.${droneAlign.reason}`, { defaultValue: droneAlign.reason ?? '' })}</p>
                )}
                {droneDeviation && !droneProposal && !alignRunning && (
                  <p className="text-amber-300">{t('map.droneAlignDeviation', {
                    rot: Math.abs(droneDeviation.rotDeg).toFixed(1), pct: Math.abs(droneDeviation.scalePct).toFixed(1), m: droneDeviation.shiftM.toFixed(1),
                  })}</p>
                )}
              </div>
            )}
```

- [ ] **Step 7: Translations**

Insert in each locale file inside the `"map"` object, directly before the line that starts with `"dronePointUndo":` (same technique as earlier drone keys):

`nl.json`:
```json
    "droneAlign": "Uitlijnen op luchtfoto",
    "droneAlignPhase": {
      "model": "Herkenningsmodel ophalen (eenmalig)",
      "aerial": "Luchtfoto ophalen",
      "coarse": "Grove uitlijning",
      "fine": "Fijne uitlijning"
    },
    "droneAlignResult": "Gecorrigeerd: {{rot}}°, {{pct}}%, {{m}} m ({{n}} overeenkomsten, {{source}}). Controleer en sla op.",
    "droneAlignDeviation": "Wijkt {{rot}}°, {{pct}}% of {{m}} m af van de laatste uitlijning op de luchtfoto.",
    "droneAlignReason": {
      "no_match": "Geen overeenkomsten met de luchtfoto gevonden. Leg de foto grofweg goed en probeer opnieuw, of lijn uit met punten.",
      "few_matches": "Te weinig overeenkomsten met de luchtfoto om zeker te zijn. Lijn uit met punten.",
      "small_overlap": "De overeenkomsten dekken te weinig van de foto om zeker te zijn. Lijn uit met punten.",
      "implausible": "De gevonden correctie is onwaarschijnlijk groot. Leg de foto grofweg goed en probeer opnieuw.",
      "offline": "De luchtfoto is niet op te halen. Is de server online?",
      "no_imagery": "Hier is geen bruikbare luchtfoto beschikbaar.",
      "too_large": "De foto beslaat een te groot gebied om uit te lijnen.",
      "model_download": "Het herkenningsmodel kon niet worden gedownload.",
      "worker": "Het uitlijnen is mislukt. Probeer het opnieuw.",
      "timeout": "Het uitlijnen duurde te lang en is gestopt."
    },
```

`en.json`:
```json
    "droneAlign": "Align to aerial photo",
    "droneAlignPhase": {
      "model": "Fetching the recognition model (once)",
      "aerial": "Fetching the aerial photo",
      "coarse": "Coarse alignment",
      "fine": "Fine alignment"
    },
    "droneAlignResult": "Corrected: {{rot}}°, {{pct}}%, {{m}} m ({{n}} matches, {{source}}). Check it and save.",
    "droneAlignDeviation": "Differs {{rot}}°, {{pct}}% or {{m}} m from the last alignment to the aerial photo.",
    "droneAlignReason": {
      "no_match": "No matches with the aerial photo. Put the photo roughly in place and try again, or align with points.",
      "few_matches": "Too few matches with the aerial photo to be sure. Align with points.",
      "small_overlap": "The matches cover too little of the photo to be sure. Align with points.",
      "implausible": "The correction found is implausibly large. Put the photo roughly in place and try again.",
      "offline": "The aerial photo cannot be fetched. Is the server online?",
      "no_imagery": "No usable aerial photo is available here.",
      "too_large": "The photo covers too large an area to align.",
      "model_download": "The recognition model could not be downloaded.",
      "worker": "Aligning failed. Try again.",
      "timeout": "Aligning took too long and was stopped."
    },
```

`de.json`:
```json
    "droneAlign": "Am Luftbild ausrichten",
    "droneAlignPhase": {
      "model": "Erkennungsmodell wird geladen (einmalig)",
      "aerial": "Luftbild wird geladen",
      "coarse": "Grobausrichtung",
      "fine": "Feinausrichtung"
    },
    "droneAlignResult": "Korrigiert: {{rot}}°, {{pct}} %, {{m}} m ({{n}} Übereinstimmungen, {{source}}). Prüfen und speichern.",
    "droneAlignDeviation": "Weicht {{rot}}°, {{pct}} % oder {{m}} m von der letzten Ausrichtung am Luftbild ab.",
    "droneAlignReason": {
      "no_match": "Keine Übereinstimmungen mit dem Luftbild. Das Foto grob platzieren und erneut versuchen, oder mit Punkten ausrichten.",
      "few_matches": "Zu wenige Übereinstimmungen mit dem Luftbild, um sicher zu sein. Mit Punkten ausrichten.",
      "small_overlap": "Die Übereinstimmungen decken zu wenig vom Foto ab, um sicher zu sein. Mit Punkten ausrichten.",
      "implausible": "Die gefundene Korrektur ist unwahrscheinlich groß. Das Foto grob platzieren und erneut versuchen.",
      "offline": "Das Luftbild kann nicht geladen werden. Ist der Server online?",
      "no_imagery": "Hier ist kein brauchbares Luftbild verfügbar.",
      "too_large": "Das Foto deckt ein zu großes Gebiet ab, um es auszurichten.",
      "model_download": "Das Erkennungsmodell konnte nicht heruntergeladen werden.",
      "worker": "Die Ausrichtung ist fehlgeschlagen. Erneut versuchen.",
      "timeout": "Die Ausrichtung hat zu lange gedauert und wurde gestoppt."
    },
```

`fr.json`:
```json
    "droneAlign": "Aligner sur la photo aérienne",
    "droneAlignPhase": {
      "model": "Téléchargement du modèle de reconnaissance (une fois)",
      "aerial": "Téléchargement de la photo aérienne",
      "coarse": "Alignement grossier",
      "fine": "Alignement fin"
    },
    "droneAlignResult": "Corrigé : {{rot}}°, {{pct}} %, {{m}} m ({{n}} correspondances, {{source}}). Vérifiez puis enregistrez.",
    "droneAlignDeviation": "S'écarte de {{rot}}°, {{pct}} % ou {{m}} m du dernier alignement sur la photo aérienne.",
    "droneAlignReason": {
      "no_match": "Aucune correspondance avec la photo aérienne. Placez la photo à peu près au bon endroit et réessayez, ou alignez avec des points.",
      "few_matches": "Trop peu de correspondances avec la photo aérienne pour être sûr. Alignez avec des points.",
      "small_overlap": "Les correspondances couvrent trop peu de la photo pour être sûr. Alignez avec des points.",
      "implausible": "La correction trouvée est d'une ampleur invraisemblable. Placez la photo à peu près au bon endroit et réessayez.",
      "offline": "La photo aérienne ne peut pas être téléchargée. Le serveur est-il en ligne ?",
      "no_imagery": "Aucune photo aérienne utilisable n'est disponible ici.",
      "too_large": "La photo couvre une zone trop grande pour être alignée.",
      "model_download": "Le modèle de reconnaissance n'a pas pu être téléchargé.",
      "worker": "L'alignement a échoué. Réessayez.",
      "timeout": "L'alignement a pris trop de temps et a été arrêté."
    },
```

Check each file still parses: `for f in dashboard/src/i18n/locales/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "$f ok"; done`
Expected: four `ok` lines.

- [ ] **Step 8: Type-check and build**

Run: `cd dashboard && npx tsc -p tsconfig.app.json --noEmit && npx vite build`
Expected: no type errors; build succeeds.

- [ ] **Step 9: Commit**

```bash
git add dashboard/src/api/client.ts dashboard/src/utils/droneOverlayMath.ts dashboard/src/components/map/MowerMap.tsx dashboard/src/i18n/locales/nl.json dashboard/src/i18n/locales/en.json dashboard/src/i18n/locales/de.json dashboard/src/i18n/locales/fr.json server/src/__tests__/services/droneOverlayMath.test.ts
git commit -m "feat(dashboard): align the drone photo to aerial imagery, with progress, proposal and a deviation warning

Saving from the placement panel now moves the dock pins that lie on the
photo along with it, and point picking no longer pins the first point on
the dock: the aerial photo is the reference, the pin follows the photo."
```

### Task 12: Meetscript voor de Pi, handleiding, eindcontrole

**Files:**
- Create: `server/src/scripts/droneAlignBench.ts`
- Modify: `docs/user-guide/dashboard.md` (sectie "A drone photo under the map")
- Modify: `docs/superpowers/specs/2026-09-25-drone-photo-auto-align-design.md` (status)

**Interfaces:**
- Consumes: Task 8 `startAlign`, `getAlign`; `readMeta` en de opslagmap uit `routes/droneOverlay.ts`.

- [ ] **Step 1: The bench script**

```ts
// server/src/scripts/droneAlignBench.ts
/**
 * Release gate for the drone photo alignment (spec, Testen): time one real
 * alignment end to end on this machine, e.g. a Raspberry Pi 4 or 5, with the
 * mower's current photo and placement. Prints each phase with its time, the
 * worker's peak memory and the result. Saves nothing.
 *
 *   Built server / container:  cd /app/server && node dist/scripts/droneAlignBench.js <SN>
 *   Development:               cd server && npx tsx src/scripts/droneAlignBench.ts <SN>
 */
import path from 'path';
import { readMeta } from '../routes/droneOverlay.js';
import { startAlign, getAlign } from '../services/droneAlign/index.js';

const sn = process.argv[2];
if (!sn) { console.error('usage: droneAlignBench <SN>'); process.exit(2); }
const meta = readMeta(sn);
if (!meta?.placement) { console.error(`${sn}: no drone photo with a placement`); process.exit(2); }
const file = path.resolve(process.env.STORAGE_PATH ?? './storage', 'overlays', meta.file);
const t0 = Date.now();
const r = await startAlign(sn, { file, width: meta.width, height: meta.height }, meta.placement.corners);
if (!r.ok) { console.error(`refused: ${r.reason}`); process.exit(1); }
let last = '';
for (;;) {
  const j = getAlign(sn)!;
  const line = `${j.phase}${j.phase === 'fine' ? ` ${Math.round(j.progress * 100)}%` : ''}`;
  if (line !== last) { console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s  ${line}`); last = line; }
  if (['done', 'rejected', 'error', 'cancelled'].includes(j.phase)) {
    console.log(JSON.stringify({ phase: j.phase, reason: j.reason, stats: j.stats, result: j.result && { correction: j.result.correction, inliers: j.result.inliers, source: j.result.source, layer: j.result.layer } }, null, 2));
    process.exit(j.phase === 'done' ? 0 : 1);
  }
  await new Promise(res => setTimeout(res, 250));
}
```

Run: `cd server && npx tsc --noEmit`
Expected: clean (top-level await is fine: the server builds as ESM).

- [ ] **Step 2: One real run with the real model and PDOK (throwaway check, not committed)**

This proves the parts fit together with the real model, the real worker process and real imagery. It needs internet (PDOK tiles, and the 50 MB model once) and touches no database: `DB_PATH=:memory:`, models in a scratch dir. The photo is the one from the garden in the spec; the corners are its placement after the 2026-09-24 correction, so the proposal should be close to no correction.

Write `/tmp/drone-align-real-check.ts`:

```ts
import { startAlign, getAlign } from '/Users/rvbcrs/GitHub/Novabot/.worktrees/drone-auto-align/server/src/services/droneAlign/index.ts';

const photo = { file: '/private/tmp/claude-501/-Users-rvbcrs-GitHub-Novabot/852d50b9-8893-4a7d-8207-b170a7d23070/scratchpad/drone244.img', width: 1720, height: 980 };
const corners = [
  { lat: 52.141106206, lng: 6.230654518 }, { lat: 52.141079422, lng: 6.231540836 },
  { lat: 52.140769495, lng: 6.231515970 }, { lat: 52.140796280, lng: 6.230629652 },
] as [{ lat: number; lng: number }, { lat: number; lng: number }, { lat: number; lng: number }, { lat: number; lng: number }];
const t0 = Date.now();
const r = await startAlign('CHECK', photo, corners);
if (!r.ok) { console.error('refused', r); process.exit(1); }
let last = '';
for (;;) {
  const j = getAlign('CHECK')!;
  const line = `${j.phase}${j.phase === 'fine' ? ` ${Math.round(j.progress * 100)}%` : ''}`;
  if (line !== last) { console.log(((Date.now() - t0) / 1000).toFixed(1), 's', line); last = line; }
  if (['done', 'rejected', 'error', 'cancelled'].includes(j.phase)) {
    console.log(JSON.stringify({ phase: j.phase, reason: j.reason, stats: j.stats, correction: j.result?.correction, inliers: j.result?.inliers, source: j.result?.source, layer: j.result?.layer }, null, 2));
    process.exit(0);
  }
  await new Promise(res => setTimeout(res, 250));
}
```

Run: `cd server && DB_PATH=:memory: STORAGE_PATH=/tmp/drone-align-check npx tsx /tmp/drone-align-real-check.ts`
Expected: phases `model`, `aerial`, `coarse`, `fine N%`, `done`; `source` `pdok`, `layer` `2025_orthoHR`; `|correction.rotDegCcw|` < 0.6, `|correction.scalePct|` < 1.2, `correction.shiftM` < 0.6; `inliers` ≥ 100; `stats.maxRssKb` < 1000000. Record the total time and `stats` for the commit in Step 5. If it is `rejected`, the reason and the numbers are a finding about the guards or the pipeline: stop and report them, do not loosen a threshold to make it pass.

Delete `/tmp/drone-align-real-check.ts` afterwards.

- [ ] **Step 3: User guide**

In `docs/user-guide/dashboard.md`, section "A drone photo under the map":
- Replace step 2 ("**Pick points**. Click the charging station in the photo ...") with: "**Pick points**. Click a recognisable spot in the photo, then where that spot really is on the aerial layer of the map. Two points fix shift, rotation and scale. With **four or more** ..." (keep the rest of that paragraph from "With four or more").
- Insert a new step 1 before "**Drag**": "**Align to aerial photo**. Put the photo roughly in place (a DJI photo already is), then press *Align to aerial photo*. The server matches the photo against the aerial imagery (PDOK 2025 in the Netherlands; Esri or USGS elsewhere, where it often declines) and proposes a placement, with the correction in degrees, percent and metres. Check it against the aerial layer and save. It takes from half a minute to a few minutes, the first time longer because it downloads a 50 MB model."
- Replace the paragraph starting "What "where it really is" means: the mower's own lines." and ending "Do not align to the aerial imagery." with: "Align the photo to the aerial imagery, not to the mower's lines: the mower's map is in the UTM grid, the dashboard projects it the same way, and the photo has to be true to the world for that to line up. Then put each mower's dock pin on its charging station in the photo (Dock → Align map to satellite). When you save a new placement, dock pins that lie on the photo move with it, for every mower that shares the photo. The pins are display only: nothing is sent to the mower."
- Renumber the list (1 Align, 2 Drag, 3 Pick points, 4 Save).

- [ ] **Step 4: Spec status and full verification**

Set the spec's `**Status:**` line to `geïmplementeerd (plan 2026-09-26-drone-photo-auto-align.md, branch feat/drone-auto-align); Pi-meting en tweede tuin open`.

Run: `cd server && npx tsc --noEmit && npx vitest run > /tmp/drone-align-suite.log 2>&1; tail -5 /tmp/drone-align-suite.log`
Expected: all test files pass (the previous total plus the new files).
Run: `cd dashboard && npx tsc -p tsconfig.app.json --noEmit && npx vite build`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add server/src/scripts/droneAlignBench.ts docs/user-guide/dashboard.md docs/superpowers/specs/2026-09-25-drone-photo-auto-align-design.md
git commit -m "docs+tools: drone photo alignment bench for the Pi release gate, user guide, spec status"
```

## Release gates (not code; the user decides when)

1. Run `droneAlignBench` on a Raspberry Pi 4 and 5 with a real photo: total time and `stats.maxRssKb`. If it takes more than 5 minutes, reduce the fine pass (fewer tiles, or `fineMPerPx` 0.10) and measure again (spec, open punten).
2. Align a photo of a second Dutch garden and one location outside the Netherlands; the thresholds in `GUARDS` must accept the good one and reject the bad one.
3. Only then a beta, and only when the user asks for it.
