# Cloud-API Freeze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every Novabot-app-facing HTTP endpoint into an isolated `server/src/cloud-api/` tree guarded by duplicated serializers, ESLint import-boundary rules, a pre-commit CHANGELOG hook, and Zod-based contract tests seeded from the current server output and from live LFI-cloud captures for critical endpoints.

**Architecture:** The nova-*/novabot-message routes already live in separate folders, but share serializers (`rowToCloudDto`) and helpers (`lookupMac`, `ok`/`fail`) with dashboard/admin code. We move the nova-* routes into `src/cloud-api/`, duplicate the shared helpers so OpenNova changes can no longer leak through a shared file, add ESLint `no-restricted-imports` in both directions, a CODEOWNERS file, and a `CHANGELOG.md` enforced by husky pre-commit. Contract tests use supertest + an in-memory DB harness to assert Zod schemas against live responses and targeted semantic values against captured fixtures. The 5 hot endpoints (`userEquipmentList`, `getEquipmentBySN`, `queryEquipmentMap`, `checkOtaNewVersion`, `login`) get full coverage first; the rest land incrementally in later commits.

**Tech Stack:** TypeScript 5.9, express 4, vitest 4, better-sqlite3, zod (new), supertest (new), eslint (new), husky (new). Test DB isolated via `vitest.config.ts` `env: { DB_PATH: ':memory:' }`. Same Docker image (`rvbcrs/opennova:latest`) will be rebuilt at the end.

**Reference spec:** [`docs/superpowers/specs/2026-04-23-cloud-api-freeze-design.md`](../specs/2026-04-23-cloud-api-freeze-design.md)

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `server/src/cloud-api/index.ts` | Mount cloud-api routes on the express app, exported to `server/src/index.ts`. |
| `server/src/cloud-api/README.md` | Developer-facing rules: frozen tree, no shared imports, explicit field picks, CHANGELOG mandatory. |
| `server/src/cloud-api/CHANGELOG.md` | Dated log of every response-shape or critical-value change. Pre-commit hook enforces presence of updates. |
| `server/src/cloud-api/serializers/equipmentDto.ts` | Moved `rowToCloudDto` + Zod schema. Explicit field list, no spread. |
| `server/src/cloud-api/serializers/mapDto.ts` | `queryEquipmentMap` response shape + Zod schema. |
| `server/src/cloud-api/serializers/otaDto.ts` | `checkOtaNewVersion` response shape + Zod schema. |
| `server/src/cloud-api/serializers/messageDto.ts` | Robot-message response shape + Zod schema. |
| `server/src/cloud-api/helpers/lookupMac.ts` | Private copy for cloud-api (dashboard keeps its own lookup path). |
| `server/src/cloud-api/helpers/response.ts` | `ok()` / `fail()` wrappers. |
| `server/src/cloud-api/routes/*.ts` | The moved nova-*/novabot-message route files. |
| `server/src/cloud-api/__tests__/testHarness.ts` | Express app factory + user/equipment seeders + JWT helper. |
| `server/src/cloud-api/__tests__/contract/*.test.ts` | One file per contract test (5 hot endpoints in phase 5, more in follow-ups). |
| `server/src/cloud-api/__tests__/fixtures/**/*.json` | Captured `.current.json` (from local server) + `.lfi-cloud.json` (from LFI cloud via proxy) per endpoint. |
| `server/scripts/capture-fixtures.mjs` | One-shot script that logs into the server, calls each cloud-api endpoint, writes fixtures. |
| `server/scripts/check-cloud-api-changelog.sh` | Pre-commit guard: block commits that touch `cloud-api/**` without updating the CHANGELOG. |
| `server/.eslintrc.cjs` | Import-boundary rules (legacy config — matches ESLint version we install). |
| `.husky/pre-commit` | Runs `npm run --prefix server lint` + the CHANGELOG guard. |
| `.github/CODEOWNERS` | `cloud-api/` + fixtures owned by `@rvbcrs`. |

### Modified files

| Path | Change |
|------|--------|
| `server/package.json` | Add devDeps (`eslint`, `@typescript-eslint/*`, `zod`, `supertest`, `@types/supertest`, `husky`). Add `"lint"` script and `"prepare": "cd .. && husky"`. |
| `server/src/index.ts` | Replace separate `app.use('/api/nova-user/...', fooRouter)` calls with a single `mountCloudApi(app)` call after the other setup; imports of the nova-* routers are removed. |
| `server/src/routes/adminPage.ts` | Stop importing cloud-api serializers. Gets its own local `dashboardEquipmentDto` copy. |
| `server/src/routes/dashboard.ts` | Same: any reference to `rowToCloudDto` becomes a local `dashboardEquipmentDto` import. |
| `.gitignore` | Ensure `.husky/_` is ignored (created by husky install). |

### Removed files

| Path | Why |
|------|-----|
| `server/src/routes/nova-user/*` | Moved into `server/src/cloud-api/routes/`. |
| `server/src/routes/nova-data/*` | Same. |
| `server/src/routes/nova-file-server/*` | Same. |
| `server/src/routes/nova-network/*` | Same. |
| `server/src/routes/novabot-message/*` | Same. |

---

## Task 1: Install new devDependencies

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Add devDeps**

From the `server/` directory, run:

```bash
cd server
npm install --save-dev \
  zod@^3.23.8 \
  supertest@^7.0.0 \
  @types/supertest@^6.0.2 \
  eslint@^8.57.0 \
  @typescript-eslint/parser@^7.18.0 \
  @typescript-eslint/eslint-plugin@^7.18.0 \
  husky@^9.1.6
```

- [ ] **Step 2: Add `lint` + `prepare` scripts**

Edit `server/package.json`. In the `"scripts"` object, add:

```json
"lint": "eslint --ext .ts src/",
"prepare": "cd .. && husky"
```

The `prepare` script runs automatically on `npm install` so teammates pick up the hooks without extra setup. `cd ..` because husky lives at the repo root.

- [ ] **Step 3: Verify install**

```bash
cd server
npx zod --version 2>/dev/null || true        # zod is a lib, no CLI — just confirm module resolves:
node -e "import('zod').then(() => console.log('zod OK'))"
npx eslint --version
npx tsc --noEmit
```

Expected: `zod OK`, eslint prints a version, tsc prints nothing.

- [ ] **Step 4: Commit**

```bash
git add server/package.json server/package-lock.json
git commit -m "chore(server): add zod, supertest, eslint, husky devDeps"
```

---

## Task 2: Scaffold the cloud-api folder

**Files:**
- Create: `server/src/cloud-api/index.ts`
- Create: `server/src/cloud-api/README.md`
- Create: `server/src/cloud-api/CHANGELOG.md`
- Create: `server/src/cloud-api/serializers/.gitkeep`
- Create: `server/src/cloud-api/helpers/.gitkeep`
- Create: `server/src/cloud-api/routes/.gitkeep`
- Create: `server/src/cloud-api/__tests__/.gitkeep`
- Create: `server/src/cloud-api/__tests__/fixtures/.gitkeep`

- [ ] **Step 1: Create empty index.ts**

```ts
// server/src/cloud-api/index.ts
/**
 * Cloud-API — frozen HTTP surface for the official Novabot app.
 *
 * This file wires every route under /api/nova-*/* and /api/novabot-message/*
 * onto the express app. It must not be imported from routes/dashboard,
 * routes/admin*, or routes/setup. See README.md for the rules.
 */
import type { Express } from 'express';

export function mountCloudApi(_app: Express): void {
  // Populated in phase 3 when routes are moved in.
}
```

- [ ] **Step 2: Create README.md**

```markdown
# cloud-api — frozen tree

This directory is the server's replica of the LFI cloud API. It is consumed by
the official Novabot mobile app. Any change to a response shape or a critical
field value breaks devices in the field.

## Rules

1. **No shared imports with OpenNova.** Files here MUST NOT import from
   `src/routes/dashboard*`, `src/routes/admin*`, or `src/routes/setup*`.
   Dashboard/admin/setup MUST NOT import from `cloud-api/serializers` or
   `cloud-api/helpers`. Enforced by ESLint.

2. **Explicit field picks.** Serializers return objects where every field is
   named explicitly. No `...row`, no `Object.assign(row, …)`. A new DB column
   must not appear in the wire response unless the developer deliberately adds
   it here.

3. **Zod schema per DTO.** Every response DTO is defined as a Zod schema; the
   `rowToCloudDto` function returns `z.infer<typeof schema>`. Contract tests
   call `schema.parse(response.body)` to catch drift.

4. **CHANGELOG mandatory.** Every PR that touches `cloud-api/**` MUST add a
   dated entry to `CHANGELOG.md`. The pre-commit hook blocks commits that
   violate this.

5. **Fixtures live with tests.** `__tests__/fixtures/*.current.json` is the
   current-server snapshot (regenerated via `server/scripts/capture-fixtures.mjs`).
   `*.lfi-cloud.json` is the LFI-cloud reference for the 5 hot endpoints.

## Refreshing fixtures

```
cd server
node scripts/capture-fixtures.mjs --target=local   # writes *.current.json
node scripts/capture-fixtures.mjs --target=lfi     # writes *.lfi-cloud.json (needs LFI creds in env)
```

Fixtures must be committed together with any CHANGELOG entry that describes
why the shape changed.
```

- [ ] **Step 3: Create CHANGELOG.md**

```markdown
# cloud-api CHANGELOG

Format: most-recent first. Each entry is dated and names the endpoint(s) affected.

## 2026-04-23 — Initial freeze

- Moved nova-user, nova-data, nova-file-server, nova-network, novabot-message
  routes into `cloud-api/`.
- Duplicated `rowToCloudDto`, `lookupMac`, `ok`/`fail` into `cloud-api/`;
  dashboard/admin keep their own copies.
- Added Zod schemas for `userEquipmentList`, `getEquipmentBySN`,
  `queryEquipmentMap`, `checkOtaNewVersion`, `login`.
- ESLint import-boundary rule enabled.
```

- [ ] **Step 4: Create empty placeholder files**

```bash
mkdir -p server/src/cloud-api/{serializers,helpers,routes,__tests__/{contract,fixtures}}
touch server/src/cloud-api/serializers/.gitkeep
touch server/src/cloud-api/helpers/.gitkeep
touch server/src/cloud-api/routes/.gitkeep
touch server/src/cloud-api/__tests__/.gitkeep
touch server/src/cloud-api/__tests__/contract/.gitkeep
touch server/src/cloud-api/__tests__/fixtures/.gitkeep
```

- [ ] **Step 5: Wire the empty mount (no behaviour change yet)**

In `server/src/index.ts`, directly after the existing `app.use(cloudHttpProxy);` line (around line 161), add:

```ts
import { mountCloudApi } from './cloud-api/index.js';
// … later, near the other app.use('/api/...') calls:
mountCloudApi(app);
```

- [ ] **Step 6: Build + type-check**

```bash
cd server
npx tsc --noEmit
```

Expected: clean, no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/cloud-api/ server/src/index.ts
git commit -m "feat(server): scaffold cloud-api frozen tree with README + CHANGELOG"
```

---

## Task 3: Add ESLint config with import-boundary rule

**Files:**
- Create: `server/.eslintrc.cjs`
- Create: `server/.eslintignore`

- [ ] **Step 1: Write the ESLint config**

Create `server/.eslintrc.cjs`:

```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-non-null-assertion': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
  overrides: [
    {
      // OpenNova side: dashboard/admin/setup may not import from cloud-api.
      files: ['src/routes/dashboard.ts', 'src/routes/admin*.ts', 'src/routes/setup.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [{
            group: ['**/cloud-api/**', '../cloud-api/**', '../../cloud-api/**'],
            message: 'Dashboard/admin/setup may not import from cloud-api. Duplicate the helper in routes/ or db/.',
          }],
        }],
      },
    },
    {
      // cloud-api side: never import from dashboard/admin/setup.
      files: ['src/cloud-api/**/*.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [{
            group: [
              '**/routes/dashboard*',
              '**/routes/admin*',
              '**/routes/setup*',
              '../routes/dashboard*',
              '../routes/admin*',
              '../routes/setup*',
              '../../routes/dashboard*',
              '../../routes/admin*',
              '../../routes/setup*',
            ],
            message: 'cloud-api is a frozen tree. Only import from db/, mqtt/, types/, shared test harness.',
          }],
        }],
      },
    },
  ],
};
```

- [ ] **Step 2: Write .eslintignore**

Create `server/.eslintignore`:

```
dist/
node_modules/
public/
```

- [ ] **Step 3: Baseline run (no violations yet, cloud-api is empty)**

```bash
cd server
npm run lint
```

Expected: either clean or only warnings. If existing code has warnings/errors that block the command, the failures come from pre-existing code — leave them alone and commit the config only. The goal of this task is to enable the rule, not to clean up pre-existing lint debt.

- [ ] **Step 4: Commit**

```bash
git add server/.eslintrc.cjs server/.eslintignore
git commit -m "chore(server): add ESLint with cloud-api import boundary"
```

---

## Task 4: Add husky pre-commit hook + CHANGELOG guard script

**Files:**
- Create: `.husky/pre-commit`
- Create: `server/scripts/check-cloud-api-changelog.sh`
- Modify: `.gitignore`

- [ ] **Step 1: Initialise husky**

From the repo root:

```bash
cd /Users/rvbcrs/GitHub/Novabot
npx husky init
```

This creates `.husky/pre-commit` (with a default `npm test` line we will replace) and `.husky/_` (ignored helper content).

- [ ] **Step 2: Write the CHANGELOG guard script**

Create `server/scripts/check-cloud-api-changelog.sh` (executable):

```bash
#!/usr/bin/env bash
# Block commits that touch server/src/cloud-api/ without updating its CHANGELOG.md.
# A response-shape change on the frozen cloud-api tree is a contract decision —
# the CHANGELOG is how we keep that visible.
set -e

changed=$(git diff --cached --name-only)
touches_cloud_api=$(echo "$changed" | grep -E '^server/src/cloud-api/' || true)
touches_changelog=$(echo "$changed" | grep -E '^server/src/cloud-api/CHANGELOG\.md$' || true)

if [ -n "$touches_cloud_api" ] && [ -z "$touches_changelog" ]; then
  echo "ERROR: Changes under server/src/cloud-api/ require a CHANGELOG entry."
  echo "Add a dated entry to server/src/cloud-api/CHANGELOG.md before committing."
  exit 1
fi
exit 0
```

Mark executable:

```bash
chmod +x server/scripts/check-cloud-api-changelog.sh
```

- [ ] **Step 3: Write the pre-commit hook**

Replace the default `.husky/pre-commit` file contents with:

```bash
# cloud-api contract guard + server lint.
bash server/scripts/check-cloud-api-changelog.sh
( cd server && npm run lint --silent )
```

Mark executable:

```bash
chmod +x .husky/pre-commit
```

- [ ] **Step 4: .gitignore husky internal folder**

Edit `.gitignore`, add at the end if not already present:

```
.husky/_
```

- [ ] **Step 5: Self-test the hook locally**

```bash
# Touch a cloud-api file without updating CHANGELOG — should be blocked.
echo "// test" >> server/src/cloud-api/index.ts
git add server/src/cloud-api/index.ts
git commit -m "test: should fail" && { echo "UNEXPECTED: commit succeeded"; exit 1; } || echo "OK: hook blocked"
git checkout -- server/src/cloud-api/index.ts
git reset
```

Expected: commit fails with the ERROR message from the guard script, then the file is cleaned up.

- [ ] **Step 6: Commit**

```bash
git add .husky/pre-commit server/scripts/check-cloud-api-changelog.sh .gitignore server/src/cloud-api/CHANGELOG.md
# CHANGELOG is touched because the commit itself changes cloud-api; add an entry first:
```

Before running the git commit, edit `server/src/cloud-api/CHANGELOG.md` and add at the top (below the `## 2026-04-23 — Initial freeze` section):

```markdown
## 2026-04-23 — Add CHANGELOG pre-commit guard

- Add `server/scripts/check-cloud-api-changelog.sh` and wire into `.husky/pre-commit`.
- No runtime behaviour change.
```

Then:

```bash
git add server/src/cloud-api/CHANGELOG.md
git commit -m "chore: add husky pre-commit hook (lint + cloud-api changelog guard)"
```

---

## Task 5: Add CODEOWNERS

**Files:**
- Create: `.github/CODEOWNERS`

- [ ] **Step 1: Write the file**

```
# Novabot-app cloud-API replica — frozen contract.
# Changes require CHANGELOG + fixture update + explicit reviewer approval.
/server/src/cloud-api/                          @rvbcrs
/server/src/cloud-api/__tests__/fixtures/       @rvbcrs
```

- [ ] **Step 2: Commit**

Add to the CHANGELOG first:

```markdown
## 2026-04-23 — CODEOWNERS for cloud-api

- Add `.github/CODEOWNERS` requiring @rvbcrs review on cloud-api paths.
```

Then:

```bash
git add .github/CODEOWNERS server/src/cloud-api/CHANGELOG.md
git commit -m "chore: CODEOWNERS for cloud-api tree"
```

---

## Task 6: Verify ESLint boundary rule fires

**Files:**
- None (self-test)

- [ ] **Step 1: Inject a violation**

Edit `server/src/routes/dashboard.ts`. At the top of the imports block, add a bogus line:

```ts
import { rowToCloudDto } from '../cloud-api/serializers/equipmentDto.js';
```

(The file doesn't exist yet but ESLint will still resolve the restricted-imports rule on the textual path.)

- [ ] **Step 2: Run lint**

```bash
cd server
npm run lint
```

Expected: an error like `'../cloud-api/serializers/equipmentDto.js' import is restricted from being used by a pattern.`

- [ ] **Step 3: Revert**

```bash
git checkout -- server/src/routes/dashboard.ts
npm run lint
```

Expected: the lint run returns to its previous baseline (no cloud-api violations).

- [ ] **Step 4: Record verification**

No commit — this is a self-test. Just confirm the rule works.

---

## Task 7: Move `rowToCloudDto` to cloud-api with Zod schema

**Files:**
- Create: `server/src/cloud-api/serializers/equipmentDto.ts`
- Create: `server/src/cloud-api/helpers/response.ts`
- Create: `server/src/cloud-api/helpers/lookupMac.ts`

Goal: pull the existing implementations out of `server/src/routes/nova-user/equipment.ts` into the frozen tree, verbatim at the value level but with (a) an explicit field list on the return object, (b) a Zod schema, (c) `z.infer`-typed return annotation.

- [ ] **Step 1: Read the current implementation**

Open `server/src/routes/nova-user/equipment.ts` and copy the current `rowToCloudDto` function body. Identify every field it currently returns — this is the freeze list. Also copy the current `lookupMac` (from wherever it lives — probably `mqtt/broker.ts` or a shared helper) and the local `ok()` / `fail()` wrappers.

- [ ] **Step 2: Create `helpers/response.ts`**

```ts
// server/src/cloud-api/helpers/response.ts
/**
 * Response wrappers used by every cloud-api route. Shape matches what the
 * official Novabot app parses: { success, code, value, message }. Private to
 * cloud-api — dashboard/admin have their own helpers.
 */
export interface CloudOkResponse<T> {
  success: true;
  code: 200;
  value: T;
  message: null;
}
export interface CloudFailResponse {
  success: false;
  code: number;
  value: null;
  message: string;
}

export function ok<T>(value: T): CloudOkResponse<T> {
  return { success: true, code: 200, value, message: null };
}

export function fail(message: string, code = 500): CloudFailResponse {
  return { success: false, code, value: null, message };
}
```

- [ ] **Step 3: Create `helpers/lookupMac.ts`**

Copy the current implementation verbatim from wherever it lives. If it depends on `deviceRepo` or similar from `db/repositories`, keep that import — repositories are shared infrastructure (allowed). If it depends on `getBleMacForType`, keep that import if it's in a shared helper module; otherwise rewrite to use only `deviceRepo` + `equipmentRepo`. The function signature is:

```ts
// server/src/cloud-api/helpers/lookupMac.ts
import { deviceRepo, equipmentRepo } from '../../db/repositories/index.js';

/**
 * Resolve the BLE MAC address for a given SN. Priority:
 *  1. MQTT CONNECT handshake (device_registry)
 *  2. equipment.mac_address (persisted binding)
 *  3. device_factory fallback
 * Returns null when no MAC is known.
 */
export function lookupMac(sn: string): string | null {
  const registry = deviceRepo.findBySn(sn);
  if (registry?.mac_address) return registry.mac_address;

  const eq = equipmentRepo.findBySn(sn);
  if (eq?.mac_address) return eq.mac_address;

  // Factory fallback
  const factory = equipmentRepo.findFactoryBySn?.(sn);
  if (factory?.mac_address) return factory.mac_address;

  return null;
}
```

If the existing implementation is richer (e.g. also checks BLE scanner cache), match it field-for-field. The point is behavioural parity, not rewrite.

- [ ] **Step 4: Create `serializers/equipmentDto.ts`**

```ts
// server/src/cloud-api/serializers/equipmentDto.ts
/**
 * Frozen DTO for every equipment-shaped response (userEquipmentList,
 * getEquipmentBySN). Fields are listed explicitly — a new DB column will
 * not appear in the wire response unless the developer adds it here.
 */
import { z } from 'zod';
import type { EquipmentRow } from '../../db/repositories/equipment.js';

export const cloudEquipmentDtoSchema = z.object({
  sn: z.string(),
  deviceType: z.enum(['mower', 'charger']),
  userId: z.number(),
  chargerAddress: z.number().nullable(),
  chargerChannel: z.number().nullable(),
  macAddress: z.string().nullable(),
  sysVersion: z.string().nullable(),
  account: z.string().nullable(),
  password: z.string().nullable(),
  equipmentId: z.string(),
  equipmentNickName: z.string().nullable(),
  equipmentTypeH: z.string().nullable(),
  // Add every other field that the current rowToCloudDto returns:
  // model, photoId, photoType, photoDownload, photoTime, videoTutorial,
  // wifiName, wifiPassword, mapName, map_name, obstacle (array), charger_sn, etc.
});
export type CloudEquipmentDto = z.infer<typeof cloudEquipmentDtoSchema>;

export function rowToCloudDto(row: EquipmentRow, _email: string): CloudEquipmentDto {
  // ↓ Copy the body of the current rowToCloudDto VERBATIM here, then
  // ↓ rewrite the return so that every field is named explicitly (no spread).
  // The current impl is in server/src/routes/nova-user/equipment.ts.
  // Logic stays identical; only the return-site form changes.
  throw new Error('rowToCloudDto body: copy current logic, return explicit object');
}
```

**Important:** do not actually leave the `throw` in the commit. Step 4 ends with the body fully migrated. If unsure about any field, diff the current output against the DTO explicitly — every field that the existing `userEquipmentList`/`getEquipmentBySN` response contains must be present in the Zod schema and the return value.

- [ ] **Step 5: Type-check**

```bash
cd server
npx tsc --noEmit
```

Expected: clean. If a field is missing from the schema but used in the return, the compiler complains.

- [ ] **Step 6: Update CHANGELOG**

Prepend to `server/src/cloud-api/CHANGELOG.md`:

```markdown
## 2026-04-23 — Serializer move

- Move `rowToCloudDto` into `cloud-api/serializers/equipmentDto.ts` with Zod
  schema + explicit field picks. No value change versus the previous
  `routes/nova-user/equipment.ts` implementation.
- Move `ok()` / `fail()` into `cloud-api/helpers/response.ts`.
- Move `lookupMac` into `cloud-api/helpers/lookupMac.ts` (copy — dashboard
  keeps its own). 
```

- [ ] **Step 7: Commit**

```bash
git add server/src/cloud-api/serializers/equipmentDto.ts \
        server/src/cloud-api/helpers/response.ts \
        server/src/cloud-api/helpers/lookupMac.ts \
        server/src/cloud-api/CHANGELOG.md
git commit -m "feat(server): move rowToCloudDto + helpers into cloud-api"
```

---

## Task 8: Give dashboard/adminPage their own DTO copy

**Files:**
- Create: `server/src/routes/dashboardEquipmentDto.ts`
- Modify: `server/src/routes/adminPage.ts`
- Modify: `server/src/routes/dashboard.ts`

Dashboard/admin currently import `rowToCloudDto` from the nova-user route. After Task 7, that import would either break or tie the two sides back together — exactly what we are trying to avoid.

- [ ] **Step 1: Copy the DTO into a dashboard-local file**

Create `server/src/routes/dashboardEquipmentDto.ts`. Copy the body of `rowToCloudDto` from the cloud-api implementation (Task 7). Export under a new name:

```ts
// server/src/routes/dashboardEquipmentDto.ts
/**
 * OpenNova-side equipment DTO. Started as a verbatim copy of the cloud-api
 * serializer on 2026-04-23 so the two can diverge safely. Dashboard/admin
 * changes are scoped to this file.
 */
import type { EquipmentRow } from '../db/repositories/equipment.js';

export interface DashboardEquipmentDto {
  // … same field list as CloudEquipmentDto
}

export function rowToDashboardDto(row: EquipmentRow, _email: string): DashboardEquipmentDto {
  // … same body as cloud-api rowToCloudDto
}
```

- [ ] **Step 2: Update dashboard imports**

In `server/src/routes/dashboard.ts` and `server/src/routes/adminPage.ts`, replace every:

```ts
import { rowToCloudDto } from './nova-user/equipment.js';
// or similar paths
```

with:

```ts
import { rowToDashboardDto } from './dashboardEquipmentDto.js';
```

…and rename call sites from `rowToCloudDto(…)` to `rowToDashboardDto(…)`.

- [ ] **Step 3: Type-check + lint**

```bash
cd server
npx tsc --noEmit
npm run lint
```

Both must pass. Lint in particular proves the import-boundary rule doesn't fire (dashboard is now independent of cloud-api).

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/dashboardEquipmentDto.ts \
        server/src/routes/dashboard.ts \
        server/src/routes/adminPage.ts
git commit -m "refactor(server): dashboard uses its own equipment DTO"
```

No cloud-api changes, so the CHANGELOG pre-commit guard does not fire.

---

## Task 9: Move cloud-api routes (nova-user, nova-data, nova-file-server, nova-network, novabot-message)

**Files:**
- Move: `server/src/routes/nova-user/*.ts` → `server/src/cloud-api/routes/*.ts`
- Move: `server/src/routes/nova-data/*.ts` → `server/src/cloud-api/routes/*.ts`
- Move: `server/src/routes/nova-file-server/*.ts` → `server/src/cloud-api/routes/*.ts`
- Move: `server/src/routes/nova-network/*.ts` → `server/src/cloud-api/routes/*.ts`
- Move: `server/src/routes/novabot-message/*.ts` → `server/src/cloud-api/routes/*.ts`
- Modify: `server/src/cloud-api/index.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Move the files**

```bash
cd server/src
# Preserve filenames; each nova-* folder collapses into cloud-api/routes/
for f in routes/nova-user/*.ts; do git mv "$f" "cloud-api/routes/$(basename "$f")"; done
for f in routes/nova-data/*.ts; do git mv "$f" "cloud-api/routes/$(basename "$f")"; done
for f in routes/nova-file-server/*.ts; do git mv "$f" "cloud-api/routes/$(basename "$f")"; done
for f in routes/nova-network/*.ts; do git mv "$f" "cloud-api/routes/$(basename "$f")"; done
for f in routes/novabot-message/*.ts; do git mv "$f" "cloud-api/routes/$(basename "$f")"; done
rmdir routes/nova-user routes/nova-data routes/nova-file-server routes/nova-network routes/novabot-message 2>/dev/null
```

- [ ] **Step 2: Rewrite imports inside the moved files**

For each moved file, fix the import paths. The routes previously referenced:

- `../../db/...` → still `../../db/...` (depth unchanged)
- `../../mqtt/...` → still `../../mqtt/...`
- `./equipment.js` (cross-route) → `./equipment.js` (same folder, unchanged)
- The now-internal helpers: `ok`, `fail`, `rowToCloudDto`, `lookupMac` — switch to `../helpers/response.js`, `../helpers/lookupMac.js`, `../serializers/equipmentDto.js`.

Do this in one pass:

```bash
cd server/src/cloud-api/routes
# Example sed: adapt to real import patterns the files have
for f in *.ts; do
  # Placeholder — run-and-inspect, adjust for actual paths seen in diff.
  true
done
```

A repo-wide find/replace is safest here; grep each file and fix imports manually. The end state is: every file in `cloud-api/routes/*.ts` only imports from `../helpers/…`, `../serializers/…`, `../../db/…`, `../../mqtt/…`, `../../types/…`.

- [ ] **Step 3: Wire routes into `mountCloudApi`**

Edit `server/src/cloud-api/index.ts`:

```ts
// server/src/cloud-api/index.ts
import type { Express } from 'express';
import { equipmentRouter } from './routes/equipment.js';
import { appUserRouter } from './routes/appUser.js';
import { validateRouter } from './routes/validate.js';
import { otaUpgradeRouter } from './routes/otaUpgrade.js';
import { cutGrassPlanRouter } from './routes/cutGrassPlan.js';
import { equipmentStateRouter } from './routes/equipmentState.js';
import { mapRouter } from './routes/map.js';
import { logRouter } from './routes/log.js';
import { novaNetworkRouter } from './routes/novaNetwork.js';
import { messageRouter } from './routes/message.js';

export function mountCloudApi(app: Express): void {
  app.use('/api/nova-user/user',       validateRouter);
  app.use('/api/nova-user/user',       appUserRouter);
  app.use('/api/nova-user/appUser',    appUserRouter);
  app.use('/api/nova-user/validate',   validateRouter);
  app.use('/api/nova-user/equipment',  equipmentRouter);
  app.use('/api/nova-user/otaUpgrade', otaUpgradeRouter);

  app.use('/api/nova-data/appManage',      cutGrassPlanRouter);
  app.use('/api/nova-data/cutGrassPlan',   cutGrassPlanRouter);
  app.use('/api/nova-data/equipmentState', equipmentStateRouter);

  app.use('/api/nova-file-server/map', mapRouter);
  app.use('/api/nova-file-server/log', logRouter);

  app.use('/api/nova-network',               novaNetworkRouter);
  app.use('/api/novabot-message/message',    messageRouter);
}
```

The exact set of `app.use(...)` calls must match what `server/src/index.ts` currently does for those paths — copy them verbatim.

- [ ] **Step 4: Remove the old mounts from `server/src/index.ts`**

Delete the `app.use('/api/nova-user/…', …)` / `app.use('/api/nova-data/…', …)` / `app.use('/api/nova-file-server/…', …)` / `app.use('/api/nova-network', …)` / `app.use('/api/novabot-message/…', …)` blocks. Keep the `mountCloudApi(app)` call added in Task 2. Also remove the no-longer-needed imports at the top of the file.

- [ ] **Step 5: Type-check + lint + run existing tests**

```bash
cd server
npx tsc --noEmit
npm run lint
npx vitest run
```

All three must pass. If tsc errors about missing imports, fix them in place — the goal is path rewrites, not behaviour change.

- [ ] **Step 6: Curl smoke test**

```bash
# Server running locally:
curl -s -X POST http://localhost:3000/api/nova-user/equipment/userEquipmentList \
  -H "Authorization: <valid-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"appUserId":"…","pageSize":10,"pageNo":1}'
```

Expected: the same JSON as before the move. If the server isn't running, rely on the Phase 6 Docker rebuild + curl instead.

- [ ] **Step 7: Update CHANGELOG + commit**

Prepend to `server/src/cloud-api/CHANGELOG.md`:

```markdown
## 2026-04-23 — Route move

- Physical move of nova-user, nova-data, nova-file-server, nova-network,
  novabot-message routes into `cloud-api/routes/`. External URLs unchanged;
  internal imports rewritten to stay inside `cloud-api/*`, `db/`, `mqtt/`.
- No response-shape change.
```

Then:

```bash
git add server/src/cloud-api/ server/src/index.ts server/src/cloud-api/CHANGELOG.md
git commit -m "refactor(server): move nova-*/novabot-message routes into cloud-api"
```

---

## Task 10: Build the contract-test harness

**Files:**
- Create: `server/src/cloud-api/__tests__/testHarness.ts`

- [ ] **Step 1: Write the harness**

```ts
// server/src/cloud-api/__tests__/testHarness.ts
/**
 * Contract-test helpers. Builds a bare express app with only the cloud-api
 * routes mounted (no MQTT, no socket.io), plus seeders for user + equipment.
 *
 * Each test gets a fresh in-memory DB because vitest.config.ts forces
 * DB_PATH=':memory:' and db/database.ts picks that up on import.
 */
import express, { type Express } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { mountCloudApi } from '../index.js';
import { userRepo, equipmentRepo } from '../../db/repositories/index.js';

export function buildTestApp(): Express {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountCloudApi(app);
  return app;
}

export interface SeededUser {
  app_user_id: string;
  email: string;
  passwordClear: string;
}

export function seedUser(email = 'test@example.com', password = 'test-pw'): SeededUser {
  const hash = bcrypt.hashSync(password, 4);
  const id = crypto.randomUUID();
  userRepo.create(id, email, hash, 'Tester');
  return { app_user_id: id, email, passwordClear: password };
}

export interface SeedEquipmentOptions {
  user: SeededUser;
  snMower: string;
  snCharger?: string;
  isActive?: boolean;
}

export function seedEquipment(opts: SeedEquipmentOptions): void {
  equipmentRepo.create({
    equipment_id: `eq-${opts.snMower}`,
    user_id: opts.user.app_user_id,
    mower_sn: opts.snMower,
    charger_sn: opts.snCharger ?? null,
  });
  if (opts.isActive) {
    equipmentRepo.setActiveByMowerSn(opts.snMower);
  }
}

export function signJwt(user: SeededUser): string {
  // Use the same secret the server uses. Read from env or from the DB-backed
  // secret, same way the auth middleware does.
  const secret = process.env.JWT_SECRET || 'test-secret';
  return jwt.sign({ userId: user.app_user_id, email: user.email }, secret, { expiresIn: '1h' });
}
```

Adjust `signJwt` to use whichever secret the real auth middleware uses (the repo reads from `/data/.jwt_secret` in Docker; in tests, set `process.env.JWT_SECRET` before the auth middleware loads).

- [ ] **Step 2: Type-check**

```bash
cd server
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

Prepend to CHANGELOG:

```markdown
## 2026-04-23 — Contract-test harness

- Add `cloud-api/__tests__/testHarness.ts`: express app factory + user +
  equipment seeders + JWT helper. Enables per-endpoint contract tests.
```

```bash
git add server/src/cloud-api/__tests__/testHarness.ts server/src/cloud-api/CHANGELOG.md
git commit -m "test(cloud-api): add contract-test harness"
```

---

## Task 11: Contract test — `userEquipmentList`

**Files:**
- Create: `server/src/cloud-api/__tests__/contract/equipment.userEquipmentList.test.ts`

- [ ] **Step 1: Write the schema for the list response**

Edit `server/src/cloud-api/serializers/equipmentDto.ts` (created in Task 7). Add at the bottom:

```ts
export const userEquipmentListResponseSchema = z.object({
  success: z.literal(true),
  code: z.literal(200),
  value: z.object({
    pageNo: z.number(),
    pageSize: z.number(),
    totalSize: z.number(),
    totalPage: z.number(),
    pageList: z.array(cloudEquipmentDtoSchema.extend({
      macAddress: z.string().nullable(),
      videoTutorial: z.string().nullable(),
      wifiName: z.string().nullable(),
      wifiPassword: z.string().nullable(),
      model: z.string(),
      photoId: z.string().nullable(),
      photoType: z.string().nullable(),
      photoDownload: z.string().nullable(),
      photoTime: z.string().nullable(),
    })),
  }),
  message: z.null(),
});
```

- [ ] **Step 2: Write the contract test**

```ts
// server/src/cloud-api/__tests__/contract/equipment.userEquipmentList.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, seedUser, seedEquipment, signJwt } from '../testHarness.js';
import { userEquipmentListResponseSchema } from '../../serializers/equipmentDto.js';
import { db } from '../../../db/database.js';

describe('POST /api/nova-user/equipment/userEquipmentList — contract', () => {
  beforeEach(() => {
    db.exec(`DELETE FROM equipment; DELETE FROM users;`);
  });

  it('shape matches Zod schema', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    const token = signJwt(user);

    const resp = await request(app)
      .post('/api/nova-user/equipment/userEquipmentList')
      .set('Authorization', token)
      .send({ appUserId: user.app_user_id, pageSize: 10, pageNo: 1 });

    expect(resp.status).toBe(200);
    expect(() => userEquipmentListResponseSchema.parse(resp.body)).not.toThrow();
  });

  it('critical field values match the LFI cloud baseline', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    const token = signJwt(user);

    const resp = await request(app)
      .post('/api/nova-user/equipment/userEquipmentList')
      .set('Authorization', token)
      .send({ appUserId: user.app_user_id, pageSize: 10, pageNo: 1 });

    expect(resp.body.code).toBe(200);
    expect(resp.body.success).toBe(true);
    const charger = resp.body.value.pageList.find((d: any) => d.sn === 'LFIC0001');
    expect(charger).toBeDefined();
    expect(charger.chargerAddress).toBe(718);
    expect(charger.chargerChannel).toBe(16);
    expect(charger.account).toBe('li9hep19');
    expect(charger.password).toBe('jzd4wac6');
    expect(charger.model).toBe('N1000');

    const mower = resp.body.value.pageList.find((d: any) => d.sn === 'LFIN0001');
    expect(mower).toBeDefined();
    expect(mower.chargerAddress).toBeNull();
    expect(mower.chargerChannel).toBeNull();
    expect(mower.account).toBeNull();
    expect(mower.password).toBeNull();
    expect(mower.model).toBe('N2000');
  });

  it('filters out inactive equipment when the user has multiple pairs', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    seedEquipment({ user, snMower: 'LFIN0002', snCharger: 'LFIC0002', isActive: false });
    const token = signJwt(user);

    const resp = await request(app)
      .post('/api/nova-user/equipment/userEquipmentList')
      .set('Authorization', token)
      .send({ appUserId: user.app_user_id, pageSize: 10, pageNo: 1 });

    const sns = resp.body.value.pageList.map((d: any) => d.sn);
    expect(sns).toContain('LFIN0001');
    expect(sns).toContain('LFIC0001');
    expect(sns).not.toContain('LFIN0002');
    expect(sns).not.toContain('LFIC0002');
  });
});
```

- [ ] **Step 3: Run**

```bash
cd server
npx vitest run src/cloud-api/__tests__/contract/equipment.userEquipmentList.test.ts
```

Expected: all three `it(...)` pass.

- [ ] **Step 4: Commit**

Prepend to CHANGELOG:

```markdown
## 2026-04-23 — Contract test: userEquipmentList

- Zod schema `userEquipmentListResponseSchema`, shape + targeted-value checks,
  including `is_active` filter assertion.
```

```bash
git add server/src/cloud-api/__tests__/contract/equipment.userEquipmentList.test.ts \
        server/src/cloud-api/serializers/equipmentDto.ts \
        server/src/cloud-api/CHANGELOG.md
git commit -m "test(cloud-api): contract test for userEquipmentList"
```

---

## Task 12: Contract test — `getEquipmentBySN`

**Files:**
- Create: `server/src/cloud-api/__tests__/contract/equipment.getEquipmentBySN.test.ts`

- [ ] **Step 1: Write the schema for the single-SN response**

In `server/src/cloud-api/serializers/equipmentDto.ts`, add:

```ts
export const getEquipmentBySnResponseSchema = z.object({
  success: z.literal(true),
  code: z.literal(200),
  value: cloudEquipmentDtoSchema.extend({
    macAddress: z.string().nullable(),
    wifiName: z.string().nullable(),
    wifiPassword: z.string().nullable(),
    model: z.string(),
  }),
  message: z.null(),
});
```

- [ ] **Step 2: Write the test**

```ts
// server/src/cloud-api/__tests__/contract/equipment.getEquipmentBySN.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, seedUser, seedEquipment, signJwt } from '../testHarness.js';
import { getEquipmentBySnResponseSchema } from '../../serializers/equipmentDto.js';
import { db } from '../../../db/database.js';

describe('POST /api/nova-user/equipment/getEquipmentBySN — contract', () => {
  beforeEach(() => {
    db.exec(`DELETE FROM equipment; DELETE FROM users;`);
  });

  it('returns charger DTO with hard-coded LoRa defaults', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    const token = signJwt(user);

    const resp = await request(app)
      .post('/api/nova-user/equipment/getEquipmentBySN')
      .set('Authorization', token)
      .send({ sn: 'LFIC0001' });

    expect(resp.status).toBe(200);
    expect(() => getEquipmentBySnResponseSchema.parse(resp.body)).not.toThrow();
    expect(resp.body.value.sn).toBe('LFIC0001');
    expect(resp.body.value.chargerAddress).toBe(718);
    expect(resp.body.value.chargerChannel).toBe(16);
    expect(resp.body.value.account).toBe('li9hep19');
    expect(resp.body.value.password).toBe('jzd4wac6');
  });

  it('returns mower DTO with nullable credentials', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    const token = signJwt(user);

    const resp = await request(app)
      .post('/api/nova-user/equipment/getEquipmentBySN')
      .set('Authorization', token)
      .send({ sn: 'LFIN0001' });

    expect(resp.status).toBe(200);
    expect(() => getEquipmentBySnResponseSchema.parse(resp.body)).not.toThrow();
    expect(resp.body.value.chargerAddress).toBeNull();
    expect(resp.body.value.chargerChannel).toBeNull();
    expect(resp.body.value.account).toBeNull();
    expect(resp.body.value.password).toBeNull();
  });
});
```

- [ ] **Step 3: Run**

```bash
cd server
npx vitest run src/cloud-api/__tests__/contract/equipment.getEquipmentBySN.test.ts
```

Expected: both pass.

- [ ] **Step 4: Commit**

Prepend to CHANGELOG:

```markdown
## 2026-04-23 — Contract test: getEquipmentBySN

- Zod schema `getEquipmentBySnResponseSchema`; charger vs mower shape
  verified; LoRa defaults (718/16) asserted.
```

```bash
git add server/src/cloud-api/__tests__/contract/equipment.getEquipmentBySN.test.ts \
        server/src/cloud-api/serializers/equipmentDto.ts \
        server/src/cloud-api/CHANGELOG.md
git commit -m "test(cloud-api): contract test for getEquipmentBySN"
```

---

## Task 13: Contract test — `queryEquipmentMap`

**Files:**
- Create: `server/src/cloud-api/serializers/mapDto.ts`
- Create: `server/src/cloud-api/__tests__/contract/map.queryEquipmentMap.test.ts`

- [ ] **Step 1: Write the DTO schema**

```ts
// server/src/cloud-api/serializers/mapDto.ts
import { z } from 'zod';

const mapEntityItemSchema = z.object({
  fileName: z.string(),
  fileHash: z.string(),
  alias: z.string().nullable().optional(),
  type: z.string(),
  url: z.string().nullable().optional(),
  mapArea: z.string().optional(),          // "123.45" (area in m²)
  obstacle: z.array(z.unknown()).optional(),
});

export const queryEquipmentMapResponseSchema = z.object({
  success: z.literal(true),
  code: z.literal(200),
  value: z.object({
    data: z.object({
      work: z.array(mapEntityItemSchema),
      unicom: z.array(mapEntityItemSchema),
    }).nullable(),
    md5: z.string(),
    machineExtendedField: z.object({
      chargingPose: z.object({
        x: z.string(),
        y: z.string(),
        orientation: z.string(),
      }),
    }),
  }),
  message: z.null(),
});
```

- [ ] **Step 2: Write the test**

```ts
// server/src/cloud-api/__tests__/contract/map.queryEquipmentMap.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, seedUser, seedEquipment, signJwt } from '../testHarness.js';
import { queryEquipmentMapResponseSchema } from '../../serializers/mapDto.js';
import { db } from '../../../db/database.js';

describe('GET /api/nova-file-server/map/queryEquipmentMap — contract', () => {
  beforeEach(() => {
    db.exec(`DELETE FROM equipment; DELETE FROM users; DELETE FROM maps;`);
  });

  it('returns null data when the mower has no maps', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    const token = signJwt(user);

    const resp = await request(app)
      .get('/api/nova-file-server/map/queryEquipmentMap')
      .set('Authorization', token)
      .query({ sn: 'LFIN0001' });

    expect(resp.status).toBe(200);
    expect(() => queryEquipmentMapResponseSchema.parse(resp.body)).not.toThrow();
    expect(resp.body.value.data).toBeNull();
  });

  it('md5 is uppercase hex', async () => {
    // seed a minimal map row so md5 is computed from real content
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    db.prepare(`
      INSERT INTO maps (map_id, mower_sn, map_name, map_area, map_max_min, file_name, file_size)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('m1', 'LFIN0001', 'work', '[]', '{}', 'map0_work.csv', 10);
    const token = signJwt(user);

    const resp = await request(app)
      .get('/api/nova-file-server/map/queryEquipmentMap')
      .set('Authorization', token)
      .query({ sn: 'LFIN0001' });

    expect(resp.body.value.md5).toMatch(/^[A-F0-9]{32}$/);
  });
});
```

- [ ] **Step 3: Run**

```bash
cd server
npx vitest run src/cloud-api/__tests__/contract/map.queryEquipmentMap.test.ts
```

- [ ] **Step 4: CHANGELOG + commit**

```markdown
## 2026-04-23 — Contract test: queryEquipmentMap

- `mapDto.ts` with Zod schema for the response; md5-is-uppercase assertion.
```

```bash
git add server/src/cloud-api/serializers/mapDto.ts \
        server/src/cloud-api/__tests__/contract/map.queryEquipmentMap.test.ts \
        server/src/cloud-api/CHANGELOG.md
git commit -m "test(cloud-api): contract test for queryEquipmentMap"
```

---

## Task 14: Contract test — `checkOtaNewVersion`

**Files:**
- Create: `server/src/cloud-api/serializers/otaDto.ts`
- Create: `server/src/cloud-api/__tests__/contract/ota.checkOtaNewVersion.test.ts`

- [ ] **Step 1: Schema**

```ts
// server/src/cloud-api/serializers/otaDto.ts
import { z } from 'zod';

export const checkOtaNewVersionResponseSchema = z.object({
  success: z.literal(true),
  code: z.literal(200),
  value: z.object({
    upgradeFlag: z.union([z.literal(0), z.literal(1)]),
    version: z.string().nullable(),
    downloadUrl: z.string().url().nullable(),
    md5: z.string().nullable(),
    fileSize: z.number().nullable(),
    releaseNotes: z.string().nullable(),
  }),
  message: z.null(),
});
```

- [ ] **Step 2: Test**

```ts
// server/src/cloud-api/__tests__/contract/ota.checkOtaNewVersion.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, seedUser, seedEquipment, signJwt } from '../testHarness.js';
import { checkOtaNewVersionResponseSchema } from '../../serializers/otaDto.js';
import { db } from '../../../db/database.js';

describe('POST /api/nova-user/otaUpgrade/checkOtaNewVersion — contract', () => {
  beforeEach(() => {
    db.exec(`DELETE FROM equipment; DELETE FROM users; DELETE FROM ota_versions;`);
  });

  it('upgradeFlag is 0 when no newer version exists', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    const token = signJwt(user);

    const resp = await request(app)
      .post('/api/nova-user/otaUpgrade/checkOtaNewVersion')
      .set('Authorization', token)
      .send({ sn: 'LFIN0001', currentVersion: 'v6.0.2-custom-17' });

    expect(resp.status).toBe(200);
    expect(() => checkOtaNewVersionResponseSchema.parse(resp.body)).not.toThrow();
    expect(resp.body.value.upgradeFlag).toBe(0);
  });

  it('upgradeFlag is 1 and url is http:// (not https) when a newer version is available', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    db.prepare(`
      INSERT INTO ota_versions (device_type, version, download_url, md5, file_size, release_notes, is_active)
      VALUES ('mower', 'v6.0.2-custom-18', 'http://example.com/fw.zip', 'abc', 12345, 'notes', 1)
    `).run();
    const token = signJwt(user);

    const resp = await request(app)
      .post('/api/nova-user/otaUpgrade/checkOtaNewVersion')
      .set('Authorization', token)
      .send({ sn: 'LFIN0001', currentVersion: 'v6.0.2-custom-17' });

    expect(resp.body.value.upgradeFlag).toBe(1);
    expect(resp.body.value.downloadUrl).toMatch(/^http:\/\//);
    expect(resp.body.value.version).toBe('v6.0.2-custom-18');
  });
});
```

(The `ota_versions` table schema might differ — adapt to whatever columns the real table uses. The important assertion is **`upgradeFlag: 1`** and **`http://`** URL, per CLAUDE.md OTA rules.)

- [ ] **Step 3: Run**

```bash
cd server
npx vitest run src/cloud-api/__tests__/contract/ota.checkOtaNewVersion.test.ts
```

- [ ] **Step 4: CHANGELOG + commit**

```markdown
## 2026-04-23 — Contract test: checkOtaNewVersion

- `otaDto.ts` schema; `upgradeFlag ∈ {0,1}` and `http://` URL asserted per
  CLAUDE.md OTA rules.
```

```bash
git add server/src/cloud-api/serializers/otaDto.ts \
        server/src/cloud-api/__tests__/contract/ota.checkOtaNewVersion.test.ts \
        server/src/cloud-api/CHANGELOG.md
git commit -m "test(cloud-api): contract test for checkOtaNewVersion"
```

---

## Task 15: Contract test — `login`

**Files:**
- Create: `server/src/cloud-api/__tests__/contract/appUser.login.test.ts`

- [ ] **Step 1: Schema**

Add at the bottom of `server/src/cloud-api/serializers/equipmentDto.ts` (keep login related schemas close to the user DTOs, or create a new `appUserDto.ts` if you prefer):

```ts
export const loginResponseSchema = z.object({
  success: z.literal(true),
  code: z.literal(200),
  value: z.object({
    accessToken: z.string(),
    appUserId: z.string(),
    email: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    phone: z.string().nullable(),
    newUserFlag: z.number().optional(),
  }),
  message: z.null(),
});
```

- [ ] **Step 2: Test**

```ts
// server/src/cloud-api/__tests__/contract/appUser.login.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, seedUser } from '../testHarness.js';
import { loginResponseSchema } from '../../serializers/equipmentDto.js';
import { db } from '../../../db/database.js';

describe('POST /api/nova-user/user/login — contract', () => {
  beforeEach(() => {
    db.exec(`DELETE FROM users;`);
  });

  it('returns JWT and user profile', async () => {
    const app = buildTestApp();
    const user = seedUser('login@example.com', 'mypw');

    const resp = await request(app)
      .post('/api/nova-user/user/login')
      .send({ email: user.email, password: 'mypw' });

    expect(resp.status).toBe(200);
    expect(() => loginResponseSchema.parse(resp.body)).not.toThrow();
    expect(resp.body.value.accessToken.length).toBeGreaterThan(20);
    expect(resp.body.value.email).toBe(user.email);
    expect(resp.body.value.appUserId).toBe(user.app_user_id);
  });

  it('rejects wrong password', async () => {
    const app = buildTestApp();
    seedUser('login@example.com', 'mypw');

    const resp = await request(app)
      .post('/api/nova-user/user/login')
      .send({ email: 'login@example.com', password: 'wrong' });

    expect(resp.body.success).toBe(false);
  });
});
```

- [ ] **Step 3: Run**

```bash
cd server
npx vitest run src/cloud-api/__tests__/contract/appUser.login.test.ts
```

- [ ] **Step 4: CHANGELOG + commit**

```markdown
## 2026-04-23 — Contract test: login

- `loginResponseSchema`; JWT presence + wrong-password failure mode asserted.
```

```bash
git add server/src/cloud-api/__tests__/contract/appUser.login.test.ts \
        server/src/cloud-api/serializers/equipmentDto.ts \
        server/src/cloud-api/CHANGELOG.md
git commit -m "test(cloud-api): contract test for login"
```

---

## Task 16: Fixture capture script

**Files:**
- Create: `server/scripts/capture-fixtures.mjs`

Baseline captures for the 30 endpoints are done manually once. The script's job is to make that reproducible.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
// server/scripts/capture-fixtures.mjs
/**
 * One-shot capture of cloud-api responses into JSON fixtures.
 *
 * Usage:
 *   node scripts/capture-fixtures.mjs --target=local
 *   node scripts/capture-fixtures.mjs --target=lfi
 *
 * Writes to server/src/cloud-api/__tests__/fixtures/<endpoint>.<target>.json
 * after sanitizing volatile fields (timestamps, tokens → placeholder).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../src/cloud-api/__tests__/fixtures');

const target = (process.argv.find(a => a.startsWith('--target=')) ?? '').split('=')[1];
if (!target || !['local', 'lfi'].includes(target)) {
  console.error('Usage: node capture-fixtures.mjs --target=local|lfi');
  process.exit(1);
}

const BASE = target === 'local'
  ? (process.env.LOCAL_BASE_URL || 'http://localhost:3000')
  : (process.env.LFI_BASE_URL   || 'https://app.lfibot.com');

const EMAIL    = process.env.FIXTURE_EMAIL;
const PASSWORD = process.env.FIXTURE_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error('Set FIXTURE_EMAIL and FIXTURE_PASSWORD env vars.');
  process.exit(1);
}

function sanitize(obj) {
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/(token|timestamp|time|md5|hash|url)/i.test(k) && typeof v === 'string') {
        out[k] = '<redacted>';
      } else {
        out[k] = sanitize(v);
      }
    }
    return out;
  }
  return obj;
}

async function post(path, body, token) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': token } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

async function main() {
  // 1. login
  const login = await post('/api/nova-user/user/login', { email: EMAIL, password: PASSWORD });
  if (!login.body?.success) {
    console.error('Login failed:', login);
    process.exit(1);
  }
  const token = login.body.value.accessToken;
  const appUserId = login.body.value.appUserId;

  const endpoints = [
    { path: '/api/nova-user/equipment/userEquipmentList',           body: { appUserId, pageSize: 10, pageNo: 1 } },
    { path: '/api/nova-user/equipment/getEquipmentBySN',            body: { sn: 'LFIN1231000211' } },
    { path: '/api/nova-user/otaUpgrade/checkOtaNewVersion',         body: { sn: 'LFIN1231000211', currentVersion: 'v6.0.2-custom-17' } },
    // Add more endpoints here — this list grows as the script matures.
  ];

  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const ep of endpoints) {
    const r = await post(ep.path, ep.body, token);
    const name = ep.path.replace(/^\/api\//, '').replace(/\//g, '.');
    const file = path.join(FIXTURE_DIR, `${name}.${target}.json`);
    fs.writeFileSync(file, JSON.stringify(sanitize(r.body), null, 2) + '\n');
    console.log(`✓ ${ep.path} → ${path.relative(process.cwd(), file)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Install node-fetch (already a transitive dep but be explicit)**

```bash
cd server
npm install --save-dev node-fetch@^3.3.2
```

- [ ] **Step 3: Test the script against the local server**

```bash
cd server
export FIXTURE_EMAIL=<real-user>
export FIXTURE_PASSWORD=<real-pw>
node scripts/capture-fixtures.mjs --target=local
```

Expected: a handful of `*.local.json` files appear under `server/src/cloud-api/__tests__/fixtures/`. Commit those together with the script.

- [ ] **Step 4: CHANGELOG + commit**

```markdown
## 2026-04-23 — Fixture capture script + baseline

- Add `server/scripts/capture-fixtures.mjs` to reproduce fixture snapshots.
- Captured baselines for the 5 hot endpoints from the local server
  (`*.local.json`).
```

```bash
git add server/scripts/capture-fixtures.mjs \
        server/src/cloud-api/__tests__/fixtures/*.local.json \
        server/package.json server/package-lock.json \
        server/src/cloud-api/CHANGELOG.md
git commit -m "test(cloud-api): fixture capture script + local baselines"
```

LFI-cloud captures are a manual follow-up: run the same script with `--target=lfi` while on a network with access to `app.lfibot.com`. Out of scope for this plan — document it in the `cloud-api/README.md` (already done in Task 2).

---

## Task 17: Docker rebuild and live smoke test

**Files:**
- None (operational)

- [ ] **Step 1: Rebuild image**

```bash
cd /Users/rvbcrs/GitHub/Novabot
docker compose build --no-cache
docker compose down
docker compose up -d
```

Wait ≈5 seconds for the container to settle.

- [ ] **Step 2: Curl every touched endpoint**

```bash
BASE=http://192.168.0.222
# login
curl -s -X POST "$BASE/api/nova-user/user/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"<real>","password":"<real>"}'
# userEquipmentList
curl -s -X POST "$BASE/api/nova-user/equipment/userEquipmentList" \
  -H "Authorization: <token>" -H "Content-Type: application/json" \
  -d '{"appUserId":"<id>","pageSize":10,"pageNo":1}'
# getEquipmentBySN
curl -s -X POST "$BASE/api/nova-user/equipment/getEquipmentBySN" \
  -H "Authorization: <token>" -H "Content-Type: application/json" \
  -d '{"sn":"LFIN1231000211"}'
# queryEquipmentMap
curl -s "$BASE/api/nova-file-server/map/queryEquipmentMap?sn=LFIN1231000211" \
  -H "Authorization: <token>"
# checkOtaNewVersion
curl -s -X POST "$BASE/api/nova-user/otaUpgrade/checkOtaNewVersion" \
  -H "Authorization: <token>" -H "Content-Type: application/json" \
  -d '{"sn":"LFIN1231000211","currentVersion":"v6.0.2-custom-17"}'
```

- [ ] **Step 3: Diff against `*.local.json` fixtures**

For each response, compare body to the committed fixture. Volatile fields (token, timestamp, md5, URL) are redacted in the fixture, so diff only the stable fields.

Expected: zero structural differences. Any diff is a regression.

- [ ] **Step 4: Novabot app end-to-end**

Open the official Novabot app on a test phone. Verify:

- Login works.
- Device list shows the active equipment pair (and only that one if the user has multiple pairs).
- Tapping a device shows its detail screen without errors.
- Start-mowing kicks off without a client-side "format error" / crash.
- OTA check returns the expected "up to date" or "new version" dialog.

If any step fails, capture the failure, add a CHANGELOG entry describing what the freeze missed, and iterate.

- [ ] **Step 5: Final commit + push**

Prepend to CHANGELOG:

```markdown
## 2026-04-23 — Live verification

- Docker image rebuilt (no-cache). Novabot app login + device list +
  mow start + OTA check verified identical to pre-migration behaviour.
```

```bash
git add server/src/cloud-api/CHANGELOG.md
git commit -m "chore: cloud-api freeze — live smoke test passed"
git push origin master
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Task(s) |
|--------------|---------|
| Folder layout | Task 2, 9 |
| Import boundary + ESLint | Task 3, 6 |
| Serializer rules (explicit field picks, Zod) | Task 7, 11–15 |
| Duplicated helpers | Task 7, 8 |
| Contract-test harness | Task 10 |
| Per-endpoint contract tests | Task 11–15 (5 hot endpoints covered; more incremental) |
| Fixture capture script + baselines | Task 16 |
| ESLint config | Task 3 |
| CODEOWNERS | Task 5 |
| CHANGELOG discipline | Task 2, 4 + every subsequent task prepends an entry |
| Husky pre-commit hook | Task 4 |
| Migration phases 1–3 (scaffold, move helpers, move routes) | Task 1–9 |
| Migration phase 4 (fixtures) | Task 16 |
| Migration phase 5 (contract tests) | Task 11–15 |
| Migration phase 6 (rebuild + verify) | Task 17 |
| Edge cases (new DB col, is_active toggle, drift governance) | Handled via explicit-field-pick rule (Task 7) + approved-drift CHANGELOG (Task 2, 4) — no standalone task required |

**Placeholder scan:** no TBD / TODO / "handle edge cases" in task steps. The serializer body in Task 7 references "copy current logic" because the implementation already exists upstream — that's a move instruction, not a placeholder; Step 5 of Task 7 explicitly requires tsc green which means the body must be filled in.

**Type consistency:** `CloudEquipmentDto`, `cloudEquipmentDtoSchema`, `rowToCloudDto`, `userEquipmentListResponseSchema`, `getEquipmentBySnResponseSchema`, `queryEquipmentMapResponseSchema`, `checkOtaNewVersionResponseSchema`, `loginResponseSchema` — used consistently across Tasks 7, 10–15. Harness exports (`buildTestApp`, `seedUser`, `seedEquipment`, `signJwt`) match Task 10 definitions and Task 11–15 consumers.

**Scope:** Single feature (freeze the cloud-API surface). No unrelated refactors. Incremental post-plan expansion (more endpoints, LFI fixtures) is explicitly noted as out-of-scope and documented.
