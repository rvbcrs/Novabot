import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { getSocket } from '../api/socket';
import type { DeviceUpdateEvent, DeviceOnlineEvent, MqttLogEntry, BleLogEntry } from '../types';

export interface OtaEventPayload {
  sn: string;
  eventType: 'state' | 'version';
  data: Record<string, unknown>;
  timestamp: number;
}

export interface MapOutlineEvent {
  sn: string;
  points: Array<{ lat: number; lng: number }>;
  timestamp: number;
}

interface SocketHandlers {
  onDeviceUpdate: (e: DeviceUpdateEvent) => void;
  onDeviceOnline: (e: DeviceOnlineEvent) => void;
  onDeviceOffline: (e: DeviceOnlineEvent) => void;
  onSnapshot: (devices: Array<{ sn: string; deviceType: string; online: boolean; sensors: Record<string, string> }>) => void;
  onMqttLog?: (entry: MqttLogEntry) => void;
  onMqttLogHistory?: (entries: MqttLogEntry[]) => void;
  onBleLog?: (entry: BleLogEntry) => void;
  onBleLogHistory?: (entries: BleLogEntry[]) => void;
  onOtaEvent?: (e: OtaEventPayload) => void;
  onMapOutline?: (e: MapOutlineEvent) => void;
  onTrailClear?: (e: { sn: string }) => void;
  onMowLanes?: (e: { sn: string; lanes: Array<{ lat1: number; lng1: number; lat2: number; lng2: number }> }) => void;
}

export function useSocket(handlers: SocketHandlers) {
  const socketRef = useRef<Socket | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socket = getSocket();
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('state:snapshot', (data: { devices: Array<{ sn: string; deviceType: string; online: boolean; sensors: Record<string, string> }> }) => {
      handlersRef.current.onSnapshot(data.devices);
    });

    socket.on('device:update', (e: DeviceUpdateEvent) => {
      handlersRef.current.onDeviceUpdate(e);
    });

    socket.on('device:online', (e: DeviceOnlineEvent) => {
      handlersRef.current.onDeviceOnline(e);
    });

    socket.on('device:offline', (e: DeviceOnlineEvent) => {
      handlersRef.current.onDeviceOffline(e);
    });

    socket.on('mqtt:log', (entry: MqttLogEntry) => {
      handlersRef.current.onMqttLog?.(entry);
    });

    socket.on('mqtt:log:history', (entries: MqttLogEntry[]) => {
      handlersRef.current.onMqttLogHistory?.(entries);
    });

    socket.on('ble:log', (entry: BleLogEntry) => {
      handlersRef.current.onBleLog?.(entry);
    });

    socket.on('ble:log:history', (entries: BleLogEntry[]) => {
      handlersRef.current.onBleLogHistory?.(entries);
    });

    socket.on('ota:event', (e: OtaEventPayload) => {
      handlersRef.current.onOtaEvent?.(e);
    });

    socket.on('map:outline', (e: MapOutlineEvent) => {
      handlersRef.current.onMapOutline?.(e);
    });

    socket.on('trail:clear', (e: { sn: string }) => {
      handlersRef.current.onTrailClear?.(e);
    });

    socket.on('mow:lanes', (e: { sn: string; lanes: Array<{ lat1: number; lng1: number; lat2: number; lng2: number }> }) => {
      handlersRef.current.onMowLanes?.(e);
    });

    // Shared socket — only remove listeners this hook registered, don't disconnect
    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('state:snapshot');
      socket.off('device:update');
      socket.off('device:online');
      socket.off('device:offline');
      socket.off('mqtt:log');
      socket.off('mqtt:log:history');
      socket.off('ble:log');
      socket.off('ble:log:history');
      socket.off('ota:event');
      socket.off('map:outline');
      socket.off('trail:clear');
      socket.off('mow:lanes');
    };
  }, []);

  return { connected };
}
