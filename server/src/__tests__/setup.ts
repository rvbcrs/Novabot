/**
 * Test setup — creates an in-memory SQLite DB and initializes the schema.
 * The repositories use the singleton `db` from database.ts, so we need to
 * set DB_PATH to :memory: BEFORE any imports happen.
 */
process.env.DB_PATH = ':memory:';
