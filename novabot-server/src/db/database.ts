import Database from 'better-sqlite3';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const dbPath = process.env.DB_PATH ?? './novabot.db';
export const db = new Database(path.resolve(dbPath));

// WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      app_user_id TEXT    NOT NULL UNIQUE,
      email       TEXT    NOT NULL UNIQUE,
      password    TEXT    NOT NULL,
      username    TEXT,
      machine_token TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_codes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT    NOT NULL,
      code       TEXT    NOT NULL,
      type       TEXT    NOT NULL,  -- 'register' | 'reset_password'
      expires_at TEXT    NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS equipment (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id        TEXT    NOT NULL UNIQUE,
      user_id             TEXT,
      mower_sn            TEXT    NOT NULL UNIQUE,
      charger_sn          TEXT,
      equipment_nick_name TEXT,
      equipment_type_h    TEXT,
      mower_version       TEXT,
      charger_version     TEXT,
      charger_address     TEXT,
      charger_channel     TEXT,
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(app_user_id)
    );

    -- Map metadata; actual binary map data is stored on disk
    CREATE TABLE IF NOT EXISTS maps (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      map_id      TEXT    NOT NULL UNIQUE,
      mower_sn    TEXT    NOT NULL,
      map_name    TEXT,
      -- JSON array of GPS coordinate objects {lat, lng}
      map_area    TEXT,
      -- JSON object {minLat, maxLat, minLng, maxLng}
      map_max_min TEXT,
      -- Filename of the binary blob stored in storage/maps/
      file_name   TEXT,
      file_size   INTEGER,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Chunked upload tracking
    CREATE TABLE IF NOT EXISTS map_uploads (
      upload_id     TEXT    NOT NULL,
      mower_sn      TEXT    NOT NULL,
      file_size     INTEGER NOT NULL,
      chunks_total  INTEGER,
      chunks_received INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (upload_id)
    );

    CREATE TABLE IF NOT EXISTS cut_grass_plans (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id      TEXT    NOT NULL UNIQUE,
      equipment_id TEXT    NOT NULL,
      user_id      TEXT    NOT NULL,
      start_time   TEXT,
      end_time     TEXT,
      -- JSON array of weekday numbers [0-6]
      weekday      TEXT,
      repeat       INTEGER NOT NULL DEFAULT 0,
      repeat_count INTEGER NOT NULL DEFAULT 0,
      repeat_type  TEXT,
      work_time    INTEGER,
      -- JSON array of area objects
      work_area    TEXT,
      work_day     TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (equipment_id) REFERENCES equipment(equipment_id)
    );

    CREATE TABLE IF NOT EXISTS robot_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id      TEXT    NOT NULL UNIQUE,
      user_id         TEXT    NOT NULL,
      equipment_id    TEXT,
      robot_msg       TEXT    NOT NULL,
      robot_msg_date  TEXT    NOT NULL DEFAULT (datetime('now')),
      robot_msg_unread INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(app_user_id)
    );

    CREATE TABLE IF NOT EXISTS work_records (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id           TEXT    NOT NULL UNIQUE,
      user_id             TEXT    NOT NULL,
      equipment_id        TEXT,
      work_record_date    TEXT    NOT NULL DEFAULT (datetime('now')),
      work_status         TEXT,
      work_time           INTEGER,
      work_record_unread  INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(app_user_id)
    );

    CREATE TABLE IF NOT EXISTS ota_versions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      version     TEXT    NOT NULL,
      device_type TEXT    NOT NULL DEFAULT 'mower',
      release_notes TEXT,
      download_url  TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Dynamisch apparaatregister: gevuld zodra een apparaat via MQTT verbindt.
    -- sn is het serienummer zoals herkend uit de MQTT client ID of username.
    CREATE TABLE IF NOT EXISTS device_registry (
      mqtt_client_id  TEXT    NOT NULL PRIMARY KEY,
      sn              TEXT,
      mac_address     TEXT,
      mqtt_username   TEXT,
      last_seen       TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS device_registry_sn ON device_registry(sn);

    -- Cache LoRa-parameters per SN zodat ze bewaard blijven na unbind (DELETE uit equipment).
    -- Zonder deze waarden stuurt de app addr:null in set_lora_info → charger crasht.
    CREATE TABLE IF NOT EXISTS equipment_lora_cache (
      sn              TEXT    NOT NULL PRIMARY KEY,
      charger_address TEXT,
      charger_channel TEXT
    );

    -- Pre-seed bekende apparaten zodat getEquipmentBySN direct chargerAddress kan teruggeven
    -- vóórdat het apparaat ooit gebonden is geweest (nodig voor eerste BLE provisioning).
    INSERT OR IGNORE INTO equipment_lora_cache (sn, charger_address, charger_channel)
    VALUES ('LFIC1230700004', '718', '16');

    -- Voeg mac_address kolom toe aan equipment als die nog niet bestaat
    -- (SQLite ondersteunt geen IF NOT EXISTS op kolommen, dus via try-catch in code)

    -- Dashboard maaischema's (geen auth, lokaal netwerk)
    CREATE TABLE IF NOT EXISTS dashboard_schedules (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id     TEXT    NOT NULL UNIQUE,
      mower_sn        TEXT    NOT NULL,
      schedule_name   TEXT,
      start_time      TEXT    NOT NULL,  -- HH:MM
      end_time        TEXT,              -- HH:MM (optioneel)
      weekdays        TEXT    NOT NULL DEFAULT '[]',  -- JSON array [0-6], 0=zondag
      enabled         INTEGER NOT NULL DEFAULT 1,
      map_id          TEXT,
      map_name        TEXT,
      cutting_height  INTEGER DEFAULT 40,   -- mm
      path_direction  INTEGER DEFAULT 0,    -- graden 0-360
      work_mode       INTEGER DEFAULT 0,
      task_mode       INTEGER DEFAULT 0,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Map calibratie: handmatige offset/rotatie/schaal per maaier
    CREATE TABLE IF NOT EXISTS map_calibration (
      mower_sn    TEXT    NOT NULL PRIMARY KEY,
      offset_lat  REAL    NOT NULL DEFAULT 0,
      offset_lng  REAL    NOT NULL DEFAULT 0,
      rotation    REAL    NOT NULL DEFAULT 0,
      scale       REAL    NOT NULL DEFAULT 1,
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Voeg mac_address kolom toe aan equipment (migratie – veilig om te herhalen)
  try {
    db.exec(`ALTER TABLE equipment ADD COLUMN mac_address TEXT`);
    console.log('[DB] Migrated: added equipment.mac_address');
  } catch {
    // Kolom bestaat al — geen actie nodig
  }

  // Migratie: user_id nullable maken (was NOT NULL, cloud verwijdert records nooit maar zet user_id=NULL bij unbind)
  // SQLite kan geen NOT NULL constraint verwijderen, dus herbouw de tabel
  {
    const info = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='equipment'`).get() as { sql: string } | undefined;
    if (info?.sql?.includes('user_id') && info.sql.includes('user_id             TEXT    NOT NULL')) {
      console.log('[DB] Migrating equipment: making user_id nullable...');
      db.exec(`
        CREATE TABLE equipment_new (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          equipment_id        TEXT    NOT NULL UNIQUE,
          user_id             TEXT,
          mower_sn            TEXT    NOT NULL UNIQUE,
          charger_sn          TEXT,
          equipment_nick_name TEXT,
          equipment_type_h    TEXT,
          mower_version       TEXT,
          charger_version     TEXT,
          charger_address     TEXT,
          charger_channel     TEXT,
          mac_address         TEXT,
          created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(app_user_id)
        );
        INSERT INTO equipment_new SELECT id, equipment_id, user_id, mower_sn, charger_sn,
          equipment_nick_name, equipment_type_h, mower_version, charger_version,
          charger_address, charger_channel, mac_address, created_at FROM equipment;
        DROP TABLE equipment;
        ALTER TABLE equipment_new RENAME TO equipment;
      `);
      console.log('[DB] Migrated: equipment.user_id is now nullable');
    }
  }

  // Nieuwe kolommen voor maaier work records (saveCutGrassRecord endpoint)
  for (const col of [
    'work_area_m2 REAL',
    'cut_grass_height INTEGER',
    'map_names TEXT',
    'start_way TEXT',
    'schedule_id TEXT',
    'week TEXT',
    'date_time TEXT',
  ]) {
    try { db.exec(`ALTER TABLE work_records ADD COLUMN ${col}`); }
    catch { /* kolom bestaat al */ }
  }

  // WiFi credentials (cloud slaat deze op en retourneert ze in userEquipmentList)
  for (const col of ['wifi_name TEXT', 'wifi_password TEXT']) {
    try { db.exec(`ALTER TABLE equipment ADD COLUMN ${col}`); }
    catch { /* kolom bestaat al */ }
  }

  // Charger GPS positie in map_calibration (migratie)
  for (const col of ['charger_lat REAL', 'charger_lng REAL']) {
    try { db.exec(`ALTER TABLE map_calibration ADD COLUMN ${col}`); }
    catch { /* kolom bestaat al */ }
  }

  // Voeg map_type kolom toe aan maps (migratie – work/obstacle/unicom)
  try {
    db.exec(`ALTER TABLE maps ADD COLUMN map_type TEXT NOT NULL DEFAULT 'work'`);
    console.log('[DB] Migrated: added maps.map_type');
  } catch {
    // Kolom bestaat al — geen actie nodig
  }
  // Migreer bestaande kaarten op basis van map_id en map_name patronen (idempotent)
  const migrated = db.prepare(`
    UPDATE maps SET map_type = 'obstacle'
    WHERE map_type = 'work'
      AND (map_id LIKE '%obstacle%' OR map_name LIKE '%obstakel%' OR map_name LIKE '%obstacle%'
           OR map_name LIKE '%trampoline%' OR map_name LIKE '%speeltoestel%')
  `).run();
  const migratedUnicom = db.prepare(`
    UPDATE maps SET map_type = 'unicom'
    WHERE map_type = 'work'
      AND (map_id LIKE '%unicom%' OR map_name LIKE '%kanaal%' OR map_name LIKE '%channel%' OR map_name LIKE '%pad naar%')
  `).run();
  if (migrated.changes > 0 || migratedUnicom.changes > 0) {
    console.log(`[DB] Migrated map_type: ${migrated.changes} obstacles, ${migratedUnicom.changes} unicom`);
  }

  // OTA versions: voeg md5 kolom toe (migratie)
  try { db.exec(`ALTER TABLE ota_versions ADD COLUMN md5 TEXT`); }
  catch { /* kolom bestaat al */ }

  console.log('[DB] Database initialised');
}
