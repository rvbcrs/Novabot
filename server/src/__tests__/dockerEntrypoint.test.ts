import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const entrypointPath = resolve(repoRoot, 'docker-entrypoint.sh');
const dockerfilePath = resolve(repoRoot, 'Dockerfile');

function readTrapLines(): string[] {
  return readFileSync(entrypointPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('trap '));
}

describe('Docker entrypoint', () => {
  it('uses POSIX signal names in shell traps', () => {
    const traps = readTrapLines();

    expect(traps.length).toBeGreaterThan(0);
    for (const trap of traps) {
      expect(trap).not.toMatch(/\bSIG(?:TERM|INT)\b/);
    }
    expect(traps.some((trap) => /\bTERM\b/.test(trap) && /\bINT\b/.test(trap))).toBe(true);
  });

  it('keeps Dockerfile copy sources present in the build context', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const missingSources: string[] = [];

    for (const line of dockerfile.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('COPY ') || trimmed.startsWith('COPY --from=')) continue;

      const parts = trimmed.split(/\s+/);
      const sources = parts.slice(1, -1);
      for (const source of sources) {
        if (!sourceExistsInBuildContext(source)) missingSources.push(source);
      }
    }

    expect(missingSources).toEqual([]);
  });

  it('installs every CLI binary the server shells out to (zip + unzip)', () => {
    // The server execs `zip` (bundle creation) and `unzip` (mower ZIP uploads).
    // unzip was missing from the image from the first beta until 2026-09-04:
    // every mower map upload failed with "unzip: not found" and nobody noticed
    // because the DB was still fed via outline reports. Keep both installed in
    // the RUNTIME stage (the last FROM).
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    const aptLine = runtimeStage
      .split(/\r?\n/)
      .find((line) => /apt-get install/.test(line));

    expect(aptLine, 'runtime stage has an apt-get install line').toBeTruthy();
    for (const bin of ['zip', 'unzip']) {
      expect(aptLine, `runtime apt-get installs ${bin}`).toMatch(new RegExp(`\\b${bin}\\b`));
    }
  });

  it('does not include the native coverage generator in the default image', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8');

    expect(dockerfile).not.toContain('COVERAGE_NATIVE_IMAGE');
    expect(dockerfile).not.toMatch(/FROM\s+\$\{COVERAGE_NATIVE_IMAGE\}\s+AS\s+coverage-native/);
    expect(dockerfile).not.toContain('coverage_grid_plan');
    expect(dockerfile).not.toContain('COVERAGE_NATIVE_BIN');
    expect(dockerfile).not.toContain('/opt/opennova/share/licenses/coverage-native');
    expect(dockerfile).not.toContain('libopencv-');
    expect(dockerfile).not.toContain('libgmp10');
    expect(dockerfile).not.toContain('libmpfr6');
    expect(dockerfile).not.toContain('CGAL_VERSION');
    expect(dockerfile).not.toContain('build-essential');
    expect(dockerfile).not.toContain('cmake -S /coverage-native');
    expect(dockerfile).not.toContain('COPY research/coverage-native/');
  });
});

function sourceExistsInBuildContext(source: string): boolean {
  if (!source.includes('*')) return existsSync(resolve(repoRoot, source));

  const slash = source.lastIndexOf('/');
  const dir = slash === -1 ? '.' : source.slice(0, slash);
  const pattern = slash === -1 ? source : source.slice(slash + 1);
  const [prefix, suffix = ''] = pattern.split('*');
  const absoluteDir = resolve(repoRoot, dir);

  if (!existsSync(absoluteDir)) return false;
  return readdirSync(absoluteDir).some((entry) => entry.startsWith(prefix) && entry.endsWith(suffix));
}
