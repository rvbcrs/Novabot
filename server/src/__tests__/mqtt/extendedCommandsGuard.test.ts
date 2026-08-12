import { describe, it, expect, beforeEach, vi } from 'vitest';

// Alleen de MQTT-rand is gemockt; publishExtendedCommand en de frame-guard
// draaien ECHT. Zo faalt deze suite wanneer iemand de guard uit
// publishExtendedCommand haalt, ook al blijft het pure predicaat
// (isFrameNavBlocked) zelf correct.
vi.mock('../../mqtt/mapSync.js', () => ({
  publishToTopic: vi.fn(),
}));

import { publishExtendedCommand } from '../../mqtt/extendedCommands.js';
import { publishToTopic } from '../../mqtt/mapSync.js';
import { markFrameUnvalidated, clearFrameUnvalidated } from '../../services/frameValidation.js';

const SN = 'LFIN_EXTGUARD_01';

describe('publishExtendedCommand frame-guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFrameUnvalidated(SN);
  });

  it('publiceert op novabot/extended/<SN> wanneer het frame gevalideerd is', () => {
    publishExtendedCommand(SN, { start_edge_cut: { mapName: 'map0', bladeHeight: 40 } });
    expect(publishToTopic).toHaveBeenCalledWith(
      `novabot/extended/${SN}`,
      { start_edge_cut: { mapName: 'map0', bladeHeight: 40 } },
    );
  });

  it('blokkeert start_edge_cut zolang het frame niet gevalideerd is', () => {
    markFrameUnvalidated(SN);
    publishExtendedCommand(SN, { start_edge_cut: { mapName: 'map0', bladeHeight: 40 } });
    expect(publishToTopic).not.toHaveBeenCalled();
  });

  // mow_zone rijdt de unicom-lijn in het map-frame af en start daarna een
  // coverage-taak — net zo frame-afhankelijk als start_navigation, en het
  // loopt uitsluitend over dit kanaal.
  it('blokkeert mow_zone zolang het frame niet gevalideerd is', () => {
    markFrameUnvalidated(SN);
    publishExtendedCommand(SN, { mow_zone: { map: 'map1' } });
    expect(publishToTopic).not.toHaveBeenCalled();
  });

  // Niet-bewegingscommando's moeten juist WEL door blijven gaan terwijl het
  // frame niet gevalideerd is: het her-anker-gereedschap (sync_map,
  // reanchor_pos, is_opennova, ...) loopt over ditzelfde kanaal en is nodig
  // om het frame weer geldig te krijgen.
  it('laat niet-bewegingscommando\'s door terwijl het frame niet gevalideerd is', () => {
    markFrameUnvalidated(SN);
    publishExtendedCommand(SN, { is_opennova: {} });
    publishExtendedCommand(SN, { sync_map: {} });
    publishExtendedCommand(SN, { reanchor_pos: { lat: 52.0, lng: 5.0 } });
    expect(publishToTopic).toHaveBeenCalledTimes(3);
  });

  it('laat mow_zone en start_edge_cut weer door na validatie', () => {
    markFrameUnvalidated(SN);
    clearFrameUnvalidated(SN);
    publishExtendedCommand(SN, { mow_zone: { map: 'map1' } });
    publishExtendedCommand(SN, { start_edge_cut: { mapName: 'map0', bladeHeight: 40 } });
    expect(publishToTopic).toHaveBeenCalledTimes(2);
  });
});
