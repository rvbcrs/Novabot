/**
 * Remote PIN verify waits for the mower and says why it failed. Field report:
 * custom-45 with stock MCU v3.6.0 got no CMD 0x23 answer, and the old route
 * reported the mower as unlocked anyway.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Handler = (d: Record<string, unknown>) => void;
const sent: Array<Record<string, unknown>> = [];
let handlers: Handler[] = [];
let autoAnswer: ((cmd: Record<string, unknown>) => Record<string, unknown> | null) | null = null;

vi.mock('../../mqtt/mapSync.js', () => ({
  onExtendedResponse: vi.fn((_sn: string, h: Handler) => { handlers.push(h); }),
  offExtendedResponse: vi.fn((_sn: string, h: Handler) => { handlers = handlers.filter(x => x !== h); }),
}));
vi.mock('../../mqtt/extendedCommands.js', () => ({
  publishExtendedCommand: vi.fn((_sn: string, cmd: Record<string, unknown>) => {
    sent.push(cmd);
    const answer = autoAnswer?.(cmd);
    if (answer) for (const h of [...handlers]) h(answer);
  }),
}));

import { pinVerifyOutcome, pinVerifyMessage, verifyPinOnMower } from '../../services/pinVerify.js';
import { translator } from '../../services/serverText.js';

const SN = 'LFIN_PIN_VERIFY';
const opId = (cmd: Record<string, unknown>) => (cmd.verify_pin as { operation_id: string }).operation_id;

beforeEach(() => { sent.length = 0; handlers = []; autoAnswer = null; });
afterEach(() => { vi.useRealTimers(); });

describe('pinVerifyOutcome', () => {
  it('reads the reason the mower sends', () => {
    expect(pinVerifyOutcome({ result: 0, status: 'verified' })).toEqual({ ok: true });
    expect(pinVerifyOutcome({ result: 2, error: 'no_response', reason: 'mcu_no_answer', hint: 'stock v3.6.0 ...' }))
      .toEqual({ ok: false, reason: 'mcu_no_answer', hint: 'stock v3.6.0 ...' });
    expect(pinVerifyOutcome({ result: 1, status: 'wrong_pin', reason: 'wrong_pin' })).toEqual({ ok: false, reason: 'wrong_pin' });
    expect(pinVerifyOutcome({ result: 2, error: 'Permission denied', reason: 'serial_error' })).toEqual({ ok: false, reason: 'serial_error' });
  });

  it('understands firmware from before the reason field (custom-45)', () => {
    expect(pinVerifyOutcome({ result: 2, error: 'no_response' })).toEqual({ ok: false, reason: 'mcu_no_answer' });
    expect(pinVerifyOutcome({ result: 1, status: 'wrong_pin' })).toEqual({ ok: false, reason: 'wrong_pin' });
    expect(pinVerifyOutcome({ result: 2, error: 'could not open port /dev/ttyACM0' })).toEqual({ ok: false, reason: 'serial_error' });
    expect(pinVerifyOutcome({ result: 1, status: 'unknown_status_7' })).toEqual({ ok: false, reason: 'unexpected_answer' });
  });

  it('no answer from the mower at all is its own reason', () => {
    expect(pinVerifyOutcome(null)).toEqual({ ok: false, reason: 'no_reply' });
  });
});

describe('pinVerifyMessage', () => {
  it('names the old MCU firmware when the motor board stays silent', () => {
    const en = pinVerifyMessage('mcu_no_answer', translator('en'));
    expect(en).toContain('v3.6.0');
    expect(en).toContain('v3.6.2');
    expect(en).not.toContain('—');
    expect(pinVerifyMessage('mcu_no_answer', translator('nl'))).toContain('scherm van de maaier');
    expect(pinVerifyMessage('wrong_pin', translator('de'))).toBe('Falsche PIN');
  });
});

describe('verifyPinOnMower', () => {
  it('sends verify_pin with an operation id and returns the matching answer', async () => {
    autoAnswer = cmd => ({ verify_pin_respond: { result: 0, status: 'verified', operation_id: opId(cmd) } });
    await expect(verifyPinOnMower(SN, '1234')).resolves.toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ verify_pin: { code: '1234', operation_id: expect.any(String) } });
    expect(handlers).toHaveLength(0);
  });

  it('ignores answers to another request', async () => {
    vi.useFakeTimers();
    autoAnswer = () => ({ verify_pin_respond: { result: 0, status: 'verified', operation_id: 'someone-else' } });
    const pending = verifyPinOnMower(SN, '1234', 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'no_reply' });
    expect(handlers).toHaveLength(0);
  });

  it('takes the uncorrelated answer of custom-45 and older', async () => {
    autoAnswer = () => ({ verify_pin_respond: { result: 2, error: 'no_response' } });
    await expect(verifyPinOnMower(SN, '1234')).resolves.toEqual({ ok: false, reason: 'mcu_no_answer' });
  });

  it('times out to no_reply when extended_commands does not answer', async () => {
    vi.useFakeTimers();
    const pending = verifyPinOnMower(SN, '1234', 15_000);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(handlers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'no_reply' });
    expect(handlers).toHaveLength(0);
  });
});
