import { describe, it, expect, beforeEach } from 'vitest';
import {
  isFrameNavBlocked, markFrameUnvalidated, clearFrameUnvalidated,
} from '../../services/frameValidation.js';

const SN = 'LFIN_GUARD_0001';

describe('isFrameNavBlocked (publishToDevice guard predicate)', () => {
  beforeEach(() => { clearFrameUnvalidated(SN); });

  it('blocks frame-nav commands while frame unvalidated', () => {
    markFrameUnvalidated(SN);
    expect(isFrameNavBlocked(SN, { go_to_charge: {} })).toBe(true);
    expect(isFrameNavBlocked(SN, { start_navigation: { area: 1 } })).toBe(true);
    expect(isFrameNavBlocked(SN, { start_run: { area: 1 } })).toBe(true);
  });

  // start_edge_cut rijdt de opgeslagen grenspolygoon af en is dus net zo
  // frame-afhankelijk als start_navigation. De rand-dag watcher
  // (scheduleRunner) vuurt dit commando volledig autonoom af, zonder dat er
  // iemand meekijkt, dus dit MOET geblokkeerd blijven zolang het frame niet
  // gevalideerd is (na een bundle-restore, vóór het her-ankeren).
  it('blocks start_edge_cut while frame unvalidated (autonome randmaai)', () => {
    markFrameUnvalidated(SN);
    expect(isFrameNavBlocked(SN, { start_edge_cut: { mapName: 'map0', bladeHeight: 40 } })).toBe(true);
  });

  // mow_zone (extended-kanaal) rijdt de unicom-lijn in het map-frame af en is
  // dus net zo frame-afhankelijk als start_navigation.
  it('blocks mow_zone while frame unvalidated', () => {
    markFrameUnvalidated(SN);
    expect(isFrameNavBlocked(SN, { mow_zone: { map: 'map1' } })).toBe(true);
  });

  it('allows start_edge_cut once the frame is validated', () => {
    expect(isFrameNavBlocked(SN, { start_edge_cut: { mapName: 'map0', bladeHeight: 40 } })).toBe(false);
  });

  it('does not block when the frame is validated', () => {
    expect(isFrameNavBlocked(SN, { go_to_charge: {} })).toBe(false);
    expect(isFrameNavBlocked(SN, { start_navigation: {} })).toBe(false);
  });

  it('allows auto_recharge and go_pile even while unvalidated', () => {
    markFrameUnvalidated(SN);
    expect(isFrameNavBlocked(SN, { auto_recharge: { cmd_num: 1 } })).toBe(false);
    expect(isFrameNavBlocked(SN, { go_pile: {} })).toBe(false);
  });
});
