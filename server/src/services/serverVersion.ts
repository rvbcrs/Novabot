/**
 * Which release is running.
 *
 * This used to come from package.json, with release.sh writing the new version
 * into it. But package.json is the file the Dockerfile copies right before
 * `npm ci`, in both the build and the deps stage, so every release invalidated
 * the dependency layer for both platforms at once. Measured on 2026-09-15: the
 * betas before a release rebuilt in four minutes with npm ci cached six times
 * out of six, the release and the beta after it missed and `npm ci` alone took
 * 863 s under arm64 emulation.
 *
 * release-notes.json carries the same version, is written by the same release
 * step, and is copied in a late layer where it invalidates nothing. package.json
 * remains the fallback so a plain dev checkout still reports something sane.
 */
import { readFileSync } from 'fs';

/** Resolved from this module, so src/ (tsx), dist/ and /app/server all work. */
function read(file: string): string | null {
  for (const rel of [`../../${file}`, `../../../${file}`]) {
    try {
      const raw = readFileSync(new URL(rel, import.meta.url), 'utf8');
      const parsed = JSON.parse(raw) as { version?: string; releases?: Array<{ version?: string }> };
      const version = parsed.releases?.[0]?.version ?? parsed.version;
      if (typeof version === 'string' && version) return version;
    } catch { /* volgende kandidaat */ }
  }
  return null;
}

/** The running release, or '?' when neither file is readable. */
export const SERVER_VERSION = read('release-notes.json') ?? read('package.json') ?? '?';
