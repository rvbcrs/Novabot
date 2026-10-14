import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../notifications/dispatcher.js', () => ({ dispatchEvent: vi.fn() }));

import { dispatchEvent } from '../../notifications/dispatcher.js';
import { dispatchPatrolDetectionEvent, dispatchPatrolFailedEvent } from '../../notifications/eventDetector.js';
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
    expect(a.message).toContain('sent back to its dock');
    expect(b.message).toContain('did not leave its dock');
  });
});
