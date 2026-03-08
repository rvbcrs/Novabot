import { useState, useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';

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
        // Container already running — always health check, skip recreate
        setExistingStatus(status);
        runHealthCheck();
        return;
      }
      if (status.containerExists) {
        // Container exists but not running — offer recreate
        setExistingStatus(status);
        setPhase('existing');
        return;
      }
      setPhase('ready-to-pull');
    } catch {
      setErrorMsg('Kan Docker status niet ophalen');
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
        setErrorMsg('Image downloaden mislukt');
        setPhase('error');
      }
      // Success handled by socket event (done: true → startContainer)
    } catch {
      setErrorMsg('Verbinding met bootstrap server verloren');
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
        setErrorMsg(data.error ?? 'Container starten mislukt');
        setPhase('error');
        return;
      }
      // Wait for container to initialize
      setTimeout(() => runHealthCheck(), 5000);
    } catch {
      setErrorMsg('Verbinding met bootstrap server verloren');
      setPhase('error');
    }
  }

  async function runHealthCheck() {
    setPhase('health-check');
    setHealthHttp(null);
    setHealthMqtt(null);

    let attempts = 0;
    const maxAttempts = 30; // 30 × 2s = 60s

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
        setErrorMsg('Health check timeout (60s) — controleer Docker logs: docker logs opennova');
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
    <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-8">
      <h2 className="text-xl font-bold text-white mb-2">Docker server starten</h2>
      <p className="text-gray-400 mb-6 text-sm">
        De OpenNova server draait in een Docker container. Deze bevat de MQTT broker,
        het dashboard en DNS.
      </p>

      {/* ── Checking ─────────────────────────────────────────── */}
      {phase === 'checking' && (
        <div className="flex flex-col items-center gap-4 py-8">
          <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-400">Docker controleren...</p>
        </div>
      )}

      {/* ── Not installed ────────────────────────────────────── */}
      {phase === 'not-installed' && (
        <div className="space-y-4">
          <div className="p-4 bg-amber-900/30 border border-amber-700/50 rounded-xl">
            <div className="flex items-start gap-2">
              <span className="text-amber-400 mt-0.5">!</span>
              <div className="text-sm text-amber-300">
                <p className="font-medium mb-2">Docker Desktop is niet geinstalleerd</p>
                <p className="text-amber-400 mb-3">
                  Download en installeer Docker Desktop voor jouw systeem:
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
                    macOS {isMac && <span className="text-emerald-400 text-xs ml-1">(jouw systeem)</span>}
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
                    Windows {isWin && <span className="text-emerald-400 text-xs ml-1">(jouw systeem)</span>}
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
                    Linux {!isMac && !isWin && <span className="text-emerald-400 text-xs ml-1">(jouw systeem)</span>}
                  </a>
                </div>
              </div>
            </div>
          </div>
          <button
            onClick={checkDocker}
            className="w-full py-3 px-6 bg-gray-700 hover:bg-gray-600 text-white font-semibold rounded-xl transition-colors"
          >
            Opnieuw controleren
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
                <p className="font-medium mb-1">Docker Desktop is niet actief</p>
                <p className="text-blue-400">
                  Start Docker Desktop en wacht tot het groene icoon verschijnt. De wizard controleert elke 5 seconden automatisch.
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-center py-4">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-gray-400 text-sm ml-3">Wachten op Docker...</span>
          </div>
        </div>
      )}

      {/* ── Ready to pull ────────────────────────────────────── */}
      {phase === 'ready-to-pull' && (
        <div className="space-y-4">
          <div className="p-4 bg-gray-800/50 rounded-xl">
            <p className="text-white font-medium mb-1">Docker is gereed</p>
            <p className="text-gray-400 text-sm">
              Image: <code className="text-emerald-400">rvbcrs/opennova:latest</code>
            </p>
            <p className="text-gray-500 text-xs mt-1">~165 MB download</p>
          </div>
          <button
            onClick={startPull}
            className="w-full py-3 px-6 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors"
          >
            Download starten
          </button>
        </div>
      )}

      {/* ── Pulling ──────────────────────────────────────────── */}
      {phase === 'pulling' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-emerald-400 font-medium">Image downloaden...</p>
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
          <p className="text-gray-400">Container starten...</p>
          <p className="text-gray-500 text-xs">IP: {selectedIp}</p>
        </div>
      )}

      {/* ── Health check ─────────────────────────────────────── */}
      {phase === 'health-check' && (
        <div className="space-y-4">
          <p className="text-gray-400 text-sm">Container gestart. Services controleren...</p>
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              {healthHttp === null ? (
                <div className="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
              ) : healthHttp ? (
                <span className="text-emerald-400">&#10003;</span>
              ) : (
                <span className="text-gray-600">&#9675;</span>
              )}
              <span className="text-gray-300">HTTP server (dashboard + API)</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              {healthMqtt === null ? (
                <div className="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
              ) : healthMqtt ? (
                <span className="text-emerald-400">&#10003;</span>
              ) : (
                <span className="text-gray-600">&#9675;</span>
              )}
              <span className="text-gray-300">MQTT broker (poort 1883)</span>
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
                <p className="font-medium">Docker server draait</p>
                <p className="text-emerald-400 text-xs mt-0.5">
                  Dashboard: <code>http://{selectedIp}</code> | MQTT: <code>{selectedIp}:1883</code>
                </p>
              </div>
            </div>
          </div>
          <div className="space-y-1.5 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-emerald-400">&#10003;</span>
              <span className="text-gray-300">HTTP server</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-emerald-400">&#10003;</span>
              <span className="text-gray-300">MQTT broker</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-emerald-400">&#10003;</span>
              <span className="text-gray-300">DNS (dnsmasq)</span>
            </div>
          </div>
          <button
            onClick={onReady}
            className="w-full py-3 px-6 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors"
          >
            Verder &rarr;
          </button>
        </div>
      )}

      {/* ── Existing container ───────────────────────────────── */}
      {phase === 'existing' && existingStatus && (
        <div className="space-y-4">
          <div className="p-4 bg-blue-900/20 border border-blue-700/30 rounded-xl">
            <div className="text-sm text-blue-300">
              <p className="font-medium mb-2">Bestaande container gevonden</p>
              <div className="space-y-1 text-blue-400 text-xs">
                <p>Image: <code>{existingStatus.containerImage ?? 'onbekend'}</code></p>
                <p>Status: {existingStatus.containerRunning ? 'actief' : 'gestopt'}</p>
                {existingStatus.containerTargetIp && (
                  <p>IP: <code>{existingStatus.containerTargetIp}</code>
                    {existingStatus.containerTargetIp !== selectedIp && (
                      <span className="text-amber-400 ml-2">(verschilt van geselecteerd: {selectedIp})</span>
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
                Hergebruiken
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
              Opnieuw aanmaken
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
                <p className="font-medium mb-1">Fout</p>
                <p className="text-red-400">{errorMsg ?? 'Onbekende fout'}</p>
              </div>
            </div>
          </div>
          <button
            onClick={checkDocker}
            className="w-full py-3 px-6 bg-gray-700 hover:bg-gray-600 text-white font-semibold rounded-xl transition-colors"
          >
            Opnieuw proberen
          </button>
        </div>
      )}
    </div>
  );
}
