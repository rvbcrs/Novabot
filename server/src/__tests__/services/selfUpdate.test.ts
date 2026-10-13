/**
 * "Update now" in the dashboard: the server cannot replace its own container,
 * so it starts a short-lived docker:cli helper that runs compose pull + up -d
 * for the OpenNova services only. Opt-in through the Docker socket mount.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ownContainerId, selfUpdateStatus, startSelfUpdate, HELPER_IMAGE, _resetSelfUpdate, type DockerCall } from '../../services/selfUpdate.js';

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
