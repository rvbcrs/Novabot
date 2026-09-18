import { describe, it, expect, beforeEach } from 'vitest';
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
});
