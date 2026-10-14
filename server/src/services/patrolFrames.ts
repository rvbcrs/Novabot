/**
 * Patrol checkpoints on disk: STORAGE_PATH/patrol/<sn>/<run>/<seq>.json and,
 * when the mower took one, <seq>.jpg. The last PATROL_KEEP_RUNS runs per mower
 * are kept. Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
import fs from 'fs';
import path from 'path';

const PATROL_DIR = path.resolve(process.env.STORAGE_PATH ?? './storage', 'patrol');
export const PATROL_KEEP_RUNS = 10;

export interface PatrolFrameMeta {
  seq: number; x: number; y: number; person: number; animal: number; frames: number; image: boolean; ts: number;
}
export interface PatrolRun { run: string; startedAt: number; frames: PatrolFrameMeta[] }

const SN_RE = /^LFI[A-Z]\d+$/;
const RUN_RE = /^\d{1,20}$/;

export function savePatrolFrame(sn: string, run: string, meta: PatrolFrameMeta, jpeg: Buffer | null): void {
  if (!SN_RE.test(sn) || !RUN_RE.test(run)) throw new Error('invalid sn or run');
  const dir = path.join(PATROL_DIR, sn, run);
  fs.mkdirSync(dir, { recursive: true });
  if (jpeg) fs.writeFileSync(path.join(dir, `${meta.seq}.jpg`), jpeg);
  fs.writeFileSync(path.join(dir, `${meta.seq}.json`), JSON.stringify(meta));
  const runs = fs.readdirSync(path.join(PATROL_DIR, sn)).filter(r => RUN_RE.test(r))
    .sort((a, b) => Number(a) - Number(b));
  for (const old of runs.slice(0, -PATROL_KEEP_RUNS)) {
    fs.rmSync(path.join(PATROL_DIR, sn, old), { recursive: true, force: true });
  }
}

export function listPatrolRuns(sn: string): PatrolRun[] {
  if (!SN_RE.test(sn)) return [];
  const root = path.join(PATROL_DIR, sn);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(r => RUN_RE.test(r))
    .sort((a, b) => Number(b) - Number(a))
    .map(run => {
      const dir = path.join(root, run);
      const frames = fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f))
        .map(f => {
          try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as PatrolFrameMeta; } catch { return null; }
        })
        .filter((m): m is PatrolFrameMeta => m !== null)
        .sort((a, b) => a.seq - b.seq);
      return { run, startedAt: Number(run), frames };
    });
}

export function patrolImagePath(sn: string, run: string, seq: string): string | null {
  if (!SN_RE.test(sn) || !RUN_RE.test(run) || !/^\d{1,3}$/.test(seq)) return null;
  const p = path.join(PATROL_DIR, sn, run, `${seq}.jpg`);
  return fs.existsSync(p) ? p : null;
}
