import { useEffect, useRef, useState } from 'react';
import { Terminal, Pause, Play, Trash2, Filter } from 'lucide-react';
import type { MqttLogEntry } from '../../types';

interface Props {
  logs: MqttLogEntry[];
}

const TYPE_COLORS: Record<MqttLogEntry['type'], string> = {
  connect: 'text-green-400',
  disconnect: 'text-red-400',
  subscribe: 'text-blue-400',
  publish: 'text-yellow-300',
  error: 'text-red-500',
};

const TYPE_LABELS: Record<MqttLogEntry['type'], string> = {
  connect: 'CONN',
  disconnect: 'DISC',
  subscribe: 'SUB',
  publish: 'PUB',
  error: 'ERR',
};

const DIR_COLORS: Record<string, string> = {
  '→DEV': 'text-cyan-400',
  '←DEV': 'text-orange-400',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('nl-NL', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function truncatePayload(payload: string, maxLen: number): string {
  if (payload.length <= maxLen) return payload;
  return payload.slice(0, maxLen) + '...';
}

export function LogConsole({ logs }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length, autoScroll]);

  const filtered = filter
    ? logs.filter(l => {
        const q = filter.toLowerCase();
        return l.clientId.toLowerCase().includes(q)
          || (l.sn?.toLowerCase().includes(q) ?? false)
          || l.topic.toLowerCase().includes(q)
          || l.payload.toLowerCase().includes(q)
          || l.type.includes(q);
      })
    : logs;

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-700 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-green-400" />
          <span className="text-sm text-gray-400">MQTT Log</span>
          <span className="text-[10px] text-gray-600 font-mono">{filtered.length} entries</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Filter className="w-3 h-3 text-gray-500 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter..."
              className="bg-gray-800 text-xs text-gray-300 rounded pl-6 pr-2 py-0.5 w-32 border border-gray-700 focus:border-gray-500 focus:outline-none"
            />
          </div>
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`p-1 rounded transition-colors ${autoScroll ? 'text-green-400 bg-green-900/30' : 'text-gray-500 hover:text-gray-300'}`}
            title={autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
          >
            {autoScroll ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
          </button>
        </div>
      </div>
      {/* Log entries */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto font-mono text-[11px] leading-relaxed"
        onWheel={() => {
          if (!scrollRef.current) return;
          const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
          setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
        }}
      >
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-600 text-xs">
            {logs.length === 0 ? 'Waiting for MQTT traffic...' : 'No matches'}
          </div>
        ) : (
          filtered.map((entry, i) => {
            const isExpanded = expanded === i;
            const hasLongPayload = entry.payload.length > 120;
            return (
              <div
                key={`${entry.ts}-${i}`}
                className={`px-3 py-0.5 hover:bg-gray-800/50 border-b border-gray-800/30 ${
                  entry.type === 'error' ? 'bg-red-950/20' : ''
                }`}
                onClick={() => hasLongPayload && setExpanded(isExpanded ? null : i)}
                style={hasLongPayload ? { cursor: 'pointer' } : undefined}
              >
                <span className="text-gray-600">{formatTime(entry.ts)}</span>
                {' '}
                <span className={`font-bold ${TYPE_COLORS[entry.type]}`}>
                  {TYPE_LABELS[entry.type]}
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
                    <span className={entry.sn.startsWith('LFIC') ? 'text-yellow-600' : 'text-emerald-600'}>
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
                      {isExpanded ? entry.payload : truncatePayload(entry.payload, 120)}
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
