/**
 * OpenNova render relay.
 *
 * Lets someone generate a garden render without their own OpenAI account: they
 * put a token in their OpenNova settings, their server posts the composite
 * here, and this relay spends one credit and forwards the call with the
 * project's key. The key never leaves this machine.
 *
 * Deliberately dependency-free (Node 20+ has fetch, FormData and Blob) and
 * file-backed: this handles tens of tokens, not thousands, and a JSON file is
 * easier to back up and to read by eye than a database.
 *
 *   PORT              listen port (default 3334)
 *   OPENAI_API_KEY    the project's key — required
 *   ADMIN_KEY         secret for the /admin endpoints — required
 *   DATA_FILE         token store (default ./data/tokens.json)
 *   RENDER_MODEL      image model (default gpt-image-2.5-sunburst)
 *   MAX_IMAGE_BYTES   refuse bigger uploads (default 12 MB)
 *   DAILY_TOTAL_CAP   renders per day across all tokens (default 200)
 *
 * Endpoints:
 *   POST /render      Bearer token, multipart (prompt, size, quality, image[])
 *                     → image/png. Spends one credit.
 *   GET  /credits     Bearer token → { credits, used, dailyUsed }
 *   POST /admin/tokens  X-Admin-Key → { token, credits } (mint or top up)
 *   GET  /admin/tokens  X-Admin-Key → the store, tokens truncated
 *   GET  /health
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT ?? 3334);
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? '';
const ADMIN_KEY = process.env.ADMIN_KEY ?? '';
const DATA_FILE = path.resolve(process.env.DATA_FILE ?? './data/tokens.json');
const MODEL = process.env.RENDER_MODEL ?? 'gpt-image-2.5-sunburst';
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES ?? 12 * 1024 * 1024);
const DAILY_TOTAL_CAP = Number(process.env.DAILY_TOTAL_CAP ?? 200);

if (!OPENAI_KEY || !ADMIN_KEY) {
  console.error('OPENAI_API_KEY and ADMIN_KEY are required');
  process.exit(1);
}

// ── Token store ─────────────────────────────────────────────────────────────
// { tokens: { <sha256>: { credits, used, note, createdAt, lastUsedAt, day, dayUsed } },
//   daily: { day, count } }

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { tokens: {}, daily: { day: '', count: 0 } }; }
}

function save(store) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, DATA_FILE);       // atomic: a crash never truncates the store
}

/** Tokens are stored hashed, so a leaked backup cannot be spent. */
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);

function bearer(req) {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/** Constant-time compare, so the admin key cannot be guessed byte by byte. */
function secretEquals(a, b) {
  const ab = Buffer.from(a ?? '');
  const bb = Buffer.from(b ?? '');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Multipart ───────────────────────────────────────────────────────────────
// Only what the OpenNova client sends: a few text fields and one image.

function parseMultipart(buf, boundary) {
  const sep = Buffer.from(`--${boundary}`);
  const parts = []; let i = buf.indexOf(sep);
  while (i !== -1) {
    const start = i + sep.length;
    if (buf.slice(start, start + 2).toString() === '--') break;   // closing boundary
    const next = buf.indexOf(sep, start);
    if (next === -1) break;
    const chunk = buf.slice(start + 2, next - 2);                 // strip the CRLFs
    const headEnd = chunk.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const head = chunk.slice(0, headEnd).toString();
      const name = /name="([^"]+)"/.exec(head)?.[1] ?? '';
      const filename = /filename="([^"]*)"/.exec(head)?.[1];
      const type = /Content-Type:\s*([^\r\n]+)/i.exec(head)?.[1];
      parts.push({ name, filename, type, data: chunk.slice(headEnd + 4) });
    }
    i = next;
  }
  return parts;
}

// ── Render ──────────────────────────────────────────────────────────────────

async function handleRender(req, res) {
  const token = bearer(req);
  if (!token) return json(res, 401, { error: 'missing token' });
  const store = load();
  const entry = store.tokens[hash(token)];
  if (!entry) return json(res, 403, { error: 'unknown token' });
  if (entry.credits <= 0) return json(res, 402, { error: 'no credits left' });

  const day = today();
  if (store.daily.day !== day) store.daily = { day, count: 0 };
  if (store.daily.count >= DAILY_TOTAL_CAP) return json(res, 429, { error: 'daily cap reached, try tomorrow' });
  if (entry.day !== day) { entry.day = day; entry.dayUsed = 0; }
  if (entry.dayUsed >= 20) return json(res, 429, { error: 'daily cap for this token reached' });

  const ctype = req.headers['content-type'] ?? '';
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ctype)?.[1] ?? /boundary=(?:"([^"]+)"|([^;]+))/.exec(ctype)?.[2];
  if (!boundary) return json(res, 400, { error: 'expected multipart/form-data' });

  let body;
  try { body = await readBody(req, MAX_IMAGE_BYTES + 64 * 1024); }
  catch { return json(res, 413, { error: 'image too large' }); }

  const parts = parseMultipart(body, boundary.trim());
  const image = parts.find((p) => p.filename !== undefined);
  const prompt = parts.find((p) => p.name === 'prompt')?.data.toString() ?? '';
  const size = parts.find((p) => p.name === 'size')?.data.toString() ?? '1536x1024';
  const quality = parts.find((p) => p.name === 'quality')?.data.toString() ?? 'high';
  if (!image) return json(res, 400, { error: 'no image' });
  if (image.data.length > MAX_IMAGE_BYTES) return json(res, 413, { error: 'image too large' });
  if (prompt.length > 8000) return json(res, 400, { error: 'prompt too long' });

  // Spend the credit BEFORE the call: a crash mid-flight must not hand out a
  // free render, and a refund on failure is the smaller error.
  entry.credits -= 1; entry.used = (entry.used ?? 0) + 1; entry.dayUsed += 1;
  entry.lastUsedAt = new Date().toISOString();
  store.daily.count += 1;
  save(store);

  const form = new FormData();
  form.append('model', MODEL);
  form.append('prompt', prompt);
  form.append('size', size);
  form.append('quality', quality);
  form.append('image[]', new Blob([image.data], { type: image.type ?? 'image/png' }), 'garden.png');

  try {
    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST', headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: form,
    });
    if (!r.ok) throw new Error(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const out = await r.json();
    const b64 = out?.data?.[0]?.b64_json;
    if (!b64) throw new Error('upstream returned no image');
    const png = Buffer.from(b64, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
    res.end(png);
    console.log(`[relay] render ok, ${entry.credits} credits left for ${entry.note ?? 'token'}`);
  } catch (err) {
    // Refund: the user got nothing, so they should not have paid.
    const s = load();
    const e = s.tokens[hash(token)];
    if (e) { e.credits += 1; e.used = Math.max(0, (e.used ?? 1) - 1); e.dayUsed = Math.max(0, e.dayUsed - 1); }
    s.daily.count = Math.max(0, s.daily.count - 1);
    save(s);
    console.error(`[relay] render failed, credit refunded: ${err.message}`);
    json(res, 502, { error: String(err.message).slice(0, 300) });
  }
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://relay');
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && (p === '/health' || p === '/')) {
    return json(res, 200, { ok: true, model: MODEL });
  }

  if (req.method === 'POST' && (p === '/render' || p === '/')) {
    return handleRender(req, res).catch((e) => json(res, 500, { error: e.message }));
  }

  if (req.method === 'GET' && p === '/credits') {
    const entry = load().tokens[hash(bearer(req))];
    if (!entry) return json(res, 403, { error: 'unknown token' });
    return json(res, 200, {
      credits: entry.credits,
      used: entry.used ?? 0,
      dailyUsed: entry.day === today() ? entry.dayUsed : 0,
    });
  }

  if (p.startsWith('/admin')) {
    if (!secretEquals(req.headers['x-admin-key'], ADMIN_KEY)) return json(res, 403, { error: 'forbidden' });

    if (req.method === 'POST' && p === '/admin/tokens') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
      const credits = Math.max(1, Math.min(500, Number(body.credits ?? 10)));
      const store = load();
      // Topping up an existing token keeps its history; otherwise mint a new one.
      const token = body.token ?? `opennova-${crypto.randomBytes(16).toString('hex')}`;
      const h = hash(token);
      const entry = store.tokens[h] ?? { credits: 0, used: 0, createdAt: new Date().toISOString(), day: '', dayUsed: 0 };
      entry.credits += credits;
      if (body.note) entry.note = String(body.note).slice(0, 80);
      store.tokens[h] = entry;
      save(store);
      // The plaintext token is shown once, here; only its hash is stored.
      return json(res, 200, { token, credits: entry.credits, note: entry.note ?? null });
    }

    if (req.method === 'GET' && p === '/admin/tokens') {
      const store = load();
      return json(res, 200, {
        daily: store.daily,
        tokens: Object.entries(store.tokens).map(([h, e]) => ({ hash: `${h.slice(0, 12)}…`, ...e })),
      });
    }
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`[relay] listening on ${PORT}, model ${MODEL}, store ${DATA_FILE}`));
