# Cloud-API Freeze — Design Spec

**Date:** 2026-04-23
**Status:** Approved (brainstorming)
**Scope:** Server only. Isolate and freeze the Novabot-app-facing HTTP endpoints so OpenNova feature development cannot silently change their output.

## Goal

The server hosts two distinct HTTP surfaces today:

- A cloud-API replica under `/api/nova-*/*` and `/api/novabot-message/*` that the official Novabot app consumes (≈30 endpoints). The Novabot app was written against LFI cloud and any shape change or value drift breaks it.
- OpenNova-only routes under `/api/dashboard/*`, `/api/admin*`, `/api/setup` that our own app and dashboard consume.

They share helpers today (`rowToCloudDto`, `lookupMac`, response wrappers, repositories). An OpenNova change to a shared helper leaks into the cloud-API output. That has already happened (multi-device filter, `chargerAddress` defaults, MAC source-of-truth migration). We need both physical isolation and a safety net that catches accidental drift.

## Non-goals

- Versioned API (`/api/v1/nova-*`). Out of scope — we trust the Novabot app version in the field today.
- Separate npm package or sub-project. Stays in the same server tree.
- Contract tests covering all 30 endpoints in a single pass — incremental, start with the hot 5.
- Touching OpenNova helpers (dashboard/admin/setup) beyond what duplication requires.

## Design decisions

| Question | Decision |
|----------|----------|
| Goal | Isolation + contract freeze (both) |
| Baseline source | Current server output, validated one-time against LFI cloud for critical endpoints |
| Isolation depth | Medium — duplicate serializers into `src/cloud-api/`, dashboard keeps its own copies |
| Contract test strategy | Hybrid — Zod schema per endpoint + targeted assertions on semantic fields |
| Governance on legitimate changes | Approved-drift — fixture update + CHANGELOG entry + CODEOWNERS review + ESLint import boundary |

## Architecture

### Folder layout

```
server/src/
  cloud-api/                                    ← NEW. Frozen tree.
    index.ts                                    ← registers routes on express
    README.md                                   ← rules for developers
    CHANGELOG.md                                ← every response change dated
    serializers/
      equipmentDto.ts                           ← rowToCloudDto + Zod schema
      mapDto.ts                                 ← queryEquipmentMap response
      otaDto.ts                                 ← checkOtaNewVersion response
      messageDto.ts
    helpers/
      lookupMac.ts                              ← private copy for cloud-api
      response.ts                               ← ok()/fail() wrappers
    routes/
      appUser.ts                                ← ex routes/nova-user/appUser.ts
      equipment.ts                              ← ex routes/nova-user/equipment.ts
      validate.ts
      otaUpgrade.ts
      cutGrassPlan.ts                           ← ex routes/nova-data
      equipmentState.ts
      map.ts                                    ← ex routes/nova-file-server
      log.ts
      novaNetwork.ts                            ← ex routes/nova-network
      message.ts                                ← ex routes/novabot-message
    __tests__/
      contract/                                 ← one test file per endpoint
      fixtures/
        <endpoint>.current.json                 ← captured from local server
        <endpoint>.lfi-cloud.json               ← captured via cloud proxy (critical endpoints only)

  routes/
    dashboard.ts                                ← OpenNova; owns its own serializers now
    admin.ts
    adminPage.ts
    adminStatus.ts
    setup.ts
    (nova-user/ nova-data/ nova-file-server/ nova-network/ novabot-message/ → removed)
```

### Import boundary

- `cloud-api/**` must never import from `routes/dashboard*`, `routes/admin*`, `routes/setup*`.
- `routes/dashboard*`, `routes/admin*`, `routes/setup*` must never import from `cloud-api/serializers` or `cloud-api/helpers`.
- Both sides may import from `db/`, `mqtt/`, `types/` (shared infrastructure). Repositories stay shared on purpose — they talk to the same DB. The freeze boundary sits at the serializer layer, not the data layer.

### Serializer rules

Every cloud-api serializer **explicitly enumerates** every field it returns. No `...row` spreads, no `Object.assign(row, …)`, no `JSON.parse(JSON.stringify(row))`. A new DB column therefore does not automatically show up in the wire response. This is the key invariant — the DB schema is allowed to evolve; the cloud-API contract is not.

Example:

```ts
// cloud-api/serializers/equipmentDto.ts
import { z } from 'zod';
import type { EquipmentRow } from '../../db/repositories/equipment';

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
  // … every field explicitly listed
});
export type CloudEquipmentDto = z.infer<typeof cloudEquipmentDtoSchema>;

export function rowToCloudDto(row: EquipmentRow, email: string): CloudEquipmentDto {
  // Semantics preserved from the existing implementation in
  // server/src/routes/nova-user/equipment.ts — this migration is organisational
  // only. The explicit field list is the contract; logic stays as-is.
  return {
    sn: /* existing logic */,
    deviceType: /* existing logic */,
    userId: /* existing logic */,
    chargerAddress: /* existing logic */,
    chargerChannel: /* existing logic */,
    macAddress: /* existing logic */,
    sysVersion: /* existing logic */,
    account: /* existing logic */,
    password: /* existing logic */,
    equipmentId: row.equipment_id,
    // … every other field on the DTO, explicitly
  };
}
```

## Contract test infrastructure

### Per-endpoint test

```
cloud-api/__tests__/contract/
  equipment.userEquipmentList.test.ts
  equipment.getEquipmentBySN.test.ts
  equipment.bindingEquipment.test.ts
  map.queryEquipmentMap.test.ts
  map.downloadMapFile.test.ts
  otaUpgrade.checkOtaNewVersion.test.ts
  appUser.login.test.ts
  appUser.regist.test.ts
  …
```

Start with the 5 hot endpoints (`userEquipmentList`, `getEquipmentBySN`, `queryEquipmentMap`, `checkOtaNewVersion`, `login`). Others land incrementally.

### Test skeleton

```ts
// cloud-api/__tests__/contract/equipment.userEquipmentList.test.ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildTestApp, seedUser, seedEquipment, loginAndReturnToken } from '../testHarness';
import { userEquipmentListSchema } from '../../serializers/equipmentDto';
import lfiFixture from './fixtures/equipment/userEquipmentList.lfi-cloud.json';

describe('POST /api/nova-user/equipment/userEquipmentList — contract', () => {
  it('shape matches Zod schema', async () => {
    const app = buildTestApp();
    const user = await seedUser();
    await seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    const token = await loginAndReturnToken(user);

    const resp = await request(app)
      .post('/api/nova-user/equipment/userEquipmentList')
      .set('Authorization', token)
      .send({ appUserId: user.app_user_id, pageSize: 10, pageNo: 1 });

    expect(resp.status).toBe(200);
    expect(() => userEquipmentListSchema.parse(resp.body)).not.toThrow();
  });

  it('critical field values match LFI cloud baseline', async () => {
    const resp = await callEndpoint();
    expect(resp.body.code).toBe(200);
    expect(resp.body.success).toBe(true);
    const first = resp.body.value.pageList[0];
    expect(first.chargerAddress).toBe(718);
    expect(first.chargerChannel).toBe(16);
    expect(first.model).toMatch(/^N(1000|2000)$/);
    expect(Array.isArray(first.obstacle ?? [])).toBe(true);
  });

  it('filters inactive equipment when N > 1', async () => {
    // …
  });
});
```

### Fixture capture script

`scripts/capture-fixtures.mjs`:

- Logs into a local server, iterates over the endpoint list, calls each, writes response to `cloud-api/__tests__/fixtures/<endpoint>.current.json`.
- Separate command to capture LFI-cloud fixtures via the existing `cloudHttpProxy` — used once per critical endpoint. Volatile fields (tokens, timestamps) sanitised to a placeholder before writing.
- Documented in `cloud-api/README.md`.

### Test DB

`vitest.config.ts` already sets `env: { DB_PATH: ':memory:' }`. Each test seeds its own users/equipment. Existing `setup.ts` guard (`throws if db.name !== ':memory:'`) still applies.

## Governance tooling

### ESLint import boundary

`.eslintrc.cjs` (server/):

```js
module.exports = {
  // existing config …
  overrides: [
    {
      files: ['src/routes/dashboard.ts', 'src/routes/admin*.ts', 'src/routes/setup.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [{
            group: ['*/cloud-api/*', '../cloud-api/*'],
            message: 'Dashboard/admin/setup may not import from cloud-api. Duplicate the helper in routes/ or db/.',
          }],
        }],
      },
    },
    {
      files: ['src/cloud-api/**/*.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [{
            group: ['*/routes/dashboard*', '*/routes/admin*', '*/routes/setup*'],
            message: 'cloud-api is a frozen tree. Import only from db/, mqtt/, types/.',
          }],
        }],
      },
    },
  ],
};
```

`npm run lint` in CI + husky pre-commit hook block violations.

### CODEOWNERS

`.github/CODEOWNERS`:

```
/server/src/cloud-api/                          @rvbcrs
/server/src/cloud-api/__tests__/fixtures/       @rvbcrs
```

Repo rule: require owner review on PR.

### CHANGELOG discipline

`server/src/cloud-api/CHANGELOG.md`. Every response-shape or critical-value change gets a dated entry. Pre-commit script blocks commits that touch `cloud-api/**` without touching the CHANGELOG:

```bash
# scripts/check-cloud-api-changelog.sh
#!/usr/bin/env bash
set -e
changed=$(git diff --cached --name-only)
if echo "$changed" | grep -q '^server/src/cloud-api/' \
   && ! echo "$changed" | grep -q '^server/src/cloud-api/CHANGELOG.md'; then
  echo "ERROR: cloud-api change without CHANGELOG.md update."
  echo "Add at least one dated entry before committing."
  exit 1
fi
```

Hook via husky (`.husky/pre-commit`).

### README

`server/src/cloud-api/README.md` describes:
- Purpose — frozen cloud-API replica for the official Novabot app.
- Rules — no shared imports with dashboard, explicit field lists in serializers, contract tests required for new endpoints, CHANGELOG mandatory.
- Fixture-refresh procedure.

## Migration plan

Split into six phases. Each phase ends with `npx tsc --noEmit` and `npx vitest run` green, Novabot-app smoke test still passes.

### Phase 1 — Scaffolding (no behaviour change)
1. Create `server/src/cloud-api/{index.ts,serializers/,helpers/,routes/,__tests__/,CHANGELOG.md,README.md}`.
2. Add ESLint rule + husky pre-commit hook + CODEOWNERS.
3. Existing routes stay in place; `cloud-api/` is an empty skeleton.
4. Commit.

### Phase 2 — Move helpers + serializers
1. Move `rowToCloudDto`, `lookupMac`, `ok()`, `fail()` to `cloud-api/helpers|serializers/`.
2. Give dashboard/admin its own `dashboardEquipmentDto.ts` (verbatim copy initially). Rewrite the explicit-field pattern later if the two diverge.
3. Rewrite cloud-api serializers to explicit field picks, add Zod schemas, remove spread operators.
4. `npx tsc --noEmit` + `vitest run` must pass.
5. Commit.

### Phase 3 — Move routes
1. Move `nova-user/`, `nova-data/`, `nova-file-server/`, `nova-network/`, `novabot-message/` files into `cloud-api/routes/`.
2. Update `index.ts` mount calls. External paths stay identical (`/api/nova-user/equipment/userEquipmentList` etc).
3. Remove the old directories.
4. tsc + vitest green.
5. Commit.

### Phase 4 — Baseline fixtures
1. Write `scripts/capture-fixtures.mjs`.
2. Run against local server → commit `cloud-api/__tests__/fixtures/*.current.json` for all 30 endpoints.
3. Capture LFI-cloud fixtures for the 5 hot endpoints via `cloudHttpProxy`. Document the procedure in `cloud-api/README.md`.
4. Commit fixtures + script.

### Phase 5 — Contract tests (incremental)
1. Start with the hot 5: `userEquipmentList`, `getEquipmentBySN`, `queryEquipmentMap`, `checkOtaNewVersion`, `login`.
2. Per endpoint: Zod schema in serializer, contract test using the fixture + targeted assertions.
3. Add more endpoints incrementally in later commits.

### Phase 6 — Docker rebuild + live verify
1. `docker compose build --no-cache && docker compose up -d`.
2. Smoke test on the official Novabot app: login, device list, start mowing, OTA check.
3. Verify OpenNova app still works (dashboard, maps, provisioning).
4. Commit notes / fixture deltas if needed.

## Edge cases

| Situation | Behaviour |
|-----------|-----------|
| New DB column added (e.g. `equipment.foo`) | Cloud-api serializers ignore it (explicit picks). Contract tests keep passing. |
| `is_active` filter toggles mid-session | `userEquipmentList` responses re-derive; schema unchanged so Zod passes. No fixture update needed. |
| Novabot app ships new version expecting new field | Approved-drift path: add field to serializer, Zod schema, fixture, CHANGELOG entry. PR review forces attention. |
| `rowToCloudDto` call signature changes | Dashboard has its own copy; cloud-api copy stays. No leak. |
| Someone adds `export` to a cloud-api helper from dashboard side | ESLint rule fails, CI blocks PR. |
| Developer forgets CHANGELOG entry | Pre-commit hook blocks local commit; CI runs same script as safety. |
| LFI cloud format drift observed later | One-off fixture recapture + schema update with CHANGELOG entry. |

## Acceptance criteria

- Phase 1: ESLint rule fires when a deliberate cloud-api import is added to dashboard.ts.
- Phase 2: `tsc` + `vitest` green; curl against `/api/nova-user/equipment/userEquipmentList` returns identical JSON to pre-migration.
- Phase 3: no external URL changed; curl every nova-* endpoint, diff against pre-migration capture — zero differences.
- Phase 4: fixtures committed; script reproducible.
- Phase 5: contract tests run in CI; Zod schemas + targeted assertions pass; snapshot diff tool shows LFI baseline match for critical endpoints.
- Phase 6: Novabot app and OpenNova app both working; production-like smoke test logged.

## Server impact

No change to client-visible URLs, payloads, or behaviour on migration. The Novabot app continues to function identically. The change is entirely internal organisation + safety net.
