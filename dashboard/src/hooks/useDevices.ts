import { useState, useEffect, useCallback, useRef } from 'react';
import type { DeviceState, DeviceUpdateEvent, DeviceOnlineEvent, MqttLogEntry, BleLogEntry, MowerEvent } from '../types';
import { useSocket, type OtaEventPayload, type MapOutlineEvent } from './useSocket';
import { fetchDevices, fetchOtaSession, type OtaSession } from '../api/client';

const MAX_LOG_ENTRIES = 500;
const MAX_EVENTS = 100;

export interface OtaProgress {
  status: string;
  percentage: number | null;
  timestamp: number;
  /** Server-side phase (#130); absent on servers that predate it. */
  session?: OtaSession;
}

const OTA_TERMINAL = new Set(['done', 'rolled-back', 'failed', 'stalled']);
export const otaFinished = (p: OtaProgress | undefined) => !!p?.session && OTA_TERMINAL.has(p.session.phase);

export function useDevices() {
  const [devices, setDevices] = useState<Map<string, DeviceState>>(new Map());
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<MqttLogEntry[]>([]);
  const [bleLogs, setBleLogs] = useState<BleLogEntry[]>([]);
  const [otaProgress, setOtaProgress] = useState<Map<string, OtaProgress>>(new Map());
  const [liveOutlines, setLiveOutlines] = useState<Map<string, Array<{ lat: number; lng: number }>>>(new Map());
  const [coveredLanes, setCoveredLanes] = useState<Map<string, Array<{ lat1: number; lng1: number; lat2: number; lng2: number }>>>(new Map());
  const [mowerEvents, setMowerEvents] = useState<MowerEvent[]>([]);
  const logsRef = useRef(logs);
  logsRef.current = logs;

  const applyOtaSession = (session: OtaSession) => setOtaProgress(prev => {
    const next = new Map(prev);
    const cur = next.get(session.sn);
    const state = session.lastState as { percentage?: unknown; progress?: unknown } | undefined;
    const rawPct = state?.percentage ?? state?.progress;
    const pct = cur?.percentage ?? (rawPct != null ? (Number(rawPct) <= 1 ? Number(rawPct) * 100 : Number(rawPct)) : null);
    next.set(session.sn, { status: cur?.status ?? session.phase, percentage: pct, timestamp: Date.now(), session });
    return next;
  });

  // REST: initial state load
  useEffect(() => {
    fetchDevices().then(devs => {
      const map = new Map<string, DeviceState>();
      for (const d of devs) map.set(d.sn, { ...d, lastUpdate: Date.now() });
      setDevices(map);
      setLoading(false);
      // An OTA that is still in flight survives a page reload on the server.
      for (const d of devs) {
        fetchOtaSession(d.sn).then(session => {
          if (session) applyOtaSession(session);
        }).catch(() => { /* old server: no phase endpoint */ });
      }
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
      // Keep the last known sensors. Wiping them dropped values that arrive
      // only once, like the firmware version: it is not in the periodic
      // telemetry, so after any offline blip the chip fell back to the serial
      // number until the page was reloaded. The server keeps serving them in
      // its snapshot, so the wipe only made the live view disagree with a
      // refresh. `online: false` is what marks the device as stale.
      if (existing) next.set(e.sn, { ...existing, online: false });
      return next;
    });
    setLiveOutlines(prev => {
      const next = new Map(prev);
      next.delete(e.sn);
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

  const onBleLog = useCallback((entry: BleLogEntry) => {
    setBleLogs(prev => {
      const next = [...prev, entry];
      return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next;
    });
  }, []);

  const onBleLogHistory = useCallback((entries: BleLogEntry[]) => {
    setBleLogs(entries.slice(-MAX_LOG_ENTRIES));
  }, []);

  const onMapOutline = useCallback((e: MapOutlineEvent) => {
    setLiveOutlines(prev => {
      const next = new Map(prev);
      next.set(e.sn, e.points);
      return next;
    });
  }, []);

  const onMowLanes = useCallback((e: { sn: string; lanes: Array<{ lat1: number; lng1: number; lat2: number; lng2: number }> }) => {
    setCoveredLanes(prev => {
      const next = new Map(prev);
      next.set(e.sn, e.lanes);
      return next;
    });
  }, []);

  const onOtaEvent = useCallback((e: OtaEventPayload) => {
    if (e.eventType === 'phase') {
      applyOtaSession(e.data as unknown as OtaSession);
      return;
    }
    if (e.eventType === 'state') {
      const data = e.data;
      const rawPct = data.percentage ?? data.progress;
      const pct = rawPct != null
        ? (Number(rawPct) <= 1 ? Number(rawPct) * 100 : Number(rawPct))
        : null;
      setOtaProgress(prev => {
        const next = new Map(prev);
        next.set(e.sn, {
          status: String(data.status ?? data.state ?? 'updating'),
          percentage: pct,
          timestamp: e.timestamp,
          session: prev.get(e.sn)?.session,
        });
        return next;
      });
    }
  }, []);

  // Newest first, deduped on (sn, type, ts): the backlog fetch and a live event
  // can describe the same thing when the page loads while one is dispatched.
  const onMowerEvent = useCallback((e: MowerEvent) => {
    setMowerEvents(prev => {
      if (prev.some(p => p.sn === e.sn && p.type === e.type && p.ts === e.ts)) return prev;
      return [e, ...prev].slice(0, MAX_EVENTS);
    });
  }, []);

  const { connected } = useSocket({
    onDeviceUpdate, onDeviceOnline, onDeviceOffline, onSnapshot,
    onMqttLog, onMqttLogHistory, onBleLog, onBleLogHistory, onOtaEvent,
    onMapOutline, onMowLanes, onMowerEvent,
  });

  return { devices, loading, connected, logs, bleLogs, otaProgress, liveOutlines,
    coveredLanes, mowerEvents, addMowerEvents: onMowerEvent };
}
