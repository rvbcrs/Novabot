#!/usr/bin/env node

import https from 'https';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import zlib from 'zlib';

const VERSION = '1.0.0';

// ── CLI argument parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2);

function printUsage() {
  console.log(`
novabot-cloud-export-cli v${VERSION}

Usage:
  Export:  node novabot-cloud-export-cli.mjs export  -e <email> -p <password> -o <dir> [options]
  Restore: node novabot-cloud-export-cli.mjs restore-maps -e <email> -p <password> -o <dir> [options]

Commands:
  export           Export cloud settings to a local folder (default)
  restore-maps     Upload backed-up maps back to the cloud

Required:
  --email, -e         Novabot account email
  --password, -p      Novabot account password
  --output, -o        Export directory (output for export, input for restore)

Export options:
  --include-firmware  Download firmware binaries (large files)
  --include-secrets   Keep sensitive fields (WiFi passwords, MQTT creds) in export
  --force             Overwrite existing export directory without prompting

Restore options:
  --sn <mowerSN>      Mower SN to restore maps for (auto-detected if omitted)
  --dry-run           Show what would be uploaded without uploading
  --yes, -y           Skip confirmation prompt

General:
  --version, -v       Show version
  --help, -h          Show this help message
`);
}

function parseArgs(args) {
  const opts = {
    command: 'export', email: null, password: null, output: null,
    includeFirmware: false, includeSecrets: false, force: false,
    sn: null, dryRun: false, yes: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case 'export': case 'restore-maps':
        opts.command = args[i]; break;
      case '--email': case '-e':
        opts.email = args[++i]; break;
      case '--password': case '-p':
        opts.password = args[++i]; break;
      case '--output': case '-o':
        opts.output = args[++i]; break;
      case '--sn':
        opts.sn = args[++i]; break;
      case '--include-firmware':
        opts.includeFirmware = true; break;
      case '--include-secrets':
        opts.includeSecrets = true; break;
      case '--force':
        opts.force = true; break;
      case '--dry-run':
        opts.dryRun = true; break;
      case '--yes': case '-y':
        opts.yes = true; break;
      case '--version': case '-v':
        console.log(VERSION); process.exit(0);
      case '--help': case '-h':
        printUsage(); process.exit(0);
      default:
        console.error(`Unknown option: ${args[i]}`);
        printUsage(); process.exit(1);
    }
  }
  return opts;
}

const opts = parseArgs(args);

if (!opts.email || !opts.password || !opts.output) {
  console.error('Error: --email, --password, and --output are required.');
  printUsage();
  process.exit(1);
}

// ── Warning tracker ─────────────────────────────────────────────────────────

const warnings = [];

function warn(msg) {
  warnings.push(msg);
  console.warn(`  WARN: ${msg}`);
}

function printWarnings() {
  if (warnings.length === 0) return;
  console.log(`\n${warnings.length} warning(s) during execution:`);
  for (const w of warnings) {
    console.log(`  - ${w}`);
  }
}

// ── Interactive prompt ──────────────────────────────────────────────────────

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// ── LFI Cloud API helpers (from cloud-export/src/server.ts) ─────────────────
//
// NOTE: rejectUnauthorized is false because the LFI cloud is accessed via bare
// IP (47.253.145.99) with a Host header of app.lfibot.com. The server does not
// present a certificate valid for that IP, so Node's TLS handshake would fail.
// We set `servername` for SNI so the server can present the right cert chain,
// but validation remains off because the IP/hostname mismatch is inherent to
// the vendor's infrastructure. This means traffic is encrypted but not
// authenticated — a MITM on your network could intercept requests.

const LFI_CLOUD_HOST = '47.253.145.99';
const LFI_CLOUD_SERVERNAME = 'app.lfibot.com';
const APP_PW_KEY_IV = Buffer.from('1234123412ABCDEF', 'utf8');

function encryptCloudPassword(plainPassword) {
  const cipher = crypto.createCipheriv('aes-128-cbc', APP_PW_KEY_IV, APP_PW_KEY_IV);
  let encrypted = cipher.update(plainPassword, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
}

function makeLfiHeaders(token) {
  const echostr = 'p' + crypto.randomBytes(6).toString('hex');
  const ts = String(Date.now());
  const nonce = crypto.createHash('sha1').update('qtzUser', 'utf8').digest('hex');
  const sig = crypto.createHash('sha256').update(echostr + nonce + ts + token, 'utf8').digest('hex');
  return {
    'Host': LFI_CLOUD_SERVERNAME,
    'Authorization': token,
    'Content-Type': 'application/json;charset=UTF-8',
    'source': 'app',
    'userlanguage': 'en',
    'echostr': echostr,
    'nonce': nonce,
    'timestamp': ts,
    'signature': sig,
  };
}

function callLfiCloud(method, urlPath, body, token = '') {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      ...makeLfiHeaders(token),
      ...(bodyStr ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
    };
    const req = https.request({
      hostname: LFI_CLOUD_HOST,
      servername: LFI_CLOUD_SERVERNAME,
      path: urlPath,
      method,
      headers,
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Cloud API returned invalid JSON: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Cloud API timeout — check your internet connection')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const MAX_REAUTH_RETRIES = 3;

async function fetchPaginated(token, urlPath, params, listKey, loginFn) {
  const all = [];
  let page = 1;
  let totalSize = 0;
  let currentToken = token;
  let reauthRetries = 0;

  while (true) {
    const body = { ...params, pageNo: page };
    const resp = await callLfiCloud('POST', urlPath, body, currentToken);

    if (resp.code === 1008) {
      reauthRetries++;
      if (reauthRetries > MAX_REAUTH_RETRIES) {
        throw new Error(`Token refresh failed after ${MAX_REAUTH_RETRIES} attempts`);
      }
      currentToken = await loginFn();
      continue;
    }

    const val = resp.value;
    const list = val?.[listKey];
    if (!resp.success || !list || list.length === 0) break;

    totalSize = val?.totalSize || 0;
    all.push(...list);

    if (all.length >= totalSize) break;
    page++;
    if (page > 200) break;

    // Progress indicator
    if (totalSize > 0) {
      process.stdout.write(`\r  Fetching (${all.length}/${totalSize})... `);
    }
  }

  return { token: currentToken, items: all };
}

const MAX_REDIRECTS = 5;

function downloadFile(url, destPath, token, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) {
    return Promise.reject(new Error(`Too many redirects (>${MAX_REDIRECTS})`));
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);

    // SSRF protection: only allow http/https and block private/link-local IPs
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(new Error(`Blocked download: unsupported protocol ${parsed.protocol}`));
      return;
    }
    const hostname = parsed.hostname;
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|localhost$)/i.test(hostname)
        && hostname !== LFI_CLOUD_HOST) {
      reject(new Error(`Blocked download: private/internal address ${hostname}`));
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const protocol = isHttps ? https : http;

    const isCloudUrl = parsed.hostname === LFI_CLOUD_SERVERNAME;
    const reqOpts = {
      hostname: isCloudUrl ? LFI_CLOUD_HOST : parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: 120000,
      ...(isCloudUrl ? {
        headers: makeLfiHeaders(token ?? ''),
        rejectUnauthorized: false,
        servername: LFI_CLOUD_SERVERNAME,
      } : {}),
    };

    const req = protocol.request(reqOpts, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        downloadFile(res.headers.location, destPath, token, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => { fileStream.close(); resolve(); });
      fileStream.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Login helper ────────────────────────────────────────────────────────────

async function doLogin() {
  const encryptedPw = encryptCloudPassword(opts.password);
  const resp = await callLfiCloud('POST', '/api/nova-user/appUser/login', {
    email: opts.email, password: encryptedPw, imei: 'imei',
  });

  const val = resp.value;
  if (!resp.success || !val?.accessToken) {
    throw new Error(`Login failed: ${resp.message ?? 'unknown error'}`);
  }

  return { accessToken: val.accessToken, appUserId: val.appUserId };
}

// Returns just the token string — for use as loginFn in fetchPaginated
async function refreshToken() {
  const { accessToken } = await doLogin();
  return accessToken;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function writeJson(filePath, data) {
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, content);
  return Buffer.byteLength(content);
}

function step(msg) {
  process.stdout.write(`  ${msg}... `);
}

function done(detail) {
  console.log(detail ? `done (${detail})` : 'done');
}

// Sanitize a filename from untrusted input — strip path components and reject traversal
function safeName(fileName) {
  const base = path.basename(fileName);
  if (base !== fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    return null;
  }
  return base;
}

const SENSITIVE_FIELDS = ['wifiPassword', 'wifiName', 'password', 'account'];

function redactSecrets(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(redactSecrets);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_FIELDS.includes(k) && typeof v === 'string') {
      out[k] = '***REDACTED***';
    } else {
      out[k] = redactSecrets(v);
    }
  }
  return out;
}

// ── Multipart upload helper ─────────────────────────────────────────────────

function uploadMultipart(urlPath, fields, fileField, token) {
  return new Promise((resolve, reject) => {
    const boundary = '----NovabotCLI' + crypto.randomBytes(8).toString('hex');
    const parts = [];

    // Text fields
    for (const [key, value] of Object.entries(fields)) {
      if (value == null) continue;
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
        `${value}\r\n`
      );
    }

    // File field
    if (fileField) {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fileField.field}"; filename="${fileField.filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`
      );
    }

    const headBuf = Buffer.from(parts.join(''));
    const tailBuf = Buffer.from(`\r\n--${boundary}--\r\n`);
    const fileBuf = fileField ? fs.readFileSync(fileField.path) : Buffer.alloc(0);
    const body = Buffer.concat([headBuf, fileBuf, tailBuf]);

    const headers = {
      ...makeLfiHeaders(token),
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    };

    const req = https.request({
      hostname: LFI_CLOUD_HOST,
      servername: LFI_CLOUD_SERVERNAME,
      path: urlPath,
      method: 'POST',
      headers,
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Upload returned invalid JSON: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Upload timeout')); });
    req.write(body);
    req.end();
  });
}

// ── ZIP helper (pure Node.js) ──────────────────────────────────────────────

function createZip(sourceDir, destPath) {
  const entries = [];

  function collectFiles(dir, prefix) {
    for (const name of fs.readdirSync(dir)) {
      if (name === path.basename(destPath) || name === '.DS_Store') continue;
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        collectFiles(full, rel);
      } else {
        entries.push({ rel, full, size: stat.size, mtime: stat.mtime });
      }
    }
  }
  collectFiles(sourceDir, '');

  const parts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = fs.readFileSync(entry.full);
    const compressed = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const nameBytes = Buffer.from(entry.rel, 'utf8');
    const useStore = compressed.length >= raw.length;
    const data = useStore ? raw : compressed;
    const method = useStore ? 0 : 8;

    // DOS date/time from mtime
    const d = entry.mtime;
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

    // Local file header (30 + name + data)
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);  // signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(method, 8);       // compression method
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);   // compressed size
    local.writeUInt32LE(raw.length, 22);    // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length

    const localEntry = Buffer.concat([local, nameBytes, data]);
    parts.push(localEntry);

    // Central directory entry (46 + name)
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);  // signature
    central.writeUInt16LE(20, 4);           // version made by
    central.writeUInt16LE(20, 6);           // version needed
    central.writeUInt16LE(0, 8);            // flags
    central.writeUInt16LE(method, 10);      // compression method
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); // compressed size
    central.writeUInt32LE(raw.length, 24);  // uncompressed size
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);           // extra field length
    central.writeUInt16LE(0, 32);           // comment length
    central.writeUInt16LE(0, 34);           // disk number start
    central.writeUInt16LE(0, 36);           // internal attributes
    central.writeUInt32LE(0, 38);           // external attributes
    central.writeUInt32LE(offset, 42);      // local header offset

    centralParts.push(Buffer.concat([central, nameBytes]));
    offset += localEntry.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                        // disk number
  eocd.writeUInt16LE(0, 6);                        // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);            // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);           // total entries
  eocd.writeUInt32LE(centralDir.length, 12);        // central dir size
  eocd.writeUInt32LE(offset, 16);                   // central dir offset
  eocd.writeUInt16LE(0, 20);                        // comment length

  fs.writeFileSync(destPath, Buffer.concat([...parts, centralDir, eocd]));
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── Restore maps ────────────────────────────────────────────────────────────

async function restoreMaps() {
  const inputDir = path.resolve(opts.output);
  const mapsDir = path.join(inputDir, 'maps');

  console.log('Novabot Map Restore CLI');
  console.log('========================\n');

  if (opts.dryRun) {
    console.log('  ** DRY RUN — no files will be uploaded **\n');
  }

  if (!fs.existsSync(mapsDir)) {
    console.error(`Error: No maps directory found at ${mapsDir}`);
    console.error('Make sure --output points to a previous export folder.');
    process.exit(1);
  }

  // 1. Login
  step('Logging in');
  const { accessToken, appUserId } = await doLogin();
  const token = accessToken;
  done(opts.email);

  // 2. Discover mower SNs from the export
  const mapMetaFiles = fs.readdirSync(mapsDir).filter(f => f.endsWith('.json'));
  const availableSns = mapMetaFiles.map(f => f.replace('.json', '')).filter(sn => sn.startsWith('LFIN'));

  if (availableSns.length === 0) {
    console.error('Error: No mower map metadata found in the export.');
    console.error('Expected files like maps/LFIN2XXXXXXXXX.json with map data inside.');
    process.exit(1);
  }

  // If --sn was provided, validate it; otherwise use all available
  const targetSns = opts.sn ? [opts.sn] : availableSns;
  for (const sn of targetSns) {
    if (!availableSns.includes(sn)) {
      console.error(`Error: No map data found for mower ${sn}`);
      console.error(`Available: ${availableSns.join(', ')}`);
      process.exit(1);
    }
  }

  console.log(`  Mower(s) to restore: ${targetSns.join(', ')}\n`);

  // 3. Verify the mower is bound to this account
  step('Verifying device ownership');
  const equipResp = await callLfiCloud('POST', '/api/nova-user/equipment/userEquipmentList', {
    appUserId, pageSize: 50, pageNo: 1,
  }, token);
  const devices = equipResp.value?.pageList ?? [];
  const boundMowerSns = devices
    .map(d => String(d.mowerSn ?? d.sn ?? ''))
    .filter(sn => sn.startsWith('LFIN'));

  for (const sn of targetSns) {
    if (!boundMowerSns.includes(sn)) {
      warn(`Mower ${sn} is not currently bound to your account. Upload may fail.`);
    }
  }
  done();

  // 4. Build upload plan and check existing cloud maps
  const uploadPlan = []; // { sn, fileName, type, alias, csvPath, size }

  for (const sn of targetSns) {
    step(`Checking existing cloud maps for ${sn}`);
    try {
      const existing = await callLfiCloud('GET',
        `/api/nova-file-server/map/queryEquipmentMap?sn=${sn}&appUserId=${appUserId}`,
        null, token);
      const data = existing.value?.data;
      if (data && (data.work?.length > 0 || data.unicom?.length > 0)) {
        const workCount = data.work?.length ?? 0;
        const unicomCount = data.unicom?.length ?? 0;
        done(`${workCount} work area(s), ${unicomCount} channel(s) already exist`);
        warn(`Maps already exist in cloud for ${sn}. Skipping to avoid duplicates. Delete maps from the app first to force restore.`);
        continue;
      }
      done('no maps — will restore');
    } catch {
      done('could not check — will attempt restore');
    }

    // Read the backed-up map metadata
    const metaPath = path.join(mapsDir, `${sn}.json`);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const mapData = meta.data;

    if (!mapData) {
      warn(`No map data in backup for ${sn}`);
      continue;
    }

    const csvDir = path.join(mapsDir, sn);
    const collectItems = (items, type) => {
      for (const item of (items ?? [])) {
        const sanitized = safeName(item.fileName);
        if (!sanitized) {
          warn(`Skipping file with suspicious name: ${item.fileName}`);
          continue;
        }
        const csvPath = path.join(csvDir, sanitized);
        // Verify the resolved path is within the expected directory
        if (!path.resolve(csvPath).startsWith(path.resolve(csvDir) + path.sep)
            && path.resolve(csvPath) !== path.resolve(csvDir, sanitized)) {
          warn(`Path traversal blocked for: ${item.fileName}`);
          continue;
        }
        if (!fs.existsSync(csvPath)) {
          warn(`File not found in backup: ${sanitized} — will skip`);
          continue;
        }
        uploadPlan.push({
          sn, fileName: sanitized, type,
          alias: item.alias ?? item.fileName,
          csvPath,
          size: fs.statSync(csvPath).size,
        });
        // Collect obstacles nested under work items
        if (type === 'work') {
          collectItems(item.obstacle, 'obstacle');
        }
      }
    };

    collectItems(mapData.work, 'work');
    collectItems(mapData.unicom, 'unicom');
  }

  if (uploadPlan.length === 0) {
    console.log('\nNothing to restore.');
    printWarnings();
    return;
  }

  // 5. Show plan and confirm
  console.log(`\nUpload plan (${uploadPlan.length} file(s)):`);
  for (const item of uploadPlan) {
    const sizeKb = (item.size / 1024).toFixed(1);
    console.log(`  ${item.sn}/${item.fileName}  (${item.type}, ${sizeKb} KB)`);
  }

  if (opts.dryRun) {
    console.log('\nDry run complete. No files were uploaded.');
    printWarnings();
    return;
  }

  if (!opts.yes) {
    console.log('');
    const proceed = await confirm(`Upload ${uploadPlan.length} file(s) to the Novabot cloud?`);
    if (!proceed) {
      console.log('Aborted.');
      return;
    }
  }

  // 6. Execute uploads
  let uploadCount = 0;
  let failCount = 0;

  for (const item of uploadPlan) {
    const uploadId = crypto.randomUUID();
    step(`Uploading ${item.sn}/${item.fileName} (${item.type})`);
    try {
      const resp = await uploadMultipart(
        '/api/nova-file-server/map/fragmentUploadEquipmentMap',
        {
          sn: item.sn,
          uploadId,
          chunkIndex: '0',
          chunksTotal: '1',
          mapName: item.alias,
        },
        { field: 'file', filename: item.fileName, path: item.csvPath },
        token,
      );

      if (resp.success || resp.value?.mapId) {
        done(resp.value?.mapId ?? 'ok');
        uploadCount++;
      } else {
        done('FAILED');
        warn(`Upload failed for ${item.fileName}: ${resp.message ?? JSON.stringify(resp)}`);
        failCount++;
      }
    } catch (err) {
      done('ERROR');
      warn(`Upload error for ${item.fileName}: ${err.message}`);
      failCount++;
    }
  }

  // 7. Verify maps landed in the cloud
  console.log('');
  const verifiedSns = [...new Set(uploadPlan.map(i => i.sn))];
  for (const sn of verifiedSns) {
    step(`Verifying cloud maps for ${sn}`);
    try {
      const check = await callLfiCloud('GET',
        `/api/nova-file-server/map/queryEquipmentMap?sn=${sn}&appUserId=${appUserId}`,
        null, token);
      const data = check.value?.data;
      const workCount = data?.work?.length ?? 0;
      const unicomCount = data?.unicom?.length ?? 0;
      if (workCount > 0 || unicomCount > 0) {
        done(`${workCount} work area(s), ${unicomCount} channel(s) confirmed`);
      } else {
        done('no maps found — upload may not have taken effect');
        warn(`Verification: no maps found for ${sn} after upload`);
      }
    } catch {
      done('could not verify');
      warn(`Could not verify maps for ${sn} after upload`);
    }
  }

  console.log(`\nRestore complete: ${uploadCount} uploaded, ${failCount} failed.`);
  console.log('Open the Novabot app and check that your maps appear.');
  console.log('If the mower is online, it should sync the maps automatically.');
  printWarnings();
}

// ── Main export ─────────────────────────────────────────────────────────────

async function main() {
  const outputDir = path.resolve(opts.output);

  console.log('Novabot Cloud Export CLI');
  console.log('========================\n');

  // Check if output directory already has an export
  if (fs.existsSync(path.join(outputDir, 'export-summary.json')) && !opts.force) {
    const proceed = await confirm(`  ${outputDir} already contains an export. Overwrite?`);
    if (!proceed) {
      console.log('Aborted. Use --force to skip this prompt.');
      return;
    }
  }

  // 1. Login
  step('Logging in');
  const { accessToken, appUserId } = await doLogin();
  let token = accessToken;
  done(opts.email);

  // Create output directories
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'devices'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'maps'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'schedules'), { recursive: true });
  if (opts.includeFirmware) {
    fs.mkdirSync(path.join(outputDir, 'firmware'), { recursive: true });
  }

  let totalFiles = 0;
  let totalSize = 0;

  const save = (filePath, data) => {
    const sz = writeJson(filePath, data);
    totalFiles++;
    totalSize += sz;
  };

  // 2. Account info
  step('Fetching account info');
  try {
    const infoResp = await callLfiCloud('GET', `/api/nova-user/appUser/appUserInfo?email=${encodeURIComponent(opts.email)}`, null, token);
    save(path.join(outputDir, 'account.json'), infoResp.value ?? infoResp);
    done();
  } catch (err) {
    save(path.join(outputDir, 'account.json'), { email: opts.email, appUserId });
    warn(`Account info fetch failed (${err.message}), saved partial`);
    done('partial');
  }

  // 3. Device list
  step('Fetching device list');
  const equipResp = await callLfiCloud('POST', '/api/nova-user/equipment/userEquipmentList', {
    appUserId, pageSize: 50, pageNo: 1,
  }, token);

  const equipVal = equipResp.value;
  const devices = (equipVal?.pageList ?? []);

  const chargers = devices.filter(e => String(e.chargerSn ?? e.sn ?? '').startsWith('LFIC'));
  const mowers = devices.filter(e => String(e.mowerSn ?? e.sn ?? '').startsWith('LFIN'));
  const mowerSns = mowers.map(d => String(d.mowerSn ?? d.sn ?? '')).filter(Boolean);
  const allSns = devices.map(d => String(d.sn ?? d.chargerSn ?? d.mowerSn ?? '')).filter(sn => sn.startsWith('LFI'));

  save(path.join(outputDir, 'devices.json'), devices);
  done(`${mowers.length} mower(s), ${chargers.length} charger(s)`);

  // 4. Device details
  step('Fetching device details');
  let detailCount = 0;
  for (const sn of allSns) {
    try {
      const detailResp = await callLfiCloud('POST', '/api/nova-user/equipment/getEquipmentBySN', {
        sn, appUserId,
      }, token);
      const detail = detailResp.value ?? detailResp;
      save(path.join(outputDir, 'devices', `${sn}.json`),
        opts.includeSecrets ? detail : redactSecrets(detail));
      detailCount++;
    } catch (err) {
      warn(`Device detail fetch failed for ${sn}: ${err.message}`);
    }
  }
  done(`${detailCount} device(s)`);

  // 5. Maps
  step('Fetching maps');
  let mapFileCount = 0;
  for (const sn of mowerSns) {
    try {
      const mapResp = await callLfiCloud('GET', `/api/nova-file-server/map/queryEquipmentMap?sn=${sn}&appUserId=${appUserId}`, null, token);
      const mapVal = mapResp.value ?? mapResp;
      save(path.join(outputDir, 'maps', `${sn}.json`), mapVal);

      // Download CSV files referenced in the map data
      const mapData = mapVal.data;
      if (mapData && typeof mapData === 'object') {
        const snMapDir = path.join(outputDir, 'maps', sn);
        fs.mkdirSync(snMapDir, { recursive: true });

        const downloadMapItem = async (item) => {
          const url = item.url;
          const fileName = safeName(item.fileName);
          if (!url || !fileName) return;
          try {
            await downloadFile(url, path.join(snMapDir, fileName), token);
            mapFileCount++;
            totalFiles++;
          } catch (err) {
            warn(`Map file download failed: ${fileName} (${err.message})`);
          }
        };

        const allItems = [
          ...((mapData.work ?? [])),
          ...((mapData.unicom ?? [])),
        ];
        for (const item of allItems) {
          await downloadMapItem(item);
          const obstacles = item.obstacle ?? [];
          for (const obs of obstacles) {
            await downloadMapItem(obs);
          }
        }
      }
    } catch (err) {
      warn(`Map fetch failed for ${sn}: ${err.message}`);
    }
  }
  done(`${mapFileCount} map file(s) downloaded`);

  // 6. Work records (paginated)
  step('Fetching work records');
  let workRecordCount = 0;
  for (const sn of mowerSns) {
    try {
      const result = await fetchPaginated(
        token,
        '/api/novabot-message/message/queryCutGrassRecordPageByUserId',
        { appUserId, pageSize: 50, sn },
        'pageList',
        refreshToken,
      );
      token = result.token;
      workRecordCount += result.items.length;
      save(path.join(outputDir, `work-records-${sn}.json`), {
        sn,
        totalSize: result.items.length,
        records: result.items,
      });
    } catch (err) {
      warn(`Work records fetch failed for ${sn}: ${err.message}`);
    }
  }
  done(`${workRecordCount} record(s)`);

  // 7. Messages (paginated)
  step('Fetching messages');
  let messageCount = 0;
  try {
    const result = await fetchPaginated(
      token,
      '/api/novabot-message/message/queryRobotMsgPageByUserId',
      { appUserId, pageSize: 50 },
      'pageList',
      refreshToken,
    );
    token = result.token;
    messageCount = result.items.length;
    save(path.join(outputDir, 'messages.json'), {
      totalSize: result.items.length,
      messages: result.items,
    });
  } catch (err) {
    warn(`Messages fetch failed: ${err.message}`);
  }
  done(`${messageCount} message(s)`);

  // 8. Schedules (per mower)
  step('Fetching schedules');
  for (const sn of mowerSns) {
    try {
      const schedResp = await callLfiCloud('POST',
        '/api/nova-data/cutGrassPlan/queryRecentCutGrassPlan',
        { sn, appUserId }, token
      );
      save(path.join(outputDir, 'schedules', `${sn}.json`), schedResp.value ?? schedResp);
    } catch (err) {
      warn(`Schedule fetch failed for ${sn}: ${err.message}`);
    }
  }
  done();

  // 9. Firmware info
  step('Fetching firmware info');
  const firmwareInfo = { charger: [], mower: [] };
  const chargerVersions = ['v0.0.0', 'v0.3.6', 'v0.4.0'];
  const mowerVersions = ['v0.0.0', 'v5.7.1', 'v6.0.0', 'v6.0.2'];

  for (const ver of chargerVersions) {
    try {
      const r = await callLfiCloud('GET',
        `/api/nova-user/otaUpgrade/checkOtaNewVersion?version=${ver}&upgradeType=serviceUpgrade&equipmentType=LFIC1&sn=SCAN`,
        null, token
      );
      if (r.value?.version) firmwareInfo.charger.push(r.value);
    } catch { /* best-effort */ }
  }
  for (const ver of mowerVersions) {
    try {
      const r = await callLfiCloud('GET',
        `/api/nova-user/otaUpgrade/checkOtaNewVersion?version=${ver}&upgradeType=serviceUpgrade&equipmentType=LFIN2&sn=SCAN`,
        null, token
      );
      if (r.value?.version) firmwareInfo.mower.push(r.value);
    } catch { /* best-effort */ }
  }
  save(path.join(outputDir, 'firmware.json'), firmwareInfo);

  if (opts.includeFirmware) {
    const allFirmware = [...(firmwareInfo.charger || []), ...(firmwareInfo.mower || [])];
    for (const fw of allFirmware) {
      if (fw.downloadUrl) {
        const filename = path.basename(new URL(fw.downloadUrl).pathname);
        const filePath = path.join(outputDir, 'firmware', filename);
        if (!fs.existsSync(filePath)) {
          try {
            await downloadFile(fw.downloadUrl, filePath);
            totalFiles++;
            totalSize += fs.statSync(filePath).size;
          } catch (err) {
            warn(`Firmware download failed for ${filename}: ${err.message}`);
          }
        }
      }
    }
  }
  done();

  // 10. Export summary
  const summary = {
    exportDate: new Date().toISOString(),
    email: opts.email,
    appUserId,
    deviceCount: allSns.length,
    mowerCount: mowerSns.length,
    chargerCount: chargers.length,
    workRecordCount,
    messageCount,
    totalFiles,
    totalSizeBytes: totalSize,
    secretsRedacted: !opts.includeSecrets,
    warnings: warnings.length,
  };
  save(path.join(outputDir, 'export-summary.json'), summary);

  // 11. Create ZIP (pure Node.js — no external tools)
  step('Creating ZIP archive');
  const zipPath = path.join(outputDir, 'novabot-export.zip');
  try {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    createZip(outputDir, zipPath);
    done(zipPath);
  } catch (err) {
    warn(`ZIP creation failed: ${err.message}`);
    console.log('skipped');
  }

  // Done
  console.log('\nExport complete!');
  console.log(`  Output: ${outputDir}`);
  console.log(`  Files:  ${totalFiles}`);
  console.log(`  Size:   ${(totalSize / 1024).toFixed(1)} KB`);
  if (!opts.includeSecrets) {
    console.log('  Note:   Sensitive fields (WiFi passwords, MQTT creds) were redacted.');
    console.log('          Use --include-secrets to keep them.');
  }
  printWarnings();
}

const run = opts.command === 'restore-maps' ? restoreMaps : main;
run().catch(err => {
  console.error(`\nError: ${err.message}`);
  printWarnings();
  process.exit(1);
});
