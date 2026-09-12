/**
 * mqtt_node op de maaier onthoudt het laatste cmd_num en beantwoordt hetzelfde
 * nummer direct met result:1, zonder de firmware aan te roepen. Een teller die
 * na een serverherstart weer op 1 begint botst daarmee: het wissen van map7
 * werd stil geweigerd (live .244, 2026-09-12).
 */
import { describe, it, expect, vi } from 'vitest';

// mapSync trekt de broker-keten mee; die hoeft hier niet echt te draaien.
vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: () => true,
  writeRawPublish: () => false,
  getBrokerDiagnostics: () => ({}),
  startMqttBroker: () => undefined,
  forceDisconnectDevice: () => false,
}));
vi.mock('../../dashboard/socketHandler.js', () => ({
  emitMapsChanged: () => undefined,
  pushMqttLog: () => undefined,
  emitExtendedEvent: () => undefined,
  emitCommandRespond: () => undefined,
  setOutlineEmitter: () => undefined,
}));
vi.mock('../../services/demoSimulator.js', () => ({
  isDemoMode: () => false,
  setDemoInterceptor: () => undefined,
}));

import { getNextCmdNum } from '../../mqtt/mapSync.js';

describe('getNextCmdNum', () => {
  it('begint niet op 1 maar hoog genoeg om na een herstart niet te botsen', () => {
    const first = getNextCmdNum('LFIN_CMDNUM_A');
    expect(first).toBeGreaterThan(1);
    expect(first).toBeLessThanOrEqual(60000);
  });

  it('telt op en herhaalt zich niet', () => {
    const sn = 'LFIN_CMDNUM_B';
    const seen = new Set<number>();
    let prev = -1;
    for (let i = 0; i < 5; i++) {
      const n = getNextCmdNum(sn);
      expect(n).not.toBe(prev);
      seen.add(n);
      prev = n;
    }
    expect(seen.size).toBe(5);
  });

  it('houdt tellers per maaier gescheiden', () => {
    const a1 = getNextCmdNum('LFIN_CMDNUM_C');
    getNextCmdNum('LFIN_CMDNUM_D');
    const a2 = getNextCmdNum('LFIN_CMDNUM_C');
    expect(a2).toBe(a1 + 1);
  });
});
