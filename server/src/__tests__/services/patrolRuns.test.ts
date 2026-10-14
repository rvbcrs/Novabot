/**
 * The patrol run the server started last, per mower (DB, so it survives a
 * restart), and what the broker mirrors of the mower's patrol reports.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { patrolRunsRepo } from '../../db/repositories/index.js';
import {
  isOlderPatrolRun, isLivePatrolRun, patrolReport, isPatrolDriving, markPatrolDocking, patrolDockingUnderWay,
  PATROL_RUN_TTL_MS, PATROL_DOCKING_MAX_MS, _resetPatrolDocking,
} from '../../services/patrolRuns.js';

const SN = 'LFIN_PATROL_RUNS';
const TOKEN = '0123456789abcdef0123456789abcdef';

function started(run: string, scheduleId: string | null = null) {
  patrolRunsRepo.start({ mower_sn: SN, run, token: TOKEN, started_at: Number(run), schedule_id: scheduleId });
}

beforeEach(() => { patrolRunsRepo.clearAll(); _resetPatrolDocking(); });

describe('patrol runs', () => {
  it('compares runs as numbers: a shorter run id is an older run', () => {
    started('1700000000000');
    expect(isOlderPatrolRun(SN, '999999999999')).toBe(true);
    expect(isOlderPatrolRun(SN, '1699999999999')).toBe(true);
    expect(isOlderPatrolRun(SN, '1700000000000')).toBe(false);
    expect(isOlderPatrolRun(SN, '1700000000001')).toBe(false);
  });

  it('without a known run, or without a run in the report, nothing is older', () => {
    expect(isOlderPatrolRun(SN, '1')).toBe(false);
    started('2000');
    expect(isOlderPatrolRun(SN, undefined)).toBe(false);
    expect(isOlderPatrolRun(SN, 'x')).toBe(false);
  });

  it('a run is live from its start until its end was handled', () => {
    started('2000');
    expect(isLivePatrolRun(SN, '2000')).toBe(true);
    expect(isLivePatrolRun(SN, '1999')).toBe(false);
    expect(patrolRunsRepo.markEnded(SN, '2000', 'done')).toBe(true);
    expect(isLivePatrolRun(SN, '2000')).toBe(false);
    expect(patrolRunsRepo.markEnded(SN, '2000', 'done')).toBe(false);   // once
  });
});

describe('what the broker mirrors of a patrol report', () => {
  it('a status of the current run sets the phase, with the run passed on', () => {
    started('2000');
    expect(patrolReport(SN, 'patrol_status', { phase: 'error', error: 'checkpoints_unreachable', run: '2000' }, 'patrolling'))
      .toEqual({
        changes: new Map([['patrol_phase', 'error'], ['patrol_error', 'checkpoints_unreachable']]),
        status: { phase: 'error', error: 'checkpoints_unreachable', run: '2000' },
      });
    expect(patrolReport(SN, 'patrol_status', { phase: 'returning', run: '2000' }, 'patrolling'))
      .toEqual({
        changes: new Map([['patrol_phase', 'returning'], ['patrol_error', '']]),
        status: { phase: 'returning', error: undefined, run: '2000' },
      });
  });

  // Run A was taken over by run B (a second start). A's late "stopped" must not
  // put B's phase on stopped: every stop path keys on that phase.
  it("an old run's late stopped does not overwrite the newer run's phase", () => {
    started('1000');
    started('2000');
    expect(patrolReport(SN, 'patrol_status', { phase: 'stopped', run: '1000' }, 'starting')).toBeNull();
  });

  // The mower re-sends its last status after a reconnect; one that left just
  // before the run's end can arrive after it.
  it('a phase on the way of a run whose end was handled is not mirrored; its end again is', () => {
    started('2000');
    patrolRunsRepo.markEnded(SN, '2000', 'done');
    expect(patrolReport(SN, 'patrol_status', { phase: 'patrolling', run: '2000' }, 'done')).toBeNull();
    expect(patrolReport(SN, 'patrol_status', { phase: 'done', run: '2000' }, 'done')?.status?.phase).toBe('done');
  });

  // R3: a stop on the mower (STOP button, lift, tilt) keeps its reason for the card.
  it("a stopped with a flag keeps it as patrol_error; the owner's own stop has none", () => {
    started('2000');
    expect(patrolReport(SN, 'patrol_status', { phase: 'stopped', error: 'error_push_button_stop', run: '2000' }, 'patrolling')?.changes)
      .toEqual(new Map([['patrol_phase', 'stopped'], ['patrol_error', 'error_push_button_stop']]));
    started('3000');
    expect(patrolReport(SN, 'patrol_status', { phase: 'stopped', run: '3000' }, 'patrolling')?.changes)
      .toEqual(new Map([['patrol_phase', 'stopped'], ['patrol_error', '']]));
  });

  it('a status without a run (an older mower build) still counts', () => {
    started('2000');
    expect(patrolReport(SN, 'patrol_status', { phase: 'patrolling' }, 'starting')?.changes.get('patrol_phase')).toBe('patrolling');
  });

  it('a checkpoint of the live run brings back a lost patrolling phase', () => {
    started('2000');
    for (const cached of [undefined, 'done', 'error', 'stopped']) {
      expect(patrolReport(SN, 'patrol_checkpoint', { seq: 3, run: '2000' }, cached))
        .toEqual({ changes: new Map([['patrol_phase', 'patrolling'], ['patrol_error', '']]) });
    }
  });

  it('a checkpoint changes nothing while a driving phase is cached, for another run, or after the end', () => {
    started('2000');
    for (const cached of ['starting', 'localizing', 'patrolling', 'returning']) {
      expect(patrolReport(SN, 'patrol_checkpoint', { seq: 3, run: '2000' }, cached)).toBeNull();
    }
    expect(patrolReport(SN, 'patrol_checkpoint', { seq: 3, run: '1999' }, 'done')).toBeNull();
    expect(patrolReport(SN, 'patrol_checkpoint', { seq: 3 }, 'done')).toBeNull();
    patrolRunsRepo.markEnded(SN, '2000', 'stopped');
    expect(patrolReport(SN, 'patrol_checkpoint', { seq: 3, run: '2000' }, 'stopped')).toBeNull();
  });

  it('a refused start is an error with its reason, and a refusal for the service', () => {
    expect(patrolReport(SN, 'patrol_respond', { result: 1, error: 'invalid_token' }, 'done'))
      .toEqual({
        changes: new Map([['patrol_phase', 'error'], ['patrol_error', 'invalid_token']]),
        refused: { error: 'invalid_token' },
      });
    expect(patrolReport(SN, 'patrol_respond', { result: 0, run: '2000' }, 'starting')).toBeNull();
  });

  it('ignores anything that is not a patrol report', () => {
    expect(patrolReport(SN, 'mow_zone_status', { phase: 'done' }, undefined)).toBeNull();
    expect(patrolReport(SN, 'patrol_status', null, undefined)).toBeNull();
    expect(patrolReport(SN, 'patrol_status', { phase: '' }, undefined)).toBeNull();
  });
});

// R5: the gates that keep a patrol apart read a cached phase that never expires;
// only a run that is out (started, not ended, within the TTL) counts.
describe('isPatrolDriving', () => {
  it('needs a driving phase and a live run', () => {
    started(String(Date.now()));
    for (const phase of ['starting', 'localizing', 'patrolling', 'returning']) expect(isPatrolDriving(SN, phase)).toBe(true);
    for (const phase of ['done', 'error', 'stopped', '', undefined]) expect(isPatrolDriving(SN, phase)).toBe(false);
  });

  it('a stale phase without a live run does not count', () => {
    expect(isPatrolDriving(SN, 'patrolling')).toBe(false);                    // no run at all
    const run = String(Date.now());
    started(run);
    patrolRunsRepo.markEnded(SN, run, 'done');
    expect(isPatrolDriving(SN, 'patrolling')).toBe(false);                    // ended
    started('1000');
    expect(isPatrolDriving(SN, 'patrolling', 1000 + PATROL_RUN_TTL_MS + 1)).toBe(false);   // older than the TTL
    expect(isPatrolDriving(SN, 'patrolling', 1000 + PATROL_RUN_TTL_MS)).toBe(true);
  });
});

// R8: the drive home after a patrol reports Work:MOVING. From the server's go
// home until the mower is docked or charging, at most 15 minutes, it is no mow.
describe('patrolDockingUnderWay', () => {
  it('holds until the first docked report, which still belongs to the docking', () => {
    markPatrolDocking(SN, 0);
    expect(patrolDockingUnderWay(SN, false, 1_000)).toBe(true);
    expect(patrolDockingUnderWay(SN, true, 2_000)).toBe(true);    // arriving on the dock
    expect(patrolDockingUnderWay(SN, false, 3_000)).toBe(false);  // and a later departure is its own
  });

  it('ends after 15 minutes without a dock', () => {
    markPatrolDocking(SN, 0);
    expect(patrolDockingUnderWay(SN, false, PATROL_DOCKING_MAX_MS)).toBe(true);
    expect(patrolDockingUnderWay(SN, false, PATROL_DOCKING_MAX_MS + 1)).toBe(false);
    expect(patrolDockingUnderWay(SN, false, PATROL_DOCKING_MAX_MS + 2)).toBe(false);
  });

  it('nothing without a docking', () => {
    expect(patrolDockingUnderWay(SN, false, 0)).toBe(false);
  });
});
