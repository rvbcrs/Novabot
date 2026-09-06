/**
 * Tests for mapEdit service — geometry, drafts, apply, revert.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock de maaier-kant VOOR de service-import (apply/revert gebruiken dit in Task 7)
vi.mock('../../services/portableBackup.js', () => ({
  createBundleFromDb: vi.fn(async () => ({ filename: 'test.novabotmap', bytes: 1, createdAt: 0, reason: 'map_edit' })),
}));
vi.mock('../../mqtt/mapSync.js', () => ({
  pushMapToMowerVerbatim: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn(() => true),
}));

import { mapRepo, mapEditsRepo } from '../../db/repositories/index.js';
import { getEditGeometry, saveDraft, discardDrafts, applyEdits, revertEdits } from '../../services/mapEdit.js';
import { createBundleFromDb } from '../../services/portableBackup.js';
import { pushMapToMowerVerbatim } from '../../mqtt/mapSync.js';
import { isDeviceOnline } from '../../mqtt/broker.js';
import { deviceCache } from '../../mqtt/sensorData.js';

// Firmware-poort: apply/revert vragen mowerFileCapability of write_map_files
// überhaupt bestaat op deze maaier. Standaard "custom" zodat de bestaande
// tests ongewijzigd blijven; de stock-tests zetten de vlag om.
const fw = vi.hoisted(() => ({ supported: true }));
vi.mock('../../services/mowerFileCapability.js', () => ({
  getMowerFileCapability: () => ({ mowerFileApplySupported: fw.supported, isOpenNova: fw.supported }),
}));

const sn = 'LFIN0001';
const square = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
const obst = [{ x: 5, y: 5 }, { x: 8, y: 5 }, { x: 8, y: 8 }, { x: 5, y: 8 }];

function seedMaps() {
  mapRepo.create({ map_id: 'w0', mower_sn: sn, map_name: 'Voortuin', map_type: 'work',
    file_name: 'map0_work.csv', map_area: JSON.stringify(square) });
  mapRepo.create({ map_id: 'o0', mower_sn: sn, map_type: 'obstacle',
    file_name: 'map0_0_obstacle.csv', map_area: JSON.stringify(obst) });
}

describe('mapEdit service: geometry + drafts', () => {
  beforeEach(seedMaps);

  it('getEditGeometry: levert maps met canonical, type en punten', () => {
    const g = getEditGeometry(sn);
    expect(g.maps.length).toBe(2);
    const work = g.maps.find(m => m.canonical === 'map0')!;
    expect(work.mapType).toBe('work');
    expect(work.points.length).toBeGreaterThanOrEqual(3);
    expect(work.draft).toBeNull();
    expect(g.hasVersions).toBe(false);
    expect(g.pendingSync).toBe(false);
  });

  it('saveDraft: bestaande polygon → draft opgeslagen en zichtbaar in geometry', () => {
    const moved = square.map(p => (p.x === 20 ? { x: 20.5, y: p.y } : p));
    const res = saveDraft(sn, { canonical: 'map0', points: moved });
    expect(res.ok).toBe(true);
    const g = getEditGeometry(sn);
    expect(g.maps.find(m => m.canonical === 'map0')!.draft?.points[1].x).toBeCloseTo(20.5, 6);
  });

  it('saveDraft: nieuw obstacle krijgt volgend vrij slot', () => {
    const res = saveDraft(sn, { mapType: 'obstacle', parentMap: 'map0',
      points: [{ x: 10, y: 10 }, { x: 12, y: 10 }, { x: 12, y: 12 }, { x: 10, y: 12 }] });
    expect(res.ok).toBe(true);
    expect(res.canonical).toBe('map0_1_obstacle');     // map0_0_obstacle bestaat al
  });

  it('saveDraft: delete-markering voor obstacle', () => {
    const res = saveDraft(sn, { canonical: 'map0_0_obstacle', deleted: true });
    expect(res.ok).toBe(true);
    const g = getEditGeometry(sn);
    expect(g.maps.find(m => m.canonical === 'map0_0_obstacle')!.draft?.deleted).toBe(true);
  });

  it('saveDraft: bewerk een net-geplakt nieuw obstakel via zijn draft-canonical (geen "Onbekende kaart")', () => {
    // Paste/draw → nieuw obstakel-draft met server-toegekende canonical.
    const pasted = saveDraft(sn, { mapType: 'obstacle', parentMap: 'map0',
      points: [{ x: 10, y: 10 }, { x: 12, y: 10 }, { x: 12, y: 12 }, { x: 10, y: 12 }] });
    expect(pasted.ok).toBe(true);
    const canonical = pasted.canonical!;          // bv. map0_1_obstacle
    // Verplaatsen/bewerken stuurt {canonical, points} — dit moet de draft updaten,
    // niet falen met "Onbekende kaart" (het is geen committed map).
    const moved = saveDraft(sn, { canonical, points: [{ x: 20, y: 20 }, { x: 22, y: 20 }, { x: 22, y: 22 }, { x: 20, y: 22 }] });
    expect(moved.ok).toBe(true);
    expect(moved.error).toBeUndefined();
    const g = getEditGeometry(sn);
    const entry = g.maps.find(m => m.canonical === canonical)!;
    expect(entry.draft?.points[0]).toEqual({ x: 20, y: 20 });
    expect(mapEditsRepo.listDrafts(sn).filter(d => d.canonical_name === canonical).length).toBe(1); // geen duplicaat
  });

  it('saveDraft: verwijder een nog niet-gecommit nieuw obstakel = draft weg', () => {
    const pasted = saveDraft(sn, { mapType: 'obstacle', parentMap: 'map0',
      points: [{ x: 10, y: 10 }, { x: 12, y: 10 }, { x: 12, y: 12 }, { x: 10, y: 12 }] });
    const canonical = pasted.canonical!;
    expect(saveDraft(sn, { canonical, deleted: true }).ok).toBe(true);
    expect(mapEditsRepo.listDrafts(sn).filter(d => d.canonical_name === canonical).length).toBe(0);
  });

  it('saveDraft: echt onbekende canonical → "Onbekende kaart"', () => {
    expect(saveDraft(sn, { canonical: 'map9_9_obstacle', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }).ok).toBe(false);
  });

  it('saveDraft: weigert delete van work-map en kapotte polygon', () => {
    expect(saveDraft(sn, { canonical: 'map0', deleted: true }).ok).toBe(false);
    expect(saveDraft(sn, { canonical: 'map0', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }).ok).toBe(false);
  });

  it('discardDrafts: alles weg', () => {
    saveDraft(sn, { canonical: 'map0_0_obstacle', deleted: true });
    discardDrafts(sn);
    expect(mapEditsRepo.listDrafts(sn).length).toBe(0);
  });
});

describe('mapEdit service: apply + revert', () => {
  beforeEach(() => {
    seedMaps();
    vi.mocked(isDeviceOnline).mockReturnValue(true);
    vi.mocked(pushMapToMowerVerbatim).mockResolvedValue({ ok: true });
    vi.mocked(pushMapToMowerVerbatim).mockClear();
    vi.mocked(createBundleFromDb).mockClear();
    // Map edits require the mower to be docked (CHARGING/FULL). Default the
    // happy-path tests to docked; the offline/busy/not_docked tests override.
    deviceCache.set(sn, new Map([['battery_state', 'CHARGING']]));
    // device_settings table is wiped by global setup beforeEach — no cleanup needed here
  });

  it('apply: happy path — DB bijgewerkt, snapshot gemaakt, push gedaan, drafts weg', async () => {
    const moved = square.map(p => (p.x === 20 ? { x: 20.5, y: p.y } : p));
    saveDraft(sn, { canonical: 'map0', points: moved });
    const res = await applyEdits(sn);
    expect(res.ok).toBe(true);
    expect(JSON.parse(mapRepo.findBySnAndCanonical(sn, 'map0')!.map_area!)[1].x).toBeCloseTo(20.5, 6);
    expect(mapEditsRepo.latestVersion(sn)).toBeTruthy();
    expect(mapEditsRepo.listDrafts(sn).length).toBe(0);
    expect(vi.mocked(createBundleFromDb)).toHaveBeenCalledWith(sn, 'map_edit');
    expect(vi.mocked(pushMapToMowerVerbatim)).toHaveBeenCalledWith(sn, 'test.novabotmap');
  });

  it('apply op STOCK firmware: geweigerd vóór elke DB-mutatie, drafts blijven, geen push', async () => {
    fw.supported = false;
    try {
      const moved = square.map(p => (p.x === 20 ? { x: 20.5, y: p.y } : p));
      saveDraft(sn, { canonical: 'map0', points: moved });
      const res = await applyEdits(sn);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('unsupported_firmware');
      // DB onaangeraakt, draft nog aanwezig, niets naar de maaier
      expect(JSON.parse(mapRepo.findBySnAndCanonical(sn, 'map0')!.map_area!)[1].x).toBe(20);
      expect(mapEditsRepo.listDrafts(sn).length).toBe(1);
      expect(mapEditsRepo.latestVersion(sn)).toBeFalsy();
      expect(vi.mocked(pushMapToMowerVerbatim)).not.toHaveBeenCalled();
    } finally {
      fw.supported = true;
    }
  });

  it('revert op STOCK firmware: DB terug naar snapshot, geen push (herstelt app/maaier-scheefstand)', async () => {
    // Eerst een echte apply (custom) zodat er een versie is …
    const moved = square.map(p => (p.x === 20 ? { x: 20.5, y: p.y } : p));
    saveDraft(sn, { canonical: 'map0', points: moved });
    expect((await applyEdits(sn)).ok).toBe(true);
    vi.mocked(pushMapToMowerVerbatim).mockClear();
    // … en dan terugdraaien alsof de maaier stock is.
    fw.supported = false;
    try {
      const res = await revertEdits(sn);
      expect(res.ok).toBe(true);
      expect(JSON.parse(mapRepo.findBySnAndCanonical(sn, 'map0')!.map_area!)[1].x).toBe(20);
      expect(vi.mocked(pushMapToMowerVerbatim)).not.toHaveBeenCalled();
    } finally {
      fw.supported = true;
    }
  });

  it('apply: nieuw obstacle → maps-rij aangemaakt; delete → rij weg', async () => {
    saveDraft(sn, { mapType: 'obstacle', parentMap: 'map0',
      points: [{ x: 10, y: 10 }, { x: 12, y: 10 }, { x: 12, y: 12 }, { x: 10, y: 12 }] });
    saveDraft(sn, { canonical: 'map0_0_obstacle', deleted: true });
    const res = await applyEdits(sn);
    expect(res.ok).toBe(true);
    expect(mapRepo.findBySnAndCanonical(sn, 'map0_1_obstacle')).toBeTruthy();
    expect(mapRepo.findBySnAndCanonical(sn, 'map0_0_obstacle')).toBeUndefined();
  });

  it('apply: validatiefout → niets gemuteerd', async () => {
    saveDraft(sn, { canonical: 'map0_0_obstacle',
      points: [{ x: 18, y: 18 }, { x: 25, y: 18 }, { x: 25, y: 25 }, { x: 18, y: 25 }] }); // buiten work
    const res = await applyEdits(sn);
    expect(res.ok).toBe(false);
    expect(res.validation?.errors.some(e => e.code === 'outside_work')).toBe(true);
    expect(mapEditsRepo.listDrafts(sn).length).toBe(1);          // drafts blijven
    expect(vi.mocked(pushMapToMowerVerbatim)).not.toHaveBeenCalled();
  });

  it('apply: maaier offline → geweigerd zonder mutatie', async () => {
    vi.mocked(isDeviceOnline).mockReturnValue(false);
    saveDraft(sn, { canonical: 'map0_0_obstacle', deleted: true });
    const res = await applyEdits(sn);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('offline');
  });

  it('apply: maaier maait → geweigerd', async () => {
    deviceCache.set(sn, new Map([['msg', 'Mode:COVERAGE Work:RUNNING']]));
    saveDraft(sn, { canonical: 'map0_0_obstacle', deleted: true });
    const res = await applyEdits(sn);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('busy');
  });

  it('apply: docked maaier met Mode:COVERAGE (task_mode 0) blokkeert NIET', async () => {
    // Docked + idle "Mode:COVERAGE" (laatst-gekozen modus) mag Apply niet blokkeren.
    deviceCache.set(sn, new Map([['msg', 'Mode:COVERAGE'], ['task_mode', '0'], ['battery_state', 'CHARGING']]));
    saveDraft(sn, { canonical: 'map0_0_obstacle', deleted: true });
    const res = await applyEdits(sn);
    expect(res.reason).not.toBe('busy');
    expect(res.ok).toBe(true);
  });

  it('apply: maaier niet op dock (idle in veld) → geweigerd met not_docked', async () => {
    // Online, niet bezig, maar NIET ladend op het dock → map-edit mag niet
    // (anders kan een verkeerde/oude dock-pose naar de maaier gepusht worden).
    deviceCache.set(sn, new Map([['msg', 'Mode:COVERAGE'], ['task_mode', '0'], ['battery_state', 'DISCHARGING']]));
    saveDraft(sn, { canonical: 'map0_0_obstacle', deleted: true });
    const res = await applyEdits(sn);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_docked');
    // Niets gemuteerd, niets gepusht.
    expect(mapEditsRepo.listDrafts(sn).length).toBe(1);
    expect(vi.mocked(pushMapToMowerVerbatim)).not.toHaveBeenCalled();
  });

  it('apply: maaier FULL op dock → toegestaan (niet alleen CHARGING)', async () => {
    deviceCache.set(sn, new Map([['battery_state', 'FULL']]));
    saveDraft(sn, { canonical: 'map0_0_obstacle', deleted: true });
    const res = await applyEdits(sn);
    expect(res.ok).toBe(true);
  });

  it('apply: actieve cover-taak (task_mode 1) blokkeert wél', async () => {
    deviceCache.set(sn, new Map([['msg', 'Mode:COVERAGE'], ['task_mode', '1']]));
    saveDraft(sn, { canonical: 'map0_0_obstacle', deleted: true });
    const res = await applyEdits(sn);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('busy');
  });

  it('apply: maaier op dock aan het laden (gepauzeerde taak) blokkeert NIET', async () => {
    // Battery-low recharge houdt task_mode op 1 + Mode:COVERAGE, maar docked+charging
    // is veilig om map-edits toe te passen (obstakel plaatsen terwijl-ie laadt).
    deviceCache.set(sn, new Map([['msg', 'Mode:COVERAGE'], ['task_mode', '1'], ['battery_state', 'CHARGING']]));
    saveDraft(sn, { canonical: 'map0_0_obstacle', deleted: true });
    const res = await applyEdits(sn);
    expect(res.reason).not.toBe('busy');
    expect(res.ok).toBe(true);
  });

  it('apply: push faalt → pendingSync gezet; retry zonder drafts pusht opnieuw', async () => {
    vi.mocked(pushMapToMowerVerbatim).mockResolvedValueOnce({ ok: false, offline: true });
    saveDraft(sn, { canonical: 'map0_0_obstacle', deleted: true });
    const r1 = await applyEdits(sn);
    expect(r1.ok).toBe(false);
    expect(r1.reason).toBe('push_failed');
    expect(getEditGeometry(sn).pendingSync).toBe(true);
    const r2 = await applyEdits(sn);
    expect(r2.ok).toBe(true);
    expect(getEditGeometry(sn).pendingSync).toBe(false);
  });

  it('discardDrafts: ruimt een vastzittende pendingSync op (escape hatch)', async () => {
    // Push faalt → pendingSync blijft '1', geen drafts meer over.
    vi.mocked(pushMapToMowerVerbatim).mockResolvedValueOnce({ ok: false, offline: true });
    saveDraft(sn, { canonical: 'map0_0_obstacle', deleted: true });
    await applyEdits(sn);
    expect(getEditGeometry(sn).pendingSync).toBe(true);
    // Discard moet de bar onvoorwaardelijk kunnen wegnemen.
    discardDrafts(sn);
    expect(getEditGeometry(sn).pendingSync).toBe(false);
  });

  it('revert: zet snapshot terug en pusht', async () => {
    const orig = mapRepo.findBySnAndCanonical(sn, 'map0')!.map_area;
    saveDraft(sn, { canonical: 'map0', points: square.map(p => (p.x === 20 ? { x: 22, y: p.y } : p)) });
    await applyEdits(sn);
    const res = await revertEdits(sn);
    expect(res.ok).toBe(true);
    expect(mapRepo.findBySnAndCanonical(sn, 'map0')!.map_area).toBe(orig);
    expect(mapEditsRepo.latestVersion(sn)).toBeUndefined();      // versie verbruikt
  });

  it('locked: gelijktijdige apply → exact één locked', async () => {
    saveDraft(sn, { canonical: 'map0_0_obstacle', deleted: true });
    const [r1, r2] = await Promise.all([applyEdits(sn), applyEdits(sn)]);
    const lockedCount = [r1.reason, r2.reason].filter(r => r === 'locked').length;
    expect(lockedCount).toBe(1);
  });

  it('bundle_failed: bundle null → reason bundle_failed, pendingSync true', async () => {
    vi.mocked(createBundleFromDb).mockResolvedValueOnce(null);
    saveDraft(sn, { canonical: 'map0_0_obstacle', deleted: true });
    const res = await applyEdits(sn);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('bundle_failed');
    expect(getEditGeometry(sn).pendingSync).toBe(true);
  });

  it('no_changes: geen drafts en geen pending → no_changes', async () => {
    const res = await applyEdits(sn);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no_changes');
  });

  it('revert: delete+recreate behoudt canonical_name en map_area', async () => {
    // Sla map_area van de bestaande obstacle op
    const origObst = mapRepo.findBySnAndCanonical(sn, 'map0_0_obstacle')!;
    const origArea = origObst.map_area;

    // Maak nieuw obstacle + verwijder bestaande
    saveDraft(sn, { mapType: 'obstacle', parentMap: 'map0',
      points: [{ x: 10, y: 10 }, { x: 12, y: 10 }, { x: 12, y: 12 }, { x: 10, y: 12 }] });
    saveDraft(sn, { canonical: 'map0_0_obstacle', deleted: true });
    const applyRes = await applyEdits(sn);
    expect(applyRes.ok).toBe(true);
    expect(mapRepo.findBySnAndCanonical(sn, 'map0_1_obstacle')).toBeTruthy();
    expect(mapRepo.findBySnAndCanonical(sn, 'map0_0_obstacle')).toBeUndefined();

    // Revert
    const revertRes = await revertEdits(sn);
    expect(revertRes.ok).toBe(true);
    expect(mapRepo.findBySnAndCanonical(sn, 'map0_1_obstacle')).toBeUndefined();
    const restored = mapRepo.findBySnAndCanonical(sn, 'map0_0_obstacle');
    expect(restored).toBeTruthy();
    expect(restored!.canonical_name).toBe('map0_0_obstacle');
    expect(restored!.map_area).toBe(origArea);
  });

  it('revert offline: offline → reason offline; no_version → reason no_version', async () => {
    vi.mocked(isDeviceOnline).mockReturnValue(false);
    const offlineRes = await revertEdits(sn);
    expect(offlineRes.ok).toBe(false);
    expect(offlineRes.reason).toBe('offline');

    vi.mocked(isDeviceOnline).mockReturnValue(true);
    const noVersionRes = await revertEdits(sn);
    expect(noVersionRes.ok).toBe(false);
    expect(noVersionRes.reason).toBe('no_version');
  });

  it('revert: maaier niet op dock → geweigerd met not_docked', async () => {
    deviceCache.set(sn, new Map([['battery_state', 'DISCHARGING']]));
    const res = await revertEdits(sn);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_docked');
  });

  it('getEditGeometry: overgebleven nieuw-obstacle draft zichtbaar als isNew', () => {
    saveDraft(sn, { mapType: 'obstacle', parentMap: 'map0',
      points: [{ x: 10, y: 10 }, { x: 12, y: 10 }, { x: 12, y: 12 }, { x: 10, y: 12 }] });
    const g = getEditGeometry(sn);
    const entry = g.maps.find(m => m.canonical === 'map0_1_obstacle');
    expect(entry).toBeTruthy();
    expect(entry!.draft?.isNew).toBe(true);
    expect(entry!.mapType).toBe('obstacle');
  });

  it('unicom rejection: saveDraft weigert unicom canonical', () => {
    mapRepo.create({ map_id: 'u0', mower_sn: sn, map_type: 'unicom',
      file_name: 'map0tocharge_unicom.csv',
      map_area: JSON.stringify([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]) });
    const res = saveDraft(sn, { canonical: 'map0tocharge_unicom',
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] });
    expect(res.ok).toBe(false);
  });
});
