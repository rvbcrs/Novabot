import { describe, it, expect, vi } from 'vitest';

// ── Mock heavy deps VOOR de import van dashboard.ts ───────────
// dashboard.ts sleept via broker.js/socketHandler.js/demoSimulator.js een
// circulaire import mee die crasht in de vitest :memory: omgeving. Zelfde
// mock-set als de andere route-tests (bv. dashboardSystemLogs.test.ts).

vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(false),
  writeRawPublish: vi.fn().mockReturnValue(false),
  getBrokerDiagnostics: vi.fn().mockReturnValue({}),
  startMqttBroker: vi.fn(),
}));

vi.mock('../../dashboard/socketHandler.js', () => ({
  getRecentLogs: vi.fn(() => []),
  forwardToDashboard: vi.fn(),
  onLogEntry: vi.fn(),
  emitMapsChanged: vi.fn(),
  emitDeviceOnline: vi.fn(),
  emitDeviceOffline: vi.fn(),
  emitTrailClear: vi.fn(),
  emitCoveredLanes: vi.fn(),
  setDemoModeChecker: vi.fn(),
  setOutlineEmitter: vi.fn(),
  initBleLogger: vi.fn(),
  sendBleLogHistory: vi.fn(),
  pushMqttLog: vi.fn(),
  emitOtaEvent: vi.fn(),
  emitPinEvent: vi.fn(),
  emitExtendedEvent: vi.fn(),
  emitCommandRespond: vi.fn(),
}));

vi.mock('../../mqtt/mapSync.js', () => ({
  requestMapList: vi.fn(),
  requestMapOutline: vi.fn(),
  publishToDevice: vi.fn(),
  publishRawToDevice: vi.fn(),
  publishEncryptedOnTopic: vi.fn(),
  publishToTopic: vi.fn(),
  goToChargePayload: vi.fn(),
  getNextCmdNum: vi.fn().mockReturnValue(1),
  initMapSync: vi.fn(),
  handleMapMessage: vi.fn(),
  handleExtendedResponse: vi.fn(),
  handleDeviceResponse: vi.fn(),
  publishToExtended: vi.fn(),
  onExtendedResponse: vi.fn(),
  offExtendedResponse: vi.fn(),
  notifyRespond: vi.fn(),
  setDemoInterceptor: vi.fn(),
  onMowerConnected: vi.fn(),
}));

vi.mock('../../mqtt/mapConverter.js', () => ({
  generateMapZipFromDb: vi.fn(),
  gpsToLocal: vi.fn(),
  localToGps: vi.fn(),
  parseMapZip: vi.fn(),
}));

vi.mock('../../services/demoSimulator.js', () => ({
  isDemoMode: vi.fn().mockReturnValue(false),
  setDemoMode: vi.fn(),
  getDemoStatus: vi.fn().mockReturnValue({}),
  setDemoInterceptor: vi.fn(),
}));

vi.mock('../../services/mowerIpDiscovery.js', () => ({
  resolveMowerIp: vi.fn().mockResolvedValue(null),
  startMowerIpDiscovery: vi.fn(),
}));

// ── Nu pas dashboard.ts importeren (na de mocks) ───────────
import { parseEdgeDays, serializeEdgeDays } from '../../routes/dashboard.js';

describe('edge_days DTO-mapping', () => {
  it('parseEdgeDays: JSON-string → array, NULL → null', () => {
    expect(parseEdgeDays('[5]')).toEqual([5]);
    expect(parseEdgeDays(null)).toBeNull();
    expect(parseEdgeDays('[]')).toEqual([]);
    expect(parseEdgeDays('garbage')).toBeNull(); // corrupt → null (geen crash)
  });
  it('serializeEdgeDays: array → JSON, null/undefined → null', () => {
    expect(serializeEdgeDays([1, 4])).toBe('[1,4]');
    expect(serializeEdgeDays(null)).toBeNull();
    expect(serializeEdgeDays(undefined)).toBeUndefined(); // undefined = niet aanraken bij PATCH
  });
});
