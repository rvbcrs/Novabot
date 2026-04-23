/**
 * OTA DTO serializer — frozen contract for `checkOtaNewVersion`.
 *
 * IMPORTANT: this is the **HTTP** response shape returned by
 * `GET /api/nova-user/otaUpgrade/checkOtaNewVersion`. It is NOT the MQTT
 * `ota_upgrade_cmd` payload that the broker publishes to the mower — that
 * payload (with `cmd:"upgrade"`, `type:"full"`, `content:"app"`, no `tz`) is
 * built in `mqtt/broker.ts` and intentionally lives outside this freeze.
 *
 * Two legitimate response shapes, mirroring the handler's two `res.json(ok(...))`
 * branches in `cloud-api/routes/otaUpgrade.ts`:
 *
 *   1. No update available → `value: null`
 *      (there is deliberately NO `upgradeFlag: 0` object form — the handler
 *      returns a bare `null`; the Novabot app treats that as "no upgrade").
 *   2. Update available    → `value: { version, downloadUrl, md5, upgradeFlag: 1, releaseNotes }`
 *
 * CLAUDE.md OTA invariants enforced here:
 *   - `upgradeFlag` is always literal `1` in the "update available" branch
 *     (never `true`, never `'1'`, never `0` — the app's firmware-update path
 *     only fires on this exact int).
 *   - `downloadUrl` is always `http://…` — the handler rewrites `https://` to
 *     `http://` because the local server has no TLS and the mower's firmware
 *     refuses TLS downloads. Contract test asserts both the positive match
 *     and the explicit https rejection.
 *   - `md5` and `releaseNotes` can be empty/null respectively when the DB row
 *     didn't populate them; kept nullable here to mirror the handler's
 *     `?? ''` / `?? null` defaults without hiding drift.
 *
 * The envelope matches `types/index.ts::ok()` (used by the handler), which
 * differs slightly from `cloud-api/helpers/response.ts::ok()` — both emit
 * `{ success, code, message, value, dateline }`, with `message` as a plain
 * string ("request success"), not `null`.
 */
import { z } from 'zod';

/**
 * "Update available" payload. Mirrors the handler's object exactly:
 *   { version, downloadUrl, md5, upgradeFlag: 1, releaseNotes }
 *
 * - `version`: the firmware version string from `ota_versions.version`.
 * - `downloadUrl`: always `http://…` (handler rewrites any https:// to http://).
 *   The positive test asserts the `^http://` prefix; a separate negative
 *   assertion rejects `^https://` to guard against a future "just remove the
 *   rewrite" regression.
 * - `md5`: handler emits `latest.md5 ?? ''`, so this is a string (possibly '').
 * - `upgradeFlag`: hard-coded literal 1 in the handler.
 * - `releaseNotes`: handler passes through `latest.release_notes` (nullable).
 */
export const otaUpdateAvailableSchema = z.object({
  version:      z.string(),
  downloadUrl:  z.string().regex(/^http:\/\//, 'downloadUrl must be http:// per CLAUDE.md OTA rules'),
  md5:          z.string(),
  upgradeFlag:  z.literal(1),
  releaseNotes: z.string().nullable(),
});

/**
 * Full `ok()`-wrapped response. `value` is either the update-available object
 * or a bare `null` — no other shape is valid.
 */
export const checkOtaNewVersionResponseSchema = z.object({
  success:  z.literal(true),
  code:     z.literal(200),
  value:    otaUpdateAvailableSchema.nullable(),
  message:  z.string(),
  dateline: z.number(),
});

export type CheckOtaNewVersionResponse = z.infer<typeof checkOtaNewVersionResponseSchema>;
