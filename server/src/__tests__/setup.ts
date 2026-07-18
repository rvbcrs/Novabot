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
