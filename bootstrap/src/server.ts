import express from 'express';
import http from 'http';
import https from 'https';
import path from 'path';
import os from 'os';
import fs from 'fs';
import dns from 'dns';
import net from 'net';
import crypto from 'crypto';
import { Server as IOServer } from 'socket.io';
import { Client as SSHClient } from 'ssh2';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const multicastDns = require('multicast-dns');
import multer from 'multer';
import { startBroker, publishToMower, getConnectedMower, getMowerVersion, getIsCustomFirmware, isClientMode, onMowerDisconnect, onMowerReconnect, switchToClientMode } from './broker.js';
import { encryptForDevice, md5 } from './crypto.js';
import { getDockerStatus, pullImage, startContainer, removeContainer, checkHealth } from './docker.js';
import { getBleStatus, scanDevices, stopScan, provisionDevice } from './ble.js';

// ── LFI Cloud API helpers ─────────────────────────────────────────────────────
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
  const sig = crypto.createHash('sha256').update(echostr + nonce + ts + token, 'utf8').digest('hex');
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

function callLfiCloud(method: string, urlPath: string, body: Record<string, unknown> | null, token = ''): Promise<Record<string, unknown>> {
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
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as Record<string, unknown>);
        } catch {
          reject(new Error(`Cloud API returned invalid JSON: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Cloud API timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Wizard files are inlined at build time by scripts/generate-wizard-bundle.mjs
// This avoids all pkg snapshot path resolution issues.
// The import will be {} if the file doesn't exist yet (first run before build).
let wizardFiles: Record<string, Buffer> = {};
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bundle = require('./wizard-bundle.js') as { wizardFiles: Record<string, Buffer> };
  wizardFiles = bundle.wizardFiles;
} catch {
  // Not yet built — will show fallback message
}

// Temp dir for uploaded firmware files
const FIRMWARE_TMP = path.join(os.tmpdir(), 'novabot-bootstrap');
fs.mkdirSync(FIRMWARE_TMP, { recursive: true });

// Currently loaded firmware
let activeFirmware: { name: string; path: string; size: number; version: string } | null = null;

// Selected network IP (set by user in wizard)
let selectedIp: string | null = null;

// mDNS responder: advertises opennovabot.local → selectedIp
let mdnsInstance: ReturnType<typeof multicastDns> | null = null;

function startMdns(ip: string): void {
  if (mdnsInstance) mdnsInstance.destroy();
  try {
    mdnsInstance = multicastDns({ reuseAddr: true });
    mdnsInstance.on('query', (query: { questions: Array<{ name: string; type: string }> }) => {
      const match = query.questions.some(
        (q: { name: string; type: string }) =>
          q.name === 'opennovabot.local' && (q.type === 'A' || q.type === 'ANY')
      );
      if (match) {
        mdnsInstance!.respond({
          answers: [{ name: 'opennovabot.local', type: 'A', ttl: 120, data: ip }],
        });
      }
    });
    mdnsInstance.on('error', (err: Error) => {
      console.warn(`[mDNS] Fout: ${err.message}`);
    });
    console.log(`[mDNS] Adverteert opennovabot.local → ${ip}`);
  } catch (err) {
    console.warn(`[mDNS] Kon niet starten: ${err}`);
  }
}

// Multer storage: save uploaded firmware to temp dir
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, FIRMWARE_TMP),
  filename: (_req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB max

function extractVersion(filename: string): string {
  const match = filename.match(/v[\d.]+-[\w-]+/);
  return match ? match[0] : 'unknown';
}

function getNetworkInterfaces(): Array<{ name: string; ip: string }> {
  const result: Array<{ name: string; ip: string }> = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        result.push({ name, ip: addr.address });
      }
    }
  }
  return result;
}


export function createServer(): http.Server {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new IOServer(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  app.use(express.json());

  // Start MQTT broker (passes io for real-time events)
  startBroker(io);

  // ── OTA state + SSH recovery ───────────────────────────────────────────────
  let otaInProgress = false;
  let otaMowerIp: string | null = null;      // Captured from firmware download or MQTT connect
  let otaTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  function clearOtaTimers(): void {
    if (otaTimeoutTimer) { clearTimeout(otaTimeoutTimer); otaTimeoutTimer = null; }
  }

  /** TCP check if SSH port 22 is reachable */
  function isSshReachable(ip: string): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(4000);
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
      sock.on('error', () => { sock.destroy(); resolve(false); });
      sock.connect(22, ip);
    });
  }

  /** SSH into mower and execute a command. Returns stdout or null on failure. */
  function sshExec(ip: string, cmd: string): Promise<string | null> {
    return new Promise((resolve) => {
      const conn = new SSHClient();
      const timeout = setTimeout(() => { conn.end(); resolve(null); }, 15000);

      conn.on('ready', () => {
        conn.exec(cmd, (err, stream) => {
          if (err) { clearTimeout(timeout); conn.end(); resolve(null); return; }
          let output = '';
          stream.on('data', (data: Buffer) => { output += data.toString(); });
          stream.stderr.on('data', (data: Buffer) => { output += data.toString(); });
          stream.on('close', () => {
            clearTimeout(timeout);
            conn.end();
            resolve(output);
          });
        });
      });

      conn.on('error', () => { clearTimeout(timeout); resolve(null); });

      conn.connect({
        host: ip,
        port: 22,
        username: 'root',
        password: 'novabot',
        readyTimeout: 10000,
        algorithms: { serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'] },
      });
    });
  }

  /**
   * SSH recovery after OTA — two phases:
   *
   * Phase 1: Mower is stuck mid-reboot → force hard kernel reboot via sysrq
   *          (the stock `reboot` command on Horizon X3 often hangs)
   *
   * Phase 2: After hard reboot, if MQTT still not connected → restart mqtt_node
   */
  async function sshRecoveryLoop(ip: string): Promise<void> {
    const PROBE_INTERVAL = 20_000;   // Check SSH every 20s
    const PHASE1_DELAY = 3 * 60_000; // Start phase 1 after 3 min
    const PHASE2_DELAY = 3 * 60_000; // Start phase 2 after another 3 min post-reboot

    // ── Phase 1: wait, then try hard reboot ──────────────────────────────
    io.emit('ota-log', { message: 'Waiting 3 minutes for normal reboot...' });
    await new Promise(r => setTimeout(r, PHASE1_DELAY));
    if (!otaInProgress) return;

    io.emit('ota-log', { message: `Mower not back — probing SSH on ${ip}...` });
    io.emit('ota-ssh-recovery', { active: true });

    // Probe SSH until reachable (max ~5 min)
    let sshOk = false;
    for (let i = 0; i < 15; i++) {
      if (!otaInProgress) return;
      const reachable = await isSshReachable(ip);
      if (reachable) { sshOk = true; break; }
      console.log(`[OTA-SSH] Probe ${i + 1}/15 — port 22 not reachable`);
      await new Promise(r => setTimeout(r, PROBE_INTERVAL));
    }

    if (!otaInProgress) return;

    if (sshOk) {
      io.emit('ota-log', { message: `SSH reachable — mower is stuck mid-reboot. Forcing hard reboot...` });

      // Force kernel-level reboot (bypasses hanging shutdown scripts)
      const result = await sshExec(ip, 'sync; echo 1 > /proc/sys/kernel/sysrq; echo b > /proc/sysrq-trigger');
      // sysrq-trigger causes immediate reboot, so SSH will disconnect (result may be null)
      io.emit('ota-log', { message: 'Hard reboot triggered — waiting for mower to come back...' });

      // Wait for mower to go down and come back up
      await new Promise(r => setTimeout(r, 30_000));
    } else {
      io.emit('ota-log', { message: 'SSH not reachable — mower may have rebooted normally. Waiting...' });
    }

    if (!otaInProgress) return;

    // ── Phase 2: wait for mower to boot, then fix MQTT if needed ─────────
    io.emit('ota-log', { message: 'Waiting for mower to finish booting...' });
    await new Promise(r => setTimeout(r, PHASE2_DELAY));
    if (!otaInProgress) return;

    // Probe SSH again
    sshOk = false;
    for (let i = 0; i < 10; i++) {
      if (!otaInProgress) return;
      const reachable = await isSshReachable(ip);
      if (reachable) { sshOk = true; break; }
      console.log(`[OTA-SSH] Phase 2 probe ${i + 1}/10 — port 22 not reachable`);
      await new Promise(r => setTimeout(r, PROBE_INTERVAL));
    }

    if (!otaInProgress) return;

    if (sshOk) {
      io.emit('ota-log', { message: 'SSH connected — checking if mqtt_node is running...' });

      const check = await sshExec(ip, 'pgrep -c mqtt_node 2>/dev/null || echo 0');
      const mqttRunning = check !== null && !check.trim().startsWith('0');

      if (mqttRunning) {
        io.emit('ota-log', { message: 'mqtt_node running but no MQTT connection — restarting...' });
        await sshExec(ip, 'killall -9 mqtt_node 2>/dev/null');
        io.emit('ota-log', { message: 'mqtt_node killed — daemon_node will restart it. Waiting...' });
      } else {
        io.emit('ota-log', { message: 'mqtt_node not running — starting services...' });
        await sshExec(ip, '/root/novabot/scripts/run_novabot.sh start 2>/dev/null &');
        io.emit('ota-log', { message: 'Services started — waiting for MQTT connection...' });
      }

      // Final wait for MQTT reconnect
      await new Promise(r => setTimeout(r, 60_000));
      if (!otaInProgress) return;

      // Last resort: try once more
      if (otaInProgress) {
        io.emit('ota-log', { message: 'Still no MQTT — last attempt: restarting run_novabot.sh...' });
        await sshExec(ip, '/root/novabot/scripts/run_novabot.sh stop 2>/dev/null; sleep 3; /root/novabot/scripts/run_novabot.sh start 2>/dev/null &');
        io.emit('ota-log', { message: 'Waiting for MQTT reconnect...' });
      }
    } else {
      io.emit('ota-log', { message: 'SSH not reachable after reboot — mower may need manual power cycle.' });
    }
  }

  // When mower disconnects post-OTA → start SSH recovery
  onMowerDisconnect((mower) => {
    if (!otaInProgress) return;
    const mowerIp = mower.ip ?? otaMowerIp;
    console.log(`[OTA] Mower ${mower.sn} disconnected — reboot detected (IP: ${mowerIp})`);
    io.emit('mower-rebooting', { sn: mower.sn });
    io.emit('ota-log', { message: 'Mower disconnected — reboot detected!' });
    io.emit('ota-log', { message: 'Waiting for mower to reconnect via MQTT...' });

    clearOtaTimers();

    // Absolute timeout: 30 minutes
    otaTimeoutTimer = setTimeout(() => {
      if (!otaInProgress) return;
      clearOtaTimers();
      io.emit('ota-log', { message: 'Timeout: mower did not reconnect after 30 minutes.' });
      io.emit('ota-timeout');
    }, 30 * 60 * 1000);

    // Start SSH recovery loop (async, self-contained)
    if (mowerIp) {
      sshRecoveryLoop(mowerIp).catch(err => {
        console.error(`[OTA-SSH] Recovery loop error:`, err);
        io.emit('ota-log', { message: `SSH recovery error: ${err.message}` });
      });
    }
  });

  // When mower reconnects after OTA reboot → OTA complete
  onMowerReconnect((mower) => {
    if (!otaInProgress) return;
    otaInProgress = false;
    clearOtaTimers();
    console.log(`[OTA] Mower ${mower.sn} reconnected — OTA complete!`);
    io.emit('ota-log', { message: `Mower ${mower.sn} reconnected — firmware installed successfully!` });
    io.emit('ota-ssh-recovery', { active: false });
    // Link to Docker dashboard (selectedIp) instead of mower server
    const dashboardUrl = selectedIp ? `http://${selectedIp}` : null;
    io.emit('server-detected', { url: dashboardUrl });
  });

  // ── Static: wizard frontend (served from in-memory bundle) ───────────────
  // Files are inlined at build time by scripts/generate-wizard-bundle.mjs
  // so no filesystem access is needed at runtime (works inside pkg binary).
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };

  if (wizardFiles['index.html']) {
    app.get('/assets/:file', (req, res) => {
      const buf = wizardFiles[`assets/${path.basename(req.params.file)}`];
      if (!buf) { res.status(404).end(); return; }
      const ext = path.extname(req.params.file);
      res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
      res.send(buf);
    });
    // Serve root-level static files (e.g. OpenNova.png from wizard/public/)
    app.get('/:file([^/]+\\.[^/]+)', (req, res) => {
      const key = req.params.file;
      const buf = wizardFiles[key];
      if (!buf) { res.status(404).end(); return; }
      const ext = path.extname(key);
      res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
      res.send(buf);
    });
    app.get('/', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(wizardFiles['index.html']);
    });
  } else {
    app.get('/', (_req, res) =>
      res.send('<h1>Build the wizard: npm run build (in bootstrap/)</h1>')
    );
  }

  // ── Firmware download (mower downloads from here) ─────────────────────────
  app.get('/firmware/:filename', (req, res) => {
    const filename = path.basename(req.params.filename);
    const filepath = path.join(FIRMWARE_TMP, filename);
    if (!fs.existsSync(filepath)) {
      res.status(404).json({ error: 'Firmware not found' });
      return;
    }

    // Capture mower IP from download request (most reliable source)
    const reqIp = (req.socket.remoteAddress ?? '').replace('::ffff:', '');
    if (reqIp && reqIp !== '127.0.0.1') {
      otaMowerIp = reqIp;
      console.log(`[OTA] Mower IP captured from firmware download: ${reqIp}`);
    }

    const stat = fs.statSync(filepath);
    const totalBytes = stat.size;
    let sentBytes = 0;
    let lastEmitAt = 0;

    res.setHeader('Content-Length', totalBytes);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const fileStream = fs.createReadStream(filepath);

    fileStream.on('data', (chunk: Buffer | string) => {
      sentBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      const now = Date.now();
      if (now - lastEmitAt > 400 || sentBytes === totalBytes) {
        lastEmitAt = now;
        const percent = Math.min(100, Math.round((sentBytes / totalBytes) * 100));
        io.emit('ota-download-progress', { sentBytes, totalBytes, percent });
      }
    });

    fileStream.on('end', () => {
      io.emit('ota-download-progress', { sentBytes: totalBytes, totalBytes, percent: 100 });
      const mb = (totalBytes / 1024 / 1024).toFixed(1);
      io.emit('ota-log', { message: `Firmware download complete (${mb} MB) — mower installing...` });
    });

    fileStream.pipe(res);
  });

  // ── API: detect existing infrastructure ──────────────────────────────────
  app.get('/api/detect', (_req, res) => {
    // Check if DNS for mqtt.lfibot.com points to a local IP
    dns.lookup('mqtt.lfibot.com', (err, address) => {
      const isLocalIp = (ip: string) =>
        ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.') || ip === '127.0.0.1';
      const dnsRedirected = !err && isLocalIp(address);

      res.json({
        mqtt: { clientMode: isClientMode() },
        dns: { redirected: dnsRedirected, address: err ? null : address },
      });
    });
  });

  // ── API: network interfaces ───────────────────────────────────────────────
  app.get('/api/network', (_req, res) => {
    res.json(getNetworkInterfaces());
  });

  // ── API: firmware upload ──────────────────────────────────────────────────
  // Wrap multer in a callback so errors are returned as JSON (not HTML)
  app.post('/api/firmware', (req, res) => {
    upload.single('firmware')(req, res, (err: unknown) => {
      if (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Bootstrap] Upload error:', msg);
        res.status(400).json({ error: msg });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }
      const { filename, path: filePath, size } = req.file;
      const version = extractVersion(filename);

      activeFirmware = { name: filename, path: filePath, size, version };
      console.log(`[Bootstrap] Firmware uploaded: ${filename} (${(size / 1024 / 1024).toFixed(1)} MB, ${version})`);

      res.json({ ok: true, name: filename, size, version });
    });
  });

  // ── API: set selected IP ──────────────────────────────────────────────────
  app.post('/api/network/select', (req, res) => {
    const { ip } = req.body as { ip: string };
    if (!ip) { res.status(400).json({ error: 'ip required' }); return; }
    selectedIp = ip;
    startMdns(ip);
    console.log(`[Bootstrap] Selected network IP: ${ip}`);
    res.json({ ok: true });
  });

  // ── API: Docker status ──────────────────────────────────────────────────
  app.get('/api/docker/status', (_req, res) => {
    try {
      const status = getDockerStatus();
      res.json(status);
    } catch (err) {
      res.json({
        dockerInstalled: false, dockerRunning: false,
        containerExists: false, containerRunning: false,
        containerImage: null, containerTargetIp: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── API: Docker pull image ─────────────────────────────────────────────
  app.post('/api/docker/pull', async (_req, res) => {
    try {
      const ok = await pullImage(io);
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── API: Docker start container ────────────────────────────────────────
  app.post('/api/docker/start', async (req, res) => {
    const { ip, recreate } = req.body as { ip?: string; recreate?: boolean };
    const targetIp = ip || selectedIp;
    if (!targetIp) { res.status(400).json({ error: 'Geen IP geselecteerd' }); return; }

    try {
      // Check if container is already running
      const status = getDockerStatus();
      if (status.containerRunning && !recreate) {
        console.log('[Docker] Container already running — skipping start');
        switchToClientMode(io, targetIp);
        res.json({ ok: true, targetIp, reused: true });
        return;
      }

      if (recreate || status.containerExists) {
        io.emit('docker-status', { phase: 'removing', message: 'Bestaande container verwijderen...' });
        removeContainer();
      }

      const ok = await startContainer(targetIp, io);
      if (!ok) { res.status(500).json({ error: 'Container starten mislukt' }); return; }

      // Wait briefly for container to initialize, then switch broker to client mode
      setTimeout(() => {
        switchToClientMode(io, targetIp);
      }, 3000);

      res.json({ ok: true, targetIp });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── API: Docker health check ───────────────────────────────────────────
  app.get('/api/docker/health', async (_req, res) => {
    const targetIp = selectedIp;
    if (!targetIp) { res.status(400).json({ error: 'Geen IP geselecteerd' }); return; }
    try {
      const health = await checkHealth(targetIp);
      res.json(health);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── API: status ───────────────────────────────────────────────────────────
  app.get('/api/status', (_req, res) => {
    res.json({
      firmware: activeFirmware ? { name: activeFirmware.name, version: activeFirmware.version, size: activeFirmware.size } : null,
      selectedIp,
      mower: getConnectedMower(),
      mowerVersion: getMowerVersion(),
      isCustomFirmware: getIsCustomFirmware(),
    });
  });

  // ── API: BLE status ─────────────────────────────────────────────────────
  app.get('/api/ble/status', async (_req, res) => {
    try {
      const status = await getBleStatus();
      res.json(status);
    } catch (err) {
      res.json({ available: false, state: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── API: BLE scan ──────────────────────────────────────────────────────
  app.post('/api/ble/scan', async (req, res) => {
    const { duration } = req.body as { duration?: number };
    try {
      await scanDevices(io, duration);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── API: BLE stop scan ────────────────────────────────────────────────
  app.post('/api/ble/stop-scan', async (_req, res) => {
    try {
      await stopScan();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── API: BLE provision ────────────────────────────────────────────────
  app.post('/api/ble/provision', async (req, res) => {
    const { mac, wifiSsid, wifiPassword, deviceType } = req.body as {
      mac?: string;
      wifiSsid?: string;
      wifiPassword?: string;
      deviceType?: 'mower' | 'charger';
    };
    if (!mac || !wifiSsid || !wifiPassword || !deviceType) {
      res.status(400).json({ error: 'mac, wifiSsid, wifiPassword, deviceType required' });
      return;
    }
    // Use relay hostname if provided, otherwise fall back to local IP
    const { mqttHost, mqttPort: reqMqttPort } = req.body as { mqttHost?: string; mqttPort?: number };
    const mqttAddr = mqttHost || 'mqtt.lfibot.com';
    const mqttPort = reqMqttPort || 1883;
    if (!mqttAddr) {
      res.status(400).json({ error: 'No network IP selected (select IP in network step first)' });
      return;
    }
    try {
      const ok = await provisionDevice({
        targetMac: mac,
        wifiSsid,
        wifiPassword,
        mqttAddr,
        mqttPort,
        deviceType,
      }, io);
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── API: OTA trigger ──────────────────────────────────────────────────────
  app.post('/api/ota/trigger', async (req, res) => {
    const mower = getConnectedMower();
    if (!mower) { res.status(400).json({ error: 'Geen maaier verbonden' }); return; }
    if (!activeFirmware) { res.status(400).json({ error: 'Geen firmware geselecteerd' }); return; }
    if (!selectedIp) { res.status(400).json({ error: 'Geen netwerk IP geselecteerd' }); return; }

    const { sn, ip: mowerIp } = mower;
    const { name, path: firmwarePath, version } = activeFirmware;

    console.log(`[OTA] Triggering OTA: SN=${sn}, firmware=${name}`);

    // Calculate MD5
    const fileBuffer = fs.readFileSync(firmwarePath);
    const firmwareMd5 = md5(fileBuffer);

    // Download URL: bootstrap HTTP server serves the file on port 7789
    const downloadUrl = `http://${selectedIp}:7789/firmware/${name}`;

    // Build OTA command (exact payload — NEVER change this structure)
    const command = {
      ota_upgrade_cmd: {
        cmd: 'upgrade',   // REQUIRED: mqtt_node ignores without this
        type: 'full',     // REQUIRED: 'increment' doesn't download
        content: 'app',   // REQUIRED: mqtt_node ignores without this
        url: downloadUrl,
        version,
        md5: firmwareMd5,
      },
    };

    // Encrypt and publish
    const encrypted = encryptForDevice(sn, command);
    publishToMower(sn, encrypted);

    io.emit('ota-log', { message: `OTA command sent to ${sn}` });
    io.emit('ota-log', { message: `Download URL: ${downloadUrl}` });
    io.emit('ota-log', { message: `Version: ${version} | MD5: ${firmwareMd5}` });
    io.emit('ota-log', { message: 'Mower downloading firmware... (this takes 10–20 minutes)' });
    io.emit('ota-started', { sn, version });

    // Mark OTA in progress so the disconnect/reconnect callbacks fire
    otaInProgress = true;
    // Capture mower IP from MQTT connection for SSH recovery
    const connectedMower = getConnectedMower();
    if (connectedMower?.ip) otaMowerIp = connectedMower.ip;

    res.json({ ok: true, sn, version, downloadUrl, md5: firmwareMd5 });
  });

  io.on('connection', (socket) => {
    console.log('[WS] Wizard client connected');
    // Re-emit current state if already detected (handles page refresh)
    const v = getMowerVersion();
    if (v) socket.emit('mower-version', { version: v });
    const isCustom = getIsCustomFirmware();
    if (isCustom !== null) socket.emit('mower-firmware-type', { isCustom });
  });

  // ── API: Check existing account in Docker container DB ────────────────────
  app.get('/api/existing-account', async (_req, res) => {
    // Approach 1: Try the API endpoint (works after container rebuild)
    const candidates = selectedIp
      ? [`http://${selectedIp}`, 'http://localhost:3000']
      : ['http://localhost:3000'];

    for (const base of candidates) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`${base}/api/dashboard/admin/accounts`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const data = await response.json() as { hasAccount?: boolean };
        if (data.hasAccount !== undefined) {
          res.json(data);
          return;
        }
      } catch {
        // try next candidate
      }
    }

    // Approach 2: Fallback — query Docker DB directly via docker exec
    try {
      const { execSync } = await import('child_process');
      const script = [
        `const Database = require('better-sqlite3');`,
        `const db = new Database(process.env.DB_PATH || './novabot.db');`,
        `const user = db.prepare('SELECT app_user_id, email, username FROM users LIMIT 1').get();`,
        `if (!user) { console.log(JSON.stringify({hasAccount:false})); process.exit(); }`,
        `const eq = db.prepare('SELECT mower_sn, charger_sn, mower_version, charger_version FROM equipment WHERE user_id = ?').all(user.app_user_id);`,
        `const devices = []; const seen = new Set();`,
        `for (const e of eq) {`,
        `  if (e.charger_sn && e.charger_sn.startsWith('LFIC') && !seen.has(e.charger_sn)) { seen.add(e.charger_sn); devices.push({type:'charger',sn:e.charger_sn,version:e.charger_version||undefined}); }`,
        `  if (e.mower_sn && e.mower_sn.startsWith('LFIN') && !seen.has(e.mower_sn)) { seen.add(e.mower_sn); devices.push({type:'mower',sn:e.mower_sn,version:e.mower_version||undefined}); }`,
        `}`,
        `console.log(JSON.stringify({hasAccount:true,email:user.email,username:user.username,devices}));`,
      ].join(' ');
      const result = execSync(`docker exec -w /app/novabot-server opennova node -e "${script.replace(/"/g, '\\"')}"`, {
        encoding: 'utf8',
        timeout: 10000,
      });
      const parsed = JSON.parse(result.trim());
      res.json(parsed);
      return;
    } catch (err) {
      console.warn('[existing-account] docker exec fallback failed:', err instanceof Error ? err.message : err);
    }

    res.json({ hasAccount: false });
  });

  // ── API: LFI Cloud import — stap 1: login + ophalen apparaten ─────────────
  app.post('/api/cloud-import', async (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      res.status(400).json({ error: 'email en password zijn verplicht' });
      return;
    }

    try {
      // Versleutel wachtwoord voor LFI cloud (AES-128-CBC, key/IV = "1234123412ABCDEF")
      const encryptedPw = encryptCloudPassword(password);

      // Stap 1: Login bij LFI cloud
      const loginResp = await callLfiCloud('POST', '/api/nova-user/appUser/login', {
        email, password: encryptedPw, imei: 'imei',
      });

      const loginVal = (loginResp as Record<string, unknown>).value as Record<string, unknown> | undefined;
      if (!loginResp || !(loginResp as Record<string, boolean>).success || !loginVal?.accessToken) {
        const msg = (loginResp as Record<string, string>).message ?? 'Inloggen mislukt';
        res.status(401).json({ error: `Cloud login mislukt: ${msg}` });
        return;
      }

      const accessToken = loginVal.accessToken as string;
      const appUserId = loginVal.appUserId as number;

      // Stap 2: Haal apparaten op
      const equipResp = await callLfiCloud('POST', '/api/nova-user/equipment/userEquipmentList', {
        appUserId, pageSize: 10, pageNo: 1,
      }, accessToken);

      const equipVal = (equipResp as Record<string, unknown>).value as Record<string, unknown> | undefined;
      const pageList = (equipVal?.pageList ?? []) as Record<string, unknown>[];

      // Zoek charger + mower entries in de lijst
      // Cloud kan ofwel separate entries sturen (één per device) ofwel gecombineerde entries
      const chargers = pageList.filter(e => {
        const sn = String(e.chargerSn ?? e.sn ?? '');
        return sn.startsWith('LFIC');
      });
      const mowers = pageList.filter(e => {
        const sn = String(e.mowerSn ?? e.sn ?? '');
        return sn.startsWith('LFIN');
      });

      // Stel ook de email in zodat de wizard het kan tonen
      res.json({
        ok: true,
        email,
        appUserId,
        chargers,
        mowers,
        rawList: pageList,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[cloud-import] Fout:', msg);
      res.status(500).json({ error: msg });
    }
  });

  // ── API: LFI Cloud import — stap 2: importeer in Docker container ──────────
  app.post('/api/cloud-import/apply', async (req, res) => {
    const { email, password, deviceName, charger, mower } = req.body as {
      email?: string;
      password?: string;
      deviceName?: string;
      charger?: { sn: string; address?: number; channel?: number; mac?: string };
      mower?: { sn: string; mac?: string; version?: string };
    };

    if (!email || !password || !charger?.sn) {
      res.status(400).json({ error: 'email, password en charger.sn zijn verplicht' });
      return;
    }

    // Try Docker container first, fall back to local dev server (localhost:3000)
    const candidates = selectedIp
      ? [`http://${selectedIp}`, 'http://localhost:3000']
      : ['http://localhost:3000'];

    let lastError = '';
    for (const base of candidates) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(`${base}/api/dashboard/admin/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, deviceName, charger, mower }),
          signal: controller.signal,
        });

        clearTimeout(timeout);
        const data = await response.json() as Record<string, unknown>;
        res.json(data);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.warn(`[cloud-import/apply] ${base} niet bereikbaar: ${lastError}`);
      }
    }

    res.status(500).json({ error: `Server niet bereikbaar: ${lastError}` });
  });

  // ── Global error handler: always return JSON ──────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Bootstrap] Unhandled error:', err.message);
    res.status(500).json({ error: err.message });
  });

  return httpServer;
}
