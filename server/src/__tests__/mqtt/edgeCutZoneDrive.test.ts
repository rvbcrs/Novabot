/**
 * #147 after #148: while mow_zone_drive drives to a zone (nav2, outside
 * robot_decision) a stop from the app only reached the parked firmware task.
 * Every ending command must also kill that drive (stop_mow_zone).
 */
import { describe, it, expect } from 'vitest';
import { endsZoneDrive } from '../../services/edgeCutGuard.js';

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
