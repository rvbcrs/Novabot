#!/usr/bin/env node
/**
 * read-charger-signal.mjs — Vraag de charger via BLE naar get_signal_info.
 *
 * We willen weten of de charger's UM980 zelf een RTK/GPS fix heeft. Zonder
 * base-station fix heeft de charger geen RTCM data om uit te zenden over
 * LoRa — dat verklaart error_status:132 op de maaier ("Data transmission
 * loss") ondanks een schijnbaar correcte LoRa config aan beide kanten.
 *
 * get_signal_info geeft doorgaans: { wifi_rssi, rtk (bool/int), rtk_sat }
 *
 * Gebruik:
 *   cd tools/ble-diagnostic
 *   node scripts/read-charger-signal.mjs
 */

import {
  scanDevices,
  connectDevice,
  disconnectDevice,
  sendDiagnosticCommand,
} from '../dist/ble.js';

const SCAN_DURATION_MS = 12000;

async function main() {
  console.log(`[1/3] Scanning ${SCAN_DURATION_MS / 1000}s for CHARGER_PILE...`);

  const found = await new Promise((resolve) => {
    const collected = [];
    scanDevices(
      (dev) => { if (dev.type === 'charger') collected.push(dev); },
      () => resolve(collected),
      SCAN_DURATION_MS,
    );
  });

  if (found.length === 0) {
    console.error('\nERROR: geen charger gevonden. BT aan? In range?');
    process.exit(1);
  }

  const charger = found[0];
  console.log(`  found: ${charger.name} (${charger.mac})`);

  console.log(`\n[2/3] Connecting...`);
  await connectDevice(charger.mac);
  console.log('  ✓ connected');

  const queries = [
    ['get_signal_info', null],
    ['get_rtk_info', null],
    ['get_dev_info', null],
    ['get_lora_info', null],
  ];

  console.log(`\n[3/3] Query charger state:`);
  for (const [cmd, payload] of queries) {
    console.log(`\n  → ${cmd}:`);
    try {
      const r = await sendDiagnosticCommand(charger.mac, cmd, payload, 8000);
      console.log(`    response: ${JSON.stringify(r)}`);
    } catch (err) {
      console.log(`    ERROR: ${err.message}`);
    }
  }

  try { await disconnectDevice(charger.mac); } catch { /* ignore */ }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
