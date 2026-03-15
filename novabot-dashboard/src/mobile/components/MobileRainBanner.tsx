import { useState, useEffect } from 'react';
import { CloudRain, CloudSun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RainSession, RainForecast } from '../../api/client';
import { fetchRainSessions, fetchRainForecast } from '../../api/client';

// Deterministic raindrop positions
const DROPS = Array.from({ length: 20 }, (_, i) => ({
  left: `${(i * 4.9 + 2) % 96 + 2}%`,
  delay: `${(i * 0.22) % 2.5}s`,
  duration: `${0.7 + (i * 0.05) % 0.5}s`,
  opacity: 0.12 + (i % 5) * 0.04,
}));

interface Props {
  mowerSn: string;
}

export function MobileRainBanner({ mowerSn }: Props) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<RainSession[]>([]);
  const [forecast, setForecast] = useState<RainForecast | null>(null);

  useEffect(() => {
    if (!mowerSn) return;
    const load = () => {
      fetchRainSessions(mowerSn).then(setSessions).catch(() => {});
      fetchRainForecast(mowerSn).then(setForecast).catch(() => {});
    };
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [mowerSn]);

  if (sessions.length === 0) return null;

  const session = sessions[0];
  const pausedAt = new Date(session.paused_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // "Clears at" prediction
  let clearLabel: string | null = null;
  if (forecast?.available && forecast.clearAt) {
    const clearDate = new Date(forecast.clearAt);
    const diffMin = Math.round((clearDate.getTime() - Date.now()) / 60_000);
    const clearTime = clearDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffMin <= 60) {
      clearLabel = t('rain.clearsInMin', { min: diffMin, defaultValue: `Dry in ~${diffMin} min` });
    } else {
      clearLabel = t('rain.clearsAt', { time: clearTime, defaultValue: `Dry at ~${clearTime}` });
    }
  }

  return (
    <>
      <style>{`
        @keyframes mini-rain-fall {
          0% { transform: translateY(-12px); opacity: 0; }
          8% { opacity: 1; }
          100% { transform: translateY(60px); opacity: 0; }
        }
        .mini-rain-drop {
          position: absolute;
          top: -12px;
          width: 1.5px;
          height: 10px;
          background: linear-gradient(to bottom, transparent, #60a5fa);
          border-radius: 0 0 2px 2px;
          animation: mini-rain-fall linear infinite;
          pointer-events: none;
        }
      `}</style>

      <div className="relative overflow-hidden rounded-2xl
                       bg-blue-50 dark:bg-blue-950/70 backdrop-blur-sm
                       border border-blue-200 dark:border-blue-500/20 px-4 py-3">
        {/* Raindrops */}
        {DROPS.map((d, i) => (
          <div
            key={i}
            className="mini-rain-drop"
            style={{ left: d.left, animationDelay: d.delay, animationDuration: d.duration, opacity: d.opacity }}
          />
        ))}

        <div className="relative flex items-center gap-3">
          <div className="flex-shrink-0 w-9 h-9 rounded-full bg-blue-100 dark:bg-blue-500/20 flex items-center justify-center">
            <CloudRain className="w-4.5 h-4.5 text-blue-500 dark:text-blue-400 animate-pulse" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-blue-700 dark:text-blue-200 leading-tight">
              {t('schedule.rainPaused')}
            </p>
            <p className="text-[10px] text-blue-500/70 dark:text-blue-300/70 leading-tight mt-0.5">
              {t('rain.since', { time: pausedAt, defaultValue: `Since ${pausedAt}` })}
            </p>
          </div>
        </div>

        {/* Clear prediction */}
        {clearLabel && (
          <div className="relative flex items-center gap-1.5 mt-2 pt-2 border-t border-blue-200/50 dark:border-blue-500/10">
            <CloudSun className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400/80" />
            <span className="text-[10px] text-amber-600 dark:text-amber-300/80 font-medium">{clearLabel}</span>
          </div>
        )}
      </div>
    </>
  );
}
