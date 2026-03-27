import { useState, useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { useT } from '../i18n/index.ts';

interface DockerStatus {
  dockerInstalled: boolean;
  dockerRunning: boolean;
  containerExists: boolean;
  containerRunning: boolean;
  containerImage: string | null;
  containerTargetIp: string | null;
  error: string | null;
}

type Phase =
  | 'checking'
  | 'not-installed'
  | 'not-running'
  | 'ready-to-pull'
  | 'pulling'
  | 'starting'
  | 'health-check'
  | 'ready'
  | 'existing'
  | 'error';

interface Props {
  selectedIp: string;
  socket: Socket;
  onReady: () => void;
}

export default function DockerSetup({ selectedIp, socket, onReady }: Props) {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>('checking');
  const [pullLog, setPullLog] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [existingStatus, setExistingStatus] = useState<DockerStatus | null>(null);
  const [healthHttp, setHealthHttp] = useState<boolean | null>(null);
  const [healthMqtt, setHealthMqtt] = useState<boolean | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-scroll pull log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [pullLog]);

  // Socket listeners for pull progress
  useEffect(() => {
    const onPullProgress = (data: { message: string; done?: boolean }) => {
      setPullLog(prev => [...prev.slice(-100), data.message]);
      if (data.done) startContainer();
    };

    const onDockerError = (data: { message: string }) => {
      setErrorMsg(data.message);
      setPhase('error');
    };

    socket.on('docker-pull-progress', onPullProgress);
    socket.on('docker-error', onDockerError);

    return () => {
      socket.off('docker-pull-progress', onPullProgress);
      socket.off('docker-error', onDockerError);
    };
  }, [socket, selectedIp]);

  // Check Docker status on mount
  useEffect(() => {
    checkDocker();
  }, []);

  // Auto-poll when Docker not running
  useEffect(() => {
    if (phase !== 'not-running') return;
    const interval = setInterval(() => checkDocker(), 5000);
    return () => clearInterval(interval);
  }, [phase]);

  async function checkDocker() {
    setPhase('checking');
    try {
      const resp = await fetch('/api/docker/status');
      const status = await resp.json() as DockerStatus;

      if (!status.dockerInstalled) {
        setPhase('not-installed');
        return;
      }
      if (!status.dockerRunning) {
        setPhase('not-running');
        return;
      }
      if (status.containerRunning) {
        setExistingStatus(status);
        runHealthCheck();
        return;
      }
      if (status.containerExists) {
        setExistingStatus(status);
        setPhase('existing');
        return;
      }
      setPhase('ready-to-pull');
    } catch {
      setErrorMsg(t('docker.errorStatus'));
      setPhase('error');
    }
  }

  async function startPull() {
    setPhase('pulling');
    setPullLog([]);
    try {
      const resp = await fetch('/api/docker/pull', { method: 'POST' });
      const data = await resp.json() as { ok: boolean };
      if (!data.ok) {
        setErrorMsg(t('docker.errorPull'));
        setPhase('error');
      }
    } catch {
      setErrorMsg(t('docker.errorConnection'));
      setPhase('error');
    }
  }

  async function startContainer(recreate = false) {
    setPhase('starting');
    try {
      const resp = await fetch('/api/docker/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: selectedIp, recreate }),
      });
      const data = await resp.json() as { ok?: boolean; error?: string };
      if (!data.ok) {
        setErrorMsg(data.error ?? t('docker.errorStart'));
        setPhase('error');
        return;
      }
      setTimeout(() => runHealthCheck(), 5000);
    } catch {
      setErrorMsg(t('docker.errorConnection'));
      setPhase('error');
    }
  }

  async function runHealthCheck() {
    setPhase('health-check');
    setHealthHttp(null);
    setHealthMqtt(null);

    let attempts = 0;
    const maxAttempts = 30;

    const poll = async () => {
      attempts++;
      try {
        const resp = await fetch('/api/docker/health');
        const data = await resp.json() as { http: boolean; mqtt: boolean };
        setHealthHttp(data.http);
        setHealthMqtt(data.mqtt);

        if (data.http && data.mqtt) {
          setPhase('ready');
          return;
        }
      } catch {
        // Server not reachable — keep polling
      }

      if (attempts >= maxAttempts) {
        setErrorMsg(t('docker.errorHealthTimeout'));
        setPhase('error');
        return;
      }

      setTimeout(poll, 2000);
    };

    poll();
  }

  const os = navigator.platform.toLowerCase();
  const isMac = os.includes('mac');
  const isWin = os.includes('win');

  return (
    <div className="glass-card p-8">
      <h2 className="text-xl font-bold text-white mb-2">{t('docker.title')}</h2>
      <p className="text-gray-400 mb-6 text-sm">
        {t('docker.description')}
      </p>

      {/* ── Checking ─────────────────────────────────────────── */}
      {phase === 'checking' && (
        <div className="flex flex-col items-center gap-4 py-8">
          <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-400">{t('docker.checking')}</p>
        </div>
      )}

      {/* ── Not installed ────────────────────────────────────── */}
      {phase === 'not-installed' && (
        <div className="space-y-4">
          <div className="p-4 bg-amber-900/30 border border-amber-700/50 rounded-xl">
            <div className="flex items-start gap-2">
              <span className="text-amber-400 mt-0.5">!</span>
              <div className="text-sm text-amber-300">
                <p className="font-medium mb-2">{t('docker.notInstalledTitle')}</p>
                <p className="text-amber-400 mb-3">
                  {t('docker.notInstalledDesc')}
                </p>
                <div className="space-y-2">
                  <a
                    href="https://docs.docker.com/desktop/setup/install/mac-install/"
                    target="_blank" rel="noopener noreferrer"
                    className={`block p-2 rounded-lg border text-sm transition-colors ${
                      isMac
                        ? 'bg-emerald-900/30 border-emerald-700/50 text-emerald-300'
                        : 'bg-gray-800/50 border-gray-700 text-gray-400 hover:text-gray-300'
                    }`}
                  >
                    macOS {isMac && <span className="text-emerald-400 text-xs ml-1">{t('docker.yourSystem')}</span>}
                  </a>
                  <a
                    href="https://docs.docker.com/desktop/setup/install/windows-install/"
                    target="_blank" rel="noopener noreferrer"
                    className={`block p-2 rounded-lg border text-sm transition-colors ${
                      isWin
                        ? 'bg-emerald-900/30 border-emerald-700/50 text-emerald-300'
                        : 'bg-gray-800/50 border-gray-700 text-gray-400 hover:text-gray-300'
                    }`}
                  >
                    Windows {isWin && <span className="text-emerald-400 text-xs ml-1">{t('docker.yourSystem')}</span>}
                  </a>
                  <a
                    href="https://docs.docker.com/engine/install/"
                    target="_blank" rel="noopener noreferrer"
                    className={`block p-2 rounded-lg border text-sm transition-colors ${
                      !isMac && !isWin
                        ? 'bg-emerald-900/30 border-emerald-700/50 text-emerald-300'
                        : 'bg-gray-800/50 border-gray-700 text-gray-400 hover:text-gray-300'
                    }`}
                  >
                    Linux {!isMac && !isWin && <span className="text-emerald-400 text-xs ml-1">{t('docker.yourSystem')}</span>}
                  </a>
                </div>
              </div>
            </div>
          </div>
          <button
            onClick={checkDocker}
            className="w-full py-3 px-6 bg-gray-700 hover:bg-gray-600 text-white font-semibold rounded-xl transition-colors"
          >
            {t('docker.recheckBtn')}
          </button>
        </div>
      )}

      {/* ── Not running ──────────────────────────────────────── */}
      {phase === 'not-running' && (
        <div className="space-y-4">
          <div className="p-4 bg-blue-900/20 border border-blue-700/30 rounded-xl">
            <div className="flex items-start gap-2">
              <span className="text-blue-400 mt-0.5">i</span>
              <div className="text-sm text-blue-300">
                <p className="font-medium mb-1">{t('docker.notRunningTitle')}</p>
                <p className="text-blue-400">
                  {t('docker.notRunningDesc')}
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-center py-4">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-gray-400 text-sm ml-3">{t('docker.waitingForDocker')}</span>
          </div>
        </div>
      )}

      {/* ── Ready to pull ────────────────────────────────────── */}
      {phase === 'ready-to-pull' && (
        <div className="space-y-4">
          <div className="p-4 bg-gray-800/50 rounded-xl">
            <p className="text-white font-medium mb-1">{t('docker.readyTitle')}</p>
            <p className="text-gray-400 text-sm">
              {t('docker.imageLabel', { image: 'rvbcrs/opennova:latest' })}
            </p>
            <p className="text-gray-500 text-xs mt-1">{t('docker.sizeEstimate')}</p>
          </div>
          <button
            onClick={startPull}
            className="w-full py-3 px-6 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors"
          >
            {t('docker.pullBtn')}
          </button>
        </div>
      )}

      {/* ── Pulling ──────────────────────────────────────────── */}
      {phase === 'pulling' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-emerald-400 font-medium">{t('docker.pulling')}</p>
          </div>
          <div
            ref={logRef}
            className="bg-gray-950 border border-gray-800 rounded-xl p-4 h-48 overflow-y-auto font-mono text-xs text-gray-400"
          >
            {pullLog.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </div>
      )}

      {/* ── Starting ─────────────────────────────────────────── */}
      {phase === 'starting' && (
        <div className="flex flex-col items-center gap-4 py-8">
          <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-400">{t('docker.starting')}</p>
          <p className="text-gray-500 text-xs">{t('docker.ipLabel', { ip: selectedIp })}</p>
        </div>
      )}

      {/* ── Health check ─────────────────────────────────────── */}
      {phase === 'health-check' && (
        <div className="space-y-4">
          <p className="text-gray-400 text-sm">{t('docker.healthCheckTitle')}</p>
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              {healthHttp === null ? (
                <div className="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
              ) : healthHttp ? (
                <span className="text-emerald-400">&#10003;</span>
              ) : (
                <span className="text-gray-600">&#9675;</span>
              )}
              <span className="text-gray-300">{t('docker.httpService')}</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              {healthMqtt === null ? (
                <div className="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
              ) : healthMqtt ? (
                <span className="text-emerald-400">&#10003;</span>
              ) : (
                <span className="text-gray-600">&#9675;</span>
              )}
              <span className="text-gray-300">{t('docker.mqttService')}</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Ready ────────────────────────────────────────────── */}
      {phase === 'ready' && (
        <div className="space-y-4">
          <div className="p-4 bg-emerald-900/20 border border-emerald-700/40 rounded-xl">
            <div className="flex items-center gap-2 text-sm text-emerald-300">
              <span>&#10003;</span>
              <div>
                <p className="font-medium">{t('docker.readyRunningTitle')}</p>
                <p className="text-emerald-400 text-xs mt-0.5">
                  {t('docker.dashboardInfo', { ip: selectedIp })}
                </p>
              </div>
            </div>
          </div>
          <div className="space-y-1.5 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-emerald-400">&#10003;</span>
              <span className="text-gray-300">{t('docker.httpCheck')}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-emerald-400">&#10003;</span>
              <span className="text-gray-300">{t('docker.mqttCheck')}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-emerald-400">&#10003;</span>
              <span className="text-gray-300">{t('docker.dnsCheck')}</span>
            </div>
          </div>
          <button
            onClick={onReady}
            className="w-full py-3 px-6 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors"
          >
            {t('docker.next')}
          </button>
        </div>
      )}

      {/* ── Existing container ───────────────────────────────── */}
      {phase === 'existing' && existingStatus && (
        <div className="space-y-4">
          <div className="p-4 bg-blue-900/20 border border-blue-700/30 rounded-xl">
            <div className="text-sm text-blue-300">
              <p className="font-medium mb-2">{t('docker.existingTitle')}</p>
              <div className="space-y-1 text-blue-400 text-xs">
                <p>{t('docker.imageLabel', { image: existingStatus.containerImage ?? 'unknown' })}</p>
                <p>Status: {existingStatus.containerRunning ? t('docker.statusActive') : t('docker.statusStopped')}</p>
                {existingStatus.containerTargetIp && (
                  <p>IP: <code>{existingStatus.containerTargetIp}</code>
                    {existingStatus.containerTargetIp !== selectedIp && (
                      <span className="text-amber-400 ml-2">{t('docker.ipDiffers', { ip: selectedIp })}</span>
                    )}
                  </p>
                )}
              </div>
            </div>
          </div>
          <div className="flex gap-3">
            {existingStatus.containerRunning && (
              <button
                onClick={() => runHealthCheck()}
                className="flex-1 py-3 px-6 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors"
              >
                {t('docker.reuseBtn')}
              </button>
            )}
            <button
              onClick={() => startContainer(true)}
              className={`flex-1 py-3 px-6 font-semibold rounded-xl transition-colors ${
                existingStatus.containerRunning
                  ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                  : 'bg-emerald-700 hover:bg-emerald-600 text-white'
              }`}
            >
              {t('docker.recreateBtn')}
            </button>
          </div>
        </div>
      )}

      {/* ── Error ────────────────────────────────────────────── */}
      {phase === 'error' && (
        <div className="space-y-4">
          <div className="p-4 bg-red-900/30 border border-red-700/50 rounded-xl">
            <div className="flex items-start gap-2 text-sm text-red-300">
              <span className="mt-0.5">&#10007;</span>
              <div>
                <p className="font-medium mb-1">{t('docker.errorTitle')}</p>
                <p className="text-red-400">{errorMsg ?? 'Unknown error'}</p>
              </div>
            </div>
          </div>
          <button
            onClick={checkDocker}
            className="w-full py-3 px-6 bg-gray-700 hover:bg-gray-600 text-white font-semibold rounded-xl transition-colors"
          >
            {t('docker.retryBtn')}
          </button>
        </div>
      )}

      {/* Skip button — always visible */}
      <button
        onClick={onReady}
        className="w-full py-2 px-4 mt-4 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-xl transition-colors"
      >
        Skip Docker →
      </button>
    </div>
  );
}
