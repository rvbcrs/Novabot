/**
 * "Update now" in the dashboard: the server cannot replace its own container,
 * so it starts a short-lived docker:cli helper that runs compose pull + up -d
 * for the OpenNova services only. Opt-in through the Docker socket mount.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ownContainerId, selfUpdateStatus, startSelfUpdate, runningImage, HELPER_IMAGE, _resetSelfUpdate, type DockerCall } from '../../services/selfUpdate.js';

beforeEach(() => _resetSelfUpdate());

const ID = 'a'.repeat(64);
const MOUNTINFO = `1452 1431 0:180 / / rw,relatime - overlay overlay rw
1470 1452 254:1 /docker/containers/${ID}/hostname /etc/hostname rw,relatime - ext4 /dev/vda1 rw`;
const LABELS = {
  'com.docker.compose.project': 'opennova',
  'com.docker.compose.service': 'opennova',
  'com.docker.compose.project.working_dir': '/volume1/docker/opennova',
  'com.docker.compose.project.config_files': '/volume1/docker/opennova/docker-compose.yml',
};

function fakeDocker(overrides: { labels?: Record<string, string>; containers?: unknown[] } = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const docker: DockerCall = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === `/containers/${ID}/json`) return { Id: ID, Config: { Labels: overrides.labels ?? LABELS, Image: 'rvbcrs/opennova:latest' } };
    if (path.startsWith('/containers/json')) {
      return overrides.containers ?? [
        { Image: 'rvbcrs/opennova:latest', Labels: { 'com.docker.compose.service': 'opennova' } },
        { Image: 'rvbcrs/opennova:latest', Labels: { 'com.docker.compose.service': 'opennova-mdns' } },
        { Image: 'homeassistant/home-assistant:stable', Labels: { 'com.docker.compose.service': 'homeassistant' } },
      ];
    }
    if (path.startsWith('/containers/create')) return { Id: 'helper1' };
    return {};
  };
  return { docker, calls };
}
const deps = (docker: DockerCall, socket = true) => ({ docker, socketExists: () => socket, mountinfo: () => MOUNTINFO, hostname: () => 'nas' });

describe('ownContainerId', () => {
  it('reads the container id from the hostname bind mount, also with network_mode host', () => {
    expect(ownContainerId(MOUNTINFO, 'nas')).toBe(ID);
  });
  it('falls back to a short-id hostname, else none', () => {
    expect(ownContainerId('', '0123456789ab')).toBe('0123456789ab');
    expect(ownContainerId('', 'nas')).toBeNull();
  });
});

describe('selfUpdateStatus', () => {
  it('needs the Docker socket', async () => {
    expect(await selfUpdateStatus(deps(fakeDocker().docker, false))).toEqual({ available: false, reason: 'no_socket' });
  });
  it('needs a compose project', async () => {
    const { docker } = fakeDocker({ labels: {} });
    expect(await selfUpdateStatus(deps(docker))).toEqual({ available: false, reason: 'not_compose' });
  });
  it('is available for a compose install with the socket', async () => {
    expect(await selfUpdateStatus(deps(fakeDocker().docker))).toEqual({ available: true });
  });
});

describe('startSelfUpdate', () => {
  it('pulls and recreates only the OpenNova services through a docker:cli helper', async () => {
    const { docker, calls } = fakeDocker();
    expect(await startSelfUpdate(deps(docker))).toEqual({ ok: true });
    expect(calls.some(c => c.method === 'POST' && c.path === `/images/create?fromImage=${HELPER_IMAGE.name}&tag=${HELPER_IMAGE.tag}`)).toBe(true);
    const create = calls.find(c => c.path.startsWith('/containers/create'))!.body as {
      Image: string; Cmd: string[]; Env: string[]; WorkingDir: string; HostConfig: { AutoRemove: boolean; Binds: string[] };
    };
    expect(create.Image).toBe(`${HELPER_IMAGE.name}:${HELPER_IMAGE.tag}`);
    expect(create.Cmd.join(' ')).toContain('pull opennova opennova-mdns');
    expect(create.Cmd.join(' ')).toContain('up -d --no-deps --force-recreate opennova opennova-mdns');
    expect(create.Cmd.join(' ')).not.toContain('homeassistant');
    expect(create.Env).toEqual(expect.arrayContaining([
      'COMPOSE_PROJECT_NAME=opennova', 'COMPOSE_FILE=/volume1/docker/opennova/docker-compose.yml',
    ]));
    expect(create.WorkingDir).toBe('/volume1/docker/opennova');
    expect(create.HostConfig.AutoRemove).toBe(true);
    expect(create.HostConfig.Binds).toEqual(expect.arrayContaining([
      '/var/run/docker.sock:/var/run/docker.sock', '/volume1/docker/opennova:/volume1/docker/opennova',
    ]));
    expect(calls.some(c => c.method === 'POST' && c.path === '/containers/helper1/start')).toBe(true);
    // A second click while this server is being replaced starts nothing.
    expect((await startSelfUpdate(deps(docker))).ok).toBe(false);
  });

  it('refuses a service name that could reach the shell', async () => {
    const { docker, calls } = fakeDocker({ containers: [{ Image: 'rvbcrs/opennova:latest', Labels: { 'com.docker.compose.service': 'x;rm -rf /' } }] });
    expect((await startSelfUpdate(deps(docker))).ok).toBe(false);
    expect(calls.some(c => c.path.startsWith('/containers/create'))).toBe(false);
  });

  it('refuses without the socket', async () => {
    expect((await startSelfUpdate(deps(fakeDocker().docker, false))).ok).toBe(false);
  });
});

/**
 * Which image this server runs: the tag decides the update channel (:beta
 * moves under a fixed version number), the digest says which build it is.
 */
describe('runningImage', () => {
  const IMAGE_ID = `sha256:${'b'.repeat(64)}`;
  const RUNNING = `sha256:${'c'.repeat(64)}`; // manifest-list digest of the image this container was created from
  const MOVED = `sha256:${'d'.repeat(64)}`; // what the name points at after a later `docker compose pull`

  /** A container as the Docker API reports it: Config.Image is the name from
   *  the compose file, Image the id of the image it was created from. */
  function imageDocker(o: { configImage?: string; repoDigests?: unknown; imageInspect?: 'fails' } = {}) {
    const calls: string[] = [];
    const docker: DockerCall = async (method, path) => {
      calls.push(`${method} ${path}`);
      if (path === `/containers/${ID}/json`) {
        return { Id: ID, Image: IMAGE_ID, Config: { Image: o.configImage ?? 'rvbcrs/opennova:beta', Labels: LABELS } };
      }
      if (path === `/images/${IMAGE_ID}/json`) {
        if (o.imageInspect === 'fails') throw new Error(`docker GET ${path}: 500`);
        return { Id: IMAGE_ID, RepoTags: [], RepoDigests: 'repoDigests' in o ? o.repoDigests : [`rvbcrs/opennova@${RUNNING}`] };
      }
      // The same pull moved the tag to a newer image; this container still runs the old one.
      if (path === '/images/rvbcrs/opennova:beta/json') {
        return { Id: `sha256:${'e'.repeat(64)}`, RepoTags: ['rvbcrs/opennova:beta'], RepoDigests: [`rvbcrs/opennova@${MOVED}`] };
      }
      throw new Error(`unexpected docker call ${method} ${path}`);
    };
    return { docker, calls };
  }

  it('reports the digest of the image the container runs, not of the one its tag points at by now', async () => {
    const { docker } = imageDocker();
    expect(await runningImage(deps(docker))).toEqual({ tag: 'beta', digest: RUNNING });
  });

  it.each([
    ['rvbcrs/opennova:beta', 'beta'],
    ['rvbcrs/opennova:2026.1013.2326', '2026.1013.2326'],
    ['rvbcrs/opennova:latest', 'latest'],
    ['rvbcrs/opennova', 'latest'],
    ['docker.io/rvbcrs/opennova:beta', 'beta'],
    ['localhost:5000/rvbcrs/opennova', 'latest'], // a registry port is not a tag
    ['localhost:5000/rvbcrs/opennova:beta', 'beta'],
    [`rvbcrs/opennova:beta@sha256:${'a'.repeat(64)}`, 'beta'],
  ])('reads the tag out of %s', async (configImage, tag) => {
    const { docker } = imageDocker({ configImage });
    expect((await runningImage(deps(docker)))?.tag).toBe(tag);
  });

  it('takes the first RepoDigests entry', async () => {
    const { docker } = imageDocker({ repoDigests: [`rvbcrs/opennova@${RUNNING}`, `ghcr.io/example/opennova@sha256:${'f'.repeat(64)}`] });
    expect((await runningImage(deps(docker)))?.digest).toBe(RUNNING);
  });

  it.each([
    ['an empty list', []],
    ['null, as for an image that never came from a registry', null],
    ['an entry that is not a sha256 reference', ['not-a-digest']],
  ])('has the tag but no digest when RepoDigests is %s', async (_what, repoDigests) => {
    const { docker } = imageDocker({ repoDigests });
    expect(await runningImage(deps(docker))).toEqual({ tag: 'beta', digest: null });
  });

  it('keeps the tag when the image itself cannot be inspected', async () => {
    const { docker } = imageDocker({ imageInspect: 'fails' });
    expect(await runningImage(deps(docker))).toEqual({ tag: 'beta', digest: null });
  });

  it('is null without the Docker socket, and does not ask Docker', async () => {
    const { docker, calls } = imageDocker();
    expect(await runningImage(deps(docker, false))).toBeNull();
    expect(calls).toEqual([]);
  });

  it('is null when it cannot tell which container it is', async () => {
    const { docker, calls } = imageDocker();
    expect(await runningImage({ docker, socketExists: () => true, mountinfo: () => '', hostname: () => 'nas' })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('is null when Docker fails on the container itself', async () => {
    const docker: DockerCall = async () => { throw new Error('connect ECONNREFUSED /var/run/docker.sock'); };
    expect(await runningImage(deps(docker))).toBeNull();
  });
});
