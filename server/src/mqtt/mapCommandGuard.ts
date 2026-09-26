import { isMapOperationCommandBlocked, isMowerMapOperationBusy } from '../services/mowerMapOperation.js';
import { isFrameNavBlocked, isFrameUnvalidated } from '../services/frameValidation.js';
import { tryDecrypt } from './decrypt.js';

/** The app publishes directly to MQTT, outside our server publish helpers. */
export function isMapMqttPacketBlocked(topic: string, payload: Buffer | string): boolean {
  const sn = topic.match(/^(?:Dart\/Send_mqtt|novabot\/extended)\/(LFIN[^/]+)$/)?.[1];
  if (!sn) return false;
  try {
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const command = JSON.parse(tryDecrypt(bytes, sn) ?? bytes.toString('utf8')) as unknown;
    if (command && typeof command === 'object' && !Array.isArray(command)) {
      return isFrameNavBlocked(sn, command as Record<string, unknown>) || isMapOperationCommandBlocked(sn, command as Record<string, unknown>);
    }
  } catch { /* An undecodable command cannot be proven safe during a map operation. */ }
  return isMowerMapOperationBusy(sn) || isFrameUnvalidated(sn);
}
