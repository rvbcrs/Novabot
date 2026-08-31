// Build the SHARED OpenNova card image — the one published for people who
// cannot run the desktop installer (Chromebooks, Linux without a GUI, ...).
//
// It reuses the installer's own download/verify/patch modules, so the output is
// byte-identical to what the app produces for the same settings. Deliberately
// generic: ethernet, no SSH, no credentials of any kind baked in.
//
//   cd installer && npm run build:main && node scripts/build-shared-image.mjs
//
// Produces release/opennova.zip containing opennova.bin.
import { writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PI_OS_RELEASE } from '../dist/shared/piOsRelease.js';
import {
  resolveLatestImageUrl,
  fetchExpectedSha256,
  downloadImage,
  verifySha256,
  decompressXz,
} from '../dist/main/imageSource.js';
import { patchImageBootPartition, readBootPartitionOffset } from '../dist/main/imagePatcher.js';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// mtools lives in vendor/ during development (resourcesPath only exists in the
// packaged Electron app).
process.env.OPENNOVA_MTOOLS_DIR ??= join(root, 'vendor', 'mtools', `${process.platform}-${process.arch}`);

// No SSH and no Wi-Fi: a shared image must not carry anyone's credentials.
// The Pi is reachable at http://opennova.local over ethernet; everything else
// happens in the browser.
const CONFIG = {
  hostname: 'opennova',
  network: { type: 'ethernet' },
  timezone: 'Europe/Amsterdam',
  connectionPath: 'opennova-app',
  ssh: { enabled: false, username: '', password: '' },
};

const out = join(root, 'release', 'shared');
await mkdir(out, { recursive: true });

const url = await resolveLatestImageUrl(PI_OS_RELEASE.latestUrl);
const xz = join(out, url.split('/').pop());
console.log(`source: ${url}`);

if (await stat(xz).catch(() => null)) {
  console.log('download: already present, reusing');
} else {
  let lastPct = -1;
  await downloadImage(url, xz, (got, total) => {
    const pct = total ? Math.floor((got / total) * 100) : -1;
    if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; process.stdout.write(`\rdownload: ${pct}%`); }
  });
  process.stdout.write('\n');
}

const expected = await fetchExpectedSha256(url);
if (!(await verifySha256(xz, expected))) {
  throw new Error(`checksum mismatch on ${xz} — delete it and re-run`);
}
console.log('checksum: ok');

const bin = join(out, 'opennova.bin');
await rm(bin, { force: true });
await decompressXz(xz, bin);
console.log(`unpacked: ${((await stat(bin)).size / 1e9).toFixed(1)} GB`);

await patchImageBootPartition(bin, CONFIG);
console.log('patched: firstrun.sh + cmdline.txt written into the boot partition');

// Raspberry Pi OS ships no default account, and with SSH disabled firstrun.sh
// creates none either — leaving the OS' own first-boot user wizard as the only
// thing that would. Every official flow (Imager included) writes userconf.txt
// instead, so do the same. `!` is a locked password hash: the account exists so
// nothing waits on a console prompt, but it cannot be logged into, and no
// credential is shipped in a publicly downloadable image.
const userconf = join(out, 'userconf.txt');
await writeFile(userconf, 'opennova:!\n');
const offset = readBootPartitionOffset(bin);
await execFileAsync(join(process.env.OPENNOVA_MTOOLS_DIR, 'mcopy'),
  ['-o', '-i', `${bin}@@${offset}`, userconf, '::/userconf.txt'],
  { env: { ...process.env, MTOOLS_SKIP_CHECK: '1' } });
console.log('patched: userconf.txt (locked account, no login)');

const zip = join(out, 'opennova.zip');
await rm(zip, { force: true });
// -j: store opennova.bin at the zip root, which is where the Chromebook
// Recovery Utility looks for the image.
await execFileAsync('zip', ['-j', '-1', zip, bin], { maxBuffer: 1 << 24 });
console.log(`\ndone: ${zip}  (${((await stat(zip)).size / 1e6).toFixed(0)} MB)`);
