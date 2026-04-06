import crypto from 'crypto';

const KEY_PREFIX = 'abcdabcd1234';
const IV = Buffer.from('abcd1234abcd1234', 'utf8');

/**
 * AES-128-CBC encrypt for LFI* devices.
 * Key = "abcdabcd1234" + last 4 chars of SN
 * IV = "abcd1234abcd1234" (static)
 * Padding = null-bytes to 16-byte boundary (NOT PKCS7)
 */
export function encryptForDevice(sn: string, command: Record<string, unknown>): Buffer {
  const key = Buffer.from(KEY_PREFIX + sn.slice(-4), 'utf8');
  const json = JSON.stringify(command);
  const plain = Buffer.from(json, 'utf8');

  // Pad with null bytes to 16-byte boundary
  const padded = Buffer.alloc(Math.ceil(plain.length / 16) * 16, 0);
  plain.copy(padded);

  const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

/**
 * AES-128-CBC decrypt from LFI* devices.
 * Returns the decrypted UTF-8 string, or null on error.
 */
export function decryptFromDevice(sn: string, data: Buffer): string | null {
  try {
    const key = Buffer.from(KEY_PREFIX + sn.slice(-4), 'utf8');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, IV);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8').replace(/\0+$/, '');
  } catch {
    return null;
  }
}

/**
 * Calculate MD5 hash of a buffer.
 */
export function md5(data: Buffer): string {
  return crypto.createHash('md5').update(data).digest('hex');
}
