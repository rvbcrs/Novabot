import { createCipheriv } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { isMapMqttPacketBlocked } from '../../mqtt/mapCommandGuard.js';
import { withMowerMapOperation } from '../../services/mowerMapOperation.js';
import { markFrameUnvalidated, clearFrameUnvalidated } from '../../services/frameValidation.js';

const SN = 'LFIN_GUARD_0238';
const topic = `Dart/Send_mqtt/${SN}`;
const start = JSON.stringify({ start_navigation: { cmd_num: 1 } });
function encrypt(json: string): Buffer {
  const bytes = Buffer.from(json);
  const padded = Buffer.alloc(Math.ceil(bytes.length / 16) * 16);
  bytes.copy(padded);
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(`abcdabcd1234${SN.slice(-4)}`), Buffer.from('abcd1234abcd1234'));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

describe('direct app MQTT map guard', () => {
  afterEach(() => clearFrameUnvalidated(SN));

  it('blocks plaintext, encrypted and extended autonomous commands during a lease, while allowing manual control and stops', async () => {
    await withMowerMapOperation(SN, async () => {
      expect(isMapMqttPacketBlocked(topic, start)).toBe(true);
      expect(isMapMqttPacketBlocked(topic, encrypt(start))).toBe(true);
      expect(isMapMqttPacketBlocked(`novabot/extended/${SN}`, JSON.stringify({ mow_zone: {} }))).toBe(true);
      expect(isMapMqttPacketBlocked(`novabot/extended/${SN}`, JSON.stringify({ write_map_files: {} }))).toBe(true);
      expect(isMapMqttPacketBlocked(topic, JSON.stringify({ set_remote_control: { linear: 0 }, stop_navigation: {} }))).toBe(false);
      expect(isMapMqttPacketBlocked(`Dart/Receive_mqtt/${SN}`, start)).toBe(false);
    });
    expect(isMapMqttPacketBlocked(topic, start)).toBe(false);
  });

  it('still blocks app navigation after an interrupted operation has invalidated the frame', () => {
    markFrameUnvalidated(SN);
    expect(isMapMqttPacketBlocked(topic, encrypt(start))).toBe(true);
    expect(isMapMqttPacketBlocked(topic, JSON.stringify({ stop_navigation: {} }))).toBe(false);
  });
});
