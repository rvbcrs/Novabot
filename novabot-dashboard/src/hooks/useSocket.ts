import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type { DeviceUpdateEvent, DeviceOnlineEvent, MqttLogEntry, BleLogEntry } from '../types';

export interface OtaEventPayload {
  sn: string;
  eventType: 'state' | 'version';
  data: Record<string, unknown>;
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
}

export function useSocket(handlers: SocketHandlers) {
  const socketRef = useRef<Socket | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socket = io({ transports: ['websocket', 'polling'] });
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

    return () => { socket.disconnect(); };
  }, []);

  return { connected };
}
