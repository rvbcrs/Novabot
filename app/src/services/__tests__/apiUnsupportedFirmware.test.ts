import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient, ApiError, isUnsupportedFirmwareError } from '../api';

/**
 * De server heeft één centraal firmware-gate: routes die OpenNova custom
 * firmware vereisen antwoorden op stock met 409 + reason 'unsupported_firmware'.
 * request() moet dat op een typed ApiError mappen; andere statussen blijven
 * een gewone Error.
 */
describe('ApiClient unsupported_firmware mapping', () => {
  it('shows the area-limit explanation and does not classify it as a legacy-fallback trigger', async () => {
    const message = 'Select only map0–map4; later slots trigger firmware error 125.';
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      ok: false, reason: 'unsupported_mowing_area', error: message,
    }), { status: 422 }));
    const api = new ApiClient('http://server');
    let caught: unknown;
    try { await api.sendCommand('SN', { start_navigation: { area: 100001 } }); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as Error).message).toBe(message);
    expect(isUnsupportedFirmwareError(caught)).toBe(false);
  });
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
