import { useState, useEffect } from 'react';
import { CloudRain, CloudSun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RainSession, RainForecast } from '../../api/client';
import { fetchRainSessions, fetchRainForecast } from '../../api/client';

// Deterministic raindrop positions spread across the full card
const DROPS = Array.from({ length: 35 }, (_, i) => ({
  left: `${(i * 2.9 + 1.5) % 96 + 2}%`,
  delay: `${(i * 0.19) % 2.5}s`,
  duration: `${0.7 + (i * 0.04) % 0.5}s`,
  opacity: 0.1 + (i % 6) * 0.04,
}));

interface Props {
  mowerSn: string;
}

export function RainOverlay({ mowerSn }: Props) {
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

  // Calculate "clears at" time
  let clearLabel: string | null = null;
  if (forecast?.available && forecast.clearAt) {
    const clearDate = new Date(forecast.clearAt);
    const now = new Date();
    const diffMin = Math.round((clearDate.getTime() - now.getTime()) / 60_000);
    const clearTime = clearDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffMin <= 60) {
      clearLabel = t('rain.clearsInMin', { min: diffMin, defaultValue: `Dry in ~${diffMin} min` });
    } else {
      clearLabel = t('rain.clearsAt', { time: clearTime, defaultValue: `Dry at ~${clearTime}` });
    }
  }

  return (
    <>
      {/* Rain animation CSS */}
      <style>{`
        @keyframes rain-fall {
          0% { transform: translateY(-16px); opacity: 0; }
          8% { opacity: 1; }
          100% { transform: translateY(120px); opacity: 0; }
        }
        .rain-drop {
          position: absolute;
          top: -16px;
          width: 1.5px;
          height: 14px;
          background: linear-gradient(to bottom, transparent, #60a5fa);
          border-radius: 0 0 2px 2px;
          animation: rain-fall linear infinite;
          pointer-events: none;
        }
      `}</style>

      {/* Banner */}
      <div className="absolute top-14 right-3 z-[1002] w-[260px]">
        <div className="relative overflow-hidden rounded-2xl bg-blue-950/80 backdrop-blur-md border border-blue-500/20 shadow-lg shadow-blue-900/30 px-4 pt-4 pb-3">
          {/* Raindrops across the full card */}
          {DROPS.map((d, i) => (
            <div
              key={i}
              className="rain-drop"
              style={{ left: d.left, animationDelay: d.delay, animationDuration: d.duration, opacity: d.opacity }}
            />
          ))}

          {/* Header row */}
          <div className="relative flex items-center gap-3 mb-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center">
              <CloudRain className="w-5 h-5 text-blue-400 animate-pulse" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold text-blue-200 leading-tight">
                {t('schedule.rainPaused')}
              </p>
              <p className="text-[10px] text-blue-300/70 leading-tight mt-0.5">
                {t('rain.since', { time: pausedAt, defaultValue: `Since ${pausedAt}` })}
              </p>
            </div>
          </div>

          {/* Forecast bar */}
          {forecast?.available && forecast.upcoming.length > 0 && (
            <div className="relative mb-2">
              <div className="flex gap-[3px]">
                {forecast.upcoming.map((h, i) => {
                  const intensity = Math.min(h.mm / 2, 1);
                  const probIntensity = h.prob / 100;
                  const barHeight = Math.max(intensity, probIntensity);
                  const time = new Date(h.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center gap-1">
                      <div className="w-full h-8 bg-blue-900/30 rounded-sm flex items-end overflow-hidden">
                        <div
                          className="w-full rounded-sm transition-all"
                          style={{
                            height: `${Math.max(barHeight * 100, 4)}%`,
                            backgroundColor: h.mm >= 0.1 ? `rgba(96, 165, 250, ${0.3 + barHeight * 0.5})` : 'rgba(96, 165, 250, 0.1)',
                          }}
                        />
                      </div>
                      <span className="text-[8px] text-blue-400/60 leading-none">{time}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Clear-at prediction */}
          {clearLabel && (
            <div className="relative flex items-center gap-1.5 pt-2 border-t border-blue-500/10">
              <CloudSun className="w-3.5 h-3.5 text-amber-400/80" />
              <span className="text-[10px] text-amber-300/80 font-medium">{clearLabel}</span>
            </div>
          )}

          {/* Map name */}
          {session.map_name && (
            <p className="relative text-[9px] text-blue-400/40 truncate mt-1">{session.map_name}</p>
          )}
        </div>
      </div>
    </>
  );
}
