/**
 * Test AES decryptie met MQTT credentials als key.
 * li9hep19 + jzd4wac6 = 16 tekens = AES-128 key
 */
import crypto from 'crypto';

// We need the full payload. Let's generate a test with the first 32 hex bytes
// and see if the first BLOCK decrypts to anything readable.
// 800B msg first 64 hex chars = 32 bytes = 2 AES blocks
const HEX_800_FIRST32 = 'bab8033ebbafb64dc09d523934626ed57d14fc511b376b3993129fb9087516f9';
const HEX_144_FIRST32 = 'f3ae2055de8ffb87ffe33d45334dd8be5bba25f77007212896f082afbc4e3491';
const HEX_496_FIRST32 = '92d5f50382c300ea652d4c260ce2446a5d4580dd0692dd96a58e3d3d06497857';

const KEYS_TO_TRY = [
  { name: 'account+password', key: 'li9hep19jzd4wac6' },  // 16 chars!
  { name: 'password+account', key: 'jzd4wac6li9hep19' },  // reversed
  { name: 'account only x2',  key: 'li9hep19li9hep19' },
  { name: 'password only x2', key: 'jzd4wac6jzd4wac6' },
  { name: 'SN padded',        key: 'LFIN2230700238\0\0' }, // 14 chars + 2 null
  { name: 'SN+_6',            key: 'LFIN2230700238_6' },   // 16 chars
  { name: 'SN first 16',      key: 'LFIN223070023800' },   // padded with 00
  { name: '1234123412ABCDEF', key: '1234123412ABCDEF' },   // original guess (control)
  { name: 'charger SN pad',   key: 'LFIC1230700004\0\0' },
  { name: 'charger SN+_6',    key: 'LFIC1230700004_6' },
  { name: 'novabot_esp32_xx', key: 'novabot_esp32_xx' },   // wild guess
  { name: 'LFI_DEFAULT_KEY!', key: 'LFI_DEFAULT_KEY!' },   // wild guess
  { name: '0000000000000000', key: '0000000000000000' },
  { name: 'ABCDEF1234123412', key: 'ABCDEF1234123412' },   // reversed original
];

const IVS_TO_TRY = [
  { name: 'same as key',      iv: null }, // will use same as key
  { name: '1234123412ABCDEF', iv: Buffer.from('1234123412ABCDEF', 'utf8') },
  { name: 'zeros',            iv: Buffer.alloc(16, 0) },
  { name: 'payload[:16]',     iv: 'PAYLOAD' }, // special marker
];

function tryDec(cipher, key, iv, algo) {
  try {
    const d = algo.includes('ecb')
      ? crypto.createDecipheriv(algo, key, null)
      : crypto.createDecipheriv(algo, key, iv);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(cipher), d.final()]);
  } catch { return null; }
}

function isPrintable(buf) {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if ((c >= 32 && c <= 126) || c === 10 || c === 13 || c === 9) p++;
  }
  return p / buf.length > 0.7;
}

console.log('=== Brute-force AES decryption ===\n');

for (const { name: hexName, hex } of [
  { name: '800B', hex: HEX_800_FIRST32 },
  { name: '144B', hex: HEX_144_FIRST32 },
  { name: '496B', hex: HEX_496_FIRST32 },
]) {
  const fullBuf = Buffer.from(hex, 'hex');
  console.log(`--- ${hexName} (${fullBuf.length} bytes available) ---`);

  for (const keyInfo of KEYS_TO_TRY) {
    const keyBuf = Buffer.from(keyInfo.key, 'utf8');
    if (keyBuf.length !== 16 && keyBuf.length !== 32) continue;

    const algoCbc = keyBuf.length === 16 ? 'aes-128-cbc' : 'aes-256-cbc';
    const algoEcb = keyBuf.length === 16 ? 'aes-128-ecb' : 'aes-256-ecb';

    // ECB
    const ecbResult = tryDec(fullBuf, keyBuf, null, algoEcb);
    if (ecbResult && isPrintable(ecbResult)) {
      console.log(`  ✅ ${keyInfo.name} ECB => "${ecbResult.toString('utf8').substring(0, 60)}"`);
    }

    for (const ivInfo of IVS_TO_TRY) {
      let iv, cipher;
      if (ivInfo.iv === 'PAYLOAD') {
        iv = fullBuf.subarray(0, 16);
        cipher = fullBuf.subarray(16);
      } else if (ivInfo.iv === null) {
        iv = keyBuf.subarray(0, 16);
        cipher = fullBuf;
      } else {
        iv = ivInfo.iv;
        cipher = fullBuf;
      }

      if (cipher.length < 16 || cipher.length % 16 !== 0) continue;

      const result = tryDec(cipher, keyBuf, iv, algoCbc);
      if (result && isPrintable(result)) {
        console.log(`  ✅ ${keyInfo.name} + ${ivInfo.name} CBC => "${result.toString('utf8').substring(0, 60)}"`);
      }
    }
  }
}

console.log('\n=== Done ===');
