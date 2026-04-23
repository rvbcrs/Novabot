/**
 * Map DTO serializer — frozen contract for `queryEquipmentMap`.
 *
 * The Novabot app (v2.4.0) treats this response as load-bearing for map
 * rendering, zone selection and coverage area display. A single missing or
 * mistyped field ("mapArea" as number instead of string, md5 lowercase,
 * chargingPose coords as numbers) silently breaks the mower UI. This Zod
 * schema captures exactly what `routes/map.ts::queryEquipmentMap` emits so
 * regressions surface as loud test failures instead of "No map!" in the app.
 *
 * Locked invariants (derived from the live handler + CLAUDE.md):
 *   - `data` is `null` OR `{ work[], unicom[] }` — never an empty object.
 *   - `md5` is `null` OR a 32-char UPPERCASE hex digest. The handler uses
 *     `.toUpperCase()` on both the ZIP-based and the map_id-join fallback
 *     path, so mixed/lowercase hex would indicate a regression.
 *   - `machineExtendedField` is `null` when there's no map ZIP, or an
 *     object with a `chargingPose` containing x/y/orientation as strings
 *     (Dart parses them via `double._parse()`).
 *   - Work items carry `mapArea` as a string ("6.22", m²). Unicom and
 *     obstacle items do NOT carry `mapArea` or `obstacle` fields (cloud
 *     parity — extra fields break app parsing).
 *
 * The envelope matches `ok()` in `cloud-api/helpers/response.ts`.
 */
import { z } from 'zod';

/**
 * Shared entry for the `unicom` array. The handler emits only
 * `fileName`, `fileHash`, `alias`, `type`, `url` — no `mapArea`,
 * no `obstacle`. Cloud parity is verified live (23 apr 2026).
 */
const unicomEntrySchema = z.object({
  fileName: z.string(),
  fileHash: z.string().regex(/^[a-f0-9]{32}$/), // lowercase md5 of map_id
  alias:    z.string(),
  type:     z.literal('unicom'),
  url:      z.string().url(),
});

/**
 * Obstacle entry — nested inside a work item's `obstacle` array. Same
 * minimal shape as unicom: no mapArea, no nested obstacle list.
 */
const obstacleEntrySchema = z.object({
  fileName: z.string(),
  fileHash: z.string().regex(/^[a-f0-9]{32}$/),
  alias:    z.string(),
  type:     z.literal('obstacle'),
  url:      z.string().url(),
});

/**
 * Work entry. `mapArea` is the polygon surface area in m² rendered as a
 * string (e.g. "6.22"). The Novabot app parses this via `double._parse()`
 * for the "Size: X m²" display and the estimated mow-time calculation
 * (`area * 0.03 / 3600`). Storing it as a number or JSON-encoded polygon
 * breaks both.
 */
const workEntrySchema = z.object({
  fileName: z.string(),
  fileHash: z.string().regex(/^[a-f0-9]{32}$/),
  alias:    z.string(),
  type:     z.literal('map'),
  url:      z.string().url(),
  mapArea:  z.string(), // oppervlakte in m² als string
  obstacle: z.array(obstacleEntrySchema),
});

/**
 * The full `data` payload. `null` is the legitimate no-maps response;
 * anything else MUST be the populated `{ work, unicom }` object.
 */
const mapDataSchema = z.object({
  work:   z.array(workEntrySchema),
  unicom: z.array(unicomEntrySchema),
});

/**
 * `chargingPose` sub-object. Every field is a string — the app parses
 * them to doubles on the Dart side. Emitting numbers here would crash
 * `ChargingPostion.fromJson`.
 */
const chargingPoseSchema = z.object({
  x:           z.string(),
  y:           z.string(),
  orientation: z.string(),
});

const machineExtendedFieldSchema = z.object({
  chargingPose: chargingPoseSchema,
});

/**
 * Inner `value` payload of `queryEquipmentMap`. Mirrors the handler's
 * three res.json(ok({...})) branches exactly:
 *   1. SN not owned → data=null, md5=null, machineExtendedField=null
 *   2. Owned but no maps → data=null, md5=null, machineExtendedField=null
 *   3. Populated → data={work,unicom}, md5=UPPERCASE hex or null,
 *      machineExtendedField=null or {chargingPose}
 */
export const queryEquipmentMapValueSchema = z.object({
  data:                 mapDataSchema.nullable(),
  // Handler emits either null (no maps / no ZIP fallback triggered) or a
  // 32-char UPPERCASE hex digest. Keep strict — a lowercase hex would
  // indicate a regression in the .toUpperCase() call site.
  md5:                  z.string().regex(/^[A-F0-9]{32}$/).nullable(),
  machineExtendedField: machineExtendedFieldSchema.nullable(),
});

/**
 * Full `ok()`-wrapped response for `GET /api/nova-file-server/map/queryEquipmentMap`.
 * Kept in sync with `cloud-api/helpers/response.ts::ok()`.
 */
export const queryEquipmentMapResponseSchema = z.object({
  success:  z.literal(true),
  code:     z.literal(200),
  value:    queryEquipmentMapValueSchema,
  message:  z.string(),
  dateline: z.number(),
});

export type QueryEquipmentMapResponse = z.infer<typeof queryEquipmentMapResponseSchema>;
