/**
 * Remote PIN verify, OpenNova firmware only.
 *
 * extended_commands.py (serial_pin_verify) takes /dev/ttyACM0 from
 * chassis_control_node and sends the PIN to the motor board (STM32) as
 * CMD 0x23 type=2, then answers verify_pin_respond. Not via MQTT
 * dev_pin_info: mqtt_node's C++ ChassisPinCodeSet action client never finds
 * its action server (21 s timeout) and then reports error_status=151 itself.
 *
 * The route used to fire the command and report success straight away, so a
 * motor board that never answered looked like an unlocked mower, and the PIN
 * error stayed hidden behind markPinVerified. Stock MCU firmware v3.6.0 sends
 * no answer to type=2 (field report: custom-45 with MCU v3.6.0): remote verify
 * came with the patched MCU builds (v3.6.2 and later), and the custom firmware
 * build keeps the stock v3.6.0. So the route now waits for the mower and says
 * why it failed.
 */
import { randomUUID } from 'node:crypto';
import { onExtendedResponse, offExtendedResponse } from '../mqtt/mapSync.js';
import { publishExtendedCommand } from '../mqtt/extendedCommands.js';
import type { Translate } from './serverText.js';

export type PinVerifyReason =
  | 'mcu_no_answer'      // the motor board sent no CMD 0x23 answer
  | 'wrong_pin'          // the motor board refused the PIN
  | 'invalid_pin'        // not 4 digits
  | 'unexpected_answer'  // the motor board answered something else
  | 'serial_error'       // the mower could not use the serial port
  | 'no_reply';          // the mower itself did not answer in time

export interface PinVerifyOutcome {
  ok: boolean;
  reason?: PinVerifyReason;
  /** The mower's own (English) hint, when it sent one. */
  hint?: string;
}

/** Serial verify (≤2.6 s) plus five clear-error rounds after a success (~5 s), with margin. */
export const PIN_VERIFY_TIMEOUT_MS = 15_000;

const MOWER_REASONS: readonly PinVerifyReason[] = ['mcu_no_answer', 'wrong_pin', 'invalid_pin', 'unexpected_answer', 'serial_error'];

/**
 * Reads verify_pin_respond. Firmware from before the reason field still
 * answers {result:2, error:"no_response"} when the motor board stays silent,
 * {result:1, status:"wrong_pin"} for a wrong PIN and {result:2, error} for a
 * serial failure; those map to the same reasons.
 */
export function pinVerifyOutcome(body: Record<string, unknown> | null): PinVerifyOutcome {
  if (!body) return { ok: false, reason: 'no_reply' };
  if (body.result === 0) return { ok: true };
  const hint = typeof body.hint === 'string' && body.hint ? body.hint : undefined;
  const withHint = (reason: PinVerifyReason): PinVerifyOutcome => (hint ? { ok: false, reason, hint } : { ok: false, reason });
  if (typeof body.reason === 'string' && (MOWER_REASONS as readonly string[]).includes(body.reason)) {
    return withHint(body.reason as PinVerifyReason);
  }
  if (body.error === 'no_response') return withHint('mcu_no_answer');
  if (body.status === 'wrong_pin') return withHint('wrong_pin');
  if (body.result === 2) return withHint('serial_error');
  return withHint('unexpected_answer');
}

/** What the user reads for a failed verify. */
export function pinVerifyMessage(reason: PinVerifyReason, T: Translate): string {
  switch (reason) {
    case 'mcu_no_answer':
      return T`De motorprint van de maaier gaf geen antwoord op de PIN-controle. Oudere MCU-firmware ondersteunt dat mogelijk niet: stock v3.6.0 antwoordt er niet op, PIN-controle op afstand kwam met de gepatchte MCU-versies (v3.6.2 en later). Voer de PIN in op het scherm van de maaier.`;
    case 'wrong_pin':
      return T`Onjuiste PIN`;
    case 'invalid_pin':
      return T`PIN moet 4 cijfers zijn`;
    case 'serial_error':
      return T`De maaier kon de motorprint niet bereiken via de seriële poort`;
    case 'unexpected_answer':
      return T`De motorprint gaf een onverwacht antwoord op de PIN-controle`;
    case 'no_reply':
      return T`De maaier gaf geen antwoord op de PIN-controle`;
  }
}

/**
 * Send verify_pin and wait for the mower's answer. Never rejects (the route is
 * an Express 4 async handler): no answer, or a publish that throws, is the
 * outcome { ok:false, reason:'no_reply' }.
 */
export function verifyPinOnMower(sn: string, code: string, timeoutMs = PIN_VERIFY_TIMEOUT_MS): Promise<PinVerifyOutcome> {
  const operationId = randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (body: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offExtendedResponse(sn, handler);
      resolve(pinVerifyOutcome(body));
    };
    const handler = (data: Record<string, unknown>) => {
      const body = data.verify_pin_respond;
      if (!body || typeof body !== 'object') return;
      const id = (body as Record<string, unknown>).operation_id;
      // custom-45 and older echo no operation_id (custom-46 does); their
      // answer is taken as the answer to this request.
      if (id === undefined || id === operationId) finish(body as Record<string, unknown>);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    onExtendedResponse(sn, handler);
    try {
      publishExtendedCommand(sn, { verify_pin: { code, operation_id: operationId } });
    } catch (error) {
      console.warn(`[PIN] verify_pin to ${sn} not sent: ${(error as Error)?.message ?? error}`);
      finish(null);
    }
  });
}
