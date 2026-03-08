import net from 'net';
import os from 'os';
import dns from 'dns';
import type { Server as IOServer } from 'socket.io';
import mqtt from 'mqtt';
import { decryptFromDevice } from './crypto.js';

// aedes v0.47.x (CommonJS)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Aedes = require('aedes');

export interface ConnectedMower {
  sn: string;
  clientId: string;
  ip: string;
}

let _broker: ReturnType<typeof Aedes> | null = null;
let _tcpServer: net.Server | null = null;           // TCP server for own broker
let _localClient: mqtt.MqttClient | null = null;   // subscriber to existing local broker
let _remoteClient: mqtt.MqttClient | null = null;  // subscriber to remote (mower's) broker
let _connectedMower: ConnectedMower | null = null;
let _clientMode = false;        // true = port 1883 was in use, using subscriber only
let _remoteDetected = false;    // mower found via remote (mower's own) broker
let _mowerVersion: string | null = null;

type MowerCallback = (mower: ConnectedMower) => void;
const _disconnectCallbacks: MowerCallback[] = [];
const _reconnectCallbacks: MowerCallback[] = [];
let _wasDisconnected = false;  // Track if mower disconnected (for reconnect detection)

export function getConnectedMower(): ConnectedMower | null { return _connectedMower; }
export function getMowerVersion(): string | null { return _mowerVersion; }
export function isClientMode(): boolean { return _clientMode; }
export function onMowerDisconnect(cb: MowerCallback): void { _disconnectCallbacks.push(cb); }
export function onMowerReconnect(cb: MowerCallback): void { _reconnectCallbacks.push(cb); }

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
    // The mower uses 'mower_version' in its status JSON
    const version = obj.mower_version ?? obj.device_version ?? obj.version;
    if (version && typeof version === 'string' && version.startsWith('v')) {
      _mowerVersion = version;
      io.emit('mower-version', { version });
      console.log(`[MQTT] Mower version: ${version}`);
    }
  } catch {
    // Not JSON or no version field — ignore
  }
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
      console.log('[MQTT] Port 1883 in use — resolving DNS to find the right broker');
      _clientMode = true;
      _broker = null;
      // Resolve mqtt.lfibot.com to find where the active broker is
      dns.lookup('mqtt.lfibot.com', (dnsErr, address) => {
        const host = (!dnsErr && address) ? address : '127.0.0.1';
        console.log(`[MQTT] Connecting as subscriber to broker at ${host}:1883`);
        io.emit('broker-mode', { mode: 'existing', host });
        startSubscriberMode(io, host);
      });
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
    }
  });

  broker.on('clientDisconnect', (client: { id: string }) => {
    if (client.id.startsWith('LFIN')) {
      const sn = client.id.split('_')[0];
      emitMowerDisconnected(io, sn);
    }
  });

  broker.on('publish', (packet: { topic: string; payload: Buffer }, client: { id: string } | null) => {
    if (!client || !packet.topic.startsWith('Dart/Receive_mqtt/')) return;
    const sn = packet.topic.split('/').pop() ?? '';
    if (!sn.startsWith('LFIN')) return;
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
    });

    _remoteClient.on('message', (topic: string, payload: Buffer) => {
      const sn = topic.split('/').pop() ?? '';
      if (!sn.startsWith('LFIN')) return;
      if (!_connectedMower || _connectedMower.sn !== sn) {
        _remoteDetected = true;
        const mower: ConnectedMower = { sn, clientId: sn, ip: '' };
        _connectedMower = mower;
        io.emit('mower-connected', { sn, ip: '' });
        console.log(`[MQTT] Mower detected via remote broker at ${address}: SN=${sn}`);
        emitMowerReconnected(io, mower);
      }
      if (topic.startsWith('Dart/Receive_mqtt/')) {
        tryExtractVersion(io, sn, payload);
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
  });

  client.on('message', (topic: string, payload: Buffer) => {
    const sn = topic.split('/').pop() ?? '';
    if (!sn.startsWith('LFIN')) return;
    if (!_connectedMower || _connectedMower.sn !== sn) {
      const mower: ConnectedMower = { sn, clientId: sn, ip: '' };
      _connectedMower = mower;
      io.emit('mower-connected', { sn, ip: '' });
      emitMowerReconnected(io, mower);
    }
    if (topic.startsWith('Dart/Receive_mqtt/')) {
      tryExtractVersion(io, sn, payload);
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
