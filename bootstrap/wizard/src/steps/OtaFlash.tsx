import { useState, useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import type { DeviceMode, FirmwareInfo, OtaStatus } from '../App.tsx';

interface Props {
  deviceMode: DeviceMode;
  chargerFirmware: FirmwareInfo | null;
  mowerFirmware: FirmwareInfo | null;
  socket: Socket;
  otaLog: string[];
  otaStatus: OtaStatus;
  otaProgress: number;
  onNext: () => void;
}

export default function OtaFlash({ deviceMode, chargerFirmware, mowerFirmware, socket: _socket, otaLog, otaStatus, otaProgress, onNext }: Props) {
  const logRef = useRef<HTMLDivElement>(null);
  const [triggered, setTriggered] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const hasFirmware = (deviceMode === 'charger' || deviceMode === 'both') && chargerFirmware
    || (deviceMode === 'mower' || deviceMode === 'both') && mowerFirmware;

  // Auto-skip if no firmware uploaded
  useEffect(() => {
    if (!hasFirmware) {
      onNext();
    }
  }, [hasFirmware, onNext]);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [otaLog]);

  // Auto-advance when OTA is done
  useEffect(() => {
    if (otaStatus === 'done') {
      const timer = setTimeout(onNext, 3000);
      return () => clearTimeout(timer);
    }
  }, [otaStatus, onNext]);

  async function triggerOta(type: 'charger' | 'mower') {
    setTriggered(true);
    setTriggerError(null);
    try {
      const resp = await fetch('/api/ota/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      });
      const data = await resp.json() as { ok?: boolean; error?: string };
      if (!resp.ok || data.error) {
        setTriggerError(data.error ?? 'OTA trigger failed');
        setTriggered(false);
      }
    } catch {
      setTriggerError('Failed to trigger OTA. Check your connection.');
      setTriggered(false);
    }
  }

  // Don't render if no firmware (auto-skip handles it)
  if (!hasFirmware) return null;

  const showCharger = (deviceMode === 'charger' || deviceMode === 'both') && chargerFirmware;
  const showMower = (deviceMode === 'mower' || deviceMode === 'both') && mowerFirmware;

  const isActive = otaStatus !== 'idle' && otaStatus !== 'done';
  const isDone = otaStatus === 'done';

  return (
    <div className="glass-card p-8">
      <h2 className="text-xl font-bold text-white mb-2">OTA Firmware Flash</h2>
      <p className="text-gray-400 mb-6 text-sm">
        Flash the uploaded firmware to your device(s) over-the-air. Make sure devices stay powered
        on during the entire process.
      </p>

      {/* Firmware cards */}
      {!triggered && (
        <div className="space-y-3 mb-6">
          {showCharger && (
            <div className="flex items-center justify-between p-4 bg-gray-800/40 rounded-xl border border-gray-700">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{'\u26A1'}</span>
                <div>
                  <p className="text-white text-sm font-medium">Charger Firmware</p>
                  <p className="text-gray-400 text-xs">{chargerFirmware!.name} &middot; v{chargerFirmware!.version}</p>
                </div>
              </div>
              <button
                onClick={() => triggerOta('charger')}
                className="py-2 px-4 bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-semibold rounded-lg transition-colors"
              >
                Flash
              </button>
            </div>
          )}

          {showMower && (
            <div className="flex items-center justify-between p-4 bg-gray-800/40 rounded-xl border border-gray-700">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{'\uD83E\uDD16'}</span>
                <div>
                  <p className="text-white text-sm font-medium">Mower Firmware</p>
                  <p className="text-gray-400 text-xs">{mowerFirmware!.name} &middot; v{mowerFirmware!.version}</p>
                </div>
              </div>
              <button
                onClick={() => triggerOta('mower')}
                className="py-2 px-4 bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-semibold rounded-lg transition-colors"
              >
                Flash
              </button>
            </div>
          )}
        </div>
      )}

      {/* Trigger error */}
      {triggerError && (
        <div className="p-4 bg-red-900/30 border border-red-700/50 rounded-xl mb-6">
          <p className="text-red-400 text-sm">{triggerError}</p>
        </div>
      )}

      {/* Progress */}
      {isActive && (
        <div className="mb-6">
          {/* Status label */}
          <div className="flex items-center gap-3 mb-4">
            <div className="w-5 h-5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
            <p className="text-emerald-300 text-sm font-medium">
              {otaStatus === 'downloading' && 'Downloading & installing firmware...'}
              {otaStatus === 'rebooting' && 'Device is rebooting...'}
              {otaStatus === 'waiting' && 'Waiting for device to come back online...'}
            </p>
          </div>

          {/* Progress bar (downloading phase) */}
          {otaStatus === 'downloading' && (
            <div className="mb-4">
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-gray-400 text-xs">Download progress</span>
                <span className="text-emerald-400 text-sm font-mono font-semibold">{otaProgress}%</span>
              </div>
              <div className="w-full h-3 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-emerald-700 to-emerald-400 rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${otaProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* Stage indicators */}
          <div className="flex items-center gap-0 mb-4">
            {(['downloading', 'rebooting', 'waiting'] as const).map((stage, i, arr) => {
              const stageOrder = ['downloading', 'rebooting', 'waiting'] as const;
              const currentIdx = stageOrder.indexOf(otaStatus as typeof stageOrder[number]);
              const stageIdx = stageOrder.indexOf(stage);
              const isDoneStage = stageIdx < currentIdx;
              const isActiveStage = stageIdx === currentIdx;

              return (
                <div key={stage} className="flex items-center flex-1 last:flex-none">
                  <div className="flex flex-col items-center flex-1">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold border-2 ${
                      isDoneStage ? 'bg-emerald-700 border-emerald-500 text-white' :
                      isActiveStage ? 'bg-emerald-900/40 border-emerald-500 text-emerald-400' :
                      'bg-gray-800 border-gray-700 text-gray-600'
                    }`}>
                      {isDoneStage ? '\u2713' : isActiveStage ? (
                        <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                      ) : i + 1}
                    </div>
                    <p className={`text-xs mt-1 capitalize ${
                      isActiveStage ? 'text-emerald-400' : isDoneStage ? 'text-gray-400' : 'text-gray-600'
                    }`}>{stage}</p>
                  </div>
                  {i < arr.length - 1 && (
                    <div className={`flex-1 h-0.5 mx-1 mb-4 ${stageIdx < currentIdx ? 'bg-emerald-600' : 'bg-gray-800'}`} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Done */}
      {isDone && (
        <div className="p-4 bg-emerald-900/20 border border-emerald-700/40 rounded-xl mb-6">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400 text-lg">{'\u2713'}</span>
            <p className="text-emerald-300 text-sm font-medium">
              Firmware update complete! Continuing...
            </p>
          </div>
        </div>
      )}

      {/* Log console */}
      {otaLog.length > 0 && (
        <div
          ref={logRef}
          className="bg-black/60 border border-gray-800 rounded-xl p-4 h-40 overflow-y-auto font-mono text-xs space-y-1 mb-6"
        >
          {otaLog.map((line, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-gray-600 flex-shrink-0">{String(i + 1).padStart(2, ' ')}.</span>
              <span className="text-gray-300">{line}</span>
            </div>
          ))}
          <div className="flex items-center gap-1 text-emerald-400">
            <span className="inline-block w-2 h-4 bg-emerald-400 animate-pulse" />
          </div>
        </div>
      )}

      {/* Skip / Continue button */}
      {!isActive && !isDone && (
        <button
          onClick={onNext}
          className="w-full py-3 px-6 bg-gray-700 hover:bg-gray-600 text-white font-semibold rounded-xl transition-colors"
        >
          Skip OTA
        </button>
      )}
    </div>
  );
}
