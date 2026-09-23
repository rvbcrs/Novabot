import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X, Move, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchSystemLogs, type SystemLogEntry } from '../../api/client';

// ── Per-device line classification + colours (mirrors the admin console) ─────
type LogClass = 'mower' | 'charger' | 'app' | 'http' | 'system';
type LogGroup = 'mower' | 'charger' | 'rest';

const LOG_COLORS: Record<LogClass, string> = {
  mower: '#22c55e',    // green
  charger: '#eab308',  // yellow
  app: '#3b82f6',      // blue
  http: '#c084fc',     // purple
  system: '#6b7280',   // gray
};

function classifyLog(l: SystemLogEntry): LogClass {
  const t = l.type || '';
  if (t === 'http-req' || t === 'http-res') return 'http';
  const cid = (l.clientId || '') + (l.sn || '') + (l.topic || '');
  if (cid.includes('LFIN')) return 'mower';
  if (cid.includes('LFIC') || cid.includes('ESP32')) return 'charger';
  if (l.clientType === 'APP' || cid.includes('@') || cid.includes('eyJ')) return 'app';
  return 'system';
}

function groupOf(l: SystemLogEntry): LogGroup {
  const c = classifyLog(l);
  return c === 'mower' ? 'mower' : c === 'charger' ? 'charger' : 'rest';
}

// Free-text filter — case-insensitive substring match across every visible
// field of a log line (type, client, SN, direction, topic, payload). Mirrors
// the admin console's search box.
function matchesQuery(l: SystemLogEntry, q: string): boolean {
  if (!q) return true;
  const hay = [l.type, l.clientId, l.clientType, l.sn, l.direction, l.topic, l.payload]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q.toLowerCase());
}

function typeIcon(type: string): string {
  switch (type) {
    case 'connect': return '🔌';
    case 'disconnect': return '🔴';
    case 'subscribe': return '📡';
    case 'publish': return '📨';
    case 'forward': return '➡️';
    case 'http-req': return '🌐';
    case 'http-res': return '↩️';
    case 'error': return '❌';
    default: return '·';
  }
}

function abbrevTopic(topic: string): string {
  return (topic || '')
    .replace('Dart/Receive_mqtt/', '←')
    .replace('Dart/Send_mqtt/', '→')
    .replace('Dart/Receive_server_mqtt/', '⇐');
}

function LogLine({ l, big }: { l: SystemLogEntry; big?: boolean }) {
  const cls = classifyLog(l);
  const color = LOG_COLORS[cls];
  const time = new Date(l.ts).toLocaleTimeString(undefined, { hour12: false });
  const topic = abbrevTopic(l.topic);
  const max = big ? 400 : 90;
  const payload = l.payload && l.payload.length > max ? l.payload.slice(0, max) + '…' : l.payload;
  return (
    <div className="py-0.5 border-b border-zinc-900/60 last:border-b-0 leading-snug break-all" style={{ color }}>
      <span className="text-zinc-600">{time}</span>{' '}
      <span>{typeIcon(l.type)}</span>{' '}
      <span className="font-bold">{(l.type || '').toUpperCase()}</span>{' '}
      {l.sn && <span style={{ opacity: 0.7 }}>{l.sn}</span>}{' '}
      {l.direction && <span className="text-zinc-500">{l.direction}</span>}{' '}
      {topic && <span className="text-zinc-500">{topic}</span>}{' '}
      {payload && <span style={{ opacity: 0.6 }}>{payload}</span>}
    </div>
  );
}

// Device-class filter — Mower / Charger / Rest toggle chips (like the admin's
// Mower/Charger checkboxes). Click to hide/show that group.
const GROUP_META: Array<{ key: LogGroup; labelKey: string; fallback: string; color: string }> = [
  { key: 'mower', labelKey: 'drawer.logs.mower', fallback: 'Mower', color: LOG_COLORS.mower },
  { key: 'charger', labelKey: 'drawer.logs.charger', fallback: 'Charger', color: LOG_COLORS.charger },
  { key: 'rest', labelKey: 'drawer.logs.rest', fallback: 'Rest', color: LOG_COLORS.system },
];

function ClassFilter({ enabled, onToggle }: { enabled: Record<LogGroup, boolean>; onToggle: (g: LogGroup) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1.5">
      {GROUP_META.map(g => (
        <button
          key={g.key}
          onClick={() => onToggle(g.key)}
          className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
            enabled[g.key] ? 'border-zinc-700 text-zinc-300' : 'border-transparent text-zinc-600 opacity-50'
          }`}
        >
          <span className="w-2 h-2 rounded-full" style={{ background: g.color, opacity: enabled[g.key] ? 1 : 0.4 }} />
          {t(g.labelKey, g.fallback)}
        </button>
      ))}
    </div>
  );
}

// Labeled auto-scroll checkbox (mirrors the admin console's "Auto-scroll").
function AutoScrollCheck({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <label className="inline-flex items-center gap-1.5 text-[10px] text-zinc-400 cursor-pointer select-none whitespace-nowrap">
      <input
        type="checkbox"
        checked={on}
        onChange={onToggle}
        className="accent-emerald-500 w-3 h-3 cursor-pointer"
      />
      {t('drawer.logs.autoScroll', 'Auto-scroll')}
    </label>
  );
}

// Free-text filter box (mirrors the admin console's search bar).
function LogSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="relative">
      <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={t('drawer.logs.search', 'Filter (e.g. start_run, error, LFIN)')}
        className="w-full bg-zinc-950 border border-zinc-800 rounded pl-7 pr-2 py-1 text-[11px] text-zinc-300 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
      />
    </div>
  );
}

function LogList({ logs, big, autoScroll }: { logs: SystemLogEntry[]; big?: boolean; autoScroll: boolean }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  // Stick to the newest line while auto-scroll is on.
  useEffect(() => {
    if (autoScroll && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs, autoScroll]);
  return (
    <div
      ref={ref}
      className={big
        ? 'flex-1 min-h-0 overflow-y-auto p-3 font-mono text-[11px] text-zinc-400 bg-zinc-950'
        : 'mt-1.5 bg-zinc-950 rounded border border-zinc-800 max-h-72 overflow-y-auto p-2 font-mono text-[10px] text-zinc-400'}
    >
      {logs.length === 0 ? (
        <p className="text-zinc-600 italic">{t('drawer.logs.empty')}</p>
      ) : logs.map((l, i) => <LogLine key={`${l.ts}-${i}`} l={l} big={big} />)}
    </div>
  );
}

// Shared poller — fetches all types while `active`; device-class filtering is
// client-side so toggling a group is instant.
function useServerLogs(tail: number, active: boolean) {
  const [logs, setLogs] = useState<SystemLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    async function load() {
      try {
        const fresh = await fetchSystemLogs({ tail });
        if (!cancelled) { setLogs(fresh); setError(null); }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    load();
    const id = setInterval(load, 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [tail, active]);
  return { logs, error };
}

const ALL_GROUPS: Record<LogGroup, boolean> = { mower: true, charger: true, rest: true };

// ── Inline tail (lives in the diagnostics drawer) ────────────────────────────
// Hidden body while the floating window is open so the log isn't shown twice.

export function ServerLogTail({ enlarged, onEnlarge }: { enlarged: boolean; onEnlarge: () => void }) {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<Record<LogGroup, boolean>>(ALL_GROUPS);
  const [autoScroll, setAutoScroll] = useState(true);
  const [query, setQuery] = useState('');
  const { logs, error } = useServerLogs(200, !enlarged);
  const shown = logs.filter(l => groups[groupOf(l)] && matchesQuery(l, query));
  const toggle = (g: LogGroup) => setGroups(prev => ({ ...prev, [g]: !prev[g] }));

  return (
    <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3">
      <div className="flex items-center justify-between mb-2 gap-2">
        <h3 className="text-xs font-semibold text-zinc-300">{t('drawer.logs.title')}</h3>
        <button
          onClick={onEnlarge}
          title={t('drawer.logs.enlarge', 'Enlarge')}
          className="grid place-items-center w-6 h-6 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {enlarged ? (
        <p className="text-[11px] text-zinc-500 italic">{t('drawer.logs.floatingOpen', 'Opened in a floating window.')}</p>
      ) : (
        <>
          {error && <p className="text-xs text-red-400 mb-2">{t('common.failed')}: {error}</p>}
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <ClassFilter enabled={groups} onToggle={toggle} />
            <AutoScrollCheck on={autoScroll} onToggle={() => setAutoScroll(v => !v)} />
          </div>
          <LogSearch value={query} onChange={setQuery} />
          <LogList logs={shown} autoScroll={autoScroll} />
        </>
      )}
    </div>
  );
}

// ── Floating, draggable + resizable log window (lifted to the shell so it
// survives the drawer closing; only its own ✕ closes it) ─────────────────────

export function FloatingServerLog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<Record<LogGroup, boolean>>(ALL_GROUPS);
  const [autoScroll, setAutoScroll] = useState(true);
  const [query, setQuery] = useState('');
  const { logs, error } = useServerLogs(500, open);
  const shown = logs.filter(l => groups[groupOf(l)] && matchesQuery(l, query));
  const toggle = (g: LogGroup) => setGroups(prev => ({ ...prev, [g]: !prev[g] }));

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Position (px, fixed) — draggable from the header, persistent.
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      const s = localStorage.getItem('novabot.logPanelPos');
      if (s) return JSON.parse(s) as { x: number; y: number };
    } catch { /* ignore */ }
    const w = typeof window !== 'undefined' ? window.innerWidth : 1024;
    return { x: Math.max(16, Math.round(w / 2 - 360)), y: 72 };
  });
  useEffect(() => {
    try { localStorage.setItem('novabot.logPanelPos', JSON.stringify(pos)); } catch { /* ignore */ }
  }, [pos]);
  const dragRef = useRef<{ ox: number; oy: number } | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPos({
        x: Math.min(Math.max(0, e.clientX - d.ox), window.innerWidth - 120),
        y: Math.min(Math.max(0, e.clientY - d.oy), window.innerHeight - 40),
      });
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  // Resizable box: restore + persist size on every resize (drag the corner).
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const el = boxRef.current;
    if (!el) return;
    try {
      const saved = localStorage.getItem('novabot.logPanelSize');
      if (saved) {
        const { w, h } = JSON.parse(saved) as { w?: number; h?: number };
        if (w) el.style.width = `${w}px`;
        if (h) el.style.height = `${h}px`;
      }
    } catch { /* ignore */ }
    const ro = new ResizeObserver(() => {
      try { localStorage.setItem('novabot.logPanelSize', JSON.stringify({ w: el.offsetWidth, h: el.offsetHeight })); } catch { /* ignore */ }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      ref={boxRef}
      className="fixed z-[10000] flex flex-col bg-zinc-900/97 backdrop-blur border border-zinc-700 rounded-2xl shadow-2xl overflow-hidden"
      style={{
        left: pos.x, top: pos.y,
        width: 720, height: 460,
        minWidth: 340, minHeight: 200, maxWidth: '96vw', maxHeight: '90vh',
        resize: 'both',
      }}
    >
      <div
        className="flex items-center justify-between gap-3 px-3 py-2 border-b border-zinc-800 cursor-move select-none"
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest('button,select')) return;
          dragRef.current = { ox: e.clientX - pos.x, oy: e.clientY - pos.y };
          e.preventDefault();
        }}
        title={t('drawer.logs.dragHint', 'Sleep om te verplaatsen — sleep de hoek om te vergroten')}
      >
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <Move className="w-4 h-4 text-emerald-400 shrink-0" />
          {t('drawer.logs.title')}
        </span>
        <div className="flex items-center gap-2.5">
          <ClassFilter enabled={groups} onToggle={toggle} />
          <AutoScrollCheck on={autoScroll} onToggle={() => setAutoScroll(v => !v)} />
          <button
            onClick={onClose}
            title={t('common.close', 'Close')}
            className="grid place-items-center w-7 h-7 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-zinc-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="px-3 py-2 border-b border-zinc-800 shrink-0">
        <LogSearch value={query} onChange={setQuery} />
      </div>
      {error && <p className="text-xs text-red-400 px-3 pt-2">{t('common.failed')}: {error}</p>}
      <LogList logs={shown} autoScroll={autoScroll} big />
    </div>,
    document.body,
  );
}
