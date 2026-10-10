import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { db } from '../db/database.js';
import { mapRepo, deviceSettingsRepo } from '../db/repositories/index.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { isOpenNovaMower } from './mowerFileCapability.js';
import { snapshotDockPose, getPhotoDockPose, PHOTO_DOCK_KEY } from './dockPhotoReference.js';
import { withMowerMapOperation, readMowerMapSnapshot, type MowerMapOperation } from './mowerMapOperation.js';
import { DOCK_SEAT_TOLERANCE_M, stablePosition } from './positionTelemetry.js';
import { isFrameUnvalidated, isMapInstallPending, clearMapInstallPending } from './frameValidation.js';
import { snapshotAnchorMatches } from './anchor.js';
import { parseMapCsv, mergeConnectorCopies, reconcileMowerCsvTrees } from './portableSnapshot.js';
import { dockChannelPoints, DOCK_MAX_M } from './zoneCopy.js';
import { distanceToPolygon } from './canonicalNaming.js';
import { beginMapApply } from './mapApplyStatus.js';
import { installVerifiedMapZip } from './mowerMapApply.js';
import { validateMapRasters } from '../maps/validateGrid.js';
import { M, TextError } from './serverText.js';

const DOCK_CHANNEL = /^map\d+tocharge_unicom\.csv$/;
type Snapshot = Record<string, unknown>;
type Pose = NonNullable<ReturnType<typeof snapshotDockPose>>;
export interface ConfirmedCopyDocks {
  source: Pose;
  target: Pose;
  sourceSnapshot: Snapshot;
  targetSnapshot: Snapshot;
  sourceOperation: MowerMapOperation;
  targetOperation: MowerMapOperation;
  /** How far the docked target may read from its saved dock; defaults to DOCK_SEAT_TOLERANCE_M. */
  seatToleranceM?: number;
}

function ready(sn: string, pose?: Pose, tolerance = DOCK_SEAT_TOLERANCE_M) {
  const live = stablePosition(sn, { docked: true });
  if (!isDeviceOnline(sn) || !live || (pose && Math.hypot(live.x - pose.x, live.y - pose.y) > tolerance)) {
    throw new TextError(M`Zet de doelmaaier op zijn eigen dock en wacht op stabiele RTK Fixed-lokalisatie binnen ${Math.round(tolerance * 100)} cm van de opgeslagen dockpositie.`);
  }
  return live;
}

function csvOf(snapshot: Snapshot): Record<string, string> {
  const csv = snapshot.csv_files as Record<string, string>;
  if (!csv || Object.entries(csv).some(([name, text]) => !/^[\w.-]+\.(csv|json)$/.test(name) || name.includes('..') || typeof text !== 'string')) {
    throw new TextError(M`Ongeldige kaartbestanden van de maaier.`);
  }
  return csv;
}

/** Compare every polygon, not just the dock. DB rounding may differ by at most one centimetre. */
export function assertStoredGeometry(sn: string, snapshot: Snapshot) {
  // DB rows hold the full connector routes (read from x3_csv_file).
  const csv = mergeConnectorCopies(csvOf(snapshot), snapshot.x3_csv_files as Record<string, string> | undefined);
  const rows = mapRepo.findByMowerSn(sn).filter(r => r.canonical_name);
  const names = Object.keys(csv).filter(n => n.endsWith('.csv')).sort();
  const rowName = (r: typeof rows[number]) => `${r.canonical_name}${r.map_type === 'work' ? '_work' : ''}.csv`;
  const expected = rows.map(rowName).sort();
  // While an install is pending the mower may still hold files of the
  // unfinished one; every stored zone must be there unchanged regardless.
  const present = isMapInstallPending(sn) ? names.filter(n => expected.includes(n)) : names;
  if (JSON.stringify(present) !== JSON.stringify(expected)) throw new TextError(M`Server en maaier bevatten verschillende kaarten; synchroniseer die eerst.`);
  for (const row of rows) {
    const points = parseMapCsv(csv[rowName(row)], rowName(row));
    const saved = JSON.parse(row.map_area ?? 'null');
    if (!Array.isArray(saved) || saved.length !== points.length || points.some((p, i) =>
      typeof saved[i]?.x !== 'number' || typeof saved[i]?.y !== 'number' ||
      !Number.isFinite(saved[i].x) || !Number.isFinite(saved[i].y) ||
      Math.hypot(p.x - saved[i].x, p.y - saved[i].y) > 0.01)) throw new TextError(M`Server en maaier verschillen voor ${rowName(row)}.`);
  }
}

const VALIDATED_FRAME_REQUIRED = () => new TextError(M`Een online OpenNova-maaier met gevalideerd frame is vereist.`);

async function readDock(sn: string, operation: MowerMapOperation, retryingInstall = false, anyFrame = false) {
  if (!isDeviceOnline(sn) || !isOpenNovaMower(sn) || (isFrameUnvalidated(sn) && !anyFrame && !(retryingInstall && isMapInstallPending(sn)))) throw VALIDATED_FRAME_REQUIRED();
  const snapshot = await readMowerMapSnapshot(sn, operation);
  const pose = snapshotDockPose(snapshot);
  if (!snapshot || !pose || typeof snapshot.pos_json !== 'string') throw new TextError(M`De dockbestanden van de maaier komen niet overeen.`);
  return { snapshot, pose };
}

/** The dashboard copy flow never derives either dock from an unverified channel or cached robot pose. */
export async function withConfirmedCopyDocks<T>(target: string, source: string, run: (docks: ConfirmedCopyDocks) => T | Promise<T>, requireDocked = true, seatToleranceM = DOCK_SEAT_TOLERANCE_M): Promise<T> {
  if (target === source) throw new TextError(M`Kies een andere bronmaaier.`);
  return withMowerMapOperation(target, targetOp => withMowerMapOperation(source, async sourceOp => {
    if (requireDocked) ready(target);
    const a = await readDock(source, sourceOp);
    // The copy is itself the repair of an install the target never finished.
    const b = await readDock(target, targetOp, true);
    assertStoredGeometry(source, a.snapshot);
    assertStoredGeometry(target, b.snapshot);
    if (!snapshotAnchorMatches(a.snapshot, a.pose) || !snapshotAnchorMatches({ ...a.snapshot, csv_files: a.snapshot.x3_csv_files }, a.pose)) throw new TextError(M`Het dockkanaal van de bronmaaier wijkt af van zijn opgeslagen dock.`);
    const hasChannels = Object.keys(csvOf(b.snapshot)).some(n => DOCK_CHANNEL.test(n));
    if (hasChannels && (!snapshotAnchorMatches(b.snapshot, b.pose) || !snapshotAnchorMatches({ ...b.snapshot, csv_files: b.snapshot.x3_csv_files }, b.pose))) throw new TextError(M`Herstel eerst het bestaande dockkanaal van de doelmaaier.`);
    if (requireDocked) ready(target, b.pose, seatToleranceM);
    return run({ source: a.pose, target: b.pose, sourceSnapshot: a.snapshot!, targetSnapshot: b.snapshot!, sourceOperation: sourceOp, targetOperation: targetOp, seatToleranceM });
  }));
}

/** Pure repair: preserve CSV bytes except dock channels. Both trees must agree before a sync. */
export function planDockChannelRepair(snapshot: Snapshot) {
  const pose = snapshotDockPose(snapshot);
  if (!pose) throw new TextError(M`Geen eenduidige opgeslagen dockpositie.`);
  const x3 = snapshot.x3_csv_files as Record<string, string> | undefined;
  const csv = reconcileMowerCsvTrees(csvOf(snapshot), x3);
  if (!csv || !x3) throw new TextError(M`De twee kaartkopieën op de maaier verschillen; geen automatische kanaalreparatie mogelijk.`);
  // The stale secondary dock metadata is part of this repair. Its polygon
  // bytes must agree; the independently confirmed primary metadata wins.
  const secondaryPose = JSON.parse(x3['map_info.json']).charging_pose;
  if (!secondaryPose || ![secondaryPose.x, secondaryPose.y, secondaryPose.orientation].every(Number.isFinite)) throw new TextError(M`Ongeldige tweede dockverwijzing.`);
  // Reject unknown files rather than omit an obstacle from the corridor check.
  for (const name of Object.keys(csv)) if (name !== 'map_info.json' && !/^map\d+(?:_work|_\d+_obstacle|tocharge_unicom|tomap\d+.*_unicom)\.csv$/.test(name)) throw new TextError(M`Onbekend kaartbestand: ${name}`);
  const obstacles = Object.entries(csv).filter(([n]) => n.endsWith('_obstacle.csv')).map(([n, text]) => parseMapCsv(text, n));
  if (obstacles.some(p => p.length < 3)) throw new TextError(M`Ongeldig obstakel.`);
  let channels = Object.keys(csv).filter(n => DOCK_CHANNEL.test(n)).map(name => {
    const workName = `${name.split('tocharge')[0]}_work.csv`;
    if (!(workName in csv)) throw new TextError(M`Werkgebied ontbreekt voor ${name}.`);
    const work = parseMapCsv(csv[workName], workName);
    if (work.length < 3) throw new TextError(M`Ongeldig werkgebied: ${workName}`);
    const points = dockChannelPoints(pose, work, obstacles);
    if (!points) throw new TextError(M`Geen vrije dockaanloop binnen ${workName}; teken een gecontroleerde doorgang.`);
    return { name, points, previous: parseMapCsv(csv[name], name) };
  });
  // No dock channel at all. Only the end of a map0 mapping session makes the
  // firmware write one, so without this there was no way back short of
  // retracing the main zone (field report, Oct 2026). Lead from the saved dock
  // into the zone it sits in, or the nearest one within DOCK_MAX_M, exactly
  // as a zone copy does.
  const created = !channels.length;
  if (created) {
    const zone = Object.keys(csv).filter(n => /^map\d+_work\.csv$/.test(n))
      .map(name => ({ name, work: parseMapCsv(csv[name], name) }))
      .filter(z => z.work.length >= 3)
      .map(z => ({ ...z, dist: distanceToPolygon(pose, z.work) }))
      .sort((a, b) => a.dist - b.dist || a.name.localeCompare(b.name, undefined, { numeric: true }))[0];
    if (!zone || zone.dist > DOCK_MAX_M) throw new TextError(M`Het opgeslagen dock ligt verder dan ${DOCK_MAX_M} m van elke zone; er is geen dockkanaal aan te maken.`);
    const points = dockChannelPoints(pose, zone.work, obstacles);
    if (!points) throw new TextError(M`Geen vrije dockaanloop binnen ${zone.name}; teken een gecontroleerde doorgang.`);
    channels = [{ name: `${zone.name.slice(0, -'_work.csv'.length)}tocharge_unicom.csv`, points, previous: [] }];
  }
  const csvFiles = { ...csv };
  for (const c of channels) csvFiles[c.name] = c.points.map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).join('\n') + '\n';
  const secondaryMetadataChanged = x3['map_info.json'] !== csv['map_info.json'];
  // A firmware-recorded channel that already starts at the saved dock must not
  // be swapped for a straight synthetic one just because someone pressed repair.
  const needed = created || secondaryMetadataChanged || !snapshotAnchorMatches(snapshot, pose) || !snapshotAnchorMatches({ ...snapshot, csv_files: x3 }, pose);
  return { pose, channels, csvFiles, secondaryMetadataChanged, created, needed };
}

export async function csvZip(files: Record<string, string>): Promise<Buffer> {
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
    const live = ready(sn);
    const { snapshot, pose } = await readDock(sn, operation, false, true);
    const offset = mapRepo.getPolygonOffset(sn);
    if (offset.x || offset.y) throw new TextError(M`Kanaalreparatie vereist een kaart zonder fysieke verschuiving.`);
    assertStoredGeometry(sn, snapshot);
    const plan = planDockChannelRepair(snapshot);
    // Rebuilding an existing channel keeps both gates. Creating a missing one
    // needs neither: the channel goes to the saved pose in the map frame, and
    // the re-anchor that has to follow aligns the GPS frame to it. A frame that
    // is off is exactly why such a mower cannot sit within 10 cm of its pose.
    if (!plan.created && isFrameUnvalidated(sn)) throw VALIDATED_FRAME_REQUIRED();
    const seat = () => plan.created ? ready(sn) : ready(sn, pose);
    seat();
    const rows = mapRepo.findByMowerSn(sn);
    const photo = getPhotoDockPose(sn);
    const hash = () => createHash('sha256').update(JSON.stringify({
      csv: Object.entries(csvOf(snapshot)).sort(), x3: Object.entries(snapshot.x3_csv_files as object).sort(),
      origin: snapshot.pos_json, yaml: snapshot.charging_station_yaml,
      rows: mapRepo.findByMowerSn(sn), calibration: mapRepo.getCalibration(sn), photo: getPhotoDockPose(sn),
    })).digest('hex');
    const planHash = hash();
    const preview = {
      planHash, dock: pose, channels: plan.channels, secondaryMetadataChanged: plan.secondaryMetadataChanged,
      created: plan.created, needed: plan.needed, zone: plan.created ? plan.channels[0].name.split('tocharge')[0] : null,
      seatOffsetM: Math.round(Math.hypot(live.x - pose.x, live.y - pose.y) * 1000) / 1000,
      preserves: ['work', 'obstacles', 'pos.json', 'charging_station.yaml', 'photo calibration'],
    };
    if (expectedHash === undefined) return { ok: true, preview };
    if (!plan.needed) throw new TextError(M`Het dockkanaal begint al op het opgeslagen dock; er is niets te herstellen.`);
    if (expectedHash !== planHash) throw new TextError(M`Kaart of kalibratie gewijzigd; vraag een nieuw voorbeeld op.`);
    const root = path.resolve(process.env.STORAGE_PATH ?? './storage');
    const backupDir = path.join(root, 'dock-channel-repair', operation.id);
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, 'before.json'), JSON.stringify({ sn, snapshot, rows, calibration: mapRepo.getCalibration(sn), photo, preview }), { flag: 'wx' });
    const bytes = await csvZip(plan.csvFiles);
    writeFileSync(path.join(backupDir, 'repair.zip'), bytes, { flag: 'wx' });
    seat();
    if (hash() !== planHash) throw new TextError(M`Kaart gewijzigd tijdens voorbereiding.`);
    const apply = beginMapApply(sn);
    apply.phase('syncing');
    try {
      const after = await installVerifiedMapZip(sn, { bytes, expectedCsv: new Map(Object.entries(plan.csvFiles)), before: snapshot, anchor: pose }, operation, apply);
      if (!after) throw new TextError(M`Kanaaloverdracht niet bevestigd; frame blijft geblokkeerd.`);
      const rasters = after.map_files_b64 as Record<string, string>;
      const text = after.map_files_text as Record<string, string>;
      const slots = Object.keys(plan.csvFiles).filter(n => /^map\d+_work\.csv$/.test(n)).map(n => n.slice(0, -9));
      const validation = validateMapRasters(rasters);
      if (!rasters || !text || ['map', ...slots].some(n => !rasters[`${n}.pgm`] || !text[`${n}.yaml`] || !validation.stats[`${n}.pgm`]?.total) || !validation.ok) throw new TextError(M`Navigatiekaarten zijn niet geldig opgebouwd.`);
      seat();
      // Device first, then server. A crash or commit failure keeps navigation blocked.
      const latest = path.join(root, 'maps', `${sn}_latest.zip`);
      mkdirSync(path.dirname(latest), { recursive: true });
      writeFileSync(`${latest}.repair`, bytes);
      renameSync(`${latest}.repair`, latest);
      db.transaction(() => {
        for (const c of plan.channels) {
          const canonical = c.name.slice(0, -4);
          const row = mapRepo.findBySnAndCanonical(sn, canonical);
          if (!row && !plan.created) throw new TextError(M`Dockkanaal verdwenen tijdens reparatie.`);
          const pts = parseMapCsv(plan.csvFiles[c.name], c.name);
          const bounds = JSON.stringify({ minX: Math.min(...pts.map(p => p.x)), maxX: Math.max(...pts.map(p => p.x)), minY: Math.min(...pts.map(p => p.y)), maxY: Math.max(...pts.map(p => p.y)) });
          if (row) mapRepo.updateAreaAndBoundsByIdAndMower(row.map_id, sn, JSON.stringify(pts), bounds);
          else mapRepo.create({ map_id: randomUUID(), mower_sn: sn, map_name: canonical, canonical_name: canonical, file_name: c.name,
            map_area: JSON.stringify(pts), map_max_min: bounds, map_type: 'unicom', source: 'mower' });
        }
        mapRepo.setPolygonChargingOrientation(sn, pose.orientation);
        if (photo) deviceSettingsRepo.upsert(sn, PHOTO_DOCK_KEY, JSON.stringify(photo));
      })();
      writeFileSync(path.join(backupDir, 'after.json'), JSON.stringify(after), { flag: 'wx' });
      clearMapInstallPending(sn);
      apply.done();
      return { ok: true, preview, backupId: operation.id, applied: true };
    } catch (error) { apply.fail('sync_failed'); throw error; }
  });
}
