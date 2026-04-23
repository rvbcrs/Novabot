/**
 * App-user DTO serializers — response shapes for `/api/nova-user/appUser/*`
 * (and the `/api/nova-user/user/*` alias). Currently scoped to the login
 * endpoint; other appUser routes (regist, loginOut, appUserInfo, …) may add
 * their own schemas here as they pick up contract coverage.
 *
 * The login handler wraps its payload via `ok()` from `types/index.ts`, so
 * the outer envelope is the standard `{ success, code, value, message,
 * dateline }` shape used everywhere in the cloud-api surface.
 *
 * Field-by-field notes for `value` on the success path:
 *   - `appUserId` is the integer SQLite row PK (`users.id`), NOT the UUID
 *     `app_user_id`. The Novabot app's Dart code types this field as `int`;
 *     emitting the UUID there would trigger a CastError in production. See
 *     the comment block in `cloud-api/routes/appUser.ts`.
 *   - `accessToken` is a JWT signed by `middleware/auth.ts#signToken`.
 *   - `firstName` defaults to `user.username ?? ''` (empty string, NOT
 *     null). `lastName`, `phone`, `country`, `city`, `address`, `coordinates`
 *     are always emitted as `''` (empty string) because the local server
 *     doesn't collect these fields but the app still expects the keys to be
 *     present.
 *   - `newUserFlag` is always literal `0` — the local server has no notion
 *     of "first-time user" to toggle this.
 *
 * On the failure path (`fail(...)` → `{ success: false, code, message, value:
 * null, dateline }`) the `value` field is `null`, so `loginResponseSchema`
 * makes `value` nullable.
 */
import { z } from 'zod';

/**
 * Inner `value` payload returned by the login handler on the success branch.
 * Every field is mandatory — the handler always emits the full object
 * literal, so a missing field indicates a regression in the route handler.
 */
export const loginValueSchema = z.object({
  appUserId:    z.number(),
  email:        z.string(),
  phone:        z.string(),
  firstName:    z.string(),
  lastName:     z.string(),
  accessToken:  z.string(),
  newUserFlag:  z.number(),
  country:      z.string(),
  city:         z.string(),
  address:      z.string(),
  coordinates:  z.string(),
});

export type LoginValue = z.infer<typeof loginValueSchema>;

/**
 * Full response envelope for `POST /api/nova-user/user/login` (and the
 * `/appUser/login` alias). On success `value` is populated; on "invalid
 * email or password" the handler emits `fail(...)` which sets `value: null`
 * — hence the `.nullable()`.
 */
export const loginResponseSchema = z.object({
  success:  z.boolean(),
  code:     z.number(),
  value:    loginValueSchema.nullable(),
  message:  z.string().nullable(),
  dateline: z.number().optional(),
});
