/**
 * Firmware advisory: is the custom build a mower runs withdrawn?
 *
 * The published manifest lists the builds that can be installed; since
 * custom-45 it also carries `withdrawn`, a map of build version to the
 * reason it was pulled (custom-43/44: a watchdog that killed a healthy
 * mqtt_node every ten minutes). A mower on a withdrawn build has to move to
 * the newest one, and nobody should have to find that out from a forum.
 *
 * Only custom builds count. Stock firmware is never told to update.
 *
 * The advisory also fetches the target build into this server's firmware
 * folder, the step the admin otherwise does by hand, so the OTA button in
 * the app and the dashboard works the moment the warning appears.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { otaVersionRepo } from '../db/repositories/otaVersions.js';
import { equipmentRepo } from '../db/repositories/equipment.js';

export const MANIFEST_URL = 'https://downloads.ramonvanbruggen.nl/opennova-manifest.json';
const REFRESH_MS = 6 * 3_600_000;

export interface ManifestEntry {
  version: string;
  device_type: string;
  url: string;
  filename?: string;
  md5?: string;
  description?: string;
}
export interface Manifest {
  firmwares: ManifestEntry[];
  /** version → why it was pulled */
  withdrawn?: Record<string, string>;
}

export interface FirmwareAdvisory {
  required: boolean;
  /** what the mower runs */
  current: string | null;
  reason: string | null;
  /** newest custom build in the manifest; versionId once it is on this server */
  target: { version: string; description: string; downloaded: boolean; versionId: number | null } | null;
}

let cache: { manifest: Manifest; at: number } | null = null;
let fetcher: (url: string) => Promise<unknown> = async (url) => {
  // Tests never reach the internet: no manifest, no advice.
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) throw new Error('no network in tests');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
};
let downloader: ((url: string, dest: string) => Promise<void>) | null = null;
const notified = new Set<string>();

/** Tests swap the network out. */
export function _setFirmwareAdvisoryIo(io: { fetchJson?: typeof fetcher; downloadFile?: typeof downloader; reset?: boolean }): void {
  if (io.fetchJson) fetcher = io.fetchJson;
  if (io.downloadFile !== undefined) downloader = io.downloadFile;
  if (io.reset) { cache = null; notified.clear(); }
}

export function customBuildNumber(version: string | null | undefined): number | null {
  const m = /custom-(\d+)/i.exec(version ?? '');
  return m ? parseInt(m[1], 10) : null;
}

export async function getManifest(force = false): Promise<Manifest | null> {
  if (!force && cache && Date.now() - cache.at < REFRESH_MS) return cache.manifest;
  try {
    const raw = await fetcher(MANIFEST_URL) as Partial<Manifest>;
    const manifest: Manifest = { firmwares: raw.firmwares ?? [], withdrawn: raw.withdrawn ?? {} };
    cache = { manifest, at: Date.now() };
    return manifest;
  } catch (e) {
    console.warn('[FW-ADVISORY] manifest fetch failed:', e instanceof Error ? e.message : e);
    return cache?.manifest ?? null;
  }
}

function newestMower(manifest: Manifest): ManifestEntry | null {
  const mowers = manifest.firmwares.filter(f => f.device_type === 'mower' && customBuildNumber(f.version) != null);
  mowers.sort((a, b) => (customBuildNumber(b.version) ?? 0) - (customBuildNumber(a.version) ?? 0));
  return mowers[0] ?? null;
}

/** Pure: the verdict for one reported version against a manifest. */
export function adviseVersion(version: string | null, manifest: Manifest | null): FirmwareAdvisory {
  const none: FirmwareAdvisory = { required: false, current: version, reason: null, target: null };
  if (!version || !manifest || customBuildNumber(version) == null) return none;
  const reason = manifest.withdrawn?.[version] ?? null;
  const target = newestMower(manifest);
  if (!reason || !target || target.version === version) return none;
  const local = otaVersionRepo.listAll().find(v => v.version === target.version && v.device_type === 'mower');
  return { required: true, current: version, reason, target: { version: target.version, description: target.description ?? '', downloaded: !!local, versionId: local?.id ?? null } };
}

// sensorData pulls the whole broker chain in at import time; the pure parts
// above are what the diagnosis and the tests use, so load it only here.
async function mowerVersion(sn: string): Promise<string | null> {
  const { getDeviceSnapshot } = await import('../mqtt/sensorData.js');
  const snap = getDeviceSnapshot(sn);
  const eq = equipmentRepo.findByMowerSn(sn) as { mower_version?: string | null } | undefined;
  return snap?.sw_version ?? snap?.mower_version ?? eq?.mower_version ?? null;
}

export async function firmwareAdvisory(sn: string): Promise<FirmwareAdvisory> {
  return adviseVersion(await mowerVersion(sn), await getManifest());
}

/**
 * Pull the target build into the firmware folder and register it, so the
 * OTA can start without the admin's Refresh/Download round trip. Idempotent.
 */
export async function ensureTargetDownloaded(entry: ManifestEntry): Promise<boolean> {
  if (otaVersionRepo.listAll().some(v => v.version === entry.version && v.device_type === 'mower')) return true;
  if (!downloader) return false;
  const firmwareDir = process.env.FIRMWARE_PATH ?? path.resolve(process.cwd(), 'firmware');
  const filename = entry.filename || entry.url.split('/').pop() || `firmware_${entry.version}.deb`;
  const filePath = path.join(firmwareDir, filename);
  try {
    fs.mkdirSync(firmwareDir, { recursive: true });
    await downloader(entry.url, filePath);
    const buf = fs.readFileSync(filePath);
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    if (entry.md5 && md5 !== entry.md5) { fs.unlinkSync(filePath); throw new Error(`md5 mismatch for ${filename}`); }
    const targetIp = process.env.TARGET_IP ?? '127.0.0.1';
    const port = process.env.PORT ?? '3000';
    fs.writeFileSync(filePath.replace(/\.(deb|bin)$/, '.json'), JSON.stringify({
      version: entry.version, device_type: 'mower', filename, md5,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length,
      description: entry.description ?? '',
    }, null, 2));
    otaVersionRepo.create({
      version: entry.version, device_type: 'mower',
      download_url: `http://${targetIp}:${port}/api/dashboard/firmware/${encodeURIComponent(filename)}`,
      md5, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length,
      signature: null, signing_key_id: null, release_notes: entry.description ?? null,
    });
    console.log(`[FW-ADVISORY] ${entry.version} downloaded for a required update (${(buf.length / 1048576).toFixed(1)} MB)`);
    return true;
  } catch (e) {
    console.warn('[FW-ADVISORY] download failed:', e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * Every few hours: for each known mower on a withdrawn build, fetch the
 * target and notify once per (mower, version). Called from index.ts.
 */
export async function runFirmwareAdvisorySweep(): Promise<void> {
  const manifest = await getManifest();
  if (!manifest || !manifest.withdrawn || Object.keys(manifest.withdrawn).length === 0) return;
  const target = newestMower(manifest);
  for (const eq of equipmentRepo.listAll() as Array<{ mower_sn: string | null; nick_name?: string | null }>) {
    const sn = eq.mower_sn;
    if (!sn) continue;
    const adv = adviseVersion(await mowerVersion(sn), manifest);
    if (!adv.required || !target) continue;
    await ensureTargetDownloaded(target);
    const key = `${sn}:${adv.current}`;
    if (!notified.has(key)) {
      notified.add(key);
      // Same reason as sensorData above: the notifier drags the broker in.
      const { dispatchFirmwareRequiredEvent } = await import('../notifications/eventDetector.js');
      dispatchFirmwareRequiredEvent(sn, adv.current ?? '', target.version, adv.reason ?? '', eq.nick_name ?? null);
    }
  }
}

export function startFirmwareAdvisory(): void {
  const run = () => { void runFirmwareAdvisorySweep(); };
  setTimeout(run, 60_000);
  setInterval(run, REFRESH_MS);
}
