import { useEffect, useRef, useState } from 'react';
import type { MowerInfo, OtaStatus } from '../App.tsx';

interface Props {
  log: string[];
  mower: MowerInfo | null;
  otaStatus: OtaStatus;
  otaProgress: number; // 0–100
  otaTimedOut: boolean;
}

const STAGES: { key: OtaStatus; label: string; sublabel: string }[] = [
  { key: 'downloading', label: 'Downloaden', sublabel: 'Maaier downloadt en installeert firmware' },
  { key: 'rebooting',  label: 'Herstart',    sublabel: 'Maaier koppelt los en herstart' },
  { key: 'waiting',    label: 'Opstarten',   sublabel: 'Wachten tot de nieuwe server online is' },
];

const STAGE_ORDER: OtaStatus[] = ['downloading', 'rebooting', 'waiting'];

export default function OtaProgress({ log, mower, otaStatus, otaProgress, otaTimedOut }: Props) {
  const logRef = useRef<HTMLDivElement>(null);
  const [showSshRecoveryHint, setShowSshRecoveryHint] = useState(false);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);

  // Show SSH recovery hint after 3.5 minutes in 'waiting' state
  // (server auto-triggers SSH recovery at 3 min — hint appears just after)
  useEffect(() => {
    if (otaStatus === 'waiting') {
      const t = setTimeout(() => setShowSshRecoveryHint(true), 3.5 * 60 * 1000);
      return () => clearTimeout(t);
    } else {
      setShowSshRecoveryHint(false);
    }
  }, [otaStatus]);

  const currentIdx = STAGE_ORDER.indexOf(otaStatus);

  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-8">
      <h2 className="text-xl font-bold text-white mb-2">Firmware flashen...</h2>
      <p className="text-gray-400 mb-6 text-sm">
        Sluit dit venster NIET. De wizard detecteert automatisch wanneer de maaier klaar is.
      </p>

      {/* Status stages */}
      <div className="flex items-start gap-0 mb-6">
        {STAGES.map((stage, i) => {
          const isDone = i < currentIdx;
          const isActive = i === currentIdx;
          return (
            <div key={stage.key} className="flex items-start flex-1 last:flex-none">
              <div className="flex flex-col items-center flex-1">
                {/* Circle */}
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold border-2 transition-all ${
                  isDone
                    ? 'bg-emerald-700 border-emerald-500 text-white'
                    : isActive
                    ? 'bg-emerald-900/40 border-emerald-500 text-emerald-400'
                    : 'bg-gray-800 border-gray-700 text-gray-600'
                }`}>
                  {isDone ? (
                    <span>✓</span>
                  ) : isActive ? (
                    <div className="w-3 h-3 rounded-full bg-emerald-400 animate-pulse" />
                  ) : (
                    <span className="text-gray-600">{i + 1}</span>
                  )}
                </div>
                {/* Label */}
                <p className={`text-xs mt-2 text-center font-medium ${
                  isActive ? 'text-emerald-400' : isDone ? 'text-gray-400' : 'text-gray-600'
                }`}>{stage.label}</p>
                {isActive && (
                  <p className="text-xs mt-0.5 text-gray-500 text-center leading-tight max-w-[100px]">
                    {stage.sublabel}
                  </p>
                )}
              </div>
              {/* Connector line */}
              {i < STAGES.length - 1 && (
                <div className={`flex-1 h-0.5 mt-5 mx-1 ${i < currentIdx ? 'bg-emerald-600' : 'bg-gray-800'}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Mower info */}
      <div className="flex items-center gap-4 mb-6 p-4 bg-gray-800/40 rounded-xl">
        <div className="relative flex-shrink-0">
          <div className="w-12 h-12 rounded-full bg-emerald-900/30 flex items-center justify-center overflow-hidden">
            <img src="/OpenNova.png" alt="OpenNova" className="w-10 h-10 object-contain" />
          </div>
          {otaStatus === 'downloading' && (
            <div className="absolute inset-0 rounded-full border-2 border-emerald-500/60 animate-ping" />
          )}
        </div>
        <div>
          <p className="text-white font-medium">{mower ? mower.sn : 'Maaier'}</p>
          <p className="text-gray-400 text-sm">
            {otaStatus === 'downloading' && 'Bezig met downloaden en installeren...'}
            {otaStatus === 'rebooting'   && 'Herstart gedetecteerd — even geduld...'}
            {otaStatus === 'waiting'     && 'Server opstarten — bijna klaar!'}
          </p>
        </div>
      </div>

      {/* Download progress bar — only during 'downloading' phase */}
      {otaStatus === 'downloading' && (
        <div className="mb-6">
          <div className="flex justify-between items-center mb-1.5">
            <span className="text-gray-400 text-xs font-medium">
              {otaProgress === 0 ? 'Wachten op download...' : 'Download voortgang'}
            </span>
            <span className={`text-sm font-mono font-semibold transition-colors ${otaProgress > 0 ? 'text-emerald-400' : 'text-gray-600'}`}>
              {otaProgress}%
            </span>
          </div>
          <div className="w-full h-3 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-700 to-emerald-400 rounded-full transition-all duration-500 ease-out"
              style={{ width: `${otaProgress}%` }}
            />
          </div>
          {otaProgress > 0 && otaProgress < 100 && (
            <p className="text-gray-600 text-xs mt-1 text-right">
              {otaProgress < 100 ? 'Maaier downloadt...' : 'Installeren...'}
            </p>
          )}
        </div>
      )}

      {/* Log console */}
      <div
        ref={logRef}
        className="bg-black/60 border border-gray-800 rounded-xl p-4 h-48 overflow-y-auto font-mono text-sm space-y-1"
      >
        {log.length === 0 ? (
          <p className="text-gray-600">Wachten op updates...</p>
        ) : (
          log.map((line, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-gray-600 flex-shrink-0">
                {String(i + 1).padStart(2, ' ')}.
              </span>
              <span className="text-gray-300">{line}</span>
            </div>
          ))
        )}
        {log.length > 0 && (
          <div className="flex items-center gap-1 text-emerald-400">
            <span className="inline-block w-2 h-4 bg-emerald-400 animate-pulse" />
          </div>
        )}
      </div>

      {/* Timeout: definitive failure after 30 minutes */}
      {otaTimedOut && (
        <div className="mt-4 p-4 bg-red-900/20 border border-red-700/40 rounded-xl">
          <p className="text-red-300 text-sm font-medium mb-2">Server niet bereikbaar na 30 minuten</p>
          <p className="text-red-400 text-xs leading-relaxed mb-3">
            De wizard heeft SSH herstel geprobeerd maar de maaier is nog steeds niet terug.
            De firmware is waarschijnlijk wel geinstalleerd maar de maaier heeft een volledige herstart nodig.
          </p>
          <ol className="text-red-400 text-xs space-y-1 list-none">
            <li>1. Schakel de maaier volledig uit</li>
            <li>2. Wacht 10 seconden</li>
            <li>3. Zet de maaier weer aan</li>
            <li>4. Ga dan naar <span className="font-mono text-red-300">http://novabot.local:3000</span></li>
          </ol>
        </div>
      )}

      {/* SSH recovery hint — shown after 3.5 minutes if not yet timed out */}
      {showSshRecoveryHint && !otaTimedOut && (
        <div className="mt-4 p-4 bg-amber-900/20 border border-amber-700/40 rounded-xl">
          <p className="text-amber-300 text-sm font-medium mb-1">SSH herstel bezig...</p>
          <p className="text-amber-400 text-xs leading-relaxed">
            De wizard probeert via SSH de maaier te herstellen. Controleer het logboek hierboven voor details.
            Als de maaier niet terugkomt: schakel hem volledig uit, wacht 10 seconden, en zet hem weer aan.
          </p>
        </div>
      )}
    </div>
  );
}
