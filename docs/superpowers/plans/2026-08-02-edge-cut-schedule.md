# Randmaaien per schema — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per maaischema kunnen kiezen op welke dagen er een randmaai (edge cut) plaatsvindt, i.p.v. bij elke maaibeurt.

**Architecture:** De firmware doet de randmaai automatisch omdat `robot_decision` `include_edge=true` hardcodeert in het coverage-goal. We zetten die default UIT met een 4-byte binary-patch in de custom firmware, en voegen op door de gebruiker gekozen rand-dagen een losse `start_edge_cut`-sessie toe vanuit de server nadat de maaibeurt is afgerond. De keuze staat per schema in een nieuwe `edge_days`-kolom.

**Tech Stack:** TypeScript (Node + better-sqlite3, Express), React + Vite + Tailwind (dashboard), Bash + objdump (firmware build), vitest.

## Global Constraints

- **Nederlands** in alle proza, comments en commit messages; NOOIT em-dashes in proza.
- **Geen Co-Authored-By Claude** in commits.
- `edge_days = NULL` = huidig gedrag (geen server-gestuurde randmaai). Bestaande schema's mogen NIET van gedrag veranderen.
- Test-DB isolatie: NOOIT `process.env.DB_PATH` in test setup zetten — `vitest.config.ts` regelt `:memory:`. Migraties via `ALTER TABLE ... ADD COLUMN` in try/catch (SQLite kent geen `IF NOT EXISTS` op kolommen).
- `cutterhigh = user_cm − 2`; edge-cut `bladeHeight` is in **mm**, server-side (in `extended_commands.py` op de maaier) geclamd 20..90. Mapping NOOIT wijzigen.
- Firmware-scriptwijziging lokaal in `research/` + via `research/build_custom_firmware.sh`; nooit los op de maaier.
- Bewegingscommando's (`start_edge_cut`) alleen na expliciete gebruikersactie/afspraak; Fase 0 verificatie vereist gebruikersbevestiging vóór livegang.
- Spec: `docs/superpowers/specs/2026-08-02-edge-cut-schedule-design.md`.

---

### Task 0: Fase 0 — verifieer de twee go/no-go aannames op de maaier

Geen code. Dit is een handmatige verificatie die vóór Task 5–7 moet slagen. Leg de uitkomst vast in de spec (sectie "Open verificatiepunten") en meld het aan de gebruiker.

**Files:**
- Modify (alleen resultaat-notitie): `docs/superpowers/specs/2026-08-02-edge-cut-schedule-design.md`

- [ ] **Step 1: Verifieer VMA = file-offset voor de patch**

Haal de binary op en bevestig dat het te patchen byte-patroon op de verwachte plek staat.

```bash
sshpass -p 'novabot' scp -o StrictHostKeyChecking=no \
  root@192.168.0.244:/root/novabot/install/compound_decision/lib/compound_decision/robot_decision /tmp/robot_decision.bin
# VMA 0x921a8 draagt `strb w3,[sp,#0xae]` = bytes e3 bb 02 39 (little-endian van 0x3902bbe3)
gobjdump -d /tmp/robot_decision.bin | grep -A1 -B1 '921a8:'
```
Expected: regel `921a8: 3902bbe3   strb w3, [sp, #0xae]`. Noteer of de PIE VMA gelijk is aan de file-offset (voor deze layout normaal 1-op-1; Task 7 hardcodeert géén offset maar zoekt het patroon, dus dit is bevestiging, geen blocker).

- [ ] **Step 2: Verifieer `start_edge_cut` vanaf het dock**

Met de maaier gedockt en de gebruiker akkoord: stuur één keer handmatig `start_edge_cut` en kijk of de maaier zelf uitrijdt en de rand maait (log: coverage_planner "Only edge mode, only covering boundary path", feedback `work_status=150`).

```bash
# via het dashboard/app "Randmaaien"-knop, of MQTT publish met de bekende payload:
#   { "start_edge_cut": { "mapName": "map0", "bladeHeight": 40 } }
sshpass -p 'novabot' ssh root@192.168.0.244 \
  "grep -i 'Only edge mode' \$(readlink /proc/\$(pgrep -f coverage_planner_server)/fd/* | grep coverage_planner | head -1) | tail -3"
```
Expected: de maaier undockt en start de randfase. **Zo NIET:** noteer dat Task 5 een korte `quit_pile`/undock vóór `start_edge_cut` moet sturen, of dat het ontwerp naar het onderbreek-alternatief moet (buiten dit plan — stop en overleg met de gebruiker).

- [ ] **Step 3: Leg de uitkomst vast**

Werk de sectie "Open verificatiepunten" in de spec bij met de bevindingen (geverifieerd / afwijking + gevolg). Commit:

```bash
git add docs/superpowers/specs/2026-08-02-edge-cut-schedule-design.md
git commit -m "docs: Fase 0 randmaai-verificatie vastgelegd (VMA-offset + start_edge_cut vanaf dock)"
```

---

### Task 1: DB-migratie — kolom `edge_days`

**Files:**
- Modify: `server/src/db/database.ts` (bij de bestaande `ALTER TABLE`-migraties, ná de `dashboard_schedules`-blokken)
- Test: `server/src/__tests__/db/edgeDaysColumn.test.ts`

**Interfaces:**
- Produces: kolom `dashboard_schedules.edge_days TEXT` (nullable, default NULL).

- [ ] **Step 1: Schrijf de falende test**

```typescript
// server/src/__tests__/db/edgeDaysColumn.test.ts
import { describe, it, expect } from 'vitest';
import { db } from '../../db/database.js';

describe('dashboard_schedules.edge_days migratie', () => {
  it('de kolom bestaat en is nullable', () => {
    const cols = db.prepare(`PRAGMA table_info(dashboard_schedules)`).all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
    const col = cols.find(c => c.name === 'edge_days');
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0); // nullable
  });
});
```

- [ ] **Step 2: Run de test — verwacht FAIL**

Run: `cd server && npx vitest run src/__tests__/db/edgeDaysColumn.test.ts`
Expected: FAIL — kolom `edge_days` bestaat niet.

- [ ] **Step 3: Voeg de migratie toe**

In `server/src/db/database.ts`, bij de andere `ALTER TABLE`-migraties (patroon exact als `equipment.mac_address`):

```typescript
  // Randmaaien per schema (migratie – veilig om te herhalen).
  // JSON-array weekdagen [0-6], 0=zondag; NULL = huidig gedrag (geen
  // server-gestuurde randmaai). Zie edge-cut-schedule spec.
  try {
    db.exec(`ALTER TABLE dashboard_schedules ADD COLUMN edge_days TEXT`);
    console.log('[DB] Migrated: added dashboard_schedules.edge_days');
  } catch {
    // Kolom bestaat al — geen actie nodig
  }
```

- [ ] **Step 4: Run de test — verwacht PASS**

Run: `cd server && npx vitest run src/__tests__/db/edgeDaysColumn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/database.ts server/src/__tests__/db/edgeDaysColumn.test.ts
git commit -m "feat(db): edge_days kolom op dashboard_schedules (randmaai per schema)"
```

---

### Task 2: Repo — `edge_days` in ScheduleRow + create/update

**Files:**
- Modify: `server/src/db/repositories/schedules.ts` (interface `ScheduleRow`; `create()`; `update()`; `updateByIdAndMower()`)
- Test: `server/src/__tests__/repositories/edgeDays.test.ts`

**Interfaces:**
- Consumes: kolom `dashboard_schedules.edge_days` (Task 1).
- Produces: `ScheduleRow.edge_days: string | null`; `create`/`update`/`updateByIdAndMower` accepteren en persisteren `edge_days`.

- [ ] **Step 1: Schrijf de falende test**

```typescript
// server/src/__tests__/repositories/edgeDays.test.ts
import { describe, it, expect } from 'vitest';
import { scheduleRepo } from '../../db/repositories/index.js';

describe('ScheduleRepository.edge_days', () => {
  it('default NULL, settable en clearbaar via update', () => {
    scheduleRepo.create({ schedule_id: 'edge-1', mower_sn: 'LFIN0001', start_time: '09:00' });
    expect(scheduleRepo.findById('edge-1')?.edge_days).toBeNull();

    scheduleRepo.update('edge-1', { edge_days: JSON.stringify([5]) });
    expect(scheduleRepo.findById('edge-1')?.edge_days).toBe('[5]');

    scheduleRepo.update('edge-1', { edge_days: null });
    expect(scheduleRepo.findById('edge-1')?.edge_days).toBeNull();
  });

  it('create accepteert edge_days direct', () => {
    scheduleRepo.create({ schedule_id: 'edge-2', mower_sn: 'LFIN0001', start_time: '10:00', edge_days: JSON.stringify([1, 4]) });
    expect(scheduleRepo.findById('edge-2')?.edge_days).toBe('[1,4]');
  });
});
```

- [ ] **Step 2: Run — verwacht FAIL**

Run: `cd server && npx vitest run src/__tests__/repositories/edgeDays.test.ts`
Expected: FAIL — `edge_days` bestaat niet op ScheduleRow / wordt niet weggeschreven.

- [ ] **Step 3: Implementeer**

In `server/src/db/repositories/schedules.ts`:

3a. Voeg toe aan `interface ScheduleRow` (na `skip_date`):
```typescript
  /** JSON-array weekdagen [0-6] waarop na de maaibeurt een randmaai volgt;
   *  NULL = huidig gedrag (geen server-gestuurde randmaai). */
  edge_days: string | null;
```

3b. In `create()`: voeg `edge_days` toe aan kolomlijst, aan de `VALUES (...)` (één extra `?`), en aan de `.run(...)`-argumenten als laatste waarde:
```typescript
      data.timezone ?? null,
      data.edge_days ?? null,
```
(kolomlijst: `... timezone, edge_days`; placeholders: één `?` erbij.)

3c. In `update()` en `updateByIdAndMower()`: voeg toe aan de `updatable`-array:
```typescript
      ['edge_days', data.edge_days],
```

- [ ] **Step 4: Run — verwacht PASS**

Run: `cd server && npx vitest run src/__tests__/repositories/edgeDays.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/repositories/schedules.ts server/src/__tests__/repositories/edgeDays.test.ts
git commit -m "feat(repo): edge_days lezen/schrijven in scheduleRepo"
```

---

### Task 3: REST — `edgeDays` in DTO + POST/PATCH

**Files:**
- Modify: `server/src/routes/dashboard.ts` (`ScheduleRow`-interface lokaal ~3483; `scheduleRowToDto` ~3513; POST-body + `create` ~3609; PATCH `updateByIdAndMower` ~3717)
- Test: `server/src/__tests__/routes/edgeDaysDto.test.ts`

**Interfaces:**
- Consumes: `ScheduleRow.edge_days` (Task 2).
- Produces: DTO-veld `edgeDays: number[] | null`; POST/PATCH accepteren `edgeDays?: number[] | null`.

- [ ] **Step 1: Schrijf de falende test (pure DTO-mapping)**

De mapper is niet los geëxporteerd; test het rondje via de repo + een geëxporteerde helper. Voeg eerst een exпорteerbare pure helper toe in `dashboard.ts` en test die.

```typescript
// server/src/__tests__/routes/edgeDaysDto.test.ts
import { describe, it, expect } from 'vitest';
import { parseEdgeDays, serializeEdgeDays } from '../../routes/dashboard.js';

describe('edge_days DTO-mapping', () => {
  it('parseEdgeDays: JSON-string → array, NULL → null', () => {
    expect(parseEdgeDays('[5]')).toEqual([5]);
    expect(parseEdgeDays(null)).toBeNull();
    expect(parseEdgeDays('[]')).toEqual([]);
    expect(parseEdgeDays('garbage')).toBeNull(); // corrupt → null (geen crash)
  });
  it('serializeEdgeDays: array → JSON, null/undefined → null', () => {
    expect(serializeEdgeDays([1, 4])).toBe('[1,4]');
    expect(serializeEdgeDays(null)).toBeNull();
    expect(serializeEdgeDays(undefined)).toBeUndefined(); // undefined = niet aanraken bij PATCH
  });
});
```

- [ ] **Step 2: Run — verwacht FAIL**

Run: `cd server && npx vitest run src/__tests__/routes/edgeDaysDto.test.ts`
Expected: FAIL — `parseEdgeDays`/`serializeEdgeDays` bestaan niet.

- [ ] **Step 3: Implementeer**

3a. Bovenaan bij de andere helpers in `dashboard.ts`, exporteer:
```typescript
/** edge_days (DB-JSON) → array voor de DTO. Corrupt/NULL → null zodat een
 *  kapotte waarde nooit de schedule-lijst laat crashen. */
export function parseEdgeDays(raw: string | null): number[] | null {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n >= 0 && n <= 6) : null;
  } catch { return null; }
}

/** array → DB-JSON. undefined blijft undefined (PATCH: veld niet aanraken);
 *  null → null (expliciet wissen). */
export function serializeEdgeDays(days: number[] | null | undefined): string | null | undefined {
  if (days === undefined) return undefined;
  if (days === null) return null;
  return JSON.stringify(days);
}
```

3b. In de lokale `ScheduleRow`-interface (~3483): voeg `edge_days: string | null;` toe.

3c. In `scheduleRowToDto` (~3513): voeg toe `edgeDays: parseEdgeDays(r.edge_days),`.

3d. In de POST-body-type (~3609): voeg `edgeDays?: number[] | null;` toe. In `scheduleRepo.create({...})` (~3645): voeg toe `edge_days: serializeEdgeDays(body.edgeDays) ?? null,`.

3e. In de PATCH-handler (~3717) `updateByIdAndMower({...})`: voeg toe
```typescript
    edge_days: serializeEdgeDays(body.edgeDays as number[] | null | undefined),
```

- [ ] **Step 4: Run — verwacht PASS + volledige serversuite groen**

Run: `cd server && npx vitest run src/__tests__/routes/edgeDaysDto.test.ts && npx tsc --noEmit`
Expected: PASS, geen type-fouten.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/dashboard.ts server/src/__tests__/routes/edgeDaysDto.test.ts
git commit -m "feat(api): edgeDays in schedule DTO + POST/PATCH"
```

---

### Task 4: Pure logica — `isEdgeDay` + `edgeBladeHeightMm`

**Files:**
- Modify: `server/src/services/scheduleRunner.ts` (nieuwe geëxporteerde pure functies)
- Modify: `server/src/services/mowingService.ts` (`edgeBladeHeightMm`)
- Test: `server/src/__tests__/services/edgeDayLogic.test.ts`

**Interfaces:**
- Produces:
  - `isEdgeDay(edgeDaysJson: string | null, weekday: number): boolean`
  - `edgeBladeHeightMm(cuttingHeight: number): number`

- [ ] **Step 1: Schrijf de falende test**

```typescript
// server/src/__tests__/services/edgeDayLogic.test.ts
import { describe, it, expect } from 'vitest';
import { isEdgeDay } from '../../services/scheduleRunner.js';
import { edgeBladeHeightMm } from '../../services/mowingService.js';

describe('isEdgeDay', () => {
  it('NULL = nooit (huidig gedrag)', () => {
    expect(isEdgeDay(null, 5)).toBe(false);
  });
  it('lege lijst = nooit', () => {
    expect(isEdgeDay('[]', 5)).toBe(false);
  });
  it('bevat de weekdag = wel, anders niet (0=zondag)', () => {
    expect(isEdgeDay('[5]', 5)).toBe(true);   // vrijdag
    expect(isEdgeDay('[5]', 1)).toBe(false);  // maandag
    expect(isEdgeDay('[0,6]', 0)).toBe(true); // zondag
  });
  it('corrupt JSON = nooit (geen crash)', () => {
    expect(isEdgeDay('nonsense', 3)).toBe(false);
  });
});

describe('edgeBladeHeightMm', () => {
  it('mm-invoer (>=20) blijft mm, geclamd 20..90', () => {
    expect(edgeBladeHeightMm(40)).toBe(40);
    expect(edgeBladeHeightMm(10)).toBe(100 > 90 ? 90 : 100); // cm-invoer 10 → 100mm → clamp 90
    expect(edgeBladeHeightMm(4)).toBe(40);   // cm-invoer 4 → 40mm
    expect(edgeBladeHeightMm(1)).toBe(20);   // cm 1 → 10mm → clamp 20 (ondergrens)
    expect(edgeBladeHeightMm(200)).toBe(90); // mm 200 → clamp 90
  });
});
```

- [ ] **Step 2: Run — verwacht FAIL**

Run: `cd server && npx vitest run src/__tests__/services/edgeDayLogic.test.ts`
Expected: FAIL — functies bestaan niet.

- [ ] **Step 3: Implementeer**

3a. In `server/src/services/scheduleRunner.ts` (bij de andere geëxporteerde helpers):
```typescript
/** Is vandaag (weekday 0=zondag) een rand-dag voor dit schema?
 *  edge_days NULL/corrupt/leeg → false (huidig gedrag: geen server-randmaai). */
export function isEdgeDay(edgeDaysJson: string | null, weekday: number): boolean {
  if (!edgeDaysJson) return false;
  try {
    const days = JSON.parse(edgeDaysJson);
    return Array.isArray(days) && days.includes(weekday);
  } catch { return false; }
}
```

3b. In `server/src/services/mowingService.ts` (bij `cuttingHeightToWire`):
```typescript
/** Randmaai bladehoogte in mm voor start_edge_cut. cutting_height komt als mm
 *  (dashboard, >=20) of user-cm (app) binnen — zelfde heuristiek als
 *  cuttingHeightToWire. extended_commands.py clamt óók 20..90 op de maaier;
 *  we clampen hier alvast zodat de payload nooit buiten bereik valt. */
export function edgeBladeHeightMm(cuttingHeight: number): number {
  const mm = cuttingHeight >= 20 ? Math.round(cuttingHeight) : Math.round(cuttingHeight * 10);
  return Math.max(20, Math.min(90, mm));
}
```

- [ ] **Step 4: Run — verwacht PASS**

Run: `cd server && npx vitest run src/__tests__/services/edgeDayLogic.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/scheduleRunner.ts server/src/services/mowingService.ts server/src/__tests__/services/edgeDayLogic.test.ts
git commit -m "feat(schedule): isEdgeDay + edgeBladeHeightMm pure helpers"
```

---

### Task 5: `startEdgeCut` + `getMowerPhase` in mowingService

**Files:**
- Modify: `server/src/services/mowingService.ts`
- Test: `server/src/__tests__/services/edgeCutStart.test.ts`

**Interfaces:**
- Consumes: `publishToDevice` (mapSync), `deviceCache` (sensorData), `isDeviceOnline` (broker).
- Produces:
  - `startEdgeCut(sn: string, mapName: string, bladeHeightMm: number): MowingResult`
  - `getMowerPhase(sn: string): 'mowing' | 'charging' | 'other'`

- [ ] **Step 1: Schrijf de falende test**

`getMowerPhase` is puur t.o.v. `deviceCache` — vul de cache direct. `startEdgeCut` test alleen de guards (offline → error) zonder echte MQTT.

```typescript
// server/src/__tests__/services/edgeCutStart.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getMowerPhase, startEdgeCut } from '../../services/mowingService.js';
import { deviceCache } from '../../mqtt/sensorData.js';

describe('getMowerPhase', () => {
  beforeEach(() => deviceCache.clear());
  it('CHARGING battery_state → charging', () => {
    deviceCache.set('SN1', new Map([['battery_state', 'CHARGING'], ['work_status', '0']]));
    expect(getMowerPhase('SN1')).toBe('charging');
  });
  it('actieve maaistatus → mowing', () => {
    deviceCache.set('SN1', new Map([['work_status', '100'], ['msg', 'Work:COVERING']]));
    expect(getMowerPhase('SN1')).toBe('mowing');
  });
  it('onbekend/leeg → other', () => {
    expect(getMowerPhase('SNX')).toBe('other');
  });
});

describe('startEdgeCut guards', () => {
  it('offline maaier → ok:false', () => {
    const r = startEdgeCut('OFFLINE_SN', 'map0', 40);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run — verwacht FAIL**

Run: `cd server && npx vitest run src/__tests__/services/edgeCutStart.test.ts`
Expected: FAIL — functies bestaan niet.

- [ ] **Step 3: Implementeer**

In `server/src/services/mowingService.ts`:
```typescript
/** Grove maaier-fase uit de sensor-cache, voor de rand-dag watcher.
 *  charging = battery_state CHARGING (= gedockt/klaar); mowing = actieve
 *  coverage-status; other = al het overige (undocken, idle, offline). */
export function getMowerPhase(sn: string): 'mowing' | 'charging' | 'other' {
  const raw = deviceCache.get(sn);
  if (!raw) return 'other';
  if ((raw.get('battery_state') ?? '').toUpperCase() === 'CHARGING') return 'charging';
  const ws = parseInt(raw.get('work_status') ?? '', 10);
  if ([100, 101, 102, 103, 150].includes(ws)) return 'mowing';
  const msg = raw.get('msg') ?? '';
  if (/Work:(COVERING|RUNNING|MOVING|BOUNDARY_COVERING)/.test(msg)) return 'mowing';
  return 'other';
}

/** Start een losse randmaai-sessie (zelfde payload als de app). bladeHeightMm
 *  wordt op de maaier (extended_commands.py) nogmaals 20..90 geclamd. */
export function startEdgeCut(sn: string, mapName: string, bladeHeightMm: number): MowingResult {
  if (!sn) return { ok: false, error: 'sn required' };
  if (!isDeviceOnline(sn)) return { ok: false, error: 'mower offline' };
  sendCommand(sn, { start_edge_cut: { mapName, bladeHeight: bladeHeightMm } });
  console.log(`[MowingService] start_edge_cut: sn=${sn} map=${mapName} blade=${bladeHeightMm}mm`);
  return { ok: true };
}
```

- [ ] **Step 4: Run — verwacht PASS**

Run: `cd server && npx vitest run src/__tests__/services/edgeCutStart.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/mowingService.ts server/src/__tests__/services/edgeCutStart.test.ts
git commit -m "feat(mowing): startEdgeCut + getMowerPhase"
```

---

### Task 6: Rand-dag watcher — arm bij trigger, vuur na docken

**Files:**
- Modify: `server/src/services/scheduleRunner.ts`
- Test: `server/src/__tests__/services/edgeWatch.test.ts`

**Interfaces:**
- Consumes: `isEdgeDay` (Task 4), `edgeBladeHeightMm`, `getMowerPhase`, `startEdgeCut` (Task 5), `mapRepo`, `getScheduleOccurrence`.
- Produces (pure, geëxporteerd voor test):
  - `type EdgeWatchEntry = { bladeHeightMm: number; mapName: string; armedAt: number; sawMowing: boolean }`
  - `advanceEdgeWatch(entry: EdgeWatchEntry, phase: 'mowing'|'charging'|'other', nowMs: number, timeoutMs: number): { next: EdgeWatchEntry | null; fire: boolean }`

- [ ] **Step 1: Schrijf de falende test**

```typescript
// server/src/__tests__/services/edgeWatch.test.ts
import { describe, it, expect } from 'vitest';
import { advanceEdgeWatch, type EdgeWatchEntry } from '../../services/scheduleRunner.js';

const base: EdgeWatchEntry = { bladeHeightMm: 40, mapName: 'map0', armedAt: 1000, sawMowing: false };
const TIMEOUT = 3 * 60 * 60 * 1000;

describe('advanceEdgeWatch', () => {
  it('markeert sawMowing zodra de maaier maait, vuurt nog niet', () => {
    const r = advanceEdgeWatch(base, 'mowing', 2000, TIMEOUT);
    expect(r.fire).toBe(false);
    expect(r.next?.sawMowing).toBe(true);
  });
  it('vuurt zodra de maaier na het maaien gaat laden', () => {
    const seen = { ...base, sawMowing: true };
    const r = advanceEdgeWatch(seen, 'charging', 3000, TIMEOUT);
    expect(r.fire).toBe(true);
    expect(r.next).toBeNull();
  });
  it('vuurt NIET bij laden als er nog geen maaien is gezien (was al gedockt)', () => {
    const r = advanceEdgeWatch(base, 'charging', 3000, TIMEOUT);
    expect(r.fire).toBe(false);
    expect(r.next?.sawMowing).toBe(false);
  });
  it('vervalt na de timeout zonder te vuren', () => {
    const seen = { ...base, sawMowing: true };
    const r = advanceEdgeWatch(seen, 'other', base.armedAt + TIMEOUT + 1, TIMEOUT);
    expect(r.fire).toBe(false);
    expect(r.next).toBeNull();
  });
});
```

- [ ] **Step 2: Run — verwacht FAIL**

Run: `cd server && npx vitest run src/__tests__/services/edgeWatch.test.ts`
Expected: FAIL — `advanceEdgeWatch` bestaat niet.

- [ ] **Step 3: Implementeer de pure transitie + bekabeling**

3a. Pure functie + type in `scheduleRunner.ts`:
```typescript
export type EdgeWatchEntry = { bladeHeightMm: number; mapName: string; armedAt: number; sawMowing: boolean };

/** State machine per maaier voor de rand-dag. Arm bij trigger (sawMowing=false),
 *  markeer sawMowing zodra de maaier echt maait, en vuur (fire=true) zodra hij
 *  daarna gaat laden = maaibeurt klaar. Vervalt na timeoutMs zonder vuren zodat
 *  een mislukte beurt nooit uren later een losse randsessie start. */
export function advanceEdgeWatch(
  entry: EdgeWatchEntry,
  phase: 'mowing' | 'charging' | 'other',
  nowMs: number,
  timeoutMs: number,
): { next: EdgeWatchEntry | null; fire: boolean } {
  if (nowMs - entry.armedAt > timeoutMs) return { next: null, fire: false };
  if (phase === 'mowing') return { next: { ...entry, sawMowing: true }, fire: false };
  if (phase === 'charging' && entry.sawMowing) return { next: null, fire: true };
  return { next: entry, fire: false };
}
```

3b. Module-state + constante bovenaan `scheduleRunner.ts`:
```typescript
const EDGE_WATCH_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 uur
const pendingEdge = new Map<string, EdgeWatchEntry>(); // sn → watcher
```

3c. In `triggerSchedule(row)`, ná een geslaagde `startMowing` (in het bestaande `if (result.ok) { ... }`-blok, na `incrementTriggerCount`), arm de watcher als vandaag een rand-dag is:
```typescript
    // Rand-dag? Arm de watcher zodat na de maaibeurt een losse randmaai volgt.
    const weekday = new Date().getDay(); // 0=zondag
    if (isEdgeDay(row.edge_days, weekday)) {
      const workMaps = mapRepo.findByMowerSnAndType(row.mower_sn, 'work');
      const selected = row.map_id ? workMaps.find(w => w.map_id === row.map_id) : undefined;
      const mapName = selected?.canonical_name?.match(/^map\d+/)?.[0] ?? 'map0';
      pendingEdge.set(row.mower_sn, {
        bladeHeightMm: edgeBladeHeightMm(row.cutting_height ?? 40),
        mapName,
        armedAt: Date.now(),
        sawMowing: false,
      });
      logScheduleDecision(row, true, 'EDGE ARMED', `na maaibeurt randmaai op ${mapName} (dag ${weekday})`);
    }
```

3d. In `checkSchedules()`, aan het BEGIN (vóór de bestaande `for (const row of rows)`-lus), de watcher-lus. Puur via `advanceEdgeWatch`; state in `pendingEdge`:
```typescript
  // Rand-dag watchers: vuur een losse randmaai zodra een gearmde maaier na het
  // maaien gaat laden (= maaibeurt klaar). Kopie van de keys zodat delete/set
  // tijdens de iteratie veilig is.
  for (const [sn, entry] of [...pendingEdge]) {
    const { next, fire } = advanceEdgeWatch(entry, getMowerPhase(sn), Date.now(), EDGE_WATCH_TIMEOUT_MS);
    if (fire) {
      const r = startEdgeCut(sn, entry.mapName, entry.bladeHeightMm);
      console.log(`[ScheduleRunner] EDGE ${r.ok ? 'STARTED' : 'FAILED'} sn=${sn} map=${entry.mapName} blade=${entry.bladeHeightMm}mm ${r.error ?? ''}`);
    }
    if (next === null) pendingEdge.delete(sn);
    else pendingEdge.set(sn, next);
  }
```

3e. Voeg de imports toe bovenaan `scheduleRunner.ts`:
```typescript
import { startMowing, edgeBladeHeightMm, getMowerPhase, startEdgeCut } from './mowingService.js';
```
(vervang de bestaande `import { startMowing } from './mowingService.js';`.)

- [ ] **Step 4: Run — verwacht PASS + suite groen**

Run: `cd server && npx vitest run src/__tests__/services/edgeWatch.test.ts && npx tsc --noEmit`
Expected: PASS, geen type-fouten.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/scheduleRunner.ts server/src/__tests__/services/edgeWatch.test.ts
git commit -m "feat(schedule): rand-dag watcher (arm bij trigger, randmaai na docken)"
```

---

### Task 7: Firmware — `include_edge` default UIT (build-patch)

Vereist Task 0 geslaagd. Wijzig alleen het build-script; niet los op de maaier.

**Files:**
- Modify: `research/build_custom_firmware.sh` (nieuwe sectie, patroon als de "Night-docking fix")

**Interfaces:**
- Produces: elke custom-firmware build heeft `robot_decision` met `include_edge=false` in `coverStartDeal`.

- [ ] **Step 1: Voeg de patch-sectie toe**

In `research/build_custom_firmware.sh`, naast de bestaande binary-patches. Zoekt het byte-patroon i.p.v. een hardcoded offset, en faalt hard bij mismatch (toekomstige fw-revisie):
```bash
# ── Edge-cut default OFF ────────────────────────────────────────────────────
# robot_decision zet include_edge onvoorwaardelijk true in coverStartDeal
# (strb w3,[sp,#0xae] = e3 bb 02 39). We patchen naar strb wzr (ff bb 02 39)
# zodat een gewone maaibeurt geen randfase meer doet; randmaaien gebeurt op
# gekozen dagen via een losse start_edge_cut vanuit de server.
RD="$ROOTFS/root/novabot/install/compound_decision/lib/compound_decision/robot_decision"
PAT=$(printf 'e3bb0239')            # originele bytes (little-endian)
REPL=$(printf 'ffbb0239')           # strb wzr
HITS=$(xxd -p "$RD" | tr -d '\n' | grep -o "$PAT" | wc -l | tr -d ' ')
if [ "$HITS" != "1" ]; then
  echo "FOUT: verwachtte precies 1 include_edge-patroon in robot_decision, vond $HITS — firmware-layout veranderd, patch afbreken." >&2
  exit 1
fi
# Vervang de enige match in-place.
python3 - "$RD" "$PAT" "$REPL" <<'PY'
import sys
path, pat, repl = sys.argv[1], bytes.fromhex(sys.argv[2]), bytes.fromhex(sys.argv[3])
data = open(path, 'rb').read()
assert data.count(pat) == 1, data.count(pat)
open(path, 'wb').write(data.replace(pat, repl))
print("include_edge default OFF gepatcht")
PY
```
(Pas `$ROOTFS` aan naar de variabele die het script al gebruikt voor het uitgepakte rootfs-pad; zoek in het script hoe de Night-docking fix zijn pad opbouwt en volg dat exact.)

- [ ] **Step 2: Statische controle van het script**

Run: `bash -n research/build_custom_firmware.sh`
Expected: geen syntax-fouten. (De echte build + flash draait de gebruiker later met `./research/build_custom_firmware.sh`; dit plan bouwt niet zelf.)

- [ ] **Step 3: Commit**

```bash
git add research/build_custom_firmware.sh
git commit -m "feat(firmware): include_edge default UIT in build (randmaai per schema)"
```

---

### Task 8: Dashboard types + api client

**Files:**
- Modify: `dashboard/src/types/index.ts` (`Schedule`)
- Modify: `dashboard/src/api/client.ts` (create/update payload-typering, indien nodig)
- Test: geen (pure type-uitbreiding; gedekt door `tsc`)

**Interfaces:**
- Produces: `Schedule.edgeDays: number[] | null`.

- [ ] **Step 1: Voeg het veld toe aan `Schedule`**

In `dashboard/src/types/index.ts`, in `interface Schedule` (na `edgeOffset`):
```typescript
  /** Weekdagen [0-6] waarop na de maaibeurt een randmaai volgt; null = geen. */
  edgeDays: number[] | null;
```

- [ ] **Step 2: Controleer de api-client typering**

`createSchedule` gebruikt `Omit<Schedule, ...>` en `updateSchedule` `Partial<Schedule>`, dus `edgeDays` loopt automatisch mee. Verifieer:

Run: `cd dashboard && npx tsc --noEmit`
Expected: mogelijk type-fouten in `Scheduler.tsx` omdat het nieuwe verplichte veld ontbreekt in `defaultForm`/create — die worden in Task 9 opgelost. Als `tsc` hier al klaagt over `Scheduler.tsx`, is dat verwacht; ga door naar Task 9 en check `tsc` daar opnieuw. Los in DEZE task alleen fouten op die niet in `Scheduler.tsx` zitten.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/types/index.ts dashboard/src/api/client.ts
git commit -m "feat(dashboard): edgeDays op Schedule-type"
```

---

### Task 9: Dashboard UI — "Randmaaien op"-dagenrij

**Files:**
- Modify: `dashboard/src/components/schedule/Scheduler.tsx`
- Test: handmatig (Vite) + `tsc`

**Interfaces:**
- Consumes: `Schedule.edgeDays` (Task 8), REST `edgeDays` (Task 3).
- Produces: form-veld + create/update sturen `edgeDays`.

- [ ] **Step 1: Form-state uitbreiden**

In `interface ScheduleForm` voeg toe: `edgeDays: number[];`
In `defaultForm` voeg toe: `edgeDays: [],`

- [ ] **Step 2: Toggle-helper**

Naast `toggleWeekday`:
```typescript
  const toggleEdgeDay = (day: number) => {
    setForm(prev => ({
      ...prev,
      edgeDays: prev.edgeDays.includes(day)
        ? prev.edgeDays.filter(d => d !== day)
        : [...prev.edgeDays, day].sort(),
    }));
  };
```

- [ ] **Step 3: Render de tweede dagenrij (subset van maaidagen)**

Direct ná de bestaande "Weekdays"-`div` (na regel ~284), alleen zichtbaar als er maaidagen gekozen zijn:
```tsx
          {/* Randmaaien op — subset van de maaidagen. Leeg = nooit randmaaien. */}
          {form.weekdays.length > 0 && (
            <div className="mb-3">
              <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t('schedule.edgeDays.label')}</label>
              <div className="flex gap-1 mt-1">
                {order.filter(d => form.weekdays.includes(d)).map(d => (
                  <button
                    key={d}
                    onClick={() => toggleEdgeDay(d)}
                    className={`flex-1 text-[11px] py-1.5 rounded transition-colors ${
                      form.edgeDays.includes(d)
                        ? 'bg-sky-600 text-white font-medium'
                        : 'bg-gray-900 text-gray-500 hover:text-gray-300 border border-gray-700'
                    }`}
                  >
                    {weekdayLabels[d]}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-gray-600 mt-1">{t('schedule.edgeDays.hint')}</p>
            </div>
          )}
```

- [ ] **Step 4: edgeDays meesturen bij create + edit-init**

4a. In `handleCreate` `createSchedule({...})`: voeg toe `edgeDays: form.edgeDays.length > 0 ? form.edgeDays : null,`.

4b. Zorg dat het bewerken van een bestaand schema `edgeDays` inleest in de form. Zoek waar de form met een bestaand schema wordt gevuld (de "edit"-init; als die er niet is en alleen create bestaat, sla 4b over). Vul `edgeDays: s.edgeDays ?? []`.

4c. Filter `edgeDays` bij het weghalen van een maaidag: pas `toggleWeekday` aan zodat een verwijderde maaidag ook uit `edgeDays` valt:
```typescript
  const toggleWeekday = (day: number) => {
    setForm(prev => {
      const weekdays = prev.weekdays.includes(day)
        ? prev.weekdays.filter(d => d !== day)
        : [...prev.weekdays, day].sort();
      // Rand-dag kan geen niet-maaidag zijn.
      const edgeDays = prev.edgeDays.filter(d => weekdays.includes(d));
      return { ...prev, weekdays, edgeDays };
    });
  };
```

- [ ] **Step 5: Type-check + visuele test**

Run: `cd dashboard && npx tsc --noEmit && npm run build`
Expected: geen type-fouten, build slaagt.
Handmatig (Vite dev of beta): open Schedule → nieuw schema → tweede rij "Randmaaien op" toont alleen gekozen maaidagen; selectie slaat op en komt terug na herladen.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/components/schedule/Scheduler.tsx
git commit -m "feat(dashboard): Randmaaien-op dagenrij in schema-form"
```

---

### Task 10: i18n — nieuwe keys in 4 locales

**Files:**
- Modify: `dashboard/src/i18n/locales/{en,nl,de,fr}.json`
- Test: `tsc` / build (Task 9 gebruikt de keys)

**Interfaces:**
- Consumes: `t('schedule.edgeDays.label')`, `t('schedule.edgeDays.hint')` (Task 9).

- [ ] **Step 1: Voeg de keys toe onder `schedule`**

In elk locale-bestand, binnen het bestaande `schedule`-object, een `edgeDays`-object toevoegen (behoud de bestaande formattering; voeg alleen deze sleutel toe):

en:
```json
"edgeDays": { "label": "Edge cut on", "hint": "Only on the selected mowing days; leave empty to never edge-cut." }
```
nl:
```json
"edgeDays": { "label": "Randmaaien op", "hint": "Alleen op de gekozen maaidagen; leeg = nooit randmaaien." }
```
de:
```json
"edgeDays": { "label": "Kantenschnitt an", "hint": "Nur an den gewählten Mähtagen; leer = nie Kantenschnitt." }
```
fr:
```json
"edgeDays": { "label": "Coupe des bords le", "hint": "Uniquement les jours de tonte choisis; vide = jamais." }
```

- [ ] **Step 2: Valideer JSON + build**

Run: `cd dashboard && node -e "for (const l of ['en','nl','de','fr']) require('./src/i18n/locales/'+l+'.json')" && npm run build`
Expected: geen JSON-fouten, build slaagt, geen ontbrekende-key-waarschuwingen voor `schedule.edgeDays.*`.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/i18n/locales/en.json dashboard/src/i18n/locales/nl.json dashboard/src/i18n/locales/de.json dashboard/src/i18n/locales/fr.json
git commit -m "i18n(dashboard): schedule.edgeDays keys (en/nl/de/fr)"
```

---

### Task 11: Integratie-verificatie (end-to-end, geen nieuwe code)

**Files:** geen.

- [ ] **Step 1: Volledige serversuite + typecheck**

Run: `cd server && npm test --silent && npx tsc --noEmit`
Expected: alles groen (bestaande 848+ tests + de nieuwe).

- [ ] **Step 2: Dashboard build**

Run: `cd dashboard && npx tsc --noEmit && npm run build`
Expected: groen.

- [ ] **Step 3: Handmatige e2e (gebruiker, na firmware-flash)**

Op een maaier met de custom firmware van Task 7:
1. Maak/bewerk een schema met maaidagen Ma-Zo en `edge_days` = alleen vrijdag.
2. Op een niet-vrijdag: maaibeurt eindigt zonder randfase (geen `work_status=150`).
3. Op vrijdag: na de maaibeurt + docken vuurt de server `start_edge_cut`; de maaier undockt en maait de rand.
Verifieer via de server-log (`EDGE ARMED` / `EDGE STARTED`) en de coverage_planner-log op de maaier.

- [ ] **Step 4: Meld op te leveren + open punten aan de gebruiker**

Vat samen: wat werkt, dat firmware-flash nodig is (Task 7 via `./research/build_custom_firmware.sh`), en de bekende consequenties (2 records + extra dock-cyclus op rand-dagen; multi-zone randmaai nog te verifiëren).

---

## Zelf-review (uitgevoerd)

- **Spec-dekking:** `edge_days` kolom (T1), repo (T2), REST (T3), firmware-default-uit (T7), rand-dag-trigger (T4–6), UI (T9), i18n (T10), scope-afbakening gerespecteerd (handmatige starts/app ongemoeid). Fase 0-verificaties (T0) + e2e (T11). Alle spec-secties gedekt.
- **Placeholders:** geen TBD/TODO; alle code-stappen bevatten concrete code.
- **Type-consistentie:** `isEdgeDay`, `edgeBladeHeightMm`, `startEdgeCut`, `getMowerPhase`, `advanceEdgeWatch`, `EdgeWatchEntry`, `parseEdgeDays`, `serializeEdgeDays` gebruiken overal dezelfde namen/signaturen tussen definitie (T2–6) en gebruik (T6, T9). DB-kolom `edge_days` ↔ DTO `edgeDays` consistent gemapt.
