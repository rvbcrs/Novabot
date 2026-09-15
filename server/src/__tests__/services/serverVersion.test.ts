/**
 * The version must not come from package.json again.
 *
 * package.json is what the Dockerfile copies right before `npm ci`, in both
 * the build and the deps stage. While release.sh wrote the version there,
 * every release threw away the dependency cache for both platforms: a release
 * that takes four minutes took twenty-five, with npm ci rebuilding under arm64
 * emulation. Nothing in the code prevents someone from reaching for
 * package.json again, so the release pipeline is asserted here instead.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { SERVER_VERSION } from '../../services/serverVersion.js';

const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const read = (p: string) => readFileSync(repo(p), 'utf8');

describe('server version', () => {
  it('is the newest release in release-notes.json', () => {
    const notes = JSON.parse(read('server/release-notes.json'));
    expect(SERVER_VERSION).toBe(notes.releases[0].version);
    expect(SERVER_VERSION).toMatch(/^\d{4}\.\d{4}\.\d{4}$/);
  });

  it('is not read from package.json anywhere in the server', () => {
    // Four places used to parse it themselves, each with its own path walk.
    const offenders = ['src/index.ts', 'src/routes/dashboard.ts',
                       'src/routes/adminStatus.ts', 'src/routes/setup.ts']
      .filter(f => read(`server/${f}`).includes('package.json'));
    expect(offenders).toEqual([]);
  });

  it('is not written into package.json by the release script', () => {
    const release = read('release.sh');
    expect(release).not.toMatch(/sed[^\n]*version[^\n]*server\/package\.json/);
    expect(release).not.toMatch(/git add[^\n]*server\/package\.json/);
  });
});
