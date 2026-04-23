/**
 * LFI cloud HTTP client helpers.
 *
 * Extracted on 2026-04-23 (Task 9 — cloud-api route move) from
 * `src/routes/setup.ts` so both `routes/setup.ts` (imports admin-side) and
 * `cloud-api/routes/appUser.ts` (imports cloud-api-side) can share the same
 * implementation without cloud-api reaching into `routes/setup.ts`.
 *
 * Logic is IDENTICAL to the previous in-file definitions in `setup.ts` —
 * same AES key/IV, same header construction, same signature algorithm, same
 * 15s timeout. See `setup.ts` git history for the original commit that added
 * these helpers (ported from `bootstrap/src/server.ts`).
 *
 * This file is PRIVATE to the server. It is neutral w.r.t. cloud-api freeze
 * rules (it lives under `src/services/`, not `src/cloud-api/*` and not
 * `src/routes/setup*`), so both sides may import it safely.
 */

import https from 'https';
import crypto from 'crypto';

// ── LFI Cloud API helpers (copied from bootstrap/src/server.ts) ──────────────
// These are proven working — do NOT modify without testing against the real cloud.

export const LFI_CLOUD_HOST = '47.253.145.99';
export const LFI_CLOUD_SERVERNAME = 'app.lfibot.com';
const APP_PW_KEY_IV = Buffer.from('1234123412ABCDEF', 'utf8');

export function encryptCloudPassword(plainPassword: string): string {
  const cipher = crypto.createCipheriv('aes-128-cbc', APP_PW_KEY_IV, APP_PW_KEY_IV);
  let encrypted = cipher.update(plainPassword, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
}

export function makeLfiHeaders(token: string): Record<string, string> {
  const echostr = 'p' + crypto.randomBytes(6).toString('hex');
  const ts = String(Date.now());
  const nonce = crypto.createHash('sha1').update('qtzUser', 'utf8').digest('hex');
  const sig = crypto.createHash('sha256')
    .update(echostr + nonce + ts + token, 'utf8').digest('hex');
  return {
    'Host': 'app.lfibot.com',
    'Authorization': token,
    'Content-Type': 'application/json;charset=UTF-8',
    'source': 'app',
    'userlanguage': 'en',
    'echostr': echostr,
    'nonce': nonce,
    'timestamp': ts,
    'signature': sig,
  };
}

export function callLfiCloud(
  method: string, urlPath: string,
  body: Record<string, unknown> | null, token = ''
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers: Record<string, string> = {
      ...makeLfiHeaders(token),
      ...(bodyStr ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
    };
    const opts: https.RequestOptions = {
      hostname: LFI_CLOUD_HOST,
      path: urlPath,
      method,
      headers,
      rejectUnauthorized: false,
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Cloud API invalid JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Cloud API timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
