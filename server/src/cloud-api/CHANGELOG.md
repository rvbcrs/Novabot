# cloud-api CHANGELOG

Format: most-recent first. Each entry is dated and names the endpoint(s) affected.

## 2026-07-17 — terrain: uploadTerrainGrid endpoint

- Nieuw: `POST /api/nova-file-server/terrain/uploadTerrainGrid?sn=` — raw
  TGR1 sessie-grid van terrain_scan.py; merge naar TGM1 op disk +
  terrain_grids metadata. Zie spec 2026-07-17-terrain-3d-map-design.md.

## 2026-07-04 — uploadEquipmentMap: preserve map alias on re-upload (#66)

Two coupled fixes — either alone still lost the alias on the second mow:

- `matchesParsedArea` now resolves a work map to its area by the stable
  `canonical_name` slot (map0/map1/…), not by the user alias in `map_name`. A
  renamed map ("test") failed to match its map2 area on the mower's post-mow
  re-upload, so the row was treated as new: alias reset + duplicate row created
  while the renamed row was deleted as stale.
- The re-upload `mapRepo.upsert` now persists `canonical_name` explicitly.
  `deriveCanonicalName()` can't recover the slot from the ZIP file_name (skipped)
  + a user alias, so it was stored as NULL — which made the NEXT mow's re-upload
  fail the (now canonical-based) match and lose the alias anyway. This is why
  earlier single-layer fixes appeared to work once, then broke on the next mow.

Verified end-to-end (`map.uploadPreservesAlias.test.ts`) by running the real
upload endpoint TWICE; the test fails if either fix is reverted.

## 2026-07-02 — saveCutGrassRecord: capture + return mow direction

- `routes/equipmentState.ts`: capture `path_direction` (mow direction, degrees)
  and freeze it on the work record. The mower doesn't report direction in the
  record, so we read `device_settings.path_direction` (re-applied to the mower
  before every mow) at record time. Also passes it through `createWorkRecordFull`.
- `routes/message.ts`: `getWorkRecordList` now returns `pathDirection` so the app
  history can show the direction chip next to cutting height.

## 2026-06-05 — queryEquipmentMap: serve metadata-only inter-map unicoms as empty CSV (issues #89, #81)

- `routes/map.ts`: a `mapNtomapM_*_unicom` row imported without a download URL
  (LFI ships inter-map channels 0-byte) is now stored as a metadata-only unicom
  (no `map_area`) and served as an empty CSV on download instead of 404. This
  keeps the inter-map channel key visible to the app without synthesizing a fake
  path. `csvBaseName` rejects path traversal and `.zip`; the empty-CSV branch
  only fires for path-less unicom rows — real unicoms with point data fall
  through to the existing CSV-from-DB logic.

## 2026-05-15 — Map rename: resolve by canonical_name (issue #66)

- `routes/map.ts`: `updateEquipmentMapAlias` was resolving the target row
  by parsing the index out of `fileName` (e.g. `map2_work.csv` → idx 2)
  and reading `rows[idx]` from a sorted list. With multiple work-maps
  sharing the same `file_name` (single ZIP upload), the sort's
  `map_id` tiebreaker fell back to UUID order and the canonical
  sequence got shuffled relative to the array index — rename hit the
  wrong DB row. Fix: derive the canonical_name (`mapN`,
  `mapN_M_obstacle`, `mapNtocharge_unicom`) from the fileName pattern
  and resolve via `mapRepo.findBySnAndCanonical()`.
- Also tightened the sort key in `findByMowerSnAndTypeWithArea` and
  related queries to prefer `canonical_name` first, so the app's
  display order tracks map0/map1/map2 instead of UUID order.
- Existing shuffled DB rows are not auto-corrected; users need one
  rename round to swap aliases back into the right canonical slots.

## 2026-05-13 — Robot messages: send `level` as string

- `routes/message.ts`: `queryRobotMsgPageByUserId` was returning `level: 0`
  (integer). Novabot app v2.4.0 `RobotMessageEntity.fromJson` runs
  `IsType_String` on all three fields (`contentEn`, `createrTime`, `level`)
  — confirmed via blutter dump
  (`asm/.../pages/user/message_page/model/robot_message_entity.dart`
  0x7d2924 + 0x7d29c4). Integer here threw a `CastError`, the whole
  pageList parse failed silently, and the Messages tab stayed empty. Also
  format `createrTime` with `T` separator and ship `pageList`/`list` plus
  `totalCount`/`total` aliases for older app builds that read the doc'd
  shape. Work records were unaffected — `WorkMessageEntity.fromJson` boxes
  numeric fields explicitly so an int `workTime` was always fine.

## 2026-05-09 — Work records: clock sanity check (issue #58)

- `routes/equipmentState.ts`: stock firmware ≤6.x falls back to
  `2001-01-01` on the on-board RTC when WiFi NTP can't sync, then posts
  that year verbatim in `saveCutGrassRecord`. Records started showing
  year-2001 dates in the dashboard/app history. Server now treats any
  parsed year `< 2025` as an unsynced clock and substitutes the server
  wall clock (same Date used when no `dateTime` is supplied at all).
  No schema change; only the stored `dateTime` value is corrected on
  ingest.

## 2026-05-06 — Work records: server-side mowing-session timer (issue #17 round 5)

- `routes/equipmentState.ts` + `mqtt/sensorData.ts`: stock and custom
  firmware both ship `saveCutGrassRecord` with `workTime` either omitted
  or zeroed out, and `cov_work_time` / `valid_cov_work_time` read 0 in
  the cache even mid-session — so the existing fallback chain always
  landed at `work_time = 0`. Track sessions server-side via
  `work_status` transitions (`100`/`101`/`102`/`103`/`150` start /
  refresh, non-mowing values leave the session intact). Compute
  `round((lastActiveAt - startedAt) / 60000)` minutes when the body +
  cache chain yields zero. Cleared after the work record is persisted.
- 11 new unit tests in `__tests__/mqtt/mowingSession.test.ts`.

## 2026-05-05 — Work records: dateTime in server-local wall clock (issue #17 round 4)

- `routes/equipmentState.ts`: previous round stored ISO+Z, but the **stock
  Novabot app** renders `dateTime` verbatim — no Date parsing — so users
  saw `2026-05-04T21:19:19Z` literally. Convert UTC input to the server's
  TZ (`process.env.TZ`, default `Europe/Amsterdam`) via `Intl.DateTimeFormat`
  and emit the SQL-style `YYYY-MM-DD HH:MM:SS` form so the stock app shows
  correct local wall-clock time. The OpenNova app + dashboard re-parse via
  `toLocaleString` and stay timezone-agnostic.
- Contract tests updated to assert CEST conversion (18:13Z → 20:13).

## 2026-05-05 — Work records: dateTime keeps UTC marker (issue #17 round 3)

- Earlier attempt at the round-3 fix that stored ISO+Z. Superseded by
  round-4 above because the stock Novabot app doesn't parse it.

## 2026-05-04 — Work records: area precision, selectMap formatting, finished detection (issue #17 round 2)

- `routes/message.ts`: `POST /api/novabot-message/message/queryCutGrassRecordPageByUserId`
  three bug-fixes after waltervl follow-up screenshots:

  1. **workArea displayed with full float precision** (`298.9381103515625 m²`).
     Now rounded to 2 decimals (`298.94`) via `formatWorkArea()` — matches
     stock cloud display.

  2. **selectMap returned raw JSON** (`["map10"]` rendered literally in app).
     New `formatSelectMap()` parses the JSON, resolves canonical `mapN` slot
     ids to user aliases via `mapRepo.findBySnAndCanonical`, and collapses
     to `"All maps"` when the selection covers every work-map for the SN.
     Equipment_id → mower_sn lookup is cached per request.

- `routes/equipmentState.ts`: `POST /api/nova-data/equipmentState/saveCutGrassRecord`
  broaden `looksFinished` signal set so a normally-completed multi-map
  session that ends with `Work:CANCELLED ... Recharge: FINISHED` is no
  longer mis-tagged as `interrupted artificially`. Also accept
  `Recharge: FINISHED` and `Recharge: WAIT` as finished signals.

## 2026-05-01 — Work records: cutting-height, workTime unit, dateTime format (issue #17)

- `routes/equipmentState.ts`: `POST /api/nova-data/equipmentState/saveCutGrassRecord`
  three bug-fixes for reporter waltervl (Novabot v2.4.0 + mower v5.7.1 stock):

  1. **cutGrassHeight stored as wire+2**: The sensor-cache fallback was doing
     `target_height + 2` converting the wire enum (0-7) to user_cm before
     storing. The stored value MUST be the wire enum — identical to what the
     mower POSTs directly and what LFI cloud stores. The Novabot app and
     dashboard display `cutGrassHeight + 2` cm; storing user_cm caused the
     display to show `(user_cm + 2)` = two too many. Fix: removed `+ 2` from
     the sensor-cache fallback (`cutGrassHeight = wire`, not `wire + 2`).

  2. **workTime always 0**: The sensor-cache key `cov_work_time` carries
     seconds, but `work_records.work_time` is minutes. The old code stored
     seconds as minutes (effectively multiplying by 60 in the wrong direction).
     Fix: sensor cache fallback now tries `valid_cov_work_time` (already
     minutes) first; falls back to `Math.round(cov_work_time / 60)`.

  3. **dateTime formatted as ISO-8601**: Mower v5.7.1 sends
     `2026-04-29T18:13:10.94Z`. Server now normalises any string containing
     `'T'` to SQL format `2026-04-29 18:13:10` via
     `new Date(raw).toISOString().replace('T', ' ').slice(0, 19)`.

- `__tests__/contract/equipmentState.saveCutGrassRecord.test.ts`: 12 new
  regression tests — one per bug plus dedicated regression guards — all green.

## 2026-04-29 — Schedule: persist cutGrassHeight / area / timezone

- `routes/cutGrassPlan.ts`: `POST /api/nova-data/appManage/saveCutGrassPlan`
  +  `POST /api/nova-data/appManage/updateCutGrassPlan` now write the
  `cutGrassHeight`, `area` and `timezone` fields the Novabot app sends
  (instead of silently dropping them). `queryPlanFromMachine` and
  `queryCutGrassPlan` echo the stored values back so the mower can set
  blade height + area scope. Without this fix the mower received
  `cutGrassHeight:null` in the plan and silently refused to start the
  scheduled run — LFI cloud worked, our docker did not. Schema migration
  in `db/database.ts` adds `cut_grass_height INTEGER`, `area INTEGER`,
  `timezone TEXT` to `cut_grass_plans` (idempotent ALTER TABLE).

## 2026-04-28 — Work records: field-name variants + sensor-cache fallback

- `routes/equipmentState.ts`: `POST /api/nova-data/equipmentState/saveCutGrassRecord`
  now accepts multiple naming variants per field (camelCase / snake_case /
  abbreviation) so it tolerates firmware-rev differences in mower POST
  bodies. When a field is missing entirely, falls back to the live
  `deviceCache` snapshot — `target_height + 2` for cutting height,
  `cov_area` / `cov_work_time` for size/duration, `current_map_ids` for
  mapNames, and `msg` parsed for workStatus. Records of interrupted
  sessions now show approximate context instead of an empty row.
- Diagnostic logging dumps every inbound body key at INFO so the next
  field-name mismatch surfaces in docker logs without needing wireshark.

## 2026-04-28 — Stock-app FCM token observation

- `routes/appUser.ts`: `POST /api/nova-user/appUser/updateAppUserMachineToken`
  now logs the FCM token prefix + IMEI tail at INFO when the stock
  Novabot v2.4.0 app uploads its registration. End-to-end delivery to
  the stock app still requires Novabot's APNS/FCM credentials we don't
  have — this is observation-only. Existing JWT auth + DB write
  unchanged.

## 2026-04-27 — Work records: parse mower multipart body

- `routes/equipmentState.ts`: `POST /api/nova-data/equipmentState/saveCutGrassRecord`
  now uses `multer.none()` to parse the mower's multipart/form-data body.
  Numeric fields are coerced (workTime, workArea, cutGrassHeight); list
  fields (mapNames, week) are JSON-stringified before insert. Previously
  every record was silently discarded as "lege body", masking a fully
  wired DB pipeline. App's `queryCutGrassRecordPageByUserId` will now
  return real rows once a mowing session completes.

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
