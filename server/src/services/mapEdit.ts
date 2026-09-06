/**
 * Map & obstacle bewerking: drafts, validatie, apply naar maaier, revert.
 * Spec: docs/superpowers/specs/2026-06-10-map-obstacle-editing-design.md
 */
import { mapRepo, mapEditsRepo, deviceSettingsRepo } from '../db/repositories/index.js';
import type { MapRow } from '../db/repositories/maps.js';
import {
  simplifyPolygon, validateMapSet, type XY, type ValidationResult,
} from '../maps/editGeometry.js';
import { deviceCache } from '../mqtt/sensorData.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { getMowerFileCapability } from './mowerFileCapability.js';
import { db } from '../db/database.js';

const TAG = '[MAP-EDIT]';
// 5mm RDP: removes duplicates + straight-run redundancy but keeps every real
// curve (a small circle's arc deviates far more than 5mm from its chords, so its
// vertices survive). The old 0.05 (5cm) flattened small circles — #91.
const SIMPLIFY_TOL_M = 0.005;
const PENDING_KEY = 'map_edit_pending_sync';
const VERSIONS_KEEP = 10;

export interface EditMapEntry {
  mapId: string;
  canonical: string;
  mapType: 'work' | 'obstacle' | 'unicom';
  alias: string | null;
  parentMap: string | null;
  points: XY[];                                   // vereenvoudigd, lokale meters
  draft: { points: XY[]; deleted: boolean; isNew: boolean } | null;
}
export interface EditGeometry {
  maps: EditMapEntry[];
  pendingSync: boolean;
  hasVersions: boolean;
}

function parentMapOf(canonical: string): string | null {
  const m = canonical.match(/^(map\d+)_\d+_obstacle$/);
  return m ? m[1] : null;
}

function parseArea(row: Pick<MapRow, 'map_area'>): XY[] {
  if (!row.map_area) return [];
  try { return JSON.parse(row.map_area) as XY[]; } catch { return []; }
}

function parseDraftArea(s: string | null): XY[] {
  if (!s) return [];
  try { return JSON.parse(s) as XY[]; } catch { return []; }
}

function isPendingSync(sn: string): boolean {
  return deviceSettingsRepo.findBySn(sn).some(r => r.key === PENDING_KEY && r.value === '1');
}

export function getEditGeometry(sn: string): EditGeometry {
  const rows = mapRepo.findByMowerSn(sn);
  const drafts = new Map(mapEditsRepo.listDrafts(sn).map(d => [d.canonical_name, d]));
  const maps: EditMapEntry[] = [];

  for (const row of rows) {
    const canonical = row.canonical_name;
    if (!canonical) continue;                      // niet-canonieke rijen (zips e.d.) niet editbaar
    const pts = parseArea(row);
    if (row.map_type !== 'unicom' && pts.length < 3) continue;
    const d = drafts.get(canonical);
    drafts.delete(canonical);
    maps.push({
      mapId: row.map_id,
      canonical,
      mapType: (row.map_type as EditMapEntry['mapType']) ?? 'work',
      alias: row.map_name,
      parentMap: parentMapOf(canonical),
      points: row.map_type === 'unicom' ? pts : simplifyPolygon(pts, SIMPLIFY_TOL_M),
      draft: d ? { points: parseDraftArea(d.draft_area), deleted: d.deleted === 1, isNew: !d.map_id } : null,
    });
  }
  // Overgebleven drafts = nieuw getekende obstacles (geen maps-rij)
  for (const d of drafts.values()) {
    maps.push({
      mapId: d.map_id ?? '',
      canonical: d.canonical_name,
      mapType: 'obstacle',
      alias: null,
      parentMap: d.parent_map,
      points: [],
      draft: { points: parseDraftArea(d.draft_area), deleted: d.deleted === 1, isNew: true },
    });
  }
  return { maps, pendingSync: isPendingSync(sn), hasVersions: !!mapEditsRepo.latestVersion(sn) };
}

export interface SaveDraftInput {
  canonical?: string;
  mapType?: 'work' | 'obstacle';
  parentMap?: string;          // verplicht bij nieuw obstacle
  points?: XY[];
  deleted?: boolean;
}
export interface SaveDraftResult { ok: boolean; canonical?: string; error?: string }

export function saveDraft(sn: string, input: SaveDraftInput): SaveDraftResult {
  if (input.canonical) {
    const row = mapRepo.findBySnAndCanonical(sn, input.canonical);
    if (row) {
      if (row.map_type === 'unicom') return { ok: false, error: 'Unicom-paden zijn niet bewerkbaar' };
      if (input.deleted) {
        if (row.map_type !== 'obstacle') return { ok: false, error: 'Alleen obstacles kunnen verwijderd worden' };
        mapEditsRepo.upsertDraft({ mower_sn: sn, canonical_name: input.canonical, map_id: row.map_id,
          map_type: 'obstacle', parent_map: parentMapOf(input.canonical), draft_area: null, deleted: 1 });
        return { ok: true, canonical: input.canonical };
      }
      if (!input.points || input.points.length < 3) return { ok: false, error: 'Minimaal 3 punten nodig' };
      mapEditsRepo.upsertDraft({ mower_sn: sn, canonical_name: input.canonical, map_id: row.map_id,
        map_type: row.map_type as 'work' | 'obstacle', parent_map: parentMapOf(input.canonical),
        draft_area: JSON.stringify(input.points), deleted: 0 });
      return { ok: true, canonical: input.canonical };
    }
    // Geen committed map — maar mogelijk een bestaande DRAFT (een net-geplakt of
    // -getekend nieuw obstakel leeft alleen als draft, met een server-toegekende
    // canonical). Bewerken/verplaatsen/verwijderen daarvan moet gewoon werken.
    const draft = mapEditsRepo.listDrafts(sn).find(d => d.canonical_name === input.canonical);
    if (draft) {
      if (draft.map_type === 'unicom') return { ok: false, error: 'Unicom-paden zijn niet bewerkbaar' };
      if (input.deleted) {
        // Een nog niet-gecommit nieuw obstakel verwijderen = de draft droppen.
        if (!draft.map_id) { mapEditsRepo.deleteDraft(sn, input.canonical); return { ok: true, canonical: input.canonical }; }
        mapEditsRepo.upsertDraft({ mower_sn: sn, canonical_name: input.canonical, map_id: draft.map_id,
          map_type: 'obstacle', parent_map: draft.parent_map, draft_area: null, deleted: 1 });
        return { ok: true, canonical: input.canonical };
      }
      if (!input.points || input.points.length < 3) return { ok: false, error: 'Minimaal 3 punten nodig' };
      mapEditsRepo.upsertDraft({ mower_sn: sn, canonical_name: input.canonical, map_id: draft.map_id,
        map_type: draft.map_type as 'work' | 'obstacle', parent_map: draft.parent_map,
        draft_area: JSON.stringify(input.points), deleted: 0 });
      return { ok: true, canonical: input.canonical };
    }
    return { ok: false, error: `Onbekende kaart ${input.canonical}` };
  }

  if (input.mapType !== 'obstacle' || !input.parentMap) {
    return { ok: false, error: 'Nieuw tekenen kan alleen als obstacle met parentMap' };
  }
  if (!input.points || input.points.length < 3) return { ok: false, error: 'Minimaal 3 punten nodig' };
  const taken = new Set<string>([
    ...mapRepo.findByMowerSn(sn).map(r => r.canonical_name ?? ''),
    ...mapEditsRepo.listDrafts(sn).map(d => d.canonical_name),
  ]);
  let idx = 0;
  while (taken.has(`${input.parentMap}_${idx}_obstacle`)) idx++;
  const canonical = `${input.parentMap}_${idx}_obstacle`;
  mapEditsRepo.upsertDraft({ mower_sn: sn, canonical_name: canonical, map_id: null,
    map_type: 'obstacle', parent_map: input.parentMap,
    draft_area: JSON.stringify(input.points), deleted: 0 });
  return { ok: true, canonical };
}

export function discardDrafts(sn: string): void {
  mapEditsRepo.clearDrafts(sn);
  // Also clear a stuck pending-sync flag: when a push failed the DB was already
  // mutated and the flag stays '1' forever (a failed re-sync never clears it),
  // so the floating edit bar can never be dismissed. Discard = "give up, clear
  // everything" → the user's unconditional escape hatch out of that state.
  deviceSettingsRepo.upsert(sn, PENDING_KEY, '0');
}

// ── Task 7: apply / revert ──────────────────────────────────────────────────

// Zelfde logica als isCoverageActive in dashboard.ts (daar private; hier
// gedupliceerd om een route↔service import-cyclus te vermijden).
function isMowerBusy(sn: string): boolean {
  const sensors = deviceCache.get(sn);
  if (!sensors) return false;
  // Op de dock / aan het laden = NIET bezig: map-edits toepassen is dan veilig,
  // ook als er nog een gepauzeerde cover-taak geladen is (battery-low recharge
  // houdt task_mode op 1 + Mode:COVERAGE → anders onterecht "bezig"). Dit is
  // precies het scenario "obstakel plaatsen terwijl de maaier op het dock laadt".
  const batteryState = (sensors.get('battery_state') ?? '').toUpperCase();
  if (batteryState === 'CHARGING' || batteryState === 'FULL') return false;
  const msg = sensors.get('msg') ?? '';
  const taskMode = parseInt(sensors.get('task_mode') ?? '0', 10);
  if (msg.includes('Work:RUNNING') || msg.includes('Work:COVERING')
      || msg.includes('Work:NAVIGATING') || msg.includes('Work:MOVING')) return true;
  // Fallback alleen bij een ACTIEVE taak (task_mode===1). Een idle maaier houdt
  // "Mode:COVERAGE" als laatst-gekozen modus-label, wat 'm anders onterecht als
  // bezig markeerde en Apply blokkeerde. Gelijkgetrokken met isCoverageActive.
  if (taskMode === 1 && msg.includes('Mode:COVERAGE') && !msg.includes('Work:STANDBY') && !msg.includes('Work:IDLE')) return true;
  return false;
}

// Map edits may ONLY be applied/reverted while the mower sits on the dock.
// On the dock the server captures the mower's real live charging pose
// (getDockPose, from map_position), which createBundleFromDb then uses for the
// regenerated bundle — so a zeroed/anchor-guessed dock pose can never be pushed
// (this is what corrupted .100). Same "docked" signal as sensorData
// isDockedByValues: battery_state CHARGING/FULL, or recharge_status 9.
function isMowerDocked(sn: string): boolean {
  const sensors = deviceCache.get(sn);
  if (!sensors) return false;
  const rs = sensors.get('recharge_status') ?? '';
  if (rs === '9' || rs.startsWith('Charging')) return true;
  const bs = (sensors.get('battery_state') ?? '').toUpperCase();
  return bs === 'CHARGING' || bs === 'FULL';
}

export interface ApplyResult {
  ok: boolean;
  reason?: 'offline' | 'busy' | 'not_docked' | 'locked' | 'no_changes' | 'validation' | 'bundle_failed' | 'push_failed' | 'no_version' | 'unsupported_firmware';
  validation?: ValidationResult;
  applied?: { canonical: string; action: 'updated' | 'created' | 'deleted' }[];
}

const applyLocks = new Set<string>();

interface SnapshotRow {
  map_id: string; canonical_name: string | null; map_type: string;
  map_name: string | null; map_area: string | null; map_max_min: string | null; file_name: string | null;
  file_size: number | null;
}

function snapshotMaps(sn: string): string {
  const rows = mapRepo.findByMowerSn(sn).map((r): SnapshotRow => ({
    map_id: r.map_id, canonical_name: r.canonical_name, map_type: r.map_type,
    map_name: r.map_name, map_area: r.map_area, map_max_min: r.map_max_min, file_name: r.file_name,
    file_size: r.file_size,
  }));
  return JSON.stringify(rows);
}

function boundsOf(pts: XY[]): string {
  if (pts.length === 0) return JSON.stringify({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
  return JSON.stringify({
    minX: Math.min(...pts.map(p => p.x)), maxX: Math.max(...pts.map(p => p.x)),
    minY: Math.min(...pts.map(p => p.y)), maxY: Math.max(...pts.map(p => p.y)),
  });
}

async function bundleAndPush(sn: string): Promise<ApplyResult> {
  const { createBundleFromDb } = await import('./portableBackup.js');
  const { pushMapToMowerVerbatim } = await import('../mqtt/mapSync.js');
  const bundle = await createBundleFromDb(sn, 'map_edit');
  if (!bundle) {
    return { ok: false, reason: 'bundle_failed' };
  }
  const push = await pushMapToMowerVerbatim(sn, bundle.filename);
  if (!push.ok) {
    console.warn(`${TAG} ${sn}: push mislukt (${JSON.stringify(push)}) — pending sync gezet`);
    return { ok: false, reason: 'push_failed' };
  }
  deviceSettingsRepo.upsert(sn, PENDING_KEY, '0');
  return { ok: true };
}

export async function applyEdits(sn: string): Promise<ApplyResult> {
  if (applyLocks.has(sn)) return { ok: false, reason: 'locked' };
  applyLocks.add(sn);
  try {
    if (!isDeviceOnline(sn)) return { ok: false, reason: 'offline' };
    if (isMowerBusy(sn)) return { ok: false, reason: 'busy' };
    if (!isMowerDocked(sn)) return { ok: false, reason: 'not_docked' };
    // Toepassen loopt via write_map_files op het extended-kanaal — dat bestaat
    // alleen in OpenNova custom firmware. Op stock luistert niets: de push
    // liep in een timeout ("push failed") terwijl de DB al gemuteerd was, en
    // app en maaier liepen uit elkaar (waltervl, stock 5.7.1). Daarom vóór
    // elke mutatie weigeren; de drafts blijven staan.
    if (!getMowerFileCapability(sn).mowerFileApplySupported) return { ok: false, reason: 'unsupported_firmware' };

    const drafts = mapEditsRepo.listDrafts(sn);
    if (drafts.length === 0) {
      // Geen edits — maar een eerdere apply kan zijn blijven hangen: retry de push.
      if (isPendingSync(sn)) return bundleAndPush(sn);
      return { ok: false, reason: 'no_changes' };
    }

    // Merged state opbouwen: huidige maps + drafts erover
    const rows = mapRepo.findByMowerSn(sn);
    const byCanonical = new Map(rows.filter(r => r.canonical_name).map(r => [r.canonical_name as string, r]));
    const originals = new Map<string, XY[]>();
    const work: { canonical: string; points: XY[] }[] = [];
    const obstacles: { canonical: string; parentMap: string; points: XY[] }[] = [];
    for (const row of rows) {
      if (!row.canonical_name || !row.map_area) continue;
      originals.set(row.canonical_name, parseArea(row));
    }
    const draftMap = new Map(drafts.map(d => [d.canonical_name, d]));
    const allCanonicals = new Set([...byCanonical.keys(), ...draftMap.keys()]);
    for (const canonical of allCanonicals) {
      const d = draftMap.get(canonical);
      const row = byCanonical.get(canonical);
      if (d?.deleted) continue;                          // verwijderd → niet valideren
      const pts: XY[] = d?.draft_area ? parseDraftArea(d.draft_area) : (row ? parseArea(row) : []);
      const type = d?.map_type ?? row?.map_type;
      if (type === 'work' && pts.length >= 3) work.push({ canonical, points: pts });
      else if (type === 'obstacle' && pts.length >= 3) {
        obstacles.push({ canonical, parentMap: d?.parent_map ?? parentMapOf(canonical) ?? '', points: pts });
      }
    }
    // Alleen de daadwerkelijk bewerkte polygonen (drafts) hard valideren —
    // onaangeraakte mower-maps (vaak licht zelf-kruisend door GPS-ruis) mogen een
    // edit niet blokkeren. De drafts-set bevat alle bewerkte canonicals.
    const editedCanonicals = new Set(drafts.map(d => d.canonical_name));
    const validation = validateMapSet({ work, obstacles }, originals, editedCanonicals);
    if (!validation.ok) return { ok: false, reason: 'validation', validation };

    // Snapshot + mutaties in één transactie
    const applied: NonNullable<ApplyResult['applied']> = [];
    db.transaction(() => {
      mapEditsRepo.saveVersion(sn, snapshotMaps(sn), `voor apply ${new Date().toISOString()}`);
      mapEditsRepo.pruneVersions(sn, VERSIONS_KEEP);
      for (const d of drafts) {
        const row = byCanonical.get(d.canonical_name);
        if (d.deleted) {
          if (row) { mapRepo.deleteByIdAndMower(row.map_id, sn); applied.push({ canonical: d.canonical_name, action: 'deleted' }); }
        } else if (row) {
          const pts = parseDraftArea(d.draft_area);
          mapRepo.updateAreaAndBoundsByIdAndMower(row.map_id, sn, JSON.stringify(pts), boundsOf(pts));
          applied.push({ canonical: d.canonical_name, action: 'updated' });
        } else {
          const pts = parseDraftArea(d.draft_area);
          mapRepo.create({
            map_id: `edit_${d.canonical_name}_${Date.now()}`, mower_sn: sn,
            map_type: 'obstacle', file_name: `${d.canonical_name}.csv`,
            map_area: JSON.stringify(pts), map_max_min: boundsOf(pts),
          });
          applied.push({ canonical: d.canonical_name, action: 'created' });
        }
      }
      mapEditsRepo.clearDrafts(sn);
      deviceSettingsRepo.upsert(sn, PENDING_KEY, '1');
    })();

    const pushRes = await bundleAndPush(sn);
    // Bewust: ook bij push_failed gaan validation+applied mee terug — de DB-mutatie
    // is dan al gebeurd (pending sync), dus warnings/applied zijn accuraat voor de UI.
    return { ...pushRes, validation, applied };
  } finally {
    applyLocks.delete(sn);
  }
}

export async function revertEdits(sn: string): Promise<ApplyResult> {
  if (applyLocks.has(sn)) return { ok: false, reason: 'locked' };
  applyLocks.add(sn);
  try {
    if (!isDeviceOnline(sn)) return { ok: false, reason: 'offline' };
    if (isMowerBusy(sn)) return { ok: false, reason: 'busy' };
    if (!isMowerDocked(sn)) return { ok: false, reason: 'not_docked' };
    const version = mapEditsRepo.latestVersion(sn);
    if (!version) return { ok: false, reason: 'no_version' };
    // Op stock firmware is er nooit iets naar de maaier gegaan; de DB
    // terugzetten is precies wat app en maaier weer gelijk trekt. Geen push.
    const pushSupported = getMowerFileCapability(sn).mowerFileApplySupported;
    const snapshot = JSON.parse(version.snapshot) as SnapshotRow[];

    db.transaction(() => {
      const current = mapRepo.findByMowerSn(sn);
      const snapIds = new Set(snapshot.map(r => r.map_id));
      for (const row of current) {
        if (!snapIds.has(row.map_id)) mapRepo.deleteByIdAndMower(row.map_id, sn);
      }
      const currentIds = new Set(current.map(r => r.map_id));
      for (const r of snapshot) {
        if (currentIds.has(r.map_id)) {
          // Restore area + bounds. When the snapshot has no bounds (row was
          // created without map_max_min), recompute them from the area so the
          // UPDATE condition doesn't silently skip the restore.
          if (r.map_area) {
            let bounds = r.map_max_min;
            if (!bounds) {
              try { bounds = boundsOf(JSON.parse(r.map_area) as XY[]); } catch { bounds = '{}'; }
            }
            mapRepo.updateAreaAndBoundsByIdAndMower(r.map_id, sn, r.map_area, bounds);
          }
        } else {
          mapRepo.create({ map_id: r.map_id, mower_sn: sn, map_name: r.map_name,
            map_type: r.map_type, file_name: r.file_name, file_size: r.file_size,
            canonical_name: r.canonical_name, map_area: r.map_area, map_max_min: r.map_max_min });
        }
      }
      mapEditsRepo.deleteVersion(version.id);
      mapEditsRepo.clearDrafts(sn);
      deviceSettingsRepo.upsert(sn, PENDING_KEY, '1');
    })();

    if (!pushSupported) {
      deviceSettingsRepo.upsert(sn, PENDING_KEY, '0');
      return { ok: true };
    }
    return bundleAndPush(sn);
  } finally {
    applyLocks.delete(sn);
  }
}
