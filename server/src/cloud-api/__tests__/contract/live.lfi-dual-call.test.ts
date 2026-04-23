/**
 * Live dual-call regression tests against the real LFI cloud.
 *
 * Skipped unless RUN_LIVE_LFI=1 AND LFI_EMAIL/LFI_PASSWORD are set. These
 * tests hit the real LFI backend directly (47.253.145.99 with SNI
 * app.lfibot.com) so the LFI account has to exist and the network has to
 * be reachable. Don't run them in CI by default — only locally when you
 * want a sanity check that our server still mirrors what LFI returns.
 *
 * Usage:
 *   RUN_LIVE_LFI=1 \
 *     LFI_EMAIL=you@example.com LFI_PASSWORD=secret \
 *     npx vitest run src/cloud-api/__tests__/contract/live.lfi-dual-call.test.ts
 *
 * Optional overrides:
 *   FIXTURE_MOWER_SN, FIXTURE_CHARGER_SN
 */
import { describe, it, expect } from 'vitest';
import {
  callLfiCloud,
  encryptCloudPassword,
} from '../../../services/lfiCloud.js';
import {
  userEquipmentListResponseSchema,
  getEquipmentBySnResponseSchema,
} from '../../serializers/equipmentDto.js';
import { queryEquipmentMapResponseSchema } from '../../serializers/mapDto.js';
import { checkOtaNewVersionResponseSchema } from '../../serializers/otaDto.js';
import { loginResponseSchema } from '../../serializers/appUserDto.js';

const ENABLED =
  process.env.RUN_LIVE_LFI === '1' &&
  !!process.env.LFI_EMAIL &&
  !!process.env.LFI_PASSWORD;

const d = ENABLED ? describe : describe.skip;

d('cloud-api live dual-call vs LFI', () => {
  let token = '';
  let appUserId: unknown = null;
  let mowerSn = process.env.FIXTURE_MOWER_SN ?? '';
  let chargerSn = process.env.FIXTURE_CHARGER_SN ?? '';

  it('login succeeds against real LFI cloud', async () => {
    const resp = await callLfiCloud('POST', '/api/nova-user/user/login', {
      email: process.env.LFI_EMAIL,
      password: encryptCloudPassword(process.env.LFI_PASSWORD!),
    });
    expect(() => loginResponseSchema.parse(resp)).not.toThrow();
    token = (resp as any).value.accessToken;
    appUserId = (resp as any).value.appUserId;
    expect(token.length).toBeGreaterThan(20);
  });

  it('userEquipmentList matches our schema', async () => {
    expect(token).not.toBe('');
    const resp = await callLfiCloud(
      'POST', '/api/nova-user/equipment/userEquipmentList',
      { appUserId, pageSize: 10, pageNo: 1 }, token,
    );
    expect(() => userEquipmentListResponseSchema.parse(resp)).not.toThrow();

    const list = (resp as any).value?.pageList ?? [];
    if (!mowerSn) {
      mowerSn = list.find((d: any) => String(d.sn ?? '').startsWith('LFIN'))?.sn ?? '';
    }
    if (!chargerSn) {
      chargerSn = list.find((d: any) => String(d.sn ?? '').startsWith('LFIC'))?.sn ?? '';
    }
  });

  it('getEquipmentBySN (mower) matches schema', async () => {
    if (!mowerSn) return;
    const resp = await callLfiCloud(
      'POST', '/api/nova-user/equipment/getEquipmentBySN',
      { sn: mowerSn }, token,
    );
    expect(() => getEquipmentBySnResponseSchema.parse(resp)).not.toThrow();
  });

  it('getEquipmentBySN (charger) matches schema', async () => {
    if (!chargerSn) return;
    const resp = await callLfiCloud(
      'POST', '/api/nova-user/equipment/getEquipmentBySN',
      { sn: chargerSn }, token,
    );
    expect(() => getEquipmentBySnResponseSchema.parse(resp)).not.toThrow();
  });

  it('queryEquipmentMap matches schema', async () => {
    if (!mowerSn) return;
    const resp = await callLfiCloud(
      'GET',
      `/api/nova-file-server/map/queryEquipmentMap?sn=${encodeURIComponent(mowerSn)}`,
      null, token,
    );
    expect(() => queryEquipmentMapResponseSchema.parse(resp)).not.toThrow();
  });

  it('checkOtaNewVersion matches schema', async () => {
    if (!mowerSn) return;
    const resp = await callLfiCloud(
      'GET',
      `/api/nova-user/otaUpgrade/checkOtaNewVersion?sn=${encodeURIComponent(mowerSn)}&version=v6.0.2&equipmentType=mower`,
      null, token,
    );
    expect(() => checkOtaNewVersionResponseSchema.parse(resp)).not.toThrow();
  });
});
