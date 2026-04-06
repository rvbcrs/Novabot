import { Wifi, Satellite, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MowerDerived, MowerActivity } from '../MobilePage';
import { useTheme } from '../ThemeProvider';

interface Props {
  mower: MowerDerived;
}

// ── Ring colors per activity ────────────────────────────────────────

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

const GLOW_COLOR: Record<MowerActivity, string> = {
  idle:      'transparent',
  mowing:    'rgba(16, 185, 129, 0.15)',
  charging:  'rgba(59, 130, 246, 0.15)',
  returning: 'rgba(245, 158, 11, 0.12)',
  paused:    'rgba(234, 179, 8, 0.10)',
  mapping:   'rgba(168, 85, 247, 0.12)',
  error:     'rgba(239, 68, 68, 0.15)',
  offline:   'transparent',
};

const ACTIVITY_TEXT_COLOR: Record<MowerActivity, string> = {
  idle:      'text-gray-500 dark:text-gray-400',
  mowing:    'text-emerald-600 dark:text-emerald-400',
  charging:  'text-blue-600 dark:text-blue-400',
  returning: 'text-amber-600 dark:text-amber-400',
  paused:    'text-yellow-600 dark:text-yellow-400',
  mapping:   'text-purple-600 dark:text-purple-400',
  error:     'text-red-600 dark:text-red-400',
  offline:   'text-gray-400 dark:text-gray-600',
};

function batteryRingColor(pct: number): string {
  if (pct >= 60) return '#22c55e';
  if (pct >= 30) return '#eab308';
  if (pct >= 15) return '#f97316';
  return '#ef4444';
}

// ── SVG Ring ────────────────────────────────────────────────────────

export function BatteryRing({ percentage, color, bgColor, size = 160 }: {
  percentage: number; color: string; bgColor?: string; size?: number;
}) {
  const strokeWidth = 8;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke={bgColor ?? '#1f2937'} strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke={color} strokeWidth={strokeWidth}
        strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset}
        className="transition-all duration-700 ease-out"
      />
    </svg>
  );
}

// ── Component ───────────────────────────────────────────────────────

export function StatusHeroCard({ mower }: Props) {
  const { t } = useTranslation();
  const { resolved } = useTheme();

  const ringColor = mower.activity === 'idle' || mower.activity === 'offline'
    ? batteryRingColor(mower.battery)
    : RING_COLOR[mower.activity];

  const ringBg = resolved === 'dark' ? '#1f2937' : '#e5e7eb';

  return (
    <div className="flex flex-col items-center pt-2 pb-1">
      {/* Name + online */}
      <div className="flex items-center gap-2 mb-5">
        <span className={`w-2 h-2 rounded-full ${mower.online ? 'bg-emerald-400' : 'bg-gray-300 dark:bg-gray-600'}`} />
        <h1 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {mower.nickname || 'OpenNova Mower'}
        </h1>
      </div>

      {/* Circular battery gauge */}
      <div
        className="relative flex items-center justify-center mb-4"
        style={{ filter: `drop-shadow(0 0 20px ${GLOW_COLOR[mower.activity]})` }}
      >
        <BatteryRing percentage={mower.battery} color={ringColor} bgColor={ringBg} size={160} />
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <img
            src={mower.online ? '/mower/novabot.png' : '/mower/mower_offline.png'}
            alt="Mower"
            className="w-16 h-16 object-contain mb-0.5"
          />
          <div className="flex items-baseline gap-0.5">
            <span className="text-xl font-bold text-gray-900 dark:text-white tabular-nums">{mower.battery}</span>
            <span className="text-xs text-gray-400 font-medium">%</span>
            {mower.batteryCharging && (
              <Zap className="w-3 h-3 text-blue-400 ml-0.5" />
            )}
          </div>
        </div>
      </div>

      {/* Activity label */}
      <p className={`text-base font-semibold mb-1 ${ACTIVITY_TEXT_COLOR[mower.activity]}`}>
        {t(`mobile.activity.${mower.activity}`)}
      </p>

      {/* Mowing progress */}
      {mower.activity === 'mowing' && mower.mowingProgress > 0 && (
        <div className="w-48 mt-1">
          <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
            <span>{t('mobile.progress')}</span>
            <span className="tabular-nums">{mower.mowingProgress}%</span>
          </div>
          <div className="h-1.5 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-500"
              style={{ width: `${mower.mowingProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Signal chips */}
      <div className="flex items-center gap-3 mt-3">
        <div className="flex items-center gap-1 text-[11px] text-gray-400 dark:text-gray-500">
          <Wifi className="w-3 h-3" />
          <span className="tabular-nums">{mower.wifiRssi ? `${mower.wifiRssi}` : '—'}</span>
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

      {/* GPS/Localization status */}
      {mower.online && mower.localizationState && (
        <div className="mt-1.5">
          <span className={`text-[10px] px-2 py-0.5 rounded-full ${
            mower.localizationState.toLowerCase().includes('not initialized')
              ? 'bg-amber-900/30 text-amber-400'
              : mower.localizationState.toLowerCase().includes('initialized')
              ? 'bg-emerald-900/30 text-emerald-400'
              : 'bg-gray-800 text-gray-400'
          }`}>
            {mower.localizationState}
          </span>
        </div>
      )}
    </div>
  );
}
