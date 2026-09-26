// server/src/services/importStaging.ts
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type ImportState =
  | 'UPLOADED'
  | 'DRIVE_AND_LOCK'  // server is driving the mower backward + waiting for RTK FIX
  | 'AUTO_DOCK'       // mower is returning to dock via ArUco
  | 'ANCHOR_SET'      // mower back on dock, RTK + map_position snapshot taken
  | 'PREVIEW_SHOWN'
  | 'USER_CONFIRMED'
  | 'APPLYING'
  | 'RECONCILE_REQUIRED'
  | 'APPLIED'
  | 'CANCELLED';

const LEGAL: Record<ImportState, ImportState[]> = {
  // start-drive: server keeps state UPLOADED while driving; transitions
  // straight to AUTO_DOCK only when the drive + RTK lock both succeed.
  // The DRIVE_AND_LOCK state is kept for compatibility but unused on the
  // happy path.
  UPLOADED:        ['DRIVE_AND_LOCK', 'AUTO_DOCK', 'ANCHOR_SET', 'APPLYING', 'APPLIED', 'CANCELLED'],
  DRIVE_AND_LOCK:  ['AUTO_DOCK', 'UPLOADED', 'CANCELLED'],
  AUTO_DOCK:       ['ANCHOR_SET', 'CANCELLED'],
  ANCHOR_SET:      ['PREVIEW_SHOWN', 'CANCELLED'],
  PREVIEW_SHOWN:   ['USER_CONFIRMED', 'CANCELLED'],
  USER_CONFIRMED:  ['APPLIED', 'CANCELLED'],
  APPLYING:       ['UPLOADED', 'RECONCILE_REQUIRED', 'APPLIED'],
  RECONCILE_REQUIRED: ['APPLYING'],
  APPLIED:         [],
  CANCELLED:       [],
};

export interface StagingContext {
  sourceSn: string;
  polygonAreaM2: number;
  newCharger?: { lat: number; lng: number };
  // Live mower map_position when the dock anchor was snapshotted. The
  // /confirm step uses this to translate the rebased polygon so that the
  // unicom anchor lines up with where the mower physically reports the
  // dock — without it the polygon is rotated but offset from reality by
  // whatever displacement the original mapping had between map-origin
  // and dock.
  newDockMapPosition?: { x: number; y: number; orientation: number };
  driveStart?: { lat: number; lng: number };
  driveEnd?: { lat: number; lng: number };
  derivedHeadingRad?: number;
  applyResult?: { driftM?: number; warning?: string; error?: string; operationId?: string; bundleHash?: string; mowerVerified?: boolean };
}

export interface StagingSession {
  sn: string;
  stagingId: string;
  state: ImportState;
  createdAt: number;
  updatedAt: number;
  context: StagingContext;
}

export class IllegalStateTransitionError extends Error {
  constructor(from: ImportState, to: ImportState) {
    super(`illegal state transition ${from} -> ${to}`);
    this.name = 'IllegalStateTransitionError';
  }
}

export class ImportStagingStore {
  private cache = new Map<string, StagingSession>();
  constructor(private readonly rootDir: string) {
    fs.mkdirSync(rootDir, { recursive: true });
    this.loadAll();
  }

  private loadAll(): void {
    if (!fs.existsSync(this.rootDir)) return;
    for (const sn of fs.readdirSync(this.rootDir)) {
      const snDir = path.join(this.rootDir, sn);
      if (!fs.statSync(snDir).isDirectory()) continue;
      for (const id of fs.readdirSync(snDir)) {
        const f = path.join(snDir, id, 'state.json');
        if (fs.existsSync(f)) {
          try {
            const s = JSON.parse(fs.readFileSync(f, 'utf8')) as StagingSession;
            if (s.state === 'APPLYING') {
              s.state = 'RECONCILE_REQUIRED';
              s.context.applyResult = { ...s.context.applyResult, warning: 'Interrupted restore: compare mower files before retrying.' };
              this.persist(s);
            }
            this.cache.set(s.stagingId, s);
          } catch { /* skip corrupt */ }
        }
      }
    }
  }

  private persist(s: StagingSession): void {
    const dir = path.join(this.rootDir, s.sn, s.stagingId);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'state.json');
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(s, null, 2));
    fs.renameSync(`${target}.tmp`, target);
  }

  create(sn: string, context: StagingContext): StagingSession {
    if (this.getActive(sn)) throw new Error(`active session already exists for ${sn}`);
    const s: StagingSession = {
      sn, stagingId: randomUUID(), state: 'UPLOADED',
      createdAt: Date.now(), updatedAt: Date.now(),
      context,
    };
    this.cache.set(s.stagingId, s);
    this.persist(s);
    return s;
  }

  get(stagingId: string): StagingSession | null {
    return this.cache.get(stagingId) ?? null;
  }

  getActive(sn: string): StagingSession | null {
    for (const s of this.cache.values()) {
      if (s.sn === sn && s.state !== 'APPLIED' && s.state !== 'CANCELLED') return s;
    }
    return null;
  }

  transition(stagingId: string, to: ImportState, contextPatch: Partial<StagingContext>): StagingSession {
    const s = this.cache.get(stagingId);
    if (!s) throw new Error(`unknown stagingId ${stagingId}`);
    if (!LEGAL[s.state].includes(to)) throw new IllegalStateTransitionError(s.state, to);
    const next = { ...s, state: to, updatedAt: Date.now(), context: { ...s.context, ...contextPatch } };
    this.persist(next);
    this.cache.set(stagingId, next);
    return next;
  }

  cancel(stagingId: string, _reason: string): void {
    const s = this.cache.get(stagingId);
    if (!s) return;
    if (s.state === 'APPLYING' || s.state === 'RECONCILE_REQUIRED') {
      throw new Error('Restore outcome must be reconciled before removing its recovery files');
    }
    const dir = path.join(this.rootDir, s.sn, s.stagingId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    this.cache.delete(stagingId);
  }
}
