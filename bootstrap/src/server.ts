import express from 'express';
import http from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';
import dns from 'dns';
import { Server as IOServer } from 'socket.io';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const multicastDns = require('multicast-dns');
import multer from 'multer';
import { startBroker, publishToMower, getConnectedMower, getMowerVersion, isClientMode, onMowerDisconnect, onMowerReconnect, switchToClientMode } from './broker.js';
import { encryptForDevice, md5 } from './crypto.js';
import { getDockerStatus, pullImage, startContainer, removeContainer, checkHealth } from './docker.js';

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

  // When mower disconnects post-OTA, it means it's rebooting
  let otaInProgress = false;
  onMowerDisconnect((mower) => {
    if (!otaInProgress) return;
    console.log(`[OTA] Mower ${mower.sn} disconnected — reboot detected`);
    io.emit('mower-rebooting', { sn: mower.sn });
    io.emit('ota-log', { message: 'Maaier is losgekoppeld — herstart gedetecteerd!' });
    io.emit('ota-log', { message: 'Wachten tot de maaier opnieuw verbindt via MQTT...' });
  });

  // When mower reconnects after OTA reboot, firmware is installed
  onMowerReconnect((mower) => {
    if (!otaInProgress) return;
    otaInProgress = false;
    console.log(`[OTA] Mower ${mower.sn} reconnected — OTA complete!`);
    io.emit('ota-log', { message: `Maaier ${mower.sn} is opnieuw verbonden — firmware succesvol geïnstalleerd!` });
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
      io.emit('ota-log', { message: `Firmware download klaar (${mb} MB) — maaier installeert...` });
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
    });
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

    io.emit('ota-log', { message: `OTA commando verzonden naar ${sn}` });
    io.emit('ota-log', { message: `Download URL: ${downloadUrl}` });
    io.emit('ota-log', { message: `Versie: ${version} | MD5: ${firmwareMd5}` });
    io.emit('ota-log', { message: 'Maaier downloadt firmware... (dit duurt 10–20 minuten)' });
    io.emit('ota-started', { sn, version });

    // Mark OTA in progress so the disconnect/reconnect callbacks fire
    otaInProgress = true;

    res.json({ ok: true, sn, version, downloadUrl, md5: firmwareMd5 });
  });

  io.on('connection', (socket) => {
    console.log('[WS] Wizard client connected');
    // Re-emit current version if already detected (handles page refresh)
    const v = getMowerVersion();
    if (v) socket.emit('mower-version', { version: v });
  });

  // ── Global error handler: always return JSON ──────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Bootstrap] Unhandled error:', err.message);
    res.status(500).json({ error: err.message });
  });

  return httpServer;
}
