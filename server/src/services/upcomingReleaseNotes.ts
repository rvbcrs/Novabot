/**
 * The release notes of a server version that is not installed yet, for the
 * dashboard's update banner: what changes before the user presses update.
 *
 * Every release tag carries server/release-notes.json (release.sh writes it in
 * the release commit, the last 10 releases newest first), and release.sh pushes
 * the tag to GitHub before it pushes the image to Docker Hub. So once Docker Hub
 * shows a version, the notes for it are in the public repo at that tag. A tag
 * never changes, so the answer is kept per version.
 */
import { SERVER_VERSION } from './serverVersion.js';

export interface ReleaseNotesEntry {
  version: string;
  date: string;
  sections: Record<string, string[]>;
}

const notesUrl = (version: string) =>
  `https://raw.githubusercontent.com/rvbcrs/Novabot/v${version}/server/release-notes.json`;

let _cache: { version: string; releases: ReleaseNotesEntry[] } | null = null;

/** Tests only. */
export function _resetUpcomingNotesCache(): void {
  _cache = null;
}

/**
 * The releases after `current` up to `latest`, newest first. `latest` is the
 * newest version tag on Docker Hub; anything else (a :beta label) has no notes
 * of its own and answers []. A failed fetch throws and is not kept.
 */
export async function upcomingReleaseNotes(
  latest: string,
  fetchJson: (url: string) => Promise<unknown>,
  current: string = SERVER_VERSION,
): Promise<ReleaseNotesEntry[]> {
  // The same guard as the Docker Hub tag filter; it also keeps the URL ours.
  if (!/^\d{4}\.\d{3,4}\.\d{3,4}$/.test(latest)) return [];
  if (_cache?.version !== latest) {
    const data = await fetchJson(notesUrl(latest)) as { releases?: unknown };
    const releases = (Array.isArray(data?.releases) ? data.releases : [])
      .filter((r): r is ReleaseNotesEntry => !!r && typeof r === 'object' && typeof (r as ReleaseNotesEntry).version === 'string');
    _cache = { version: latest, releases };
  }
  const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return _cache.releases.filter(r => cmp.compare(r.version, current) > 0);
}
