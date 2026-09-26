import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { db } from '../db/database.js';
import { mapRepo, deviceSettingsRepo } from '../db/repositories/index.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { isOpenNovaMower } from './mowerFileCapability.js';
import { snapshotDockPose, getPhotoDockPose, PHOTO_DOCK_KEY } from './dockPhotoReference.js';
import { withMowerMapOperation, readMowerMapSnapshot, type MowerMapOperation } from './mowerMapOperation.js';
import { stablePosition } from './positionTelemetry.js';
import { isFrameUnvalidated, clearFrameUnvalidated } from './frameValidation.js';
import { snapshotAnchorMatches } from './anchor.js';
import { parseMapCsv } from './portableSnapshot.js';
import { dockChannelPoints } from './zoneCopy.js';
import { beginMapApply } from './mapApplyStatus.js';
import { installVerifiedMapZip } from './mowerMapApply.js';
import { validateMapRasters } from '../maps/validateGrid.js';

const DOCK_CHANNEL = /^map\d+tocharge_unicom\.csv$/;
type Snapshot = Record<string, unknown>;
type Pose = NonNullable<ReturnType<typeof snapshotDockPose>>;

function ready(sn: string, pose?: Pose) {
  const live = stablePosition(sn, { docked: true });
  if (!isDeviceOnline(sn) || !live || (pose && Math.hypot(live.x - pose.x, live.y - pose.y) > 0.05)) {
    throw new Error('Zet de doelmaaier op zijn eigen dock en wacht op stabiele RTK Fixed-lokalisatie binnen 5 cm van de opgeslagen dockpositie.');
  }
  return live;
}

function csvOf(snapshot: Snapshot): Record<string, string> {
  const csv = snapshot.csv_files as Record<string, string>;
  if (!csv || Object.entries(csv).some(([name, text]) => !/^[\w.-]+\.(csv|json)$/.test(name) || name.includes('..') || typeof text !== 'string')) {
    throw new Error('Ongeldige kaartbestanden van de maaier.');
  }
  return csv;
}

/** Compare every polygon, not just the dock. DB rounding may differ by at most one centimetre. */
export function assertStoredGeometry(sn: string, snapshot: Snapshot) {
  const csv = csvOf(snapshot);
  const rows = mapRepo.findByMowerSn(sn).filter(r => r.canonical_name);
  const names = Object.keys(csv).filter(n => n.endsWith('.csv')).sort();
  const rowName = (r: typeof rows[number]) => `${r.canonical_name}${r.map_type === 'work' ? '_work' : ''}.csv`;
  if (JSON.stringify(names) !== JSON.stringify(rows.map(rowName).sort())) throw new Error('Server en maaier bevatten verschillende kaarten; synchroniseer die eerst.');
  for (const row of rows) {
    const points = parseMapCsv(csv[rowName(row)], rowName(row));
    const saved = JSON.parse(row.map_area ?? 'null');
    if (!Array.isArray(saved) || saved.length !== points.length || points.some((p, i) =>
      typeof saved[i]?.x !== 'number' || typeof saved[i]?.y !== 'number' ||
      !Number.isFinite(saved[i].x) || !Number.isFinite(saved[i].y) ||
      Math.hypot(p.x - saved[i].x, p.y - saved[i].y) > 0.01)) throw new Error(`Server en maaier verschillen voor ${rowName(row)}.`);
  }
}

async function readDock(sn: string, operation: MowerMapOperation) {
  if (!isDeviceOnline(sn) || !isOpenNovaMower(sn) || isFrameUnvalidated(sn)) throw new Error('Een online OpenNova-maaier met gevalideerd frame is vereist.');
  const snapshot = await readMowerMapSnapshot(sn, operation);
  const pose = snapshotDockPose(snapshot);
  if (!snapshot || !pose || typeof snapshot.pos_json !== 'string') throw new Error('De dockbestanden van de maaier komen niet overeen.');
  return { snapshot, pose };
}

/** The dashboard copy flow never derives either dock from an unverified channel or cached robot pose. */
export async function withConfirmedCopyDocks<T>(target: string, source: string, run: (docks: { source: Pose; target: Pose }) => T | Promise<T>, requireDocked = true): Promise<T> {
  if (target === source) throw new Error('Kies een andere bronmaaier.');
  return withMowerMapOperation(target, targetOp => withMowerMapOperation(source, async sourceOp => {
    if (requireDocked) ready(target);
    const a = await readDock(source, sourceOp);
    const b = await readDock(target, targetOp);
    assertStoredGeometry(source, a.snapshot);
    assertStoredGeometry(target, b.snapshot);
    if (!snapshotAnchorMatches(a.snapshot, a.pose) || !snapshotAnchorMatches({ ...a.snapshot, csv_files: a.snapshot.x3_csv_files }, a.pose)) throw new Error('Het dockkanaal van de bronmaaier wijkt af van zijn opgeslagen dock.');
    const hasChannels = Object.keys(csvOf(b.snapshot)).some(n => DOCK_CHANNEL.test(n));
    if (hasChannels && (!snapshotAnchorMatches(b.snapshot, b.pose) || !snapshotAnchorMatches({ ...b.snapshot, csv_files: b.snapshot.x3_csv_files }, b.pose))) throw new Error('Herstel eerst het bestaande dockkanaal van de doelmaaier.');
    if (requireDocked) ready(target, b.pose);
    return run({ source: a.pose, target: b.pose });
  }));
}

/** Pure repair: preserve CSV bytes except dock channels. Both trees must agree before a sync. */
export function planDockChannelRepair(snapshot: Snapshot) {
  const pose = snapshotDockPose(snapshot);
  if (!pose) throw new Error('Geen eenduidige opgeslagen dockpositie.');
  const csv = csvOf(snapshot), x3 = snapshot.x3_csv_files as Record<string, string> | undefined;
  if (!x3 || JSON.stringify(Object.keys(csv).sort()) !== JSON.stringify(Object.keys(x3).sort()) ||
    Object.entries(csv).some(([name, text]) => name !== 'map_info.json' && x3[name] !== text)) throw new Error('De twee kaartkopieën op de maaier verschillen; geen automatische kanaalreparatie mogelijk.');
  // The stale secondary dock metadata is part of this repair. Its polygon
  // bytes must agree; the independently confirmed primary metadata wins.
  const secondaryPose = JSON.parse(x3['map_info.json']).charging_pose;
  if (!secondaryPose || ![secondaryPose.x, secondaryPose.y, secondaryPose.orientation].every(Number.isFinite)) throw new Error('Ongeldige tweede dockverwijzing.');
  // Reject unknown files rather than omit an obstacle from the corridor check.
  for (const name of Object.keys(csv)) if (name !== 'map_info.json' && !/^map\d+(?:_work|_\d+_obstacle|tocharge_unicom|tomap\d+.*_unicom)\.csv$/.test(name)) throw new Error(`Onbekend kaartbestand: ${name}`);
  const obstacles = Object.entries(csv).filter(([n]) => n.endsWith('_obstacle.csv')).map(([n, text]) => parseMapCsv(text, n));
  if (obstacles.some(p => p.length < 3)) throw new Error('Ongeldig obstakel.');
  const channels = Object.keys(csv).filter(n => DOCK_CHANNEL.test(n)).map(name => {
    const workName = `${name.split('tocharge')[0]}_work.csv`;
    if (!(workName in csv)) throw new Error(`Werkgebied ontbreekt voor ${name}.`);
    const work = parseMapCsv(csv[workName], workName);
    if (work.length < 3) throw new Error(`Ongeldig werkgebied: ${workName}`);
    const points = dockChannelPoints(pose, work, obstacles);
    if (!points) throw new Error(`Geen vrije dockaanloop binnen ${workName}; teken een gecontroleerde doorgang.`);
    return { name, points, previous: parseMapCsv(csv[name], name) };
  });
  if (!channels.length) throw new Error('Geen bestaand dockkanaal om te herstellen.');
  const csvFiles = { ...csv };
  for (const c of channels) csvFiles[c.name] = c.points.map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).join('\n') + '\n';
  return { pose, channels, csvFiles, secondaryMetadataChanged: x3['map_info.json'] !== csv['map_info.json'] };
}

async function csvZip(files: Record<string, string>): Promise<Buffer> {
  const archive = archiver('zip', { zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    archive.on('data', c => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
  });
  for (const [name, text] of Object.entries(files)) archive.append(text, { name: `csv_file/${name}` });
  void archive.finalize().catch(() => {}); // 'error' rejects result
  return result;
}

export async function repairDockChannels(sn: string, expectedHash?: string) {
  return withMowerMapOperation(sn, async operation => {
    ready(sn);
    const { snapshot, pose } = await readDock(sn, operation);
    ready(sn, pose);
    const offset = mapRepo.getPolygonOffset(sn);
    if (offset.x || offset.y) throw new Error('Kanaalreparatie vereist een kaart zonder fysieke verschuiving.');
    assertStoredGeometry(sn, snapshot);
    const plan = planDockChannelRepair(snapshot);
    const rows = mapRepo.findByMowerSn(sn);
    const photo = getPhotoDockPose(sn);
    const hash = () => createHash('sha256').update(JSON.stringify({
      csv: Object.entries(csvOf(snapshot)).sort(), x3: Object.entries(snapshot.x3_csv_files as object).sort(),
      origin: snapshot.pos_json, yaml: snapshot.charging_station_yaml,
      rows: mapRepo.findByMowerSn(sn), calibration: mapRepo.getCalibration(sn), photo: getPhotoDockPose(sn),
    })).digest('hex');
    const planHash = hash();
    const preview = { planHash, dock: pose, channels: plan.channels, secondaryMetadataChanged: plan.secondaryMetadataChanged, preserves: ['work', 'obstacles', 'pos.json', 'charging_station.yaml', 'photo calibration'] };
    if (expectedHash === undefined) return { ok: true, preview };
    if (expectedHash !== planHash) throw new Error('Kaart of kalibratie gewijzigd; vraag een nieuw voorbeeld op.');
    const root = path.resolve(process.env.STORAGE_PATH ?? './storage');
    const backupDir = path.join(root, 'dock-channel-repair', operation.id);
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, 'before.json'), JSON.stringify({ sn, snapshot, rows, calibration: mapRepo.getCalibration(sn), photo, preview }), { flag: 'wx' });
    const bytes = await csvZip(plan.csvFiles);
    writeFileSync(path.join(backupDir, 'repair.zip'), bytes, { flag: 'wx' });
    ready(sn, pose);
    if (hash() !== planHash) throw new Error('Kaart gewijzigd tijdens voorbereiding.');
    const apply = beginMapApply(sn);
    apply.phase('syncing');
    try {
      const after = await installVerifiedMapZip(sn, { bytes, expectedCsv: new Map(Object.entries(plan.csvFiles)), before: snapshot, anchor: pose }, operation, apply);
      if (!after) throw new Error('Kanaaloverdracht niet bevestigd; frame blijft geblokkeerd.');
      const rasters = after.map_files_b64 as Record<string, string>;
      const text = after.map_files_text as Record<string, string>;
      const slots = Object.keys(plan.csvFiles).filter(n => /^map\d+_work\.csv$/.test(n)).map(n => n.slice(0, -9));
      const validation = validateMapRasters(rasters);
      if (!rasters || !text || ['map', ...slots].some(n => !rasters[`${n}.pgm`] || !text[`${n}.yaml`] || !validation.stats[`${n}.pgm`]?.total) || !validation.ok) throw new Error('Navigatiekaarten zijn niet geldig opgebouwd.');
      ready(sn, pose);
      // Device first, then server. A crash or commit failure keeps navigation blocked.
      const latest = path.join(root, 'maps', `${sn}_latest.zip`);
      mkdirSync(path.dirname(latest), { recursive: true });
      writeFileSync(`${latest}.repair`, bytes);
      renameSync(`${latest}.repair`, latest);
      db.transaction(() => {
        for (const c of plan.channels) {
          const row = mapRepo.findBySnAndCanonical(sn, c.name.slice(0, -4));
          if (!row) throw new Error('Dockkanaal verdwenen tijdens reparatie.');
          const pts = parseMapCsv(plan.csvFiles[c.name], c.name);
          const bounds = { minX: Math.min(...pts.map(p => p.x)), maxX: Math.max(...pts.map(p => p.x)), minY: Math.min(...pts.map(p => p.y)), maxY: Math.max(...pts.map(p => p.y)) };
          mapRepo.updateAreaAndBoundsByIdAndMower(row.map_id, sn, JSON.stringify(pts), JSON.stringify(bounds));
        }
        mapRepo.setPolygonChargingOrientation(sn, pose.orientation);
        if (photo) deviceSettingsRepo.upsert(sn, PHOTO_DOCK_KEY, JSON.stringify(photo));
      })();
      writeFileSync(path.join(backupDir, 'after.json'), JSON.stringify(after), { flag: 'wx' });
      clearFrameUnvalidated(sn);
      apply.done();
      return { ok: true, preview, backupId: operation.id, applied: true };
    } catch (error) { apply.fail('sync_failed'); throw error; }
  });
}
