// server/src/__tests__/services/patrolDockFailed.test.ts
/**
 * Novabot-bqzs, live 2026-10-15: the first dashboard patrol ended
 * checkpoints_unreachable, the server's go home failed (nav2 "goal is occupied"
 * at the pile pose, error 126) and the mower stood 17 m out for six hours while
 * patrol_failed said it was sent back to its dock.
 *
 * End to end from the patrol's end: the patrol service sends the mower home and
 * starts watching it, the event detector sees the recharge fail, and exactly one
 * dock_failed with the patrol's context reaches the owner and the run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../mqtt/extendedCommands.js', () => ({ publishExtendedCommand: vi.fn() }));
vi.mock('../../mqtt/mapSync.js', () => ({ publishToTopic: vi.fn(), publishToDevice: vi.fn(), getNextCmdNum: vi.fn(() => 1) }));
vi.mock('../../mqtt/broker.js', () => ({ isDeviceOnline: vi.fn(() => true) }));
vi.mock('../../mqtt/sensorData.js', () => ({ deviceCache: new Map<string, Map<string, string>>() }));
vi.mock('../../services/mowerFileCapability.js', () => ({ isOpenNovaMower: vi.fn(() => true) }));
vi.mock('../../services/mowingService.js', () => ({ isMowerBusy: vi.fn(() => false), goHome: vi.fn(() => ({ ok: true })) }));
vi.mock('../../services/mowerMapOperation.js', () => ({ isMowerMapOperationBusy: vi.fn(() => false) }));
vi.mock('../../services/frameValidation.js', () => ({ isFrameUnvalidated: vi.fn(() => false) }));
vi.mock('../../services/anchor.js', () => ({ getPolygonAnchor: vi.fn(() => null) }));
vi.mock('../../services/positionTelemetry.js', () => ({
  freshPositionState: vi.fn(() => ({ fixed: false, running: false, docked: true, dockKnown: true, pose: null })),
}));

import { onPatrolStatus, PATROL_HOME_DELAY_MS, _resetPatrolState } from '../../services/patrolService.js';
import { detectAndDispatch, resetEventState } from '../../notifications/eventDetector.js';
import { getRecentEvents } from '../../notifications/dispatcher.js';
import { patrolRunsRepo } from '../../db/repositories/patrolRuns.js';
import { goHome } from '../../services/mowingService.js';
import { PATROL_DOCKING_MAX_MS } from '../../services/patrolRuns.js';

const RUN = '1760000000000';
const PATROL_SENTENCE = 'Docking after the patrol failed; the mower is standing still in the garden.';
const GOING = 'Mode:COVERAGE Work:MOVING Prev work:FINISHED Recharge: GOING';
const FAILED = 'Mode:COVERAGE Work:MOVING Prev work:FINISHED Recharge: FAILED';

// Every case its own mower: the dispatcher's event list outlives a test.
let n = 0;
let SN = '';

/** A status report of the mower in the garden, with fields overridden. */
const report = (extra: Record<string, string> = {}) => new Map(Object.entries({
  error_status: '0', msg: GOING, battery_power: '70', recharge_status: '0', battery_state: 'DISCHARGING', ...extra,
}));
const onTheCharger = () => report({
  msg: 'Mode:COVERAGE Work:FINISHED Prev work:MOVING Recharge: FINISHED', recharge_status: '9', battery_state: 'CHARGING',
});
const events = (type: string) => getRecentEvents(SN, 50).filter(e => e.type === type);

/** The patrol goes out and ends; the mower's first report sets the detector's snapshot. */
function patrolEnds(phase: 'done' | 'error' | 'stopped') {
  patrolRunsRepo.start({ mower_sn: SN, run: RUN, token: '0'.repeat(32), started_at: Date.now(), schedule_id: null });
  detectAndDispatch(SN, report());
  onPatrolStatus(SN, 'patrolling', undefined, RUN);
  onPatrolStatus(SN, phase, phase === 'error' ? 'checkpoints_unreachable' : undefined, RUN);
}

describe('the docking after a night patrol', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    n += 1;
    SN = `LFIN_PATROL_DOCK_${n}`;
    _resetPatrolState();
    resetEventState(SN);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a patrol that ended well and a recharge that fails: one dock_failed, on the mower and on the run', () => {
    patrolEnds('done');
    expect(goHome).toHaveBeenCalledWith(SN);
    detectAndDispatch(SN, report({ msg: FAILED }));
    const [ev, ...rest] = events('dock_failed');
    expect(rest).toEqual([]);
    expect(ev.message).toBe(PATROL_SENTENCE);
    expect(ev.data).toMatchObject({ patrol: true, run: RUN });
    expect(patrolRunsRepo.get(SN)?.dock_failed_at).toEqual(expect.any(Number));
  });

  // The case of the live evidence: a failed patrol, a go home five seconds
  // later, error 126 and nothing but "the mower is being sent to its dock".
  it('a failed patrol says the mower is being sent home, and the go home that fails is its own dock_failed', () => {
    patrolEnds('error');
    expect(events('patrol_failed')).toHaveLength(1);
    expect(events('patrol_failed')[0].message)
      .toBe('The night patrol stopped: it could not reach five checkpoints in a row; something blocked them, or its position was off. The mower is being sent to its dock.');
    expect(goHome).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).toHaveBeenCalledWith(SN);
    detectAndDispatch(SN, report({ error_status: '126', error_msg: 'Return-to-charge failed' }));
    expect(events('dock_failed').map(e => e.message)).toEqual([PATROL_SENTENCE]);
    expect(patrolRunsRepo.get(SN)?.dock_failed_at).toEqual(expect.any(Number));
    // The recharge then reports its failure as well: still one.
    detectAndDispatch(SN, report({ error_status: '126', msg: FAILED }));
    expect(events('dock_failed')).toHaveLength(1);
  });

  it('a mower that charges within the 15 minutes reports no failed docking', () => {
    patrolEnds('done');
    vi.advanceTimersByTime(PATROL_DOCKING_MAX_MS - 60_000);
    detectAndDispatch(SN, onTheCharger());
    expect(events('dock_failed')).toEqual([]);
    expect(patrolRunsRepo.get(SN)?.dock_failed_at).toBeNull();
  });

  it('a failure after the 15 minutes is the generic one', () => {
    patrolEnds('done');
    vi.advanceTimersByTime(PATROL_DOCKING_MAX_MS + 1);
    detectAndDispatch(SN, report({ msg: FAILED }));
    expect(events('dock_failed').map(e => e.message.startsWith('Mower returned to the charger but failed to dock'))).toEqual([true]);
    expect(patrolRunsRepo.get(SN)?.dock_failed_at).toBeNull();
  });

  it('a stopped patrol is not sent home and not watched: the failure is the generic one', () => {
    patrolEnds('stopped');
    expect(goHome).not.toHaveBeenCalled();
    detectAndDispatch(SN, report({ msg: FAILED }));
    expect(events('dock_failed').map(e => e.message.startsWith('Mower returned to the charger but failed to dock'))).toEqual([true]);
    expect(patrolRunsRepo.get(SN)?.dock_failed_at).toBeNull();
  });
});
