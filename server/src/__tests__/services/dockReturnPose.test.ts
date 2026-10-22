/**
 * GH #158: docking back after a departure used the yaw the mower reported on
 * the dock, before the departure initialized its heading.
 */
import { it, expect, vi } from 'vitest';

vi.mock('../../mqtt/mapSync.js', () => ({ publishToExtended: vi.fn() }));
import { returnChargePose } from '../../services/dockMotion.js';

const left = { x: 1.2, y: -0.4, yaw: 2.1 };

it('takes x/y from the departure and the heading from the saved dock', () => {
  expect(returnChargePose(left, 1.5)).toEqual({ x: 1.2, y: -0.4, yaw: 1.5 });
});

it('keeps the departure pose when no saved dock heading is known', () => {
  expect(returnChargePose(left, undefined)).toEqual(left);
  expect(returnChargePose(left, Number.NaN)).toEqual(left);
});
