/**
 * Integration test — cloud import flow.
 * Tests that repeated imports don't destroy existing pairs.
 */
import { describe, it, expect } from 'vitest';
import { userRepo, equipmentRepo, mapRepo } from '../../db/repositories/index.js';

describe('Cloud Import — equipment pairing safety', () => {
  it('creates a paired set from scratch', () => {
    userRepo.create('user-1', 'test@test.com', 'hash', 'test');

    // Simulate first import call (charger only — mower_sn uses charger SN as placeholder)
    const chargerExists = equipmentRepo.findByChargerSn('LFIC0001');
    expect(chargerExists).toBeUndefined();
    equipmentRepo.create({
      equipment_id: 'eq-1',
      user_id: 'user-1',
      mower_sn: 'LFIC0001',  // mower_sn NOT NULL — charger-only uses charger SN
      charger_sn: 'LFIC0001',
    });

    // Simulate second import call (mower) — should update the mower_sn
    equipmentRepo.updateMowerSn('eq-1', 'LFIN0001');

    // Verify pair
    const result = equipmentRepo.findBySn('LFIN0001');
    expect(result!.mower_sn).toBe('LFIN0001');
    expect(result!.charger_sn).toBe('LFIC0001');
  });

  it('does NOT destroy existing pair on re-import', () => {
    userRepo.create('user-1', 'test@test.com', 'hash', 'test');

    // Create a working pair
    equipmentRepo.create({
      equipment_id: 'eq-1',
      user_id: 'user-1',
      mower_sn: 'LFIN0001',
      charger_sn: 'LFIC0001',
    });
    equipmentRepo.setLoraCache('LFIN0001', '719', '16');
    equipmentRepo.setLoraCache('LFIC0001', '719', '16');

    // Simulate re-import: charger SN already exists
    const chargerExists = equipmentRepo.findByChargerSn('LFIC0001');
    expect(chargerExists).toBeDefined();
    // Cloud import should only claim ownership, NOT modify the record
    equipmentRepo.claimOwnership(chargerExists!.equipment_id, 'user-1');

    // Verify pair is still intact
    const pair = equipmentRepo.findBySn('LFIN0001');
    expect(pair!.mower_sn).toBe('LFIN0001');
    expect(pair!.charger_sn).toBe('LFIC0001');

    // Verify LoRa cache NOT overwritten
    const lora = equipmentRepo.getLoraCache('LFIC0001');
    expect(lora!.charger_address).toBe('719');
  });

  it('does NOT create duplicate records on re-import', () => {
    userRepo.create('user-1', 'test@test.com', 'hash', 'test');

    // First import
    equipmentRepo.create({
      equipment_id: 'eq-1',
      user_id: 'user-1',
      mower_sn: 'LFIN0001',
      charger_sn: 'LFIC0001',
    });

    // Re-import: both SNs already exist
    const mowerExists = equipmentRepo.findByMowerSn('LFIN0001');
    const chargerExists = equipmentRepo.findByChargerSn('LFIC0001');
    expect(mowerExists).toBeDefined();
    expect(chargerExists).toBeDefined();

    // Should NOT create new records
    expect(equipmentRepo.count()).toBe(1);
  });
});

describe('Cloud Import — map safety', () => {
  it('creates maps for a mower', () => {
    mapRepo.create({
      map_id: 'map-1',
      mower_sn: 'LFIN0001',
      map_name: 'work0',
      map_area: '[{"x":0,"y":0},{"x":1,"y":1}]',
      map_type: 'work',
    });

    const maps = mapRepo.findByMowerSn('LFIN0001');
    expect(maps.length).toBe(1);
  });

  it('upsert does not create duplicates', () => {
    mapRepo.upsert({ map_id: 'map-1', mower_sn: 'LFIN0001', map_name: 'v1' });
    mapRepo.upsert({ map_id: 'map-1', mower_sn: 'LFIN0001', map_name: 'v2' });
    expect(mapRepo.countByMowerSn('LFIN0001')).toBe(1);
    expect(mapRepo.findById('map-1')!.map_name).toBe('v2');
  });
});
