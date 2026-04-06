/**
 * Setup wizard API routes — used during initial configuration.
 *
 * Reuses the working cloud import logic from bootstrap/src/server.ts
 * and the admin import endpoint already in dashboard.ts.
 *
 * Flow:
 * 1. GET  /api/setup/status       — check if setup is complete
 * 2. POST /api/setup/cloud-login  — login to LFI cloud, return device list (preview)
 * 3. POST /api/setup/cloud-apply  — import selected devices into local DB
 * 4. POST /api/setup/skip         — create local account without cloud import
 * 5. GET  /api/setup/devices      — list imported devices
 * 6. GET  /api/setup/health       — check server + MQTT health
 */

import { Router, Request, Response } from 'express';
import https from 'https';
import crypto from 'crypto';
import { db } from '../db/database.js';
import { isSetupComplete, invalidateSetupCache } from '../middleware/setupGuard.js';

export const setupRouter = Router();

// ── LFI Cloud API helpers (copied from bootstrap/src/server.ts) ──────────────
// These are proven working — do NOT modify without testing against the real cloud.

const LFI_CLOUD_HOST = '47.253.145.99';
const APP_PW_KEY_IV = Buffer.from('1234123412ABCDEF', 'utf8');

function encryptCloudPassword(plainPassword: string): string {
  const cipher = crypto.createCipheriv('aes-128-cbc', APP_PW_KEY_IV, APP_PW_KEY_IV);
  let encrypted = cipher.update(plainPassword, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
}

function makeLfiHeaders(token: string): Record<string, string> {
  const echostr = 'p' + crypto.randomBytes(6).toString('hex');
  const ts = String(Date.now());
  const nonce = crypto.createHash('sha1').update('qtzUser', 'utf8').digest('hex');
  const sig = crypto.createHash('sha256')
    .update(echostr + nonce + ts + token, 'utf8').digest('hex');
  return {
    'Host': 'app.lfibot.com',
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

function callLfiCloud(
  method: string, urlPath: string,
  body: Record<string, unknown> | null, token = ''
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers: Record<string, string> = {
      ...makeLfiHeaders(token),
      ...(bodyStr ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
    };
    const opts: https.RequestOptions = {
      hostname: LFI_CLOUD_HOST,
      path: urlPath,
      method,
      headers,
      rejectUnauthorized: false,
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Cloud API invalid JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Cloud API timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── GET /status ──────────────────────────────────────────────────────────────

setupRouter.get('/status', (_req, res) => {
  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  const equipCount = (db.prepare('SELECT COUNT(*) as count FROM equipment').get() as { count: number }).count;
  const deviceCount = (db.prepare('SELECT COUNT(*) as count FROM device_registry').get() as { count: number }).count;

  res.json({
    setupComplete: isSetupComplete(),
    users: userCount,
    equipment: equipCount,
    devicesConnected: deviceCount,
  });
});

// ── POST /cloud-login — Step 1: login + fetch device list (preview) ──────────
// Exact same logic as bootstrap/src/server.ts /api/cloud-import

setupRouter.post('/cloud-login', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ ok: false, error: 'Email and password required' });
    return;
  }

  try {
    const encryptedPw = encryptCloudPassword(password);

    // Login (exact same call as bootstrap)
    const loginResp = await callLfiCloud('POST', '/api/nova-user/appUser/login', {
      email, password: encryptedPw, imei: 'imei',
    });

    const loginVal = (loginResp as Record<string, unknown>).value as Record<string, unknown> | undefined;
    if (!loginResp || !(loginResp as { success?: boolean }).success || !loginVal?.accessToken) {
      const msg = (loginResp as { message?: string }).message ?? 'Login failed';
      res.status(401).json({ ok: false, error: msg });
      return;
    }

    const accessToken = loginVal.accessToken as string;
    const appUserId = loginVal.appUserId as number;

    // Fetch equipment list (exact same call as bootstrap)
    const equipResp = await callLfiCloud('POST', '/api/nova-user/equipment/userEquipmentList', {
      appUserId, pageSize: 10, pageNo: 1,
    }, accessToken);

    const equipVal = (equipResp as Record<string, unknown>).value as Record<string, unknown> | undefined;
    const pageList = ((equipVal?.pageList ?? []) as Record<string, unknown>[]);

    // Categorize devices (same logic as bootstrap)
    const chargers = pageList.filter(e => {
      const sn = String(e.chargerSn ?? e.sn ?? '');
      return sn.startsWith('LFIC');
    });
    const mowers = pageList.filter(e => {
      const sn = String(e.mowerSn ?? e.sn ?? '');
      return sn.startsWith('LFIN');
    });

    res.json({ ok: true, email, appUserId, chargers, mowers, rawList: pageList });
  } catch (err) {
    console.error('[Setup] Cloud login error:', err);
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Cloud login failed',
    });
  }
});

// ── POST /cloud-apply — Step 2: import into local DB ─────────────────────────
// Calls the existing /api/dashboard/admin/import endpoint internally.

setupRouter.post('/cloud-apply', async (req: Request, res: Response) => {
  const { email, password, deviceName, charger, mower } = req.body as {
    email?: string;
    password?: string;
    deviceName?: string;
    charger?: { sn: string; address?: number; channel?: number; mac?: string };
    mower?: { sn: string; mac?: string; version?: string };
  };

  if (!email || !password) {
    res.status(400).json({ ok: false, error: 'Email and password required' });
    return;
  }

  try {
    // Call the existing admin import endpoint internally via fetch to localhost
    const port = process.env.PORT ?? '3000';
    const resp = await fetch(`http://127.0.0.1:${port}/api/dashboard/admin/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, deviceName, charger, mower }),
    });

    const data = await resp.json() as Record<string, unknown>;

    // Invalidate setup cache after import
    invalidateSetupCache();

    res.json({ ...data, setupComplete: isSetupComplete() });
  } catch (err) {
    console.error('[Setup] Cloud apply error:', err);
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Import failed',
    });
  }
});

// ── POST /skip — create local account without cloud import ───────────────────

setupRouter.post('/skip', async (_req: Request, res: Response) => {
  try {
    const bcrypt = await import('bcrypt');
    const hashedPwd = await bcrypt.hash('admin', 10);
    const appUserId = `local_${Date.now()}`;

    db.prepare(`
      INSERT OR IGNORE INTO users (app_user_id, email, password, username)
      VALUES (?, ?, ?, ?)
    `).run(appUserId, 'admin@local', hashedPwd, 'admin');

    invalidateSetupCache();
    res.json({ ok: true, message: 'Local account created. Bind your mower via the Novabot app.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── GET /devices ─────────────────────────────────────────────────────────────

setupRouter.get('/devices', (_req, res) => {
  const equipment = db.prepare(`
    SELECT mower_sn, charger_sn, equipment_nick_name, mower_version, charger_version
    FROM equipment
  `).all();

  const registry = db.prepare(`
    SELECT sn, mac_address, last_seen FROM device_registry
    ORDER BY last_seen DESC
  `).all();

  res.json({ equipment, registry });
});

// ── GET /profile — generate combined .mobileconfig (DNS + TLS cert) ───────────

setupRouter.get('/profile', async (_req, res) => {
  const fs = await import('fs');
  const path = await import('path');
  const crypto = await import('crypto');

  const serverIp = process.env.TARGET_IP ?? '127.0.0.1';
  const certPath = '/data/certs/server.crt';

  // Read the TLS certificate
  let certDer: Buffer | null = null;
  try {
    const certPem = fs.readFileSync(certPath, 'utf-8');
    // Extract base64 content between BEGIN/END CERTIFICATE
    const b64 = certPem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s/g, '');
    certDer = Buffer.from(b64, 'base64');
  } catch {
    // No cert available
  }

  const profileUuid = crypto.randomUUID().toUpperCase();
  const dnsUuid = crypto.randomUUID().toUpperCase();
  const certUuid = crypto.randomUUID().toUpperCase();

  // Build payloads array
  const payloads: string[] = [];

  // DNS payload
  payloads.push(`
    <dict>
      <key>PayloadType</key>
      <string>com.apple.dnsSettings.managed</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>com.opennova.profile.dns</string>
      <key>PayloadUUID</key>
      <string>${dnsUuid}</string>
      <key>PayloadDisplayName</key>
      <string>OpenNova DNS</string>
      <key>PayloadDescription</key>
      <string>Routes DNS queries through the OpenNova server so the Novabot app connects locally.</string>
      <key>DNSSettings</key>
      <dict>
        <key>ServerAddresses</key>
        <array>
          <string>${serverIp}</string>
        </array>
      </dict>
    </dict>`);

  // TLS certificate payload (if cert exists)
  if (certDer) {
    payloads.push(`
    <dict>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>com.opennova.profile.cert</string>
      <key>PayloadUUID</key>
      <string>${certUuid}</string>
      <key>PayloadDisplayName</key>
      <string>OpenNova CA Certificate</string>
      <key>PayloadDescription</key>
      <string>Trusts the OpenNova server's TLS certificate for secure HTTPS connections.</string>
      <key>PayloadContent</key>
      <data>${certDer.toString('base64')}</data>
    </dict>`);
  }

  const profile = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadIdentifier</key>
  <string>com.opennova.profile</string>
  <key>PayloadUUID</key>
  <string>${profileUuid}</string>
  <key>PayloadDisplayName</key>
  <string>OpenNova</string>
  <key>PayloadDescription</key>
  <string>Configures DNS and TLS for the Novabot app to connect to your local OpenNova server (${serverIp}).</string>
  <key>PayloadOrganization</key>
  <string>OpenNova</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadContent</key>
  <array>${payloads.join('')}
  </array>
</dict>
</plist>`;

  res.setHeader('Content-Type', 'application/x-apple-aspen-config');
  res.setHeader('Content-Disposition', 'attachment; filename="OpenNova.mobileconfig"');
  res.send(profile);
});

// ── GET /cert — download TLS certificate separately ──────────────────────────

setupRouter.get('/cert', async (_req, res) => {
  const fs = await import('fs');
  try {
    const cert = fs.readFileSync('/data/certs/server.crt');
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="OpenNova-CA.crt"');
    res.send(cert);
  } catch {
    res.status(404).json({ error: 'No certificate found. Start the container first.' });
  }
});

// ── GET /dns-check — verify DNS resolution ───────────────────────────────────

setupRouter.get('/dns-check', async (_req, res) => {
  const dns = await import('dns');
  const os = await import('os');

  // Determine this server's IP (TARGET_IP env or first non-internal IPv4)
  let serverIp = process.env.TARGET_IP ?? '';
  if (!serverIp) {
    const ifaces = os.networkInterfaces();
    for (const addrs of Object.values(ifaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          serverIp = addr.address;
          break;
        }
      }
      if (serverIp) break;
    }
  }

  async function checkDomain(domain: string): Promise<{ ok: boolean; resolvedIp: string | null }> {
    return new Promise((resolve) => {
      dns.resolve4(domain, (err, addresses) => {
        if (err || !addresses?.length) {
          resolve({ ok: false, resolvedIp: null });
          return;
        }
        const ip = addresses[0];
        resolve({ ok: ip === serverIp, resolvedIp: ip });
      });
    });
  }

  const [appResult, mqttResult] = await Promise.all([
    checkDomain('app.lfibot.com'),
    checkDomain('mqtt.lfibot.com'),
  ]);

  // Check if any connected mower has custom firmware (version contains "custom")
  const mowerRow = db.prepare(`
    SELECT mower_version FROM equipment WHERE mower_sn LIKE 'LFIN%' LIMIT 1
  `).get() as { mower_version?: string } | undefined;

  const hasCustomFirmware = !!(mowerRow?.mower_version && mowerRow.mower_version.includes('custom'));

  // Check if a mower is currently connected (seen in last 5 minutes)
  const mowerConnected = !!(db.prepare(`
    SELECT 1 FROM device_registry
    WHERE sn LIKE 'LFIN%' AND datetime(last_seen) > datetime('now', '-5 minutes')
    LIMIT 1
  `).get());

  res.json({
    serverIp,
    app: appResult,
    mqtt: mqttResult,
    hasCustomFirmware,
    mowerConnected,
  });
});

// ── GET /health — replaced by version below with devicesConnected ────────────

// ── WiFi switch (RPi only) ──────────────────────────────────────────────────

setupRouter.post('/switch-wifi', async (req: Request, res: Response) => {
  const { mode, ssid, password } = req.body as { mode?: string; ssid?: string; password?: string };
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  try {
    if (mode === 'ap') {
      // Switch to AP mode
      await execAsync('sudo /opt/opennovabot/wifi-switch.sh ap');
      res.json({ ok: true, mode: 'ap', ip: '192.168.4.1' });
    } else if (mode === 'home' || ssid) {
      // Switch to home WiFi
      if (ssid) {
        // Configure new WiFi network first
        await execAsync(`sudo nmcli device wifi connect "${ssid}" password "${password}" 2>/dev/null || sudo nmcli connection up netplan-wlan0-${ssid} 2>/dev/null`).catch(() => {});
      }
      await execAsync('sudo /opt/opennovabot/wifi-switch.sh home');
      res.json({ ok: true, mode: 'home' });
    } else {
      // Status
      const { stdout } = await execAsync('sudo /opt/opennovabot/wifi-switch.sh status');
      res.json({ ok: true, status: stdout.trim() });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.json({ ok: false, error: msg });
  }
});

// ── GET /factory-lookup — lookup MAC from factory DB (no auth/setup needed) ──

setupRouter.get('/factory-lookup', (req: Request, res: Response) => {
  const sn = (req.query.sn as string || '').trim().toUpperCase();
  if (!sn) { res.json({ mac: null, error: 'sn required' }); return; }
  const row = db.prepare('SELECT mac_address FROM device_factory WHERE sn = ?').get(sn) as { mac_address: string } | undefined;
  res.json({ sn, mac: row?.mac_address || null });
});

// ── Device connection count (for MQTT polling) ─────────────────────────────

setupRouter.get('/health', async (_req: Request, res: Response) => {
  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  const equipCount = (db.prepare('SELECT COUNT(*) as count FROM equipment').get() as { count: number }).count;
  const deviceCount = (db.prepare('SELECT COUNT(*) as count FROM device_registry').get() as { count: number }).count;

  const recentDevice = db.prepare(`
    SELECT sn, last_seen FROM device_registry
    WHERE datetime(last_seen) > datetime('now', '-5 minutes')
    ORDER BY last_seen DESC LIMIT 1
  `).get() as { sn: string; last_seen: string } | undefined;

  const connectedCount = (db.prepare(`
    SELECT COUNT(DISTINCT sn) as count FROM device_registry
    WHERE sn IS NOT NULL AND datetime(last_seen) > datetime('now', '-1 minutes')
  `).get() as { count: number }).count;

  // Own IP
  const { networkInterfaces } = await import('os');
  let serverIp = '192.168.4.1';
  for (const addrs of Object.values(networkInterfaces())) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) { serverIp = addr.address; break; }
    }
    if (serverIp !== '192.168.4.1') break;
  }

  // DHCP leases — which devices are on the AP
  let apClients: string[] = [];
  try {
    const { readFileSync } = await import('fs');
    const leases = readFileSync('/var/lib/misc/dnsmasq.leases', 'utf8');
    apClients = leases.trim().split('\n').filter(Boolean).map(l => {
      const [, mac, ip, host] = l.split(' ');
      return `${mac} ${ip}${host && host !== '*' ? ' ('+host+')' : ''}`;
    });
  } catch { /* not RPi or no leases yet */ }

  res.json({
    server: 'running',
    mqtt: 'running',
    serverIp,
    apClients,
    users: userCount,
    equipment: equipCount,
    devicesConnected: connectedCount,
    devicesEverConnected: deviceCount,
    lastDeviceOnline: recentDevice ?? null,
    setupComplete: isSetupComplete(),
  });
});
