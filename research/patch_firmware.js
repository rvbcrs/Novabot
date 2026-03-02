#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════
//  Novabot Charger Firmware Patcher
//
//  Patches hardcoded MQTT hostnames/IPs in the ESP32-S3 charger firmware
//  binary and prepares the result for OTA deployment.
//
//  The charger firmware has these hardcoded network strings:
//    1. mqtt-dev.lfibot.com    — factory default MQTT broker (20-byte slot)
//    2. mqtt://47.253.57.111   — hardcoded fallback MQTT URI  (24-byte slot)
//    3. OTA download URL       — Alibaba OSS firmware URL     (92-byte slot)
//
//  Note: mqtt.lfibot.com is NOT in the firmware binary — it's stored
//  in NVS at runtime during BLE provisioning (set_mqtt_info command).
//
//  When the replacement hostname is longer than the available slot,
//  the tool uses string relocation: it writes the new string to unused
//  DROM space and patches all code references to point to the new location.
//
//  Usage:
//    node patch_firmware.js                          # Patch with defaults
//    node patch_firmware.js --analyze                # Analyze only
//    node patch_firmware.js --mqtt-host my.server.nl # Custom hostname
//    node patch_firmware.js --mqtt-host 192.168.1.50 # Use IP (always fits)
//    node patch_firmware.js --fw-version v0.3.6-local # Change firmware version string
//
//  After patching, host the binary on a local HTTP server and send
//  the ota_upgrade_cmd MQTT message shown in the output.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// ─── Defaults ────────────────────────────────────────────────────────
const DEFAULT_MQTT_HOST = 'nova-mqtt.ramonvanbruggen.nl';

// ─── ESP32-S3 Memory Map ────────────────────────────────────────────
const DROM_BASE = 0x3C000000; // Data ROM (flash-mapped .rodata)
const DROM_END  = 0x3E000000;
const IROM_BASE = 0x42000000; // Instruction ROM (flash-mapped .text)
const IROM_END  = 0x44000000;

// ─── Patchable strings ──────────────────────────────────────────────
// Each entry: { id, description, find, makeReplace(host) }
function buildPatches(mqttHost, otaUrl, fwVersion, detectedVersion) {
  const patches = [
    {
      id: 'mqtt_dev_host',
      description: 'Factory default MQTT broker hostname',
      find: 'mqtt-dev.lfibot.com',
      replace: mqttHost,
    },
    {
      id: 'mqtt_fallback_uri',
      description: 'Hardcoded fallback MQTT URI',
      find: 'mqtt://47.253.57.111',
      replace: `mqtt://${mqttHost}`,
    },
  ];

  if (otaUrl) {
    patches.push({
      id: 'ota_download_url',
      description: 'OTA firmware download URL',
      find: 'https://novabot-oss.oss-us-east-1.aliyuncs.com/novabot-file/lfi-charging-station_lora.bin',
      replace: otaUrl,
    });
  }

  if (fwVersion && detectedVersion) {
    patches.push({
      id: 'fw_version',
      description: 'Firmware version string',
      find: detectedVersion,
      replace: fwVersion,
    });
  }

  return patches;
}

// ═══════════════════════════════════════════════════════════════════════
//  Firmware Version Detection
// ═══════════════════════════════════════════════════════════════════════

function detectFirmwareVersion(data, segments) {
  const drom = segments.find(s => s.type === 'DROM');
  if (!drom) return null;

  const versions = [];
  const end = drom.dataStart + drom.size;

  for (let i = drom.dataStart; i < end - 6; i++) {
    // Look for null-terminated strings starting with 'v' + digit
    if (data[i - 1] !== 0 && i !== drom.dataStart) continue; // Must start at string boundary
    if (data[i] !== 0x76 /* 'v' */) continue;
    if (data[i + 1] < 0x30 || data[i + 1] > 0x39) continue; // Next char must be digit

    // Extract null-terminated string
    let strEnd = i;
    while (strEnd < end && data[strEnd] !== 0) strEnd++;
    const str = data.subarray(i, strEnd).toString('utf8');

    // Match vX.Y.Z pattern, skip ESP-IDF versions (contain 'dirty')
    if (/^v\d+\.\d+\.\d+/.test(str) && !str.includes('dirty')) {
      versions.push({
        version: str,
        offset: i,
        length: strEnd - i,
      });
    }
  }

  // First non-ESP-IDF version is the firmware version
  // (v0.0.1 is a sub-version, firmware version has higher minor/patch)
  // Sort: prefer v0.X.Y where X > 0, then by offset
  const fwVersion = versions.find(v => {
    const m = v.version.match(/^v(\d+)\.(\d+)\.(\d+)/);
    return m && (parseInt(m[1]) > 0 || parseInt(m[2]) > 0);
  });

  return fwVersion || versions[0] || null;
}

// ─── Parse command-line arguments ────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    input: null,       // Auto-detect from available files
    output: null,      // Auto-generate from input + version
    mqttHost: DEFAULT_MQTT_HOST,
    otaUrl: null,
    fwVersion: null,   // null = auto (append '-local' to detected version)
    analyzeOnly: false,
    servePort: 8080,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--analyze': opts.analyzeOnly = true; break;
      case '--mqtt-host': opts.mqttHost = args[++i]; break;
      case '--ota-url': opts.otaUrl = args[++i]; break;
      case '--fw-version': opts.fwVersion = args[++i]; break;
      case '--input': opts.input = args[++i]; break;
      case '--output': opts.output = args[++i]; break;
      case '--serve-port': opts.servePort = parseInt(args[++i]); break;
      case '--help':
        console.log(`
Novabot Charger Firmware Patcher

Usage: node patch_firmware.js [options]

Options:
  --analyze              Only analyze, don't patch
  --mqtt-host <host>     MQTT hostname/IP (default: ${DEFAULT_MQTT_HOST})
  --fw-version <ver>     New firmware version string (default: <detected>-local)
  --ota-url <url>        Replacement OTA download URL (optional)
  --input <file>         Input firmware binary (auto-detects available files)
  --output <file>        Output patched binary (auto-generated from version)
  --serve-port <port>    Port for hosting instructions (default: 8080)
  --help                 Show this help

Examples:
  node patch_firmware.js                                    # Auto-detect, default host
  node patch_firmware.js --fw-version v0.4.0-local          # Custom version string
  node patch_firmware.js --mqtt-host 192.168.1.50           # Short IP (fits in-place)
  node patch_firmware.js --input firmware/charger_v0.4.0.bin --fw-version v0.4.0-patched
`);
        process.exit(0);
    }
  }

  // Auto-detect input file if not specified
  if (!opts.input) {
    const candidates = [
      path.join(__dirname, 'charger_ota_v0.3.6_cloud.bin'),
      path.join(__dirname, 'firmware', 'charger_firmware_v0.3.6.bin'),
      path.join(__dirname, 'charger_ota1_v0.4.0.bin'),
    ];
    opts.input = candidates.find(f => fs.existsSync(f)) || candidates[0];
  }

  return opts;
}

// ═══════════════════════════════════════════════════════════════════════
//  ESP32 Image Parser
// ═══════════════════════════════════════════════════════════════════════

function parseEsp32Image(data) {
  if (data[0] !== 0xE9) {
    throw new Error(`Not an ESP32 image (magic: 0x${data[0].toString(16)}, expected 0xE9)`);
  }

  const numSegments = data[1];
  const entryPoint = data.readUInt32LE(4);
  const segments = [];
  let offset = 24;

  for (let i = 0; i < numSegments; i++) {
    const loadAddr = data.readUInt32LE(offset);
    const size = data.readUInt32LE(offset + 4);
    const dataStart = offset + 8;

    let type = 'UNKNOWN';
    if (loadAddr >= DROM_BASE && loadAddr < DROM_END) type = 'DROM';
    else if (loadAddr >= IROM_BASE && loadAddr < IROM_END) type = 'IROM';
    else if (loadAddr >= 0x3FC80000 && loadAddr < 0x3FD00000) type = 'DRAM';
    else if (loadAddr >= 0x40370000 && loadAddr < 0x40380000) type = 'IRAM';
    else if (loadAddr >= 0x50000000 && loadAddr < 0x50002000) type = 'RTC';

    segments.push({ index: i, loadAddr, size, dataStart, type });
    offset = dataStart + size;
  }

  // Find actual image end (trim 0xFF partition padding if present)
  let imageEnd = data.length;
  // Search backwards for first non-0xFF byte
  while (imageEnd > offset && data[imageEnd - 1] === 0xFF) imageEnd--;

  // Verify SHA256 hash (last 32 bytes of the actual image)
  const hashData = data.subarray(0, imageEnd - 32);
  const computed = crypto.createHash('sha256').update(hashData).digest();
  const stored = data.subarray(imageEnd - 32, imageEnd);
  const sha256Valid = computed.equals(stored);

  // Checksum position: after last segment data, pad with zeros, checksum byte is last byte
  // before 16-byte alignment.  Formula from esptool:
  //   padding = (16 - dataEnd - 1) % 16
  //   checksum at dataEnd + padding
  //   paddedEnd = dataEnd + padding + 1
  const padding = (16 - (offset % 16) - 1 + 16) % 16;
  const checksumOffset = offset + padding;
  const paddedEnd = checksumOffset + 1;

  return { numSegments, entryPoint, segments, sha256Valid, dataEnd: offset, checksumOffset, paddedEnd, imageEnd };
}

// ═══════════════════════════════════════════════════════════════════════
//  String Analysis
// ═══════════════════════════════════════════════════════════════════════

function findString(data, str) {
  const needle = Buffer.from(str, 'utf-8');
  const results = [];
  let pos = 0;

  while (pos < data.length) {
    const idx = data.indexOf(needle, pos);
    if (idx === -1) break;

    // Count available null bytes after the string
    let nulls = 0;
    const strEnd = idx + needle.length;
    while (strEnd + nulls < data.length && data[strEnd + nulls] === 0) nulls++;

    results.push({
      offset: idx,
      length: needle.length,
      nullsAfter: nulls,
      slotSize: needle.length + nulls,
    });

    pos = idx + 1;
  }

  return results;
}

function findSegmentForOffset(segments, offset) {
  for (const seg of segments) {
    if (offset >= seg.dataStart && offset < seg.dataStart + seg.size) {
      return seg;
    }
  }
  return null;
}

function offsetToVirtualAddr(segments, offset) {
  const seg = findSegmentForOffset(segments, offset);
  if (!seg) return null;
  return seg.loadAddr + (offset - seg.dataStart);
}

// ═══════════════════════════════════════════════════════════════════════
//  Unused Space Finder
// ═══════════════════════════════════════════════════════════════════════

function findUnusedSpace(data, segments, minSize = 48) {
  const drom = segments.find(s => s.type === 'DROM');
  if (!drom) throw new Error('No DROM segment found');

  const gaps = [];
  let i = drom.dataStart;
  const end = drom.dataStart + drom.size;

  while (i < end) {
    if (data[i] === 0) {
      const start = i;
      while (i < end && data[i] === 0) i++;
      const len = i - start;
      if (len >= minSize) {
        gaps.push({
          offset: start,
          size: len,
          virtualAddr: drom.loadAddr + (start - drom.dataStart),
        });
      }
    } else {
      i++;
    }
  }

  // Sort by size descending
  gaps.sort((a, b) => b.size - a.size);
  return gaps;
}

// ═══════════════════════════════════════════════════════════════════════
//  Reference Finder (for string relocation)
// ═══════════════════════════════════════════════════════════════════════

function findReferences(data, virtualAddr) {
  // Search for the 4-byte little-endian virtual address in the binary
  const needle = Buffer.alloc(4);
  needle.writeUInt32LE(virtualAddr);

  const refs = [];
  let pos = 0;

  while (pos < data.length - 3) {
    const idx = data.indexOf(needle, pos);
    if (idx === -1) break;
    refs.push(idx);
    pos = idx + 1;
  }

  return refs;
}

// ═══════════════════════════════════════════════════════════════════════
//  Patching Engine
// ═══════════════════════════════════════════════════════════════════════

function applyPatches(data, patches, segments, analyzeOnly) {
  const unusedSpaces = findUnusedSpace(data, segments);
  let nextUnusedIdx = 0; // Index into unusedSpaces for allocation
  let unusedOffset = unusedSpaces.length > 0 ? unusedSpaces[0].offset : -1;

  const results = [];

  for (const patch of patches) {
    const occurrences = findString(data, patch.find);
    const replaceStr = patch.replace;
    const replaceBytes = Buffer.from(replaceStr + '\0', 'utf-8');

    if (occurrences.length === 0) {
      results.push({
        ...patch,
        status: 'NOT_FOUND',
        message: `String "${patch.find}" not found in binary`,
      });
      continue;
    }

    for (const occ of occurrences) {
      const fitsInPlace = replaceBytes.length <= occ.slotSize;
      const vAddr = offsetToVirtualAddr(segments, occ.offset);

      if (fitsInPlace) {
        // ── In-place patch ──────────────────────────────────────
        if (!analyzeOnly) {
          // Write replacement string + null terminator
          replaceBytes.copy(data, occ.offset);
          // Null-fill remaining space
          for (let j = occ.offset + replaceBytes.length; j < occ.offset + occ.slotSize; j++) {
            data[j] = 0;
          }
        }

        results.push({
          ...patch,
          status: 'PATCHED_IN_PLACE',
          offset: occ.offset,
          virtualAddr: vAddr,
          oldSize: occ.length,
          newSize: replaceBytes.length - 1, // -1 for null
          slotSize: occ.slotSize,
          message: `Patched in-place at 0x${occ.offset.toString(16)} (${occ.slotSize - replaceBytes.length} bytes spare)`,
        });

      } else {
        // ── String relocation ───────────────────────────────────
        if (!vAddr) {
          results.push({
            ...patch,
            status: 'FAILED',
            offset: occ.offset,
            message: `Cannot determine virtual address for offset 0x${occ.offset.toString(16)}`,
          });
          continue;
        }

        // Find unused space for the new string
        let targetGap = null;
        for (let g = nextUnusedIdx; g < unusedSpaces.length; g++) {
          if (unusedSpaces[g].size >= replaceBytes.length + 4) { // +4 for safety
            targetGap = unusedSpaces[g];
            break;
          }
        }

        if (!targetGap) {
          results.push({
            ...patch,
            status: 'NO_SPACE',
            offset: occ.offset,
            message: `No unused DROM space for ${replaceBytes.length} bytes. Use --mqtt-host with a shorter hostname or IP address.`,
          });
          continue;
        }

        // Find all references to the old string's virtual address
        const refs = findReferences(data, vAddr);

        if (refs.length === 0) {
          results.push({
            ...patch,
            status: 'NO_REFS',
            offset: occ.offset,
            virtualAddr: vAddr,
            message: `No code references found to virtual address 0x${vAddr.toString(16)}. Cannot safely relocate.`,
          });
          continue;
        }

        // Calculate new virtual address
        const newOffset = targetGap.offset;
        const newVAddr = targetGap.virtualAddr;

        if (!analyzeOnly) {
          // Write new string to unused space
          replaceBytes.copy(data, newOffset);

          // Update all references from old virtual address to new
          const newAddrBuf = Buffer.alloc(4);
          newAddrBuf.writeUInt32LE(newVAddr);

          for (const ref of refs) {
            newAddrBuf.copy(data, ref);
          }

          // Zero out old string (clean up, prevents confusion)
          for (let j = occ.offset; j < occ.offset + occ.length; j++) {
            data[j] = 0;
          }
        }

        // Advance the unused space pointer so we don't overlap
        targetGap.offset += replaceBytes.length + 4; // 4-byte aligned gap
        targetGap.offset = (targetGap.offset + 3) & ~3; // Align to 4
        targetGap.size -= (targetGap.offset - newOffset);
        targetGap.virtualAddr += (targetGap.offset - newOffset);

        results.push({
          ...patch,
          status: 'RELOCATED',
          offset: occ.offset,
          virtualAddr: vAddr,
          newOffset,
          newVAddr,
          references: refs.length,
          refOffsets: refs.map(r => `0x${r.toString(16)}`),
          message: `Relocated to 0x${newOffset.toString(16)} (virt 0x${newVAddr.toString(16)}), ${refs.length} reference(s) updated`,
        });
      }
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════
//  ESP32 Image Checksum (XOR of segment data bytes, init 0xEF)
// ═══════════════════════════════════════════════════════════════════════

function computeImageChecksum(data, segments) {
  let checksum = 0xEF;
  for (const seg of segments) {
    for (let i = seg.dataStart; i < seg.dataStart + seg.size; i++) {
      checksum ^= data[i];
    }
  }
  return checksum & 0xFF;
}

function updateImageChecksum(data, image) {
  const checksum = computeImageChecksum(data, image.segments);
  const stored = data[image.checksumOffset];
  data[image.checksumOffset] = checksum;
  return { checksum, previousValue: stored, offset: image.checksumOffset };
}

// ═══════════════════════════════════════════════════════════════════════
//  SHA256 Hash Update
// ═══════════════════════════════════════════════════════════════════════

function updateSha256(data, imageEnd) {
  const hashData = data.subarray(0, imageEnd - 32);
  const newHash = crypto.createHash('sha256').update(hashData).digest();
  newHash.copy(data, imageEnd - 32);
  return newHash;
}

// ═══════════════════════════════════════════════════════════════════════
//  Output & Deployment Instructions
// ═══════════════════════════════════════════════════════════════════════

function printAnalysis(data, image, patches, results) {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  Novabot Charger Firmware Patcher — Analysis            ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const currentChecksum = computeImageChecksum(data, image.segments);
  const storedChecksum = data[image.checksumOffset];
  const checksumValid = currentChecksum === storedChecksum;

  console.log(`Input:     ${data.length} bytes (${(data.length / 1024).toFixed(1)} KB)`);
  console.log(`Segments:  ${image.numSegments}`);
  console.log(`SHA256:    ${image.sha256Valid ? 'Valid' : 'Invalid/missing'}`);
  console.log(`Checksum:  stored=0x${storedChecksum.toString(16)} computed=0x${currentChecksum.toString(16)} ${checksumValid ? 'Valid' : 'MISMATCH'} (at 0x${image.checksumOffset.toString(16)})`);
  console.log(`Entry:     0x${image.entryPoint.toString(16)}\n`);

  console.log('Segments:');
  for (const seg of image.segments) {
    console.log(`  #${seg.index}: ${seg.type.padEnd(5)} load=0x${seg.loadAddr.toString(16)} size=${seg.size} (file 0x${seg.dataStart.toString(16)}-0x${(seg.dataStart + seg.size).toString(16)})`);
  }

  console.log('\n─── Patchable Strings ───────────────────────────────────\n');

  for (const r of results) {
    const icon = {
      PATCHED_IN_PLACE: '✅',
      RELOCATED: '🔀',
      NOT_FOUND: '⚠️ ',
      NO_SPACE: '❌',
      NO_REFS: '❌',
      FAILED: '❌',
    }[r.status] || '?';

    console.log(`${icon} [${r.id}] ${r.description}`);
    console.log(`   Find:    "${r.find}"`);
    console.log(`   Replace: "${r.replace}"`);
    console.log(`   Status:  ${r.message}`);
    if (r.refOffsets) {
      console.log(`   Refs:    ${r.refOffsets.join(', ')}`);
    }
    console.log();
  }
}

function printDeploymentInstructions(outputPath, md5, opts, firmwareVersion) {
  const fileName = path.basename(outputPath);

  console.log('\n─── Deployment Instructions ─────────────────────────────\n');
  console.log(`Patched binary: ${outputPath}`);
  console.log(`MD5:            ${md5}`);
  console.log(`Size:           ${fs.statSync(outputPath).size} bytes`);
  console.log(`Version:        ${firmwareVersion}`);

  console.log('\n1. Host the patched firmware on a local HTTP server:\n');
  console.log(`   cd ${path.dirname(outputPath)}`);
  console.log(`   python3 -m http.server ${opts.servePort}\n`);

  const localIp = '<YOUR-MAC-IP>';
  const downloadUrl = `http://${localIp}:${opts.servePort}/${fileName}`;

  console.log(`2. Send the OTA upgrade command via MQTT:\n`);
  console.log(`   Topic: Dart/Send_mqtt/LFIC1230700004\n`);

  const otaCmd = {
    ota_upgrade_cmd: {
      type: 'full',
      content: {
        upgradeApp: {
          version: firmwareVersion,
          downloadUrl: downloadUrl,
          md5: md5,
        },
      },
    },
  };

  console.log(`   Payload:\n${JSON.stringify(otaCmd, null, 2)}\n`);

  console.log('   Or via mosquitto_pub:\n');
  console.log(`   mosquitto_pub -h localhost -t "Dart/Send_mqtt/LFIC1230700004" \\`);
  console.log(`     -m '${JSON.stringify(otaCmd)}'\n`);

  console.log('   Or via the dashboard API:\n');
  console.log(`   curl -X POST http://localhost:3000/api/dashboard/command/LFIC1230700004 \\`);
  console.log(`     -H "Content-Type: application/json" \\`);
  console.log(`     -d '${JSON.stringify(otaCmd)}'\n`);

  console.log('─── Important Notes ─────────────────────────────────────\n');
  console.log('  - Replace <YOUR-MAC-IP> with your Mac\'s IP address (e.g., 192.168.178.61)');
  console.log('  - The charger uses esp_https_ota() which may require HTTPS.');
  console.log('    If HTTP fails, try hosting with HTTPS (e.g., caddy, nginx + certbot).');
  console.log('  - The charger must be connected to MQTT to receive the command.');
  console.log('  - After OTA, the charger reboots. The fallback MQTT host will be patched.');
  console.log('  - NVS config (set during BLE provisioning) is NOT affected by OTA.');
  console.log('  - To also update NVS, re-provision via BLE with set_mqtt_info.');
  console.log('  - TEST ON YOUR RESERVE BOARD FIRST before patching the production charger!');
  console.log('  - If OTA fails, the charger boots from the other OTA partition (v0.4.0).');
  console.log('  - Recovery via UART: press "b" to switch OTA partition manually.\n');
}

// ═══════════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════════

function main() {
  const opts = parseArgs();

  // Read input binary
  if (!fs.existsSync(opts.input)) {
    // Check alternate location
    const altPath = path.join(__dirname, 'firmware', path.basename(opts.input));
    if (fs.existsSync(altPath)) {
      opts.input = altPath;
    } else {
      console.error(`Error: Input file not found: ${opts.input}`);
      console.error('Run with --help for usage information.');
      process.exit(1);
    }
  }

  console.log(`\nReading: ${opts.input}`);
  const data = Buffer.from(fs.readFileSync(opts.input));

  // Parse ESP32 image
  const image = parseEsp32Image(data);

  // Detect firmware version from binary
  const detected = detectFirmwareVersion(data, image.segments);
  const detectedVersion = detected ? detected.version : null;

  if (detectedVersion) {
    console.log(`Detected firmware version: ${detectedVersion} (at offset 0x${detected.offset.toString(16)}, ${detected.length} bytes, slot ${detected.length + 2} bytes)`);
  } else {
    console.log('Warning: Could not detect firmware version in binary');
  }

  // Determine target firmware version
  // --fw-version explicitly set → use that
  // Not set → default to <detected>-local
  const firmwareVersion = opts.fwVersion || (detectedVersion ? `${detectedVersion}-local` : 'unknown');
  const shouldPatchVersion = detectedVersion && firmwareVersion !== detectedVersion;

  if (shouldPatchVersion) {
    console.log(`Target firmware version:  ${firmwareVersion}`);
  }

  // Auto-generate output filename if not specified
  if (!opts.output) {
    // Extract base version from detected version for filename (e.g., v0.3.6 → charger_v0.3.6_patched.bin)
    const baseVer = detectedVersion || 'unknown';
    opts.output = path.join(__dirname, 'firmware', `charger_${baseVer}_patched.bin`);
  }

  // Build patch list (include version patch if version is being changed)
  const patches = buildPatches(
    opts.mqttHost,
    opts.otaUrl,
    shouldPatchVersion ? firmwareVersion : null,
    detectedVersion,
  );

  // Apply patches (or analyze)
  const results = applyPatches(data, patches, image.segments, opts.analyzeOnly);

  // Print analysis
  printAnalysis(data, image, patches, results);

  if (opts.analyzeOnly) {
    console.log('─── Analyze-only mode, no files written ────────────────\n');

    // Show unused space info
    const gaps = findUnusedSpace(data, image.segments);
    if (gaps.length > 0) {
      console.log('Available unused DROM space for string relocation:');
      for (const g of gaps) {
        console.log(`  0x${g.offset.toString(16)}: ${g.size} bytes (virt 0x${g.virtualAddr.toString(16)})`);
      }
      console.log();
    }

    if (detectedVersion) {
      console.log(`Detected firmware version: ${detectedVersion}`);
      console.log(`  Use --fw-version <ver> to change it (e.g., --fw-version ${detectedVersion}-local)\n`);
    }
    return;
  }

  // Check if any patches failed
  const failed = results.filter(r => ['NO_SPACE', 'NO_REFS', 'FAILED'].includes(r.status));
  if (failed.length > 0) {
    console.log('⚠️  Some patches could not be applied:');
    for (const f of failed) {
      console.log(`   - ${f.id}: ${f.message}`);
    }
    console.log('\n   Consider using --mqtt-host with a shorter hostname or IP address.\n');
  }

  const applied = results.filter(r => ['PATCHED_IN_PLACE', 'RELOCATED'].includes(r.status));
  if (applied.length === 0) {
    console.log('No patches were applied. Exiting.\n');
    process.exit(1);
  }

  // Trim to actual image size (remove 0xFF partition padding)
  const outputData = data.subarray(0, image.imageEnd);
  console.log(`Image trimmed: ${data.length} → ${outputData.length} bytes (removed ${data.length - outputData.length} bytes padding)`);

  // Update ESP32 image checksum (XOR byte at paddedEnd - 1)
  const checksumResult = updateImageChecksum(outputData, image);
  console.log(`Image checksum updated: 0x${checksumResult.previousValue.toString(16)} → 0x${checksumResult.checksum.toString(16)} (at offset 0x${checksumResult.offset.toString(16)})`);

  // Update SHA256 hash (must be AFTER checksum update, since checksum is in the hashed region)
  const newHash = updateSha256(outputData, outputData.length);
  console.log(`SHA256 hash updated: ${newHash.toString('hex').substring(0, 16)}...`);

  // Verify SHA256
  const verifyData = outputData.subarray(0, outputData.length - 32);
  const verifyHash = crypto.createHash('sha256').update(verifyData).digest();
  if (!verifyHash.equals(outputData.subarray(outputData.length - 32))) {
    console.error('ERROR: SHA256 verification failed after update!');
    process.exit(1);
  }
  console.log('SHA256 verification: OK');

  // Verify image checksum
  const verifyChecksum = computeImageChecksum(outputData, image.segments);
  if (verifyChecksum !== outputData[image.checksumOffset]) {
    console.error(`ERROR: Image checksum verification failed! Computed 0x${verifyChecksum.toString(16)}, stored 0x${outputData[image.checksumOffset].toString(16)}`);
    process.exit(1);
  }
  console.log('Image checksum verification: OK');

  // Ensure output directory exists
  const outDir = path.dirname(opts.output);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Write patched binary
  fs.writeFileSync(opts.output, outputData);

  // Compute MD5 for OTA command
  const md5 = crypto.createHash('md5').update(outputData).digest('hex');

  console.log(`\n✅ Patched firmware written to: ${opts.output}`);
  console.log(`   MD5: ${md5}`);
  console.log(`   Version: ${firmwareVersion}`);

  // Print deployment instructions
  printDeploymentInstructions(opts.output, md5, opts, firmwareVersion);
}

main();
