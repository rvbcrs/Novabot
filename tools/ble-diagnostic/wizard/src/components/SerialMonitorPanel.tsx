import { useState, useEffect, useRef, useCallback } from 'react';
import { useT } from '../i18n';
import { io, Socket } from 'socket.io-client';

interface SerialFrame {
  timestamp: number;
  cmdId: number;
  payloadHex: string;
  category?: string;
  decoded?: Record<string, unknown>;
  direction: 'read' | 'write';
  raw: string;
}

interface SerialStats {
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

type Filter = 'all' | 'lora' | 'rtk' | 'heartbeat' | 'sensor';

const MAX_FRAMES = 200;

export default function SerialMonitorPanel() {
  const { t } = useT();
  const [host, setHost] = useState('192.168.0.244');
  const [password, setPassword] = useState('novabot');
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<SerialStats | null>(null);
  const [frames, setFrames] = useState<SerialFrame[]>([]);
  const [filter, setFilter] = useState<Filter>('lora');
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io({ transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('serial:frame', (frame: SerialFrame) => {
      setFrames(prev => {
        const next = [...prev, frame];
        return next.length > MAX_FRAMES ? next.slice(-MAX_FRAMES) : next;
      });
    });

    socket.on('serial:stats', (s: SerialStats) => {
      setStats(s);
    });

    socket.on('serial:status', (status: { connected: boolean; host: string; error?: string }) => {
      setConnected(status.connected);
      if (status.error) setError(status.error);
    });

    // Check initial status
    fetch('/api/serial/status')
      .then(r => r.json())
      .then(data => {
        setConnected(data.connected);
        if (data.stats) setStats(data.stats);
      })
      .catch(() => {});

    return () => { socket.disconnect(); };
  }, []);

  // Auto-scroll log
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [frames, autoScroll]);

  const connectSerial = async () => {
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch('/api/serial/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, password }),
      });
      const data = await res.json();
      if (data.ok) {
        setConnected(true);
      } else {
        setError(data.error || 'Connection failed');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setConnecting(false);
    }
  };

  const disconnectSerial = async () => {
    await fetch('/api/serial/disconnect', { method: 'POST' });
    setConnected(false);
    setFrames([]);
  };

  const clearLog = useCallback(() => setFrames([]), []);

  const LORA_CATS = new Set(['REPORT', 'RTK_RELAY', 'GPS', 'ORDER', 'CONFIG', 'CHARGER', 'SCAN_CHANNEL']);
  const SENSOR_CATS = new Set(['IMU', 'SENSOR', 'BATTERY', 'MCU_DATA', 'MCU_CMD', 'MCU_STATUS']);

  const filteredFrames = frames.filter(f => {
    if (filter === 'all') return true;
    if (filter === 'lora') return f.category != null && LORA_CATS.has(f.category);
    if (filter === 'rtk') return f.category === 'RTK_RELAY';
    if (filter === 'heartbeat') return f.category === 'REPORT';
    if (filter === 'sensor') return f.category != null && SENSOR_CATS.has(f.category);
    return true;
  });

  const timeSince = (ts: number | null) => {
    if (!ts) return '—';
    const diff = (Date.now() - ts) / 1000;
    if (diff < 1) return '<1s';
    if (diff < 60) return `${Math.floor(diff)}s`;
    return `${Math.floor(diff / 60)}m ${Math.floor(diff % 60)}s`;
  };

  const formatFrame = (frame: SerialFrame): string => {
    const time = new Date(frame.timestamp).toLocaleTimeString('en-GB', { hour12: false });
    const dir = frame.direction === 'read' ? '<<<' : '>>>';
    const cat = frame.category ?? `CMD:0x${frame.cmdId.toString(16).padStart(4, '0')}`;

    let detail = '';
    if (frame.decoded) {
      const d = frame.decoded;
      if (d.subCommand) detail += ` ${d.subCommand}`;
      if (d.nmea) detail += ` ${(d.nmea as string).substring(0, 60)}`;
      if (d.command) detail += ` ${d.command}`;
      if (d.mower_status !== undefined) detail += ` status=0x${(d.mower_status as number).toString(16)}`;
      if (d.latitude !== undefined) detail += ` lat=${d.latitude} lon=${d.longitude}`;
    }

    return `${time} ${dir} [${cat}]${detail}`;
  };

  const getCategoryColor = (cat?: string): string => {
    switch (cat) {
      case 'REPORT': return 'text-yellow-400';
      case 'RTK_RELAY': return 'text-cyan-400';
      case 'GPS': return 'text-green-400';
      case 'ORDER': return 'text-red-400';
      case 'CONFIG': return 'text-purple-400';
      case 'CHARGER': return 'text-blue-400';
      case 'SCAN_CHANNEL': return 'text-orange-400';
      case 'IMU': return 'text-white/25';
      case 'SENSOR': return 'text-white/25';
      case 'BATTERY': return 'text-amber-400/50';
      case 'MCU_DATA': return 'text-white/20';
      case 'MCU_CMD': return 'text-white/20';
      case 'MCU_STATUS': return 'text-white/20';
      case 'PIN': return 'text-white/20';
      default: return 'text-white/40';
    }
  };

  return (
    <div className="glass-card p-4 md:p-6">
      <div className="relative z-10">
        <h3 className="text-sm font-semibold text-white/60 mb-4 flex items-center gap-2">
          <span className="text-base">🔌</span>
          {t('serial.title')}
          <span className={`status-dot ml-1 ${connected ? 'connected' : 'disconnected'}`} />
        </h3>

        {/* Connection controls */}
        <div className="flex items-center gap-2 mb-4">
          <input
            type="text"
            value={host}
            onChange={e => setHost(e.target.value)}
            placeholder="IP address"
            className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm font-mono"
            disabled={connected}
          />
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Password"
            className="w-28 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm"
            disabled={connected}
            autoComplete="off"
            data-1p-ignore
          />
          {connected ? (
            <button
              onClick={disconnectSerial}
              className="px-3 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded text-sm transition-colors"
            >
              {t('serial.disconnect')}
            </button>
          ) : (
            <button
              onClick={connectSerial}
              disabled={connecting || !host}
              className="px-3 py-1 bg-green-500/20 hover:bg-green-500/30 text-green-300 rounded text-sm transition-colors disabled:opacity-40"
            >
              {connecting ? '...' : t('serial.connect')}
            </button>
          )}
        </div>

        {error && (
          <div className="mb-3 p-2 bg-red-500/10 border border-red-500/20 rounded text-red-300 text-xs">
            {error}
          </div>
        )}

        {/* Stats bar */}
        {connected && stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <StatBox
              label={t('serial.heartbeats')}
              value={String(stats.heartbeats)}
              sub={`${t('serial.lastSeen')}: ${timeSince(stats.lastHeartbeat)}`}
              color={stats.lastHeartbeat && Date.now() - stats.lastHeartbeat < 5000 ? 'text-green-400' : 'text-red-400'}
            />
            <StatBox
              label={t('serial.rtkRelay')}
              value={String(stats.rtkSentences)}
              sub={`${t('serial.lastSeen')}: ${timeSince(stats.lastRtk)}`}
              color={stats.lastRtk && Date.now() - stats.lastRtk < 5000 ? 'text-cyan-400' : 'text-white/30'}
            />
            <StatBox
              label={t('serial.loraFrames')}
              value={String(stats.loraFrames)}
              sub={`${t('serial.total')}: ${stats.totalFrames}`}
              color="text-orange-400"
            />
            <StatBox
              label={t('serial.frameRate')}
              value={`${stats.framesPerSec}/s`}
              sub={t('serial.framesPerSecond')}
              color="text-white/60"
            />
          </div>
        )}

        {/* Filter + controls */}
        {connected && (
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs text-white/40">{t('serial.filter')}:</span>
            {(['all', 'lora', 'heartbeat', 'rtk', 'sensor'] as Filter[]).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2 py-0.5 rounded text-xs transition-colors ${
                  filter === f ? 'bg-white/15 text-white' : 'text-white/40 hover:text-white/60'
                }`}
              >
                {t(`serial.filter_${f}`)}
              </button>
            ))}
            <div className="flex-1" />
            <label className="flex items-center gap-1 text-xs text-white/40">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={e => setAutoScroll(e.target.checked)}
                className="rounded"
              />
              Auto-scroll
            </label>
            <button
              onClick={clearLog}
              className="px-2 py-0.5 text-xs text-white/40 hover:text-white/60"
            >
              {t('serial.clear')}
            </button>
          </div>
        )}

        {/* Frame log */}
        {connected && (
          <div
            ref={logRef}
            className="bg-black/30 rounded-lg p-2 h-64 overflow-y-auto font-mono text-[11px] leading-relaxed"
          >
            {filteredFrames.length === 0 ? (
              <div className="space-y-2 p-2">
                {stats && stats.totalFrames > 0 && filter === 'lora' ? (
                  <div>
                    <div className="text-red-400 font-semibold">No LoRa frames detected</div>
                    <div className="text-white/30 mt-2 text-[10px] leading-relaxed">
                      Serial link OK ({stats.totalFrames} MCU frames at {stats.framesPerSec}/s)
                      — but 0 LoRa packets from charger.
                    </div>
                    <div className="text-white/20 mt-2 text-[10px] leading-relaxed">
                      Possible causes:<br/>
                      - Charger not powered on or out of LoRa range<br/>
                      - LoRa address/channel mismatch between mower and charger<br/>
                      - Mower LoRa antenna disconnected (u.FL connector, left side PCB)<br/>
                      - Charger LoRa module fault
                    </div>
                  </div>
                ) : (
                  <span className="text-white/20">{t('serial.waitingForData')}</span>
                )}
              </div>
            ) : (
              filteredFrames.map((frame, i) => (
                <div key={i} className={getCategoryColor(frame.category)}>
                  {formatFrame(frame)}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatBox({ label, value, sub, color }: {
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <div className="panel-card text-center">
      <div className="text-[10px] text-white/40 mb-1">{label}</div>
      <div className={`text-xl font-mono font-bold ${color}`}>{value}</div>
      <div className="text-[10px] text-white/30 mt-0.5">{sub}</div>
    </div>
  );
}
