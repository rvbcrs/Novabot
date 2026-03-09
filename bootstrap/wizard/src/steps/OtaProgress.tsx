import { useEffect, useRef, useState } from 'react';
import type { MowerInfo, OtaStatus } from '../App.tsx';
import { useT } from '../i18n/index.ts';

interface Props {
  log: string[];
  mower: MowerInfo | null;
  otaStatus: OtaStatus;
  otaProgress: number; // 0–100
  otaTimedOut: boolean;
}

export default function OtaProgress({ log, mower, otaStatus, otaProgress, otaTimedOut }: Props) {
  const { t } = useT();
  const logRef = useRef<HTMLDivElement>(null);
  const [showSshRecoveryHint, setShowSshRecoveryHint] = useState(false);

  const STAGES: { key: OtaStatus; label: string; sublabel: string }[] = [
    { key: 'downloading', label: t('progress.stage1'), sublabel: t('progress.stage1Sub') },
    { key: 'rebooting',  label: t('progress.stage2'), sublabel: t('progress.stage2Sub') },
    { key: 'waiting',    label: t('progress.stage3'), sublabel: t('progress.stage3Sub') },
  ];

  const STAGE_ORDER: OtaStatus[] = ['downloading', 'rebooting', 'waiting'];

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);

  // Show SSH recovery hint after 3.5 minutes in 'waiting' state
  useEffect(() => {
    if (otaStatus === 'waiting') {
      const timer = setTimeout(() => setShowSshRecoveryHint(true), 3.5 * 60 * 1000);
      return () => clearTimeout(timer);
    } else {
      setShowSshRecoveryHint(false);
    }
  }, [otaStatus]);

  const currentIdx = STAGE_ORDER.indexOf(otaStatus);

  return (
    <div className="glass-card p-8">
      <h2 className="text-xl font-bold text-white mb-2">{t('progress.title')}</h2>
      <p className="text-gray-400 mb-6 text-sm">
        {t('progress.description')}
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
          <p className="text-white font-medium">{mower ? mower.sn : t('confirm.mowerLabel')}</p>
          <p className="text-gray-400 text-sm">
            {otaStatus === 'downloading' && t('progress.downloadInstall')}
            {otaStatus === 'rebooting'   && t('progress.rebootDetected')}
            {otaStatus === 'waiting'     && t('progress.serverStarting')}
          </p>
        </div>
      </div>

      {/* Download progress bar — only during 'downloading' phase */}
      {otaStatus === 'downloading' && (
        <div className="mb-6">
          <div className="flex justify-between items-center mb-1.5">
            <span className="text-gray-400 text-xs font-medium">
              {otaProgress === 0 ? t('progress.waitDownload') : t('progress.downloadProgress')}
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
              {otaProgress < 100 ? t('progress.downloading') : t('progress.installing')}
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
          <p className="text-gray-600">{t('progress.waitUpdates')}</p>
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
          <p className="text-red-300 text-sm font-medium mb-2">{t('progress.timeoutTitle')}</p>
          <p className="text-red-400 text-xs leading-relaxed mb-3">
            {t('progress.timeoutDesc')}
          </p>
          <ol className="text-red-400 text-xs space-y-1 list-none">
            <li>{t('progress.timeoutStep1')}</li>
            <li>{t('progress.timeoutStep2')}</li>
            <li>{t('progress.timeoutStep3')}</li>
            <li>{t('progress.timeoutStep4')} <span className="font-mono text-red-300">http://novabot.local:3000</span></li>
          </ol>
        </div>
      )}

      {/* SSH recovery hint — shown after 3.5 minutes if not yet timed out */}
      {showSshRecoveryHint && !otaTimedOut && (
        <div className="mt-4 p-4 bg-amber-900/20 border border-amber-700/40 rounded-xl">
          <p className="text-amber-300 text-sm font-medium mb-1">{t('progress.sshTitle')}</p>
          <p className="text-amber-400 text-xs leading-relaxed">
            {t('progress.sshDesc')}
          </p>
        </div>
      )}
    </div>
  );
}
