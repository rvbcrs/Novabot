import { describe, it, expect } from 'vitest';
import { isMuted } from '../../notifications/expoPush.js';
import { CATEGORY_BY_TYPE } from '../../notifications/types.js';

describe('push muting', () => {
  it('mutes only the listed categories and survives bad JSON', () => {
    expect(isMuted(null, 'activity')).toBe(false);
    expect(isMuted('["activity","battery"]', 'activity')).toBe(true);
    expect(isMuted('["activity","battery"]', 'errors')).toBe(false);
    expect(isMuted('not json', 'errors')).toBe(false);
  });
  it('maps every event type to a category', () => {
    for (const cat of Object.values(CATEGORY_BY_TYPE)) {
      expect(['activity', 'errors', 'safety', 'battery', 'maintenance']).toContain(cat);
    }
    expect(CATEGORY_BY_TYPE.map_error).toBe('errors');
  });
});
