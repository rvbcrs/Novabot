/**
 * Unit tests — ensureInitialBackup (first-time auto snapshot)
 *
 * Verifies the idempotency guarantee: a snapshot is attempted only when no
 * backup exists yet, and skipped entirely (createBackup never reached) once any
 * backup is present. Distinguishes the two branches via createBackup's own
 * "skip — no charger anchor" warn (the in-memory test DB has no anchor, so
 * reaching createBackup is observable without DB fixtures).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Avoid pulling the broker → socketHandler chain into the test runtime.
// portableBackup only needs these three symbols from mapSync; mocking the
// module breaks the circular broker import. createBackup returns null at the
// anchor check (before any MQTT call) for the empty in-memory test DB, so the
// stubs are never actually invoked.
vi.mock('../../mqtt/mapSync.js', () => ({
  readLatestZipChargingPose: () => null,
  publishToExtended: vi.fn(),
  onExtendedResponse: vi.fn(),
  offExtendedResponse: vi.fn(),
}));
vi.mock('../../mqtt/sensorData.js', () => ({
  deviceCache: new Map<string, Map<string, string>>(),
}));

import { ensureInitialBackup, listBackups } from '../../services/portableBackup.js';

const SN = 'LFIN9999000001';
const BACKUP_ROOT = path.join(process.env.STORAGE_PATH ?? './storage', 'portable_backups');
const snDir = path.join(BACKUP_ROOT, SN);

beforeEach(() => { fs.rmSync(snDir, { recursive: true, force: true }); });
afterEach(() => { fs.rmSync(snDir, { recursive: true, force: true }); });

describe('ensureInitialBackup', () => {
  it('reaches createBackup when no backup exists yet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await ensureInitialBackup(SN);
    // No anchor/work polygon in the in-memory test DB → createBackup no-ops
    // (returns null) — but it WAS reached, proving we did not skip.
    expect(result).toBeNull();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/no charger anchor|no work polygon/i);
    warn.mockRestore();
  });

  it('skips entirely (never reaches createBackup) when a backup already exists', async () => {
    fs.mkdirSync(snDir, { recursive: true });
    fs.writeFileSync(path.join(snDir, '2026-06-10T00-00-00_manual.novabotmap'), 'stub');
    expect(listBackups(SN)).toHaveLength(1);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await ensureInitialBackup(SN);
    expect(result).toBeNull();
    // createBackup must NOT have run → no anchor/polygon warn emitted.
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/no charger anchor|no work polygon/i);
    warn.mockRestore();
  });
});
