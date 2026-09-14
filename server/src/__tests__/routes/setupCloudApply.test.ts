import { beforeEach, describe, expect, it, vi, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../services/lfiCloud.js', () => ({
  callLfiCloud: vi.fn(),
  encryptCloudPassword: vi.fn(() => 'encrypted-password'),
  makeLfiHeaders: vi.fn(() => ({})),
  LFI_CLOUD_HOST: 'app.lfibot.com',
  LFI_CLOUD_SERVERNAME: 'app.lfibot.com',
}));

vi.mock('../../services/cloudWorkRecordsImport.js', () => ({
  importCloudWorkRecords: vi.fn().mockResolvedValue({ inserted: 0, skipped: 0 }),
}));

vi.mock('../../services/portableBackup.js', () => ({
  createBundleFromDb: vi.fn().mockResolvedValue(null),
}));

import { setupRouter } from '../../routes/setup.js';
import { mapRepo } from '../../db/repositories/index.js';
import { callLfiCloud } from '../../services/lfiCloud.js';
import { isFrameUnvalidated } from '../../services/frameValidation.js';

const app = express();
app.use(express.json());
app.use('/api/setup', setupRouter);

// Eén luisteraar voor dit hele bestand. `request(server)` laat supertest per
// verzoek een NIEUWE efemere poort openen, en dat botst onder belasting met een
// andere luisteraar: het antwoord komt dan ergens anders vandaan. Bewezen op
// 2026-09-14, een 403 op /reanchor zonder x-powered-by en zonder serverkant-
// regel in de trace, wat drie beta-builds heeft gekost.
const server = app.listen(0);
afterAll(() => new Promise<void>(r => { server.close(() => r()); }));

describe('POST /cloud-apply map import', () => {
  beforeEach(() => {
    vi.mocked(callLfiCloud).mockImplementation(async (_method: string, route: string) => {
      if (route.includes('/api/nova-user/appUser/login')) {
        return {
          success: true,
          value: { accessToken: 'cloud-token', appUserId: 123 },
        };
      }
      if (route.includes('/api/nova-file-server/map/queryEquipmentMap')) {
        return {
          success: true,
          value: {
            data: {
              work: [],
              unicom: [{
                fileName: 'map0tomap1_0_unicom.csv',
                alias: 'map0tomap1_0_unicom',
                type: 'unicom',
              }],
            },
            md5: '0123456789ABCDEF0123456789ABCDEF',
            machineExtendedField: null,
          },
        };
      }
      return { success: true, value: {} };
    });
  });

  it('preserves no-URL inter-map unicom rows from the LFI cloud response', async () => {
    const res = await request(server)
      .post('/api/setup/cloud-apply')
      .send({
        email: 'setup@example.com',
        password: 'secret',
        deviceName: 'Test mower',
        mower: { sn: 'LFIN_SETUP_UNICOM', version: '5.7.1' },
        charger: { sn: 'LFIC_SETUP_UNICOM', address: 718, channel: 16 },
      });

    expect(res.status).toBe(200);
    expect(res.body.mapsImported).toBe(1);
    const rows = mapRepo.findAllByMowerSnAndType('LFIN_SETUP_UNICOM', 'unicom');
    expect(rows).toHaveLength(1);
    expect(rows[0].file_name).toBe('map0tomap1_0_unicom.csv');
    expect(rows[0].canonical_name).toBe('map0tomap1_0_unicom');
    expect(rows[0].map_area).toBeNull();
  });

  // After a factory reset the recovery flow is a (non-merge) cloud re-import:
  // it lands the cloud's polygons in their old frame, so the frame must be
  // flagged unvalidated to drive the app's re-anchor wizard. Without this the
  // mower won't move and gives no re-anchor prompt (the bug David hit).
  it('sets frame_unvalidated after a non-merge cloud re-import', async () => {
    const res = await request(server)
      .post('/api/setup/cloud-apply')
      .send({
        email: 'setup@example.com',
        password: 'secret',
        deviceName: 'Test mower',
        mower: { sn: 'LFIN_FU_NONMERGE', version: '5.7.1' },
        charger: { sn: 'LFIC_FU_NONMERGE', address: 718, channel: 16 },
      });

    expect(res.status).toBe(200);
    expect(res.body.mapsImported).toBeGreaterThan(0);
    expect(isFrameUnvalidated('LFIN_FU_NONMERGE')).toBe(true);
  });

  // A merge re-import (settings sync on an already-anchored, working device)
  // must NOT force a re-anchor.
  it('does NOT set frame_unvalidated in merge mode', async () => {
    const res = await request(server)
      .post('/api/setup/cloud-apply')
      .send({
        email: 'setup@example.com',
        password: 'secret',
        deviceName: 'Test mower',
        merge: true,
        mower: { sn: 'LFIN_FU_MERGE', version: '5.7.1' },
        charger: { sn: 'LFIC_FU_MERGE', address: 718, channel: 16 },
      });

    expect(res.status).toBe(200);
    expect(res.body.mapsImported).toBeGreaterThan(0);
    expect(isFrameUnvalidated('LFIN_FU_MERGE')).toBe(false);
  });
});
