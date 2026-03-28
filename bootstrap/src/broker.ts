import net from 'net';
import os from 'os';
import dns from 'dns';
import type { Server as IOServer } from 'socket.io';
import mqtt from 'mqtt';
import { decryptFromDevice, encryptForDevice } from './crypto.js';

// aedes v0.47.x (CommonJS)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Aedes = require('aedes');

export interface ConnectedMower {
  sn: string;
  clientId: string;
  ip: string;
}

export interface ConnectedCharger {
  sn: string;
  clientId: string;
}

let _connectedCharger: ConnectedCharger | null = null;

export function getConnectedCharger(): ConnectedCharger | null { return _connectedCharger; }

function detectCharger(io: IOServer, sn: string, clientId: string): void {
  if (_connectedCharger?.sn === sn) return; // already known
  _connectedCharger = { sn, clientId };
  console.log(`[MQTT] Charger connected: SN=${sn} clientId=${clientId}`);
  io.emit('charger-connected', { sn });
}

function detectDevice(io: IOServer, sn: string, topic: string, clientId: string): void {
  if (sn.startsWith('LFIC')) {
    detectCharger(io, sn, clientId);
  }
}

let _broker: ReturnType<typeof Aedes> | null = null;
let _tcpServer: net.Server | null = null;           // TCP server for own broker
let _localClient: mqtt.MqttClient | null = null;   // subscriber to existing local broker
let _remoteClient: mqtt.MqttClient | null = null;  // subscriber to remote (mower's) broker
let _connectedMower: ConnectedMower | null = null;
let _clientMode = false;        // true = port 1883 was in use, using subscriber only
let _remoteDetected = false;    // mower found via remote (mower's own) broker
let _mowerVersion: string | null = null;
let _isCustomFirmware: boolean | null = null; // null = unknown, true = SSH reachable, false = no SSH

type MowerCallback = (mower: ConnectedMower) => void;
const _disconnectCallbacks: MowerCallback[] = [];
const _reconnectCallbacks: MowerCallback[] = [];
let _wasDisconnected = false;  // Track if mower disconnected (for reconnect detection)

// Heartbeat: detect mower disconnect in subscriber/remote mode (no CONNACK events)
let _lastMowerMessage = 0;         // timestamp of last MQTT message from mower
let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const HEARTBEAT_INTERVAL = 15_000; // check every 15s
const HEARTBEAT_TIMEOUT = 45_000;  // no message for 45s → disconnect

export function getConnectedMower(): ConnectedMower | null { return _connectedMower; }
export function getMowerVersion(): string | null { return _mowerVersion; }
export function getIsCustomFirmware(): boolean | null { return _isCustomFirmware; }
export function isClientMode(): boolean { return _clientMode; }

/**
 * Check if SSH (port 22) is reachable on the mower.
 * Custom firmware has SSH enabled; stock firmware does not.
 */
function checkSshReachable(ip: string, io: IOServer): void {
  if (!ip) { _isCustomFirmware = null; return; }
  const socket = new net.Socket();
  socket.setTimeout(3000);
  socket.on('connect', () => {
    _isCustomFirmware = true;
    socket.destroy();
    io.emit('mower-firmware-type', { isCustom: true });
    console.log(`[MQTT] SSH reachable on ${ip}:22 → custom firmware`);
  });
  socket.on('timeout', () => {
    _isCustomFirmware = false;
    socket.destroy();
    io.emit('mower-firmware-type', { isCustom: false });
    console.log(`[MQTT] SSH not reachable on ${ip}:22 → stock firmware`);
  });
  socket.on('error', () => {
    _isCustomFirmware = false;
    socket.destroy();
    io.emit('mower-firmware-type', { isCustom: false });
    console.log(`[MQTT] SSH not reachable on ${ip}:22 → stock firmware`);
  });
  socket.connect(22, ip);
}
/**
 * In subscriber mode, the mower's IP isn't available from the MQTT connection.
 * Query the Docker container's DB to get the IP, then run SSH check.
 */
function checkFirmwareViaDocker(sn: string, io: IOServer): void {
  if (_isCustomFirmware !== null) return;
  import('child_process').then(({ execSync }) => {
    try {
      const script = [
        `const Database = require('better-sqlite3');`,
        `const db = new Database(process.env.DB_PATH || './novabot.db');`,
        `const r = db.prepare("SELECT e.mower_ip, d.ip_address FROM equipment e LEFT JOIN device_registry d ON d.sn = e.mower_sn AND d.ip_address IS NOT NULL WHERE e.mower_sn = ?").get('${sn}');`,
        `console.log(JSON.stringify({ip: r?.mower_ip || r?.ip_address || null}));`,
      ].join(' ');
      const result = execSync(
        `docker exec -w /app/novabot-server opennova node -e "${script.replace(/"/g, '\\"')}"`,
        { encoding: 'utf8', timeout: 10000 },
      );
      const { ip } = JSON.parse(result.trim()) as { ip: string | null };
      if (ip) {
        console.log(`[MQTT] Mower IP from Docker DB: ${ip}`);
        if (_connectedMower && !_connectedMower.ip) _connectedMower.ip = ip;
        checkSshReachable(ip, io);
      } else {
        console.log(`[MQTT] No mower IP found in Docker DB`);
      }
    } catch (err) {
      console.warn('[MQTT] Docker DB IP lookup failed:', err instanceof Error ? err.message : err);
    }
  });
}

export function onMowerDisconnect(cb: MowerCallback): void { _disconnectCallbacks.push(cb); }
export function onMowerReconnect(cb: MowerCallback): void { _reconnectCallbacks.push(cb); }

/**
 * Start heartbeat timer for subscriber/remote mode.
 * Detects mower disconnect when MQTT messages stop (no CONNACK events in these modes).
 */
function startHeartbeat(io: IOServer): void {
  if (_heartbeatTimer) return; // already running
  _heartbeatTimer = setInterval(() => {
    if (!_connectedMower || _lastMowerMessage === 0) return;
    const elapsed = Date.now() - _lastMowerMessage;
    if (elapsed > HEARTBEAT_TIMEOUT) {
      console.log(`[MQTT] Heartbeat timeout: no message from ${_connectedMower.sn} for ${Math.round(elapsed / 1000)}s — treating as disconnect`);
      emitMowerDisconnected(io, _connectedMower.sn);
      _lastMowerMessage = 0; // reset so we don't fire again
    }
  }, HEARTBEAT_INTERVAL);
}

/** Reset heartbeat on each mower message. */
function heartbeat(): void {
  _lastMowerMessage = Date.now();
}

/**
 * Try to decrypt a message from the mower and extract firmware version.
 * The mower sends AES-encrypted JSON with a 'mower_version' field in its status messages.
 */
function tryExtractVersion(io: IOServer, sn: string, payload: Buffer): void {
  if (_mowerVersion) return; // Already detected
  const text = decryptFromDevice(sn, payload);
  if (!text) return;
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    let version: string | undefined;

    // 1. ota_version_info_respond — response to our ota_version_info request
    //    Mower:  {"ota_version_info_respond":{"version":"v6.0.0",...}}
    //    Charger: {"type":"ota_version_info_respond","message":{"value":{"version":"v0.4.0"}}}
    const otaResp = obj.ota_version_info_respond as Record<string, unknown> | undefined;
    if (otaResp && typeof otaResp === 'object') {
      version = otaResp.version as string | undefined;
    }
    if (!version && obj.type === 'ota_version_info_respond') {
      const msg = obj.message as Record<string, unknown> | undefined;
      const val = msg?.value as Record<string, unknown> | undefined;
      version = (val?.version ?? msg?.version) as string | undefined;
    }

    // 2. Fallback: top-level version fields in status messages
    if (!version) {
      version = (obj.mower_version ?? obj.device_version ?? obj.version) as string | undefined;
    }

    if (version && typeof version === 'string') {
      _mowerVersion = version;
      io.emit('mower-version', { version });
      console.log(`[MQTT] Mower version: ${version}`);
    }
  } catch {
    // Not JSON or no version field — ignore
  }
}

/**
 * Request the mower to report its firmware version by sending ota_version_info: null.
 * Delayed 3s to let the mower finish its connection handshake.
 */
function requestMowerVersion(sn: string): void {
  if (_mowerVersion) return;
  setTimeout(() => {
    if (_mowerVersion) return;
    console.log(`[MQTT] Requesting mower version from ${sn}...`);
    const command = { ota_version_info: null };
    const encrypted = encryptForDevice(sn, command);
    publishToMower(sn, encrypted);
  }, 3000);
}

function emitMowerDisconnected(io: IOServer, sn: string): void {
  const mower = _connectedMower;
  _connectedMower = null;
  _wasDisconnected = true;
  io.emit('mower-disconnected', { sn });
  if (mower) _disconnectCallbacks.forEach(cb => cb(mower));
}

function emitMowerReconnected(io: IOServer, mower: ConnectedMower): void {
  if (!_wasDisconnected) return;
  _wasDisconnected = false;
  console.log(`[MQTT] Mower reconnected: SN=${mower.sn}, IP=${mower.ip}`);
  io.emit('mower-reconnected', { sn: mower.sn, ip: mower.ip });
  _reconnectCallbacks.forEach(cb => cb(mower));
}

export function startBroker(io: IOServer): void {
  const broker = Aedes();
  _broker = broker;

  _tcpServer = net.createServer(broker.handle);
  const server = _tcpServer;

  server.listen(1883, '0.0.0.0', () => {
    console.log('[MQTT] Bootstrap broker listening on port 1883');
    // After starting own broker, also check if DNS points to an external broker
    // (e.g. mower running its own novabot-server — self-hosted firmware)
    checkDnsForRemoteBroker(io);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Port 1883 is already in use — Docker container is running on this machine.
      // Connect directly to localhost instead of doing a DNS lookup (which would
      // resolve mqtt.lfibot.com to the real LFI cloud if the Mac's DNS bypasses AdGuard).
      console.log('[MQTT] Port 1883 in use — connecting as subscriber to local broker (127.0.0.1)');
      _clientMode = true;
      _broker = null;
      io.emit('broker-mode', { mode: 'existing', host: '127.0.0.1' });
      startSubscriberMode(io, '127.0.0.1');
    } else {
      console.error('[MQTT] Server error:', err.message);
    }
  });

  // Broker server mode event handlers
  broker.on('client', (client: { id: string; conn: { remoteAddress?: string } }) => {
    const rawIp = client.conn?.remoteAddress ?? '';
    const ip = rawIp.replace(/^::ffff:/, '');
    console.log(`[MQTT] Client connected: ${client.id} (${ip})`);

    if (client.id.startsWith('LFIN')) {
      const sn = client.id.split('_')[0];
      const mower: ConnectedMower = { sn, clientId: client.id, ip };
      _connectedMower = mower;
      io.emit('mower-connected', { sn, ip });
      console.log(`[MQTT] Mower connected to own broker: SN=${sn}, IP=${ip}`);
      emitMowerReconnected(io, mower);
      requestMowerVersion(sn);
    }
    if (client.id.startsWith('ESP32_') || client.id.startsWith('SNC')) {
      // Charger — clientId is ESP32_xxxx, detect SN from subscribe topic later
      console.log(`[MQTT] Charger connected to own broker: clientId=${client.id}, IP=${ip}`);
      // Check if SSH is reachable → determines custom vs stock firmware
      if (ip) checkSshReachable(ip, io);
    }
  });

  broker.on('clientDisconnect', (client: { id: string }) => {
    if (client.id.startsWith('LFIN')) {
      const sn = client.id.split('_')[0];
      emitMowerDisconnected(io, sn);
    }
  });

  broker.on('publish', (packet: { topic: string; payload: Buffer }, client: { id: string } | null) => {
    if (!client) return;
    const isReceive = packet.topic.startsWith('Dart/Receive_mqtt/');
    const isServerReceive = packet.topic.startsWith('Dart/Receive_server_mqtt/');
    if (!isReceive && !isServerReceive) return;
    const sn = packet.topic.split('/').pop() ?? '';
    if (sn.startsWith('LFIC')) detectDevice(io, sn, packet.topic, client.id);
    if (!sn.startsWith('LFIN') && !sn.startsWith('LFIC')) return;
    console.log(`[MQTT] Publish on ${packet.topic} from ${client.id} (${packet.payload.length} bytes)`);
    tryExtractVersion(io, sn, packet.payload);
  });
}

/**
 * After starting our own broker, check if mqtt.lfibot.com resolves to an EXTERNAL IP.
 * This happens when the mower runs its own novabot-server (self-hosted firmware).
 * In that case, the mower's mqtt_node connects to its OWN broker — we subscribe there
 * to detect the mower and send OTA commands.
 */
function checkDnsForRemoteBroker(io: IOServer): void {
  // Collect our own IPs so we don't subscribe to ourselves
  const ownIps = new Set(
    Object.values(os.networkInterfaces())
      .flat()
      .filter(i => i?.family === 'IPv4')
      .map(i => i!.address)
  );
  ownIps.add('127.0.0.1');

  dns.lookup('mqtt.lfibot.com', (err, address) => {
    if (err || !address) return; // No DNS redirect
    if (ownIps.has(address)) return; // Points to us → mower will come directly

    console.log(`[MQTT] mqtt.lfibot.com → ${address} (mower's own broker). Connecting as subscriber.`);
    io.emit('broker-mode', { mode: 'remote-dns', address });

    _remoteClient = mqtt.connect(`mqtt://${address}:1883`, {
      clientId: `novabot-bootstrap-remote-${Date.now()}`,
      clean: true,
      connectTimeout: 5000,
      reconnectPeriod: 30000,
    });

    _remoteClient.on('connect', () => {
      console.log(`[MQTT] Connected to mower's broker at ${address}:1883`);
      _remoteClient!.subscribe(['Dart/Receive_mqtt/#', 'Dart/Receive_server_mqtt/#']);
      io.emit('broker-mode', { mode: 'remote-dns', address, connected: true });
      startHeartbeat(io);
    });

    _remoteClient.on('message', (topic: string, payload: Buffer) => {
      const sn = topic.split('/').pop() ?? '';
      if (!sn.startsWith('LFI')) return;
      heartbeat();

      if (sn.startsWith('LFIC')) {
        detectDevice(io, sn, topic, sn);
        return;
      }

      if (sn.startsWith('LFIN')) {
        if (!_connectedMower || _connectedMower.sn !== sn) {
          _remoteDetected = true;
          const mower: ConnectedMower = { sn, clientId: sn, ip: '' };
          _connectedMower = mower;
          io.emit('mower-connected', { sn, ip: '' });
          console.log(`[MQTT] Mower detected via remote broker at ${address}: SN=${sn}`);
          emitMowerReconnected(io, mower);
          requestMowerVersion(sn);
          checkFirmwareViaDocker(sn, io);
        }
        if (topic.startsWith('Dart/Receive_mqtt/') || topic.startsWith('Dart/Receive_server_mqtt/')) {
          tryExtractVersion(io, sn, payload);
        }
      }
    });

    // When the mower's own broker goes offline (reboot), treat as disconnect
    _remoteClient.on('close', () => {
      if (_connectedMower && _remoteDetected) {
        console.log(`[MQTT] Remote broker at ${address} closed — mower likely rebooting`);
        emitMowerDisconnected(io, _connectedMower.sn);
        _remoteDetected = false;
      }
    });

    _remoteClient.on('error', (e: Error) => {
      console.log(`[MQTT] Remote broker at ${address} unreachable: ${e.message}`);
    });
  });
}

/**
 * Subscribe to an existing broker (when port 1883 was already in use).
 */
function startSubscriberMode(io: IOServer, host: string): void {
  const client = mqtt.connect(`mqtt://${host}:1883`, {
    clientId: `novabot-bootstrap-${Date.now()}`,
    clean: true,
    reconnectPeriod: 5000,
  });
  _localClient = client;

  client.on('connect', () => {
    console.log(`[MQTT] Subscribed to existing broker at ${host}:1883`);
    client.subscribe(['Dart/Receive_mqtt/#', 'Dart/Receive_server_mqtt/#']);
    io.emit('broker-mode', { mode: 'existing', connected: true, host });
    startHeartbeat(io);
  });

  client.on('message', (topic: string, payload: Buffer) => {
    const sn = topic.split('/').pop() ?? '';
    if (!sn.startsWith('LFI')) return;
    heartbeat();

    // Charger detection (LFIC*)
    if (sn.startsWith('LFIC')) {
      detectDevice(io, sn, topic, sn);
      return;
    }

    // Mower detection (LFIN*)
    if (sn.startsWith('LFIN')) {
      if (!_connectedMower || _connectedMower.sn !== sn) {
        const mower: ConnectedMower = { sn, clientId: sn, ip: '' };
        _connectedMower = mower;
        io.emit('mower-connected', { sn, ip: '' });
        emitMowerReconnected(io, mower);
        requestMowerVersion(sn);
        checkFirmwareViaDocker(sn, io);
      }
      if (topic.startsWith('Dart/Receive_mqtt/') || topic.startsWith('Dart/Receive_server_mqtt/')) {
        tryExtractVersion(io, sn, payload);
      }
    }
  });

  client.on('error', (e: Error) => {
    console.error('[MQTT] Subscriber error:', e.message);
  });
}

/**
 * Stop the bootstrap's own MQTT broker and switch to subscriber mode.
 * Called when Docker container is started and takes over port 1883.
 */
export function switchToClientMode(io: IOServer, host: string): void {
  if (_clientMode) return; // Already in client mode

  if (_tcpServer) {
    _tcpServer.close(() => {
      console.log('[MQTT] TCP server on 1883 closed');
    });
    _tcpServer = null;
  }
  if (_broker) {
    _broker.close(() => {
      console.log('[MQTT] Aedes broker closed');
    });
    _broker = null;
  }

  _clientMode = true;
  console.log(`[MQTT] Switching to client mode → ${host}:1883`);
  io.emit('broker-mode', { mode: 'docker', host });
  startSubscriberMode(io, host);
}

export function publishToMower(sn: string, payload: Buffer): void {
  // Use whichever client has the mower's broker
  const pubClient = (_remoteDetected && _remoteClient) ? _remoteClient
    : (_clientMode && _localClient) ? _localClient
    : null;

  if (pubClient) {
    pubClient.publish(`Dart/Send_mqtt/${sn}`, payload, { qos: 0, retain: false }, (err) => {
      if (err) console.error('[MQTT] Publish error:', err.message);
    });
    return;
  }

  if (!_broker) throw new Error('Broker not started');
  _broker.publish(
    { topic: `Dart/Send_mqtt/${sn}`, payload, qos: 0, retain: false },
    (err: Error | null) => { if (err) console.error('[MQTT] Publish error:', err.message); }
  );
}
