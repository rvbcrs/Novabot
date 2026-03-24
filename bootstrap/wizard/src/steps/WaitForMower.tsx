import { useEffect, useState, useCallback } from 'react';
import type { Socket } from 'socket.io-client';
import type { DetectResult, FirmwareInfo, MowerInfo } from '../App.tsx';
import { useT } from '../i18n/index.ts';
import { isWebBluetoothAvailable, provisionMower, type BleStatus } from '../ble/webBle.ts';

interface ScannedDevice {
  mac: string;
  name: string;
  rssi: number;
  type: 'charger' | 'mower' | 'unknown';
}

interface Props {
  mower: MowerInfo | null;
  firmware: FirmwareInfo | null;
  detect: DetectResult | null;
  ip: string;
  cloudImported: boolean;
  isCustomFirmware: boolean | null;
  socket: Socket;
  onConnected: () => void;
  onAddNewDevice?: () => void;
}

export default function WaitForMower({ mower, firmware, detect, ip, cloudImported, isCustomFirmware, socket, onConnected, onAddNewDevice }: Props) {
  const { t } = useT();
  const existingBroker = detect?.mqtt.clientMode ?? false;
  const [dots, setDots] = useState('');
  const [showNewMower, setShowNewMower] = useState(false);

  // Web Bluetooth state (fallback)
  const [bleStatus, setBleStatus] = useState<BleStatus>({ phase: 'idle', message: '' });
  const [wifiSsid, setWifiSsid] = useState('ABERSONPLEIN-IoT');
  const [wifiPassword, setWifiPassword] = useState('ramonvanbruggen');

  // Native BLE state
  const [nativeBleAvailable, setNativeBleAvailable] = useState<boolean | null>(null);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<ScannedDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<ScannedDevice | null>(null);
  const [provPhase, setProvPhase] = useState<string>('idle');
  const [provError, setProvError] = useState<string | null>(null);

  const hasBle = isWebBluetoothAvailable();

  useEffect(() => {
    const interval = setInterval(() => {
      setDots(d => d.length >= 3 ? '' : d + '.');
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // Check native BLE availability on mount
  useEffect(() => {
    fetch('/api/ble/status')
      .then(r => r.json())
      .then((data: { available: boolean; state: string }) => {
        setNativeBleAvailable(data.available && data.state === 'poweredOn');
      })
      .catch(() => setNativeBleAvailable(false));
  }, []);

  // Socket.io events for native BLE
  useEffect(() => {
    const onScanResult = (device: ScannedDevice) => {
      setDevices(prev => {
        const exists = prev.find(d => d.mac === device.mac);
        if (exists) return prev.map(d => d.mac === device.mac ? { ...d, rssi: device.rssi } : d);
        return [...prev, device];
      });
    };

    const onScanDone = () => setScanning(false);

    const onProgress = ({ phase, error }: { phase: string; message?: string; error?: string }) => {
      setProvPhase(phase);
      if (error) setProvError(error);
      if (phase === 'done') setProvError(null);
    };

    socket.on('ble-scan-result', onScanResult);
    socket.on('ble-scan-done', onScanDone);
    socket.on('ble-progress', onProgress);

    return () => {
      socket.off('ble-scan-result', onScanResult);
      socket.off('ble-scan-done', onScanDone);
      socket.off('ble-progress', onProgress);
    };
  }, [socket]);

  // Don't auto-advance — let user choose "Use this mower" or "Add new device"

  // ── Native BLE handlers ──────────────────────────────────────────────────
  const handleNativeScan = useCallback(async () => {
    setDevices([]);
    setScanning(true);
    setSelectedDevice(null);
    setProvPhase('idle');
    setProvError(null);
    try {
      await fetch('/api/ble/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ duration: 10000 }) });
    } catch {
      setScanning(false);
    }
  }, []);

  const handleStopScan = useCallback(async () => {
    try {
      await fetch('/api/ble/stop-scan', { method: 'POST' });
    } catch { /* ignore */ }
    setScanning(false);
  }, []);

  const handleNativeProvision = useCallback(async (device: ScannedDevice) => {
    if (!wifiSsid) return;
    setSelectedDevice(device);
    setProvPhase('connecting');
    setProvError(null);
    try {
      const res = await fetch('/api/ble/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mac: device.mac,
          wifiSsid,
          wifiPassword,
          deviceType: device.type === 'unknown' ? 'mower' : device.type,
        }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok && data.error) {
        setProvPhase('error');
        setProvError(data.error);
      }
    } catch (err) {
      setProvPhase('error');
      setProvError(err instanceof Error ? err.message : 'Connection error');
    }
  }, [wifiSsid, wifiPassword]);

  // ── Web Bluetooth handler (fallback) ────────────────────────────────────
  const handleBleConnect = useCallback(async (scanAll = false) => {
    if (!ip) return;
    setBleStatus({ phase: 'requesting', message: '' });
    await provisionMower(ip, 1883, setBleStatus, scanAll, wifiSsid || undefined, wifiPassword || undefined);
  }, [ip, wifiSsid, wifiPassword]);

  const bleInProgress = bleStatus.phase !== 'idle' && bleStatus.phase !== 'error' && bleStatus.phase !== 'done';
  const bleDone = bleStatus.phase === 'done';
  const bleError = bleStatus.phase === 'error';

  const nativeProvInProgress = provPhase !== 'idle' && provPhase !== 'error' && provPhase !== 'done';
  const nativeProvDone = provPhase === 'done';
  const nativeProvError = provPhase === 'error';

  // Use native BLE when available, fall back to Web Bluetooth
  const useNativeBle = nativeBleAvailable === true;

  return (
    <div className="glass-card p-8">
      <h2 className="text-xl font-bold text-white mb-2">{t('wait.title')}</h2>
      <p className="text-gray-400 mb-6 text-sm">
        {t('wait.description')}
      </p>

      {!mower ? (
        <div className="flex flex-col gap-5">
          {/* Animated waiting indicator */}
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="relative">
              <div className="w-16 h-16 rounded-full bg-emerald-900/30 flex items-center justify-center overflow-hidden">
                <img src="/OpenNova.png" alt="OpenNova" className="w-12 h-12 object-contain" />
              </div>
              <div className="absolute inset-0 rounded-full border-2 border-emerald-500/50 animate-ping" />
            </div>
            <p className="text-gray-400 font-mono">{t('wait.waiting')}{dots}</p>
          </div>

          {/* ── Native BLE Provisioning (primary when available) ──────── */}
          {useNativeBle ? (
            <div className="bg-blue-900/20 border border-blue-700/40 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-blue-400 text-lg">&#x1F4F6;</span>
                <p className="text-blue-300 text-sm font-semibold">{t('wait.bleNativeTitle')}</p>
              </div>
              <p className="text-gray-400 text-sm mb-4">{t('wait.bleNativeDesc')}</p>

              {/* WiFi credentials (always visible when idle) */}
              {(provPhase === 'idle' || nativeProvError) && (
                <div className="space-y-2 mb-4">
                  <label className="text-gray-400 text-xs font-medium">{t('wait.bleWifiLabel')}</label>
                  <input
                    type="text"
                    placeholder={t('wait.bleWifiSsid')}
                    value={wifiSsid}
                    onChange={e => setWifiSsid(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700/50 text-white text-sm placeholder-gray-600 focus:border-blue-500 focus:outline-none"
                  />
                  <input
                    type="password"
                    placeholder={t('wait.bleWifiPassword')}
                    value={wifiPassword}
                    onChange={e => setWifiPassword(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700/50 text-white text-sm placeholder-gray-600 focus:border-blue-500 focus:outline-none"
                  />
                  {!wifiSsid && (
                    <p className="text-yellow-500/70 text-xs">{t('wait.bleWifiHint')}</p>
                  )}
                </div>
              )}

              {/* Scan button */}
              {provPhase === 'idle' && !scanning && (
                <button
                  onClick={handleNativeScan}
                  disabled={!wifiSsid}
                  className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold transition-colors"
                >
                  {t('wait.bleScanBtn')}
                </button>
              )}

              {/* Scanning indicator + stop button */}
              {scanning && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-blue-400 animate-pulse" />
                    <p className="text-blue-300 text-sm">{t('wait.bleScanning')}</p>
                  </div>
                  <button
                    onClick={handleStopScan}
                    className="w-full py-2 rounded-lg bg-gray-700/50 hover:bg-gray-700 text-gray-300 text-sm transition-colors"
                  >
                    Stop
                  </button>
                </div>
              )}

              {/* Device list */}
              {devices.length > 0 && provPhase === 'idle' && (
                <div className="mt-3 space-y-2">
                  <p className="text-gray-400 text-xs font-medium">{t('wait.bleSelectDevice')}</p>
                  {devices.map(dev => (
                    <button
                      key={dev.mac}
                      onClick={() => handleNativeProvision(dev)}
                      disabled={!wifiSsid || nativeProvInProgress}
                      className="w-full flex items-center justify-between px-4 py-3 bg-gray-800/50 border border-gray-700/40 rounded-lg hover:border-blue-500/50 hover:bg-gray-800/70 disabled:opacity-50 transition-colors text-left"
                    >
                      <div>
                        <p className="text-white text-sm font-medium">{dev.name}</p>
                        <p className="text-gray-500 text-xs font-mono">{dev.mac}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          dev.type === 'charger' ? 'bg-yellow-900/40 text-yellow-400' :
                          dev.type === 'mower' ? 'bg-emerald-900/40 text-emerald-400' :
                          'bg-gray-700/40 text-gray-400'
                        }`}>
                          {dev.type === 'charger' ? t('wait.bleDeviceCharger') :
                           dev.type === 'mower' ? t('wait.bleDeviceMower') : '?'}
                        </span>
                        <span className="text-gray-600 text-xs">{dev.rssi} dBm</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* No devices found after scan */}
              {!scanning && devices.length === 0 && provPhase === 'idle' && nativeBleAvailable && (
                <p className="text-gray-600 text-xs mt-2">{/* shown after first scan attempt */}</p>
              )}

              {/* Provisioning progress */}
              {nativeProvInProgress && selectedDevice && (
                <div className="mt-3 space-y-2">
                  <p className="text-blue-300 text-sm font-semibold">
                    {t('wait.bleProvStarted', { name: selectedDevice.name })}
                  </p>
                  <BleProgressSteps phase={provPhase} t={t} />
                </div>
              )}

              {/* Provisioning done */}
              {nativeProvDone && (
                <div className="mt-3 flex items-center gap-2 py-2">
                  <span className="text-emerald-400">&#x2713;</span>
                  <p className="text-emerald-300 text-sm font-semibold">{t('wait.bleDone')}</p>
                </div>
              )}

              {/* Provisioning error */}
              {nativeProvError && (
                <div className="mt-3 space-y-3">
                  <div className="flex items-start gap-2 p-3 bg-red-900/20 border border-red-800/30 rounded-lg">
                    <span className="text-red-400 mt-0.5">&#x2717;</span>
                    <div>
                      <p className="text-red-300 text-sm">{provError}</p>
                    </div>
                  </div>
                  <button
                    onClick={handleNativeScan}
                    className="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-colors"
                  >
                    {t('wait.bleRetry')}
                  </button>
                </div>
              )}
            </div>
          ) : hasBle ? (
            /* ── Web Bluetooth fallback ────────────────────────────────── */
            <div className="bg-blue-900/20 border border-blue-700/40 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-blue-400 text-lg">&#x1F4F6;</span>
                <p className="text-blue-300 text-sm font-semibold">{t('wait.bleTitle')}</p>
              </div>
              <p className="text-gray-400 text-sm mb-4">{t('wait.bleDesc')}</p>

              {/* WiFi credentials + BLE connect */}
              {bleStatus.phase === 'idle' && (
                <div className="flex flex-col gap-3">
                  <div className="space-y-2">
                    <label className="text-gray-400 text-xs font-medium">{t('wait.bleWifiLabel')}</label>
                    <input
                      type="text"
                      placeholder={t('wait.bleWifiSsid')}
                      value={wifiSsid}
                      onChange={e => setWifiSsid(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700/50 text-white text-sm placeholder-gray-600 focus:border-blue-500 focus:outline-none"
                    />
                    <input
                      type="password"
                      placeholder={t('wait.bleWifiPassword')}
                      value={wifiPassword}
                      onChange={e => setWifiPassword(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700/50 text-white text-sm placeholder-gray-600 focus:border-blue-500 focus:outline-none"
                    />
                    {!wifiSsid && (
                      <p className="text-yellow-500/70 text-xs">{t('wait.bleWifiHint')}</p>
                    )}
                  </div>
                  <button
                    onClick={() => handleBleConnect(false)}
                    disabled={!ip || !wifiSsid}
                    className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold transition-colors"
                  >
                    {t('wait.bleBtn')}
                  </button>
                  <button
                    onClick={() => handleBleConnect(true)}
                    disabled={!ip || !wifiSsid}
                    className="w-full py-2 rounded-lg bg-gray-700/50 hover:bg-gray-700 disabled:bg-gray-800 disabled:text-gray-600 text-gray-300 text-sm transition-colors"
                  >
                    {t('wait.bleScanAll')}
                  </button>
                </div>
              )}

              {bleInProgress && (
                <div className="space-y-2">
                  <BleProgressSteps phase={bleStatus.phase} t={t} />
                  <p className="text-blue-300 text-xs font-mono animate-pulse">{bleStatus.message}</p>
                </div>
              )}

              {bleDone && (
                <div className="flex items-center gap-2 py-2">
                  <span className="text-emerald-400">&#x2713;</span>
                  <p className="text-emerald-300 text-sm font-semibold">{t('wait.bleDone')}</p>
                </div>
              )}

              {bleError && (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 p-3 bg-red-900/20 border border-red-800/30 rounded-lg">
                    <span className="text-red-400 mt-0.5">&#x2717;</span>
                    <div>
                      <p className="text-red-300 text-sm">{bleStatus.message}</p>
                      {bleStatus.error && bleStatus.error !== 'cancelled' && (
                        <p className="text-red-400/60 text-xs mt-1 font-mono">{bleStatus.error}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleBleConnect(false)}
                      className="flex-1 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-colors"
                    >
                      {t('wait.bleRetry')}
                    </button>
                    <button
                      onClick={() => handleBleConnect(true)}
                      className="flex-1 py-2.5 rounded-lg bg-gray-700/50 hover:bg-gray-700 text-gray-300 text-sm transition-colors"
                    >
                      {t('wait.bleScanAll')}
                    </button>
                  </div>
                </div>
              )}

              {/* Browser hint */}
              <p className="text-gray-600 text-xs mt-3">{t('wait.bleHint')}</p>
            </div>
          ) : (
            /* Web Bluetooth not available and no native BLE */
            <div className="bg-yellow-900/15 border border-yellow-800/30 rounded-xl p-4">
              <p className="text-yellow-400 text-sm font-semibold mb-1">{t('wait.bleUnavailableTitle')}</p>
              <p className="text-gray-400 text-sm">{t('wait.bleUnavailableDesc')}</p>
            </div>
          )}

          {/* ── Path A: already cloud-paired (DNS auto-connect) ───────── */}
          <div className="bg-emerald-900/20 border border-emerald-800/40 rounded-xl p-4">
            <p className="text-emerald-300 text-sm font-semibold mb-1">{t('wait.pathAutoTitle')}</p>
            <p className="text-gray-400 text-sm">{t('wait.pathAutoDesc')}</p>
          </div>

          {/* ── Path B: new mower via app — collapsed when cloud was imported */}
          {cloudImported ? (
            <button
              onClick={() => setShowNewMower(v => !v)}
              className="w-full flex items-center justify-between px-4 py-3 bg-gray-800/30 border border-gray-700/30 rounded-xl text-sm text-gray-500 hover:text-gray-300 hover:bg-gray-800/50 transition-colors"
            >
              <span>{t('wait.pathNewTitle')}</span>
              <span className="text-xs">{showNewMower ? '\u25B2' : '\u25BC'}</span>
            </button>
          ) : null}

          {(!cloudImported || showNewMower) && (
            <div className="bg-gray-800/40 rounded-xl p-5">
              <p className="text-gray-300 text-sm font-semibold mb-4">{t('wait.pathNewTitle')} — {t('wait.stepsTitle')}</p>
              <div className="space-y-4">
                {(([
                  { num: 1, label: t('wait.step1'), sub: t('wait.step1Sub', { ip: ip || '...' }) },
                  { num: 2, label: t('wait.step2'), sub: t('wait.step2Sub') },
                  { num: 3, label: t('wait.step3'), sub: t('wait.step3Sub') },
                  { num: 4, label: t('wait.step4'), sub: null },
                ]) as const).map(({ num, label, sub }) => (
                  <div key={num} className="flex gap-3">
                    <div className="w-6 h-6 rounded-full bg-gray-700/60 border border-gray-600/60 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <span className="text-gray-400 text-xs font-bold">{num}</span>
                    </div>
                    <div>
                      <p className="text-gray-200 text-sm">{label}</p>
                      {sub && <p className="text-gray-500 text-xs mt-0.5">{sub}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 py-8">
          <div className="w-20 h-20 rounded-full bg-emerald-900/40 border-2 border-emerald-500 flex items-center justify-center overflow-hidden">
            <img src="/OpenNova.png" alt="OpenNova" className="w-16 h-16 object-contain" />
          </div>
          <div className="text-center">
            <p className="text-emerald-400 font-semibold text-lg">{t('wait.found')}</p>
            <p className="text-gray-300 font-mono text-sm mt-1">{mower.sn}</p>
            <p className="text-gray-500 text-xs">{mower.ip}</p>
            {isCustomFirmware !== null && (
              <span className={`inline-block mt-2 text-xs px-2 py-0.5 rounded-full ${
                isCustomFirmware ? 'bg-emerald-900/40 text-emerald-400' : 'bg-amber-900/40 text-amber-400'
              }`}>
                {isCustomFirmware ? t('wait.firmwareCustom') : t('wait.firmwareStock')}
              </span>
            )}
          </div>

          {/* Choice buttons when mower is found */}
          <div className="flex gap-3 mt-4 w-full">
            <button
              onClick={onConnected}
              className="flex-1 py-3 px-4 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors"
            >
              Use this mower →
            </button>
            {onAddNewDevice && (
              <button
                onClick={onAddNewDevice}
                className="flex-1 py-3 px-4 bg-teal-800 hover:bg-teal-700 text-white font-semibold rounded-xl transition-colors"
              >
                + Add new device
              </button>
            )}
          </div>
        </div>
      )}

      <div className="mt-6 p-4 bg-gray-800/40 rounded-xl">
        <p className="text-gray-500 text-xs font-medium uppercase tracking-wide mb-2">{t('wait.statusTitle')}</p>
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">&#x2713;</span>
            <span className="text-gray-300">
              MQTT {existingBroker
                ? <span className="text-blue-400">({t('wait.mqttSubscriber').replace('MQTT ', '')})</span>
                : `(${t('wait.mqttBroker').replace('MQTT ', '')})`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">&#x2713;</span>
            <span className="text-gray-300">{t('wait.httpServer')}</span>
          </div>
          <div className="flex items-center gap-2">
            {firmware ? <span className="text-emerald-400">&#x2713;</span> : <span className="text-yellow-400">&#x25CB;</span>}
            <span className="text-gray-300">
              {firmware ? t('wait.firmwareLoaded', { version: firmware.version }) : t('wait.firmwareNone')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {mower ? <span className="text-emerald-400">&#x2713;</span> : <span className="text-gray-600">&#x25CB;</span>}
            <span className="text-gray-300">
              {mower ? t('wait.mowerConnected', { sn: mower.sn }) : <span className="text-gray-600">{t('wait.mowerNone').replace('Mower: ', '').replace('Maaier: ', '').replace('Tondeuse : ', '')}</span>}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── BLE progress steps (visual checkmarks) ──────────────────────────────────

const BLE_STEPS: Array<{ phases: string[]; key: string }> = [
  { phases: ['requesting', 'connecting'], key: 'wait.bleStepConnect' },
  { phases: ['discovering', 'handshake'], key: 'wait.bleStepDiscover' },
  { phases: ['wifi'], key: 'wait.bleStepWifi' },
  { phases: ['mqtt'], key: 'wait.bleStepMqtt' },
  { phases: ['commit'], key: 'wait.bleStepCommit' },
];

function BleProgressSteps({ phase, t }: { phase: string; t: (k: string) => string }) {
  // Determine which step we're on
  let currentIdx = -1;
  for (let i = 0; i < BLE_STEPS.length; i++) {
    if (BLE_STEPS[i].phases.includes(phase)) {
      currentIdx = i;
      break;
    }
  }

  return (
    <div className="space-y-1.5 py-1">
      {BLE_STEPS.map((step, i) => {
        const isDone = i < currentIdx;
        const isActive = i === currentIdx;
        return (
          <div key={step.key} className="flex items-center gap-2 text-sm">
            {isDone && <span className="text-emerald-400 w-4 text-center">&#x2713;</span>}
            {isActive && <span className="text-blue-400 w-4 text-center animate-pulse">&#x25CF;</span>}
            {!isDone && !isActive && <span className="text-gray-600 w-4 text-center">&#x25CB;</span>}
            <span className={isDone ? 'text-gray-400' : isActive ? 'text-blue-300' : 'text-gray-600'}>
              {t(step.key)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
