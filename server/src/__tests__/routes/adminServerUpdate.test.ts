/**
 * The server update check behind the dashboard's update banner.
 *
 * A server on the :beta image carries the same version number as the release it
 * was cut from, so comparing version tags never finds a newer beta. It compares
 * the digest of the image it runs with the digest Docker Hub holds for :beta.
 * Every other install keeps comparing version tags.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkServerUpdate, _resetServerUpdateCache, type ServerUpdateDeps } from '../../routes/adminStatus.js';
import { SERVER_VERSION } from '../../services/serverVersion.js';

const HUB_BETA = 'https://hub.docker.com/v2/repositories/rvbcrs/opennova/tags/beta';
const HUB_TAGS = 'https://hub.docker.com/v2/repositories/rvbcrs/opennova/tags?page_size=25&ordering=last_updated';

// The :beta tag as Docker Hub answers for it (trimmed; digests and date are real).
const HUB_DIGEST = 'sha256:4d7efc6e0d331a0f1dafcc798a4d324bd0ca178a1538c1dfb9d6f4c0e75f1668';
const BUILT_AT = '2026-10-15T22:37:08.924735Z';
const OLDER_DIGEST = `sha256:${'1'.repeat(64)}`;
const hubBeta = (over: Record<string, unknown> = {}) => ({
  name: 'beta',
  digest: HUB_DIGEST,
  last_updated: BUILT_AT,
  images: [
    { architecture: 'amd64', os: 'linux', status: 'active', digest: 'sha256:f68afcb0eea8aa15fea28e48677e423109c654c71f441878aa1b272b23483fda' },
    { architecture: 'arm64', os: 'linux', status: 'active', digest: 'sha256:54e325cc30d78500dd202466437206db84555355d0b9af584c93e1dc30c10b17' },
  ],
  ...over,
});

// The tag list: rolling aliases next to the timestamp version tags release.sh writes.
const NEWER = '2999.1231.2359';
const NEWER_PUSHED = '2999-12-31T23:57:00.000000Z';
const rolling = [
  { name: 'latest', last_updated: '2999-12-31T23:59:00.000000Z' },
  { name: 'beta', last_updated: '2999-12-31T23:58:00.000000Z' },
];
const OLD = { name: '2000.0101.0101', last_updated: '2000-01-01T01:01:00.000000Z' };

type Image = Awaited<ReturnType<ServerUpdateDeps['runningImage']>>;

/** Docker Hub answers from `hub` by URL; any other URL is a failure of the code under test. */
function fakeDeps(image: Image, hub: Record<string, unknown>) {
  const fetched: string[] = [];
  let lookups = 0;
  const deps: ServerUpdateDeps = {
    runningImage: async () => { lookups++; return image; },
    fetchJson: async (url) => {
      fetched.push(url);
      if (!(url in hub)) throw new Error(`unexpected fetch of ${url}`);
      return hub[url];
    },
  };
  return { deps, fetched, lookups: () => lookups };
}

beforeEach(() => _resetServerUpdateCache());
afterEach(() => vi.useRealTimers());

describe('checkServerUpdate on the beta channel', () => {
  it('offers an update when Docker Hub holds another :beta digest than the running image', async () => {
    const { deps, fetched } = fakeDeps({ tag: 'beta', digest: OLDER_DIGEST }, { [HUB_BETA]: hubBeta() });
    expect(await checkServerUpdate(deps)).toEqual({
      current: SERVER_VERSION,
      latest: 'beta@4d7efc6e0d33',
      updateAvailable: true,
      lastUpdatedAt: BUILT_AT,
      latestBuiltAt: BUILT_AT,
      channel: 'beta',
    });
    // Only the :beta tag is asked for, never the tag list the release path reads.
    expect(fetched).toEqual([HUB_BETA]);
  });

  it('offers nothing once the running image is the one Docker Hub holds for :beta', async () => {
    const { deps } = fakeDeps({ tag: 'beta', digest: HUB_DIGEST }, { [HUB_BETA]: hubBeta() });
    expect(await checkServerUpdate(deps)).toEqual({
      current: SERVER_VERSION,
      latest: 'beta@4d7efc6e0d33',
      updateAvailable: false,
      lastUpdatedAt: BUILT_AT,
      latestBuiltAt: BUILT_AT,
      channel: 'beta',
    });
  });

  it('makes no claim while the running digest is unknown, as for a locally built image', async () => {
    const { deps } = fakeDeps({ tag: 'beta', digest: null }, { [HUB_BETA]: hubBeta() });
    expect(await checkServerUpdate(deps)).toEqual({
      current: SERVER_VERSION,
      latest: 'beta@4d7efc6e0d33',
      updateAvailable: false,
      lastUpdatedAt: BUILT_AT,
      latestBuiltAt: BUILT_AT,
      channel: 'beta',
      reason: 'digest_unknown',
    });
  });

  it('makes no claim when Docker Hub answers without a digest', async () => {
    const { deps } = fakeDeps({ tag: 'beta', digest: OLDER_DIGEST }, { [HUB_BETA]: hubBeta({ digest: undefined }) });
    expect(await checkServerUpdate(deps)).toEqual({
      current: SERVER_VERSION,
      latest: null,
      updateAvailable: false,
      lastUpdatedAt: null,
      latestBuiltAt: null,
      channel: 'beta',
      reason: 'hub_digest_missing',
    });
  });
});

describe('checkServerUpdate off the beta channel', () => {
  it.each([
    ['a pinned release tag', { tag: '2026.1013.2326', digest: OLDER_DIGEST }],
    ['the rolling latest tag', { tag: 'latest', digest: OLDER_DIGEST }],
    ['a Docker socket that is not there', null],
  ])('keeps comparing version tags for %s, whatever rolling tags sit in the list', async (_what, image) => {
    const { deps, fetched } = fakeDeps(image, { [HUB_TAGS]: { results: [...rolling, { name: NEWER, last_updated: NEWER_PUSHED }, OLD] } });
    expect(await checkServerUpdate(deps)).toEqual({
      current: SERVER_VERSION,
      latest: NEWER,
      updateAvailable: true,
      lastUpdatedAt: NEWER_PUSHED,
      channel: 'release',
    });
    expect(fetched).toEqual([HUB_TAGS]);
  });

  it('offers nothing when no version tag is newer than the running one', async () => {
    const { deps } = fakeDeps({ tag: 'latest', digest: OLDER_DIGEST }, { [HUB_TAGS]: { results: [...rolling, OLD] } });
    expect(await checkServerUpdate(deps)).toEqual({
      current: SERVER_VERSION,
      latest: OLD.name,
      updateAvailable: false,
      lastUpdatedAt: OLD.last_updated,
      channel: 'release',
    });
  });
});

describe('checkServerUpdate cache', () => {
  it('answers from a five minute cache instead of asking Docker Hub and Docker again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
    const { deps, fetched, lookups } = fakeDeps({ tag: 'beta', digest: OLDER_DIGEST }, { [HUB_BETA]: hubBeta() });

    const first = await checkServerUpdate(deps);
    vi.setSystemTime(new Date('2026-10-18T12:04:59Z'));
    expect(await checkServerUpdate(deps)).toEqual(first);
    expect(fetched).toHaveLength(1);
    expect(lookups()).toBe(1);

    vi.setSystemTime(new Date('2026-10-18T12:05:01Z'));
    await checkServerUpdate(deps);
    expect(fetched).toHaveLength(2);
    expect(lookups()).toBe(2);
  });

  it('does not cache a failed Docker Hub request, so the next poll tries again', async () => {
    let hubUp = false;
    const deps: ServerUpdateDeps = {
      runningImage: async () => ({ tag: 'beta', digest: OLDER_DIGEST }),
      fetchJson: async () => {
        if (!hubUp) throw new Error('HTTP 429');
        return hubBeta();
      },
    };
    await expect(checkServerUpdate(deps)).rejects.toThrow('HTTP 429');
    hubUp = true;
    expect((await checkServerUpdate(deps)).updateAvailable).toBe(true);
  });
});
