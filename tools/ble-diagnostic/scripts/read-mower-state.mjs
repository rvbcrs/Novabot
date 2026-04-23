#!/usr/bin/env node
/**
 * read-mower-state.mjs — BLE diagnostic voor Novabot devices.
 *
 * Gebruikt de tool's scanDevices() (nu permissief: filtert op BLE name
 * CHARGER_PILE / NOVABOT OF manufacturer company ID 0x5566) zodat de
 * interne peripheral cache wordt gevuld en connectDevice() direct werkt.
 */

import {
  scanDevices,
  connectDevice,
  disconnectDevice,
  readSignalInfo,
  readLoraInfo,
  readDevInfo,
} from '../dist/ble.js';

const SCAN_DURATION_MS = 12000;

function interpretSignal(raw) {
  const val = raw?.value ?? raw;
  if (!val) return '  (no data)';
  const wifi = val.wifi ?? val.rssi;
  const rtk = val.rtk ?? val.rtk_sat ?? val.sats;
  const lines = [];
  lines.push(`  wifi RSSI: ${wifi ?? '??'}`);
  if (wifi === 0 || wifi === null || wifi === undefined) {
    lines.push(`    → WiFi NIET verbonden — check SSID/password typo of 5GHz-only AP`);
  } else if (Math.abs(wifi) > 85) {
    lines.push(`    → zwak signaal`);
  } else {
    lines.push(`    → WiFi verbinding OK`);
  }
  lines.push(`  RTK sats: ${rtk ?? '??'}`);
  return lines.join('\n');
}

function interpretLora(raw) {
  const val = raw?.value ?? raw;
  if (!val) return '  (no data)';
  return `  addr=${val.addr}, channel=${val.channel}, hc=${val.hc}, lc=${val.lc}`;
}

async function main() {
  console.log(`[1/2] Scanning ${SCAN_DURATION_MS / 1000}s via tool's scanDevices (fills peripheral cache)...`);

  // Wrap in Promise omdat scanDevices() zelf NIET wacht op z'n eigen
  // setTimeout — het keert direct terug na startScanning. We moeten dus
  // expliciet op de onDone callback wachten.
  const found = await new Promise((resolve) => {
    const collected = [];
    scanDevices(
      (dev) => { collected.push(dev); },
      (count) => {
        console.log(`  scan done (${count} total devices)`);
        resolve(collected);
      },
      SCAN_DURATION_MS,
    );
  });

  if (found.length === 0) {
    console.log('\nNO Novabot devices found. BT aan? Mower/charger binnen 10m?');
    process.exit(1);
  }

  console.log(`\n[2/2] Query each device...`);
  for (const dev of found) {
    console.log(`\n========== ${dev.name} (${dev.mac}) type=${dev.type} ==========`);

    try {
      await connectDevice(dev.mac);
      console.log('  ✓ connected');

      console.log('\n  get_signal_info:');
      try {
        const r = await readSignalInfo(dev.mac);
        const msg = r.response?.message ?? r.response ?? r;
        console.log(`  raw: ${JSON.stringify(msg)}`);
        console.log(interpretSignal(msg));
      } catch (e) { console.log(`  ERROR: ${e.message}`); }

      console.log('\n  get_lora_info:');
      try {
        const r = await readLoraInfo(dev.mac);
        const msg = r.response?.message ?? r.response ?? r;
        console.log(`  raw: ${JSON.stringify(msg)}`);
        console.log(interpretLora(msg));
      } catch (e) { console.log(`  ERROR: ${e.message}`); }

      console.log('\n  get_dev_info:');
      try {
        const r = await readDevInfo(dev.mac);
        const msg = r.response?.message ?? r.response ?? r;
        console.log(`  raw: ${JSON.stringify(msg)}`);
      } catch (e) { console.log(`  ERROR: ${e.message}`); }
    } catch (err) {
      console.log(`  CONNECT FAILED: ${err.message}`);
    } finally {
      try { await disconnectDevice(dev.mac); } catch { /* ignore */ }
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
