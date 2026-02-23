/**
 * Maaier MQTT payload analyse + AES decryptie pogingen.
 *
 * Dumpt de eerste 3 volledige payloads naar bestanden voor offline analyse,
 * en probeert tegelijk een groot aantal key/IV combinaties.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const DUMP_DIR = path.resolve(__dirname, '../../captured');

// Alle key kandidaten — inclusief hash-afgeleide keys
function buildKeyCandidates(): { name: string; key: Buffer }[] {
  const candidates: { name: string; key: Buffer }[] = [];

  // Directe UTF-8 strings
  const utf8Keys = [
    '1234123412ABCDEF',
    'ABCDEF1234123412',
    'li9hep19jzd4wac6',     // MQTT credentials concat
    'jzd4wac6li9hep19',     // reversed
    'li9hep19li9hep19',
    'jzd4wac6jzd4wac6',
    '3e1af419a269a5f8',
    '66a7d3c25c3df80a',
    'e979259373ff2b18',
    '5eeefca380d02919',
    'd6031998d1b3bbfe',
    'LFIN2230700238_6',     // SN + partial suffix = 16 chars
    'LFIC1230700004_6',
    '0000000000000000',
  ];
  for (const s of utf8Keys) {
    const buf = Buffer.from(s, 'utf8');
    if (buf.length === 16) candidates.push({ name: `utf8:"${s}"`, key: buf });
  }

  // AES-256 (32-byte keys)
  const utf8Keys256 = [
    '3e1af419a269a5f866a7d3c25c3df80a',
    'e979259373ff2b182f49d4ce7e1bbc8b',
    'd6031998d1b3bbfebf59cc9bbff9aee1',
    'li9hep19jzd4wac6li9hep19jzd4wac6',
  ];
  for (const s of utf8Keys256) {
    const buf = Buffer.from(s, 'utf8');
    if (buf.length === 32) candidates.push({ name: `utf8-256:"${s.substring(0, 16)}..."`, key: buf });
  }

  // 32-char hex strings gedecodeerd als binary (= 16 bytes = AES-128)
  const hexKeys = [
    '3e1af419a269a5f866a7d3c25c3df80a',
    'e979259373ff2b182f49d4ce7e1bbc8b',
    'd6031998d1b3bbfebf59cc9bbff9aee1',
    '5eeefca380d02919dc2c6558bb6d8a5d',
    'e87579c11079f43dd824993c2cee5ed3',
  ];
  for (const h of hexKeys) {
    const buf = Buffer.from(h, 'hex');
    if (buf.length === 16) candidates.push({ name: `hex:${h.substring(0, 16)}...`, key: buf });
  }

  // MD5 hash-afgeleide keys
  const hashInputs = [
    'LFIN2230700238',
    'LFIC1230700004',
    'li9hep19',
    'jzd4wac6',
    'li9hep19jzd4wac6',
    'novabot',
    'NOVABOT',
    'lfibot',
    '6688',
    'LFIN2230700238_6688',
    '1234123412ABCDEF',
  ];
  for (const input of hashInputs) {
    const md5 = crypto.createHash('md5').update(input).digest();
    candidates.push({ name: `md5("${input}")`, key: md5 });
    // Ook SHA-256 eerste 16 bytes
    const sha = crypto.createHash('sha256').update(input).digest().subarray(0, 16);
    candidates.push({ name: `sha256("${input}")[:16]`, key: sha });
    // SHA-256 volledig = 32 bytes = AES-256
    const shaFull = crypto.createHash('sha256').update(input).digest();
    candidates.push({ name: `sha256("${input}")`, key: shaFull });
  }

  return candidates;
}

const KEY_CANDIDATES = buildKeyCandidates();

const IV_CANDIDATES: { name: string; iv: Buffer | null }[] = [
  { name: 'same-as-key',      iv: null }, // speciale marker
  { name: '1234123412ABCDEF', iv: Buffer.from('1234123412ABCDEF', 'utf8') },
  { name: 'zeros',            iv: Buffer.alloc(16, 0) },
  { name: 'payload[:16]',     iv: Buffer.alloc(0) }, // speciale marker: eerste 16 bytes
  { name: 'li9hep19jzd4wac6', iv: Buffer.from('li9hep19jzd4wac6', 'utf8') },
  { name: 'jzd4wac6li9hep19', iv: Buffer.from('jzd4wac6li9hep19', 'utf8') },
];

function isPrintableJson(buf: Buffer): boolean {
  if (buf.length < 2) return false;
  const first = buf[0];
  // JSON start: { [ " of letter
  if (first !== 0x7b && first !== 0x5b && first !== 0x22 && !(first >= 0x61 && first <= 0x7a)) return false;
  let printable = 0;
  const check = Math.min(buf.length, 40);
  for (let i = 0; i < check; i++) {
    const c = buf[i];
    if ((c >= 32 && c <= 126) || c === 10 || c === 13 || c === 9) printable++;
  }
  return printable / check > 0.85;
}

let dumpCount = 0;
let foundCombo: { keyIdx: number; ivIdx: number; algo: string; payloadIv: boolean } | null = null;

export function tryDecrypt(payload: Buffer): string | null {
  // Dump de eerste 3 payloads naar bestanden
  if (dumpCount < 3 && payload.length > 50) {
    try {
      fs.mkdirSync(DUMP_DIR, { recursive: true });
      const fname = path.join(DUMP_DIR, `mower_payload_${dumpCount}_${payload.length}B.bin`);
      fs.writeFileSync(fname, payload);
      console.log(`[AES-DUMP] Saved ${payload.length}B → ${fname}`);
      // Ook hex naar console (eerste 128 bytes)
      console.log(`[AES-DUMP] hex[0:128]: ${payload.subarray(0, 128).toString('hex')}`);
    } catch (e) {
      console.error(`[AES-DUMP] Error: ${e}`);
    }
    dumpCount++;
  }

  // Probeer alle combinaties
  for (const keyInfo of KEY_CANDIDATES) {
    const kLen = keyInfo.key.length;
    if (kLen !== 16 && kLen !== 32) continue;

    const algoCbc = kLen === 16 ? 'aes-128-cbc' : 'aes-256-cbc';
    const algoEcb = kLen === 16 ? 'aes-128-ecb' : 'aes-256-ecb';

    // ECB
    if (payload.length >= 16 && payload.length % 16 === 0) {
      const r = attempt(payload, keyInfo.key, Buffer.alloc(0), algoEcb);
      if (r && isPrintableJson(r)) {
        console.log(`[AES] ✅ key=${keyInfo.name} mode=ECB`);
        return r.toString('utf8');
      }
    }

    // CBC met diverse IVs
    for (const ivInfo of IV_CANDIDATES) {
      let iv: Buffer;
      let cipher: Buffer;

      if (ivInfo.iv === null) {
        // same-as-key
        iv = keyInfo.key.subarray(0, 16);
        cipher = payload;
      } else if (ivInfo.iv.length === 0) {
        // payload[:16]
        if (payload.length < 32) continue;
        iv = payload.subarray(0, 16);
        cipher = payload.subarray(16);
      } else {
        iv = ivInfo.iv.subarray(0, 16);
        cipher = payload;
      }

      if (cipher.length < 16 || cipher.length % 16 !== 0) continue;

      const r = attempt(cipher, keyInfo.key, iv, algoCbc);
      if (r && isPrintableJson(r)) {
        console.log(`[AES] ✅ key=${keyInfo.name} iv=${ivInfo.name} mode=CBC`);
        return r.toString('utf8');
      }
    }
  }

  return null;
}

function attempt(cipher: Buffer, key: Buffer, iv: Buffer, algo: string): Buffer | null {
  try {
    const d = algo.includes('ecb')
      ? crypto.createDecipheriv(algo, key, null)
      : crypto.createDecipheriv(algo, key, iv);
    d.setAutoPadding(false); // geen padding check — we willen raw output zien
    return Buffer.concat([d.update(cipher), d.final()]);
  } catch {
    return null;
  }
}
