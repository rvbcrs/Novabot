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

export interface CachedMap {
  mapId: string;
  mapType: string;
  mapName?: string;
  fileName?: string;
  canonicalName?: string;
  points: Array<{ x: number; y: number }>;
}

function pathFor(sn: string): string {
  const safe = sn.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${FileSystem.documentDirectory}maps-cache-${safe}.json`;
}

export async function writeMapsCache(sn: string, maps: CachedMap[]): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(pathFor(sn), JSON.stringify({ savedAt: Date.now(), maps }));
  } catch { /* best effort */ }
}

export async function readMapsCache(sn: string): Promise<CachedMap[] | null> {
  try {
    const info = await FileSystem.getInfoAsync(pathFor(sn));
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(pathFor(sn));
    const parsed = JSON.parse(raw) as { maps?: CachedMap[] };
    return Array.isArray(parsed.maps) ? parsed.maps : null;
  } catch {
    return null;
  }
}
