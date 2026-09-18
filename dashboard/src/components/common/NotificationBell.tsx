/**
 * NotificationBell — the dashboard's feed of mower events.
 *
 * The server has detected these events all along (docked, mowing_finished,
 * low_battery, stuck, …) and pushed them to the mobile app, to ntfy and to Home
 * Assistant. The dashboard received none of them: its Settings panel said
 * "coming soon" while the events were already flowing past. This surfaces the
 * same objects, live over socket.io plus the backlog from GET /api/events/:sn.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Bell, BatteryLow, CheckCircle2, Home, AlertTriangle, ShieldAlert, Lock,
  WifiOff, Satellite, Map as MapIcon, Cpu, Play, XCircle, type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MowerEvent, MowerEventType } from '../../types';
import { fetchMowerEvents } from '../../api/client';

/** Icon + tint per event type. Severity drives the colour, not the wording. */
const META: Record<MowerEventType, { icon: LucideIcon; tone: string }> = {
  docked: { icon: Home, tone: 'text-emerald-400' },
  mowing_finished: { icon: CheckCircle2, tone: 'text-emerald-400' },
  mowing_started: { icon: Play, tone: 'text-sky-400' },
  error_cleared: { icon: CheckCircle2, tone: 'text-emerald-400' },
  low_battery: { icon: BatteryLow, tone: 'text-amber-400' },
  gps_weak: { icon: Satellite, tone: 'text-amber-400' },
  connection_lost: { icon: WifiOff, tone: 'text-amber-400' },
  dock_failed: { icon: XCircle, tone: 'text-red-400' },
  stuck: { icon: AlertTriangle, tone: 'text-red-400' },
  safety: { icon: ShieldAlert, tone: 'text-red-400' },
  pin_locked: { icon: Lock, tone: 'text-red-400' },
  map_error: { icon: MapIcon, tone: 'text-red-400' },
  initialization_error: { icon: Cpu, tone: 'text-red-400' },
  hardware_fault: { icon: Cpu, tone: 'text-red-400' },
  error: { icon: AlertTriangle, tone: 'text-red-400' },
  dock_drift: { icon: Home, tone: 'text-amber-400' },
  firmware_required: { icon: ShieldAlert, tone: 'text-red-400' },
};

function relative(ts: number, t: (k: string, d: string) => string): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return t('events.justNow', 'zojuist');
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} u`;
  return new Date(ts).toLocaleDateString();
}

interface Props {
  sn: string | null;
  /** Live events from the socket, newest first. */
  events: MowerEvent[];
  /** Feed the fetched backlog back into the shared list. */
  onBacklog: (e: MowerEvent) => void;
}

export function NotificationBell({ sn, events, onBacklog }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Only events newer than this count as unread. Seeded at mount so the
  // backlog does not light the bell up on every page load.
  const [seenTs, setSeenTs] = useState(() => {
    const raw = localStorage.getItem('events:seenTs');
    return raw ? Number(raw) || 0 : Date.now();
  });
  const fetchedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!sn || fetchedFor.current === sn) return;
    fetchedFor.current = sn;
    fetchMowerEvents(sn, 50).then(list => list.forEach(onBacklog)).catch(() => {});
  }, [sn, onBacklog]);

  const visible = sn ? events.filter(e => e.sn === sn) : events;
  const unread = visible.filter(e => e.ts > seenTs).length;

  const markSeen = () => {
    const ts = Date.now();
    setSeenTs(ts);
    try { localStorage.setItem('events:seenTs', String(ts)); } catch { /* private window */ }
  };

  return (
    <div className="relative">
      <button
        onClick={() => { setOpen(o => { if (!o) markSeen(); return !o; }); }}
        title={t('events.title', 'Meldingen')}
        aria-label={t('events.title', 'Meldingen')}
        className="relative p-1.5 rounded-lg text-gray-400 hover:text-gray-100 hover:bg-gray-800 transition-colors"
      >
        <Bell className="w-4 h-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full
                           bg-red-500 text-white text-[9px] font-bold leading-[15px] text-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* De kaartwrapper staat op z-[2000] in dezelfde stacking context; alles
              wat hieronder blijft verdwijnt achter de kaart zodra het eroverheen valt. */}
          <div className="fixed inset-0 z-[2050]" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto z-[2100]
                          rounded-xl bg-zinc-900 border border-zinc-700 shadow-2xl">
            <div className="px-3 py-2 border-b border-zinc-800 text-xs font-semibold text-zinc-400">
              {t('events.title', 'Meldingen')}
            </div>
            {visible.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-zinc-500">
                {t('events.empty', 'Nog geen meldingen')}
              </div>
            ) : (
              visible.map(e => {
                const meta = META[e.type] ?? META.error;
                const Icon = meta.icon;
                return (
                  <div key={`${e.sn}-${e.type}-${e.ts}`}
                       className="px-3 py-2 border-b border-zinc-800/60 last:border-0 flex gap-2.5">
                    <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${meta.tone}`} />
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-zinc-200">{e.title}</div>
                      <div className="text-[11px] text-zinc-400 break-words">{e.message}</div>
                      <div className="text-[10px] text-zinc-600 mt-0.5">{relative(e.ts, t)}</div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
