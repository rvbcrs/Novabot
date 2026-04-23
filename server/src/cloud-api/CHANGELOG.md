# cloud-api CHANGELOG

Format: most-recent first. Each entry is dated and names the endpoint(s) affected.

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
