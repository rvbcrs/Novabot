/**
 * Integration test — factory reset.
 * Tests that factory reset deletes all user data tables.
 * Mirrors the logic from POST /api/admin-status/factory-reset in adminStatus.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../db/database.js';
import { userRepo, equipmentRepo, mapRepo } from '../../db/repositories/index.js';

// Replicate the factory reset logic from adminStatus.ts (without HTTP/auth layer)
function factoryReset(): void {
  db.pragma('foreign_keys = OFF');
  const tables = [
    'users', 'equipment', 'maps', 'map_calibration', 'map_uploads', 'map_overlays',
    'device_settings', 'work_records', 'robot_messages', 'dashboard_schedules',
    'cut_grass_plans', 'email_codes', 'equipment_lora_cache', 'signal_history',
    'virtual_walls', 'rain_sessions', 'pin_unlock_state',
  ];
  for (const table of tables) {
    try { db.exec(`DELETE FROM "${table}"`); } catch { /* table may not exist */ }
  }
  db.pragma('foreign_keys = ON');
}

describe('Factory Reset', () => {
  beforeEach(() => {
    // Seed data across multiple tables
    userRepo.create('user-fr', 'fr@test.com', 'hash', 'factory');
    equipmentRepo.create({
      equipment_id: 'eq-fr',
      user_id: 'user-fr',
      mower_sn: 'LFIN0001',
      charger_sn: 'LFIC0001',
    });
    equipmentRepo.setLoraCache('LFIN0001', '718', '15');
    equipmentRepo.setLoraCache('LFIC0001', '718', '16');
  });

  it('deletes users, equipment, maps, lora cache', () => {
    // Verify data exists before reset
    expect(userRepo.count()).toBe(1);
    expect(equipmentRepo.count()).toBe(1);
    expect(equipmentRepo.getLoraCache('LFIN0001')).toBeDefined();
    expect(equipmentRepo.getLoraCache('LFIC0001')).toBeDefined();

    factoryReset();

    expect(userRepo.count()).toBe(0);
    expect(equipmentRepo.count()).toBe(0);
    expect(equipmentRepo.getLoraCache('LFIN0001')).toBeUndefined();
    expect(equipmentRepo.getLoraCache('LFIC0001')).toBeUndefined();
    expect(mapRepo.count()).toBe(0);
  });

  it('after factory reset, findFirst() returns undefined', () => {
    expect(userRepo.findFirst()).toBeDefined();

    factoryReset();

    expect(userRepo.findFirst()).toBeUndefined();
  });

  it('device_registry is NOT deleted by factory reset (intentional)', () => {
    // device_registry is NOT in the factory reset list — devices are auto-learned
    // from MQTT CONNECT and should persist across resets
    db.exec("INSERT OR IGNORE INTO device_registry (mqtt_client_id, sn) VALUES ('client1', 'LFIN0001')");

    const before = db.prepare('SELECT COUNT(*) as count FROM device_registry').get() as { count: number };
    expect(before.count).toBeGreaterThan(0);

    factoryReset();

    const after = db.prepare('SELECT COUNT(*) as count FROM device_registry').get() as { count: number };
    expect(after.count).toBeGreaterThan(0);
  });
});
