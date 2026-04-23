#!/usr/bin/env node
/**
 * set-mower-wifi.mjs — Stuur ALLEEN set_wifi_info via BLE naar de mower.
 *
 * Geen andere provisioning commands (geen set_lora, geen set_mqtt, geen
 * set_cfg_info). Schrijft alleen WiFi credentials naar de mower's NVS
 * zodat hij daarna zelf gaat reconnecten naar het netwerk.
 *
 * Gebruik:
 *   cd tools/ble-diagnostic
 *   nvm use 20
 *   SSID="AB-IOT" PASS="ramonvanbruggen" node scripts/set-mower-wifi.mjs
 *
 * Of interactief (vraagt om input):
 *   node scripts/set-mower-wifi.mjs
 *
 * Payload format (mower, verified via memory/bootstrap):
 *   {"set_wifi_info":{"ap":{"ssid":"<SSID>","passwd":"<PASS>","encrypt":0}}}
 */

import readline from 'readline';
import {
  scanDevices,
  connectDevice,
  disconnectDevice,
  sendDiagnosticCommand,
} from '../dist/ble.js';

const SCAN_DURATION_MS = 12000;

function promptInput(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    if (hidden) {
      // Basic password-mute: replace output writes with '*'
      const orig = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (str) => {
        if (str.startsWith(question)) orig(str);
        else orig('*');
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  let ssid = process.env.SSID;
  let pass = process.env.PASS;

  if (!ssid) ssid = await promptInput('WiFi SSID: ');
  if (!pass) pass = await promptInput('WiFi password: ', { hidden: true });

  if (!ssid || !pass) {
    console.error('ERROR: SSID en password zijn verplicht');
    process.exit(1);
  }

  console.log(`\n→ SSID="${ssid}" (${ssid.length} chars), PASS length=${pass.length}`);

  console.log(`\n[1/3] Scanning ${SCAN_DURATION_MS / 1000}s for NOVABOT mower...`);

  const found = await new Promise((resolve) => {
    const collected = [];
    scanDevices(
      (dev) => { if (dev.type === 'mower') collected.push(dev); },
      () => resolve(collected),
      SCAN_DURATION_MS,
    );
  });

  if (found.length === 0) {
    console.error('\nERROR: geen NOVABOT mower gevonden. BT aan? In range?');
    process.exit(1);
  }

  const mower = found[0];
  console.log(`\n[2/3] Connecting to ${mower.name} (${mower.mac})...`);
  await connectDevice(mower.mac);
  console.log('  ✓ connected');

  console.log(`\n[3/3] Sending set_wifi_info...`);
  const payload = {
    ap: {
      ssid,
      passwd: pass,
      encrypt: 0,
    },
  };
  console.log(`  payload: ${JSON.stringify({ set_wifi_info: payload }).replace(pass, '***')}`);

  // BELANGRIJK: set_wifi_info op mower stuurt meestal GEEN respond terug
  // (of een minimal one) voordat de WiFi stack herstart. Timeout 15s.
  // Mower reboot/reconnect na ~10s naar het netwerk. Geen set_cfg_info
  // nodig — set_wifi_info alleen triggert al de WiFi-reconnect.
  try {
    const result = await sendDiagnosticCommand(mower.mac, 'set_wifi_info', payload, 15000);
    console.log(`  response: ${JSON.stringify(result)}`);
    if (result.ok) {
      console.log('\n✅ set_wifi_info acknowledged. Mower zou binnen 30-60s op WiFi moeten komen.');
    } else {
      console.log('\n⚠ No JSON respond (timeout).');
      console.log('   Dit is normaal voor mower set_wifi_info — firmware herstart WiFi stack');
      console.log('   zonder response te sturen. Check binnen 60s of ping werkt:');
      console.log(`      ping ${mower.name === 'NOVABOT' ? '<mower-ip>' : '<mower-ip>'}`);
      console.log('   Of kijk in router admin voor een nieuw DHCP device.');
    }
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
  }

  try { await disconnectDevice(mower.mac); } catch { /* ignore */ }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
