import { describe, it, expect, vi, afterEach } from 'vitest';
import { getMowerFileCapability, isOpenNovaMower, isSimulatedStock, SIMULATED_STOCK_VERSION } from '../../services/mowerFileCapability.js';

const SN = 'LFIN_SIM_STOCK';

describe('SIMULATE_STOCK_FIRMWARE (test-knop voor de firmware-gate)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('treats a listed custom-firmware mower as stock', () => {
    vi.stubEnv('SIMULATE_STOCK_FIRMWARE', ` LFIN_OTHER , ${SN}`);
    expect(isSimulatedStock(SN)).toBe(true);
    const cap = getMowerFileCapability(SN, 'v6.0.2-custom-38');
    expect(cap.isOpenNova).toBe(false);
    expect(cap.mowerVersion).toBe(SIMULATED_STOCK_VERSION);
    expect(isOpenNovaMower(SN, new Map([['sw_version', 'v6.0.2-custom-38']]))).toBe(false);
    // Mag NOOIT als v5 lezen: dashboard.ts zou dan AES uitzetten voor een v6-maaier.
    expect(SIMULATED_STOCK_VERSION.startsWith('5.')).toBe(false);
    expect(SIMULATED_STOCK_VERSION.startsWith('v5.')).toBe(false);
  });

  it('is inert when the variable is unset or lists other mowers', () => {
    vi.stubEnv('SIMULATE_STOCK_FIRMWARE', 'LFIN_OTHER');
    expect(isSimulatedStock(SN)).toBe(false);
    expect(getMowerFileCapability(SN, 'v6.0.2-custom-38').isOpenNova).toBe(true);
    vi.stubEnv('SIMULATE_STOCK_FIRMWARE', '');
    expect(isSimulatedStock(SN)).toBe(false);
  });
});
