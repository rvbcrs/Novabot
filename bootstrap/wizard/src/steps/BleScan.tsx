import { useState, useEffect, useCallback } from 'react';
import type { Socket } from 'socket.io-client';
import type { DeviceMode, BleDevice } from '../App.tsx';

interface Props {
  deviceMode: DeviceMode;
  socket: Socket;
  chargerConnected: boolean;
  mowerConnected: boolean;
  onDeviceSelected: (devices: BleDevice[]) => void;
  onAlreadyConnected: (devices: string[]) => void;
  onNext: () => void;
  onSkip: () => void;
}

interface ScannedDevice {
  id: string;
  name: string;
  mac?: string;
  rssi: number;
  type: 'charger' | 'mower' | 'unknown';
}

export default function BleScan({ deviceMode, socket, chargerConnected, mowerConnected, onDeviceSelected, onAlreadyConnected, onNext, onSkip }: Props) {
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<ScannedDevice[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [scanDone, setScanDone] = useState(false);

  // Filter devices based on deviceMode
  function matchesMode(dev: ScannedDevice): boolean {
    if (deviceMode === 'both') return dev.type === 'charger' || dev.type === 'mower';
    if (deviceMode === 'charger') return dev.type === 'charger';
    if (deviceMode === 'mower') return dev.type === 'mower';
    return false;
  }

  // Socket listeners
  useEffect(() => {
    const onScanResult = (device: ScannedDevice) => {
      setDevices(prev => {
        const id = device.id || device.mac || device.name;
        const exists = prev.find(d => (d.id || d.mac || d.name) === id);
        if (exists) {
          return prev.map(d =>
            (d.id || d.mac || d.name) === id ? { ...d, rssi: device.rssi } : d
          );
        }
        return [...prev, { ...device, id: id }];
      });
    };

    const onScanDone = (data?: { alreadyConnected?: string[] }) => {
      setScanning(false);
      setScanDone(true);
      if (data?.alreadyConnected) {
        onAlreadyConnected(data.alreadyConnected);
      }
    };

    socket.on('ble-scan-result', onScanResult);
    socket.on('ble-scan-done', onScanDone);

    return () => {
      socket.off('ble-scan-result', onScanResult);
      socket.off('ble-scan-done', onScanDone);
    };
  }, [socket, onAlreadyConnected]);

  // Auto-scan on mount
  useEffect(() => {
    startScan();
  }, []);

  const startScan = useCallback(async () => {
    setDevices([]);
    setSelected(new Set());
    setScanning(true);
    setScanDone(false);
    setError(null);
    try {
      const resp = await fetch('/api/ble/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: 10000 }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? 'Scan failed');
        setScanning(false);
      }
    } catch {
      setError('Could not start BLE scan. Check that Bluetooth is available.');
      setScanning(false);
    }
  }, []);

  // Auto-select first matching device(s)
  useEffect(() => {
    if (!scanDone || selected.size > 0) return;

    const matching = devices.filter(matchesMode);
    if (matching.length > 0) {
      const autoSelect = new Set<string>();
      if (deviceMode === 'both') {
        // Auto-select one charger and one mower
        const charger = matching.find(d => d.type === 'charger');
        const mower = matching.find(d => d.type === 'mower');
        if (charger) autoSelect.add(charger.id);
        if (mower) autoSelect.add(mower.id);
      } else {
        autoSelect.add(matching[0].id);
      }
      setSelected(autoSelect);
    }
  }, [scanDone, devices, deviceMode]);

  function toggleDevice(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleStartProvisioning() {
    const selectedDevices: BleDevice[] = devices
      .filter(d => selected.has(d.id))
      .map(d => ({
        id: d.id,
        name: d.name,
        rssi: d.rssi,
        type: d.type === 'unknown' ? (deviceMode === 'mower' ? 'mower' : 'charger') : d.type,
      }));

    onDeviceSelected(selectedDevices);
    onNext();
  }

  const matchingDevices = devices.filter(matchesMode);
  const otherDevices = devices.filter(d => !matchesMode(d));

  return (
    <div className="glass-card p-8">
      <h2 className="text-xl font-bold text-white mb-2">BLE Scan</h2>
      <p className="text-gray-400 mb-6 text-sm">
        Scanning for nearby Bluetooth devices. Make sure your {deviceMode === 'both' ? 'charger and mower are' : deviceMode + ' is'} powered
        on and in range.
      </p>

      {/* Already connected via MQTT — show skip option */}
      {(() => {
        const chargerNeeded = deviceMode === 'charger' || deviceMode === 'both';
        const mowerNeeded = deviceMode === 'mower' || deviceMode === 'both';
        const chargerOk = !chargerNeeded || chargerConnected;
        const mowerOk = !mowerNeeded || mowerConnected;
        const allConnected = chargerOk && mowerOk;
        // Only count devices that are RELEVANT to this flow
        const relevantConnected = (chargerNeeded && chargerConnected) || (mowerNeeded && mowerConnected);

        if (!relevantConnected) return null;

        return (
          <div className={`mb-6 p-4 rounded-xl border ${allConnected ? 'bg-emerald-900/20 border-emerald-700/40' : 'bg-blue-900/20 border-blue-700/30'}`}>
            <p className={`text-sm font-medium mb-2 ${allConnected ? 'text-emerald-300' : 'text-blue-300'}`}>
              {allConnected
                ? deviceMode === 'both' ? 'Both devices already connected!' : `${deviceMode === 'charger' ? 'Charger' : 'Mower'} already connected!`
                : 'Some devices already connected'}
            </p>
            <div className="space-y-1 mb-3">
              {chargerNeeded && (
                <div className="flex items-center gap-2 text-sm">
                  <span className={chargerConnected ? 'text-emerald-400' : 'text-gray-500'}>{chargerConnected ? '●' : '○'}</span>
                  <span className={chargerConnected ? 'text-gray-300' : 'text-gray-500'}>
                    Charger — {chargerConnected ? 'connected via MQTT' : 'not connected'}
                  </span>
                </div>
              )}
              {mowerNeeded && (
                <div className="flex items-center gap-2 text-sm">
                  <span className={mowerConnected ? 'text-emerald-400' : 'text-gray-500'}>{mowerConnected ? '●' : '○'}</span>
                  <span className={mowerConnected ? 'text-gray-300' : 'text-gray-500'}>
                    Mower — {mowerConnected ? 'connected via MQTT' : 'not connected'}
                  </span>
                </div>
              )}
            </div>
            <p className="text-gray-500 text-xs mb-3">
              {allConnected
                ? 'BLE provisioning is not needed. You can skip this step.'
                : 'Only unconnected devices need BLE provisioning.'}
            </p>
            <button
              onClick={onSkip}
              className={`w-full py-2 px-4 font-semibold rounded-xl transition-colors text-sm ${
                allConnected
                  ? 'bg-emerald-700 hover:bg-emerald-600 text-white'
                  : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
              }`}
            >
              {allConnected ? 'Skip BLE — All Connected' : 'Skip BLE — Continue with connected devices'}
            </button>
          </div>
        );
      })()}

      {/* Scanning indicator */}
      {scanning && (
        <div className="flex items-center gap-3 mb-6 p-4 bg-blue-900/20 border border-blue-700/30 rounded-xl">
          <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
          <div>
            <p className="text-blue-300 text-sm font-medium">Scanning for devices...</p>
            <p className="text-blue-400/60 text-xs">This may take up to 10 seconds</p>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="p-4 bg-red-900/30 border border-red-700/50 rounded-xl mb-6">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* Matching devices */}
      {matchingDevices.length > 0 && (
        <div className="mb-4">
          <p className="text-gray-400 text-xs font-medium uppercase tracking-wide mb-2">
            Matching devices ({matchingDevices.length})
          </p>
          <div className="space-y-2">
            {matchingDevices.map(dev => {
              const isSelected = selected.has(dev.id);
              return (
                <button
                  key={dev.id}
                  onClick={() => toggleDevice(dev.id)}
                  className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all text-left ${
                    isSelected
                      ? 'bg-emerald-900/30 border-emerald-600'
                      : 'bg-gray-800/40 border-gray-700 hover:border-gray-500'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                      isSelected ? 'border-emerald-500 bg-emerald-600' : 'border-gray-600'
                    }`}>
                      {isSelected && <span className="text-white text-xs">{'\u2713'}</span>}
                    </div>
                    <div>
                      <p className="text-white text-sm font-medium">{dev.name}</p>
                      <p className="text-gray-500 text-xs font-mono">{dev.id}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      dev.type === 'charger'
                        ? 'bg-amber-900/40 text-amber-400'
                        : dev.type === 'mower'
                        ? 'bg-emerald-900/40 text-emerald-400'
                        : 'bg-gray-700/40 text-gray-400'
                    }`}>
                      {dev.type === 'charger' ? 'Charger' : dev.type === 'mower' ? 'Mower' : 'Unknown'}
                    </span>
                    <span className="text-gray-600 text-xs">{dev.rssi} dBm</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Other devices (collapsed if there are matching ones) */}
      {otherDevices.length > 0 && (
        <div className="mb-6">
          <p className="text-gray-600 text-xs font-medium uppercase tracking-wide mb-2">
            Other devices ({otherDevices.length})
          </p>
          <div className="space-y-1.5">
            {otherDevices.map(dev => (
              <div key={dev.id} className="flex items-center justify-between px-4 py-2 bg-gray-800/20 rounded-lg opacity-50">
                <div>
                  <p className="text-gray-400 text-sm">{dev.name}</p>
                  <p className="text-gray-600 text-xs font-mono">{dev.id}</p>
                </div>
                <span className="text-gray-600 text-xs">{dev.rssi} dBm</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No devices found */}
      {scanDone && devices.length === 0 && !error && (
        <div className="p-6 bg-gray-800/40 rounded-xl mb-6 text-center">
          <p className="text-gray-400 text-sm mb-2">No Bluetooth devices found.</p>
          <p className="text-gray-600 text-xs">Make sure the device is powered on, in range, and not already connected.</p>
        </div>
      )}

      {/* No matching devices */}
      {scanDone && devices.length > 0 && matchingDevices.length === 0 && !error && (
        <div className="p-4 bg-amber-900/20 border border-amber-700/40 rounded-xl mb-6">
          <p className="text-amber-400 text-sm">
            No {deviceMode === 'both' ? 'charger or mower' : deviceMode} devices found.
            Found {otherDevices.length} other device(s).
          </p>
        </div>
      )}

      {/* Buttons */}
      <div className="flex gap-3">
        <button
          onClick={startScan}
          disabled={scanning}
          className="flex-1 py-3 px-6 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white font-semibold rounded-xl transition-colors"
        >
          {scanning ? 'Scanning...' : 'Rescan'}
        </button>
        <button
          onClick={handleStartProvisioning}
          disabled={selected.size === 0 || scanning}
          className="flex-[2] py-3 px-6 bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors"
        >
          Start Provisioning ({selected.size})
        </button>
      </div>
    </div>
  );
}
