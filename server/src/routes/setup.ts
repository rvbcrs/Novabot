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
import fs from 'fs';
import path from 'path';
import { userRepo, equipmentRepo, deviceRepo, mapRepo } from '../db/repositories/index.js';
import { isSetupComplete, invalidateSetupCache } from '../middleware/setupGuard.js';
// LFI cloud helpers were extracted to `src/services/lfiCloud.ts` on 2026-04-23
// so cloud-api routes can import them without reaching into `routes/setup.ts`
// (the cloud-api freeze forbids that direction). Re-export here so existing
// external callers (none today, but kept for safety) keep working.
import {
  callLfiCloud,
  encryptCloudPassword,
  makeLfiHeaders,
  LFI_CLOUD_HOST,
  LFI_CLOUD_SERVERNAME,
} from '../services/lfiCloud.js';
export { callLfiCloud, encryptCloudPassword };

export const setupRouter = Router();

// ── GET /status ──────────────────────────────────────────────────────────────

setupRouter.get('/status', (_req, res) => {
  const userCount = userRepo.count();
  const equipCount = equipmentRepo.count();
  const deviceCount = deviceRepo.countAll();

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
    const bcrypt = await import('bcrypt');
    const normalizedEmail = email.trim().toLowerCase();

    // 1. Create or update user
    const existingUser = userRepo.findByEmail(normalizedEmail);

    let appUserId: string;
    if (existingUser) {
      appUserId = existingUser.app_user_id;
      const hash = await bcrypt.hash(password, 10);
      userRepo.updatePassword(appUserId, hash);
      console.log(`[Setup] Updated user: ${normalizedEmail}`);
    } else {
      appUserId = crypto.randomUUID();
      const hash = await bcrypt.hash(password, 10);
      userRepo.create(appUserId, normalizedEmail, hash, normalizedEmail.split('@')[0], true);
      console.log(`[Setup] Created user: ${normalizedEmail} (admin)`);
    }

    // 2. Register equipment — NEVER destroy existing working pairs
    // Principle: if the SN already exists in any equipment record, skip it.
    // Only create a new record if this device is truly new to the DB.
    if (mower?.sn || charger?.sn) {
      const mowerExists = mower?.sn
        ? equipmentRepo.findByMowerSn(mower.sn)
        : null;
      const chargerExists = charger?.sn
        ? equipmentRepo.findByChargerSn(charger.sn)
        : null;

      if (mowerExists || chargerExists) {
        // Device already in DB — only update user_id if not set (claim ownership)
        const targetId = mowerExists?.equipment_id ?? chargerExists?.equipment_id;
        equipmentRepo.claimOwnership(targetId!, appUserId);
        console.log(`[Setup] Equipment already exists: ${targetId} — claimed by ${appUserId}`);
      } else {
        // Truly new device — check if user has an incomplete record (missing mower or charger)
        const incomplete = equipmentRepo.findIncompleteByUserId(appUserId);

        if (incomplete && mower?.sn && !incomplete.mower_sn) {
          // Fill in missing mower on existing charger-only record
          equipmentRepo.updateMowerSn(incomplete.equipment_id, mower.sn, mower.mac);
          console.log(`[Setup] Added mower ${mower.sn} to existing record ${incomplete.equipment_id}`);
        } else if (incomplete && charger?.sn && !incomplete.charger_sn) {
          // Fill in missing charger on existing mower-only record
          equipmentRepo.updateChargerSn(
            incomplete.equipment_id, charger.sn,
            charger.address != null ? String(charger.address) : undefined,
            charger.channel != null ? String(charger.channel) : undefined,
          );
          console.log(`[Setup] Added charger ${charger.sn} to existing record ${incomplete.equipment_id}`);
        } else {
          // Create brand new record
          const equipmentId = crypto.randomUUID();
          equipmentRepo.create({
            equipment_id: equipmentId,
            user_id: appUserId,
            mower_sn: mower?.sn ?? '',
            charger_sn: charger?.sn ?? null,
            nick_name: deviceName ?? null,
            charger_address: charger?.address != null ? String(charger.address) : null,
            charger_channel: charger?.channel != null ? String(charger.channel) : null,
            // Only the mower BLE MAC belongs here — the charger MAC (48:27:E2:*)
            // would otherwise leak in and break BLE matching in the Novabot app.
            // equipmentRepo.create() backfills from device_factory when null.
            mac_address: mower?.mac ?? null,
          });
          console.log(`[Setup] Equipment created: mower=${mower?.sn ?? 'none'}, charger=${charger?.sn ?? 'none'}`);
        }
      }

      // 3. Register in device_registry (for MAC lookup) — INSERT OR IGNORE = idempotent
      if (mower?.sn && mower?.mac) {
        deviceRepo.insertIfMissing(`cloud_import_${mower.sn}`, mower.sn, mower.mac);
      }
      if (charger?.sn && charger?.mac) {
        deviceRepo.insertIfMissing(`cloud_import_${charger.sn}`, charger.sn, charger.mac);
      }

      // 3b. Ensure mower BLE MAC is populated even when the cloud returned
      // no MAC (happens for accounts where the mower isn't listed in LFI cloud).
      equipmentRepo.backfillMissingMacsFromFactory();

      // 4. LoRa cache — NIET vanuit cloud importeren, cloud waarden zijn onbetrouwbaar.
      // Echte LoRa config wordt automatisch opgehaald via MQTT get_lora_info bij charger connect.
    }

    // 5. Import maps from cloud for each mower
    let mapsImported = 0;
    let mapZipSize = 0;
    let chargerGpsImported = false;
    if (mower?.sn) {
      try {
        // Login to get a fresh token
        const encryptedPw = encryptCloudPassword(password);
        const loginResp = await callLfiCloud('POST', '/api/nova-user/appUser/login', {
          email, password: encryptedPw, imei: 'imei',
        });
        const loginVal = (loginResp as Record<string, unknown>).value as Record<string, unknown> | undefined;
        const cloudToken = loginVal?.accessToken as string | undefined;

        if (cloudToken) {
          // Fetch map data from cloud
          const mapResp = await callLfiCloud('GET',
            `/api/nova-file-server/map/queryEquipmentMap?sn=${encodeURIComponent(mower.sn)}`,
            null, cloudToken);
          const mapVal = (mapResp as Record<string, unknown>).value as Record<string, unknown> | undefined;
          const mapData = mapVal?.data as Record<string, unknown> | undefined;

          // Log de volledige cloud response keys + unicom array structuur
          console.log(`[Setup] Cloud response keys: data=${mapData ? Object.keys(mapData).join(',') : 'null'} md5=${mapVal?.md5 ?? 'null'}`);
          if (mapData) {
            const rawUnicom = mapData.unicom;
            console.log(`[Setup] Cloud unicom raw: type=${typeof rawUnicom} isArray=${Array.isArray(rawUnicom)} length=${Array.isArray(rawUnicom) ? rawUnicom.length : 'N/A'}`);
            if (Array.isArray(rawUnicom)) {
              for (const u of rawUnicom) console.log(`[Setup]   unicom: ${JSON.stringify({ fileName: u?.fileName, alias: u?.alias, type: u?.type, hasUrl: !!u?.url })}`);
            }
          }

          if (mapData) {
            const workItems = (mapData.work ?? []) as Array<Record<string, unknown>>;
            const unicomItems = (mapData.unicom ?? []) as Array<Record<string, unknown>>;
            console.log(`[Setup] Cloud maps: ${workItems.length} work, ${unicomItems.length} unicom for ${mower.sn}`);

            // Log exact cloud unicom data — helpt bij debugging missing channels
            for (const u of unicomItems) {
              console.log(`[Setup] Cloud unicom item: fileName=${u.fileName} alias=${u.alias} url=${u.url ? 'yes' : 'MISSING'}`);
            }

            // Wis bestaande maps om duplicaten te voorkomen bij re-import
            mapRepo.deleteByMowerSn(mower.sn);

            // Download each map CSV from cloud and store in DB
            // Flatten: work items + their nested obstacles + unicom items
            const { v4: uuidv4 } = await import('uuid');
            const allItems: Array<Record<string, unknown>> = [];
            for (const w of workItems) {
              allItems.push(w);
              const obstacles = (w.obstacle ?? []) as Array<Record<string, unknown>>;
              for (const obs of obstacles) allItems.push({ ...obs, type: 'obstacle' });
            }
            for (const u of unicomItems) allItems.push(u);

            // Helper: download CSV met retry (cloud kan traag zijn)
            // eslint-disable-next-line no-inner-declarations
            async function downloadCsvWithRetry(url: string, headers: Record<string, string>, maxRetries = 3): Promise<string> {
              let lastErr: Error | null = null;
              for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                  const data = await new Promise<string>((resolve, reject) => {
                    const parsedUrl = new URL(url, `https://${LFI_CLOUD_HOST}`);
                    const isCloud = parsedUrl.hostname === LFI_CLOUD_SERVERNAME || parsedUrl.hostname === LFI_CLOUD_HOST;
                    const req = https.request({
                      hostname: isCloud ? LFI_CLOUD_HOST : parsedUrl.hostname,
                      path: parsedUrl.pathname + parsedUrl.search,
                      method: 'GET',
                      ...(isCloud
                        ? { headers, rejectUnauthorized: false }
                        : {}),
                    }, (resp) => {
                      // Check HTTP status — cloud kan 4xx/5xx retourneren
                      if (resp.statusCode && resp.statusCode >= 400) {
                        let body = '';
                        resp.on('data', (chunk: string) => { body += chunk; });
                        resp.on('end', () => reject(new Error(`HTTP ${resp.statusCode}: ${body.slice(0, 200)}`)));
                        return;
                      }
                      let d = '';
                      resp.on('data', (chunk: string) => { d += chunk; });
                      resp.on('end', () => resolve(d));
                    });
                    req.on('error', reject);
                    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
                    req.end();
                  });
                  return data;
                } catch (err) {
                  lastErr = err as Error;
                  if (attempt < maxRetries) {
                    console.warn(`[Setup] Download attempt ${attempt}/${maxRetries} failed, retrying in 2s...`);
                    await new Promise(r => setTimeout(r, 2000));
                  }
                }
              }
              throw lastErr ?? new Error('download failed');
            }

            let importErrors = 0;
            for (const item of allItems) {
              const csvUrl = item.url as string | undefined;
              const fileName = item.fileName as string | undefined;
              const mapType = item.type === 'obstacle' ? 'obstacle' : item.type === 'unicom' ? 'unicom' : 'work';

              if (!fileName) {
                console.warn(`[Setup] Skipping item without fileName: type=${item.type}`);
                importErrors++;
                continue;
              }
              if (!csvUrl) {
                console.warn(`[Setup] Skipping ${fileName}: no download URL in cloud response`);
                importErrors++;
                continue;
              }

              try {
                const csvData = await downloadCsvWithRetry(csvUrl, makeLfiHeaders(cloudToken!));
                let points: Array<{ x: number; y: number }> = [];

                if (csvData && csvData.length > 5 && csvData.includes(',')) {
                  // Parse CSV: each line is "x,y" in local meters
                  points = csvData.trim().split('\n').map(line => {
                    const [x, y] = line.trim().split(',').map(Number);
                    return { x, y };
                  }).filter(p => !isNaN(p.x) && !isNaN(p.y));
                }

                if (points.length < 2 && mapType !== 'unicom') {
                  // Work/obstacle items MOETEN punten hebben voor rendering
                  console.warn(`[Setup] ${fileName}: ${points.length} valid points (need ≥2), skipping`);
                  importErrors++;
                  continue;
                }

                const mapId = uuidv4();
                const alias = (item.alias as string | undefined) ?? fileName.replace('.csv', '');
                mapRepo.upsert({
                  map_id: mapId,
                  mower_sn: mower.sn,
                  map_name: alias,
                  map_area: points.length >= 2 ? JSON.stringify(points) : null,
                  file_name: fileName,
                  file_size: csvData.length,
                  map_type: mapType,
                });
                mapsImported++;
                if (points.length >= 2) {
                  console.log(`[Setup] ✓ Imported: ${fileName} (${mapType}, ${points.length} points)`);
                } else {
                  // Unicom met lege CSV — by design (LFI cloud slaat geen paddata op voor inter-map channels)
                  console.log(`[Setup] ✓ Imported: ${fileName} (${mapType}, metadata only — empty CSV is normal for inter-map channels)`);
                }
              } catch (dlErr) {
                // Download volledig gefaald — voor unicom items alsnog opslaan (metadata)
                if (mapType === 'unicom') {
                  const mapId = uuidv4();
                  const alias = (item.alias as string | undefined) ?? fileName!.replace('.csv', '');
                  mapRepo.upsert({
                    map_id: mapId, mower_sn: mower.sn, map_name: alias,
                    map_area: null, file_name: fileName!, file_size: null, map_type: 'unicom',
                  });
                  mapsImported++;
                  console.log(`[Setup] ✓ Imported: ${fileName} (unicom, metadata only — download failed but item preserved)`);
                } else {
                  importErrors++;
                  console.error(`[Setup] ✗ FAILED ${fileName} after 3 retries:`, (dlErr as Error).message);
                }
              }
            }
            if (importErrors > 0) {
              console.warn(`[Setup] ⚠ ${importErrors} map(s) failed to import for ${mower.sn}`);
            }

            // Geen auto-generatie van unicom paddata meer.
            // LFI cloud slaat inter-map unicom channels op als 0-byte CSV — by design.
            // De app checkt alleen fileName.startsWith("mapX") voor zone selectie,
            // NIET of er daadwerkelijk paddata is. Metadata-only records zijn voldoende.

            // Import chargingPose for map calibration
            const machineField = mapVal?.machineExtendedField as Record<string, unknown> | undefined;
            const chargingPose = machineField?.chargingPose as Record<string, string> | undefined;
            if (chargingPose?.x && chargingPose?.y) {
              const poseX = parseFloat(chargingPose.x);
              const poseY = parseFloat(chargingPose.y);
              // chargingPose can be GPS (lat~52, lng~6) or local meters (x~0.1, y~0.2)
              // GPS values are > 10, local meters are typically < 50
              const isGps = !isNaN(poseY) && Math.abs(poseY) > 10;
              if (isGps) {
                mapRepo.setCalibration(mower.sn, {
                  offset_lat: 0,
                  offset_lng: 0,
                  rotation: 0,
                  scale: 1,
                  charger_lat: poseY,   // y=lat
                  charger_lng: poseX,   // x=lng
                });
                chargerGpsImported = true;
                console.log(`[Setup] Charger GPS imported: lat=${poseY}, lng=${poseX}`);
              } else {
                console.log(`[Setup] ChargingPose is local meters (x=${poseX}, y=${poseY})`);
              }
            }

            // Genereer _latest.zip zodat queryEquipmentMap md5 + chargingPose kan retourneren
            if (mapsImported > 0) {
              try {
                const STORAGE = path.resolve(process.env.STORAGE_PATH ?? './storage', 'maps');
                fs.mkdirSync(STORAGE, { recursive: true });
                const tmpZipDir = path.join(STORAGE, `tmp_zip_${Date.now()}`);
                const csvDir = path.join(tmpZipDir, 'csv_file');
                fs.mkdirSync(csvDir, { recursive: true });

                // Schrijf CSV's uit DB
                const importedMaps = mapRepo.findWithAreaOrderByMapId(mower.sn);
                const mapInfoObj: Record<string, unknown> = {};
                for (const m of importedMaps) {
                  if (!m.map_area) continue;
                  const pts = JSON.parse(m.map_area) as Array<{ x: number; y: number }>;
                  const csvName = (m.file_name && !m.file_name.endsWith('.zip')) ? m.file_name : (m.map_name + '.csv');
                  fs.writeFileSync(path.join(csvDir, csvName), pts.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('\n') + '\n');
                  if (m.map_type === 'work') {
                    // Shoelace area
                    let a = 0;
                    for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i].x * pts[j].y - pts[j].x * pts[i].y; }
                    mapInfoObj[csvName] = { map_size: Math.round(Math.abs(a / 2) * 100) / 100 };
                  }
                }
                if (chargingPose?.x) {
                  mapInfoObj['charging_pose'] = { x: parseFloat(chargingPose.x), y: parseFloat(chargingPose.y), orientation: parseFloat(chargingPose.orientation ?? '0') };
                }
                fs.writeFileSync(path.join(csvDir, 'map_info.json'), JSON.stringify(mapInfoObj, null, 2));

                // Maak ZIP met archiver (Node.js, geen system zip command nodig)
                const zipPath = path.join(STORAGE, `${mower.sn}_latest.zip`);
                if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
                const archiver = (await import('archiver')).default;
                await new Promise<void>((resolve, reject) => {
                  const output = fs.createWriteStream(zipPath);
                  const archive = archiver('zip', { zlib: { level: 9 } });
                  output.on('close', resolve);
                  archive.on('error', reject);
                  archive.pipe(output);
                  archive.directory(csvDir, 'csv_file');
                  archive.finalize();
                });
                fs.rmSync(tmpZipDir, { recursive: true, force: true });
                mapZipSize = fs.statSync(zipPath).size;
                console.log(`[Setup] Generated ${mower.sn}_latest.zip (${mapZipSize} bytes)`);
              } catch (zipErr) {
                console.warn(`[Setup] ZIP generation failed (non-fatal):`, zipErr);
              }
            }
          }
        }
      } catch (mapErr) {
        console.warn(`[Setup] Map import failed (non-fatal):`, mapErr);
      }
    }

    invalidateSetupCache();
    res.json({ ok: true, email: normalizedEmail, setupComplete: isSetupComplete(), mapsImported, mapZipSize, chargerGpsImported });
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

    userRepo.createIfMissing(appUserId, 'admin@local', hashedPwd, 'admin');

    invalidateSetupCache();
    res.json({ ok: true, message: 'Local account created. Bind your mower via the Novabot app.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── GET /devices ─────────────────────────────────────────────────────────────

setupRouter.get('/devices', (_req, res) => {
  const equipment = equipmentRepo.listAll();
  const registry = deviceRepo.listAll();

  res.json({ equipment, registry });
});

// ── GET /profile — generate combined .mobileconfig (DNS + TLS cert) ───────────

setupRouter.get('/profile', async (_req, res) => {
  const fs = await import('fs');
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  const mowerVersion = equipmentRepo.findFirstMowerVersionByPrefix('LFIN%');
  const hasCustomFirmware = !!(mowerVersion && mowerVersion.includes('custom'));

  // Check if a mower is currently connected (seen in last 5 minutes)
  const mowerConnected = deviceRepo.hasRecentlyOnlineBySnPrefix('LFIN%', 5);

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
  const mac = deviceRepo.getFactoryMac(sn);
  res.json({ sn, mac });
});

// ── Device connection count (for MQTT polling) ─────────────────────────────

setupRouter.get('/health', async (_req: Request, res: Response) => {
  const userCount = userRepo.count();
  const equipCount = equipmentRepo.count();
  const deviceCount = deviceRepo.countAll();

  const recentDevices = deviceRepo.findRecentlyOnline(5);
  const recentDevice = recentDevices.length > 0
    ? { sn: recentDevices[0].sn, last_seen: recentDevices[0].last_seen }
    : undefined;

  const connectedCount = deviceRepo.countOnline(1);

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

  // Read version
  let version = '?';
  try { const { readFileSync } = await import('fs'); version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; } catch { /* ignore */ }

  res.json({
    server: 'running',
    mqtt: 'running',
    version,
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
