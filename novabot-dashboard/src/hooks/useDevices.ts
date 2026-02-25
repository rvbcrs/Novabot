import { useState, useEffect, useCallback, useRef } from 'react';
import type { DeviceState, DeviceUpdateEvent, DeviceOnlineEvent, MqttLogEntry } from '../types';
import { useSocket } from './useSocket';
import { fetchDevices } from '../api/client';

const MAX_LOG_ENTRIES = 500;

export function useDevices() {
  const [devices, setDevices] = useState<Map<string, DeviceState>>(new Map());
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<MqttLogEntry[]>([]);
  const logsRef = useRef(logs);
  logsRef.current = logs;

  // REST: initial state load
  useEffect(() => {
    fetchDevices().then(devs => {
      const map = new Map<string, DeviceState>();
      for (const d of devs) map.set(d.sn, { ...d, lastUpdate: Date.now() });
      setDevices(map);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const onSnapshot = useCallback((devs: Array<{ sn: string; deviceType: string; online: boolean; sensors: Record<string, string> }>) => {
    setDevices(prev => {
      const next = new Map(prev);
      for (const d of devs) {
        const existing = next.get(d.sn);
        next.set(d.sn, {
          sn: d.sn,
          deviceType: d.deviceType as 'charger' | 'mower',
          online: d.online,
          sensors: { ...(existing?.sensors ?? {}), ...d.sensors },
          lastUpdate: Date.now(),
          nickname: existing?.nickname,
          macAddress: existing?.macAddress,
          lastSeen: existing?.lastSeen,
        });
      }
      return next;
    });
  }, []);

  const onDeviceUpdate = useCallback((e: DeviceUpdateEvent) => {
    setDevices(prev => {
      const next = new Map(prev);
      const existing = next.get(e.sn);
      if (existing) {
        next.set(e.sn, {
          ...existing,
          sensors: { ...existing.sensors, ...e.fields },
          lastUpdate: e.timestamp,
        });
      } else {
        next.set(e.sn, {
          sn: e.sn,
          deviceType: e.sn.startsWith('LFIC') ? 'charger' : 'mower',
          online: true,
          sensors: e.fields,
          lastUpdate: e.timestamp,
        });
      }
      return next;
    });
  }, []);

  const onDeviceOnline = useCallback((e: DeviceOnlineEvent) => {
    setDevices(prev => {
      const next = new Map(prev);
      const existing = next.get(e.sn);
      if (existing) next.set(e.sn, { ...existing, online: true });
      return next;
    });
  }, []);

  const onDeviceOffline = useCallback((e: DeviceOnlineEvent) => {
    setDevices(prev => {
      const next = new Map(prev);
      const existing = next.get(e.sn);
      if (existing) next.set(e.sn, { ...existing, online: false });
      return next;
    });
  }, []);

  const onMqttLog = useCallback((entry: MqttLogEntry) => {
    setLogs(prev => {
      const next = [...prev, entry];
      return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next;
    });
  }, []);

  const onMqttLogHistory = useCallback((entries: MqttLogEntry[]) => {
    setLogs(entries.slice(-MAX_LOG_ENTRIES));
  }, []);

  const { connected } = useSocket({
    onDeviceUpdate, onDeviceOnline, onDeviceOffline, onSnapshot,
    onMqttLog, onMqttLogHistory,
  });

  return { devices, loading, connected, logs };
}
