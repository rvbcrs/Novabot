import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient, ApiError, isUnsupportedFirmwareError } from '../api';

/**
 * De server heeft één centraal firmware-gate: routes die OpenNova custom
 * firmware vereisen antwoorden op stock met 409 + reason 'unsupported_firmware'.
 * request() moet dat op een typed ApiError mappen; andere statussen blijven
 * een gewone Error.
 */
describe('ApiClient unsupported_firmware mapping', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mapt 409 + reason unsupported_firmware op ApiError', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({
        ok: false,
        reason: 'unsupported_firmware',
        msgKey: 'requiresOpenNovaFirmware',
        error: 'Mower runs stock firmware',
      }), { status: 409, headers: { 'Content-Type': 'application/json' } }));

    const api = new ApiClient('https://example.invalid');
    let caught: unknown;
    try { await api.sendExtended('LFIN0000', { blade_on: {} }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ApiError);
    expect(isUnsupportedFirmwareError(caught)).toBe(true);
    const err = caught as ApiError;
    expect(err.status).toBe(409);
    expect(err.reason).toBe('unsupported_firmware');
    expect(err.msgKey).toBe('requiresOpenNovaFirmware');
    expect(err.message).toBe('Mower runs stock firmware');
  });

  it('laat een 409 met een andere reason als gewone Error', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: false, reason: 'busy' }), { status: 409 }));

    const api = new ApiClient('https://example.invalid');
    let caught: unknown;
    try { await api.reanchor('LFIN0000', 'invalidate'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ApiError);
    expect(isUnsupportedFirmwareError(caught)).toBe(false);
    expect((caught as Error).message).toMatch(/^HTTP 409/);
  });

  it('laat andere statussen ongemoeid', async () => {
    vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }));

    const api = new ApiClient('https://example.invalid');
    await expect(api.mappingPreflight('LFIN0000')).rejects.toThrow(/^HTTP 500: boom/);
    expect(isUnsupportedFirmwareError(new Error('x'))).toBe(false);
    expect(isUnsupportedFirmwareError(null)).toBe(false);
  });
});
