/**
 * Finding 5 (whole-branch review): de include_edge-patch in
 * research/build_custom_firmware.sh mag NOOIT op alleen een patroon-telling
 * patchen. Een toekomstige firmware-revisie kan het patroon toevallig 1x op
 * een andere of niet-uitgelijnde plek bevatten; blind patchen levert dan een
 * maaier op die fysiek geflasht moet worden. Deze tests extraheren het echte
 * Python-patchblok uit het buildscript en draaien het tegen synthetische
 * binaries: de offset-, uitlijnings- en context-checks moeten de build hard
 * laten falen. Wie de checks uit het script sloopt, maakt deze tests rood.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const buildScriptPath = resolve(repoRoot, 'research/build_custom_firmware.sh');

const PAT = Buffer.from('e3bb0239', 'hex');        // strb w3,[sp,#0xae]
const REPL = Buffer.from('ffbb0239', 'hex');       // strb wzr,[sp,#0xae]
const EXPECTED_OFFSET = 0x921a8;
const MOV_W3_1 = Buffer.from('23008052', 'hex');   // mov w3,#1 (LE bytes van 0x52800023)
const NEXT_STORE = Buffer.from('e3c30239', 'hex'); // strb w3,[sp,#0xb0] (LE bytes van 0x3902c3e3)

/** Extraheer het Python-heredoc van de include_edge-patch uit het buildscript. */
function extractPatchBlock(): string {
  const script = readFileSync(buildScriptPath, 'utf8');
  const match = script.match(/python3 - "\$RD" <<'PY'\n([\s\S]*?)\nPY\n/);
  expect(match, 'include_edge patchblok (heredoc) niet gevonden in build_custom_firmware.sh').toBeTruthy();
  return match![1];
}

/** Synthetische robot_decision: nullen met de geverifieerde woorden op de
 *  geverifieerde offsets. */
function syntheticBinary(): Buffer {
  const buf = Buffer.alloc(0x94000, 0);
  MOV_W3_1.copy(buf, 0x92188);
  PAT.copy(buf, EXPECTED_OFFSET);
  NEXT_STORE.copy(buf, EXPECTED_OFFSET + 4);
  return buf;
}

function runPatch(binary: Buffer): { status: number | null; stderr: string; result: Buffer } {
  const tmp = mkdtempSync(join(tmpdir(), 'edge-patch-guard-'));
  const py = join(tmp, 'patch.py');
  const bin = join(tmp, 'robot_decision');
  writeFileSync(py, extractPatchBlock());
  writeFileSync(bin, binary);
  const r = spawnSync('python3', [py, bin], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr ?? '', result: readFileSync(bin) };
}

describe('include_edge firmware-patch offsetguard (finding 5)', () => {
  it('patcht een binary met het patroon op exact 0x921a8 en intacte context', () => {
    const { status, result } = runPatch(syntheticBinary());
    expect(status).toBe(0);
    expect(result.indexOf(REPL)).toBe(EXPECTED_OFFSET);
    expect(result.indexOf(PAT)).toBe(-1);
  });

  it('breekt af wanneer het patroon 1x op een ANDERE offset staat (brick-scenario)', () => {
    const buf = syntheticBinary();
    // verplaats het patroon: echte plek wissen, elders (niet-uitgelijnd) planten
    buf.fill(0, EXPECTED_OFFSET, EXPECTED_OFFSET + 4);
    PAT.copy(buf, 0x1001);
    const { status, stderr, result } = runPatch(buf);
    expect(status).not.toBe(0);
    expect(stderr).toContain('offset-check');
    // en er is NIETS gepatcht
    expect(result.indexOf(REPL)).toBe(-1);
  });

  it('breekt af wanneer de instructie ná de patch-plek afwijkt (context-check)', () => {
    const buf = syntheticBinary();
    buf.fill(0xde, EXPECTED_OFFSET + 4, EXPECTED_OFFSET + 8);
    const { status, stderr, result } = runPatch(buf);
    expect(status).not.toBe(0);
    expect(stderr).toContain('context-check');
    expect(result.indexOf(REPL)).toBe(-1);
  });

  it('breekt af wanneer het mov w3,#1-anker afwijkt (context-check)', () => {
    const buf = syntheticBinary();
    buf.fill(0, 0x92188, 0x9218c);
    const { status, stderr, result } = runPatch(buf);
    expect(status).not.toBe(0);
    expect(stderr).toContain('context-check');
    expect(result.indexOf(REPL)).toBe(-1);
  });

  it('breekt af wanneer het patroon vaker dan 1x voorkomt', () => {
    const buf = syntheticBinary();
    PAT.copy(buf, 0x2000);
    const { status, result } = runPatch(buf);
    expect(status).not.toBe(0);
    expect(result.indexOf(REPL)).toBe(-1);
  });

  it('pint de geverifieerde constanten in het script (0x921a8, mov-anker, volgende store)', () => {
    const block = extractPatchBlock();
    expect(block).toContain('EXPECTED_OFFSET = 0x921A8');
    expect(block).toContain('MOV_W3_1_WORD = 0x52800023');
    expect(block).toContain('NEXT_STORE_WORD = 0x3902C3E3');
    expect(block).toContain('off % 4');
  });
});
