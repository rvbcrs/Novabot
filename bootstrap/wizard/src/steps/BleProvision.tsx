import { useState, useEffect, useCallback } from 'react';
import type { Socket } from 'socket.io-client';

interface ScannedDevice {
  mac: string;
  name: string;
  rssi: number;
  type: 'charger' | 'mower' | 'unknown';
}

interface Props {
  selectedIp: string;
  socket: Socket;
  onDone: () => void;
}

export default function BleProvision({ selectedIp, socket, onDone }: Props) {
  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [nativeBleAvailable, setNativeBleAvailable] = useState<boolean | null>(null);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<ScannedDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<ScannedDevice | null>(null);
  const [provPhase, setProvPhase] = useState<string>('idle');
  const [provError, setProvError] = useState<string | null>(null);
  const [devicesDone, setDevicesDone] = useState<string[]>([]);

  const mqttPort = 1883;

  useEffect(() => {
    fetch('/api/ble/status')
      .then(r => r.json())
      .then((data: { available: boolean; state: string }) => {
        setNativeBleAvailable(data.available && data.state === 'poweredOn');
      })
      .catch(() => setNativeBleAvailable(false));
  }, []);

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
      if (phase === 'done') {
        setProvError(null);
        if (selectedDevice) {
          setDevicesDone(prev => [...prev, selectedDevice.name]);
          setSelectedDevice(null);
          setProvPhase('idle');
          setDevices([]);
        }
      }
    };

    socket.on('ble-scan-result', onScanResult);
    socket.on('ble-scan-done', onScanDone);
    socket.on('ble-progress', onProgress);

    return () => {
      socket.off('ble-scan-result', onScanResult);
      socket.off('ble-scan-done', onScanDone);
      socket.off('ble-progress', onProgress);
    };
  }, [socket, selectedDevice]);

  const handleScan = useCallback(async () => {
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
    try { await fetch('/api/ble/stop-scan', { method: 'POST' }); } catch { /* ignore */ }
    setScanning(false);
  }, []);

  const handleProvision = useCallback(async (device: ScannedDevice) => {
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
          mqttAddr: selectedIp,
          mqttPort,
          deviceType: device.type === 'unknown' ? 'charger' : device.type,
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
  }, [wifiSsid, wifiPassword, selectedIp]);

  const inProgress = provPhase !== 'idle' && provPhase !== 'error' && provPhase !== 'done';
  const hasError = provPhase === 'error';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white mb-2">Add New Device via Bluetooth</h2>
        <p className="text-gray-400 text-sm">
          Connect your charger or mower via Bluetooth to configure WiFi and MQTT settings.
          The device will connect to your OpenNova server at <code className="text-emerald-400">{selectedIp}:{mqttPort}</code>.
        </p>
      </div>

      {nativeBleAvailable === false && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-4">
          <p className="text-red-400 font-medium">Bluetooth not available</p>
          <p className="text-gray-400 text-sm mt-1">
            The OpenNova server needs Bluetooth hardware to provision devices directly.
          </p>
        </div>
      )}

      {/* Provisioned devices */}
      {devicesDone.length > 0 && (
        <div className="bg-emerald-900/20 border border-emerald-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-emerald-400 mb-2">Configured devices:</h3>
          {devicesDone.map((d, i) => (
            <div key={i} className="flex items-center gap-2 text-sm text-gray-300">
              <span className="text-emerald-400">✓</span> {d}
            </div>
          ))}
        </div>
      )}

      {nativeBleAvailable && (
        <div className="space-y-4">
          {/* WiFi credentials */}
          <div className="space-y-2">
            <label className="text-gray-400 text-xs font-medium">WiFi Credentials (2.4 GHz)</label>
            <input
              type="text"
              placeholder="WiFi network name (SSID)"
              value={wifiSsid}
              onChange={e => setWifiSsid(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-white placeholder-gray-500 focus:border-emerald-500 focus:outline-none"
              disabled={inProgress}
            />
            <input
              type="password"
              placeholder="WiFi password"
              value={wifiPassword}
              onChange={e => setWifiPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-white placeholder-gray-500 focus:border-emerald-500 focus:outline-none"
              disabled={inProgress}
            />
          </div>

          {/* Scan button */}
          {provPhase === 'idle' && !scanning && (
            <button
              onClick={handleScan}
              disabled={!wifiSsid}
              className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold transition-colors"
            >
              {devicesDone.length === 0 ? 'Scan for Devices' : 'Scan for Another Device'}
            </button>
          )}

          {/* Scanning */}
          {scanning && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-blue-400 animate-pulse" />
                <p className="text-blue-300 text-sm">Scanning for BLE devices...</p>
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
            <div className="space-y-2">
              <p className="text-gray-400 text-xs font-medium">Select a device to provision:</p>
              {devices.map(dev => (
                <button
                  key={dev.mac}
                  onClick={() => handleProvision(dev)}
                  disabled={!wifiSsid || inProgress}
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
                      {dev.type === 'charger' ? 'Charger' : dev.type === 'mower' ? 'Mower' : '?'}
                    </span>
                    <span className="text-gray-600 text-xs">{dev.rssi} dBm</span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Provisioning progress */}
          {inProgress && selectedDevice && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                <p className="text-blue-300 text-sm font-semibold">Provisioning {selectedDevice.name}...</p>
              </div>
              <BleProgressSteps phase={provPhase} />
            </div>
          )}

          {/* Provisioning error */}
          {hasError && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 p-3 bg-red-900/20 border border-red-800/30 rounded-lg">
                <span className="text-red-400 mt-0.5">✗</span>
                <p className="text-red-300 text-sm">{provError}</p>
              </div>
              <button
                onClick={handleScan}
                className="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-colors"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      )}

      {/* Continue / skip */}
      {devicesDone.length >= 1 && !inProgress && (
        <button
          onClick={onDone}
          className="w-full py-3 rounded-lg font-medium transition-colors bg-emerald-700 hover:bg-emerald-600 text-white"
        >
          {devicesDone.length >= 2 ? 'Continue →' : 'Skip mower for now, continue →'}
        </button>
      )}
      {devicesDone.length === 0 && (
        <button
          onClick={onDone}
          className="w-full py-2 rounded-lg text-sm text-gray-500 hover:text-gray-400 transition-colors"
        >
          Skip BLE provisioning
        </button>
      )}
    </div>
  );
}

// ── BLE progress steps ───────────────────────────────────────────────────────

const BLE_STEPS = [
  { phases: ['requesting', 'connecting'], label: 'Connecting to device' },
  { phases: ['discovering', 'handshake'], label: 'Discovering services' },
  { phases: ['wifi'], label: 'Sending WiFi credentials' },
  { phases: ['mqtt'], label: 'Sending MQTT settings' },
  { phases: ['commit'], label: 'Saving configuration' },
];

function BleProgressSteps({ phase }: { phase: string }) {
  let currentIdx = -1;
  for (let i = 0; i < BLE_STEPS.length; i++) {
    if (BLE_STEPS[i].phases.includes(phase)) { currentIdx = i; break; }
  }

  return (
    <div className="space-y-1.5 py-1">
      {BLE_STEPS.map((step, i) => {
        const isDone = i < currentIdx;
        const isActive = i === currentIdx;
        return (
          <div key={i} className="flex items-center gap-2 text-sm">
            {isDone && <span className="text-emerald-400 w-4 text-center">✓</span>}
            {isActive && <span className="text-blue-400 w-4 text-center animate-pulse">●</span>}
            {!isDone && !isActive && <span className="text-gray-600 w-4 text-center">○</span>}
            <span className={isDone ? 'text-gray-400' : isActive ? 'text-blue-300' : 'text-gray-600'}>
              {step.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
