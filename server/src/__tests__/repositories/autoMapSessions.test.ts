import { describe, it, expect } from 'vitest';
import {
  createSession, updatePhase, getActiveSession, getLatestSession,
} from '../../db/repositories/autoMapSessions.js';

describe('autoMapSessions repository', () => {
  it('maakt een sessie aan en vindt hem als actief', () => {
    const s = createSession('LFIN_TEST_AM1', 'test', 30);
    expect(s.id).toBeGreaterThan(0);
    expect(s.phase).toBe('preflight');
    expect(getActiveSession('LFIN_TEST_AM1')?.id).toBe(s.id);
  });

  it('updatePhase muteert fase en sluit sessies af', () => {
    const s = createSession('LFIN_TEST_AM2', 'record', 25);
    updatePhase(s.id, 'following');
    expect(getActiveSession('LFIN_TEST_AM2')?.phase).toBe('following');
    updatePhase(s.id, 'aborted', { error: 'geofence', finished: true });
    expect(getActiveSession('LFIN_TEST_AM2')).toBeUndefined();
    const latest = getLatestSession('LFIN_TEST_AM2');
    expect(latest?.phase).toBe('aborted');
    expect(latest?.error).toBe('geofence');
    expect(latest?.finished_at).not.toBeNull();
  });

  it('result_code wordt opgeslagen', () => {
    const s = createSession('LFIN_TEST_AM3', 'record', 30);
    updatePhase(s.id, 'awaiting_review', { result_code: 0 });
    expect(getLatestSession('LFIN_TEST_AM3')?.result_code).toBe(0);
  });
});
