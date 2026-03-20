import { Wifi, Satellite, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MowerDerived, MowerActivity } from '../MobilePage';
import { useTheme } from '../ThemeProvider';

// ── Colors ──────────────────────────────────────────────────────────

const RING_COLOR: Record<MowerActivity, string> = {
  idle:      '#6b7280',
  mowing:    '#10b981',
  charging:  '#3b82f6',
  returning: '#f59e0b',
  paused:    '#eab308',
  mapping:   '#a855f7',
  error:     '#ef4444',
  offline:   '#374151',
};

const ACTIVITY_BADGE: Record<MowerActivity, string> = {
  idle:      'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  mowing:    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
  charging:  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400',
  returning: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  paused:    'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400',
  mapping:   'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400',
  error:     'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
  offline:   'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
};

function batteryRingColor(pct: number): string {
  if (pct >= 60) return '#22c55e';
  if (pct >= 30) return '#eab308';
  if (pct >= 15) return '#f97316';
  return '#ef4444';
}

// ── Mini Battery Ring ───────────────────────────────────────────────

function MiniRing({ percentage, color, bgColor, size = 44 }: {
  percentage: number; color: string; bgColor: string; size?: number;
}) {
  const sw = 5;
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (percentage / 100) * c;

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={bgColor} strokeWidth={sw} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={sw}
        strokeLinecap="round" strokeDasharray={c} strokeDashoffset={offset}
        className="transition-all duration-700 ease-out" />
    </svg>
  );
}

// ── Component ───────────────────────────────────────────────────────

interface Props {
  mower: MowerDerived;
}

export function CompactStatusBar({ mower }: Props) {
  const { t } = useTranslation();
  const { resolved } = useTheme();

  const ringColor = mower.activity === 'idle' || mower.activity === 'offline'
    ? batteryRingColor(mower.battery)
    : RING_COLOR[mower.activity];

  const ringBg = resolved === 'dark' ? '#1f2937' : '#e5e7eb';

  return (
    <div className="px-4 pt-2 pb-1">
      {/* Row 1: Name + battery ring + activity badge */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${mower.online ? 'bg-emerald-400' : 'bg-gray-300 dark:bg-gray-600'}`} />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
            {mower.nickname || 'OpenNova Mower'}
          </span>
        </div>

        <div className="flex items-center gap-2.5">
          {/* Battery ring */}
          <div className="relative flex items-center justify-center" style={{ width: 44, height: 44 }}>
            <MiniRing percentage={mower.battery} color={ringColor} bgColor={ringBg} />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-[11px] font-bold tabular-nums text-gray-900 dark:text-white">
                {mower.battery}
              </span>
            </div>
            {mower.batteryCharging && (
              <Zap className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 text-blue-500" />
            )}
          </div>

          {/* Activity badge */}
          <span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${ACTIVITY_BADGE[mower.activity]}`}>
            {t(`mobile.activity.${mower.activity}`)}
          </span>
        </div>
      </div>

      {/* Row 2: Signal chips */}
      <div className="flex items-center gap-3 mt-1">
        <div className="flex items-center gap-1 text-[11px] text-gray-400 dark:text-gray-500">
          <Wifi className="w-3 h-3" />
          <span className="tabular-nums">{mower.wifiRssi ?? '—'}</span>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-gray-400 dark:text-gray-500">
          <Satellite className="w-3 h-3" />
          <span className="tabular-nums">{mower.rtkSat ?? '—'}</span>
        </div>
        <div className={`flex items-center gap-1 text-[11px] font-medium ${mower.rtkOk ? 'text-emerald-400' : 'text-red-400'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${mower.rtkOk ? 'bg-emerald-400' : 'bg-red-400 animate-pulse'}`} />
          <span>RTK</span>
        </div>
      </div>
    </div>
  );
}
