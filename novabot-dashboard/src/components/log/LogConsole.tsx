import { useEffect, useRef, useState } from 'react';
import { Terminal, Pause, Play, Filter, Bluetooth } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MqttLogEntry, BleLogEntry } from '../../types';

interface Props {
  logs: MqttLogEntry[];
  bleLogs?: BleLogEntry[];
}

type LogTab = 'mqtt' | 'ble';

// ── MQTT styling ─────────────────────────────────────────────────

const MQTT_TYPE_COLORS: Record<MqttLogEntry['type'], string> = {
  connect: 'text-green-400',
  disconnect: 'text-red-400',
  subscribe: 'text-blue-400',
  publish: 'text-yellow-300',
  error: 'text-red-500',
};

const MQTT_TYPE_LABELS: Record<MqttLogEntry['type'], string> = {
  connect: 'CONN',
  disconnect: 'DISC',
  subscribe: 'SUB',
  publish: 'PUB',
  error: 'ERR',
};

const DIR_COLORS: Record<string, string> = {
  '\u2192DEV': 'text-cyan-400',
  '\u2190DEV': 'text-orange-400',
};

type DeviceSource = 'mower' | 'charger' | 'app' | 'unknown';

const SOURCE_STYLES: Record<DeviceSource, { border: string; bg: string; snColor: string }> = {
  mower:   { border: 'border-l-2 border-l-emerald-500', bg: 'bg-emerald-950/15', snColor: 'text-emerald-400' },
  charger: { border: 'border-l-2 border-l-yellow-500',  bg: 'bg-yellow-950/15',  snColor: 'text-yellow-400' },
  app:     { border: 'border-l-2 border-l-blue-500',    bg: 'bg-blue-950/15',    snColor: 'text-blue-400' },
  unknown: { border: 'border-l-2 border-l-gray-700',    bg: '',                   snColor: 'text-gray-500' },
};

// ── BLE styling ──────────────────────────────────────────────────

const BLE_TYPE_COLORS: Record<BleLogEntry['type'], string> = {
  advertisement: 'text-blue-400',
  connect: 'text-green-400',
  disconnect: 'text-red-400',
  write: 'text-cyan-400',
  notify: 'text-orange-400',
  read: 'text-purple-400',
  error: 'text-red-500',
};

const BLE_TYPE_LABELS: Record<BleLogEntry['type'], string> = {
  advertisement: 'ADV',
  connect: 'CONN',
  disconnect: 'DISC',
  write: 'WR',
  notify: 'NTF',
  read: 'RD',
  error: 'ERR',
};

// ── Helpers ──────────────────────────────────────────────────────

function getMqttSource(entry: MqttLogEntry): DeviceSource {
  if (entry.sn?.startsWith('LFIN')) return 'mower';
  if (entry.sn?.startsWith('LFIC')) return 'charger';
  if (entry.clientType === 'APP') return 'app';
  if (entry.topic) {
    const topicSn = entry.topic.split('/').pop() ?? '';
    if (topicSn.startsWith('LFIN')) return 'mower';
    if (topicSn.startsWith('LFIC')) return 'charger';
  }
  if (entry.clientType === 'DEV') {
    if (entry.clientId.startsWith('LFIN')) return 'mower';
    if (entry.clientId.startsWith('LFIC') || entry.clientId.startsWith('ESP32_')) return 'charger';
  }
  return 'unknown';
}

function getBleSource(entry: BleLogEntry): DeviceSource {
  const name = entry.deviceName.toLowerCase();
  if (name.startsWith('novabot')) return 'mower';
  if (name.startsWith('charger')) return 'charger';
  return 'unknown';
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('nl-NL', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen) + '...';
}

export function LogConsole({ logs, bleLogs = [] }: Props) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [tab, setTab] = useState<LogTab>('mqtt');

  const activeLogs = tab === 'mqtt' ? logs : bleLogs;

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeLogs.length, autoScroll]);

  // Reset expanded when switching tabs
  useEffect(() => { setExpanded(null); }, [tab]);

  const filteredMqtt = filter
    ? logs.filter(l => {
        const q = filter.toLowerCase();
        return l.clientId.toLowerCase().includes(q)
          || (l.sn?.toLowerCase().includes(q) ?? false)
          || l.topic.toLowerCase().includes(q)
          || l.payload.toLowerCase().includes(q)
          || l.type.includes(q);
      })
    : logs;

  const filteredBle = filter
    ? bleLogs.filter(l => {
        const q = filter.toLowerCase();
        return l.deviceName.toLowerCase().includes(q)
          || l.mac.toLowerCase().includes(q)
          || (l.data?.toLowerCase().includes(q) ?? false)
          || (l.service?.toLowerCase().includes(q) ?? false)
          || (l.characteristic?.toLowerCase().includes(q) ?? false)
          || l.type.includes(q);
      })
    : bleLogs;

  const filtered = tab === 'mqtt' ? filteredMqtt : filteredBle;
  const totalActive = tab === 'mqtt' ? logs.length : bleLogs.length;

  const handleWheel = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-700 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          {/* Tab buttons */}
          <button
            onClick={() => setTab('mqtt')}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors ${
              tab === 'mqtt' ? 'bg-green-900/40 text-green-400' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            MQTT
            <span className="text-[10px] font-mono ml-0.5">{filteredMqtt.length}</span>
          </button>
          <button
            onClick={() => setTab('ble')}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors ${
              tab === 'ble' ? 'bg-blue-900/40 text-blue-400' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <Bluetooth className="w-3.5 h-3.5" />
            BLE
            <span className="text-[10px] font-mono ml-0.5">{filteredBle.length}</span>
          </button>
        </div>
        <div className="flex items-center gap-2">
          {/* Legend (MQTT) */}
          {tab === 'mqtt' && (
            <div className="hidden sm:flex items-center gap-2 mr-2">
              <span className="flex items-center gap-1 text-[9px]">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                <span className="text-gray-500">{t('sidebar.mower')}</span>
              </span>
              <span className="flex items-center gap-1 text-[9px]">
                <span className="w-2 h-2 rounded-full bg-yellow-500" />
                <span className="text-gray-500">{t('sidebar.charger')}</span>
              </span>
              <span className="flex items-center gap-1 text-[9px]">
                <span className="w-2 h-2 rounded-full bg-blue-500" />
                <span className="text-gray-500">App</span>
              </span>
            </div>
          )}
          {/* Legend (BLE) */}
          {tab === 'ble' && (
            <div className="hidden sm:flex items-center gap-2 mr-2">
              <span className="flex items-center gap-1 text-[9px]">
                <span className="w-2 h-2 rounded-full bg-blue-400" />
                <span className="text-gray-500">ADV</span>
              </span>
              <span className="flex items-center gap-1 text-[9px]">
                <span className="w-2 h-2 rounded-full bg-cyan-400" />
                <span className="text-gray-500">GATT</span>
              </span>
            </div>
          )}
          <div className="relative">
            <Filter className="w-3 h-3 text-gray-500 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={t('log.filter')}
              className="bg-gray-800 text-xs text-gray-300 rounded pl-6 pr-2 py-0.5 w-32 border border-gray-700 focus:border-gray-500 focus:outline-none"
            />
          </div>
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`p-1 rounded transition-colors ${autoScroll ? 'text-green-400 bg-green-900/30' : 'text-gray-500 hover:text-gray-300'}`}
            title={autoScroll ? t('log.autoScrollOn') : t('log.autoScrollOff')}
          >
            {autoScroll ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Log entries */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto font-mono text-[11px] leading-relaxed"
        onWheel={handleWheel}
      >
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-600 text-xs">
            {totalActive === 0
              ? (tab === 'mqtt' ? t('log.waiting') : 'Waiting for BLE activity...')
              : t('log.noMatches')
            }
          </div>
        ) : tab === 'mqtt' ? (
          /* ── MQTT entries ─────────────────────────────────── */
          (filteredMqtt as MqttLogEntry[]).map((entry, i) => {
            const isExpanded = expanded === i;
            const hasLongPayload = entry.payload.length > 120;
            const source = getMqttSource(entry);
            const style = SOURCE_STYLES[source];
            return (
              <div
                key={`m-${entry.ts}-${i}`}
                className={`px-3 py-0.5 hover:bg-gray-800/50 border-b border-gray-800/30 ${style.border} ${style.bg} ${
                  entry.type === 'error' ? 'bg-red-950/20' : ''
                }`}
                onClick={() => hasLongPayload && setExpanded(isExpanded ? null : i)}
                style={hasLongPayload ? { cursor: 'pointer' } : undefined}
              >
                <span className="text-gray-600">{formatTime(entry.ts)}</span>
                {' '}
                <span className={`font-bold ${MQTT_TYPE_COLORS[entry.type]}`}>
                  {MQTT_TYPE_LABELS[entry.type]}
                </span>
                {' '}
                {entry.direction && (
                  <>
                    <span className={DIR_COLORS[entry.direction] ?? 'text-gray-500'}>
                      {entry.direction}
                    </span>
                    {' '}
                  </>
                )}
                <span className="text-gray-500">{entry.clientId}</span>
                {entry.sn && (
                  <>
                    {' '}
                    <span className={style.snColor + ' font-semibold'}>
                      {entry.sn}
                    </span>
                  </>
                )}
                {entry.topic && (
                  <>
                    {' '}
                    <span className="text-purple-400">{entry.topic}</span>
                  </>
                )}
                {entry.encrypted && (
                  <span className="text-cyan-600 ml-1">[AES]</span>
                )}
                {entry.payload && (
                  <>
                    {' '}
                    <span className="text-gray-400">
                      {isExpanded ? entry.payload : truncate(entry.payload, 120)}
                    </span>
                  </>
                )}
              </div>
            );
          })
        ) : (
          /* ── BLE entries ──────────────────────────────────── */
          (filteredBle as BleLogEntry[]).map((entry, i) => {
            const isExpanded = expanded === i;
            const hasLongData = (entry.data?.length ?? 0) > 80;
            const source = getBleSource(entry);
            const style = SOURCE_STYLES[source];
            return (
              <div
                key={`b-${entry.ts}-${i}`}
                className={`px-3 py-0.5 hover:bg-gray-800/50 border-b border-gray-800/30 ${style.border} ${style.bg} ${
                  entry.type === 'error' ? 'bg-red-950/20' : ''
                }`}
                onClick={() => hasLongData && setExpanded(isExpanded ? null : i)}
                style={hasLongData ? { cursor: 'pointer' } : undefined}
              >
                <span className="text-gray-600">{formatTime(entry.ts)}</span>
                {' '}
                <span className={`font-bold ${BLE_TYPE_COLORS[entry.type]}`}>
                  {BLE_TYPE_LABELS[entry.type]}
                </span>
                {' '}
                {entry.direction && (
                  <>
                    <span className={DIR_COLORS[entry.direction] ?? 'text-gray-500'}>
                      {entry.direction}
                    </span>
                    {' '}
                  </>
                )}
                <span className={style.snColor + ' font-semibold'}>
                  {entry.deviceName}
                </span>
                {' '}
                <span className="text-gray-500">{entry.mac}</span>
                {entry.rssi !== 0 && (
                  <span className={`ml-1 ${
                    Math.abs(entry.rssi) < 60 ? 'text-green-500' : Math.abs(entry.rssi) < 80 ? 'text-yellow-500' : 'text-red-500'
                  }`}>
                    {entry.rssi}dBm
                  </span>
                )}
                {entry.service && (
                  <>
                    {' '}
                    <span className="text-purple-400">svc:{entry.service}</span>
                  </>
                )}
                {entry.characteristic && (
                  <>
                    {' '}
                    <span className="text-purple-300">chr:{entry.characteristic}</span>
                  </>
                )}
                {entry.data && (
                  <>
                    {' '}
                    <span className="text-gray-400">
                      {isExpanded ? entry.data : truncate(entry.data, 80)}
                    </span>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
