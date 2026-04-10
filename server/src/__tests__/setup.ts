/**
 * Test setup — in-memory SQLite DB.
 * Disable FK constraints during test cleanup to avoid ordering issues.
 */
process.env.DB_PATH = ':memory:';

import { beforeEach } from 'vitest';
import { db } from '../db/database.js';

// Clean ALL tables before each test (disable FK to avoid ordering issues)
beforeEach(() => {
  db.pragma('foreign_keys = OFF');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const { name } of tables) {
    db.exec(`DELETE FROM "${name}"`);
  }
  db.pragma('foreign_keys = ON');
});
