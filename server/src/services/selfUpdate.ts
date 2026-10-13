/**
 * "Update now" from the dashboard.
 *
 * A container cannot replace itself: the process doing the update would stop
 * itself halfway. So the server starts a short-lived helper container
 * (docker:cli) that runs `docker compose pull` + `up -d` for the OpenNova
 * services of its own compose project, with the same compose file, and
 * removes itself afterwards. Compose recreates the container with the new
 * image and exactly the old settings.
 *
 * Opt-in: it needs /var/run/docker.sock mounted into this container, which
 * gives control over Docker on the host. Without the mount, or for an install
 * that is not a compose project, the dashboard keeps its terminal instructions.
 * Only services running an rvbcrs/opennova image are touched, never other
 * services that share the project.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const DOCKER_SOCKET = '/var/run/docker.sock';
/** Pinned: a moving tag could change what runs with the Docker socket. */
export const HELPER_IMAGE = { name: 'docker', tag: '27.5.1-cli' };
const OPENNOVA_IMAGE = /^(docker\.io\/)?rvbcrs\/opennova(:|@|$)/;
// Names that end up in the helper's shell command: compose's own character set.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

export type DockerCall = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** Docker Engine API over the unix socket, JSON in and out. */
export const dockerRequest: DockerCall = (method, apiPath, body) => new Promise((resolve, reject) => {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const req = http.request({
    socketPath: DOCKER_SOCKET, path: apiPath, method,
    headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
  }, res => {
    const chunks: Buffer[] = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if ((res.statusCode ?? 500) >= 400) { reject(new Error(`docker ${method} ${apiPath}: ${res.statusCode} ${text.slice(0, 200)}`)); return; }
      // A pull streams one JSON object per line; an error can sit in any of them.
      const lines = text.split('\n').filter(Boolean);
      const failed = lines.map(l => { try { return JSON.parse(l) as { error?: string }; } catch { return null; } }).find(o => o?.error);
      if (failed) { reject(new Error(failed.error)); return; }
      try { resolve(lines.length === 1 ? JSON.parse(lines[0]) : lines.length ? lines.map(l => JSON.parse(l)) : {}); } catch { resolve(text); }
    });
  });
  req.on('error', reject);
  req.setTimeout(300_000, () => req.destroy(new Error('docker request timed out')));
  if (payload) req.write(payload);
  req.end();
});

export interface SelfUpdateDeps {
  docker: DockerCall;
  socketExists: () => boolean;
  mountinfo: () => string;
  hostname: () => string;
}

const realDeps: SelfUpdateDeps = {
  docker: dockerRequest,
  socketExists: () => fs.existsSync(DOCKER_SOCKET),
  mountinfo: () => { try { return fs.readFileSync('/proc/self/mountinfo', 'utf8'); } catch { return ''; } },
  hostname: () => os.hostname(),
};

/** This container's id: the /etc/hostname bind mount names it, also under
 *  network_mode host where the hostname is the machine's. */
export function ownContainerId(mountinfo: string, hostname: string): string | null {
  const m = mountinfo.match(/\/containers\/([0-9a-f]{64})\//);
  if (m) return m[1];
  return /^[0-9a-f]{12}$/.test(hostname) ? hostname : null;
}

interface Plan { project: string; workdir: string; configFiles: string[]; services: string[] }

async function planUpdate(d: SelfUpdateDeps): Promise<{ plan?: Plan; reason?: string }> {
  if (!d.socketExists()) return { reason: 'no_socket' };
  const id = ownContainerId(d.mountinfo(), d.hostname());
  if (!id) return { reason: 'unknown_container' };
  const self = await d.docker('GET', `/containers/${id}/json`) as { Config?: { Labels?: Record<string, string> } };
  const labels = self.Config?.Labels ?? {};
  const project = labels['com.docker.compose.project'];
  const workdir = labels['com.docker.compose.project.working_dir'];
  const configFiles = (labels['com.docker.compose.project.config_files'] ?? '').split(',').map(f => f.trim()).filter(Boolean);
  if (!project || !workdir || !configFiles.length) return { reason: 'not_compose' };
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }));
  const containers = await d.docker('GET', `/containers/json?all=1&filters=${filters}`) as Array<{ Image?: string; Labels?: Record<string, string> }>;
  const services = [...new Set(containers
    .filter(c => OPENNOVA_IMAGE.test(c.Image ?? ''))
    .map(c => c.Labels?.['com.docker.compose.service'] ?? ''))].filter(Boolean).sort();
  if (!services.length) return { reason: 'not_compose' };
  return { plan: { project, workdir, configFiles, services } };
}

export async function selfUpdateStatus(d: SelfUpdateDeps = realDeps): Promise<{ available: boolean; reason?: string }> {
  try {
    const { plan, reason } = await planUpdate(d);
    return plan ? { available: true } : { available: false, reason };
  } catch {
    return { available: false, reason: 'docker_error' };
  }
}

let running = false;

/** Start the helper that pulls the new image and recreates the OpenNova
 *  services. Returns as soon as the helper runs; this server stops shortly
 *  after, when compose replaces it. */
export async function startSelfUpdate(d: SelfUpdateDeps = realDeps): Promise<{ ok: boolean; error?: string }> {
  if (running) return { ok: false, error: 'update already running' };
  running = true;
  // Stays set after a start: this server is replaced within seconds, and a
  // second click must not start a second helper racing the first.
  const fail = (error?: string) => { running = false; return { ok: false, error }; };
  try {
    const { plan, reason } = await planUpdate(d);
    if (!plan) return fail(reason);
    if (![plan.project, ...plan.services].every(n => SAFE_NAME.test(n))) return fail('unexpected compose name');
    await d.docker('POST', `/images/create?fromImage=${HELPER_IMAGE.name}&tag=${HELPER_IMAGE.tag}`);
    const services = plan.services.join(' ');
    // Paths travel as environment variables, never through the shell. The
    // short sleep lets this server answer the request before it is replaced.
    // --force-recreate: a pinned tag or :beta may pull nothing new, and the
    // dashboard waits for the restart either way.
    const script = `sleep 3 && docker compose pull ${services} && docker compose up -d --no-deps --force-recreate ${services}`;
    const dirs = [...new Set([plan.workdir, ...plan.configFiles.map(f => path.dirname(f))])];
    const created = await d.docker('POST', `/containers/create?name=opennova-updater-${Date.now()}`, {
      Image: `${HELPER_IMAGE.name}:${HELPER_IMAGE.tag}`,
      Cmd: ['sh', '-c', script],
      Env: [`COMPOSE_PROJECT_NAME=${plan.project}`, `COMPOSE_FILE=${plan.configFiles.join(':')}`],
      WorkingDir: plan.workdir,
      Labels: { 'opennova.role': 'updater' },
      HostConfig: { AutoRemove: true, Binds: [`${DOCKER_SOCKET}:${DOCKER_SOCKET}`, ...dirs.map(p => `${p}:${p}`)] },
    }) as { Id: string };
    await d.docker('POST', `/containers/${created.Id}/start`);
    console.log(`[UPDATE] helper started for ${plan.project}: ${services}`);
    return { ok: true };
  } catch (e) {
    return fail((e as Error).message);
  }
}

/** Tests only. */
export function _resetSelfUpdate(): void {
  running = false;
}
