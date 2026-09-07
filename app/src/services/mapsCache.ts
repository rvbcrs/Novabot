/**
 * Last-known map list per mower, cached on the phone.
 *
 * MappingScreen derives the NEXT slot name (map0, map1, …) from the server's
 * map list. Without a server (BLE mapping far from WiFi) that list came back
 * empty and the screen would start a brand-new "map0" session — overwriting
 * the existing map0 on the mower. Caching the last successful fetch makes
 * naming (and the existing-map overlays) work fully offline.
 *
 * Stored as a JSON file (polygons are far too large for SecureStore's
 * per-item limit). Best effort: every call swallows errors.
 */
import * as FileSystem from 'expo-file-system/legacy';
import type { MapData } from './api';
import { isMapPoint } from '../utils/mapPoints';
import { getUnicomPair } from '../utils/mapChannels';

export interface CachedMap {
  mapId: string;
  mapType: string;
  mapName?: string;
  fileName?: string;
  canonicalName?: string;
  connectedMaps?: [string, string];
  points: Array<{ x: number; y: number }>;
}

/** Older writes stored API rows (`mapArea`) directly; readers expect `points`. */
export function normalizeCachedMaps(maps: unknown): CachedMap[] {
  if (!Array.isArray(maps)) return [];
  return maps.filter(m => m != null && typeof m.mapId === 'string').map(m => {
    const points = Array.isArray(m.points) ? m.points : m.mapArea;
    return {
      mapId: m.mapId,
      mapType: typeof m.mapType === 'string' ? m.mapType : 'work',
      mapName: typeof m.mapName === 'string' ? m.mapName : undefined,
      fileName: typeof m.fileName === 'string' ? m.fileName : undefined,
      canonicalName: typeof m.canonicalName === 'string' ? m.canonicalName : undefined,
      connectedMaps: m.mapType === 'unicom'
        ? getUnicomPair({ mapType: 'unicom', connectedMaps: m.connectedMaps }) ?? undefined
        : undefined,
      // A missing vertex is an unknown edge, not permission to join its neighbours.
      points: Array.isArray(points) && points.every(isMapPoint) ? points : [],
    };
  });
}

/** Keep confirmed phone-side saves until the mower's ZIP reaches the server. */
export function mergePendingMaps(loaded: CachedMap[], cached: CachedMap[]): CachedMap[] {
  const key = (map: CachedMap) => {
    const pair = map.mapType === 'unicom' ? getUnicomPair(map) : null;
    if (pair) return `unicom:${pair.sort().join(':')}`;
    const name = (map.canonicalName ?? map.fileName ?? map.mapName ?? map.mapId).replace(/\.csv$/i, '');
    return `${map.mapType}:${map.mapType === 'work' ? name.match(/^(map\d+)(?:_|$)/)?.[1] ?? name : name}`;
  };
  const loadedKeys = new Set(loaded
    .filter(map => map.mapType !== 'unicom' || map.points.length >= 2)
    .map(key));
  return [...loaded, ...cached.filter(map => map.mapId.startsWith('optimistic-') && !loadedKeys.has(key(map)))];
}

function pathFor(sn: string): string {
  const safe = sn.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${FileSystem.documentDirectory}maps-cache-${safe}.json`;
}

export async function writeMapsCache(sn: string, maps: Array<CachedMap | MapData>): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(pathFor(sn), JSON.stringify({ savedAt: Date.now(), maps: normalizeCachedMaps(maps) }));
  } catch { /* best effort */ }
}

export async function readMapsCache(sn: string): Promise<CachedMap[] | null> {
  try {
    const info = await FileSystem.getInfoAsync(pathFor(sn));
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(pathFor(sn));
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.maps) ? normalizeCachedMaps(parsed.maps) : null;
  } catch {
    return null;
  }
}
