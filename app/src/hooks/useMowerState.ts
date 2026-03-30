/**
 * Custom hook that connects to Socket.io and returns real-time mower state.
 *
 * Listens to events from server/src/dashboard/socketHandler.ts:
 *   - 'state:snapshot' -> full state on connect
 *   - 'device:update'  -> real-time sensor updates
 *   - 'device:online'  / 'device:offline'
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { Socket } from 'socket.io-client';
import { getSocket } from '../services/socket';
import type {
  DeviceState,
  DeviceUpdateEvent,
  DeviceOnlineEvent,
  SnapshotDevice,
} from '../types';
import { useDemo } from '../context/DemoContext';

interface UseMowerStateResult {
  devices: Map<string, DeviceState>;
  connected: boolean;
}

// Re-export so screens can import from one place
export function useMowerState(): UseMowerStateResult {
  const [realDevices, setDevices] = useState<Map<string, DeviceState>>(new Map());
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  const handleSnapshot = useCallback(
    (data: { devices: SnapshotDevice[] }) => {
      const map = new Map<string, DeviceState>();
      for (const d of data.devices) {
        map.set(d.sn, {
          sn: d.sn,
          deviceType: d.deviceType as 'charger' | 'mower',
          online: d.online,
          sensors: d.sensors,
          lastUpdate: Date.now(),
        });
      }
      setDevices(map);
    },
    [],
  );

  const handleDeviceUpdate = useCallback((e: DeviceUpdateEvent) => {
    setDevices((prev) => {
      const next = new Map(prev);
      const existing = next.get(e.sn);
      if (existing) {
        next.set(e.sn, {
          ...existing,
          sensors: { ...existing.sensors, ...e.fields },
          lastUpdate: e.timestamp,
        });
      }
      return next;
    });
  }, []);

  const handleDeviceOnline = useCallback((e: DeviceOnlineEvent) => {
    setDevices((prev) => {
      const next = new Map(prev);
      const existing = next.get(e.sn);
      if (existing) {
        next.set(e.sn, { ...existing, online: true, lastUpdate: Date.now() });
      } else {
        next.set(e.sn, {
          sn: e.sn,
          deviceType: e.deviceType as 'charger' | 'mower',
          online: true,
          sensors: {},
          lastUpdate: Date.now(),
        });
      }
      return next;
    });
  }, []);

  const handleDeviceOffline = useCallback((e: DeviceOnlineEvent) => {
    setDevices((prev) => {
      const next = new Map(prev);
      const existing = next.get(e.sn);
      if (existing) {
        next.set(e.sn, { ...existing, online: false, lastUpdate: Date.now() });
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    socketRef.current = socket;

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('state:snapshot', handleSnapshot);
    socket.on('device:update', handleDeviceUpdate);
    socket.on('device:online', handleDeviceOnline);
    socket.on('device:offline', handleDeviceOffline);

    // If already connected, update state
    if (socket.connected) {
      setConnected(true);
    }

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('state:snapshot', handleSnapshot);
      socket.off('device:update', handleDeviceUpdate);
      socket.off('device:online', handleDeviceOnline);
      socket.off('device:offline', handleDeviceOffline);
    };
  }, [handleSnapshot, handleDeviceUpdate, handleDeviceOnline, handleDeviceOffline]);

  // Merge demo devices when demo mode is active
  const demo = useDemo();
  const devices = useMemo(() => {
    if (!demo.enabled) return realDevices;
    const merged = new Map(realDevices);
    for (const [sn, d] of demo.demoDevices) {
      merged.set(sn, d);
    }
    return merged;
  }, [realDevices, demo.enabled, demo.demoDevices]);

  return { devices, connected: demo.enabled || connected };
}
