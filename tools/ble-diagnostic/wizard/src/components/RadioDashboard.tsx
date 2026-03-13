import { useState, useEffect, useCallback, useRef } from 'react';
import { useT } from '../i18n';
import { io, Socket } from 'socket.io-client';
import WifiPanel from './WifiPanel';
import LoraPanel from './LoraPanel';
import GpsPanel from './GpsPanel';
import DeviceInfoPanel from './DeviceInfoPanel';
import ProvisioningPanel from './ProvisioningPanel';
import MqttPanel from './MqttPanel';
import LoraFixPanel from './LoraFixPanel';
import SerialMonitorPanel from './SerialMonitorPanel';

interface Props {
  device: {
    mac: string;
    name: string;
    type: 'charger' | 'mower' | 'unknown';
  };
  onBack: () => void;
}

export interface DiagnosticData {
  wifi?: { rssi?: number };
  rtk?: { satellite_num?: number; status?: number; valid?: number };
  lora?: { addr?: number; channel?: number; hc?: number; lc?: number };
  devInfo?: { sn?: string; fw_version?: string; hw_version?: string };
  cfg?: { value?: number };
  wifiRssi?: { wifi?: number };
  // MQTT data for mower
  mqttLora?: { addr?: number; channel?: number; hc?: number; lc?: number };
  mqttDevInfo?: Record<string, unknown>;
}

export default function RadioDashboard({ device, onBack }: Props) {
  const { t } = useT();
  const [data, setData] = useState<DiagnosticData>({});
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(10);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const socketRef = useRef<Socket | null>(null);

  // Prevent duplicate fetch on React strict mode double-mount
  const fetchedRef = useRef(false);
  // Track loading state in a ref so auto-refresh can check it without stale closures
  const loadingRef = useRef(false);

  const fetchDiagnostics = useCallback(async () => {
    setLoading(true);
    loadingRef.current = true;
    try {
      const res = await fetch(`/api/ble/device/${encodeURIComponent(device.mac)}/info`);
      const results: Array<{ command: string; ok: boolean; response: unknown }> = await res.json();

      const newData: DiagnosticData = { ...data };

      for (const r of results) {
        if (!r.response) continue;
        const msg = (r.response as { message?: Record<string, unknown> })?.message;
        if (!msg) continue;

        // Charger wraps data in message.value, mower puts it directly in message
        const val = (msg.value as Record<string, unknown>) ?? msg;

        switch (r.command) {
          case 'get_dev_info':
            newData.devInfo = val as DiagnosticData['devInfo'];
            break;
          case 'get_signal_info':
            if (val.wifi !== undefined) newData.wifi = { rssi: val.wifi as number };
            if (val.rtk !== undefined) newData.rtk = val.rtk as DiagnosticData['rtk'];
            break;
          case 'get_lora_info':
            newData.lora = val as DiagnosticData['lora'];
            break;
          case 'get_cfg_info':
            newData.cfg = val as DiagnosticData['cfg'];
            break;
          case 'get_wifi_rssi':
            newData.wifiRssi = { wifi: val.wifi as number };
            break;
        }
      }

      setData(newData);
    } catch (err) {
      console.error('Failed to fetch diagnostics:', err);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, [device.mac]); // eslint-disable-line react-hooks/exhaustive-deps

  // Signal-only refresh (lightweight, just WiFi + GPS)
  // Skips if a full diagnostic read is in progress to avoid BLE command flooding
  const fetchSignalOnly = useCallback(async () => {
    if (loadingRef.current) return;
    try {
      const res = await fetch(`/api/ble/device/${encodeURIComponent(device.mac)}/signal`);
      const result = await res.json();
      if (result.response) {
        const msg = (result.response as { message?: Record<string, unknown> })?.message;
        if (msg) {
          const val = (msg.value as Record<string, unknown>) ?? msg;
          setData(prev => ({
            ...prev,
            wifi: val.wifi !== undefined ? { rssi: val.wifi as number } : prev.wifi,
            rtk: val.rtk !== undefined ? val.rtk as DiagnosticData['rtk'] : prev.rtk,
          }));
        }
      }
    } catch {
      // Silent fail for auto-refresh
    }
  }, [device.mac]);

  // Initial full fetch (only once, even in React strict mode)
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetchDiagnostics();
  }, [fetchDiagnostics]);

  // Socket.io for live MQTT data
  useEffect(() => {
    const socket = io({ transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('mqtt:data', ({ sn, data: mqttData }: { sn: string; data: Record<string, unknown> }) => {
      // Update dashboard with live MQTT sensor data
      if (mqttData.lora_info) {
        setData(prev => ({ ...prev, mqttLora: mqttData.lora_info as DiagnosticData['mqttLora'] }));
      }
      if (mqttData.dev_info) {
        setData(prev => ({ ...prev, mqttDevInfo: mqttData.dev_info as Record<string, unknown> }));
      }
    });

    return () => { socket.disconnect(); };
  }, []);

  // Auto-refresh
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchSignalOnly, refreshInterval * 1000);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, refreshInterval, fetchSignalOnly]);

  const handleDisconnect = async () => {
    await fetch('/api/ble/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac: device.mac }),
    });
    onBack();
  };

  const getTypeEmoji = () => {
    if (device.type === 'charger') return '🔌';
    if (device.type === 'mower') return '🤖';
    return '📡';
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="glass-card p-4 md:p-6">
        <div className="relative z-10 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{getTypeEmoji()}</span>
            <div>
              <h2 className="text-lg font-semibold">{device.name}</h2>
              <div className="text-xs text-white/40">{device.mac}</div>
            </div>
            <span className="status-dot connected ml-2" />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Auto-refresh toggle */}
            <div className="flex items-center gap-2 text-sm">
              <label className="text-white/50">{t('dashboard.autoRefresh')}</label>
              <button
                onClick={() => setAutoRefresh(!autoRefresh)}
                className={`w-10 h-5 rounded-full transition-colors ${
                  autoRefresh ? 'bg-green-500' : 'bg-white/10'
                } relative`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    autoRefresh ? 'left-5' : 'left-0.5'
                  }`}
                />
              </button>
              <select
                value={refreshInterval}
                onChange={(e) => setRefreshInterval(Number(e.target.value))}
                className="bg-white/5 border border-white/10 rounded px-2 py-0.5 text-sm"
              >
                <option value={3}>3s</option>
                <option value={5}>5s</option>
                <option value={10}>10s</option>
                <option value={30}>30s</option>
              </select>
            </div>

            <button
              onClick={fetchDiagnostics}
              disabled={loading}
              className="px-3 py-1.5 bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 rounded-lg text-sm transition-colors disabled:opacity-40"
            >
              {loading ? '...' : t('dashboard.refreshAll')}
            </button>
            <button
              onClick={handleDisconnect}
              className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg text-sm transition-colors"
            >
              {t('scanner.disconnect')}
            </button>
            <button
              onClick={onBack}
              className="px-3 py-1.5 bg-white/5 hover:bg-white/10 text-white/60 rounded-lg text-sm transition-colors"
            >
              {t('dashboard.backToScan')}
            </button>
          </div>
        </div>
      </div>

      {/* Diagnostic panels */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <WifiPanel data={data} />
        <LoraPanel data={data} deviceType={device.type} />
        <GpsPanel data={data} />
      </div>

      {/* LoRa Fix — prominent, right after diagnostics */}
      <LoraFixPanel chargerMac={device.mac} deviceType={device.type} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <DeviceInfoPanel data={data} />
        <MqttPanel
          deviceType={device.type}
          onLoraData={(lora) => setData(prev => ({ ...prev, mqttLora: lora }))}
          onDevInfoData={(info) => setData(prev => ({ ...prev, mqttDevInfo: info }))}
        />
      </div>

      {/* Serial Monitor (SSH → strace → LoRa frame decoder) */}
      <SerialMonitorPanel />

      {/* Provisioning */}
      <ProvisioningPanel mac={device.mac} deviceType={device.type} data={data} />
    </div>
  );
}
