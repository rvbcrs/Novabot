import { spawn, execSync } from 'child_process';
import net from 'net';
import type { Server as IOServer } from 'socket.io';

const CONTAINER_NAME = 'opennova';
const IMAGE_NAME = 'rvbcrs/opennova:latest';

export interface DockerStatus {
  dockerInstalled: boolean;
  dockerRunning: boolean;
  containerExists: boolean;
  containerRunning: boolean;
  containerImage: string | null;
  containerTargetIp: string | null;
  error: string | null;
}

function isDockerInstalled(): boolean {
  try {
    execSync('docker --version', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function isDockerRunning(): boolean {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function getContainerInfo(): { exists: boolean; running: boolean; image: string | null; targetIp: string | null } {
  try {
    const output = execSync(
      `docker inspect ${CONTAINER_NAME} --format '{{.State.Running}}|||{{.Config.Image}}'`,
      { stdio: 'pipe', timeout: 5000 }
    ).toString().trim();

    const [running, image] = output.split('|||');

    // Extract TARGET_IP from env vars
    let targetIp: string | null = null;
    try {
      const envOutput = execSync(
        `docker inspect ${CONTAINER_NAME} --format '{{range .Config.Env}}{{println .}}{{end}}'`,
        { stdio: 'pipe', timeout: 5000 }
      ).toString();
      const match = envOutput.match(/^TARGET_IP=(.+)$/m);
      if (match) targetIp = match[1];
    } catch { /* ignore */ }

    return {
      exists: true,
      running: running === 'true',
      image: image || null,
      targetIp,
    };
  } catch {
    return { exists: false, running: false, image: null, targetIp: null };
  }
}

export function getDockerStatus(): DockerStatus {
  const dockerInstalled = isDockerInstalled();
  if (!dockerInstalled) {
    return {
      dockerInstalled: false, dockerRunning: false,
      containerExists: false, containerRunning: false,
      containerImage: null, containerTargetIp: null, error: null,
    };
  }

  const dockerRunning = isDockerRunning();
  if (!dockerRunning) {
    return {
      dockerInstalled: true, dockerRunning: false,
      containerExists: false, containerRunning: false,
      containerImage: null, containerTargetIp: null, error: null,
    };
  }

  const container = getContainerInfo();
  return {
    dockerInstalled: true,
    dockerRunning: true,
    containerExists: container.exists,
    containerRunning: container.running,
    containerImage: container.image,
    containerTargetIp: container.targetIp,
    error: null,
  };
}

export function pullImage(io: IOServer): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('docker', ['pull', IMAGE_NAME], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let lastLine = '';

    proc.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        lastLine = line;
        io.emit('docker-pull-progress', { message: line });
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) io.emit('docker-pull-progress', { message: text });
    });

    proc.on('close', (code) => {
      if (code === 0) {
        io.emit('docker-pull-progress', { message: 'Image download voltooid', done: true });
        resolve(true);
      } else {
        io.emit('docker-error', { message: `Pull mislukt (exit ${code}): ${lastLine}` });
        resolve(false);
      }
    });

    proc.on('error', (err) => {
      io.emit('docker-error', { message: `Pull error: ${err.message}` });
      resolve(false);
    });
  });
}

export function removeContainer(): void {
  try {
    execSync(`docker stop ${CONTAINER_NAME}`, { stdio: 'pipe', timeout: 30000 });
  } catch { /* container might not be running */ }
  try {
    execSync(`docker rm ${CONTAINER_NAME}`, { stdio: 'pipe', timeout: 10000 });
  } catch { /* container might not exist */ }
}

export function startContainer(targetIp: string, io: IOServer): Promise<boolean> {
  return new Promise((resolve) => {
    const args = [
      'run', '-d',
      '--name', CONTAINER_NAME,
      '--restart', 'unless-stopped',
      '-p', '53:53/udp',
      '-p', '53:53/tcp',
      '-p', '80:80',
      '-p', '443:443',
      '-p', '1883:1883',
      '-v', 'novabot-data:/data',
      '-e', `TARGET_IP=${targetIp}`,
      '-e', 'PORT=80',
      IMAGE_NAME,
    ];

    io.emit('docker-status', { phase: 'starting', message: 'Container starten...' });

    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let containerId = '';
    let errorOutput = '';

    proc.stdout.on('data', (data: Buffer) => { containerId += data.toString().trim(); });
    proc.stderr.on('data', (data: Buffer) => { errorOutput += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        const shortId = containerId.slice(0, 12);
        console.log(`[Docker] Container gestart: ${shortId}`);
        io.emit('docker-status', { phase: 'started', containerId: shortId });
        resolve(true);
      } else {
        console.error(`[Docker] Start mislukt: ${errorOutput}`);
        io.emit('docker-error', { message: errorOutput.trim() || `Container start mislukt (exit ${code})` });
        resolve(false);
      }
    });

    proc.on('error', (err) => {
      io.emit('docker-error', { message: `Start error: ${err.message}` });
      resolve(false);
    });
  });
}

export async function checkHealth(targetIp: string): Promise<{ http: boolean; mqtt: boolean }> {
  const [http, mqtt] = await Promise.all([
    checkHttpHealth(targetIp),
    checkMqttHealth(targetIp),
  ]);
  return { http, mqtt };
}

async function checkHttpHealth(targetIp: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`http://${targetIp}/api/nova-network/network/connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return resp.ok;
  } catch {
    return false;
  }
}

function checkMqttHealth(targetIp: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(1883, targetIp, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(3000);
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { resolve(false); });
  });
}
