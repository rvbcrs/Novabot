# cloud-api CHANGELOG

Format: most-recent first. Each entry is dated and names the endpoint(s) affected.

## 2026-04-23 — Regression tests vs LFI fixtures + live dual-call

- `__tests__/contract/regression.lfi-fixtures.test.ts`: for every hot
  endpoint, load `fixtures/<name>.lfi.json` (captured from real LFI
  cloud via `scripts/capture-lfi-fixtures.mjs`), assert the fixture
  itself parses against our Zod schema, assert our server response
  parses against the same schema, and assert server response keys are
  a SUPERSET of LFI's (no dropped fields; extras allowed). Tests are
  auto-skipped if the fixture is missing so CI stays green without
  LFI credentials.
- `__tests__/contract/live.lfi-dual-call.test.ts`: env-gated live
  sanity check. `RUN_LIVE_LFI=1 LFI_EMAIL=… LFI_PASSWORD=…` runs a
  login + userEquipmentList + getEquipmentBySN(mower+charger) +
  queryEquipmentMap + checkOtaNewVersion against the real cloud and
  validates each response against our schema. Skipped by default.
- Added `.github/workflows/server-test.yml`: CI runs tsc + scoped
  ESLint + `npm test` on every push touching `server/**`.

## 2026-04-23 — Contract test: login

- `appUserDto.ts` schema `loginResponseSchema`; JWT presence + wrong-pw
  failure mode asserted. Also locks: `appUserId` is integer (row PK, not
  UUID), empty-string defaults for unset profile fields, HTTP 200 on
  failure (envelope-level `success:false`/`code:400`), and `/user` vs
  `/appUser` route alias parity. Plaintext passwords accepted because the
  handler's `tryDecryptAppPassword` falls back to raw on non-AES input;
  no network call needed (cloud fallback only fires when local user is
  missing, and `seedUser` seeds locally).

## 2026-04-23 — Contract test: checkOtaNewVersion

- `otaDto.ts` schema; `upgradeFlag ∈ {0,1}` asserted; `http://` URL
  enforced per CLAUDE.md OTA rules (https is explicitly rejected).

## 2026-04-23 — Contract test: queryEquipmentMap

- `mapDto.ts` with Zod schema for the response; md5-is-uppercase/null
  assertion; null-data path tested; IDOR null-payload parity tested.

## 2026-04-23 — Contract test: getEquipmentBySN

- Zod schema `getEquipmentBySnResponseSchema`; charger vs mower shape
  verified; LoRa defaults (718/16) asserted.

## 2026-04-23 — Contract test: userEquipmentList

- Zod schema `userEquipmentListResponseSchema` + 3 contract tests:
  shape, critical field values (chargerAddress 718, chargerChannel 16,
  account/password for charger, nullable for mower), is_active filter.
- `vitest.config.ts` now also includes `src/cloud-api/__tests__/**/*.test.ts`
  so contract tests under the cloud-api tree are picked up.

## 2026-04-23 — Contract-test harness

- Add `cloud-api/__tests__/testHarness.ts`: express app factory (no MQTT/socket),
  user + equipment seeders, JWT signer. Enables per-endpoint contract tests.

## 2026-04-23 — Route move (phase 3)

- Physical move of nova-user, nova-data, nova-file-server, nova-network,
  novabot-message routes into `cloud-api/routes/`. External URLs unchanged;
  internal imports rewritten to stay inside `cloud-api/*`, `db/`, `mqtt/`,
  `types/`, `middleware/`.
- `rowToCloudDto` now lives only in `cloud-api/serializers/equipmentDto.ts`;
  local copy in `nova-user/equipment.ts` removed.
- `callLfiCloud` / `encryptCloudPassword` (plus `makeLfiHeaders`,
  `LFI_CLOUD_HOST`, `LFI_CLOUD_SERVERNAME`) extracted from `routes/setup.ts`
  into `services/lfiCloud.ts` so the moved `appUser.ts` can import them
  without reaching into `routes/setup*` (forbidden by the cloud-api freeze
  ESLint rule). `routes/setup.ts` still re-exports `callLfiCloud` and
  `encryptCloudPassword` for backward-compat.
- No response-shape change.

## 2026-04-23 — Serializer + helpers move (step 1/2)

- Add `cloud-api/serializers/equipmentDto.ts` with Zod schema +
  `rowToCloudDto` mirroring the existing `nova-user/equipment.ts` impl.
  Explicit field picks; no spread operators.
- Add `cloud-api/helpers/response.ts` (`ok`/`fail`) and
  `cloud-api/helpers/lookupMac.ts` as private copies. Old versions remain in
  place; Task 9 will switch route imports over.
- No wire-level change.

## 2026-04-23 — CODEOWNERS for cloud-api

- Add `.github/CODEOWNERS` requiring @rvbcrs review on cloud-api paths.

## 2026-04-23 — Add CHANGELOG pre-commit guard

- Add `server/scripts/check-cloud-api-changelog.sh` and wire into `.husky/pre-commit`.
- Pre-commit also runs scoped ESLint on cloud-api + dashboard/admin/setup (boundary zone).
- No runtime behaviour change.

## 2026-04-23 — Initial scaffold

- Created `cloud-api/` tree with README and empty `mountCloudApi`. No runtime
  behaviour change; routes still mounted from their original locations.
