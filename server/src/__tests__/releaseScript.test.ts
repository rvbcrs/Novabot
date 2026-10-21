import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const releaseScriptPath = resolve(repoRoot, 'release.sh');
const coverageNativeBuildScriptPath = resolve(repoRoot, 'scripts/build-coverage-native-image.sh');

// The image is built on GitHub, not on the maintainer's machine: a local
// multi-arch build was slow, a push from home broke off halfway (2026-10-21),
// and the container release.sh left running took over the mowers via mDNS.
const workflowPath = resolve(repoRoot, '.github/workflows/docker.yml');
const betaScriptPath = resolve(repoRoot, 'release-beta.sh');
/** A script without its comment lines: the beta header tells the device to `docker compose pull`. */
const code = (path: string) => readFileSync(path, 'utf8').split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n');

describe('release scripts leave the Docker build to GitHub', () => {
  it('release.sh builds, pushes and starts nothing locally, and waits for the tag\'s workflow', () => {
    const script = code(releaseScriptPath);
    expect(script).not.toMatch(/docker (buildx|run|pull|compose)/);
    expect(script).toContain('git push --tags');
    expect(script).toMatch(/gh run watch .*--exit-status/);
    expect(script).toContain('docker.yml');
  });

  it('release-beta.sh only starts the workflow for pushed code', () => {
    const script = code(betaScriptPath);
    expect(script).not.toMatch(/docker (buildx|run|pull|compose)/);
    expect(script).toMatch(/gh workflow run docker\.yml --ref/);
    expect(script).toMatch(/push .* first/);
  });

  it('the workflow publishes on a release tag or a manual beta run, and nothing else', () => {
    const wf = readFileSync(workflowPath, 'utf8');
    const on = wf.slice(wf.indexOf('\non:'), wf.indexOf('\njobs:'));
    expect(on).toMatch(/tags: \['v\[0-9\]\*'\]/);
    expect(on).toContain('workflow_dispatch');
    expect(on).not.toMatch(/branches:/);
    expect(wf).toContain('uses: ./.github/workflows/server-test.yml');
    expect(wf).toContain('ubuntu-24.04-arm');
    expect(wf).toContain("import('@huggingface/transformers')");
    expect(wf).toContain('push-by-digest=true');
    expect(wf).toContain('rewrite-timestamp=true');
    expect(wf).toContain('type=gha');
    // A tag moves latest, the version and beta; a manual run only beta.
    expect(wf).toMatch(/\$IMAGE:latest .*\$IMAGE:\$\{GITHUB_REF_NAME#v\} .*\$IMAGE:beta/);
    expect(readFileSync(resolve(repoRoot, '.github/workflows/server-test.yml'), 'utf8')).toContain('workflow_call:');
  });

  it('keeps native coverage planner compilation in an explicit artifact build script', () => {
    const script = readFileSync(coverageNativeBuildScriptPath, 'utf8');

    expect(script).toContain('research/coverage-native/Dockerfile.build');
    expect(script).toContain('rvbcrs/opennova-coverage-native');
    expect(script).toContain('--platform linux/amd64,linux/arm64');
    expect(script).toContain('--push');

    const dockerfile = readFileSync(resolve(repoRoot, 'research/coverage-native/Dockerfile.build'), 'utf8');
    expect(dockerfile).toContain('FROM scratch AS artifact');
    expect(dockerfile).toContain('COPY --from=builder /opt/opennova /opt/opennova');

    const dockerignore = readFileSync(resolve(repoRoot, 'research/coverage-native/.dockerignore'), 'utf8');
    expect(dockerignore).toContain('Dockerfile.build');
  });

  it('runs the native artifact build script with cache enabled', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'coverage-native-build-script-'));
    const logPath = join(tmp, 'docker-args.txt');
    const dockerPath = join(tmp, 'docker');

    writeFileSync(dockerPath, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(logPath)}\n`);
    chmodSync(dockerPath, 0o755);

    const result = spawnSync(coverageNativeBuildScriptPath, ['testtag'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${tmp}:${process.env.PATH ?? ''}`,
        BUILDER: 'test-builder',
        COVERAGE_NATIVE_IMAGE: 'example/native',
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const args = readFileSync(logPath, 'utf8');
    expect(args).toContain('buildx\n');
    expect(args).toContain('build\n');
    expect(args).toContain('test-builder\n');
    expect(args).toContain('example/native:testtag\n');
    expect(args).toContain('research/coverage-native\n');
    expect(args).not.toContain('--no-cache\n');
  });
});
