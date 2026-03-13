import { useState, useEffect, useRef } from 'react';
import { useT } from '../i18n';
import { io, Socket } from 'socket.io-client';

interface ScannedDevice {
  mac: string;
  name: string;
  rssi: number;
  type: 'charger' | 'mower' | 'unknown';
}

interface Props {
  onDeviceSelect: (device: { mac: string; name: string; type: 'charger' | 'mower' | 'unknown' }) => void;
}

export default function DeviceScanner({ onDeviceSelect }: Props) {
  const { t } = useT();
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<ScannedDevice[]>([]);
  const [bleAvailable, setBleAvailable] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    // Check BLE status
    fetch('/api/ble/status')
      .then(r => r.json())
      .then(data => setBleAvailable(data.available && data.state === 'poweredOn'))
      .catch(() => setBleAvailable(false));

    // Set up Socket.io
    const socket = io({ transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('ble:scan-result', (device: ScannedDevice) => {
      setDevices(prev => {
        const existing = prev.findIndex(d => d.mac === device.mac);
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = device;
          return updated;
        }
        return [...prev, device];
      });
    });

    socket.on('ble:scan-done', () => {
      setScanning(false);
    });

    socket.on('ble:connected', (data: { mac: string; name: string; type: string }) => {
      setConnecting(null);
      onDeviceSelect({
        mac: data.mac,
        name: data.name,
        type: data.type as 'charger' | 'mower' | 'unknown',
      });
    });

    return () => {
      socket.disconnect();
    };
  }, [onDeviceSelect]);

  const startScan = async () => {
    setDevices([]);
    setScanning(true);
    try {
      await fetch('/api/ble/scan', { method: 'POST' });
    } catch {
      setScanning(false);
    }
  };

  const stopScan = async () => {
    await fetch('/api/ble/stop-scan', { method: 'POST' });
    setScanning(false);
  };

  const connectDevice = async (device: ScannedDevice) => {
    setConnecting(device.mac);
    try {
      const res = await fetch('/api/ble/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mac: device.mac }),
      });
      const data = await res.json();
      if (data.ok) {
        onDeviceSelect({ mac: data.mac, name: data.name, type: data.type });
      } else {
        alert(data.error || 'Connection failed');
      }
    } catch (err) {
      alert(String(err));
    } finally {
      setConnecting(null);
    }
  };

  const getTypeLabel = (type: string) => {
    if (type === 'charger') return t('scanner.charger');
    if (type === 'mower') return t('scanner.mower');
    return t('scanner.unknown');
  };

  const getTypeColor = (type: string) => {
    if (type === 'charger') return 'text-blue-400';
    if (type === 'mower') return 'text-green-400';
    return 'text-gray-400';
  };

  const getRssiBar = (rssi: number) => {
    const strength = Math.min(4, Math.max(0, Math.floor((rssi + 100) / 15)));
    return (
      <div className="flex gap-0.5 items-end h-4">
        {[0, 1, 2, 3].map(i => (
          <div
            key={i}
            className={`w-1 rounded-sm ${
              i <= strength ? 'bg-green-400' : 'bg-white/10'
            }`}
            style={{ height: `${(i + 1) * 25}%` }}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="glass-card p-6 md:p-8">
      <div className="relative z-10">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold">{t('scanner.title')}</h2>
          <div className="flex gap-2">
            {scanning ? (
              <button
                onClick={stopScan}
                className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg transition-colors"
              >
                {t('scanner.stopScan')}
              </button>
            ) : (
              <button
                onClick={startScan}
                disabled={bleAvailable === false}
                className="px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t('scanner.scan')}
              </button>
            )}
          </div>
        </div>

        {bleAvailable === false && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-300 text-sm">
            Bluetooth is not available. Make sure your Bluetooth adapter is enabled.
          </div>
        )}

        {scanning && (
          <div className="mb-4 flex items-center gap-2 text-yellow-300/80 text-sm">
            <span className="status-dot scanning" />
            {t('scanner.scanning')}
          </div>
        )}

        {devices.length === 0 && !scanning && (
          <p className="text-white/40 text-sm">{t('scanner.noDevices')}</p>
        )}

        {devices.length > 0 && (
          <div className="space-y-2">
            {devices.map(device => (
                <div
                  key={device.mac}
                  className="flex items-center justify-between p-3 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="text-2xl">
                      {device.type === 'charger' ? '🔌' : device.type === 'mower' ? '🤖' : '📡'}
                    </div>
                    <div>
                      <div className="font-medium">{device.name}</div>
                      <div className="text-xs text-white/40 flex items-center gap-2">
                        <span className={getTypeColor(device.type)}>{getTypeLabel(device.type)}</span>
                        <span>{device.mac}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1 text-xs text-white/40">
                      {getRssiBar(device.rssi)}
                      <span>{device.rssi}dB</span>
                    </div>
                    <button
                      onClick={() => connectDevice(device)}
                      disabled={connecting !== null}
                      className="px-3 py-1.5 bg-green-500/20 hover:bg-green-500/30 text-green-300 rounded-lg text-sm transition-colors disabled:opacity-40"
                    >
                      {connecting === device.mac ? '...' : t('scanner.connect')}
                    </button>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
