/**
 * #147 after #148: while mow_zone_drive drives to a zone (nav2, outside
 * robot_decision) a stop from the app only reached the parked firmware task.
 * Every ending command must also kill that drive (stop_mow_zone).
 */
import { describe, it, expect } from 'vitest';
import { endsZoneDrive, PATROL_DRIVE_PHASES } from '../../services/edgeCutGuard.js';

describe('endsZoneDrive', () => {
  it('kills the drive for a stop, pause, go home or new start while it drives', () => {
    for (const phase of ['starting', 'localizing', 'following_unicom', 'entering_zone']) {
      expect(endsZoneDrive({ stop_navigation: {} }, phase)).toBe(true);
      expect(endsZoneDrive({ go_to_charge: {} }, phase)).toBe(true);
      expect(endsZoneDrive({ pause_navigation: {} }, phase)).toBe(true);
      expect(endsZoneDrive({ start_navigation: {} }, phase)).toBe(true);
    }
  });
  it('leaves the firmware task and finished drives alone', () => {
    for (const phase of ['covering', 'edge_ready', 'done', 'error', 'stopped', '', undefined]) {
      expect(endsZoneDrive({ stop_navigation: {} }, phase)).toBe(false);
    }
    expect(endsZoneDrive({ get_para_info: {} }, 'following_unicom')).toBe(false);
  });
});

// Night patrol: a stop, pause, go home or new start from the stock app or the
// server must kill a running patrol too (stop_mow_zone), but never the server's
// own docking after a patrol that has ended.
describe('endsZoneDrive for a night patrol', () => {
  it('kills the patrol for a stop, pause, go home or new start while it localizes, patrols or returns', () => {
    for (const phase of ['localizing', 'patrolling', 'returning']) {
      expect(endsZoneDrive({ stop_navigation: {} }, undefined, phase)).toBe(true);
      expect(endsZoneDrive({ go_to_charge: {} }, undefined, phase)).toBe(true);
      expect(endsZoneDrive({ pause_navigation: {} }, undefined, phase)).toBe(true);
      expect(endsZoneDrive({ start_navigation: {} }, undefined, phase)).toBe(true);
    }
  });

  it('leaves a patrol that has ended alone, so the docking after it goes through', () => {
    for (const phase of ['done', 'error', 'stopped', '', undefined]) {
      expect(endsZoneDrive({ go_to_charge: {} }, undefined, phase)).toBe(false);
      expect(endsZoneDrive({ stop_navigation: {} }, undefined, phase)).toBe(false);
    }
  });

  it('leaves a command that ends nothing alone while it patrols', () => {
    for (const command of [{ set_para_info: {} }, { mst: {} }, { get_para_info: {} }]) {
      expect(endsZoneDrive(command, undefined, 'patrolling')).toBe(false);
    }
  });

  it('reacts to either drive, and to neither', () => {
    expect(endsZoneDrive({ stop_navigation: {} }, 'following_unicom', 'done')).toBe(true);
    expect(endsZoneDrive({ stop_navigation: {} }, 'done', 'patrolling')).toBe(true);
    expect(endsZoneDrive({ stop_navigation: {} }, 'done', 'done')).toBe(false);
  });

  it('exports exactly the phases in which the patrol holds the wheels', () => {
    expect([...PATROL_DRIVE_PHASES].sort()).toEqual(['localizing', 'patrolling', 'returning']);
  });
});
