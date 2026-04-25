/**
 * LoRa auto-sync — periodically polls online devices for their actual
 * addr/channel and lets the broker.ts autosync handler update the DB.
 *
 * Motivation (2026-04-21): chargers can drift to another channel after
 * a LoRa scan (lc→hc range) without notifying us, leaving the DB stale.
 * Dashboard then shows e.g. ch20 while device actually runs ch19.
 *
 * Flow:
 *   1. Every POLL_INTERVAL_MS tick, list all online LFI* devices
 *   2. For each: publish get_lora_info on the appropriate topic
 *        - LFIC (charger) → Dart/Send_mqtt/<SN>  { get_lora_info: null }
 *        - LFIN (mower)   → novabot/extended/<SN>  { get_lora_info: {} }
 *   3. Response handling lives in broker.ts — it parses the respond
 *      and writes actual addr/channel to equipment_lora_cache via
 *      equipmentRepo.setLoraCache().
 *
 * We don't need to wait for responses here; broker.ts is the sink.
 * Rate-limit: 1 poll per device per interval, staggered 500ms apart
 * so we don't swamp MQTT at the top of every interval.
 */

import { isDeviceOnline } from '../mqtt/broker.js';
import { deviceRepo, equipmentRepo } from '../db/repositories/index.js';
import { publishToDevice, publishToExtended } from '../mqtt/mapSync.js';

const POLL_INTERVAL_MS = 60_000; // 1 min
const STAGGER_MS = 500;

let started = false;

export function startLoraAutoSync(): void {
  if (started) return;
  started = true;

  console.log('[LoRa-AutoSync] Starting — 60s poll interval');

  setInterval(() => {
    try {
      const registry = deviceRepo.listLatestBySn();
      const online = registry.filter(r => r.sn && isDeviceOnline(r.sn));

      online.forEach((row, idx) => {
        const sn = row.sn!;
        setTimeout(() => {
          try {
            if (sn.startsWith('LFIC')) {
              publishToDevice(sn, { get_lora_info: null });
            } else if (sn.startsWith('LFIN')) {
              publishToExtended(sn, { get_lora_info: {} });
            }
          } catch (e) {
            console.log(`[LoRa-AutoSync] publish failed for ${sn}: ${e}`);
          }

          // Firmware version fetch als nog niet bekend in DB.
          // ota_version_info werkt op het standaard MQTT topic voor zowel
          // mower als charger. Broker ota_version_info_respond handler
          // schrijft `mower_version` / `charger_version` in equipment.
          try {
            const eq = equipmentRepo.findBySn(sn);
            const isCharger = sn.startsWith('LFIC');
            const currentVersion = isCharger ? eq?.charger_version : eq?.mower_version;
            if (!currentVersion) {
              publishToDevice(sn, { ota_version_info: null });
            }
          } catch (e) {
            console.log(`[LoRa-AutoSync] version check failed for ${sn}: ${e}`);
          }
        }, idx * STAGGER_MS);
      });
    } catch (e) {
      console.log(`[LoRa-AutoSync] tick error: ${e}`);
    }
  }, POLL_INTERVAL_MS);
}
