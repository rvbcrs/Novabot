import express from 'express';
import https from 'https';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

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
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as Record<string, unknown>);
        } catch {
          reject(new Error(`Cloud API returned invalid JSON: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Cloud API timeout — the cloud may be offline')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function fetchPaginated(
  token: string,
  urlPath: string,
  params: Record<string, unknown>,
  listKey: string,
  loginFn: () => Promise<string>
): Promise<{ token: string; items: Record<string, unknown>[] }> {
  const all: Record<string, unknown>[] = [];
  let page = 1;
  let totalSize = 0;
  let currentToken = token;

  while (true) {
    const body = { ...params, pageNo: page };
    const resp = await callLfiCloud('POST', urlPath, body, currentToken);

    if ((resp as Record<string, number>).code === 1008) {
      currentToken = await loginFn();
      continue;
    }

    const val = resp.value as Record<string, unknown> | undefined;
    const list = val?.[listKey] as Record<string, unknown>[] | undefined;
    if (!resp.success || !list || list.length === 0) break;

    totalSize = (val?.totalSize as number) || 0;
    all.push(...list);

    if (all.length >= totalSize) break;
    page++;
    if (page > 200) break;
  }

  return { token: currentToken, items: all };
}

// ── Session-based export state ───────────────────────────────────────────────

interface ExportProgress {
  status: 'idle' | 'running' | 'done' | 'error';
  steps: { name: string; status: 'pending' | 'running' | 'done' | 'error'; count?: number }[];
  outputDir: string;
  error?: string;
  zipFile?: string;
  createdAt: number;
  summary?: {
    totalFiles: number;
    totalSize: number;
    devices: number;
    workRecords: number;
    messages: number;
  };
}

const sessions = new Map<string, ExportProgress>();

// Cleanup sessions older than 1 hour
const SESSION_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      // Remove temp dir
      if (session.outputDir && fs.existsSync(session.outputDir)) {
        try { fs.rmSync(session.outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// ── Wizard bundle (inlined at build time) ────────────────────────────────────
// In dev mode, we serve from wizard/dist/. In production (pkg), from the bundle.
let wizardFiles: Record<string, Buffer> = {};
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bundle = require('./wizard-bundle.js') as { wizardFiles: Record<string, Buffer> };
  wizardFiles = bundle.wizardFiles;
} catch {
  // Not yet built — will serve from filesystem or show fallback
}

// ── Express server ───────────────────────────────────────────────────────────

export function createServer(): express.Express {
  const app = express();
  app.use(express.json());

  // In development, Vite serves the wizard. In production, serve from bundle.
  const wizardDist = path.join(__dirname, '..', 'wizard', 'dist');
  if (!wizardFiles['index.html'] && fs.existsSync(wizardDist)) {
    app.use(express.static(wizardDist));
  }

  // ── GET /api/version ────────────────────────────────────────────────────
  // Version injected at build time by build:server script to avoid pkg snapshot issues
  const APP_VERSION = '__APP_VERSION__';
  app.get('/api/version', (_req, res) => {
    res.json({ version: APP_VERSION });
  });

  // ── POST /api/login ──────────────────────────────────────────────────────
  app.post('/api/login', async (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    try {
      const encryptedPw = encryptCloudPassword(password);
      const loginResp = await callLfiCloud('POST', '/api/nova-user/appUser/login', {
        email, password: encryptedPw, imei: 'imei',
      });

      const val = loginResp.value as Record<string, unknown> | undefined;
      if (!loginResp.success || !val?.accessToken) {
        const msg = (loginResp.message as string) ?? 'Login failed';
        res.status(401).json({ error: msg });
        return;
      }

      const accessToken = val.accessToken as string;
      const appUserId = val.appUserId as number;

      // Fetch user info (GET with query params)
      let userInfo: Record<string, unknown> = {};
      try {
        const infoResp = await callLfiCloud('GET', `/api/nova-user/appUser/appUserInfo?email=${encodeURIComponent(email)}`, null, accessToken);
        if (infoResp.success && infoResp.value) {
          userInfo = infoResp.value as Record<string, unknown>;
        }
      } catch { /* non-fatal */ }

      // Fetch device list
      const equipResp = await callLfiCloud('POST', '/api/nova-user/equipment/userEquipmentList', {
        appUserId, pageSize: 50, pageNo: 1,
      }, accessToken);

      const equipVal = equipResp.value as Record<string, unknown> | undefined;
      const pageList = (equipVal?.pageList ?? []) as Record<string, unknown>[];

      const chargers = pageList.filter(e => String(e.chargerSn ?? e.sn ?? '').startsWith('LFIC'));
      const mowers = pageList.filter(e => String(e.mowerSn ?? e.sn ?? '').startsWith('LFIN'));

      res.json({
        ok: true,
        accessToken,
        appUserId,
        email,
        userInfo: {
          firstName: userInfo.firstName ?? '',
          lastName: userInfo.lastName ?? '',
          country: userInfo.country ?? '',
          city: userInfo.city ?? '',
          registerTime: userInfo.registerTime ?? '',
        },
        devices: pageList,
        chargerCount: chargers.length,
        mowerCount: mowers.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('timeout') || msg.includes('ECONNREFUSED') || msg.includes('EHOSTUNREACH')) {
        res.status(503).json({ error: 'Cloud is unreachable. It may be offline.' });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  // ── POST /api/preview ────────────────────────────────────────────────────
  app.post('/api/preview', async (req, res) => {
    const { accessToken, appUserId, mowerSns } = req.body as {
      accessToken: string; appUserId: number; mowerSns: string[];
    };

    try {
      // Quick counts — just first page of each
      let workRecordCount = 0;
      let messageCount = 0;

      try {
        const workResp = await callLfiCloud('POST',
          '/api/novabot-message/message/queryCutGrassRecordPageByUserId',
          { appUserId, pageSize: 1, pageNo: 1, sn: mowerSns[0] ?? '' },
          accessToken
        );
        const wVal = workResp.value as Record<string, unknown> | undefined;
        workRecordCount = (wVal?.totalSize as number) || 0;
      } catch { /* non-fatal */ }

      try {
        const msgResp = await callLfiCloud('POST',
          '/api/novabot-message/message/queryRobotMsgPageByUserId',
          { appUserId, pageSize: 1, pageNo: 1 },
          accessToken
        );
        const mVal = msgResp.value as Record<string, unknown> | undefined;
        messageCount = (mVal?.totalSize as number) || 0;
      } catch { /* non-fatal */ }

      res.json({
        ok: true,
        workRecordCount,
        messageCount,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /api/export/status ───────────────────────────────────────────────
  app.get('/api/export/status', (req, res) => {
    const sessionId = req.query.session as string;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  });

  // ── POST /api/export ─────────────────────────────────────────────────────
  app.post('/api/export', async (req, res) => {
    const { accessToken, appUserId, email, password, devices, includeFirmware } = req.body as {
      accessToken: string;
      appUserId: number;
      email: string;
      password: string;
      devices: Record<string, unknown>[];
      includeFirmware?: boolean;
    };

    // Create unique session
    const sessionId = crypto.randomBytes(12).toString('hex');
    const outputDir = path.join(os.tmpdir(), `novabot-export-${sessionId}`);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(path.join(outputDir, 'devices'), { recursive: true });
    fs.mkdirSync(path.join(outputDir, 'maps'), { recursive: true });
    fs.mkdirSync(path.join(outputDir, 'schedules'), { recursive: true });
    if (includeFirmware) {
      fs.mkdirSync(path.join(outputDir, 'firmware'), { recursive: true });
    }

    const mowerSns = devices
      .map(d => String(d.mowerSn ?? d.sn ?? ''))
      .filter(sn => sn.startsWith('LFIN'));
    const allSns = devices
      .map(d => String(d.sn ?? d.chargerSn ?? d.mowerSn ?? ''))
      .filter(sn => sn.startsWith('LFI'));

    const progress: ExportProgress = {
      status: 'running',
      outputDir,
      createdAt: Date.now(),
      steps: [
        { name: 'account', status: 'pending' },
        { name: 'devices', status: 'pending' },
        { name: 'maps', status: 'pending' },
        { name: 'workRecords', status: 'pending' },
        { name: 'messages', status: 'pending' },
        { name: 'schedules', status: 'pending' },
        { name: 'firmware', status: 'pending' },
      ],
    };
    sessions.set(sessionId, progress);

    res.json({ ok: true, sessionId });

    // Re-login helper
    const loginFn = async (): Promise<string> => {
      const encPw = encryptCloudPassword(password);
      const resp = await callLfiCloud('POST', '/api/nova-user/appUser/login', {
        email, password: encPw, imei: 'imei',
      });
      const val = resp.value as Record<string, unknown>;
      return val.accessToken as string;
    };

    let token = accessToken;
    let totalFiles = 0;
    let totalSize = 0;
    let workRecordCount = 0;
    let messageCount = 0;

    const writeJson = (filePath: string, data: unknown) => {
      const content = JSON.stringify(data, null, 2);
      fs.writeFileSync(filePath, content);
      totalFiles++;
      totalSize += Buffer.byteLength(content);
    };

    const setStepStatus = (name: string, status: 'pending' | 'running' | 'done' | 'error', count?: number) => {
      const step = progress.steps.find(s => s.name === name);
      if (step) {
        step.status = status;
        if (count !== undefined) step.count = count;
      }
    };

    try {
      // 1. Account info (GET with query params)
      setStepStatus('account', 'running');
      try {
        const infoResp = await callLfiCloud('GET', `/api/nova-user/appUser/appUserInfo?email=${encodeURIComponent(email)}`, null, token);
        writeJson(path.join(outputDir, 'account.json'), infoResp.value ?? infoResp);
        setStepStatus('account', 'done');
      } catch {
        // Fallback: save what we have
        writeJson(path.join(outputDir, 'account.json'), { email, appUserId });
        setStepStatus('account', 'done');
      }

      // 2. Devices
      setStepStatus('devices', 'running');
      writeJson(path.join(outputDir, 'devices.json'), devices);
      for (const sn of allSns) {
        try {
          const detailResp = await callLfiCloud('POST', '/api/nova-user/equipment/getEquipmentBySN', {
            sn, appUserId,
          }, token);
          writeJson(path.join(outputDir, 'devices', `${sn}.json`), detailResp.value ?? detailResp);
        } catch { /* skip individual device errors */ }
      }
      setStepStatus('devices', 'done', allSns.length);

      // 3. Maps (per mower — GET with query params + download CSV files)
      setStepStatus('maps', 'running');
      let mapFileCount = 0;
      for (const sn of mowerSns) {
        try {
          const mapResp = await callLfiCloud('GET', `/api/nova-file-server/map/queryEquipmentMap?sn=${sn}&appUserId=${appUserId}`, null, token);
          const mapVal = (mapResp.value ?? mapResp) as Record<string, unknown>;
          writeJson(path.join(outputDir, 'maps', `${sn}.json`), mapVal);

          // Download CSV files referenced in the map data
          const mapData = mapVal.data as Record<string, unknown[]> | null;
          if (mapData) {
            const snMapDir = path.join(outputDir, 'maps', sn);
            fs.mkdirSync(snMapDir, { recursive: true });

            const downloadMapFile = async (item: Record<string, unknown>) => {
              const url = item.url as string;
              const fileName = item.fileName as string;
              if (!url || !fileName) return;
              try {
                await downloadFile(url, path.join(snMapDir, fileName), token);
                mapFileCount++;
                totalFiles++;
              } catch { /* skip failed CSV downloads */ }
            };

            const allItems = [
              ...((mapData.work ?? []) as Record<string, unknown>[]),
              ...((mapData.unicom ?? []) as Record<string, unknown>[]),
            ];
            for (const item of allItems) {
              await downloadMapFile(item);
              // Also download obstacle CSVs nested inside work items
              const obstacles = (item.obstacle ?? []) as Record<string, unknown>[];
              for (const obs of obstacles) {
                await downloadMapFile(obs);
              }
            }
          }
        } catch { /* non-fatal */ }
      }
      setStepStatus('maps', 'done', mapFileCount);

      // 4. Work records (paginated)
      setStepStatus('workRecords', 'running');
      for (const sn of mowerSns) {
        try {
          const result = await fetchPaginated(
            token,
            '/api/novabot-message/message/queryCutGrassRecordPageByUserId',
            { appUserId, pageSize: 50, sn },
            'pageList',
            loginFn,
          );
          token = result.token;
          workRecordCount += result.items.length;
          writeJson(path.join(outputDir, 'work-records.json'), {
            totalSize: result.items.length,
            records: result.items,
          });
        } catch { /* non-fatal */ }
      }
      setStepStatus('workRecords', 'done', workRecordCount);

      // 5. Messages (paginated)
      setStepStatus('messages', 'running');
      try {
        const result = await fetchPaginated(
          token,
          '/api/novabot-message/message/queryRobotMsgPageByUserId',
          { appUserId, pageSize: 50 },
          'pageList',
          loginFn,
        );
        token = result.token;
        messageCount = result.items.length;
        writeJson(path.join(outputDir, 'messages.json'), {
          totalSize: result.items.length,
          messages: result.items,
        });
      } catch { /* non-fatal */ }
      setStepStatus('messages', 'done', messageCount);

      // 6. Schedules (per mower)
      setStepStatus('schedules', 'running');
      for (const sn of mowerSns) {
        try {
          const schedResp = await callLfiCloud('POST',
            '/api/nova-data/cutGrassPlan/queryRecentCutGrassPlan',
            { sn, appUserId }, token
          );
          writeJson(path.join(outputDir, 'schedules', `${sn}.json`), schedResp.value ?? schedResp);
        } catch { /* non-fatal */ }
      }
      setStepStatus('schedules', 'done');

      // 7. Firmware versions
      setStepStatus('firmware', 'running');
      const firmwareInfo: Record<string, unknown> = { charger: [], mower: [] };
      const chargerVersions = ['v0.0.0', 'v0.3.6', 'v0.4.0'];
      const mowerVersions = ['v0.0.0', 'v5.7.1', 'v6.0.0', 'v6.0.2'];

      for (const ver of chargerVersions) {
        try {
          const r = await callLfiCloud('GET',
            `/api/nova-user/otaUpgrade/checkOtaNewVersion?version=${ver}&upgradeType=serviceUpgrade&equipmentType=LFIC1&sn=SCAN`,
            null, token
          );
          if (r.value && (r.value as Record<string, unknown>).version) {
            (firmwareInfo.charger as unknown[]).push(r.value);
          }
        } catch { /* skip */ }
      }
      for (const ver of mowerVersions) {
        try {
          const r = await callLfiCloud('GET',
            `/api/nova-user/otaUpgrade/checkOtaNewVersion?version=${ver}&upgradeType=serviceUpgrade&equipmentType=LFIN2&sn=SCAN`,
            null, token
          );
          if (r.value && (r.value as Record<string, unknown>).version) {
            (firmwareInfo.mower as unknown[]).push(r.value);
          }
        } catch { /* skip */ }
      }
      writeJson(path.join(outputDir, 'firmware.json'), firmwareInfo);

      // Download firmware binaries if requested
      if (includeFirmware) {
        const allFirmware = [
          ...((firmwareInfo.charger as Record<string, unknown>[]) || []),
          ...((firmwareInfo.mower as Record<string, unknown>[]) || []),
        ];
        for (const fw of allFirmware) {
          const downloadUrl = fw.downloadUrl as string;
          if (downloadUrl) {
            const filename = path.basename(new URL(downloadUrl).pathname);
            const filePath = path.join(outputDir, 'firmware', filename);
            if (!fs.existsSync(filePath)) {
              try {
                await downloadFile(downloadUrl, filePath);
                totalFiles++;
                totalSize += fs.statSync(filePath).size;
              } catch { /* skip failed downloads */ }
            }
          }
        }
      }
      setStepStatus('firmware', 'done');

      // Export summary
      writeJson(path.join(outputDir, 'export-summary.json'), {
        exportDate: new Date().toISOString(),
        email,
        appUserId,
        deviceCount: allSns.length,
        mowerCount: mowerSns.length,
        workRecordCount,
        messageCount,
        totalFiles,
        totalSizeBytes: totalSize,
      });

      // Create ZIP of all exported data
      const zipPath = path.join(outputDir, 'novabot-export.zip');
      try {
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        const filesToZip = fs.readdirSync(outputDir)
          .filter(f => f !== 'novabot-export.zip' && f !== '.DS_Store')
          .map(f => `"${f}"`)
          .join(' ');

        if (os.platform() === 'win32') {
          // Windows: use PowerShell Compress-Archive
          const items = fs.readdirSync(outputDir)
            .filter(f => f !== 'novabot-export.zip' && f !== '.DS_Store')
            .map(f => `'${path.join(outputDir, f)}'`)
            .join(',');
          execSync(`powershell -NoProfile -Command "Compress-Archive -Path ${items} -DestinationPath '${zipPath}'"`, { stdio: 'pipe' });
        } else {
          // macOS / Linux / Docker
          execSync(`cd "${outputDir}" && zip -r "novabot-export.zip" ${filesToZip}`, { stdio: 'pipe' });
        }
        progress.zipFile = zipPath;
      } catch {
        // ZIP creation failed — still mark as done
      }

      progress.status = 'done';
      progress.summary = {
        totalFiles,
        totalSize,
        devices: allSns.length,
        workRecords: workRecordCount,
        messages: messageCount,
      };

      // Log device telemetry (SNs + firmware versions) for analytics
      try {
        const telemetryDir = process.env.DOCKER ? '/data' : path.join(os.homedir(), '.novabot-export');
        fs.mkdirSync(telemetryDir, { recursive: true });
        const telemetryFile = path.join(telemetryDir, 'devices.jsonl');
        const deviceEntries = devices.map(d => ({
          sn: d.sn ?? d.mowerSn ?? d.chargerSn ?? null,
          deviceType: d.deviceType ?? null,
          sysVersion: d.sysVersion ?? null,
          equipmentType: d.equipmentType ?? null,
        }));
        const entry = {
          timestamp: new Date().toISOString(),
          devices: deviceEntries,
        };
        fs.appendFileSync(telemetryFile, JSON.stringify(entry) + '\n');
        console.log(`[telemetry] Logged ${deviceEntries.length} devices to ${telemetryFile}`);
      } catch { /* non-fatal — telemetry should never break the export */ }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      progress.status = 'error';
      progress.error = msg;
    }
  });

  // ── GET /api/export/download ─────────────────────────────────────────────
  app.get('/api/export/download', (req, res) => {
    const sessionId = req.query.session as string;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session?.zipFile || !fs.existsSync(session.zipFile)) {
      res.status(404).json({ error: 'No export ZIP available' });
      return;
    }
    res.download(session.zipFile, 'novabot-export.zip', () => {
      // Cleanup: delete temp dir after successful download
      // Delay slightly to ensure download is complete
      setTimeout(() => {
        if (session.outputDir && fs.existsSync(session.outputDir)) {
          try { fs.rmSync(session.outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        sessions.delete(sessionId);
      }, 5000);
    });
  });

  // ── GET /api/admin/devices — view collected device telemetry ─────────────
  app.get('/api/admin/devices', (_req, res) => {
    try {
      const telemetryDir = process.env.DOCKER ? '/data' : path.join(os.homedir(), '.novabot-export');
      const telemetryFile = path.join(telemetryDir, 'devices.jsonl');
      if (!fs.existsSync(telemetryFile)) {
        res.json({ ok: true, entries: [], uniqueDevices: [] });
        return;
      }
      const lines = fs.readFileSync(telemetryFile, 'utf8').trim().split('\n').filter(Boolean);
      const entries = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

      // Build unique device list (deduplicate by SN, keep latest info)
      const deviceMap = new Map<string, Record<string, unknown>>();
      for (const entry of entries) {
        const ts = entry.timestamp;
        for (const d of (entry.devices ?? [])) {
          const sn = d.sn as string;
          if (sn) {
            deviceMap.set(sn, { ...d, lastSeen: ts });
          }
        }
      }
      const uniqueDevices = [...deviceMap.values()].sort((a, b) =>
        String(a.sn ?? '').localeCompare(String(b.sn ?? ''))
      );

      res.json({
        ok: true,
        totalExports: entries.length,
        uniqueDevices,
        entries,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ── Wizard: serve from inlined bundle or filesystem ─────────────────────
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };

  if (wizardFiles['index.html']) {
    app.get('/assets/:file', (req, res) => {
      const buf = wizardFiles[`assets/${path.basename(req.params.file)}`];
      if (!buf) { res.status(404).end(); return; }
      const ext = path.extname(req.params.file);
      res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
      res.send(buf);
    });
    app.get('/:file([^/]+\\.[^/]+)', (req, res) => {
      const key = req.params.file;
      const buf = wizardFiles[key];
      if (!buf) { res.status(404).end(); return; }
      const ext = path.extname(key);
      res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
      res.send(buf);
    });
    app.get('*', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(wizardFiles['index.html']);
    });
  } else {
    // Fallback: serve from wizard/dist/ or show build message
    app.get('*', (req, res) => {
      if (fs.existsSync(wizardDist)) {
        res.sendFile(path.join(wizardDist, 'index.html'));
      } else {
        res.status(200).send('<h1>Cloud Export Wizard</h1><p>Run <code>npm run build</code> first.</p>');
      }
    });
  }

  return app;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function downloadFile(url: string, destPath: string, token?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const protocol = isHttps ? https : http;

    // If URL points to the cloud (app.lfibot.com), use cloud IP + auth headers
    const isCloudUrl = parsed.hostname === 'app.lfibot.com';
    const opts: https.RequestOptions = {
      hostname: isCloudUrl ? LFI_CLOUD_HOST : parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: 120000,
      ...(isCloudUrl ? { headers: makeLfiHeaders(token ?? ''), rejectUnauthorized: false } : {}),
    };

    const req = protocol.request(opts, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        downloadFile(res.headers.location!, destPath, token).then(resolve).catch(reject);
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
