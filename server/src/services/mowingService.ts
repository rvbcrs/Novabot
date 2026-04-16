/**
 * Mowing Service — centrale module voor het starten/stoppen van maaisessies.
 *
 * Gebruikt EXACT dezelfde code path als de dashboard command handler
 * (encrypt + publishRawToDevice) — bewezen werkend vanuit het HomeScreen.
 *
 * Gebruikt door:
 * - Schedule runner (automatisch op schema)
 * - Dashboard API (handmatige start via browser)
 * - App API (start via OpenNova/Novabot app)
 */

import crypto from 'crypto';
import { publishRawToDevice } from '../mqtt/mapSync.js';
import { isDeviceOnline } from '../mqtt/broker.js';

export interface MowingParams {
  sn: string;
  cuttingHeight?: number;   // cm (2-9), default 5
  pathDirection?: number;   // degrees (0-359), default 120
  area?: number;            // 1=map0, 10=map1, 200=map2
}

export interface MowingResult {
  ok: boolean;
  error?: string;
}

/** Encrypt and publish a command — same as dashboard command handler */
function sendEncryptedCommand(sn: string, command: Record<string, unknown>): void {
  const KEY_PREFIX = 'abcdabcd1234';
  const IV = Buffer.from('abcd1234abcd1234', 'utf8');
  const key = Buffer.from(KEY_PREFIX + sn.slice(-4), 'utf8');
  const json = JSON.stringify(command);
  const plaintext = Buffer.from(json, 'utf8');
  const padded = Buffer.alloc(Math.ceil(plaintext.length / 16) * 16, 0);
  plaintext.copy(padded);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  publishRawToDevice(sn, encrypted);
  console.log(`[MowingService] Sent ${Object.keys(command)[0]} to ${sn} (${encrypted.length}B encrypted)`);
}

/**
 * Start een maaisessie op de maaier.
 * Stuurt start_navigation, exact als de Novabot app en het HomeScreen.
 */
export function startMowing(params: MowingParams): MowingResult {
  const { sn, cuttingHeight = 5, pathDirection = 120, area = 1 } = params;

  if (!sn) return { ok: false, error: 'sn required' };
  if (!isDeviceOnline(sn)) return { ok: false, error: 'mower offline' };

  const cmdNum = Date.now() % 100000;

  // Exact same payload as HomeScreen StartMowSheet
  sendEncryptedCommand(sn, {
    start_navigation: {
      mapName: 'test',
      cutterhigh: cuttingHeight,
      area,
      cmd_num: cmdNum,
    },
  });

  console.log(`[MowingService] Started: sn=${sn} height=${cuttingHeight}cm dir=${pathDirection}° area=${area}`);
  return { ok: true };
}

/**
 * Stop een actieve maaisessie.
 */
export function stopMowing(sn: string): MowingResult {
  if (!sn) return { ok: false, error: 'sn required' };

  const cmdNum = Date.now() % 100000;
  sendEncryptedCommand(sn, {
    stop_navigation: { cmd_num: cmdNum },
  });

  console.log(`[MowingService] Stopped: sn=${sn}`);
  return { ok: true };
}

/**
 * Stuur de maaier naar het laadstation.
 */
export function goHome(sn: string): MowingResult {
  if (!sn) return { ok: false, error: 'sn required' };

  const cmdNum = Date.now() % 100000;
  sendEncryptedCommand(sn, { go_pile: {} });
  setTimeout(() => {
    sendEncryptedCommand(sn, {
      go_to_charge: {
        cmd_num: cmdNum,
        chargerpile: { latitude: 200, longitude: 200 },
      },
    });
  }, 500);

  console.log(`[MowingService] Go home: sn=${sn}`);
  return { ok: true };
}
