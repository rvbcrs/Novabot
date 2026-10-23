import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../notifications/dispatcher.js', () => ({ dispatchEvent: vi.fn() }));

import { dispatchEvent } from '../../notifications/dispatcher.js';
import { dispatchPatrolDetectionEvent, dispatchPatrolFailedEvent, dispatchPatrolDockFailedEvent } from '../../notifications/eventDetector.js';
import { CATEGORY_BY_TYPE } from '../../notifications/types.js';

describe('patrol events', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a detection is its own event type in the patrol category', () => {
    dispatchPatrolDetectionEvent('LFIN1', { run: '17', seq: 4, kind: 'person', points: 120, image: true });
    const ev = vi.mocked(dispatchEvent).mock.calls[0][0];
    expect(ev.type).toBe('patrol_detection');
    expect(CATEGORY_BY_TYPE[ev.type]).toBe('patrol');
    expect(ev.message).toContain('a person');
    expect(ev.data).toMatchObject({ run: '17', seq: 4, kind: 'person', points: 120, image: true });
  });

  it('a failed patrol says whether the mower was sent home', () => {
    dispatchPatrolFailedEvent('LFIN1', 'checkpoints_unreachable', true);
    dispatchPatrolFailedEvent('LFIN1', 'not_localized', false);
    const [a, b] = vi.mocked(dispatchEvent).mock.calls.map(c => c[0]);
    expect(a.type).toBe('patrol_failed');
    expect(CATEGORY_BY_TYPE[a.type]).toBe('patrol');
    expect(a.message).toContain('is being sent to its dock');
    expect(b.message).toContain('did not leave its dock');
  });

  // Novabot-bqzs: the push said "was sent back to its dock" at the moment the
  // go home was only about to start, and the docking then failed (error 126).
  // It states what the server does, not what has happened.
  it('a failed patrol does not claim the mower is already back on its dock', () => {
    dispatchPatrolFailedEvent('LFIN1', 'checkpoints_unreachable', true);
    const ev = vi.mocked(dispatchEvent).mock.calls[0][0];
    expect(ev.message).toBe('The night patrol stopped: it could not reach five checkpoints in a row; something blocked them, or its position was off. The mower is being sent to its dock.');
    expect(ev.message).not.toContain('was sent');
    expect(ev.data).toMatchObject({ reason: 'checkpoints_unreachable', went_home: true });
  });

  // Walter, 2026-10-23 00:15: the camera repeated one frame for a whole round
  // and the docking failed on it. The push names the cause and what fixes it.
  it('a frozen camera says so, and that switching the mower off and on brings it back', () => {
    dispatchPatrolFailedEvent('LFIN1', 'camera_frozen', true);
    const ev = vi.mocked(dispatchEvent).mock.calls[0][0];
    expect(ev.message).toBe('The night patrol stopped: its camera stopped delivering images, also after a restart; switch the mower off and on before the next round. The mower is being sent to its dock.');
  });

  it('a docking that failed after a patrol is a dock_failed that says the mower stands in the garden', () => {
    dispatchPatrolDockFailedEvent('LFIN1', {
      run: '1700', msg: 'Mode:COVERAGE Work:MOVING Recharge: FAILED', errorStatus: '126', batteryPower: 41,
    });
    const ev = vi.mocked(dispatchEvent).mock.calls[0][0];
    expect(ev.type).toBe('dock_failed');
    expect(CATEGORY_BY_TYPE[ev.type]).toBe('errors');
    expect(ev.title).toBe('Mower could not dock');
    expect(ev.message).toBe('Docking after the patrol failed; the mower is standing still in the garden.');
    expect(ev.data).toMatchObject({ patrol: true, run: '1700', error_status: '126', battery_power: 41 });
  });

  // R3: the STOP button, a lift or a tilt stopped it in the garden.
  it('a patrol stopped on the mower says the mower stays where it stopped', () => {
    dispatchPatrolFailedEvent('LFIN1', 'error_push_button_stop', false, true);
    const ev = vi.mocked(dispatchEvent).mock.calls[0][0];
    expect(ev.type).toBe('patrol_failed');
    expect(ev.message).toBe('The night patrol stopped: the STOP button was pressed. The mower stays where it stopped.');
    expect(ev.data).toMatchObject({ reason: 'error_push_button_stop', went_home: false });
  });
});
