/**
 * Response wrappers for cloud-api. Private to cloud-api — dashboard/admin
 * use their own. Shape matches what the official Novabot app parses.
 *
 * NOTE: Copied verbatim from `src/types/index.ts` on 2026-04-23. Behaviour
 * identical — same field order, same `dateline: Date.now()`, same default
 * `message: 'request success'` for ok(). Task 9 will switch cloud-api route
 * imports over; the old copies stay in `types/index.ts` for dashboard/admin
 * consumers until those are separately migrated.
 */

export interface CloudOkResponse<T> {
  success: true;
  code: 200;
  message: string;
  value: T;
  dateline: number;
}

export interface CloudFailResponse {
  success: false;
  code: number;
  message: string;
  value: null;
  dateline: number;
}

// Exact response format van de echte Novabot API
export function ok<T = unknown>(value: T = null as T): CloudOkResponse<T> {
  return { success: true, code: 200, message: 'request success', value, dateline: Date.now() };
}

export function fail(message: string, code = 500): CloudFailResponse {
  return { success: false, code, message, value: null, dateline: Date.now() };
}
