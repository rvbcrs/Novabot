import { describe, it, expect, beforeEach, vi } from 'vitest';
import { adviseVersion, customBuildNumber, getManifest, _setFirmwareAdvisoryIo, type Manifest } from '../../services/firmwareAdvisory.js';
import { otaVersionRepo } from '../../db/repositories/otaVersions.js';

const manifest: Manifest = {
  firmwares: [
    { version: 'v6.0.2-custom-45', device_type: 'mower', url: 'https://x/45.deb', description: 'fixes' },
    { version: 'v6.0.2-custom-40', device_type: 'mower', url: 'https://x/40.deb' },
    { version: 'v6.0.2-custom-39', device_type: 'mower', url: 'https://x/39.deb' },
  ],
  withdrawn: {
    'v6.0.2-custom-43': 'watchdog killed mqtt_node',
    'v6.0.2-custom-44': 'watchdog killed mqtt_node',
  },
};

describe('firmware advisory', () => {
  beforeEach(() => _setFirmwareAdvisoryIo({ reset: true }));

  it('reads the custom build number', () => {
    expect(customBuildNumber('v6.0.2-custom-44')).toBe(44);
    expect(customBuildNumber('v5.7.1')).toBeNull();
    expect(customBuildNumber(null)).toBeNull();
  });

  it('a withdrawn build must move to the newest one; stock and current builds are left alone', () => {
    const a = adviseVersion('v6.0.2-custom-44', manifest);
    expect(a.required).toBe(true);
    expect(a.reason).toContain('watchdog');
    expect(a.target?.version).toBe('v6.0.2-custom-45');
    expect(a.target?.downloaded).toBe(false);
    expect(adviseVersion('v6.0.2-custom-40', manifest).required).toBe(false);
    expect(adviseVersion('v6.0.2-custom-45', manifest).required).toBe(false);
    expect(adviseVersion('v5.7.1', manifest).required).toBe(false);
    expect(adviseVersion('v6.0.2', manifest).required).toBe(false);
    expect(adviseVersion(null, manifest).required).toBe(false);
    expect(adviseVersion('v6.0.2-custom-44', null).required).toBe(false);
  });

  // The banner shows what changes before the owner updates: every build after
  // the mower's own up to the offered one, newest first (2026-10-22).
  it('lists the release notes of every build between the mower and the offer', () => {
    const notes: Manifest = { firmwares: [
      { version: 'v6.0.2-custom-50', device_type: 'mower', url: 'u', description: '- Night patrol\n- Headlight 1 while docking\n' },
      { version: 'v6.0.2-custom-49', device_type: 'mower', url: 'u', description: '- An edge cut starts beside the lawn' },
      { version: 'v6.0.2-custom-48', device_type: 'mower', url: 'u' },
      { version: 'v6.0.2-custom-45', device_type: 'mower', url: 'u', description: '- older' },
      { version: 'v0.4.0', device_type: 'charger', url: 'u', description: '- charger' },
    ] };
    expect(adviseVersion('v6.0.2-custom-45', notes).releases).toEqual([
      { version: 'v6.0.2-custom-50', notes: ['Night patrol', 'Headlight 1 while docking'] },
      { version: 'v6.0.2-custom-49', notes: ['An edge cut starts beside the lawn'] },
      { version: 'v6.0.2-custom-48', notes: [] },
    ]);
    expect(adviseVersion('v6.0.2-custom-50', notes).releases).toEqual([]);
    expect(adviseVersion('v6.0.2', notes).releases).toEqual([]);
  });

  it('offers a newer custom build as optional; never to stock, never a downgrade', () => {
    const a = adviseVersion('v6.0.2-custom-40', manifest);
    expect(a).toMatchObject({ required: false, updateAvailable: true, reason: null });
    expect(a.target?.version).toBe('v6.0.2-custom-45');
    expect(adviseVersion('v6.0.2-custom-44', manifest)).toMatchObject({ required: true, updateAvailable: true });
    expect(adviseVersion('v6.0.2-custom-45', manifest).updateAvailable).toBe(false);
    expect(adviseVersion('v6.0.2-custom-46', manifest)).toMatchObject({ updateAvailable: false, target: null });
    expect(adviseVersion('v6.0.2', manifest).updateAvailable).toBe(false);
    expect(adviseVersion('v5.7.1', manifest).updateAvailable).toBe(false);
  });

  it('knows when the target is already on this server', () => {
    otaVersionRepo.create({ version: 'v6.0.2-custom-45', device_type: 'mower', download_url: 'http://s/45.deb' });
    expect(adviseVersion('v6.0.2-custom-43', manifest).target?.downloaded).toBe(true);
  });

  it('caches the manifest and keeps the last good one when the fetch fails', async () => {
    let calls = 0;
    _setFirmwareAdvisoryIo({ fetchJson: async () => { calls++; return manifest; } });
    expect((await getManifest())?.withdrawn?.['v6.0.2-custom-44']).toBeTruthy();
    await getManifest();
    expect(calls).toBe(1);
    _setFirmwareAdvisoryIo({ fetchJson: async () => { throw new Error('offline'); } });
    expect((await getManifest(true))?.firmwares.length).toBe(3);
  });

  // 2026-10-22: custom-52 was published at 20:30 and a dashboard still offered
  // custom-50, from a manifest kept six hours.
  it('reads a newly published build within half an hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
      _setFirmwareAdvisoryIo({ reset: true, fetchJson: async () => manifest });
      await getManifest();
      const newer = { ...manifest, firmwares: [{ version: 'v6.0.2-custom-52', device_type: 'mower', url: 'https://x/52.deb' }, ...manifest.firmwares] };
      _setFirmwareAdvisoryIo({ fetchJson: async () => newer });
      vi.setSystemTime(new Date('2026-10-22T12:30:01Z'));
      expect((await getManifest())?.firmwares[0].version).toBe('v6.0.2-custom-52');
    } finally {
      vi.useRealTimers();
    }
  });
});
