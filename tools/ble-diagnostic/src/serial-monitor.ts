/**
 * SSH-based Serial Monitor for Novabot mower.
 *
 * Connects via SSH to the mower, runs strace on chassis_control_node
 * to non-invasively read /dev/ttyACM0 data, parses STM32 binary frames,
 * and decodes LoRa packets.
 *
 * STM32 frame protocol:
 *   [02 02] [CMD_ID_H CMD_ID_L] [PAYLOAD_LEN] [PAYLOAD...] [03 03]
 *
 * LoRa packet categories (first payload byte):
 *   0x30 = CHARGER (hall ACK), 0x31 = RTK_RELAY (NMEA),
 *   0x32 = CONFIG, 0x33 = GPS, 0x34 = REPORT (heartbeat/status),
 *   0x35 = ORDER (mow commands), 0x36 = SCAN_CHANNEL
 */

import { Client as SSHClient } from 'ssh2';
import type { ClientChannel } from 'ssh2';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SerialFrame {
  timestamp: number;
  cmdId: number;
  payloadHex: string;
  category?: string;
  decoded?: Record<string, unknown>;
  direction: 'read' | 'write';
  raw: string;
}

export interface SerialStats {
  connected: boolean;
  host: string;
  heartbeats: number;
  lastHeartbeat: number | null;
  rtkSentences: number;
  lastRtk: number | null;
  totalFrames: number;
  loraFrames: number;
  framesPerSec: number;
}

type FrameListener = (frame: SerialFrame) => void;
type StatsListener = (stats: SerialStats) => void;
type StatusListener = (status: { connected: boolean; host: string; error?: string }) => void;

// ── LoRa Category Names ────────────────────────────────────────────────────

const LORA_CATEGORIES: Record<number, string> = {
  0x30: 'CHARGER',
  0x31: 'RTK_RELAY',
  0x32: 'CONFIG',
  0x33: 'GPS',
  0x34: 'REPORT',
  0x35: 'ORDER',
  0x36: 'SCAN_CHANNEL',
};

const LORA_CATEGORY_SET = new Set(Object.values(LORA_CATEGORIES));

const ORDER_SUBCMDS: Record<number, string> = {
  0x01: 'start_run',
  0x03: 'pause_run',
  0x05: 'resume_run',
  0x07: 'stop_run',
  0x09: 'stop_time_run',
  0x0B: 'go_pile',
};

// ── State ───────────────────────────────────────────────────────────────────

let sshClient: SSHClient | null = null;
let straceStream: ClientChannel | null = null;
let _connected = false;
let _host = '';

const frameListeners: FrameListener[] = [];
const statsListeners: StatsListener[] = [];
const statusListeners: StatusListener[] = [];

// Stats
let stats: SerialStats = resetStats('');

// Frame rate tracking
let frameCountWindow: number[] = [];

// Strace line buffer
let lineBuf = '';

// ── Public API ──────────────────────────────────────────────────────────────

export function onFrame(listener: FrameListener): void {
  frameListeners.push(listener);
}

export function offFrame(listener: FrameListener): void {
  const idx = frameListeners.indexOf(listener);
  if (idx !== -1) frameListeners.splice(idx, 1);
}

export function onStats(listener: StatsListener): void {
  statsListeners.push(listener);
}

export function onStatus(listener: StatusListener): void {
  statusListeners.push(listener);
}

export function getStatus(): { connected: boolean; host: string } {
  return { connected: _connected, host: _host };
}

export function getStats(): SerialStats {
  return { ...stats };
}

/**
 * Connect to mower via SSH and start strace on chassis_control_node.
 */
export function connectMower(host: string, password?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (_connected) {
      disconnectMower();
    }

    _host = host;
    stats = resetStats(host);
    lineBuf = '';
    readBuf.length = 0;
    writeBuf.length = 0;

    const conn = new SSHClient();
    sshClient = conn;

    const connectTimeout = setTimeout(() => {
      conn.end();
      reject(new Error('SSH connection timeout (10s)'));
    }, 10000);

    conn.on('ready', () => {
      clearTimeout(connectTimeout);
      console.log(`[Serial] SSH connected to ${host}`);
      _connected = true;
      emitStatus({ connected: true, host });

      // Kill any orphaned strace first, then start fresh.
      // Use killall (exact process name) — pkill -f would match the bash wrapper and kill itself!
      const killOrphans = 'killall strace 2>/dev/null; sleep 0.3';
      const straceCmd = 'strace -e trace=read,write -xx -s 4096 -f -p $(pidof chassis_control_node) 2>&1';
      const cmd = `${killOrphans}; ${straceCmd}`;
      console.log(`[Serial] Running: ${cmd}`);

      conn.exec(cmd, (err, stream) => {
        if (err) {
          console.error(`[Serial] exec error: ${err.message}`);
          emitStatus({ connected: true, host, error: `strace failed: ${err.message}` });
          reject(err);
          return;
        }

        straceStream = stream;
        resolve();

        stream.on('data', (data: Buffer) => {
          processStraceData(data.toString('utf8'));
        });

        stream.stderr.on('data', (data: Buffer) => {
          // strace outputs to stderr
          processStraceData(data.toString('utf8'));
        });

        stream.on('close', () => {
          console.log('[Serial] strace stream closed');
          _connected = false;
          emitStatus({ connected: false, host });
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(connectTimeout);
      console.error(`[Serial] SSH error: ${err.message}`);
      _connected = false;
      emitStatus({ connected: false, host, error: err.message });
      reject(err);
    });

    conn.on('close', () => {
      _connected = false;
      emitStatus({ connected: false, host });
    });

    conn.connect({
      host,
      port: 22,
      username: 'root',
      password: password ?? 'novabot',
      readyTimeout: 10000,
      algorithms: {
        serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'],
      },
    });
  });
}

/**
 * Disconnect SSH and stop strace.
 */
export function disconnectMower(): void {
  // Kill strace on remote before closing SSH to prevent orphaned processes
  if (sshClient && _connected) {
    try {
      sshClient.exec('killall strace 2>/dev/null', () => {});
    } catch { /* ignore */ }
  }
  if (straceStream) {
    try { straceStream.close(); } catch { /* ignore */ }
    straceStream = null;
  }
  if (sshClient) {
    try { sshClient.end(); } catch { /* ignore */ }
    sshClient = null;
  }
  _connected = false;
  emitStatus({ connected: false, host: _host });
  console.log('[Serial] Disconnected');
}

// ── Strace Output Parsing ───────────────────────────────────────────────────

// Byte accumulation buffers per direction.
// chassis_control_node reads serial data in small chunks (1 byte header, 3 bytes cmd+len, N bytes payload)
// so we must accumulate across multiple read() calls before scanning for complete frames.
const readBuf: number[] = [];
const writeBuf: number[] = [];
const MAX_BUF = 8192; // Prevent unbounded growth

/**
 * Parse strace output lines. strace writes to stderr, one syscall per line.
 * Actual output from mower looks like:
 *   [pid  3508] read(4, "\x02", 1)          = 1
 *   [pid  3508] read(4, "\x02", 1)          = 1
 *   [pid  3508] read(4, "\x00\x01\x16", 3)  = 3
 *   [pid  3508] read(4, "\x09\xff\x3e...\x03\x03", 24) = 24
 *   [pid  3170] write(4, "\x02\x02\x07\xff\x08...\x03\x03", 15) = 15
 *   [pid  3508] <... read resumed>"\x02", 1) = 1
 */
function processStraceData(chunk: string): void {
  lineBuf += chunk;
  const lines = lineBuf.split('\n');
  lineBuf = lines.pop() ?? ''; // Keep incomplete last line in buffer

  for (const line of lines) {
    parseStraceLine(line.trim());
  }
}

// Regex to match strace read/write with hex data — handles [pid  NNN] with variable whitespace
// Also handles resumed syscalls: [pid  3508] <... read resumed>"\x02", 1) = 1
const STRACE_RE = /(?:\[pid\s+\d+\]\s+)?(?:(read|write)\(\d+, |<\.\.\. (read|write) resumed>)"((?:\\x[0-9a-f]{2})+)".*=\s*(\d+)/;

function parseStraceLine(line: string): void {
  const m = line.match(STRACE_RE);
  if (!m) return;

  const direction = (m[1] || m[2]) as 'read' | 'write';
  const hexStr = m[3];

  // Convert \xHH sequences to byte array
  const bytes = hexToBytes(hexStr);
  if (bytes.length === 0) return;

  // Accumulate into per-direction buffer
  const buf = direction === 'read' ? readBuf : writeBuf;
  buf.push(...bytes);

  // Prevent unbounded growth
  if (buf.length > MAX_BUF) buf.splice(0, buf.length - MAX_BUF);

  // Scan buffer for complete frames
  extractFrames(buf, direction);
}

function hexToBytes(hexStr: string): number[] {
  const bytes: number[] = [];
  const re = /\\x([0-9a-f]{2})/g;
  let match;
  while ((match = re.exec(hexStr)) !== null) {
    bytes.push(parseInt(match[1], 16));
  }
  return bytes;
}

/**
 * Extract STM32 frames from accumulated byte buffer.
 * Frame format: [02 02] [CMD_H CMD_L] [PAYLOAD_LEN] [PAYLOAD...] [03 03]
 * Consumes matched bytes from the buffer.
 */
function extractFrames(buf: number[], direction: 'read' | 'write'): void {
  let consumed = 0;

  while (consumed < buf.length - 4) {
    // Find start marker [02 02]
    if (buf[consumed] !== 0x02 || buf[consumed + 1] !== 0x02) {
      consumed++;
      continue;
    }

    // Need at least 5 bytes to read cmd + length
    if (consumed + 4 >= buf.length) break;

    // CMD_ID (2 bytes, big-endian)
    const cmdId = (buf[consumed + 2] << 8) | buf[consumed + 3];

    // Payload length
    const payloadLen = buf[consumed + 4];

    // Check if we have enough bytes for the full frame
    const frameEnd = consumed + 5 + payloadLen + 2; // +2 for [03 03]
    if (frameEnd > buf.length) break; // Wait for more data

    // Check end marker [03 03]
    if (buf[frameEnd - 2] !== 0x03 || buf[frameEnd - 1] !== 0x03) {
      consumed++;
      continue;
    }

    // Extract payload
    const payload = buf.slice(consumed + 5, consumed + 5 + payloadLen);
    const payloadHex = payload.map(b => b.toString(16).padStart(2, '0')).join(' ');
    const rawHex = buf.slice(consumed, frameEnd).map(b => b.toString(16).padStart(2, '0')).join(' ');

    // Decode the frame — only emit LoRa frames to frontend (sensor data = 200+ fps noise)
    const frame = decodeFrame(cmdId, payload, direction, rawHex);
    if (frame.category && LORA_CATEGORY_SET.has(frame.category)) {
      emitFrame(frame);
    }

    consumed = frameEnd;
  }

  // Remove consumed bytes from buffer
  if (consumed > 0) {
    buf.splice(0, consumed);
  }
}

// ── Frame Decoding ──────────────────────────────────────────────────────────

function decodeFrame(cmdId: number, payload: number[], direction: 'read' | 'write', raw: string): SerialFrame {
  const frame: SerialFrame = {
    timestamp: Date.now(),
    cmdId,
    payloadHex: payload.map(b => b.toString(16).padStart(2, '0')).join(' '),
    direction,
    raw,
  };

  // LoRa packets have cmdId 0x0003 (charger→mower) or 0x0001 (mower→charger)
  // and the first payload byte is the category (0x30-0x36)
  if (payload.length > 0) {
    const firstByte = payload[0];
    if (firstByte >= 0x30 && firstByte <= 0x36) {
      frame.category = LORA_CATEGORIES[firstByte] ?? `UNKNOWN_0x${firstByte.toString(16)}`;
      frame.decoded = decodeLoraPayload(firstByte, payload.slice(1));

      // Update stats
      stats.loraFrames++;

      if (firstByte === 0x34) {
        // REPORT (heartbeat/status)
        stats.heartbeats++;
        stats.lastHeartbeat = Date.now();
      } else if (firstByte === 0x31) {
        // RTK_RELAY
        stats.rtkSentences++;
        stats.lastRtk = Date.now();
      }
    }
  }

  // Categorize non-LoRa frames by cmdId and first payload byte
  if (!frame.category) {
    if (cmdId === 0x07FF) {
      frame.category = 'PIN';
    } else if (cmdId === 0x0020) {
      frame.category = 'MCU_STATUS';
    } else if (cmdId === 0x0001 && payload.length > 0) {
      // MCU→ROS messages on cmdId 0x0001 — categorize by first byte
      const sub = payload[0];
      if (sub === 0x09) {
        frame.category = 'IMU';
        frame.decoded = { type: 'accelerometer/gyro' };
      } else if (sub === 0x03) {
        frame.category = 'SENSOR';
        frame.decoded = { type: 'sensor_data' };
      } else if (sub === 0x13) {
        frame.category = 'BATTERY';
        frame.decoded = { type: 'power_status' };
      } else {
        frame.category = 'MCU_DATA';
        frame.decoded = { subCmd: `0x${sub.toString(16).padStart(2, '0')}` };
      }
    } else if (cmdId === 0x0003) {
      // ROS→MCU messages
      frame.category = 'MCU_CMD';
    }
  }

  stats.totalFrames++;
  trackFrameRate();

  return frame;
}

function decodeLoraPayload(category: number, data: number[]): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};

  switch (category) {
    case 0x34: {
      // REPORT
      if (data.length === 0) break;
      const subCmd = data[0];
      decoded.subCommand = subCmd === 0x01 ? 'heartbeat_poll' : subCmd === 0x02 ? 'mower_status' : `0x${subCmd.toString(16)}`;

      if (subCmd === 0x02 && data.length >= 20) {
        // Mower status report (19 bytes after subcmd)
        const statusBytes = data.slice(1);
        decoded.mower_status = readUint32LE(statusBytes, 0);
        decoded.mower_info = readUint32LE(statusBytes, 4);
        decoded.mower_x = readUint24LE(statusBytes, 8);
        decoded.mower_y = readUint24LE(statusBytes, 11);
        decoded.mower_z = readUint24LE(statusBytes, 14);
        decoded.mower_info1 = readUint16LE(statusBytes, 17);
      }
      break;
    }

    case 0x31: {
      // RTK_RELAY — NMEA sentence
      try {
        const nmea = Buffer.from(data).toString('ascii');
        decoded.nmea = nmea.replace(/\0/g, '').trim();
      } catch {
        decoded.nmea = '(parse error)';
      }
      break;
    }

    case 0x33: {
      // GPS position
      if (data.length >= 16) {
        // lat (8 bytes double LE) + lon (8 bytes double LE)
        const buf = Buffer.from(data);
        decoded.latitude = buf.readDoubleLE(0);
        decoded.longitude = buf.readDoubleLE(8);
      }
      break;
    }

    case 0x35: {
      // ORDER
      if (data.length > 0) {
        decoded.command = ORDER_SUBCMDS[data[0]] ?? `0x${data[0].toString(16)}`;
      }
      break;
    }

    case 0x36: {
      // SCAN_CHANNEL
      decoded.type = 'channel_scan';
      break;
    }

    case 0x30: {
      // CHARGER — hall/IRQ ACK
      decoded.type = 'charger_ack';
      break;
    }

    case 0x32: {
      // CONFIG
      decoded.type = 'config';
      break;
    }
  }

  return decoded;
}

// ── Helper functions ────────────────────────────────────────────────────────

function readUint32LE(bytes: number[], offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readUint24LE(bytes: number[], offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint16LE(bytes: number[], offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function resetStats(host: string): SerialStats {
  return {
    connected: false,
    host,
    heartbeats: 0,
    lastHeartbeat: null,
    rtkSentences: 0,
    lastRtk: null,
    totalFrames: 0,
    loraFrames: 0,
    framesPerSec: 0,
  };
}

function trackFrameRate(): void {
  const now = Date.now();
  frameCountWindow.push(now);
  // Keep last 5 seconds
  frameCountWindow = frameCountWindow.filter(t => now - t < 5000);
  stats.framesPerSec = Math.round(frameCountWindow.length / 5);
}

// ── Event emitters ──────────────────────────────────────────────────────────

function emitFrame(frame: SerialFrame): void {
  for (const listener of frameListeners) {
    listener(frame);
  }
}

function emitStatus(status: { connected: boolean; host: string; error?: string }): void {
  stats.connected = status.connected;
  for (const listener of statusListeners) {
    listener(status);
  }
}

// Stats emit interval — sends stats every 2 seconds
let statsInterval: ReturnType<typeof setInterval> | null = null;

export function startStatsEmitter(): void {
  if (statsInterval) return;
  statsInterval = setInterval(() => {
    for (const listener of statsListeners) {
      listener({ ...stats });
    }
  }, 2000);
}

export function stopStatsEmitter(): void {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}
