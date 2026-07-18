import { describe, it, expect } from 'vitest';
import { scoreFrame, cropBox } from '../../services/terrainCrops.js';

describe('terrainCrops wiskunde', () => {
  it('recht vooruit op 1m scoort beter dan 30° opzij op 1m', () => {
    const c = { cx: 1, cy: 0 };
    const recht = scoreFrame(c, { x: 0, y: 0, yaw: 0 })!;
    const opzij = scoreFrame(c, { x: 0, y: 0, yaw: 0.5 })!;
    expect(recht).toBeLessThan(opzij);
  });
  it('achter de camera of te ver → null', () => {
    expect(scoreFrame({ cx: -1, cy: 0 }, { x: 0, y: 0, yaw: 0 })).toBeNull();
    expect(scoreFrame({ cx: 6, cy: 0 }, { x: 0, y: 0, yaw: 0 })).toBeNull();
  });
  it('cropBox centreert links van het midden bij object links', () => {
    // object 0.3 rad links van de kijkrichting
    const b = cropBox({ cx: Math.cos(0.3), cy: Math.sin(0.3) }, { x: 0, y: 0, yaw: 0 }, 960, 540);
    expect(b.left + b.width / 2).toBeLessThan(480);
    expect(b.left).toBeGreaterThanOrEqual(0);
    expect(b.left + b.width).toBeLessThanOrEqual(960);
  });
});
