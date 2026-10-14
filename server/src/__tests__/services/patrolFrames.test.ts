import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { savePatrolFrame, listPatrolRuns, patrolImagePath, PATROL_KEEP_RUNS } from '../../services/patrolFrames.js';

const SN = 'LFIN9990000001';
const ROOT = path.resolve(process.env.STORAGE_PATH ?? './storage', 'patrol', SN);
const meta = (seq: number, over: Partial<{ person: number; image: boolean; frames: number }> = {}) =>
  ({ seq, x: 1, y: 2, person: 0, animal: 0, frames: 3, image: true, ts: 1, ...over });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe('patrol frames on disk', () => {
  beforeEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it('keeps photo and metadata per checkpoint and lists the newest run first', () => {
    savePatrolFrame(SN, '100', meta(1), JPEG);
    savePatrolFrame(SN, '100', meta(2, { image: false }), null);
    savePatrolFrame(SN, '200', meta(1, { person: 60 }), JPEG);
    const runs = listPatrolRuns(SN);
    expect(runs.map(r => r.run)).toEqual(['200', '100']);
    expect(runs[1].frames.map(f => f.seq)).toEqual([1, 2]);
    expect(patrolImagePath(SN, '100', '1')).not.toBeNull();
    expect(patrolImagePath(SN, '100', '2')).toBeNull();
  });

  it(`keeps only the last ${PATROL_KEEP_RUNS} runs, oldest by number`, () => {
    for (let run = 1; run <= PATROL_KEEP_RUNS + 2; run++) savePatrolFrame(SN, String(run), meta(1), JPEG);
    const runs = listPatrolRuns(SN).map(r => r.run);
    expect(runs).toHaveLength(PATROL_KEEP_RUNS);
    expect(runs).not.toContain('1');
    expect(runs).not.toContain('2');
  });

  it('never resolves a path outside the patrol folder', () => {
    expect(patrolImagePath('../etc', '1', '1')).toBeNull();
    expect(patrolImagePath(SN, '../1', '1')).toBeNull();
    expect(patrolImagePath(SN, '1', '../1')).toBeNull();
    expect(listPatrolRuns('../x')).toEqual([]);
    expect(() => savePatrolFrame(SN, '../9', meta(1), JPEG)).toThrow();
  });
});
