import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { reconcileMowerCsvTrees, sameMapFile, sameMapInfo } from './portableSnapshot.js';
import path from 'node:path';
import { db } from '../db/database.js';
import { mapRepo, deviceSettingsRepo } from '../db/repositories/index.js';
import { polygonArea } from '../maps/editGeometry.js';
import { validateMapRasters } from '../maps/validateGrid.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { csvZip, type ConfirmedCopyDocks } from './dockChannelRepair.js';
import { getPhotoDockPose, PHOTO_DOCK_KEY } from './dockPhotoReference.js';
import { isFrameUnvalidated, isMapInstallPending, markFrameUnvalidated } from './frameValidation.js';
import { beginMapApply, confirmMapInstall } from './mapApplyStatus.js';
import { assertMowerMapOperation } from './mowerMapOperation.js';
import { installVerifiedMapZip } from './mowerMapApply.js';
import { DOCK_SEAT_TOLERANCE_M, stablePosition } from './positionTelemetry.js';
import { persistZoneCopy, type CopyPlan, type PersistResult } from './zoneCopy.js';
import { M, TextError } from './serverText.js';

/** Both leases remain owned by the copy route until device verification and DB commit. */
export async function installZoneCopy(
  sn: string,
  plan: CopyPlan,
  opts: { alias: string | null; acceptChannel: boolean },
  docks: ConfirmedCopyDocks,
  verifyBeforeInstall: () => Promise<{ verifyRuntime: () => Promise<Record<string, unknown>> }>,
): Promise<PersistResult> {
  const { targetOperation: operation, sourceOperation, targetSnapshot: before, target: dock } = docks;
  const ready = () => {
    assertMowerMapOperation(sn, operation);
    assertMowerMapOperation(sourceOperation.sn, sourceOperation);
    const position = stablePosition(sn, { docked: true });
    const tolerance = docks.seatToleranceM ?? DOCK_SEAT_TOLERANCE_M;
    if (!isDeviceOnline(sn) || !position || Math.hypot(position.x - dock.x, position.y - dock.y) > tolerance) {
      throw new TextError(M`Zet de doelmaaier op zijn eigen dock met stabiele RTK Fixed-lokalisatie binnen ${Math.round(tolerance * 100)} cm van de opgeslagen dockpositie.`);
    }
  };
  ready();
  // A copy is a full CSV install, so like /apply it may retry a pending one.
  if (!plan.ok || (isFrameUnvalidated(sn) && !isMapInstallPending(sn))) throw new TextError(M`De kopie of het kaartframe is niet bevestigd.`);
  const original = before.csv_files as Record<string, string>;
  const x3 = before.x3_csv_files as Record<string, string>;
  // Filtered connectors in csv_file with the full route in x3_csv_file are one
  // map (natively mapped touching zones); the copy ships the full route to both.
  const merged = reconcileMowerCsvTrees(original, x3);
  if (!merged || !sameMapInfo(x3['map_info.json'], merged['map_info.json'])) {
    throw new TextError(M`De twee kaartkopieën op de doelmaaier verschillen; synchroniseer die eerst.`);
  }
  const csv = { ...merged };
  const workName = `${plan.canonical}_work.csv`;
  // Files of an install that never completed, unknown to the DB, are
  // replaced by the retry rather than blocking it.
  if (isMapInstallPending(sn)) {
    const known = new Set(mapRepo.findByMowerSn(sn).map(r => r.canonical_name));
    for (const name of Object.keys(csv)) if (name.endsWith('.csv') && !known.has(name.replace(/(?:_work)?\.csv$/, ''))) delete csv[name];
  }
  if (plan.replacesExisting) {
    const slot = plan.canonical;
    const related = new RegExp(`^(?:${slot}_work|${slot}_\\d+_obstacle|${slot}tocharge_unicom|${slot}tomap\\d+_\\d+_unicom|map\\d+to${slot}_\\d+_unicom)\\.csv$`);
    for (const name of Object.keys(csv)) if (related.test(name)) delete csv[name];
  } else if (workName in csv) throw new TextError(M`Het gekozen kaartslot is niet meer vrij.`);
  const additions = [{ canonical: `${plan.canonical}_work`, points: plan.work }, ...plan.obstacles,
    ...(opts.acceptChannel ? plan.channels : [])];
  for (const area of additions) csv[`${area.canonical}.csv`] = area.points.map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).join('\n') + '\n';
  const metadata = JSON.parse(csv['map_info.json']);
  metadata[workName] = { map_size: Math.round(polygonArea(plan.work) * 100) / 100 };
  for (const key of Object.keys(metadata)) if (key !== 'charging_pose' && !(key in csv)) delete metadata[key];
  csv['map_info.json'] = JSON.stringify(metadata, null, 3) + '\n';

  const rows = mapRepo.findByMowerSn(sn), photo = getPhotoDockPose(sn);
  const unchanged = () => JSON.stringify(mapRepo.findByMowerSn(sn)) === JSON.stringify(rows);
  const root = path.resolve(process.env.STORAGE_PATH ?? './storage');
  const backupDir = path.join(root, 'zone-copy', operation.id);
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(path.join(backupDir, 'before.json'), JSON.stringify({ sn, sourceSn: sourceOperation.sn, snapshot: before,
    sourceSnapshot: docks.sourceSnapshot, rows, calibration: mapRepo.getCalibration(sn), photo, plan }), { flag: 'wx' });
  const bytes = await csvZip(csv);
  writeFileSync(path.join(backupDir, 'copy.zip'), bytes, { flag: 'wx' });
  // Do the fresh comparison after ZIP preparation, immediately before any device write.
  const verification = await verifyBeforeInstall();
  ready();
  if (!unchanged()) throw new TextError(M`De doelkaart is tijdens de voorbereiding gewijzigd.`);
  const apply = beginMapApply(sn);
  apply.phase('syncing');
  let transferFailed = false;
  try {
    const after = await installVerifiedMapZip(sn, { bytes, expectedCsv: new Map(Object.entries(csv)), before, anchor: dock }, operation, apply);
    if (!after) { transferFailed = true; throw new TextError(M`Kaartoverdracht niet bevestigd; de kopie is niet opgeslagen.`); }
    const rasters = after.map_files_b64 as Record<string, string>;
    const text = after.map_files_text as Record<string, string>;
    const slots = Object.keys(csv).filter(n => /^map\d+_work\.csv$/.test(n)).map(n => n.slice(0, -9));
    const validation = validateMapRasters(rasters);
    if (!rasters || !text || !validation.ok || ['map', ...slots].some(n =>
      !rasters[`${n}.pgm`] || !text[`${n}.yaml`] || !validation.stats[`${n}.pgm`]?.total)) {
      throw new TextError(M`De navigatiekaarten zijn niet geldig opgebouwd.`);
    }
    const current = await verification.verifyRuntime().catch(error => {
      // A failed frame measurement needs recovery independently of the files.
      markFrameUnvalidated(sn, { preservePhotoDock: true });
      throw error;
    });
    // The runtime check takes time; its final native read must still contain this exact installation.
    if (current.pos_json !== before.pos_json || current.charging_station_yaml !== before.charging_station_yaml) {
      markFrameUnvalidated(sn, { preservePhotoDock: true });
      throw new TextError(M`De kaartreferentie is tijdens de eindcontrole gewijzigd.`);
    }
    if (['csv_files', 'x3_csv_files'].some(key => {
        const files = current[key] as Record<string, string> | undefined;
        return !files || Object.keys(files).length !== Object.keys(csv).length || Object.entries(csv).some(([name, text]) => !sameMapFile(name, text, files[name]));
      })) throw new TextError(M`De kaartbestanden zijn tijdens de eindcontrole gewijzigd.`);
    if (['map_files_b64', 'map_files_text'].some(key => {
      const previous = after[key] as Record<string, string>;
      const files = current[key] as Record<string, string> | undefined;
      return !files || Object.keys(files).length !== Object.keys(previous).length || Object.entries(previous).some(([name, text]) => files[name] !== text);
    })) throw new TextError(M`De navigatiekaarten zijn tijdens de eindcontrole gewijzigd.`);
    ready();
    if (!unchanged()) throw new TextError(M`De doelkaart is tijdens de overdracht gewijzigd.`);
    writeFileSync(path.join(backupDir, 'after.json'), JSON.stringify(after), { flag: 'wx' });
    const latest = path.join(root, 'maps', `${sn}_latest.zip`);
    mkdirSync(path.dirname(latest), { recursive: true });
    writeFileSync(`${latest}.copy`, bytes);
    renameSync(`${latest}.copy`, latest);
    const saved = db.transaction(() => {
      const result = persistZoneCopy(sn, plan, { ...opts, dockOrientation: dock.orientation });
      if (photo) deviceSettingsRepo.upsert(sn, PHOTO_DOCK_KEY, JSON.stringify(photo));
      return result;
    })();
    confirmMapInstall(sn);
    return saved;
  } catch (error) {
    if (!transferFailed) apply.fail('sync_failed'); // Preserve the installer's specific failure.
    throw error;
  }
}
