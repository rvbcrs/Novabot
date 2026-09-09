/**
 * Test setup — in-memory SQLite DB.
 *
 * DB_PATH=:memory: is set in vitest.config.ts (`test.env`) so that database.ts
 * reads the right value at static-import time. Writing `process.env.DB_PATH`
 * here would be too late: ESM hoists imports ahead of statements, so the db
 * module would already have been initialised against the real novabot.db.
 *
 * The guard below is a safety net: if anything regresses and tests ever point
 * at a real file, we abort before `beforeEach` has a chance to `DELETE FROM`
 * every user-facing table.
 */
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';

import { beforeEach, beforeAll, afterAll } from 'vitest';
import { db } from '../db/database.js';

// Node >= 19 zet keep-alive aan op de global agent. Supertest bindt per
// request(app) een verse server op een ephemeral poort; met keep-alive poolt
// superagent sockets per host:poort, en als de OS zo'n poort binnen dit
// worker-proces hergebruikt voor een LATERE testserver krijgt een request de
// gepoolde socket naar de oude (gesloten of verkeerde) server. Symptomen in
// release-runs: "socket hang up" en 403's van routes zonder 403-pad.
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });

// Per test-BESTAND een eigen wegwerp-storage-dir. De gedeelde
// /tmp/novabot-test-storage uit vitest.config.ts lekte state tussen
// parallelle testbestanden én tussen runs (achtergebleven .active/.tgm
// terrain-bestanden) — daar faalden twee release-runs "flaky" op.
// Route-modules lezen STORAGE_PATH bij import; setupFiles draaien vóór de
// module-graph van het testbestand, dus deze override komt op tijd (de
// eigen imports hierboven raken STORAGE_PATH niet).
const testStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novabot-test-storage-'));
process.env.STORAGE_PATH = testStorageDir;

afterAll(() => {
  fs.rmSync(testStorageDir, { recursive: true, force: true });
});

// ── Opt-in HTTP-tracer voor flaky-onderzoek (TEST_HTTP_TRACE=1) ─────────────
// Logt elke respons ≥ 400 van ELKE testserver in dit proces met url, body en
// de stack van de handler, naar $TEST_HTTP_TRACE_FILE (default
// /tmp/novabot-test-http-trace.log). Idempotent over testbestanden heen.
if (process.env.TEST_HTTP_TRACE === '1') {
  const proto = http.ServerResponse.prototype as unknown as { end: (...a: unknown[]) => unknown; __traced?: boolean };
  if (!proto.__traced) {
    proto.__traced = true;
    const origEnd = proto.end;
    const traceFile = process.env.TEST_HTTP_TRACE_FILE || '/tmp/novabot-test-http-trace.log';
    proto.end = function (this: http.ServerResponse & { req?: http.IncomingMessage }, ...args: unknown[]) {
      if (this.statusCode >= 400) {
        const chunk = typeof args[0] === 'string' || Buffer.isBuffer(args[0]) ? String(args[0]).slice(0, 300) : '';
        const stack = (new Error().stack ?? '').split('\n').slice(2, 9).map(l => l.trim()).join(' | ');
        const line = `${new Date().toISOString()} ${this.statusCode} ${this.req?.method} ${this.req?.url} body=${JSON.stringify(chunk)} stack=${stack}\n`;
        try { fs.appendFileSync(traceFile, line); } catch { /* ignore */ }
      }
      return origEnd.apply(this, args as []);
    };
    // Client-kant: elke respons ≥ 400 die supertest ONTVANGT, met headers en
    // poortpaar. Een respons van een vreemd proces (403 zonder 403-pad in de
    // router) verraadt zich hier via server-headers en remotePort.
    const origRequest = http.request;
    (http as unknown as { request: typeof http.request }).request = function (this: unknown, ...a: Parameters<typeof http.request>) {
      const req = origRequest.apply(this, a);
      req.on('response', (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          const sock = res.socket;
          const line = `${new Date().toISOString()} CLIENT ${res.statusCode} ${req.method} ${req.path} remote=${sock?.remoteAddress}:${sock?.remotePort} local=${sock?.localPort} headers=${JSON.stringify(res.headers)}\n`;
          try { fs.appendFileSync(traceFile, line); } catch { /* ignore */ }
        }
      });
      return req;
    } as typeof http.request;
  }
}

beforeAll(() => {
  // better-sqlite3 reports ":memory:" unchanged; any real file path is a bug.
  if (db.name !== ':memory:') {
    throw new Error(
      `Test DB is not :memory: (got ${db.name}). Refusing to run — would wipe live data. ` +
      `Check vitest.config.ts test.env.DB_PATH.`,
    );
  }
});

// Clean ALL tables before each test (disable FK to avoid ordering issues)
beforeEach(() => {
  db.pragma('foreign_keys = OFF');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const { name } of tables) {
    db.exec(`DELETE FROM "${name}"`);
  }
  db.pragma('foreign_keys = ON');
});
