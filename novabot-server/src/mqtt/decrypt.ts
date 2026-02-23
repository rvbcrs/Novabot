/**
 * Maaier MQTT payload AES decryptie.
 *
 * Probeert een groot aantal key/IV/mode combinaties.
 * De juiste key is nog onbekend (runtime-derived, niet statisch in APK).
 * Als de key ooit gevonden wordt, kan deze module vereenvoudigd worden.
 */
import crypto from 'crypto';

// Alle key kandidaten — inclusief hash-afgeleide keys
function buildKeyCandidates(): { key: Buffer }[] {
  const candidates: { key: Buffer }[] = [];

  const utf8Keys = [
    '1234123412ABCDEF', 'ABCDEF1234123412',
    'li9hep19jzd4wac6', 'jzd4wac6li9hep19',
    'li9hep19li9hep19', 'jzd4wac6jzd4wac6',
    '3e1af419a269a5f8', '66a7d3c25c3df80a',
    'e979259373ff2b18', '5eeefca380d02919',
    'd6031998d1b3bbfe', '0000000000000000',
  ];
  for (const s of utf8Keys) {
    const buf = Buffer.from(s, 'utf8');
    if (buf.length === 16) candidates.push({ key: buf });
  }

  // AES-256 (32-byte keys)
  for (const s of [
    '3e1af419a269a5f866a7d3c25c3df80a', 'e979259373ff2b182f49d4ce7e1bbc8b',
    'd6031998d1b3bbfebf59cc9bbff9aee1', 'li9hep19jzd4wac6li9hep19jzd4wac6',
  ]) {
    const buf = Buffer.from(s, 'utf8');
    if (buf.length === 32) candidates.push({ key: buf });
  }

  // Hex-gedecodeerde keys (32 hex chars → 16 bytes = AES-128)
  for (const h of [
    '3e1af419a269a5f866a7d3c25c3df80a', 'e979259373ff2b182f49d4ce7e1bbc8b',
    'd6031998d1b3bbfebf59cc9bbff9aee1', '5eeefca380d02919dc2c6558bb6d8a5d',
    'e87579c11079f43dd824993c2cee5ed3',
  ]) {
    const buf = Buffer.from(h, 'hex');
    if (buf.length === 16) candidates.push({ key: buf });
  }

  // Hash-afgeleide keys (MD5, SHA-256)
  for (const input of [
    'LFIN2230700238', 'LFIC1230700004', 'li9hep19', 'jzd4wac6',
    'li9hep19jzd4wac6', 'novabot', 'NOVABOT', 'lfibot', '6688',
    'LFIN2230700238_6688', '1234123412ABCDEF',
  ]) {
    candidates.push({ key: crypto.createHash('md5').update(input).digest() });
    candidates.push({ key: crypto.createHash('sha256').update(input).digest().subarray(0, 16) });
    candidates.push({ key: crypto.createHash('sha256').update(input).digest() });
  }

  return candidates;
}

const KEY_CANDIDATES = buildKeyCandidates();

const IV_CANDIDATES: (Buffer | null)[] = [
  null, // same-as-key
  Buffer.from('1234123412ABCDEF', 'utf8'),
  Buffer.alloc(16, 0),
  Buffer.alloc(0), // payload[:16]
  Buffer.from('li9hep19jzd4wac6', 'utf8'),
  Buffer.from('jzd4wac6li9hep19', 'utf8'),
];

function isPrintableJson(buf: Buffer): boolean {
  if (buf.length < 2) return false;
  const first = buf[0];
  if (first !== 0x7b && first !== 0x5b && first !== 0x22 && !(first >= 0x61 && first <= 0x7a)) return false;
  let printable = 0;
  const check = Math.min(buf.length, 40);
  for (let i = 0; i < check; i++) {
    const c = buf[i];
    if ((c >= 32 && c <= 126) || c === 10 || c === 13 || c === 9) printable++;
  }
  return printable / check > 0.85;
}

export function tryDecrypt(payload: Buffer): string | null {
  for (const { key } of KEY_CANDIDATES) {
    const kLen = key.length;
    if (kLen !== 16 && kLen !== 32) continue;

    const algoCbc = kLen === 16 ? 'aes-128-cbc' : 'aes-256-cbc';
    const algoEcb = kLen === 16 ? 'aes-128-ecb' : 'aes-256-ecb';

    // ECB
    if (payload.length >= 16 && payload.length % 16 === 0) {
      const r = attempt(payload, key, Buffer.alloc(0), algoEcb);
      if (r && isPrintableJson(r)) return r.toString('utf8');
    }

    // CBC met diverse IVs
    for (const ivCandidate of IV_CANDIDATES) {
      let iv: Buffer;
      let cipher: Buffer;

      if (ivCandidate === null) {
        iv = key.subarray(0, 16);
        cipher = payload;
      } else if (ivCandidate.length === 0) {
        if (payload.length < 32) continue;
        iv = payload.subarray(0, 16);
        cipher = payload.subarray(16);
      } else {
        iv = ivCandidate.subarray(0, 16);
        cipher = payload;
      }

      if (cipher.length < 16 || cipher.length % 16 !== 0) continue;

      const r = attempt(cipher, key, iv, algoCbc);
      if (r && isPrintableJson(r)) return r.toString('utf8');
    }
  }

  return null;
}

function attempt(cipher: Buffer, key: Buffer, iv: Buffer, algo: string): Buffer | null {
  try {
    const d = algo.includes('ecb')
      ? crypto.createDecipheriv(algo, key, null)
      : crypto.createDecipheriv(algo, key, iv);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(cipher), d.final()]);
  } catch {
    return null;
  }
}
