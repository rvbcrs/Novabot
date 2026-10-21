/**
 * The release notes of a server version that is not installed yet, shown from
 * the dashboard's update banner before the user updates. They come from the
 * release-notes.json in that version's git tag on GitHub.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { upcomingReleaseNotes, _resetUpcomingNotesCache } from '../../services/upcomingReleaseNotes.js';

const LATEST = '2026.1020.1052';
const TAG_URL = `https://raw.githubusercontent.com/rvbcrs/Novabot/v${LATEST}/server/release-notes.json`;

const rel = (version: string) => ({ version, date: version.slice(0, 4), sections: { dashboard: [`Change in ${version}`] } });

// The file in the tag, newest first: two releases past the running one, then
// the running one and an older one.
const FILE = { releases: [rel(LATEST), rel('2026.1019.2356'), rel('2026.1013.2326'), rel('2026.1011.2012')] };

function fakeFetch(answers: Record<string, unknown>) {
  const fetched: string[] = [];
  const fetchJson = async (url: string) => {
    fetched.push(url);
    if (!(url in answers)) throw new Error(`unexpected fetch of ${url}`);
    return answers[url];
  };
  return { fetchJson, fetched };
}

beforeEach(() => _resetUpcomingNotesCache());

describe('upcomingReleaseNotes', () => {
  it('reads the notes from the tag of the newer version and keeps only the releases past the running one', async () => {
    const { fetchJson, fetched } = fakeFetch({ [TAG_URL]: FILE });
    expect(await upcomingReleaseNotes(LATEST, fetchJson, '2026.1013.2326')).toEqual([rel(LATEST), rel('2026.1019.2356')]);
    expect(fetched).toEqual([TAG_URL]);
  });

  it('asks GitHub once per version: a tag never changes', async () => {
    const { fetchJson, fetched } = fakeFetch({ [TAG_URL]: FILE });
    await upcomingReleaseNotes(LATEST, fetchJson, '2026.1013.2326');
    expect(await upcomingReleaseNotes(LATEST, fetchJson, '2026.1013.2326')).toHaveLength(2);
    expect(fetched).toHaveLength(1);
  });

  it('asks again once Docker Hub has a newer version still', async () => {
    const NEXT = '2026.1021.0900';
    const nextUrl = TAG_URL.replace(LATEST, NEXT);
    const { fetchJson, fetched } = fakeFetch({ [TAG_URL]: FILE, [nextUrl]: { releases: [rel(NEXT), ...FILE.releases] } });
    await upcomingReleaseNotes(LATEST, fetchJson, '2026.1013.2326');
    expect((await upcomingReleaseNotes(NEXT, fetchJson, '2026.1013.2326')).map(r => r.version))
      .toEqual([NEXT, LATEST, '2026.1019.2356']);
    expect(fetched).toEqual([TAG_URL, nextUrl]);
  });

  it('does not cache a failed request, so the next look tries again', async () => {
    let up = false;
    const fetchJson = async () => {
      if (!up) throw new Error('HTTP 404');
      return FILE;
    };
    await expect(upcomingReleaseNotes(LATEST, fetchJson, '2026.1013.2326')).rejects.toThrow('HTTP 404');
    up = true;
    expect(await upcomingReleaseNotes(LATEST, fetchJson, '2026.1013.2326')).toHaveLength(2);
  });

  it('builds no URL from anything but a version tag', async () => {
    const { fetchJson, fetched } = fakeFetch({});
    expect(await upcomingReleaseNotes('beta@4d7efc6e0d33', fetchJson, '2026.1013.2326')).toEqual([]);
    expect(await upcomingReleaseNotes('../../evil', fetchJson, '2026.1013.2326')).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it('drops what is not a release entry and answers [] for a file without releases', async () => {
    const { fetchJson } = fakeFetch({ [TAG_URL]: { releases: [rel(LATEST), null, { date: 'x' }, { version: 7 }] } });
    expect(await upcomingReleaseNotes(LATEST, fetchJson, '2026.1013.2326')).toEqual([rel(LATEST)]);

    _resetUpcomingNotesCache();
    const empty = fakeFetch({ [TAG_URL]: { version: LATEST } });
    expect(await upcomingReleaseNotes(LATEST, empty.fetchJson, '2026.1013.2326')).toEqual([]);
  });
});
