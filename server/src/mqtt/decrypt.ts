/**
 * Maaier MQTT payload AES-128-CBC decryptie.
 *
 * Key derivatie (ontdekt via blutter decompilatie van APK v2.4.0):
 *   key = "abcdabcd1234" + SN.substring(SN.length - 4)   (16 bytes UTF-8)
 *   IV  = "abcd1234abcd1234"                               (16 bytes UTF-8, statisch)
 *
 * Bron: package:flutter_novabot/mqtt/encrypt_utils.dart
 */
import crypto from 'crypto';

const KEY_PREFIX = 'abcdabcd1234';
const IV = Buffer.from('abcd1234abcd1234', 'utf8');

function buildKey(sn: string): Buffer {
  const suffix = sn.slice(-4);
  return Buffer.from(KEY_PREFIX + suffix, 'utf8');
}

/**
 * Ontsleutelt een AES-128-CBC versleuteld maaier MQTT bericht.
 * @param payload  Versleutelde bytes (moet deelbaar zijn door 16)
 * @param sn       Serienummer van het apparaat (bijv. "LFIN2230700238")
 * @returns        Ontsleutelde JSON string, of null bij fout
 */
export function tryDecrypt(payload: Buffer, sn: string): string | null {
  if (!sn || sn.length < 4) return null;
  if (payload.length < 16 || payload.length % 16 !== 0) return null;

  try {
    const key = buildKey(sn);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, IV);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);

    // Strip null-byte padding (app paddet naar 64-byte grens met \0)
    let end = decrypted.length;
    while (end > 0 && decrypted[end - 1] === 0) end--;
    if (end === 0) return null;

    const json = decrypted.subarray(0, end).toString('utf8');

    // Valideer dat het JSON is
    if (json[0] !== '{' && json[0] !== '[') return null;

    return json;
  } catch {
    return null;
  }
}
