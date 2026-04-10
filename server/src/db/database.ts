import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const dbPath = process.env.DB_PATH ?? './novabot.db';
// :memory: is a special SQLite token — path.resolve would turn it into a file path
export const db = new Database(dbPath === ':memory:' ? ':memory:' : path.resolve(dbPath));

// WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// initDb() wordt hier gedefinieerd EN direct aangeroepen aan het einde van dit bestand,
// zodat tabellen gegarandeerd bestaan voordat andere modules db.prepare() aanroepen op module-level.
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
      -- JSON array of local coordinate objects {x, y} in meters (charger = 0,0)
      map_area    TEXT,
      -- JSON object {minX, maxX, minY, maxY} in meters
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

    -- Factory device lookup — pre-loaded from LFI cloud scan.
    -- Contains SN → MAC mapping for BLE provisioning without cloud dependency.
    CREATE TABLE IF NOT EXISTS device_factory (
      sn              TEXT    NOT NULL PRIMARY KEY,
      device_type     TEXT,                          -- 'charger' or 'mower'
      mac_address     TEXT,                          -- BLE MAC address
      equipment_type  TEXT,                          -- 'LFIC1', 'LFIN2', etc.
      sys_version     TEXT,                          -- factory firmware version
      charger_address INTEGER,                       -- LoRa address (718 typical)
      charger_channel INTEGER,                       -- LoRa channel
      mqtt_account    TEXT,                          -- MQTT username
      mqtt_password   TEXT,                          -- MQTT password
      model           TEXT                           -- 'N1000', 'N2000'
    );

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
    INSERT OR IGNORE INTO equipment_lora_cache (sn, charger_address, charger_channel)
    VALUES ('LFIN2230700238', '718', '15');

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

    -- Signaal historie: periodieke samples van sensor waarden per apparaat
    CREATE TABLE IF NOT EXISTS signal_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sn          TEXT    NOT NULL,
      ts          TEXT    NOT NULL DEFAULT (datetime('now')),
      battery     INTEGER,
      wifi_rssi   INTEGER,
      rtk_sat     INTEGER,
      loc_quality INTEGER,
      cpu_temp    INTEGER
    );
    CREATE INDEX IF NOT EXISTS signal_history_sn_ts ON signal_history(sn, ts);

    -- Map calibratie: handmatige offset/rotatie/schaal per maaier
    CREATE TABLE IF NOT EXISTS map_calibration (
      mower_sn    TEXT    NOT NULL PRIMARY KEY,
      offset_lat  REAL    NOT NULL DEFAULT 0,
      offset_lng  REAL    NOT NULL DEFAULT 0,
      rotation    REAL    NOT NULL DEFAULT 0,
      scale       REAL    NOT NULL DEFAULT 1,
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Apparaat instellingen: persistent cache voor set_para_info
    -- (maaier reageert niet op get_para_info, dus we bewaren de laatst gezette waarden)
    CREATE TABLE IF NOT EXISTS device_settings (
      sn          TEXT    NOT NULL,
      key         TEXT    NOT NULL,
      value       TEXT    NOT NULL,
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (sn, key)
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
  // charger_lat/lng = door gebruiker op kaart geplaatste positie (visueel)
  // gps_charger_lat/lng = ruwe GPS positie van maaier op laadstation (meetwaarde)
  // Verschil = satellietbeeld offset → automatische polygon kalibratie
  for (const col of ['charger_lat REAL', 'charger_lng REAL', 'gps_charger_lat REAL', 'gps_charger_lng REAL']) {
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

  // IP-adres van apparaten opslaan voor SSH upload (migratie)
  try { db.exec(`ALTER TABLE device_registry ADD COLUMN ip_address TEXT`); }
  catch { /* kolom bestaat al */ }

  // Handmatig geconfigureerd maaier IP voor SSH upload (migratie)
  try { db.exec(`ALTER TABLE equipment ADD COLUMN mower_ip TEXT`); }
  catch { /* kolom bestaat al */ }

  // Feature: alternerende maairichting per schema
  for (const col of ['alternate_direction INTEGER DEFAULT 0', 'alternate_step INTEGER DEFAULT 90']) {
    try { db.exec(`ALTER TABLE dashboard_schedules ADD COLUMN ${col}`); }
    catch { /* kolom bestaat al */ }
  }

  // Feature: rand-offset (polygon inset/outset)
  try { db.exec(`ALTER TABLE dashboard_schedules ADD COLUMN edge_offset REAL DEFAULT 0`); }
  catch { /* kolom bestaat al */ }

  // Feature: weergebaseerd pauzeren
  for (const col of [
    'rain_pause INTEGER DEFAULT 0',
    'rain_threshold_mm REAL DEFAULT 0.5',
    'rain_threshold_probability INTEGER DEFAULT 50',
    'rain_check_hours INTEGER DEFAULT 2',
    'last_triggered_at TEXT',
  ]) {
    try { db.exec(`ALTER TABLE dashboard_schedules ADD COLUMN ${col}`); }
    catch { /* kolom bestaat al */ }
  }

  // Feature: actieve regenpauze sessies (rain monitor → go_to_charge → herstart na regen)
  db.exec(`
    CREATE TABLE IF NOT EXISTS rain_sessions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT    NOT NULL UNIQUE,
      schedule_id     TEXT    NOT NULL,
      mower_sn        TEXT    NOT NULL,
      state           TEXT    NOT NULL DEFAULT 'paused',  -- paused | resuming | completed | cancelled
      -- Opgeslagen maaiparameters voor herstart
      map_id          TEXT,
      map_name        TEXT,
      cutting_height  INTEGER,
      path_direction  INTEGER,
      work_mode       INTEGER DEFAULT 0,
      task_mode       INTEGER DEFAULT 0,
      edge_offset     REAL    DEFAULT 0,
      -- Weer thresholds (kopie van schedule, zodat wijzigingen aan schedule geen lopende sessie beïnvloeden)
      rain_threshold_mm           REAL DEFAULT 0.5,
      rain_threshold_probability  INTEGER DEFAULT 50,
      rain_check_hours            INTEGER DEFAULT 2,
      -- Timestamps
      paused_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      resumed_at      TEXT,
      completed_at    TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS rain_sessions_state ON rain_sessions(state);
    CREATE INDEX IF NOT EXISTS rain_sessions_mower ON rain_sessions(mower_sn, state);
  `);

  // Feature: virtual walls (no-go zones) per maaier
  db.exec(`
    CREATE TABLE IF NOT EXISTS virtual_walls (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      wall_id     TEXT    NOT NULL UNIQUE,
      mower_sn    TEXT    NOT NULL,
      wall_name   TEXT,
      lat1        REAL    NOT NULL,
      lng1        REAL    NOT NULL,
      lat2        REAL    NOT NULL,
      lng2        REAL    NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS virtual_walls_sn ON virtual_walls(mower_sn);
  `);

  // ── Migratie: map_area van GPS {lat,lng} naar lokaal {x,y} meters ──
  // Detectie: als het eerste punt in map_area een 'lat' veld heeft, is het GPS formaat.
  // Na migratie bevat map_area [{x,y}] lokale meters (charger = 0,0).
  {
    const sampleRow = db.prepare(
      "SELECT map_area FROM maps WHERE map_area IS NOT NULL AND map_area != '[]' LIMIT 1"
    ).get() as { map_area: string } | undefined;

    if (sampleRow) {
      try {
        const sample = JSON.parse(sampleRow.map_area);
        if (Array.isArray(sample) && sample.length > 0 && 'lat' in sample[0]) {
          console.log('[DB] Migrating map_area from GPS to local coordinates...');

          // Inline conversie (vermijdt circulaire import met mapConverter.ts)
          const METERS_PER_DEG = 111320;
          function gps2local(p: { lat: number; lng: number }, o: { lat: number; lng: number }) {
            const cosLat = Math.cos(o.lat * Math.PI / 180);
            return {
              x: Math.round(((p.lng - o.lng) * cosLat * METERS_PER_DEG) * 100) / 100,
              y: Math.round(((p.lat - o.lat) * METERS_PER_DEG) * 100) / 100,
            };
          }

          const allMaps = db.prepare(
            'SELECT map_id, mower_sn, map_area FROM maps WHERE map_area IS NOT NULL'
          ).all() as Array<{ map_id: string; mower_sn: string; map_area: string }>;

          // Verzamel charger GPS per mower_sn
          const chargerCache = new Map<string, { lat: number; lng: number } | null>();
          function getCharger(mowerSn: string) {
            if (chargerCache.has(mowerSn)) return chargerCache.get(mowerSn)!;
            const cal = db.prepare('SELECT charger_lat, charger_lng FROM map_calibration WHERE mower_sn = ?')
              .get(mowerSn) as { charger_lat: number | null; charger_lng: number | null } | undefined;
            const result = cal?.charger_lat && cal?.charger_lng
              ? { lat: cal.charger_lat, lng: cal.charger_lng } : null;
            chargerCache.set(mowerSn, result);
            return result;
          }

          let migrated = 0;
          for (const row of allMaps) {
            try {
              const gpsPoints = JSON.parse(row.map_area);
              if (!Array.isArray(gpsPoints) || gpsPoints.length === 0 || !('lat' in gpsPoints[0])) continue;

              const origin = getCharger(row.mower_sn) ?? gpsPoints[0]; // fallback: eerste punt
              const localPoints = gpsPoints.map((p: { lat: number; lng: number }) => gps2local(p, origin));
              const bounds = {
                minX: Math.min(...localPoints.map((p: { x: number }) => p.x)),
                maxX: Math.max(...localPoints.map((p: { x: number }) => p.x)),
                minY: Math.min(...localPoints.map((p: { y: number }) => p.y)),
                maxY: Math.max(...localPoints.map((p: { y: number }) => p.y)),
              };

              db.prepare('UPDATE maps SET map_area = ?, map_max_min = ? WHERE map_id = ?')
                .run(JSON.stringify(localPoints), JSON.stringify(bounds), row.map_id);
              migrated++;
            } catch { /* skip ongeldig record */ }
          }

          console.log(`[DB] Migrated ${migrated}/${allMaps.length} map(s) to local coordinates`);
        }
      } catch { /* skip als parse mislukt */ }
    }
  }

  // ── Import factory device data from cloud scan (one-time, idempotent) ──────
  importFactoryDevices();

  // User roles
  try { db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`); }
  catch { /* kolom bestaat al */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN dashboard_access INTEGER NOT NULL DEFAULT 0`); }
  catch { /* kolom bestaat al */ }

  // Auto-promote user to admin if ADMIN_EMAIL env var matches
  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail) {
    const result = db.prepare('UPDATE users SET is_admin = 1 WHERE email = ? AND is_admin = 0').run(adminEmail);
    if (result.changes > 0) {
      console.log(`[DB] Promoted ${adminEmail} to admin`);
    }
  }

  // First user is always admin (if no admins exist yet)
  const hasAdmin = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_admin = 1').get() as { c: number };
  if (hasAdmin.c === 0) {
    const firstUser = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as { id: number } | undefined;
    if (firstUser) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(firstUser.id);
      console.log('[DB] First user promoted to admin (no admins existed)');
    }
  }

  console.log('[DB] Database initialised');
}

/**
 * Import anonymized cloud device data into device_factory table.
 * Looks for cloud_devices_anonymous.json in multiple locations.
 * Idempotent: uses INSERT OR IGNORE so existing entries are preserved.
 */
function importFactoryDevices(): void {
  // fs and path imported at top of file via static imports

  const candidates = [
    path.resolve(__dirname, '../../../research/cloud_devices_anonymous.json'),   // dev
    path.resolve(__dirname, '../../cloud_devices_anonymous.json'),               // Docker
    '/data/cloud_devices_anonymous.json',                                           // Docker volume
  ];

  let data: Array<Record<string, unknown>> | null = null;
  let loadedFrom = '';
  for (const p of candidates) {
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      loadedFrom = p;
      break;
    } catch { /* file not found, try next */ }
  }

  if (!data || data.length === 0) return;

  const existing = (db.prepare('SELECT COUNT(*) as count FROM device_factory').get() as { count: number }).count;
  if (existing >= data.length) return;  // Already imported

  const insert = db.prepare(`
    INSERT OR IGNORE INTO device_factory
      (sn, device_type, mac_address, equipment_type, sys_version,
       charger_address, charger_channel, mqtt_account, mqtt_password, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    let imported = 0;
    for (const d of data!) {
      const sn = (d.sn ?? d._queriedSn) as string;
      if (!sn) continue;
      insert.run(
        sn,
        (d.deviceType ?? d._queriedType ?? null) as string | null,
        (d.macAddress ?? null) as string | null,
        (d.equipmentType ?? null) as string | null,
        (d.sysVersion ?? null) as string | null,
        (d.chargerAddress ?? null) as number | null,
        (d.chargerChannel ?? null) as number | null,
        (d.account ?? null) as string | null,
        (d.password ?? null) as string | null,
        (d.model ?? null) as string | null,
      );
      imported++;
    }
    return imported;
  });

  const count = tx();
  console.log(`[DB] Factory devices: ${count} imported from ${loadedFrom} (${existing} already in DB)`);
}

// Direct aanroepen bij module-load — andere modules (sensorData, broker, etc.) doen
// db.prepare() op module-level en verwachten dat de tabellen al bestaan.
initDb();
