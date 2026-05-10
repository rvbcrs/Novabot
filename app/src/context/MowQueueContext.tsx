/**
 * MowQueueContext — sequential multi-map mowing queue.
 *
 * The stock mqtt_node binary's `start_navigation` command takes one `area`
 * value (uint32) and only starts ONE map per call. To support "mow map1
 * AND map3 but not map2" we orchestrate it in the app: enqueue the
 * selected mapIds, send the first start_navigation, watch the active
 * mower's `msg` field for `Work:FINISHED` + error_status=0, then send
 * the next.
 *
 * State is persisted to AsyncStorage so a JS reload mid-cycle resumes
 * cleanly. The queue is per-SN — switching mowers does not interfere.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { useActiveMower } from '../hooks/useActiveMower';
import { ApiClient, type MapData } from '../services/api';
import { getServerUrl } from '../services/auth';

interface QueueItem {
  mapId: string;
  mapName: string;
  /** Index into the workMaps array, used to encode `area`
   *  (0 → 1, 1 → 10, 2 → 200) per Flutter decompilation. */
  mapIdx: number;
}

interface QueueState {
  sn: string;
  cuttingHeight: number;        // user cm (2..9), wire = cm − 2
  pathDirection: number;
  remaining: QueueItem[];       // INCLUDES the currently-running map at index 0
  startedAt: number;
}

interface MowQueueContextValue {
  /** Active queue state for the current mower, or null when idle. */
  queue: QueueState | null;
  /** Start a multi-map sequence. Returns once the FIRST map has been
   *  dispatched. The remaining maps are scheduled by the watcher. */
  enqueue: (params: {
    sn: string;
    mapIds: string[];
    cuttingHeight: number;
    pathDirection: number;
  }) => Promise<void>;
  /** Clear the queue without stopping the mower. Used when the user
   *  presses Stop in the UI — the stop_task command goes through the
   *  normal HomeScreen path. */
  clear: () => Promise<void>;
}

const MowQueueContext = createContext<MowQueueContextValue>({
  queue: null,
  enqueue: async () => {},
  clear: async () => {},
});

const STORAGE_KEY_PREFIX = 'novabot_mowQueue_';

function storageKey(sn: string): string {
  return `${STORAGE_KEY_PREFIX}${sn}`;
}

function areaParamFromIdx(idx: number): number {
  // Flutter decompilation: 1 = map0, 10 = map1, 200 = map2.
  return idx === 0 ? 1 : idx === 1 ? 10 : 200;
}

function isMowingMsg(msg: string): boolean {
  return msg.includes('Work:RUNNING')
      || msg.includes('Work:COVERING')
      || msg.includes('Work:NAVIGATING')
      || msg.includes('Work:BOUNDARY_COVERING')
      || msg.includes('Work:AVOIDING');
}

export function MowQueueProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<QueueState | null>(null);
  const { activeMower } = useActiveMower();
  const sn = activeMower?.sn ?? null;
  // Edge-detect FINISHED: only fire once per transition into Work:FINISHED.
  const wasMowingRef = useRef(false);
  // Coalesce double-advance during the brief window between FINISHED and
  // the next start_navigation actually running.
  const advanceLockRef = useRef(false);

  // Issue #34: queues persisted in SecureStore stayed forever — if a user
  // ever started a multi-map run and the app/mower never reached
  // Work:FINISHED (force-quit, mower error, network, cold reload) the
  // banner reappeared on every cold-start regardless of mower state. Drop
  // any persisted queue that's older than this threshold; a real session
  // never legitimately spans this long.
  const MAX_QUEUE_AGE_MS = 6 * 60 * 60 * 1000; // 6h

  // ── Hydration: load persisted queue when active SN changes ────────
  useEffect(() => {
    if (!sn) {
      setQueue(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const raw = await SecureStore.getItemAsync(storageKey(sn)).catch(() => null);
        if (cancelled) return;
        if (!raw) {
          setQueue(null);
          return;
        }
        const parsed = JSON.parse(raw) as QueueState;
        const ageMs = Date.now() - (parsed.startedAt ?? 0);
        if (ageMs > MAX_QUEUE_AGE_MS) {
          // Stale — never resurrect. Drop the persisted entry too so the
          // next reload starts truly clean.
          SecureStore.deleteItemAsync(storageKey(sn)).catch(() => {});
          setQueue(null);
          return;
        }
        if (parsed.sn === sn && Array.isArray(parsed.remaining) && parsed.remaining.length > 0) {
          setQueue(parsed);
          // Reset edge-detect refs on hydrate so we don't immediately fire.
          wasMowingRef.current = false;
          advanceLockRef.current = false;
        }
      } catch {
        // Ignore — fall back to clean state.
      }
    })();
    return () => { cancelled = true; };
  }, [sn]);

  // ── Auto-clear stale queue when mower is idle on dock ─────────────
  // Even within MAX_QUEUE_AGE_MS, a queue is meaningless once the mower
  // has been parked + idle for a sustained window. Without this guard a
  // brief restart mid-queue (force-quit, mower error after first map)
  // left the banner stuck until the timestamp aged out. Detect "idle on
  // dock" — battery_state=CHARGING/FINISHED, task_mode=0, no Work:* mowing
  // substring — for 60 seconds and self-clear.
  const idleClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sensors = activeMower?.sensors ?? {};
  const batteryState = String(sensors.battery_state ?? '').toUpperCase();
  const taskMode = parseInt(String(sensors.task_mode ?? '0'), 10);
  const liveMsg = String(sensors.msg ?? '');
  const onDockIdle = (batteryState === 'CHARGING' || batteryState === 'FINISHED')
    && taskMode === 0
    && !isMowingMsg(liveMsg);

  useEffect(() => {
    if (!queue || queue.sn !== sn) return;
    if (!onDockIdle) {
      if (idleClearTimer.current) {
        clearTimeout(idleClearTimer.current);
        idleClearTimer.current = null;
      }
      return;
    }
    if (idleClearTimer.current) return; // already armed
    idleClearTimer.current = setTimeout(() => {
      console.log('[MowQueue] idle on dock 60s — clearing stale queue');
      setQueue(null);
      idleClearTimer.current = null;
    }, 60_000);
    return () => {
      if (idleClearTimer.current) {
        clearTimeout(idleClearTimer.current);
        idleClearTimer.current = null;
      }
    };
  }, [queue, sn, onDockIdle]);

  // ── Persist on every mutation ─────────────────────────────────────
  useEffect(() => {
    if (!sn) return;
    if (queue) {
      SecureStore.setItemAsync(storageKey(sn), JSON.stringify(queue)).catch(() => {});
    } else {
      SecureStore.deleteItemAsync(storageKey(sn)).catch(() => {});
    }
  }, [queue, sn]);

  const advanceQueue = useCallback(async (): Promise<void> => {
    setQueue(prev => {
      if (!prev) return null;
      // Drop the just-finished map (index 0).
      const next = prev.remaining.slice(1);
      if (next.length === 0) {
        return null;   // queue drained
      }
      return { ...prev, remaining: next };
    });
  }, []);

  const sendNextStart = useCallback(async (state: QueueState): Promise<void> => {
    const head = state.remaining[0];
    if (!head) return;
    try {
      const url = await getServerUrl();
      if (!url) return;
      const api = new ApiClient(url);
      const wireHeight = Math.max(0, state.cuttingHeight - 2);
      const cmdNum = Date.now() % 100000;
      console.log(`[MowQueue] dispatch ${head.mapName} (idx=${head.mapIdx}) cutterhigh=${wireHeight}`);
      // Multi-map support (spec 2026-05-04): swap the active map slot
      // before each dispatch so the queue can mow ANY canonical slot,
      // not just map0/1/2. Treat swap failure as a fatal queue error
      // — better to abort cleanly than mow the wrong polygon.
      try {
        await api.setActiveMapSlot(state.sn, head.mapIdx);
      } catch (err) {
        console.warn(`[MowQueue] setActiveMapSlot failed for slot=${head.mapIdx}:`, err);
        return;
      }
      await api.sendCommand(state.sn, {
        start_navigation: {
          mapName: 'test',
          area: 0,  // map.yaml swap above makes the legacy area enum irrelevant
          cutterhigh: wireHeight,
          cmd_num: cmdNum,
        },
      });
    } catch (err) {
      console.warn('[MowQueue] start_navigation dispatch failed:', err);
    }
  }, []);

  // ── Watch the active mower's msg for Work:FINISHED transitions ────
  const msg = String(activeMower?.sensors?.msg ?? '');
  const errorStatus = parseInt(String(activeMower?.sensors?.error_status ?? '0').match(/\d+/)?.[0] ?? '0', 10);

  useEffect(() => {
    if (!queue || !sn || queue.sn !== sn) return;
    const mowing = isMowingMsg(msg);
    const finished = msg.includes('Work:FINISHED');

    if (mowing) {
      wasMowingRef.current = true;
      advanceLockRef.current = false;
      return;
    }

    if (wasMowingRef.current && finished && !advanceLockRef.current) {
      if (errorStatus !== 0) {
        // Don't auto-advance into the next map when the previous one
        // ended in an error — the user needs to inspect first.
        console.warn(`[MowQueue] aborting queue, error_status=${errorStatus}`);
        wasMowingRef.current = false;
        setQueue(null);
        return;
      }
      advanceLockRef.current = true;
      console.log(`[MowQueue] Work:FINISHED detected — advancing queue (${queue.remaining.length - 1} left)`);
      // Edge-detect reset.
      wasMowingRef.current = false;
      // Advance + dispatch next after a short settle delay so the
      // mower's internal state has time to flush before the next
      // start_cov_task hits.
      const timer = setTimeout(() => {
        setQueue(prev => {
          if (!prev) return null;
          const next = prev.remaining.slice(1);
          if (next.length === 0) {
            advanceLockRef.current = false;
            return null;
          }
          const updated = { ...prev, remaining: next };
          // Fire the next start_navigation. We deliberately ignore the
          // returned promise — the watcher above picks up the next
          // FINISHED transition naturally.
          void sendNextStart(updated);
          return updated;
        });
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [msg, errorStatus, queue, sn, advanceQueue, sendNextStart]);

  // ── Public API ────────────────────────────────────────────────────
  const enqueue = useCallback(async ({
    sn: enqueueSn, mapIds, cuttingHeight, pathDirection,
  }: { sn: string; mapIds: string[]; cuttingHeight: number; pathDirection: number; }) => {
    if (mapIds.length === 0) return;

    // Translate mapIds → workMap order so we know each map's idx for area
    // encoding. Pull the canonical work-map list off the server so the
    // UI's selection (which only stores ids) maps to the firmware's
    // canonical order.
    let workMaps: MapData[] = [];
    try {
      const url = await getServerUrl();
      if (!url) return;
      const api = new ApiClient(url);
      const res = await api.fetchMaps(enqueueSn);
      workMaps = (res.maps ?? []).filter(m => m.mapType === 'work' && m.mapArea?.length >= 3);
    } catch {
      console.warn('[MowQueue] could not fetch maps, aborting enqueue');
      return;
    }

    const remaining: QueueItem[] = [];
    for (const id of mapIds) {
      const arrayIdx = workMaps.findIndex(m => m.mapId === id);
      if (arrayIdx < 0) continue;
      // Issue #14 / #18: prefer the firmware-canonical slot index from
      // canonicalName ("map0", "map1", ...) over the server's update-order
      // array position. Otherwise the queue dispatches the wrong map.
      const canonicalMatch = (workMaps[arrayIdx].canonicalName ?? '').match(/^map(\d+)/);
      const mapIdx = canonicalMatch ? parseInt(canonicalMatch[1], 10) : arrayIdx;
      remaining.push({
        mapId: id,
        mapName: workMaps[arrayIdx].mapName ?? id,
        mapIdx,
      });
    }
    if (remaining.length === 0) return;

    const state: QueueState = {
      sn: enqueueSn,
      cuttingHeight,
      pathDirection,
      remaining,
      startedAt: Date.now(),
    };
    setQueue(state);
    wasMowingRef.current = false;
    advanceLockRef.current = false;
    await sendNextStart(state);
  }, [sendNextStart]);

  const clear = useCallback(async () => {
    setQueue(null);
    wasMowingRef.current = false;
    advanceLockRef.current = false;
  }, []);

  const value = useMemo(() => ({ queue, enqueue, clear }), [queue, enqueue, clear]);

  return (
    <MowQueueContext.Provider value={value}>
      {children}
    </MowQueueContext.Provider>
  );
}

export function useMowQueue(): MowQueueContextValue {
  return useContext(MowQueueContext);
}
