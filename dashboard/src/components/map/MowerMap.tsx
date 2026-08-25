import { useEffect, useState, useCallback, useMemo, useRef, Fragment, type ReactNode } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polygon, Polyline, Tooltip, CircleMarker, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import {
  MapPin, Map as MapIcon, Trash2, Route, Crosshair, Layers,
  SlidersHorizontal, Save, X, RotateCcw, Pencil, Check, Scissors, Navigation,
  ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Flame,
  Fence, Target, XCircle, CheckCircle2, Plus, Minus, Brush, Paintbrush, Eraser,
  Copy, ClipboardPaste, Spline, RefreshCw, Loader2, Move as MoveIcon, Camera, Eye,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MapData, MapCalibration, GpsPoint } from '../../types';
import {
  fetchMaps, fetchAllMaps, fetchTrail, clearTrail, fetchCalibration, saveCalibration,
  deleteMap, renameMap, updateMapArea, createMap,
  navigateToPosition, stopNavigation,
  fetchVirtualWalls, createVirtualWall, deleteVirtualWall,
  calibrateCharger,
  fetchEditGeometry, saveEditDraft, discardEditDrafts, applyEdits, revertEdits,
  refreshPreviewPath, getPlanPath, refreshPlanPath,
  fetchCoveragePlannerRadius, updateCoveragePlannerRadius,
  applyPolygonOffset, fetchPolygonOffset,
  type VirtualWall, type EditGeometryDto, type CoveragePathEntry,
} from '../../api/client';
import { localToGps, gpsToLocal, isUsableChargerGps } from '../../utils/coords';
import { applyBrush, densifyPolygon, hitTestEdge, offsetPolygon, pointInPolygon as pointInPolygonXY, polygonArea, simplifyPolygon, type XY } from '../../utils/editGeometry';
import { paintCircle, eraseCircle, makeValidPolygon } from '../../utils/brushPaint';
import { useToast } from '../common/Toast';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { PolygonEditor } from './PolygonEditor';
import { MapEditBar } from './MapEditBar';
import { MowingStatsCard } from '../status/MowingStatsCard';
import { parseFinishedAreas, prefixedAreaId } from '../../utils/coverPathProgress';
import { PatternOverlay, type PatternPlacement } from '../patterns/PatternOverlay';
import { CameraTile } from './CameraTile';
import { isOpenNovaFirmware } from '../../utils/firmwareCapability';
import { readMowDefaults } from '../../utils/mowDefaults';

// Fix Leaflet default marker icons in Vite
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

// Standaard positie (Nederland)
const DEFAULT_CENTER: [number, number] = [52.1409, 6.231];
const DEFAULT_COVERAGE_RADIUS = 0.61;
const MIN_COVERAGE_RADIUS = 0.2;
const MAX_COVERAGE_RADIUS = 1.2;

function previewMapIdsFromCanonicals(canonicals: string[]): number {
  const weights = new Set<number>();
  for (const canonical of canonicals) {
    const match = canonical.match(/^map(\d+)$/);
    if (!match) continue;
    const idx = Number(match[1]);
    if (idx === 0) weights.add(1);
    else if (idx === 1) weights.add(10);
    else if (idx === 2) weights.add(100);
  }
  const mask = Array.from(weights).reduce((sum, value) => sum + value, 0);
  return mask || 1;
}
// Grace window before a mowing session is considered ended. The msg-based
// `mowingActive` flag briefly drops to false on every between-lane turn, blade
// pause, or obstacle stop; keeping the live plan + progress sticky for this long
// stops those flickers from ending the session (or jumping to the preview).
const LIVE_SESSION_GRACE_MS = 45000;

// ── Obstacle copy/paste (R6) ──────────────────────────────────────
// Clipboard for copying an obstacle and pasting it as a new obstacle draft —
// onto the same work map or a different one, even after switching mowers.
// Points are LOCAL meters (charger = 0,0). Persisted to localStorage so the
// clipboard survives reloads and mower switches.
const OBSTACLE_CLIPBOARD_KEY = 'novabot.obstacleClipboard';
interface ObstacleClipboard {
  points: { x: number; y: number }[];
  sourceName?: string | null;
}
// Small fixed nudge (meters) used as the paste-placement fallback when a map
// view center isn't available, so the pasted obstacle never lands exactly on
// top of the original.
const PASTE_FALLBACK_DELTA = 0.7;

// Kleuren per kaarttype
const AREA_STYLES = {
  work:     { color: '#10b981', fillColor: '#10b981', fillOpacity: 0.25, weight: 2 },   // emerald
  obstacle: { color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.30, weight: 2 },   // red
  unicom:   { color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.20, weight: 2 },   // blue
  default:  { color: '#8b5cf6', fillColor: '#8b5cf6', fillOpacity: 0.25, weight: 2 },   // purple
} as const;

/** Bepaal kaarttype — primair uit mapType veld, fallback op mapId/mapName patronen */
function getAreaStyle(mapType?: string, mapId?: string, mapName?: string | null) {
  if (mapType === 'obstacle') return AREA_STYLES.obstacle;
  if (mapType === 'unicom') return AREA_STYLES.unicom;
  if (mapType === 'work') return AREA_STYLES.work;
  // Fallback voor oude kaarten zonder mapType
  const id = (mapId ?? '').toLowerCase();
  const name = (mapName ?? '').toLowerCase();
  if (id.includes('obstacle') || name.includes('obstakel') || name.includes('obstacle')) return AREA_STYLES.obstacle;
  if (id.includes('unicom') || name.includes('pad naar') || name.includes('kanaal') || name.includes('channel')) return AREA_STYLES.unicom;
  if (id.includes('work') || name.includes('werkgebied') || name.includes('map')) return AREA_STYLES.work;
  return AREA_STYLES.default;
}

interface SignalInfo {
  wifiRssi?: string;
  rtkSat?: string;
  locQuality?: string;
  batteryPower?: string;
  batteryState?: string;
}

interface MowingInfo {
  mowingProgress?: string;
  coveringArea?: string;
  finishedArea?: string;
  workStatus?: string;
  mowSpeed?: string;
  covDirection?: string;
}

interface Props {
  sn: string;
  lat?: string;
  lng?: string;
  /** Mower local-frame position (map_position_x/y). Live + cm-accurate, unlike
   *  the sporadic/base-offset reported GPS — used to place the mower marker. */
  mapX?: string;
  mapY?: string;
  heading?: string;
  /** Mower reachable (online + dashboard socket connected). Kept for callers
   *  that pass live state; idle preview is native/server-side and does not use it. */
  online?: boolean;
  /** True while the mower is actively mowing (Work:RUNNING/NAVIGATING/COVERING/
   *  MOVING — computed in MapTab, mirrors the OpenNova app). Drives the coverage
   *  panel to show the LIVE plan path (get_map_plan_path) instead of refusing,
   *  and to poll it every ~5s while the overlay is shown. */
  mowingActive?: boolean;
  /** True only right after the user starts a mow FROM THE DASHBOARD, until the
   *  mower reports fresh cover data. Hides the previous session's carried-over
   *  green/yellow at a fresh start. Owned by the shell (mirrors the app's
   *  HomeScreen freshSession); monitoring never sets it, so progress always shows. */
  progressSuppressed?: boolean;
  /** Volledige sensor-map (mower.sensors) — voor de MowingStatsCard tijdens maaien. */
  sensors?: Record<string, string>;
  signals?: SignalInfo;
  mowing?: MowingInfo;
  /** Wanneer ingesteld, toon een richting-overlay lijn op de kaart (graden, 0=N) */
  pathDirectionPreview?: number | null;
  /** Bumped (nonce) by the Start-sheet "Preview" button to show a FRESH coverage
   *  preview at the configured cov_direction for the selected work-area
   *  canonical(s) (one, or all when "All work areas" is selected). */
  previewRequest?: { nonce: number; covDirection: number; canonicals: string[]; polygonArea?: Array<{ latitude: number; longitude: number }> } | null;
  /** Callback when a new map is saved (draw/edit) — used for draw-to-start flow */
  onMapSaved?: (map: MapData) => void;
  /** Live growing polygon boundary during autonomous mapping (report_state_map_outline) */
  liveOutline?: Array<{ lat: number; lng: number }> | null;
  /** Pattern placement preview on the map */
  patternPlacement?: PatternPlacement | null;
  /** Callback when user clicks on map to place a pattern */
  onMapClickForPattern?: (center: { lat: number; lng: number }) => void;
  /** Offset polygon preview (dashed) */
  offsetPreview?: Array<{ lat: number; lng: number }> | null;
  /** Afgelegde maai-banen van demo simulator */
  coveredLanes?: Array<{ lat1: number; lng1: number; lat2: number; lng2: number }> | null;
  /** Mower control buttons (start/pause/stop/…) rendered at the left of the
   *  floating tool-bar over the map. Supplied by the shell so the big controls
   *  component stays intact; the bar just hosts it. */
  controlsSlot?: ReactNode;
  /** Reports when the map is actually fetching the mower coverage preview, so
   *  the shell can keep the Preview button disabled until the path is back. */
  onPreviewLoading?: (loading: boolean) => void;
}

function locColor(quality: number): string {
  if (quality >= 80) return 'text-green-400';
  if (quality >= 50) return 'text-yellow-400';
  return 'text-red-400';
}

function RecenterMap({ position, hasManualInteraction, waitForFit }: { position: [number, number]; hasManualInteraction: boolean; waitForFit: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (waitForFit || hasManualInteraction) return;
    map.setView(position, map.getZoom());
  }, [map, position[0], position[1], hasManualInteraction, waitForFit]);
  return null;
}

/** Auto-fit map to polygon bounds on load */
function FitToMaps({ maps, onFitted }: { maps: Array<{ mapArea: Array<{ lat: number; lng: number }> }>; onFitted?: () => void }) {
  const map = useMap();
  const [fitted, setFitted] = useState(false);

  useEffect(() => {
    if (fitted || maps.length === 0) return;
    const allPoints: [number, number][] = [];
    for (const m of maps) {
      for (const p of m.mapArea) {
        allPoints.push([p.lat, p.lng]);
      }
    }
    if (allPoints.length < 2) return;
    const bounds = L.latLngBounds(allPoints);
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 24 });
    setFitted(true);
    onFitted?.();
  }, [map, maps, fitted, onFitted]);

  return null;
}

/** Invalidate Leaflet map size once on mount */
function ResizeHandler() {
  const map = useMap();
  useEffect(() => {
    map.invalidateSize();
    const t1 = setTimeout(() => map.invalidateSize(), 100);
    const t2 = setTimeout(() => map.invalidateSize(), 350);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [map]);
  return null;
}

/** Clip een lijn aan een polygon — geeft segmenten binnen de polygon terug. */
export function clipLineToPolygon(
  line: [[number, number], [number, number]],
  polygon: Array<{ lat: number; lng: number }>,
): [number, number][][] {
  const pts = polygon.map(p => [p.lat, p.lng] as [number, number]);
  const n = pts.length;
  if (n < 3) return [];
  const [aLat, aLng] = line[0];
  const [bLat, bLng] = line[1];
  const dLat = bLat - aLat;
  const dLng = bLng - aLng;
  const tValues: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const edLat = pts[j][0] - pts[i][0];
    const edLng = pts[j][1] - pts[i][1];
    const denom = dLat * edLng - dLng * edLat;
    if (Math.abs(denom) < 1e-15) continue;
    const t = ((pts[i][0] - aLat) * edLng - (pts[i][1] - aLng) * edLat) / denom;
    const u = ((pts[i][0] - aLat) * dLng - (pts[i][1] - aLng) * dLat) / denom;
    if (u >= 0 && u <= 1 && t >= 0 && t <= 1) tValues.push(t);
  }
  if (pointInPolygon(aLat, aLng, polygon)) tValues.push(0);
  if (pointInPolygon(bLat, bLng, polygon)) tValues.push(1);
  tValues.sort((a, b) => a - b);
  const segments: [number, number][][] = [];
  for (let i = 0; i < tValues.length - 1; i++) {
    const midT = (tValues[i] + tValues[i + 1]) / 2;
    if (pointInPolygon(aLat + dLat * midT, aLng + dLng * midT, polygon)) {
      segments.push([
        [aLat + dLat * tValues[i], aLng + dLng * tValues[i]],
        [aLat + dLat * tValues[i + 1], aLng + dLng * tValues[i + 1]],
      ]);
    }
  }
  return segments;
}

/** Coverage visualisatie — dunne lijntjes ~3px uit elkaar, geclipt aan polygon.
 *  Per lane worden meerdere parallelle dunne lijnen gerenderd, net als de Novabot app. */
export function CoverageStripes({ lanes, workPolys }: {
  lanes: Array<{ lat1: number; lng1: number; lat2: number; lng2: number }>;
  workPolys: Array<Array<{ lat: number; lng: number }>>;
}) {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });

  const segments = useMemo(() => {
    if (lanes.length === 0 || workPolys.length === 0) return [];

    const lat = lanes[0].lat1;
    const metersPerPixel = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    const spacingMeters = metersPerPixel * 3;  // 3px spacing
    const laneWidth = 0.28;
    const linesPerLane = Math.max(1, Math.round(laneWidth / spacingMeters));

    const result: [number, number][][] = [];

    for (const lane of lanes) {
      const dLat = lane.lat2 - lane.lat1;
      const dLng = lane.lng2 - lane.lng1;
      const len = Math.sqrt(dLat * dLat + dLng * dLng);
      if (len === 0) continue;
      const pLat = -dLng / len;
      const pLng = dLat / len;

      const cosLat = Math.cos(lat * Math.PI / 180);
      const mPerDeg = Math.sqrt((pLat * 111000) ** 2 + (pLng * 111000 * cosLat) ** 2);
      const halfWidthDeg = (laneWidth / 2) / mPerDeg;
      const stepDeg = linesPerLane > 1 ? laneWidth / mPerDeg / (linesPerLane - 1) : 0;

      const subLines: [[number, number], [number, number]][] = [];
      if (linesPerLane === 1) {
        subLines.push([[lane.lat1, lane.lng1], [lane.lat2, lane.lng2]]);
      } else {
        for (let i = 0; i < linesPerLane; i++) {
          const offset = -halfWidthDeg + i * stepDeg;
          subLines.push([
            [lane.lat1 + pLat * offset, lane.lng1 + pLng * offset],
            [lane.lat2 + pLat * offset, lane.lng2 + pLng * offset],
          ]);
        }
      }

      // Clip elke sub-lijn aan alle work polygons
      for (const sl of subLines) {
        for (const poly of workPolys) {
          const clipped = clipLineToPolygon(sl, poly);
          for (const seg of clipped) result.push(seg);
        }
      }
    }
    return result;
  }, [lanes, workPolys, zoom]);

  // Edge lines: eerste en laatste sub-lijn per lane voor witte rand
  const edgeSegments = useMemo(() => {
    if (lanes.length === 0 || workPolys.length === 0) return [];

    const lat = lanes[0].lat1;
    const metersPerPixel = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    const spacingMeters = metersPerPixel * 3;
    const laneWidth = 0.28;
    const linesPerLane = Math.max(1, Math.round(laneWidth / spacingMeters));

    if (linesPerLane <= 2) return []; // te weinig lijnen voor edge effect

    const result: [number, number][][] = [];

    for (const lane of lanes) {
      const dLat = lane.lat2 - lane.lat1;
      const dLng = lane.lng2 - lane.lng1;
      const len = Math.sqrt(dLat * dLat + dLng * dLng);
      if (len === 0) continue;
      const pLat = -dLng / len;
      const pLng = dLat / len;

      const cosLat = Math.cos(lat * Math.PI / 180);
      const mPerDeg = Math.sqrt((pLat * 111000) ** 2 + (pLng * 111000 * cosLat) ** 2);
      const halfWidthDeg = (laneWidth / 2) / mPerDeg;

      // Alleen de buitenste twee lijnen (edges)
      for (const offset of [-halfWidthDeg, halfWidthDeg]) {
        const edgeLine: [[number, number], [number, number]] = [
          [lane.lat1 + pLat * offset, lane.lng1 + pLng * offset],
          [lane.lat2 + pLat * offset, lane.lng2 + pLng * offset],
        ];
        for (const poly of workPolys) {
          const clipped = clipLineToPolygon(edgeLine, poly);
          for (const seg of clipped) result.push(seg);
        }
      }
    }
    return result;
  }, [lanes, workPolys, zoom]);

  if (segments.length === 0) return null;

  return (
    <>
      {edgeSegments.length > 0 && (
        <Polyline
          positions={edgeSegments}
          pathOptions={{
            color: 'rgba(255,255,255,0.5)',
            weight: 2,
            opacity: 1,
            lineCap: 'butt',
          }}
        />
      )}
      <Polyline
        positions={segments}
        pathOptions={{
          color: '#026c4aff',
          weight: 3.5,
          opacity: 0.25,
          lineCap: 'butt',
        }}
      />
    </>
  );
}

/** Click handler for draw mode — adds points to the polygon */
function DrawClickHandler({ onPoint }: { onPoint: (latlng: [number, number]) => void }) {
  const map = useMap();
  useEffect(() => {
    const handler = (e: L.LeafletMouseEvent) => onPoint([e.latlng.lat, e.latlng.lng]);
    map.on('click', handler);
    map.getContainer().style.cursor = 'crosshair';
    return () => { map.off('click', handler); map.getContainer().style.cursor = ''; };
  }, [map, onPoint]);
  return null;
}

/** Push/pull brush pointer handler (R3). Translates Leaflet mouse events into
 *  LOCAL meter coords (caller supplies the GPS→local projection) and drives the
 *  stroke lifecycle. Disables map dragging while a stroke is active, like the
 *  draw handler. onDown returns true if it grabbed an edge (stroke begins). */
function BrushPointerHandler({
  toLocal, onDown, onMove, onUp,
}: {
  toLocal: (latlng: L.LatLng) => XY;
  onDown: (m: XY) => boolean;
  onMove: (m: XY) => void;
  onUp: () => void;
}) {
  const map = useMap();
  const active = useRef(false);
  // Keep the latest callbacks in a ref so the Leaflet listeners bind ONCE (on
  // `map`). Re-binding per render would tear down mid-stroke (cleanup runs
  // while active.current is true → premature dragging.enable + stroke abort).
  const cb = useRef({ toLocal, onDown, onMove, onUp });
  useEffect(() => { cb.current = { toLocal, onDown, onMove, onUp }; });
  useEffect(() => {
    const down = (e: L.LeafletMouseEvent) => {
      if (cb.current.onDown(cb.current.toLocal(e.latlng))) {
        active.current = true;
        map.dragging.disable();
      }
    };
    const move = (e: L.LeafletMouseEvent) => {
      if (active.current) cb.current.onMove(cb.current.toLocal(e.latlng));
    };
    const up = () => {
      if (active.current) {
        active.current = false;
        map.dragging.enable();
        cb.current.onUp();
      }
    };
    map.on('mousedown', down);
    map.on('mousemove', move);
    map.on('mouseup', up);
    map.getContainer().style.cursor = 'crosshair';
    return () => {
      map.off('mousedown', down);
      map.off('mousemove', move);
      map.off('mouseup', up);
      if (active.current) { map.dragging.enable(); active.current = false; }
      map.getContainer().style.cursor = '';
    };
  }, [map]);
  return null;
}

/** Paint/erase brush pointer handler. Mirrors BrushPointerHandler but the brush
 *  op is applied on mousedown too (no edge gating) and accumulated per mousemove,
 *  like a real paint stroke. onDown returns true to begin the stroke. A circular
 *  cursor preview (paintRadius meters) follows the pointer while in paint mode. */
function PaintPointerHandler({
  toLatLng, toLocal, radius, onDown, onMove, onUp,
}: {
  toLatLng: (latlng: L.LatLng) => L.LatLng;
  toLocal: (latlng: L.LatLng) => XY;
  radius: number;
  onDown: (m: XY) => boolean;
  onMove: (m: XY) => void;
  onUp: () => void;
}) {
  const map = useMap();
  const active = useRef(false);
  const cursorRef = useRef<L.Circle | null>(null);
  // Keep the latest callbacks in a ref so the Leaflet listeners bind ONCE.
  const cb = useRef({ toLatLng, toLocal, onDown, onMove, onUp, radius });
  useEffect(() => { cb.current = { toLatLng, toLocal, onDown, onMove, onUp, radius }; });
  useEffect(() => {
    const cursor = L.circle(map.getCenter(), {
      radius: cb.current.radius,
      color: '#f59e0b', weight: 1, fillColor: '#f59e0b', fillOpacity: 0.12,
      interactive: false, opacity: 0,
    }).addTo(map);
    cursorRef.current = cursor;
    const down = (e: L.LeafletMouseEvent) => {
      if (cb.current.onDown(cb.current.toLocal(e.latlng))) {
        active.current = true;
        map.dragging.disable();
      }
    };
    const move = (e: L.LeafletMouseEvent) => {
      cursor.setLatLng(cb.current.toLatLng(e.latlng));
      cursor.setRadius(cb.current.radius);
      cursor.setStyle({ opacity: 1 });
      if (active.current) cb.current.onMove(cb.current.toLocal(e.latlng));
    };
    const up = () => {
      if (active.current) {
        active.current = false;
        map.dragging.enable();
        cb.current.onUp();
      }
    };
    map.on('mousedown', down);
    map.on('mousemove', move);
    map.on('mouseup', up);
    map.getContainer().style.cursor = 'crosshair';
    return () => {
      map.off('mousedown', down);
      map.off('mousemove', move);
      map.off('mouseup', up);
      cursor.remove();
      cursorRef.current = null;
      if (active.current) { map.dragging.enable(); active.current = false; }
      map.getContainer().style.cursor = '';
    };
  }, [map]);
  return null;
}

/** Move (translate) pointer handler. Mirrors PaintPointerHandler/BrushPointerHandler:
 *  bound ONCE (listeners read the latest callbacks via a ref so they never re-bind
 *  mid-drag). The drag begins only when the down point is INSIDE the target polygon
 *  — otherwise the map pans normally. onDown returns true to begin a drag (which
 *  disables map dragging); onMove gets the live local point; onUp commits. */
function MovePointerHandler({
  toLocal, onDown, onMove, onUp,
}: {
  toLocal: (latlng: L.LatLng) => XY;
  onDown: (m: XY) => boolean;
  onMove: (m: XY) => void;
  onUp: () => void;
}) {
  const map = useMap();
  const active = useRef(false);
  const cb = useRef({ toLocal, onDown, onMove, onUp });
  useEffect(() => { cb.current = { toLocal, onDown, onMove, onUp }; });
  useEffect(() => {
    const down = (e: L.LeafletMouseEvent) => {
      if (cb.current.onDown(cb.current.toLocal(e.latlng))) {
        active.current = true;
        map.dragging.disable();
      }
    };
    const move = (e: L.LeafletMouseEvent) => {
      if (active.current) cb.current.onMove(cb.current.toLocal(e.latlng));
    };
    const up = () => {
      if (active.current) {
        active.current = false;
        map.dragging.enable();
        cb.current.onUp();
      }
    };
    map.on('mousedown', down);
    map.on('mousemove', move);
    map.on('mouseup', up);
    map.getContainer().style.cursor = 'move';
    return () => {
      map.off('mousedown', down);
      map.off('mousemove', move);
      map.off('mouseup', up);
      if (active.current) { map.dragging.enable(); active.current = false; }
      map.getContainer().style.cursor = '';
    };
  }, [map]);
  return null;
}

/** Deselect polygons when clicking on empty map area */
function MapClickDeselect({ onDeselect }: { onDeselect: () => void }) {
  const map = useMap();
  useEffect(() => {
    const handler = () => onDeselect();
    map.on('click', handler);
    return () => { map.off('click', handler); };
  }, [map, onDeselect]);
  return null;
}

/** Capture the live Leaflet map instance into a ref so component-scope code
 *  (e.g. obstacle paste placement) can read the current view center without
 *  living inside a MapContainer child. */
function MapInstanceCapture({ mapRef }: { mapRef: React.MutableRefObject<L.Map | null> }) {
  const map = useMap();
  useEffect(() => {
    mapRef.current = map;
    return () => { mapRef.current = null; };
  }, [map, mapRef]);
  return null;
}

/** Track user interaction so we don't fight RecenterMap */
function UserInteractionTracker({ onInteract }: { onInteract: () => void }) {
  const map = useMap();
  useEffect(() => {
    const handler = () => onInteract();
    map.on('dragstart', handler);
    map.on('zoomstart', handler);
    return () => {
      map.off('dragstart', handler);
      map.off('zoomstart', handler);
    };
  }, [map, onInteract]);
  return null;
}

// Issue #36: PDOK Luchtfoto only covers the Netherlands, so users outside
// NL saw white tiles. Switch to Esri World Imagery — global coverage, free
// for low-traffic use, no API key. Resolution is slightly lower than PDOK
// for NL parcels but it's the only sane global default. A future setting
// could let the operator paste a custom XYZ template (Mapbox, Google,
// regional aerial provider) if they want better resolution.
// Wereldwijd: één globale default (Esri) + per-regio hi-res providers die
// alleen verschijnen / auto-geselecteerd worden waar ze geldig zijn. `bounds`
// = [zuid, west, noord, oost] (lat/lng); zonder bounds = globaal. Nieuwe landen
// toevoegen = één entry erbij met de juiste WMTS-URL + bounds.
interface TileLayerDef {
  label: string;
  url: string;
  attribution: string;
  maxNativeZoom: number;
  maxZoom: number;
  bounds?: [number, number, number, number];
}

const TILE_LAYERS: Record<string, TileLayerDef> = {
  satellite: {
    label: 'Esri satelliet (globaal)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    maxNativeZoom: 19,
    maxZoom: 25,
  },
  // Google satelliet — vaak hoge resolutie, maar ONOFFICIËLE tile-URL (Google
  // Maps ToS); kan zonder waarschuwing breken. Globaal, bewust niet default.
  google: {
    label: 'Google satelliet (hi-res, onofficieel)',
    url: 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
    attribution: 'Imagery &copy; Google',
    maxNativeZoom: 20,
    maxZoom: 25,
  },
  // ── Regionale hi-res (officiële open data) ──
  // PDOK Actueel orthoHR — officiële NL luchtfoto, ~8 cm. Alleen Nederland.
  pdok: {
    label: 'PDOK luchtfoto (NL, ~8 cm)',
    url: 'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg',
    attribution: '&copy; <a href="https://www.pdok.nl">PDOK</a> / Beeldmateriaal Nederland',
    maxNativeZoom: 21,
    maxZoom: 25,
    bounds: [50.7, 3.2, 53.7, 7.3],
  },
  // USGS National Map imagery — officiële VS luchtfoto (NAIP), hi-res. Alleen VS.
  usgs: {
    label: 'USGS imagery (VS)',
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery &copy; USGS / The National Map',
    maxNativeZoom: 20,
    maxZoom: 25,
    bounds: [24.5, -125, 49.5, -66.9],
  },
  street: {
    label: 'Straatkaart (OSM)',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    maxNativeZoom: 19,
    maxZoom: 25,
  },
};

type TileLayerKey = string;

function tileLayerInBounds(def: TileLayerDef, lat: number | null, lng: number | null): boolean {
  if (!def.bounds) return true; // globaal
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const [s, w, n, e] = def.bounds;
  return lat >= s && lat <= n && lng >= w && lng <= e;
}

// ── Calibration transform ────────────────────────────────────────

// Meters-per-graad, identiek aan utils/coords.ts (gpsToLocal). Zo gebruiken de
// maai-verschuif-preview en de server-side apply-offset exact dezelfde schaal.
const DEG_TO_M = 111320;

// Lokaal frame: +x = oost, +y = noord (uit gpsToLocal). Converteer een offset
// in meters naar de graden-offset die de preview (calibratePoints) gebruikt.
function metersToOffsetDeg(dxM: number, dyM: number, latDeg: number): { offsetLat: number; offsetLng: number } {
  const cosLat = Math.cos((latDeg * Math.PI) / 180);
  return { offsetLat: dyM / DEG_TO_M, offsetLng: dxM / (DEG_TO_M * cosLat) };
}

// Omgekeerde conversie: graden-offset → meters, voor de apply-offset call.
function offsetDegToMeters(offsetLat: number, offsetLng: number, latDeg: number): { dxM: number; dyM: number } {
  const cosLat = Math.cos((latDeg * Math.PI) / 180);
  return { dxM: offsetLng * DEG_TO_M * cosLat, dyM: offsetLat * DEG_TO_M };
}

// Mirror van isToChargeUnicomName in server/src/services/polygonOffset.ts: het
// eerste punt van een `mapNtocharge_unicom` polygoon is het dok-anker en schuift
// NOOIT mee, zodat de dok-pose / pos.json-origin vast blijft.
const TO_CHARGE_UNICOM_RE = /^map\d+tocharge_unicom$/;
function isToChargeUnicomName(name: string | null | undefined): boolean {
  return !!name && TO_CHARGE_UNICOM_RE.test(name);
}

/** Apply calibration (manual offset + rotation + scale) to polygon points.
 *  Server converteert lokaal→GPS met charger als origin — anchor offset is niet meer nodig.
 *  excludeAnchor0: bij de `mapNtocharge_unicom` polygoon krijgt punt 0 GEEN handmatige
 *  offset, exact zoals server-side shiftPoints. Zo is de preview WYSIWYG met wat de
 *  maaier doet (het dok-anker blijft staan). */
function calibratePoints(
  points: Array<{ lat: number; lng: number }>,
  cal: MapCalibration,
  center: { lat: number; lng: number },
  excludeAnchor0 = false,
): [number, number][] {
  const totalOffLat = cal.offsetLat;
  const totalOffLng = cal.offsetLng;

  if (totalOffLat === 0 && totalOffLng === 0 && cal.rotation === 0 && cal.scale === 1) {
    return points.map(p => [p.lat, p.lng]);
  }

  const rad = (cal.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  return points.map((p, i) => {
    // Translate to center
    let dLat = p.lat - center.lat;
    let dLng = p.lng - center.lng;

    // Scale
    dLat *= cal.scale;
    dLng *= cal.scale;

    // Rotate
    const rLat = dLat * cos - dLng * sin;
    const rLng = dLat * sin + dLng * cos;

    // Dok-anker (unicom punt 0) krijgt geen handmatige offset (zie shiftPoints).
    const offLat = excludeAnchor0 && i === 0 ? 0 : totalOffLat;
    const offLng = excludeAnchor0 && i === 0 ? 0 : totalOffLng;

    // Translate back + manual offset
    return [center.lat + rLat + offLat, center.lng + rLng + offLng] as [number, number];
  });
}

const DEFAULT_CAL: MapCalibration = { offsetLat: 0, offsetLng: 0, rotation: 0, scale: 1 };

type AreaType = 'work' | 'obstacle' | 'unicom';

// ── Edit-history snapshot stack (client-side undo/redo, R6) ──────────
// A "draft snapshot" is the full set of currently-pending drafts, each entry
// carrying enough to re-create it via saveEditDraft. Undo/redo move a pointer
// over a stack of these snapshots and replay them through the EXISTING draft
// endpoints (discardEditDrafts → re-save each entry). No server change.
type DraftEntry =
  | { kind: 'edit'; canonical: string; points: { x: number; y: number }[] }
  | { kind: 'delete'; canonical: string }
  | { kind: 'new'; mapType: 'obstacle'; parentMap: string; points: { x: number; y: number }[] };
type DraftSnapshot = DraftEntry[];

const HISTORY_CAP = 50;

/** Derive a draft snapshot from the freshly-fetched edit geometry. Each map
 *  with a non-null draft contributes one entry: new obstacle, delete, or edit. */
function snapshotOf(geom: EditGeometryDto | null): DraftSnapshot {
  if (!geom) return [];
  const snap: DraftSnapshot = [];
  for (const entry of geom.maps) {
    const draft = entry.draft;
    if (!draft) continue;
    if (draft.isNew) {
      // New obstacle drawn this session; needs a parent work map to re-create.
      if (entry.parentMap) {
        snap.push({ kind: 'new', mapType: 'obstacle', parentMap: entry.parentMap, points: draft.points.map(p => ({ x: p.x, y: p.y })) });
      }
    } else if (draft.deleted) {
      snap.push({ kind: 'delete', canonical: entry.canonical });
    } else {
      snap.push({ kind: 'edit', canonical: entry.canonical, points: draft.points.map(p => ({ x: p.x, y: p.y })) });
    }
  }
  return snap;
}

// ── Mower marker icon ────────────────────────────────────────────

function makeMowerIcon(heading: number) {
  // PNG bovenaanzicht: voorkant wijst naar rechts (= 90° compass).
  // CSS rotate(0deg) = geen rotatie → maaier wijst rechts.
  // Compass: 0°=N(omhoog), 90°=E(rechts). Offset -90° corrigeert dit.
  const cssRotation = heading - 90;
  return L.divIcon({
    className: '',
    html: `<div style="width:36px;height:36px;transform:rotate(${cssRotation}deg);display:flex;align-items:center;justify-content:center">
      <img src="/mower/lawn_mower.png" style="width:32px;height:20px;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.4))" />
    </div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}

// ── Charger marker icon ────────────────────────────────────────
function makeChargerIcon(live = false) {
  const ring = live
    ? `<div style="position:absolute;inset:-3px;border:2px solid #22c55e;border-radius:50%;opacity:0.8"></div>`
    : '';
  return L.divIcon({
    className: '',
    html: `<div style="width:36px;height:36px;position:relative;display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.4))">
      ${ring}
      <svg viewBox="0 0 32 32" width="28" height="28">
        <path d="M16 3 L28 14 L24 14 L24 27 L8 27 L8 14 L4 14 Z" fill="#f59e0b" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M18 12 L13 19 L16 19 L14 25 L21 17 L17 17 Z" fill="white" opacity="0.95"/>
      </svg>
    </div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}

// ── Point-in-polygon (ray casting) ──────────────────────────────

function pointInPolygon(lat: number, lng: number, polygon: Array<{ lat: number; lng: number }>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = polygon[i].lat, xi = polygon[i].lng;
    const yj = polygon[j].lat, xj = polygon[j].lng;
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Calculate polygon area in m² using Shoelace on GPS coords */
function polygonAreaM2(points: Array<{ lat: number; lng: number }>): number {
  if (points.length < 3) return 0;
  const MpD = 111320;
  const centerLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const cosLat = Math.cos(centerLat * Math.PI / 180);
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = (points[i].lng - points[0].lng) * MpD * cosLat;
    const yi = (points[i].lat - points[0].lat) * MpD;
    const xj = (points[j].lng - points[0].lng) * MpD * cosLat;
    const yj = (points[j].lat - points[0].lat) * MpD;
    area += xi * yj - xj * yi;
  }
  return Math.abs(area) / 2;
}

/** Length of a polyline in meters on GPS coords (for unicom channels) */
function polylineLengthM(points: Array<{ lat: number; lng: number }>): number {
  if (points.length < 2) return 0;
  const MpD = 111320;
  const centerLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const cosLat = Math.cos(centerLat * Math.PI / 180);
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = (points[i].lng - points[i - 1].lng) * MpD * cosLat;
    const dy = (points[i].lat - points[i - 1].lat) * MpD;
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

// ── Click-to-place charger component ────────────────────────────
function ChargerPlacer({ onPlace }: { onPlace: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPlace(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

// ── Nudge step: ~0.5m in degrees ─────────────────────────────────
// Fijne meter-stap voor het verschuiven van het maaigebied. 5 cm zodat een
// 10 cm-correctie in twee klikken haalbaar is (de oude graden-stap was ~0.5 m).
const NUDGE_STEP_M = 0.05;

/** Click handler for pattern placement */
function PatternClickHandler({ onClick }: { onClick: (center: { lat: number; lng: number }) => void }) {
  const map = useMap();
  useEffect(() => {
    const handler = (e: L.LeafletMouseEvent) => onClick({ lat: e.latlng.lat, lng: e.latlng.lng });
    map.on('click', handler);
    map.getContainer().style.cursor = 'crosshair';
    return () => { map.off('click', handler); map.getContainer().style.cursor = ''; };
  }, [map, onClick]);
  return null;
}

/** Click handler for navigate-to mode */
function NavigateClickHandler({ onClick }: { onClick: (lat: number, lng: number) => void }) {
  const map = useMap();
  useEffect(() => {
    const handler = (e: L.LeafletMouseEvent) => onClick(e.latlng.lat, e.latlng.lng);
    map.on('click', handler);
    map.getContainer().style.cursor = 'crosshair';
    return () => { map.off('click', handler); map.getContainer().style.cursor = ''; };
  }, [map, onClick]);
  return null;
}

/** Click handler for virtual wall drawing (two-point rectangle) */
function WallDrawClickHandler({ onPoint }: { onPoint: (lat: number, lng: number) => void }) {
  const map = useMap();
  useEffect(() => {
    const handler = (e: L.LeafletMouseEvent) => onPoint(e.latlng.lat, e.latlng.lng);
    map.on('click', handler);
    map.getContainer().style.cursor = 'crosshair';
    return () => { map.off('click', handler); map.getContainer().style.cursor = ''; };
  }, [map, onPoint]);
  return null;
}

/** Navigate-to target icon */
function makeTargetIcon() {
  return L.divIcon({
    className: '',
    html: `<div style="width:32px;height:32px">
      <svg viewBox="0 0 32 32" width="32" height="32">
        <circle cx="16" cy="16" r="12" fill="#3b82f6" stroke="white" stroke-width="2" opacity="0.85"/>
        <circle cx="16" cy="16" r="5" fill="white" opacity="0.9"/>
        <circle cx="16" cy="16" r="2" fill="#3b82f6"/>
      </svg>
    </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

const targetIcon = makeTargetIcon();

// ── Confetti celebration ──────────────────────────────────────

const CONFETTI_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#22d3ee'];

function ConfettiPiece({ color, left, delay, duration, size, wobble }: {
  color: string; left: number; delay: number; duration: number; size: number; wobble: number;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: `${left}%`,
        top: -20,
        width: size,
        height: size * 0.6,
        backgroundColor: color,
        borderRadius: 2,
        opacity: 0,
        animation: `confetti-fall ${duration}s ease-in ${delay}s forwards`,
        '--wobble': `${wobble}px`,
      } as React.CSSProperties}
    />
  );
}

function CelebrationOverlay({ area, onDismiss }: { area: number; onDismiss: () => void }) {
  const pieces = useMemo(() =>
    Array.from({ length: 60 }, (_, i) => ({
      id: i,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      left: Math.random() * 100,
      delay: Math.random() * 2,
      duration: 2.5 + Math.random() * 2.5,
      size: 5 + Math.random() * 8,
      wobble: (Math.random() - 0.5) * 100,
    })),
  []);

  return (
    <div className="absolute inset-0 z-[2000] overflow-hidden">
      <style>{`
        @keyframes confetti-fall {
          0%   { transform: translateY(0) translateX(0) rotate(0deg); opacity: 1; }
          25%  { transform: translateY(25vh) translateX(var(--wobble)) rotate(180deg); opacity: 1; }
          50%  { transform: translateY(50vh) translateX(calc(var(--wobble) * -0.5)) rotate(360deg); opacity: 0.8; }
          100% { transform: translateY(110vh) translateX(var(--wobble)) rotate(720deg); opacity: 0; }
        }
        @keyframes celebration-pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.05); }
        }
        @keyframes celebration-appear {
          0% { opacity: 0; transform: scale(0.8); }
          100% { opacity: 1; transform: scale(1); }
        }
      `}</style>

      {pieces.map(p => <ConfettiPiece key={p.id} {...p} />)}

      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div
          className="pointer-events-auto bg-gray-900/95 backdrop-blur-lg border border-emerald-500/40 rounded-2xl p-6 shadow-2xl text-center max-w-xs"
          style={{ animation: 'celebration-appear 0.4s ease-out forwards' }}
        >
          <div className="text-5xl mb-3" style={{ animation: 'celebration-pulse 1.5s ease-in-out infinite' }}>
            🎉
          </div>
          <h3 className="text-lg font-bold text-emerald-400 mb-1">Maaien voltooid!</h3>
          <p className="text-sm text-gray-400 mb-1">
            100% — Alle banen gemaaid
          </p>
          {area > 0 && (
            <p className="text-xs text-gray-500 mb-4">
              {area.toFixed(0)} m&sup2; afgerond
            </p>
          )}
          <button
            onClick={onDismiss}
            className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors shadow-lg shadow-emerald-900/40"
          >
            Sluiten
          </button>
        </div>
      </div>
    </div>
  );
}

export function MowerMap({ sn, lat, lng, mapX, mapY, heading, mowingActive, progressSuppressed, sensors, signals, mowing, pathDirectionPreview, previewRequest, onMapSaved: _onMapSaved, liveOutline, patternPlacement, onMapClickForPattern, offsetPreview, coveredLanes, controlsSlot, onPreviewLoading }: Props) {
  const { t } = useTranslation();
  const mowingSensors = sensors ?? {};
  // ── Sticky live-session flag (hysteresis) ───────────────────────────
  // `mowingActive` (derived from the mower's status msg) briefly drops to false
  // on every between-lane turn, blade pause, or obstacle stop. Those flickers
  // must NOT end the on-screen live plan + progress, and must never let the
  // display fall back to the generated preview. `liveSession` rises instantly
  // with mowingActive but only falls after a sustained pause, so brief
  // blade-stops keep the live coverage exactly as the OpenNova app does.
  const [liveSession, setLiveSession] = useState(false);
  const liveSessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (mowingActive) {
      if (liveSessionTimerRef.current) { clearTimeout(liveSessionTimerRef.current); liveSessionTimerRef.current = null; }
      setLiveSession(true);
    } else if (!liveSessionTimerRef.current) {
      liveSessionTimerRef.current = setTimeout(() => {
        liveSessionTimerRef.current = null;
        setLiveSession(false);
      }, LIVE_SESSION_GRACE_MS);
    }
  }, [mowingActive]);
  useEffect(() => () => { if (liveSessionTimerRef.current) clearTimeout(liveSessionTimerRef.current); }, []);

  // Fresh-session coverage suppression. Owned by the dashboard shell (mirrors the
  // app's HomeScreen `freshSession`, which "doet het altijd prima"): it arms ONLY
  // when the user starts a mow from the dashboard, and clears the moment the mower
  // reports fresh cover data (finished_area/cover_map_id change), goes idle/charging,
  // or after a safety timeout. Monitoring a mow started elsewhere — or opening the
  // map mid-session, or resuming after a recharge/obstacle pause — never arms it, so
  // live progress is always shown. The old liveSession-edge heuristic re-armed on
  // every (re)entry, which hid green/yellow until the next lane completed (the
  // progress lines flickering on/off the user reported).
  const progressIsStale = !!progressSuppressed;

  // A coverage session stays "live" for the overlay not only while actively
  // mowing, but also while PAUSED (Work:USER_STOP/PAUSED) or RETURNING for a
  // recharge — the mower is still mid-task. In those states we keep the live
  // progress (green mowed + amber current lane) on screen instead of reverting to
  // the cyan idle preview. We read `msg` directly because task_mode is not
  // reliably reported during a pause. It ends only on Work:CANCELLED/FINISHED
  // (true stop / completion) — then the overlay falls back to the idle preview.
  const coverageSessionActive = (() => {
    const m = mowingSensors.msg ?? '';
    if (/Work:(CANCELLED|FINISHED)/.test(m)) return false;
    return (
      /Work:(RUNNING|COVERING|NAVIGATING|BOUNDARY_COVERING|AVOIDING|MOVING|USER_STOP|PAUSED)/.test(m) ||
      /Recharge:\s*(GOING|ALIGN|ALIGNING|MOVING|RUNNING|BACK|DOCKING)/i.test(m) ||
      /Work:(GO_PILE|BACK_CHARGER|DOCKING)/.test(m)
    );
  })();
  // Treat the sticky live-mowing flag OR a paused/returning coverage session as
  // "show the live plan + progress" (vs the idle generated preview).
  const inLiveCoverage = liveSession || coverageSessionActive;
  const { toast } = useToast();
  const [maps, setMaps] = useState<MapData[]>([]);
  // Trail in LOKALE meters (map_position frame), net als de maaier-icoon en de
  // polygonen. De server /trail endpoint geeft default lokale punten {x,y,ts};
  // we projecteren ze via DEZELFDE localToGps(charger)-transform als de maaier,
  // anders staat de trail op de verkeerde plek (rauwe GPS heeft een base-offset).
  const [trail, setTrail] = useState<Array<{ x: number; y: number; ts: number }>>([]);
  const [showTrail, setShowTrail] = useState(true);
  // true zodra de gebruiker zélf een laag koos (of er een opgeslagen keuze is) →
  // dan geen auto-selectie meer op basis van locatie.
  const tileManualRef = useRef(false);
  const [tileLayer, setTileLayer] = useState<TileLayerKey>(() => {
    try {
      const saved = localStorage.getItem('novabot.tileLayer');
      if (saved && saved in TILE_LAYERS) { tileManualRef.current = true; return saved; }
    } catch { /* ignore */ }
    return 'satellite';
  });
  const changeTileLayer = useCallback((key: TileLayerKey) => {
    tileManualRef.current = true;
    setTileLayer(key);
    try { localStorage.setItem('novabot.tileLayer', key); } catch { /* ignore */ }
  }, []);
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);

  // Polygon edit/draw state
  const [editMode, setEditMode] = useState<'none' | 'edit' | 'draw'>('none');
  const [editVertices, setEditVertices] = useState<[number, number][]>([]);
  const [editingMapId, setEditingMapId] = useState<string | null>(null);
  const [drawType, setDrawType] = useState<'work' | 'obstacle' | 'unicom'>('work');
  const [drawName, setDrawName] = useState('');
  const [showHeatmap, setShowHeatmap] = useState(false);

  // ── Coverage-path preview ("show mowing path"): idle preview is generated
  //    by the mower through generate_preview_cover_path/get_preview_cover_path;
  //    live mowing still polls the mower's plan path.
  const [coveragePath, setCoveragePath] = useState<CoveragePathEntry[] | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [showCoverage, setShowCoverage] = useState(false);
  const [coverageRadiusDraft, setCoverageRadiusDraft] = useState(() => {
    const fromSensors = Number(sensors?.coverage_planner_radius);
    return Number.isFinite(fromSensors) ? fromSensors.toString() : DEFAULT_COVERAGE_RADIUS.toString();
  });
  const [coverageRadiusSaving, setCoverageRadiusSaving] = useState(false);
  // Live camera tile — only available on OpenNova custom firmware (the
  // `camera_stream.py` daemon ships only there; the proxy 404s otherwise).
  const [showCamera, setShowCamera] = useState(false);
  // Tool-bar flyout: which category popover is open (Weergave / Bewerken /
  // Coverage / Dock). null = none. Only one open at a time.
  const [railFlyout, setRailFlyout] = useState<null | 'view' | 'edit' | 'coverage' | 'dock'>(null);
  // Satellite-layer picker is a side submenu off the Weergave flyout (it stays
  // compact instead of listing every layer inline). Auto-closes with Weergave.
  const [railTileSub, setRailTileSub] = useState(false);
  useEffect(() => { if (railFlyout !== 'view') setRailTileSub(false); }, [railFlyout]);
  // Tile labels are shown without their parenthetical suffix (e.g. "PDOK
  // luchtfoto (NL, ~8 cm)" → "PDOK luchtfoto"); the full label stays as the
  // hover title so the resolution/region hint isn't lost.
  const cleanTileLabel = (s: string) => s.replace(/\s*\([^)]*\)/g, '').trim();
  // Shared styles for the floating tool-bar category buttons + flyout panels.
  const railCat = (open: boolean) =>
    `relative inline-flex items-center gap-1.5 h-9 px-2.5 rounded-lg text-xs font-semibold transition-colors ${open ? 'bg-gray-700 text-white' : 'text-gray-300 bg-gray-800/50 hover:bg-gray-700/70'}`;
  const railPanel = 'absolute top-full left-0 mt-2 z-[950] bg-gray-900/95 backdrop-blur border border-gray-700 rounded-xl p-1 shadow-xl min-w-[210px]';
  const railRow = (active: boolean) =>
    `flex w-full items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] transition-colors ${active ? 'bg-emerald-600/15 text-emerald-300' : 'text-gray-300 hover:bg-gray-700/60'}`;
  const railHdr = 'px-2.5 pt-1.5 pb-1 text-[9px] font-bold uppercase tracking-[0.12em] text-gray-500';
  const railDot = <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-gray-900" />;
  const cameraAvailable = isOpenNovaFirmware(
    (sensors?.sw_version ?? sensors?.version) ?? undefined,
  );
  // coverageStatus-waarde wordt niet meer getoond (hint-paneel verwijderd) — alleen
  // de setter blijft voor de bestaande logica-flow. Waarde bewust gediscard.
  const [, setCoverageStatus] = useState<string | null>(null);
  // True when the currently-shown overlay is the LIVE plan path (mower mowing),
  // so the panel shows a subtle "live" indicator + hint instead of the idle one.
  const [coverageLive, setCoverageLive] = useState(false);
  // Interval handle for live plan-path polling (~5s) while the overlay is shown
  // AND the mower is mowing. Cleared on hide / stop-mowing / unmount.
  const coveragePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Mirror showCoverage in a ref so the poll loop can self-cancel without being
  // re-created on every toggle.
  const showCoverageRef = useRef(false);
  useEffect(() => { showCoverageRef.current = showCoverage; }, [showCoverage]);

  useEffect(() => {
    if (!sn) return;
    let cancelled = false;
    const fromSensors = Number(sensors?.coverage_planner_radius);
    if (Number.isFinite(fromSensors)) {
      setCoverageRadiusDraft(fromSensors.toString());
      return;
    }
    fetchCoveragePlannerRadius(sn)
      .then((result) => {
        if (!cancelled && Number.isFinite(result.radius)) {
          setCoverageRadiusDraft(result.radius.toString());
        }
      })
      .catch(() => {
        if (!cancelled) setCoverageRadiusDraft(DEFAULT_COVERAGE_RADIUS.toString());
      });
    return () => { cancelled = true; };
  }, [sn, sensors?.coverage_planner_radius]);

  // ── Push/pull brush (R3) ────────────────────────────────────────
  // The brush operates on the currently selected WORK or OBSTACLE polygon
  // (unicom excluded). brushWorking holds the live LOCAL points during a stroke
  // so we can render an in-progress dashed overlay and commit on mouseup.
  const [brushMode, setBrushMode] = useState(false);
  const [brushRadius, setBrushRadius] = useState(0.8);
  const [brushWorking, setBrushWorking] = useState<XY[] | null>(null);

  // ── Paint/erase brush (primary tool) ────────────────────────────
  // Paints (union) or erases (difference) a circular brush into the selected
  // work/obstacle polygon. paintWorking mirrors the live polygon during a stroke
  // for the dashed overlay; successive strokes accumulate (re-seeded on commit).
  const [paintMode, setPaintMode] = useState(false);
  const [paintTool, setPaintTool] = useState<'paint' | 'erase'>('erase');
  const [paintRadius, setPaintRadius] = useState(0.4);
  const [paintWorking, setPaintWorking] = useState<XY[] | null>(null);

  // ── Move/translate tool ─────────────────────────────────────────
  // Drag a whole work/obstacle shape to reposition it (saved as a draft,
  // undoable, applied later). The move target is pinned by CANONICAL — not by
  // selectedMapId — because a fresh paste is a draft-only obstacle that may NOT
  // appear in the committed `maps` list. moveWorking mirrors the live translated
  // points during a drag for the dashed overlay; the drag re-seeds its base from
  // the refreshed geometry on each release so successive nudges stack cleanly.
  const [moveMode, setMoveMode] = useState(false);
  const [moveTargetCanonical, setMoveTargetCanonical] = useState<string | null>(null);
  const [moveWorking, setMoveWorking] = useState<XY[] | null>(null);

  // Cumulative obstacle offset (R3). Repeated Expand/Shrink must offset from the
  // ORIGINAL base by the accumulated distance — offsetting the previous result
  // each time compounds miter rounding error (corners drift). Key = canonical.
  const obstacleOffsetBase = useRef<Map<string, { base: XY[]; accum: number }>>(new Map());
  // Dimension annotation for the active obstacle expand/shrink: a leader line in
  // LOCAL metres from the original boundary to the offset boundary + the cm delta.
  const [offsetAnnotation, setOffsetAnnotation] = useState<
    { canonical: string; from: XY; to: XY; cm: number } | null
  >(null);

  // Live Leaflet map instance (captured via <MapInstanceCapture/>) so paste can
  // read the current view CENTER for placement without living inside MapContainer.
  const leafletMapRef = useRef<L.Map | null>(null);

  // ── Obstacle copy/paste (R6) ────────────────────────────────────
  // Clipboard holds an obstacle's LOCAL points (charger-relative meters). It
  // PERSISTS across mower switches and reloads via localStorage, so a copy on
  // one mower can be pasted onto another's work map (the relative shape is reused
  // in the target mower's frame; absolute position may differ — the user then
  // repositions with Paint/Move). Initialized from localStorage on mount.
  const [obstacleClipboard, setObstacleClipboardState] = useState<ObstacleClipboard | null>(() => {
    try {
      const raw = localStorage.getItem(OBSTACLE_CLIPBOARD_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ObstacleClipboard;
      if (!parsed || !Array.isArray(parsed.points) || parsed.points.length < 3) return null;
      return parsed;
    } catch { return null; }
  });
  // Setter that mirrors to localStorage so the clipboard survives reloads.
  const setObstacleClipboard = useCallback((c: ObstacleClipboard | null) => {
    setObstacleClipboardState(c);
    try {
      if (c) localStorage.setItem(OBSTACLE_CLIPBOARD_KEY, JSON.stringify(c));
      else localStorage.removeItem(OBSTACLE_CLIPBOARD_KEY);
    } catch { /* localStorage may be unavailable (private mode) — keep in-memory */ }
  }, []);

  // Draft → apply-to-mower flow (R2). editGeometry mirrors the server's draft
  // store; the floating MapEditBar surfaces pending drafts + apply/revert/discard.
  const [editGeometry, setEditGeometry] = useState<EditGeometryDto | null>(null);
  const [editStatus, setEditStatus] = useState('');
  const [editStatusKind, setEditStatusKind] = useState<'info' | 'error' | 'warn' | 'ok'>('info');
  const [applying, setApplying] = useState(false);

  // Mirror editGeometry in a ref so recordHistory() can read the FRESHLY fetched
  // geometry synchronously right after refreshEditGeometry() (the setEditGeometry
  // state update is async and not yet visible in the same tick).
  const editGeometryRef = useRef<EditGeometryDto | null>(null);
  const refreshEditGeometry = useCallback(async () => {
    if (!sn) return;
    try {
      const geom = await fetchEditGeometry(sn);
      editGeometryRef.current = geom;
      setEditGeometry(geom);
    } catch { /* non-fatal */ }
  }, [sn]);

  // ── Undo/redo edit-history (R6) ─────────────────────────────────
  // Client-side snapshot stack over the existing draft endpoints. history holds
  // DraftSnapshots; historyIndex points at the currently-applied one. Mutating
  // ops push a fresh snapshot; undo/redo replay a snapshot via applySnapshot.
  const [history, setHistory] = useState<DraftSnapshot[]>([[]]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [historyBusy, setHistoryBusy] = useState(false);
  // historyIndex mirrored in a ref so keyboard handlers + the truncate logic in
  // recordHistory read the live value without re-binding/closure staleness.
  const historyIndexRef = useRef(0);
  useEffect(() => { historyIndexRef.current = historyIndex; }, [historyIndex]);

  // Record the current pending-draft set as a new history entry. Call AFTER a
  // successful mutating op once refreshEditGeometry() has updated the geometry —
  // derives the snapshot from editGeometryRef (freshly fetched, not stale state).
  // Truncates any redo branch, caps at HISTORY_CAP. Never call during undo/redo.
  const recordHistory = useCallback(() => {
    const snap = snapshotOf(editGeometryRef.current);
    setHistory(prev => {
      const base = prev.slice(0, historyIndexRef.current + 1);
      base.push(snap);
      const trimmed = base.length > HISTORY_CAP ? base.slice(base.length - HISTORY_CAP) : base;
      setHistoryIndex(trimmed.length - 1);
      return trimmed;
    });
  }, []);

  // Reset history to a single fresh snapshot of the current geometry. Used on
  // mower select / editor open and after apply/revert/discard (drafts cleared).
  const resetHistory = useCallback(() => {
    const snap = snapshotOf(editGeometryRef.current);
    setHistory([snap]);
    setHistoryIndex(0);
  }, []);

  // Re-fetch the canonical map list from the server (used after draft save /
  // apply / revert, where optimistic local edits no longer match the server).
  const reloadMaps = useCallback(async () => {
    if (!sn) return;
    try {
      const resp = await fetchMaps(sn);
      setMaps(resp.maps);
      setChargerGps(resp.chargerGps);
      setChargingPose(resp.chargingPose ?? null);
    } catch { /* keep current maps */ }
  }, [sn]);

  // Replay a snapshot onto the server: clear all drafts, then re-create each
  // entry through the existing draft endpoints. Sequential to avoid the per-SN
  // draft race. After replay, refresh geometry + reload maps so overlays update.
  const applySnapshot = useCallback(async (snap: DraftSnapshot) => {
    if (!sn) return;
    await discardEditDrafts(sn).catch(() => {});
    for (const entry of snap) {
      try {
        if (entry.kind === 'edit') {
          await saveEditDraft(sn, { canonical: entry.canonical, points: entry.points });
        } else if (entry.kind === 'delete') {
          await saveEditDraft(sn, { canonical: entry.canonical, deleted: true });
        } else {
          await saveEditDraft(sn, { mapType: 'obstacle', parentMap: entry.parentMap, points: entry.points });
        }
      } catch { /* skip a failed entry, continue replay */ }
    }
    // Replaying changes the committed/draft geometry → the cumulative obstacle
    // offset base is no longer valid; clear it so the next expand/shrink re-seeds.
    obstacleOffsetBase.current.clear(); setOffsetAnnotation(null);
    await refreshEditGeometry();
    await reloadMaps();
  }, [sn, refreshEditGeometry, reloadMaps]);

  // Undo: move the pointer back one step and replay that snapshot. Moving the
  // pointer IS the history move — do NOT recordHistory here. Guarded by
  // historyBusy so rapid clicks don't overlap (each applySnapshot is awaited).
  const undo = useCallback(async () => {
    if (historyBusy || historyIndex <= 0) return;
    setHistoryBusy(true);
    const target = historyIndex - 1;
    setHistoryIndex(target);
    try { await applySnapshot(history[target]); }
    finally { setHistoryBusy(false); }
  }, [historyBusy, historyIndex, history, applySnapshot]);

  const redo = useCallback(async () => {
    if (historyBusy || historyIndex >= history.length - 1) return;
    setHistoryBusy(true);
    const target = historyIndex + 1;
    setHistoryIndex(target);
    try { await applySnapshot(history[target]); }
    finally { setHistoryBusy(false); }
  }, [historyBusy, historyIndex, history, applySnapshot]);

  const canUndo = historyIndex > 0 && !historyBusy;
  const canRedo = historyIndex < history.length - 1 && !historyBusy;

  // Mowing completion celebration + "vandaag gemaaid" tracking
  const [showCelebration, setShowCelebration] = useState(false);
  const [lastMowedDate, setLastMowedDate] = useState<string | null>(null);
  const prevWorkStatusRef = useRef<string>('0');
  const prevMowingRef = useRef(false);
  const celebrationArea = useRef(0);

  useEffect(() => {
    const ws = mowing?.workStatus ?? '0';
    const progress = parseInt(mowing?.mowingProgress ?? '0', 10);
    const nowMowing = !!mowingActive;
    // Maaien gestart → wis oude trail. Gebruik de msg-based mowingActive i.p.v.
    // work_status==='1' — dat veld staat tijdens maaien niet altijd op '1', wat
    // ervoor zorgde dat de trail nooit werd geleegd/opgebouwd.
    if (!prevMowingRef.current && nowMowing) {
      setTrail([]);
    }
    // Transitie: maaien klaar (was mowing, nu niet, met progress >=95%)
    if (prevMowingRef.current && !nowMowing && progress >= 95) {
      celebrationArea.current = parseFloat(mowing?.coveringArea ?? '0');
      setShowCelebration(true);
      setLastMowedDate(new Date().toLocaleDateString());
    }
    prevWorkStatusRef.current = ws;
    prevMowingRef.current = nowMowing;
  }, [mowingActive, mowing?.workStatus, mowing?.mowingProgress, mowing?.coveringArea]);

  // Place charger mode
  const [placingCharger, setPlacingCharger] = useState(false);

  // Navigate-to mode
  const [navigateMode, setNavigateMode] = useState(false);
  const [navigateTarget, setNavigateTarget] = useState<{ lat: number; lng: number } | null>(null);

  // Confirm delete dialog
  const [confirmDeleteMapId, setConfirmDeleteMapId] = useState<string | null>(null);
  const [confirmDeleteMapName, setConfirmDeleteMapName] = useState<string>('');

  // Charger calibration
  const [confirmCalibrate, setConfirmCalibrate] = useState(false);
  const [confirmShiftReset, setConfirmShiftReset] = useState(false);
  // True zolang de absolute-offset-seed nog binnenkomt; houdt de nudge-pijltjes
  // uit zodat een klik niet door de async seed wordt overschreven (race-fix).
  const [seedLoading, setSeedLoading] = useState(false);

  // Virtual walls
  const [walls, setWalls] = useState<VirtualWall[]>([]);
  const [wallDrawMode, setWallDrawMode] = useState(false);
  const [wallFirstCorner, setWallFirstCorner] = useState<{ lat: number; lng: number } | null>(null);

  // Charger GPS — used for local meter → GPS conversion for Leaflet display
  const [chargerGps, setChargerGps] = useState<GpsPoint | null>(null);
  // Charger pose in local meter frame (from map_info.json charging_pose).
  // Used to shift all local coords so that the physical charger position
  // projects onto chargerGps instead of the local origin (0,0).
  const [chargingPose, setChargingPose] = useState<{ x: number; y: number; orientation: number } | null>(null);

  // Auto-selecteer de scherpste regionale satelliet-laag voor de locatie van de
  // maaier (charger-GPS, anders live GPS). Globaal valt terug op Esri. Slaat over
  // zodra de gebruiker zelf een laag koos (tileManualRef).
  useEffect(() => {
    if (tileManualRef.current) return;
    const aLat = chargerGps?.lat ?? (lat ? parseFloat(lat) : null);
    const aLng = chargerGps?.lng ?? (lng ? parseFloat(lng) : null);
    if (aLat == null || aLng == null || !Number.isFinite(aLat) || !Number.isFinite(aLng)) return;
    const regional = (Object.keys(TILE_LAYERS) as TileLayerKey[]).find(
      k => TILE_LAYERS[k].bounds && tileLayerInBounds(TILE_LAYERS[k], aLat, aLng),
    );
    if (regional) setTileLayer(regional); // geen localStorage-save → blijft "auto"
  }, [chargerGps, lat, lng]);

  // Calibration state
  const [savedCal, setSavedCal] = useState<MapCalibration>(DEFAULT_CAL);
  const [editCal, setEditCal] = useState<MapCalibration | null>(null);
  const calibrating = editCal !== null;
  const activeCal = editCal ?? savedCal;

  // Area type labels (translated)
  const AREA_TYPE_META: Record<AreaType, { color: string; label: string }> = useMemo(() => ({
    work:     { color: '#10b981', label: t('map.workArea') },
    obstacle: { color: '#ef4444', label: t('map.obstacle') },
    unicom:   { color: '#3b82f6', label: t('map.channel') },
  }), [t]);

  useEffect(() => {
    if (sn) {
      fetchMaps(sn).then(resp => {
        setMaps(resp.maps);
        setChargerGps(resp.chargerGps);
        setChargingPose(resp.chargingPose ?? null);
      }).catch(() => setMaps([]));
      // Server /trail geeft default lokale punten {x,y,ts} (ondanks de TrailPoint-
      // type-naam) — gebruik ze rechtstreeks als lokale trail.
      fetchTrail(sn).then(pts => setTrail(pts as unknown as Array<{ x: number; y: number; ts: number }>)).catch(() => setTrail([]));
      fetchCalibration(sn).then(setSavedCal).catch(() => {});
      // Initialize undo/redo history to a single fresh snapshot once the editor's
      // geometry has loaded for this mower (usually an empty snapshot = no drafts).
      refreshEditGeometry().then(resetHistory);
    } else {
      // No mower SN — load all maps and calibration as fallback
      fetchAllMaps().then(loaded => {
        setMaps(loaded);
        // Load calibration for the first map's owner SN
        const ownerSn = (loaded[0] as MapData & { mowerSn?: string })?.mowerSn;
        if (ownerSn) {
          fetchCalibration(ownerSn).then(setSavedCal).catch(() => {});
        }
      }).catch(() => setMaps([]));
      setTrail([]);
    }
  }, [sn]);

  // Fetch virtual walls
  useEffect(() => {
    if (sn) {
      fetchVirtualWalls(sn).then(setWalls).catch(() => setWalls([]));
    }
  }, [sn]);

  // Keyboard shortcuts for undo/redo while the map editor is mounted.
  // Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z (and Ctrl+Y) = redo. Ignored when the
  // focus is in a text field so typing in name/rename inputs is unaffected.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) void redo();
        else void undo();
      } else if (key === 'y') {
        e.preventDefault();
        void redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);


  // Append new trail points when lat/lng changes — only while actively mowing.
  // Gebruik mowingActive (msg-based) i.p.v. work_status==='1': dat veld klopt
  // niet altijd tijdens maaien, waardoor de trail leeg bleef.
  const isMowing = !!mowingActive || mowing?.workStatus === '1';
  useEffect(() => {
    if (!isMowing) return;
    // Lokale map_position (cm-nauwkeurig, zelfde frame als de maaier-icoon) i.p.v.
    // rauwe GPS — anders staat de trail op de verkeerde plek.
    const mx = mapX != null ? parseFloat(mapX) : NaN;
    const my = mapY != null ? parseFloat(mapY) : NaN;
    if (isNaN(mx) || isNaN(my)) return;

    setTrail(prev => {
      if (prev.length > 0) {
        const last = prev[prev.length - 1];
        if (Math.abs(last.x - mx) < 0.01 && Math.abs(last.y - my) < 0.01) {
          return prev;
        }
      }
      return [...prev, { x: mx, y: my, ts: Date.now() }];
    });
  }, [mapX, mapY, isMowing]);

  const handleClearTrail = useCallback(() => {
    clearTrail(sn).then(() => setTrail([])).catch(() => {});
  }, [sn]);

  const handleDeleteMap = useCallback((mapId: string) => {
    deleteMap(sn, mapId).then(() => {
      setMaps(prev => prev.filter(m => m.mapId !== mapId));
      setSelectedMapId(null);
    }).catch(() => {});
  }, [sn]);

  // Inline rename state
  const [editingName, setEditingName] = useState<string | null>(null);

  const handleRenameMap = useCallback((mapId: string, newName: string) => {
    const trimmed = newName.trim();
    renameMap(sn, mapId, trimmed).then(() => {
      setMaps(prev => prev.map(m => m.mapId === mapId ? { ...m, mapName: trimmed || null } : m));
      setEditingName(null);
    }).catch(() => {});
  }, [sn]);

  // Start editing an existing polygon — accepts map data directly to avoid stale closure
  // Server stuurt al GPS coords (lokaal→GPS conversie) — direct bruikbaar voor Leaflet.
  const startEditMap = useCallback((mapId: string, mapArea: Array<{ lat: number; lng: number }>) => {
    if (mapArea.length < 3) return;
    // KEEP THE FULL RING — never simplify on edit. Mower-recorded rings carry
    // hundreds of densely sampled points that trace the real garden contour;
    // RDP-simplifying them (the old behaviour) straightened the boundary and
    // corrupted the saved map. PolygonEditor caps the number of *drag handles*
    // and warps the dense ring locally (cosine falloff) so editing stays usable
    // while every un-touched point is preserved on save.
    const verts = mapArea.map(p => [p.lat, p.lng] as [number, number]);
    setEditingMapId(mapId);
    setEditVertices(verts);
    setEditMode('edit');
    setSelectedMapId(null);
    setEditingName(null);
    setMoveMode(false);
    setMoveTargetCanonical(null);
    setMoveWorking(null);
    setUserInteracted(true);
  }, [chargerGps]);

  // Start drawing a new polygon
  const startDrawMap = useCallback(() => {
    setEditingMapId(null);
    setEditVertices([]);
    setDrawName('');
    setEditMode('draw');
    setSelectedMapId(null);
    setMoveMode(false);
    setMoveTargetCanonical(null);
    setMoveWorking(null);
    setUserInteracted(true);
  }, []);

  // Determine editor polygon color based on context
  const editorColor = useMemo(() => {
    if (editMode === 'draw') return AREA_TYPE_META[drawType].color;
    if (editMode === 'edit' && editingMapId) {
      const m = maps.find(p => p.mapId === editingMapId);
      if (m) return getAreaStyle(m.mapType, m.mapId, m.mapName).color;
    }
    return '#10b981';
  }, [editMode, drawType, editingMapId, maps, AREA_TYPE_META]);

  // Convert local meter maps to GPS-projected maps for Leaflet rendering.
  // All rendering code uses gpsMaps (with lat/lng). Only save/create uses local meters.
  //
  // Shift: map_info.json declares charging_pose {x,y} in local meters. The
  // physical charger sits at that offset, NOT at local (0,0). We shift every
  // point by -(chargingPose.x, chargingPose.y) so that local (chargingPose.x,
  // chargingPose.y) projects onto chargerGps (where the user placed the icon).
  // Without this shift the unicom start (which begins at the actual charger pose)
  // appears offset from the rendered charger icon on the satellite tile.
  type GpsMapData = Omit<MapData, 'mapArea'> & { mapArea: Array<{ lat: number; lng: number }> };
  const gpsMaps: GpsMapData[] = useMemo(() => {
    if (!isUsableChargerGps(chargerGps)) return [];
    const offX = chargingPose?.x ?? 0;
    const offY = chargingPose?.y ?? 0;
    // Drop any vertex that becomes non-finite after projection — a single
    // NaN coord crashes Leaflet with "Invalid LatLng object" (issue #15).
    return maps.map(m => ({
      ...m,
      mapArea: m.mapArea.flatMap(p => {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return [];
        const gps = localToGps({ x: p.x - offX, y: p.y - offY }, chargerGps);
        if (!Number.isFinite(gps.lat) || !Number.isFinite(gps.lng)) return [];
        return [gps];
      }),
    }));
  }, [maps, chargerGps, chargingPose]);

  // Pending draft geometry (R2) projected to GPS for a dashed "pending" overlay.
  // Each draft with non-null geometry (and not deleted) is drawn on top of the
  // base maps so the user sees their edit before it is applied to the mower.
  const draftOverlays: Array<{ canonical: string; mapType: 'work' | 'obstacle' | 'unicom'; gps: Array<{ lat: number; lng: number }> }> = useMemo(() => {
    if (!editGeometry || !isUsableChargerGps(chargerGps)) return [];
    const offX = chargingPose?.x ?? 0;
    const offY = chargingPose?.y ?? 0;
    const out: Array<{ canonical: string; mapType: 'work' | 'obstacle' | 'unicom'; gps: Array<{ lat: number; lng: number }> }> = [];
    for (const entry of editGeometry.maps) {
      const draft = entry.draft;
      if (!draft || draft.deleted || draft.points.length < 3) continue;
      const gps = draft.points.flatMap(p => {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return [];
        const g = localToGps({ x: p.x - offX, y: p.y - offY }, chargerGps);
        if (!Number.isFinite(g.lat) || !Number.isFinite(g.lng)) return [];
        return [g];
      });
      if (gps.length >= 3) out.push({ canonical: entry.canonical, mapType: entry.mapType, gps });
    }
    return out;
  }, [editGeometry, chargerGps, chargingPose]);

  // Coverage-path sub-paths projected into the SAME GPS frame as gpsMaps /
  // draftOverlays (local → GPS with the chargingPose offset). Rendering then
  // applies calibratePoints(..., activeCal, polyCenter), identical to maps,
  // so the "black lines" land exactly on the work polygons.
  const coverageGps: Array<{ id: string; gps: Array<{ lat: number; lng: number }> }> = useMemo(() => {
    if (!coveragePath || !isUsableChargerGps(chargerGps)) return [];
    const offX = chargingPose?.x ?? 0;
    const offY = chargingPose?.y ?? 0;
    const out: Array<{ id: string; gps: Array<{ lat: number; lng: number }> }> = [];
    for (const entry of coveragePath) {
      const gps = entry.points.flatMap(p => {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return [];
        const g = localToGps({ x: p.x - offX, y: p.y - offY }, chargerGps);
        if (!Number.isFinite(g.lat) || !Number.isFinite(g.lng)) return [];
        return [g];
      });
      if (gps.length >= 2) out.push({ id: entry.id, gps });
    }
    return out;
  }, [coveragePath, chargerGps, chargingPose]);

  // Live coverage-voortgang — DEZELFDE classificatie als de OpenNova app
  // (MowingProgressMap), via de gedeelde util. finished → dik groen, actief →
  // emerald tot covering_area_points, resterend → dunne lijn.
  const coverProgress = useMemo(() => {
    const finished = new Set(
      parseFinishedAreas(mowingSensors.finished_area, mowingSensors.cover_map_id) ?? [],
    );
    const activeId = prefixedAreaId(mowingSensors.covering_area_id, mowingSensors.cover_map_id);
    const activePoints = parseInt(mowingSensors.covering_area_points ?? '0', 10) || 0;
    return { finished, activeId, activePoints };
  }, [
    mowingSensors.finished_area,
    mowingSensors.cover_map_id,
    mowingSensors.covering_area_id,
    mowingSensors.covering_area_points,
  ]);

  // ── Live plan-path polling (while mowing) ───────────────────────
  // Fetch the live plan path once (used by the poll loop AND the manual path).
  // Returns true if a non-empty path was applied. Never throws.
  const fetchPlanOnce = useCallback(async (refresh: boolean): Promise<boolean> => {
    if (!sn) return false;
    try {
      const paths = refresh ? await refreshPlanPath(sn) : await getPlanPath(sn);
      if (paths.length > 0) { setCoveragePath(paths); return true; }
    } catch { /* keep any existing path */ }
    return false;
  }, [sn]);

  const stopCoveragePoll = useCallback(() => {
    if (coveragePollRef.current) {
      clearInterval(coveragePollRef.current);
      coveragePollRef.current = null;
    }
  }, []);

  // Start (or restart) the ~5s live plan-path poll. The loop self-cancels if the
  // overlay is hidden; the auto-switch effect cancels it when mowing stops.
  const startCoveragePoll = useCallback(() => {
    stopCoveragePoll();
    coveragePollRef.current = setInterval(() => {
      if (!showCoverageRef.current) { stopCoveragePoll(); return; }
      void fetchPlanOnce(false).then((ok) => { if (!ok) void fetchPlanOnce(true); });
    }, 5000);
  }, [stopCoveragePoll, fetchPlanOnce]);

  // Show the LIVE plan path: refresh once, fall back to cache, then poll. Used
  // while the mower is mowing — no Error-128 risk (get_map_plan_path is safe).
  const showLiveCoverage = useCallback(async () => {
    if (!sn) return;
    setCoverageLive(true);
    setCoverageLoading(true);
    setCoverageStatus(t('map.edit.coverageLive'));
    try {
      // Show whatever is cached immediately, then refresh for the freshest plan.
      const cached = await getPlanPath(sn).catch(() => [] as CoveragePathEntry[]);
      if (cached.length > 0) setCoveragePath(cached);
      const ok = await fetchPlanOnce(true);
      // During a session we NEVER fall back to the generated preview: a transient
      // empty plan (the mower briefly stops between lanes / pauses its blades)
      // must keep the last live plan on screen, not jump to the native preview.
      // Only when there is genuinely nothing yet do we show a soft "none" note.
      if (!ok && cached.length === 0) setCoverageStatus(t('map.edit.coverageNone'));
    } finally {
      setCoverageLoading(false);
      startCoveragePoll();
    }
  }, [sn, t, fetchPlanOnce, startCoveragePoll]);

  const saveCoverageRadius = useCallback(async () => {
    if (!sn) return;
    const radius = Number(coverageRadiusDraft);
    if (!Number.isFinite(radius) || radius < MIN_COVERAGE_RADIUS || radius > MAX_COVERAGE_RADIUS) {
      toast(t('map.edit.coverageRadiusInvalid'), 'error');
      return;
    }
    setCoverageRadiusSaving(true);
    try {
      const result = await updateCoveragePlannerRadius(sn, Number(radius.toFixed(3)));
      setCoverageRadiusDraft(result.radius.toString());
      toast(t('map.edit.coverageRadiusSaved'), 'success');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      toast(detail || t('map.edit.coverageRadiusSaveFailed'), 'error');
    } finally {
      setCoverageRadiusSaving(false);
    }
  }, [sn, coverageRadiusDraft, toast, t]);

  // Stock mower coverage preview. This routes through generate_preview_cover_path
  // and get_preview_cover_path, matching the Novabot app's advanced-settings
  // preview flow. When the mower is mowing this routes to showLiveCoverage
  // instead because get_map_plan_path is the right source for the active task.
  const refreshCoverage = useCallback(async (dirOverride?: number) => {
    if (!sn) return;
    if (inLiveCoverage) { stopCoveragePoll(); await showLiveCoverage(); return; }
    setCoverageLive(false);
    stopCoveragePoll();
    setCoveragePath(null);
    setCoverageLoading(true);
    setCoverageStatus(t('map.edit.coverageLoading'));
    try {
      const selectedStoredMap = selectedMapId
        ? maps.find(m => m.mapId === selectedMapId && m.mapType === 'work')
        : maps.find(m => m.mapType === 'work');
      const canonicals = selectedStoredMap?.canonicalName
        ? [selectedStoredMap.canonicalName]
        : maps
          .filter(m => m.mapType === 'work' && m.canonicalName)
          .map(m => m.canonicalName!)
          .filter(Boolean);
      // The mowing direction comes from the operator's CONFIGURED setting — the
      // device para `path_direction` (e.g. 60), the same value the Settings tab and
      // Start sheet show. Never the mower's reported cov_direction (often empty,
      // which made the generate omit the direction → a spurious 0-degree preview).
      // Fall back to the stored localStorage default only if the para isn't loaded
      // yet. An explicit dirOverride still wins.
      const fromPara = Number(mowingSensors.path_direction);
      const dir = dirOverride
        ?? (Number.isFinite(fromPara) ? fromPara : readMowDefaults().pathDirection);
      const covDirection = Number.isFinite(dir) && dir >= 0 && dir <= 180
        ? Math.round(dir)
        : undefined;
      const result = await refreshPreviewPath(sn, {
        mapIds: previewMapIdsFromCanonicals(canonicals),
        ...(covDirection !== undefined ? { covDirection } : {}),
      });
      setCoveragePath(result.paths);
      setCoverageStatus(result.busy
        ? t('map.edit.coverageBusy')
        : result.paths.length > 0 ? null : t('map.edit.coverageNone'));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setCoverageStatus(detail || t('map.edit.coverageNone'));
      toast(detail || t('map.edit.coverageNone'), 'error');
    } finally {
      setCoverageLoading(false);
    }
  }, [sn, inLiveCoverage, maps, selectedMapId, mowingSensors.path_direction, t, toast, showLiveCoverage, stopCoveragePoll]);

  // Toggle handler: hide is pure visibility; show triggers the right mower
  // source. Idle uses a fresh stock preview, live mowing uses the live plan.
  const toggleCoverage = useCallback(async () => {
    if (showCoverage) {
      setShowCoverage(false);
      stopCoveragePoll();
      return;
    }
    setShowCoverage(true);
    setCoverageStatus(null);
    if (!sn) return;
    if (inLiveCoverage) { await showLiveCoverage(); return; }
    await refreshCoverage();
  }, [showCoverage, sn, inLiveCoverage, showLiveCoverage, stopCoveragePoll, refreshCoverage]);

  // Auto-switch: when the mower transitions into/out of mowing WHILE the panel
  // is open, switch to/from the live plan path automatically. Also stops the
  // poll when the panel closes or the component unmounts.
  useEffect(() => {
    if (!showCoverage) { stopCoveragePoll(); return; }
    if (inLiveCoverage) {
      // Mowing OR paused/returning mid-coverage: keep the live plan + progress on
      // screen. get_map_plan_path is safe in all these states (never 128s), so the
      // poll can run while paused too; coverageLive stays true so the green/amber
      // never revert to the cyan idle preview.
      if (!coveragePollRef.current) void showLiveCoverage();
    } else {
      // Session truly ended (Work:CANCELLED/FINISHED, or docked/idle): stop
      // polling, drop the live indicator. Keep the last path on screen (no auto
      // preview-refresh — that needs a user action / could 128 a just-finished
      // task that hasn't cleared yet).
      stopCoveragePoll();
      setCoverageLive(false);
      setCoverageStatus((s) => (s === t('map.edit.coverageLive') ? null : s));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inLiveCoverage, showCoverage]);

  // Auto-toon het maaipad zodra de maaier gaat maaien — geen knop-druk nodig.
  // Vuurt op de start van een live sessie; sluit de gebruiker de overlay
  // handmatig, dan blijft die dicht tot de volgende sessie.
  useEffect(() => {
    if (inLiveCoverage) setShowCoverage(true);
  }, [inLiveCoverage]);

  // Generate a fresh coverage preview for one OR MANY work maps (honors the
  // Start-sheet work-area selector: "All work areas" → every work map, a single
  // selection → just that map). Static preview: no progress coloring, no poll.
  const lastPreviewParamsRef = useRef<{ canonicals: string[]; covDirection: number; polygonArea?: Array<{ latitude: number; longitude: number }> } | null>(null);
  const previewMaps = useCallback(async (canonicals: string[], covDirection: number, polygonArea?: Array<{ latitude: number; longitude: number }>) => {
    // A custom polygon (pattern / edge-offset) needs no canonicals; a saved-map
    // preview needs at least one.
    if (!sn) return;
    if (canonicals.length === 0 && !polygonArea) return;
    lastPreviewParamsRef.current = { canonicals, covDirection, polygonArea };
    setShowCoverage(true);
    setCoverageLive(false);
    stopCoveragePoll();
    setCoveragePath(null);
    setCoverageLoading(true);
    onPreviewLoading?.(true);
    setCoverageStatus(t('map.edit.coverageLoading'));
    try {
      const result = await refreshPreviewPath(sn, {
        mapIds: previewMapIdsFromCanonicals(canonicals),
        covDirection,
        polygonArea,
      });
      if (result.busy) {
        // 409: the server returned a CACHED path because it still believes the
        // mower is busy. Never silently swap in stale data — surface it clearly
        // and leave the overlay empty so it's obvious there was no fresh result.
        setCoverageStatus(t('map.edit.previewBusy', 'Mower busy, no fresh preview'));
        toast(`✗ ${t('map.edit.previewBusy', 'Mower busy, no fresh preview')}`, 'error');
      } else if (result.paths.length === 0) {
        setCoverageStatus(t('map.edit.coverageNone'));
        toast(`✗ ${t('map.edit.coverageNone')}`, 'error');
      } else {
        setCoveragePath(result.paths);
        setCoverageStatus(null);
        if (result.ackTimeout) {
          // The mower didn't ack the regenerate in time; the returned file may be
          // the previous one. Show it, but say it might not be up to date.
          toast(`⚠ ${t('map.edit.previewStale', 'Preview may not be up to date')}`, 'error');
        } else {
          toast(`✓ ${t('map.edit.previewUpdated', 'Preview updated')}`, 'success');
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setCoverageStatus(detail || t('map.edit.coverageNone'));
      toast(`✗ ${t('map.edit.coverageNone')}`, 'error');
    } finally {
      setCoverageLoading(false);
      onPreviewLoading?.(false);
    }
  }, [sn, t, toast, stopCoveragePoll, onPreviewLoading]);

  // Start-sheet "Preview" knop → verse coverage-preview met de gekozen richting
  // en de geselecteerde werkgebieden (alle of één).
  const lastPreviewNonceRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!previewRequest) return;
    if (previewRequest.nonce === lastPreviewNonceRef.current) return;
    lastPreviewNonceRef.current = previewRequest.nonce;
    void previewMaps(previewRequest.canonicals, previewRequest.covDirection, previewRequest.polygonArea);
  }, [previewRequest, previewMaps]);

  // Cleanup poll on unmount.
  useEffect(() => () => stopCoveragePoll(), [stopCoveragePoll]);

  // Pending counts for the edit bar.
  const pendingDraftCount = useMemo(
    () => editGeometry ? editGeometry.maps.filter(m => m.draft).length : 0,
    [editGeometry],
  );
  // Keep the bar visible while there is any undo/redo history to traverse, even
  // after undoing back to an empty draft set — otherwise Redo becomes unreachable.
  const showEditBar = !!editGeometry && (pendingDraftCount > 0 || editGeometry.pendingSync || history.length > 1);

  // Save edited/drawn polygon — vertices zijn Leaflet GPS coords, converteer naar lokale meters voor API.
  //
  // Routing (R2): editing existing work/obstacle geometry and adding new
  // obstacles go through the DRAFT flow (saveEditDraft) — they become pending
  // changes that the MapEditBar applies/reverts. Drawing a brand-new work area
  // or unicom keeps the existing direct-create path (createMap); creating new
  // top-level areas is a separate existing feature, not part of edit/draft.
  const handleSavePolygon = useCallback(() => {
    if (editVertices.length < 3 || !chargerGps) return;
    const gpsArea = editVertices.map(([lat, lng]) => ({ lat, lng }));
    // Add the chargingPose offset back. The display projects stored local points
    // as localToGps(p - chargingPose, charger), so the inverse for saving is
    // gpsToLocal(gps, charger) + chargingPose. Without this, every saved vertex was
    // shifted by -chargingPose, moving the WHOLE map on save (this matches the
    // paste/paint/brush save paths, which already add the offset back).
    const offX = chargingPose?.x ?? 0;
    const offY = chargingPose?.y ?? 0;
    const localArea = gpsArea.map(p => {
      const l = gpsToLocal(p, chargerGps!);
      return { x: l.x + offX, y: l.y + offY };
    });
    const points = localArea.map(p => ({ x: p.x, y: p.y }));

    const finishEdit = () => {
      setEditMode('none');
      setEditVertices([]);
      setEditingMapId(null);
    };

    if (editMode === 'edit' && editingMapId) {
      const target = maps.find(m => m.mapId === editingMapId);
      const canonical = target?.canonicalName ?? null;
      // Draft flow for existing work/obstacle geometry.
      if (canonical && (target!.mapType === 'work' || target!.mapType === 'obstacle')) {
        saveEditDraft(sn, { canonical, points }).then(async r => {
          if (r.ok) {
            await reloadMaps();
            await refreshEditGeometry();
            recordHistory();
            setEditStatus('');
            setEditStatusKind('info');
          } else {
            setEditStatus(r.error || t('map.edit.validationFailed'));
            setEditStatusKind('error');
          }
          finishEdit();
        }).catch(() => { finishEdit(); });
        return;
      }
      // Fallback: unicom (or legacy maps without canonical) — direct update.
      updateMapArea(sn, editingMapId, localArea).then(() => {
        setMaps(prev => prev.map(m => m.mapId === editingMapId ? { ...m, mapArea: localArea } : m));
        finishEdit();
      }).catch(() => { finishEdit(); });
    } else if (editMode === 'draw') {
      // New OBSTACLE → draft flow (attached to a parent work map).
      if (drawType === 'obstacle') {
        const selWork = maps.find(m => m.mapId === selectedMapId && m.mapType === 'work');
        const parent = selWork ?? maps.find(m => m.mapType === 'work');
        const parentMap = parent?.canonicalName ?? null;
        if (!parentMap) {
          setEditStatus(t('map.edit.validationFailed'));
          setEditStatusKind('error');
          finishEdit();
          return;
        }
        saveEditDraft(sn, { mapType: 'obstacle', parentMap, points }).then(async r => {
          if (r.ok) {
            await reloadMaps();
            await refreshEditGeometry();
            recordHistory();
            setEditStatus('');
            setEditStatusKind('info');
          } else {
            setEditStatus(r.error || t('map.edit.validationFailed'));
            setEditStatusKind('error');
          }
          finishEdit();
        }).catch(() => { finishEdit(); });
        return;
      }
      // New WORK area or UNICOM → existing direct-create path (unchanged).
      const typeMeta = AREA_TYPE_META[drawType];
      const trimmedName = drawName.trim();
      const name = trimmedName || (() => {
        const count = gpsMaps.filter(m => {
          const s = getAreaStyle(m.mapType, m.mapId, m.mapName);
          return s.color === typeMeta.color;
        }).length;
        return `${typeMeta.label} ${count + 1}`;
      })();
      createMap(sn, name, localArea, drawType).then(newMap => {
        setMaps(prev => [...prev, newMap]);
        setEditMode('none');
        setEditVertices([]);
        setSelectedMapId(newMap.mapId);
      }).catch(() => {});
    }
  }, [editVertices, editMode, editingMapId, sn, maps, selectedMapId, gpsMaps, drawType, drawName, AREA_TYPE_META, chargerGps, chargingPose, reloadMaps, refreshEditGeometry, recordHistory, t]);

  // Cancel edit/draw
  const cancelEditPolygon = useCallback(() => {
    setEditMode('none');
    setEditVertices([]);
    setEditingMapId(null);
  }, []);

  // ── Draft apply / revert / discard (R2) ─────────────────────────
  const handleApplyEdits = useCallback(async () => {
    if (!sn || applying) return;
    setApplying(true);
    const r = await applyEdits(sn).catch(() => null);
    setApplying(false);
    if (!r) {
      setEditStatus(t('map.edit.pushFailed'));
      setEditStatusKind('error');
      await refreshEditGeometry();
      return;
    }
    if (r.ok) {
      const warnings = r.validation?.warnings ?? [];
      const warnText = warnings.map(w => `${w.canonical}: ${w.message}`).join('\n');
      setEditStatus([t('map.edit.applied'), warnText].filter(Boolean).join('\n'));
      setEditStatusKind(warnings.length ? 'warn' : 'ok');
      // Drafts are committed → the obstacle base in maps is now the new origin.
      obstacleOffsetBase.current.clear(); setOffsetAnnotation(null);
      await reloadMaps();
      await refreshEditGeometry();
      resetHistory(); // drafts cleared after apply → fresh empty history
      return;
    }
    switch (r.reason) {
      case 'validation': {
        const errors = r.validation?.errors ?? [];
        setEditStatus(errors.map(e => `${e.canonical}: ${e.message}`).join('\n') || t('map.edit.validationFailed'));
        setEditStatusKind('error');
        break; // keep drafts
      }
      case 'busy':
      case 'locked':
        setEditStatus(t('map.edit.busy'));
        setEditStatusKind('error');
        break;
      case 'offline':
        setEditStatus(t('map.edit.offline'));
        setEditStatusKind('error');
        break;
      case 'no_changes':
        setEditStatus(t('map.edit.noChanges'));
        setEditStatusKind('info');
        await refreshEditGeometry();
        break;
      case 'push_failed':
      case 'bundle_failed':
        setEditStatus(t('map.edit.pushFailed'));
        setEditStatusKind('error');
        await refreshEditGeometry();
        break;
      default:
        setEditStatus(t('map.edit.validationFailed'));
        setEditStatusKind('error');
        await refreshEditGeometry();
    }
  }, [sn, applying, reloadMaps, refreshEditGeometry, resetHistory, t]);

  const handleRevertEdits = useCallback(async () => {
    if (!sn || applying) return;
    if (!window.confirm(t('map.edit.confirmRevert'))) return;
    setApplying(true);
    const r = await revertEdits(sn).catch(() => null);
    setApplying(false);
    if (r?.ok) {
      setEditStatus(t('map.edit.applied'));
      setEditStatusKind('ok');
    } else {
      setEditStatus(r?.reason === 'no_changes' ? t('map.edit.nothingToRevert') : t('map.edit.pushFailed'));
      setEditStatusKind(r?.reason === 'no_changes' ? 'info' : 'error');
    }
    obstacleOffsetBase.current.clear(); setOffsetAnnotation(null);
    await reloadMaps();
    await refreshEditGeometry();
    resetHistory(); // server-side revert cleared drafts → fresh history
  }, [sn, applying, reloadMaps, refreshEditGeometry, resetHistory, t]);

  const handleDiscardEdits = useCallback(async () => {
    if (!sn || applying) return;
    if (!window.confirm(t('map.edit.confirmDiscard'))) return;
    setApplying(true);
    await discardEditDrafts(sn).catch(() => {});
    setApplying(false);
    setEditStatus('');
    setEditStatusKind('info');
    obstacleOffsetBase.current.clear(); setOffsetAnnotation(null);
    await reloadMaps();
    await refreshEditGeometry();
    resetHistory(); // drafts discarded → fresh empty history
  }, [sn, applying, reloadMaps, refreshEditGeometry, resetHistory, t]);

  // Latest LOCAL points for a canonical: the pending DRAFT if one exists
  // (editGeometry mirrors the server draft store), else the committed geometry
  // from the maps list. Both are local meters (charger = 0,0); no GPS round-trip.
  const latestLocalPoints = useCallback((canonical: string): XY[] | null => {
    const draftEntry = editGeometry?.maps.find(e => e.canonical === canonical);
    if (draftEntry?.draft && !draftEntry.draft.deleted && draftEntry.draft.points.length >= 3) {
      return draftEntry.draft.points.map(p => ({ x: p.x, y: p.y }));
    }
    const m = maps.find(p => p.canonicalName === canonical);
    if (m && m.mapArea.length >= 3) return m.mapArea.map(p => ({ x: p.x, y: p.y }));
    return null;
  }, [editGeometry, maps]);

  // ── Obstacle expand / shrink (R3, Part A) ───────────────────────
  // LOCAL points come straight from the maps list (mapArea is local meters,
  // charger = 0,0) — never via a GPS round-trip. Cumulative offset is computed
  // from a cached ORIGINAL base by the accumulated distance, so repeated clicks
  // do NOT compound the miter-join rounding of offsetPolygon.
  const OBSTACLE_OFFSET_STEP = 0.05; // meters per click
  const MIN_OBSTACLE_OFFSET_AREA = 0.5; // m² floor when shrinking

  const offsetSelectedObstacle = useCallback(async (dir: 1 | -1) => {
    if (!sn || applying) return;
    const target = maps.find(m => m.mapId === selectedMapId);
    if (!target || target.mapType !== 'obstacle' || !target.canonicalName) return;
    const canonical = target.canonicalName;

    // Seed the offset base ONCE from the current geometry (a prior brush draft
    // if present, else the committed map). All subsequent clicks offset from
    // that FIXED base by the running `accum` total — never from the previous
    // offset result — so miter-join rounding never compounds across clicks.
    // The cache is cleared on apply/revert/discard so the next session re-seeds.
    let entry = obstacleOffsetBase.current.get(canonical);
    if (!entry) {
      const raw = latestLocalPoints(canonical) ?? target.mapArea.map(p => ({ x: p.x, y: p.y }));
      // De-noise the base FIRST. The per-vertex miter offset explodes on a
      // densely-sampled, jagged obstacle boundary (tiny concave noise notches →
      // huge inward miter spikes — the "weird polygon" bug). RDP at ~5 cm removes
      // that noise while keeping the overall shape, so the offset stays smooth.
      const simplified = simplifyPolygon(raw, 0.05);
      entry = { base: simplified.length >= 3 ? simplified : raw, accum: 0 };
      obstacleOffsetBase.current.set(canonical, entry);
    }

    const nextAccum = entry.accum + dir * OBSTACLE_OFFSET_STEP;
    // Offset, then clean any residual self-intersection the inset/outset created.
    let next = offsetPolygon(entry.base, nextAccum);
    const cleaned = makeValidPolygon(next);
    if (cleaned.length >= 3) next = simplifyPolygon(cleaned, 0.02);

    if (dir < 0 && polygonArea(next) < MIN_OBSTACLE_OFFSET_AREA) {
      setEditStatus(t('map.edit.tooSmall'));
      setEditStatusKind('warn');
      return;
    }

    const r = await saveEditDraft(sn, { canonical, points: next.map(p => ({ x: p.x, y: p.y })) }).catch(() => null);
    if (!r || !r.ok) {
      setEditStatus(r?.error || t('map.edit.validationFailed'));
      setEditStatusKind('error');
      return;
    }
    entry.accum = nextAccum;
    // Dimension annotation: a leader from the ORIGINAL boundary to the offset one
    // at a representative (rightmost) vertex, labelled with the cumulative cm.
    const base = entry.base;
    let cx = 0, cy = 0;
    for (const p of base) { cx += p.x; cy += p.y; }
    cx /= base.length; cy /= base.length;
    let anchor = base[0];
    for (const p of base) if (p.x > anchor.x) anchor = p;
    const ax = anchor.x - cx, ay = anchor.y - cy;
    const al = Math.hypot(ax, ay) || 1;
    const cmVal = Math.round(nextAccum * 100);
    setOffsetAnnotation(cmVal === 0 ? null : {
      canonical,
      from: { x: anchor.x, y: anchor.y },
      to: { x: anchor.x + (ax / al) * nextAccum, y: anchor.y + (ay / al) * nextAccum },
      cm: cmVal,
    });
    setEditStatus('');
    setEditStatusKind('info');
    await refreshEditGeometry();
    recordHistory();
    await reloadMaps();
  }, [sn, applying, maps, selectedMapId, latestLocalPoints, refreshEditGeometry, reloadMaps, recordHistory, t]);

  // ── Obstacle copy / paste (R6) ──────────────────────────────────
  // COPY: read the selected obstacle's LOCAL points (same source expand/shrink
  // uses — the maps list `mapArea`, charger-relative meters) and stash them in
  // the persisted clipboard. Gated identically to expand/shrink (exactly one
  // obstacle map selected).
  const copySelectedObstacle = useCallback(() => {
    const target = maps.find(m => m.mapId === selectedMapId);
    if (!target || target.mapType !== 'obstacle' || !target.canonicalName) return;
    if (target.mapArea.length < 3) return;
    const points = target.mapArea.map(p => ({ x: p.x, y: p.y }));
    setObstacleClipboard({ points, sourceName: target.mapName ?? target.canonicalName ?? null });
    setEditStatus(t('map.edit.copied'));
    setEditStatusKind('info');
  }, [maps, selectedMapId, setObstacleClipboard, t]);

  // PASTE: drop the clipboard shape as a NEW obstacle DRAFT attached to a work
  // map. Parent work map preference:
  //   1. the selected map if it IS a work map (same-map / different-map paste —
  //      the user selects another work map first, then Paste),
  //   2. else the work map whose polygon CONTAINS the computed paste point,
  //   3. else the first work map.
  // Cross-mower: the clipboard persists via localStorage, so after switching
  // mowers Paste attaches the same relative shape to the NEW mower's work map.
  //
  // Placement: translate the clipboard points so their centroid lands at the
  // current Leaflet view CENTER (visible + not overlapping the original). If the
  // map instance / charger GPS isn't available, fall back to a small fixed +0.7m
  // x/y offset. The result becomes a pending dashed obstacle draft, included in
  // the next Apply and undoable via the F1 history.
  const pasteObstacle = useCallback(async () => {
    if (!sn || applying) return;
    const clip = obstacleClipboard;
    if (!clip || clip.points.length < 3) return;

    // Centroid of the clipboard shape (simple vertex average — adequate for
    // placement; exact area-centroid not needed here).
    const n = clip.points.length;
    const cx = clip.points.reduce((s, p) => s + p.x, 0) / n;
    const cy = clip.points.reduce((s, p) => s + p.y, 0) / n;

    // Desired centroid in the mapArea LOCAL frame. Prefer the Leaflet view
    // center → local (mirrors brushToLocal: gpsToLocal yields the charger-origin
    // frame, add the pose offset back to land in the mapArea frame). Fall back to
    // original-centroid + fixed delta when no map/GPS is available.
    let targetCx = cx + PASTE_FALLBACK_DELTA;
    let targetCy = cy + PASTE_FALLBACK_DELTA;
    const lmap = leafletMapRef.current;
    if (lmap && isUsableChargerGps(chargerGps)) {
      try {
        const center = lmap.getCenter();
        const offX = chargingPose?.x ?? 0;
        const offY = chargingPose?.y ?? 0;
        const l = gpsToLocal({ lat: center.lat, lng: center.lng }, chargerGps);
        const vc = { x: l.x + offX, y: l.y + offY };
        if (Number.isFinite(vc.x) && Number.isFinite(vc.y)) {
          targetCx = vc.x;
          targetCy = vc.y;
        }
      } catch { /* keep fixed-offset fallback */ }
    }

    const dx = targetCx - cx;
    const dy = targetCy - cy;
    const translated = clip.points.map(p => ({ x: p.x + dx, y: p.y + dy }));

    // Choose the parent work map canonical.
    const sel = maps.find(m => m.mapId === selectedMapId);
    const works = maps.filter(m => m.mapType === 'work' && m.canonicalName);
    let parent: MapData | undefined;
    if (sel && sel.mapType === 'work' && sel.canonicalName) {
      parent = sel; // explicit (same-map or different-map) selection
    } else {
      // Work map whose polygon contains the paste centroid, else the first work.
      parent = works.find(m => pointInPolygonXY({ x: targetCx, y: targetCy }, m.mapArea)) ?? works[0];
    }
    if (!parent || !parent.canonicalName) {
      setEditStatus(t('map.edit.pasteNoWork'));
      setEditStatusKind('warn');
      return;
    }

    const r = await saveEditDraft(sn, {
      mapType: 'obstacle',
      parentMap: parent.canonicalName,
      points: translated,
    }).catch(() => null);
    if (!r || !r.ok) {
      setEditStatus(r?.error || t('map.edit.validationFailed'));
      setEditStatusKind('error');
      return;
    }
    await refreshEditGeometry();
    recordHistory();
    await reloadMaps();
    // Auto-activate Move on the freshly pasted obstacle so the user can drag it
    // into position immediately. The paste's saveEditDraft response carries the
    // server-assigned canonical — the cleanest identifier (the pasted obstacle is
    // a draft-only map, may not be in the committed `maps` list). We do NOT touch
    // selectedMapId here: the draft obstacle has no maps-list entry to select, and
    // changing selectedMapId would trip the move-exit effect.
    if (r.canonical) {
      setMoveTargetCanonical(r.canonical);
      setMoveWorking(null);
      moveStroke.current = null;
      moveWorkingRef.current = null;
      setMoveMode(true);
    }
    setEditStatus(t('map.edit.pasted'));
    setEditStatusKind('info');
  }, [sn, applying, obstacleClipboard, maps, selectedMapId, chargerGps, chargingPose, refreshEditGeometry, recordHistory, reloadMaps, t]);

  // ── Push/pull brush (R3, Part B) ────────────────────────────────
  // Working state for a brush stroke: the densified base ring + the anchor that
  // was grabbed. delta is applied via applyBrush on every mousemove.
  const brushStroke = useRef<{ canonical: string; base: XY[]; anchor: XY } | null>(null);
  // Latest working polygon mirrored in a ref so mouseup reads the exact last
  // value regardless of React state-batching timing.
  const brushWorkingRef = useRef<XY[] | null>(null);

  // The selected map eligible for the brush (work or obstacle, not unicom).
  const brushTarget = useMemo(() => {
    const m = maps.find(p => p.mapId === selectedMapId);
    if (!m || !m.canonicalName) return null;
    if (m.mapType !== 'work' && m.mapType !== 'obstacle') return null;
    return m;
  }, [maps, selectedMapId]);

  const enterBrushMode = useCallback(() => {
    setEditMode('none');
    setEditVertices([]);
    setEditingMapId(null);
    setPaintMode(false);
    setPaintWorking(null);
    setMoveMode(false);
    setMoveTargetCanonical(null);
    setMoveWorking(null);
    setBrushMode(true);
    setBrushWorking(null);
    brushStroke.current = null;
  }, []);

  const exitBrushMode = useCallback(() => {
    setBrushMode(false);
    setBrushWorking(null);
    brushStroke.current = null;
  }, []);

  // Begin a stroke: hit-test the polygon edge near the pointer; if hit, grab.
  // Source from the LATEST geometry (prior brush draft if present) so successive
  // strokes accumulate rather than reverting to the committed base.
  const handleBrushDown = useCallback((m: XY) => {
    if (!brushTarget || !chargerGps) return false;
    const canonical = brushTarget.canonicalName!;
    const localPts = latestLocalPoints(canonical);
    if (!localPts || localPts.length < 3) return false;
    const hit = hitTestEdge(localPts, m, brushRadius * 2);
    if (!hit) return false;
    const base = densifyPolygon(localPts, brushRadius / 4);
    brushStroke.current = { canonical, base, anchor: m };
    brushWorkingRef.current = base;
    setBrushWorking(base);
    return true;
  }, [brushTarget, chargerGps, brushRadius, latestLocalPoints]);

  // During a stroke: push/pull the densified ring by the cursor delta.
  const handleBrushMove = useCallback((m: XY) => {
    const stroke = brushStroke.current;
    if (!stroke) return;
    const delta = { x: m.x - stroke.anchor.x, y: m.y - stroke.anchor.y };
    const next = applyBrush(stroke.base, stroke.anchor, delta, brushRadius);
    brushWorkingRef.current = next;
    setBrushWorking(next);
  }, [brushRadius]);

  // End a stroke: commit the working polygon as a draft, then re-source.
  const handleBrushUp = useCallback(async () => {
    const stroke = brushStroke.current;
    brushStroke.current = null;
    if (!stroke) return;
    const working = brushWorkingRef.current;
    brushWorkingRef.current = null;
    setBrushWorking(null);
    if (!working || working.length < 3 || !sn) return;
    const r = await saveEditDraft(sn, {
      canonical: stroke.canonical,
      points: working.map(p => ({ x: p.x, y: p.y })),
    }).catch(() => null);
    if (!r || !r.ok) {
      setEditStatus(r?.error || t('map.edit.validationFailed'));
      setEditStatusKind('error');
      return;
    }
    setEditStatus('');
    setEditStatusKind('info');
    await refreshEditGeometry();
    recordHistory();
    await reloadMaps();
  }, [sn, refreshEditGeometry, reloadMaps, recordHistory, t]);

  // Live in-progress brush overlay projected to GPS (same charger/pose shift as
  // gpsMaps / draftOverlays).
  const brushOverlayGps = useMemo(() => {
    if (!brushWorking || !isUsableChargerGps(chargerGps)) return null;
    const offX = chargingPose?.x ?? 0;
    const offY = chargingPose?.y ?? 0;
    const gps = brushWorking.flatMap(p => {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return [];
      const g = localToGps({ x: p.x - offX, y: p.y - offY }, chargerGps);
      if (!Number.isFinite(g.lat) || !Number.isFinite(g.lng)) return [];
      return [g];
    });
    return gps.length >= 3 ? gps : null;
  }, [brushWorking, chargerGps, chargingPose]);

  // GPS → mapArea-local frame for the brush. gpsToLocal yields {p.x-offX, p.y-offY}
  // (the frame gpsMaps renders into); add the pose offset back to match mapArea.
  const brushToLocal = useCallback((latlng: L.LatLng): XY => {
    if (!isUsableChargerGps(chargerGps)) return { x: NaN, y: NaN };
    const offX = chargingPose?.x ?? 0;
    const offY = chargingPose?.y ?? 0;
    const l = gpsToLocal({ lat: latlng.lat, lng: latlng.lng }, chargerGps);
    return { x: l.x + offX, y: l.y + offY };
  }, [chargerGps, chargingPose]);

  // ── Paint/erase brush (primary tool) ────────────────────────────
  // Working ring mirrored in a ref so mouseup reads the exact last value
  // regardless of React state-batching. canonical pins the stroke's target.
  const paintStroke = useRef<{ canonical: string } | null>(null);
  const paintWorkingRef = useRef<XY[] | null>(null);

  // The selected map eligible for paint (work or obstacle, not unicom) — same
  // gating as the push/pull brush.
  const paintTarget = useMemo(() => {
    const m = maps.find(p => p.mapId === selectedMapId);
    if (!m || !m.canonicalName) return null;
    if (m.mapType !== 'work' && m.mapType !== 'obstacle') return null;
    return m;
  }, [maps, selectedMapId]);

  const enterPaintMode = useCallback(() => {
    setEditMode('none');
    setEditVertices([]);
    setEditingMapId(null);
    setBrushMode(false);
    setBrushWorking(null);
    brushStroke.current = null;
    setMoveMode(false);
    setMoveTargetCanonical(null);
    setMoveWorking(null);
    setPaintMode(true);
    setPaintWorking(null);
    paintStroke.current = null;
    paintWorkingRef.current = null;
  }, []);

  const exitPaintMode = useCallback(() => {
    setPaintMode(false);
    setPaintWorking(null);
    paintStroke.current = null;
    paintWorkingRef.current = null;
  }, []);

  // Selecting a different map exits paint mode (the working ring was seeded from
  // the previous map). Re-enter from the new map's tool toolbar.
  useEffect(() => {
    setPaintMode(false);
    setPaintWorking(null);
    paintStroke.current = null;
    paintWorkingRef.current = null;
  }, [selectedMapId]);

  // Apply one brush op (paint=union / erase=difference) at a local point.
  const applyPaintOp = useCallback((prev: XY[], m: XY): XY[] => {
    return paintTool === 'paint'
      ? paintCircle(prev, m, paintRadius)
      : eraseCircle(prev, m, paintRadius);
  }, [paintTool, paintRadius]);

  // Begin a stroke: seed the working ring from the LATEST geometry (prior draft
  // if present) so successive strokes stack, then apply one op at the down point.
  const handlePaintDown = useCallback((m: XY) => {
    if (!chargerGps) return false;
    // Auto-target the work/obstacle map whose polygon is UNDER the brush, so you
    // edit the lobe you're pointing at — not a previously-selected map elsewhere.
    // Tested against each map's live LOCAL ring (same frame as the brush point).
    // Falls back to the selected map when the brush starts outside every polygon
    // (e.g. painting/extending an edge from just outside it).
    const under = maps.find(p => {
      if ((p.mapType !== 'work' && p.mapType !== 'obstacle') || !p.canonicalName) return false;
      const pts = latestLocalPoints(p.canonicalName);
      return !!pts && pts.length >= 3 && pointInPolygonXY(m, pts);
    });
    const target = under ?? paintTarget;
    if (!target || !target.canonicalName) return false;
    if (target.mapId !== selectedMapId) setSelectedMapId(target.mapId);  // select the lobe you're editing
    const canonical = target.canonicalName;
    const localPts = latestLocalPoints(canonical);
    if (!localPts || localPts.length < 3) return false;
    const next = (paintTool === 'paint' ? paintCircle : eraseCircle)(localPts, m, paintRadius);
    paintStroke.current = { canonical };
    paintWorkingRef.current = next;
    setPaintWorking(next);
    return true;
  }, [maps, paintTarget, selectedMapId, chargerGps, paintTool, paintRadius, latestLocalPoints]);

  // During a stroke: accumulate the op onto the working ring.
  const handlePaintMove = useCallback((m: XY) => {
    if (!paintStroke.current) return;
    const prev = paintWorkingRef.current;
    if (!prev || prev.length < 3) return;
    const next = applyPaintOp(prev, m);
    paintWorkingRef.current = next;
    setPaintWorking(next);
  }, [applyPaintOp]);

  // End a stroke: commit the working polygon as a draft, then re-source so the
  // next stroke stacks on the refreshed geometry. Paint mode stays ON.
  const handlePaintUp = useCallback(async () => {
    const stroke = paintStroke.current;
    paintStroke.current = null;
    if (!stroke) return;
    const working = paintWorkingRef.current;
    paintWorkingRef.current = null;
    setPaintWorking(null);
    if (!working || working.length < 3 || !sn) return;
    const r = await saveEditDraft(sn, {
      canonical: stroke.canonical,
      points: working.map(p => ({ x: p.x, y: p.y })),
    }).catch(() => null);
    if (!r || !r.ok) {
      setEditStatus(r?.error || t('map.edit.validationFailed'));
      setEditStatusKind('error');
      return;
    }
    setEditStatus('');
    setEditStatusKind('info');
    await refreshEditGeometry();
    recordHistory();
    await reloadMaps();
  }, [sn, refreshEditGeometry, reloadMaps, recordHistory, t]);

  // Live in-progress paint overlay projected to GPS (same charger/pose shift).
  const paintOverlayGps = useMemo(() => {
    if (!paintWorking || !isUsableChargerGps(chargerGps)) return null;
    const offX = chargingPose?.x ?? 0;
    const offY = chargingPose?.y ?? 0;
    const gps = paintWorking.flatMap(p => {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return [];
      const g = localToGps({ x: p.x - offX, y: p.y - offY }, chargerGps);
      if (!Number.isFinite(g.lat) || !Number.isFinite(g.lng)) return [];
      return [g];
    });
    return gps.length >= 3 ? gps : null;
  }, [paintWorking, chargerGps, chargingPose]);

  // GPS → mapArea-local frame for paint (same as brushToLocal).
  const paintToLocal = brushToLocal;
  // Identity latlng passthrough for the cursor preview (kept calibration-naive;
  // the brush operates in unrotated frame, like the live overlay before calibrate).
  const paintCursorLatLng = useCallback((latlng: L.LatLng): L.LatLng => latlng, []);

  // ── Move/translate tool ─────────────────────────────────────────
  // Current LOCAL points for a canonical = the pending DRAFT points if present
  // (a fresh paste / prior edit), else the committed `maps` entry's mapArea.
  // Same source ordering as latestLocalPoints, but keyed for the move target —
  // which may be a draft-only obstacle (paste) not yet in the maps list.
  const geometryFor = useCallback((canonical: string): XY[] | null => {
    const draftEntry = editGeometry?.maps.find(e => e.canonical === canonical);
    if (draftEntry?.draft && !draftEntry.draft.deleted && draftEntry.draft.points.length >= 3) {
      return draftEntry.draft.points.map(p => ({ x: p.x, y: p.y }));
    }
    const m = maps.find(p => p.canonicalName === canonical);
    if (m && m.mapArea.length >= 3) return m.mapArea.map(p => ({ x: p.x, y: p.y }));
    return null;
  }, [editGeometry, maps]);

  const exitMoveMode = useCallback(() => {
    setMoveMode(false);
    setMoveTargetCanonical(null);
    setMoveWorking(null);
    moveStroke.current = null;
    moveWorkingRef.current = null;
  }, []);

  // Enter move mode targeting a specific canonical. Mirrors how paint/brush
  // exit each other — this clears the other edit modes first.
  const enterMoveMode = useCallback((canonical: string) => {
    setEditMode('none');
    setEditVertices([]);
    setEditingMapId(null);
    setBrushMode(false);
    setBrushWorking(null);
    brushStroke.current = null;
    setPaintMode(false);
    setPaintWorking(null);
    paintStroke.current = null;
    paintWorkingRef.current = null;
    setMoveTargetCanonical(canonical);
    setMoveWorking(null);
    moveStroke.current = null;
    moveWorkingRef.current = null;
    setMoveMode(true);
  }, []);

  // Drag-in-progress state: the base points captured at mousedown + the grabbed
  // anchor. delta = current − anchor is added to every base point on mousemove.
  const moveStroke = useRef<{ canonical: string; base: XY[]; anchor: XY } | null>(null);
  const moveWorkingRef = useRef<XY[] | null>(null);

  // Begin a drag — only if the down point is INSIDE the target polygon (so the
  // user grabs the shape; outside lets the map pan). Seeds the base from the
  // LATEST geometry (draft if present) so successive nudges stack.
  const handleMoveDown = useCallback((m: XY): boolean => {
    if (!moveTargetCanonical || !chargerGps) return false;
    const pts = geometryFor(moveTargetCanonical);
    if (!pts || pts.length < 3) return false;
    if (!pointInPolygonXY(m, pts)) return false; // must press inside the shape
    moveStroke.current = { canonical: moveTargetCanonical, base: pts, anchor: m };
    moveWorkingRef.current = pts;
    setMoveWorking(pts);
    return true;
  }, [moveTargetCanonical, chargerGps, geometryFor]);

  // During a drag: translate every base point by (current − anchor).
  const handleMoveMove = useCallback((m: XY) => {
    const stroke = moveStroke.current;
    if (!stroke) return;
    const dx = m.x - stroke.anchor.x;
    const dy = m.y - stroke.anchor.y;
    const next = stroke.base.map(p => ({ x: p.x + dx, y: p.y + dy }));
    moveWorkingRef.current = next;
    setMoveWorking(next);
  }, []);

  // End a drag: commit the translated shape as a draft, refresh + record history,
  // then re-seed from the refreshed geometry. Move mode stays ON so the user can
  // nudge again. A zero-delta tap (anchor == release) writes the same points back
  // — harmless, the server validates identically; we skip it to avoid noise.
  const handleMoveUp = useCallback(async () => {
    const stroke = moveStroke.current;
    moveStroke.current = null;
    if (!stroke) return;
    const working = moveWorkingRef.current;
    moveWorkingRef.current = null;
    setMoveWorking(null);
    if (!working || working.length < 3 || !sn) return;
    // No-op tap (didn't actually move) → don't write a draft / history entry.
    const moved = working.some((p, i) => p.x !== stroke.base[i]?.x || p.y !== stroke.base[i]?.y);
    if (!moved) return;
    const r = await saveEditDraft(sn, {
      canonical: stroke.canonical,
      points: working.map(p => ({ x: p.x, y: p.y })),
    }).catch(() => null);
    if (!r || !r.ok) {
      setEditStatus(r?.error || t('map.edit.validationFailed'));
      setEditStatusKind('error');
      return;
    }
    setEditStatus('');
    setEditStatusKind('info');
    await refreshEditGeometry();
    recordHistory();
    await reloadMaps();
  }, [sn, refreshEditGeometry, reloadMaps, recordHistory, t]);

  // Live in-progress move overlay projected to GPS (same charger/pose shift as
  // gpsMaps / draftOverlays / paint overlay).
  const moveOverlayGps = useMemo(() => {
    if (!moveWorking || !isUsableChargerGps(chargerGps)) return null;
    const offX = chargingPose?.x ?? 0;
    const offY = chargingPose?.y ?? 0;
    const gps = moveWorking.flatMap(p => {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return [];
      const g = localToGps({ x: p.x - offX, y: p.y - offY }, chargerGps);
      if (!Number.isFinite(g.lat) || !Number.isFinite(g.lng)) return [];
      return [g];
    });
    return gps.length >= 3 ? gps : null;
  }, [moveWorking, chargerGps, chargingPose]);

  // GPS → mapArea-local frame for move (identical conversion to brushToLocal).
  const moveToLocal = brushToLocal;

  // Move mode is also a "selected map" type tool — selecting a different map (or
  // entering paint via the effect below) must exit it. The selectedMapId effect
  // (used by paint) is reused; mirror it for move so a new selection drops out.
  useEffect(() => {
    setMoveMode(false);
    setMoveTargetCanonical(null);
    setMoveWorking(null);
    moveStroke.current = null;
    moveWorkingRef.current = null;
  }, [selectedMapId]);

  // Add point in draw mode
  const handleDrawPoint = useCallback((latlng: [number, number]) => {
    setEditVertices(prev => [...prev, latlng]);
  }, []);

  const hasGps = lat && lng && lat !== '0' && lng !== '0';
  const position: [number, number] = (() => {
    const offLat = Number.isFinite(activeCal.offsetLat) ? activeCal.offsetLat : 0;
    const offLng = Number.isFinite(activeCal.offsetLng) ? activeCal.offsetLng : 0;
    // Prefer the live, cm-accurate local map_position projected through the
    // charger origin — exactly the same frame as the polygons. The mower's
    // reported GPS only updates sporadically (~every 50s) and carries the
    // ~base offset, so it makes a poor, frozen-looking marker. Fall back to the
    // reported GPS only when map_position or the charger origin is unavailable.
    const mx = mapX != null ? parseFloat(mapX) : NaN;
    const my = mapY != null ? parseFloat(mapY) : NaN;
    if (Number.isFinite(mx) && Number.isFinite(my) && isUsableChargerGps(chargerGps)) {
      const g = localToGps({ x: mx - (chargingPose?.x ?? 0), y: my - (chargingPose?.y ?? 0) }, chargerGps);
      const pLat = g.lat + offLat;
      const pLng = g.lng + offLng;
      if (Number.isFinite(pLat) && Number.isFinite(pLng)) return [pLat, pLng];
    }
    if (!hasGps) return DEFAULT_CENTER;
    const numLat = parseFloat(lat) + offLat;
    const numLng = parseFloat(lng) + offLng;
    if (!Number.isFinite(numLat) || !Number.isFinite(numLng)) return DEFAULT_CENTER;
    return [numLat, numLng];
  })();

  const [userInteracted, setUserInteracted] = useState(false);
  const [mapsFitted, setMapsFitted] = useState(false);

  const polygonMaps = gpsMaps.filter(m => m.mapArea.length >= 3);
  // Totale zone-oppervlakte = som van de work-map polygon-area's (m², lokale
  // meters). Dit is de "echte" oppervlakte zoals de app toont (bv. 204 m²),
  // i.t.t. de coverage-planner-schatting cov_area+cov_remaining (lager).
  const totalWorkAreaM2 = useMemo(() => {
    const sum = maps
      .filter(m => m.mapType === 'work' && Array.isArray(m.mapArea) && m.mapArea.length >= 3)
      .reduce((acc, m) => acc + polygonArea(m.mapArea as XY[]), 0);
    return sum > 0 ? sum : null;
  }, [maps]);

  // Trail (lokale map_position) → GPS via EXACT dezelfde transform als de maaier-
  // icoon: localToGps({x,y} − chargingPose, chargerGps) + calibratie-offset. Zo
  // valt de trail samen met de maaier, de polygonen en het coverage-pad.
  // GPS trail, split into contiguous SEGMENTS. We start a new segment whenever
  // two consecutive fixes jump more than TRAIL_GAP_M apart — i.e. a GPS
  // signal-loss gap. Rendering one straight polyline across such a gap made the
  // trail appear to cut straight through obstacles even though the mower drove
  // around them (issue #93: the long diagonal lines are interpolation across
  // dropouts, not the physical path — confirmed via surveillance camera). At
  // ~0.3 m/s a real step between samples is well under a metre, so a 5 m jump is
  // unambiguously a dropout, not mowing.
  const TRAIL_GAP_M = 5;
  const trailSegments: [number, number][][] = (() => {
    if (!isUsableChargerGps(chargerGps)) return [];
    const offLat = Number.isFinite(activeCal.offsetLat) ? activeCal.offsetLat : 0;
    const offLng = Number.isFinite(activeCal.offsetLng) ? activeCal.offsetLng : 0;
    const segs: [number, number][][] = [];
    let cur: [number, number][] = [];
    let prev: { x: number; y: number } | null = null;
    for (const p of trail) {
      if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) > TRAIL_GAP_M) {
        if (cur.length >= 2) segs.push(cur);
        cur = [];
      }
      prev = p;
      const g = localToGps({ x: p.x - (chargingPose?.x ?? 0), y: p.y - (chargingPose?.y ?? 0) }, chargerGps);
      const lat = g.lat + offLat;
      const lng = g.lng + offLng;
      if (Number.isFinite(lat) && Number.isFinite(lng)) cur.push([lat, lng]);
    }
    if (cur.length >= 2) segs.push(cur);
    return segs;
  })();
  const trailPositions: [number, number][] = trailSegments.flat();

  // Mower heading icon — `heading` carries the firmware `theta` field in
  // radians using the ENU convention (0 = East, π/2 = North). The icon
  // helper expects compass degrees (0 = North, 90 = East), so we have to
  // convert ENU → compass before passing it in. Earlier code converted
  // radians → degrees but skipped the ENU→compass step, leaving the
  // arrow rotated 90° clockwise from reality (issue #50 follow-up).
  const thetaRad = heading ? parseFloat(heading) : 0;
  const enuDeg = isNaN(thetaRad) ? 0 : (thetaRad * 180 / Math.PI);
  const compassDeg = ((90 - enuDeg) % 360 + 360) % 360;
  const mowerIcon = useMemo(() => makeMowerIcon(compassDeg), [compassDeg]);
  // Coverage stats per polygon (trail points inside each work area)
  const coverageStats = useMemo(() => {
    if (trail.length === 0) return new Map<string, { points: number; area: number }>();
    const stats = new Map<string, { points: number; area: number }>();
    // Trail én maps zijn lokaal {x,y} → lokale point-in-polygon + lokale area.
    for (const m of maps) {
      if (!Array.isArray(m.mapArea) || m.mapArea.length < 3) continue;
      if (getAreaStyle(m.mapType, m.mapId, m.mapName) !== AREA_STYLES.work) continue;
      const local = m.mapArea as XY[];
      const area = polygonArea(local);
      let count = 0;
      for (const tp of trail) {
        if (pointInPolygonXY({ x: tp.x, y: tp.y }, local)) count++;
      }
      stats.set(m.mapId, { points: count, area });
    }
    return stats;
  }, [trail, maps]);

  // Charger GPS: ALLEEN uit opgeslagen calibratie — nooit live GPS (voorkomt drift bij refresh)
  const resolvedChargerLat = savedCal.chargerLat || null;
  const resolvedChargerLng = savedCal.chargerLng || null;
  const chargerIcon = useMemo(() => makeChargerIcon(false), []);
  const chargerHasGps = !!(resolvedChargerLat && resolvedChargerLng);

  // Set the charger's DISPLAYED position (menu "Laadstation" click OR marker drag
  // — both routes call this, so they behave identically). The mower-reported
  // GPS (charger base) stays the source of truth and is NEVER overwritten; we
  // only store a VISUAL offset = target − base. Nothing is pushed to the mower.
  // When there is no base yet (mower never auto-detected) we adopt the clicked
  // point as the base so a charger can still be placed manually.
  const handlePlaceCharger = useCallback((lat: number, lng: number) => {
    // Always set the real charger anchor (base) — never a visual offset. The
    // drop point IS where the charger physically sits, so the anchor moves there
    // and the charger + polygons shift together. No relocateCharger: the local
    // polygon coords are unchanged and nothing is pushed to the mower. Setting
    // the base (not an offset) keeps the app consistent with the dashboard — the
    // app reads chargerGps directly and ignores offset.
    const updated: MapCalibration = { ...savedCal, chargerLat: lat, chargerLng: lng, offsetLat: 0, offsetLng: 0 };
    setSavedCal(updated);
    setPlacingCharger(false);
    saveCalibration(sn, updated).then(() => {
      toast(t('map.chargerSaved'), 'success');
    });
  }, [sn, savedCal, t]);

  // Push maps to mower via SSH
  // Navigate-to handler — GPS coords direct van Leaflet klik
  const handleNavigateClick = useCallback((lat: number, lng: number) => {
    setNavigateTarget({ lat, lng });
    setNavigateMode(false);
    navigateToPosition(sn, lat, lng).then(() => {
      toast(`✓ ${t('controls.navigateTo')}`, 'success');
    }).catch(() => toast(`✗ ${t('controls.navigateTo')}`, 'error'));
    setTimeout(() => setNavigateTarget(null), 60_000);
  }, [sn, t, toast]);

  const handleStopNavigation = useCallback(() => {
    setNavigateTarget(null);
    stopNavigation(sn).then(() => {
      toast(`✓ ${t('controls.stopNavigation')}`, 'success');
    }).catch(() => {});
  }, [sn, t, toast]);

  // Virtual wall drawing — GPS coords direct van Leaflet klik
  const handleWallPoint = useCallback((lat: number, lng: number) => {
    if (!wallFirstCorner) {
      setWallFirstCorner({ lat, lng });
    } else {
      createVirtualWall(sn, {
        lat1: wallFirstCorner.lat,
        lng1: wallFirstCorner.lng,
        lat2: lat,
        lng2: lng,
      }).then(() => {
        fetchVirtualWalls(sn).then(setWalls).catch(() => {});
        toast(`✓ No-go zone saved`, 'success');
        setWallFirstCorner(null);
        setWallDrawMode(false);
      }).catch(() => toast(`✗ No-go zone`, 'error'));
    }
  }, [sn, wallFirstCorner, toast]);

  const handleDeleteWall = useCallback((wallId: string) => {
    deleteVirtualWall(sn, wallId).then(() => {
      setWalls(prev => prev.filter(w => w.wall_id !== wallId));
      toast(`✓ No-go zone deleted`, 'success');
    }).catch(() => toast(`✗ Delete failed`, 'error'));
  }, [sn, toast]);

  // Center of all polygon points (used as rotation/scale pivot). Skip
  // any non-finite vertex so a single NaN doesn't propagate into the
  // pathDirection preview polylines and crash Leaflet (issue #15).
  const polyCenter = useMemo(() => {
    let totalLat = 0, totalLng = 0, count = 0;
    for (const m of polygonMaps) {
      for (const p of m.mapArea) {
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
        totalLat += p.lat;
        totalLng += p.lng;
        count++;
      }
    }
    if (count === 0) {
      const [pLat, pLng] = position;
      if (Number.isFinite(pLat) && Number.isFinite(pLng)) {
        return { lat: pLat, lng: pLng };
      }
      return { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] };
    }
    return { lat: totalLat / count, lng: totalLng / count };
  }, [polygonMaps, position]);

  // Calibration handlers
  // De edit-offset houden we in GRADEN aan zodat de bestaande preview
  // (calibratePoints) ongewijzigd blijft; conversie meters↔graden gebeurt alleen
  // aan de randen (seed bij openen + apply). Zo vermijden we dubbele conversie in
  // de render.
  const startCalibrating = useCallback(() => {
    setEditCal({ ...savedCal });
    setUserInteracted(true); // prevent auto-recenter during calibration
    // apply-offset zet de offset ABSOLUUT. Start de sessie daarom vanaf de reeds
    // toegepaste offset, anders wist een nieuwe nudge-sessie de vorige verschuiving.
    // De seed komt async binnen (netwerk-round-trip). Om te voorkomen dat een
    // nudge in dat venster stil wordt overschreven door de `.then` (race), houden
    // we de pijltjes uit tot de seed er is (seedLoading). Zo kan er geen nudge
    // gebeuren vóór de seed en gaat er niets verloren; de baseline klopt altijd.
    setSeedLoading(true);
    fetchPolygonOffset(sn).then(({ dxM, dyM }) => {
      const latDeg = chargerGps?.lat ?? polyCenter.lat;
      if (!Number.isFinite(latDeg)) return;
      const { offsetLat, offsetLng } = metersToOffsetDeg(dxM, dyM, latDeg);
      setEditCal(prev => prev ? { ...prev, offsetLat, offsetLng } : prev);
    }).catch(() => {}).finally(() => setSeedLoading(false));
  }, [savedCal, sn, chargerGps, polyCenter]);

  const cancelCalibrating = useCallback(() => {
    setEditCal(null);
  }, []);

  // Huidige totale offset in meters (voor de readout naast de pijltjes).
  const shiftOffsetM = useMemo(() => {
    if (!editCal) return { dxM: 0, dyM: 0 };
    const latDeg = chargerGps?.lat ?? polyCenter.lat;
    if (!Number.isFinite(latDeg)) return { dxM: 0, dyM: 0 };
    return offsetDegToMeters(editCal.offsetLat, editCal.offsetLng, latDeg);
  }, [editCal, chargerGps, polyCenter]);

  const applyShift = useCallback(async (dxM: number, dyM: number, calForDisplay: MapCalibration) => {
    const r = await applyPolygonOffset(sn, dxM, dyM);
    // Bij maaier offline geeft de server een "pick up on next reconnect"-melding
    // door; dat is een waarschuwing (offset is opgeslagen), geen echte fout.
    const offline = !r.ok && /reconnect|offline/i.test(r.error ?? '');
    if (!r.ok && !offline) { toast(r.error ?? t('map.shiftFailed'), 'error'); return false; }
    // Display-overlay (offset_lat/lng + rotatie + schaal) in sync houden met de
    // toegepaste maai-offset zodat de kaart ook na sluiten van het paneel klopt.
    saveCalibration(sn, calForDisplay).catch(() => {});
    setSavedCal(calForDisplay);
    setEditCal(null);
    toast(offline ? t('map.shiftOffline') : t('map.shiftApplied'), offline ? 'info' : 'success');
    return true;
  }, [sn, t, toast]);

  const handleApplyOffset = useCallback(async () => {
    if (!editCal) return;
    const latDeg = chargerGps?.lat ?? polyCenter.lat;
    if (!Number.isFinite(latDeg)) { toast(t('map.shiftFailed'), 'error'); return; }
    // editCal.offset is in graden; converteer naar meters (+x oost, +y noord —
    // zelfde frame als shiftPoints). LET OP: teken/richting is nog NIET hardware-
    // geverifieerd (aparte Fase 0). Mapping bewust recht-toe-recht-aan (noord-pijl
    // → +dy noord, oost-pijl → +dx oost) zodat de latere check dit op één plek
    // kan bevestigen of omdraaien.
    const { dxM, dyM } = offsetDegToMeters(editCal.offsetLat, editCal.offsetLng, latDeg);
    await applyShift(dxM, dyM, editCal);
  }, [editCal, chargerGps, polyCenter, applyShift, t, toast]);

  const handleResetOffset = useCallback(async () => {
    const zeroed: MapCalibration = { ...(editCal ?? savedCal), offsetLat: 0, offsetLng: 0 };
    await applyShift(0, 0, zeroed);
  }, [editCal, savedCal, applyShift]);

  const nudge = useCallback((dxM: number, dyM: number) => {
    const latDeg = chargerGps?.lat ?? polyCenter.lat;
    if (!Number.isFinite(latDeg)) return;
    const d = metersToOffsetDeg(dxM, dyM, latDeg);
    setEditCal(prev => prev ? { ...prev, offsetLat: prev.offsetLat + d.offsetLat, offsetLng: prev.offsetLng + d.offsetLng } : prev);
  }, [chargerGps, polyCenter]);

  return (
    <div className="bg-gray-800 rounded-none md:rounded-xl border-0 md:border md:border-gray-700 overflow-hidden flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between px-1.5 md:px-4 py-1.5 md:py-2 border-b border-gray-700 flex-shrink-0 overflow-x-auto gap-1 md:gap-2">
        <div className="flex items-center gap-1.5 md:gap-3">
          <MapPin className="w-4 h-4 text-blue-400 hidden md:block" />
          {/* Alleen loc-quality (map-relevant). Battery/wifi/GPS staan al in de
              bovenste status-bar (DeviceChips) — hier weggelaten om dubbele info
              boven de kaart te voorkomen. */}
          {signals && (() => {
            const loc = signals.locQuality ? parseInt(signals.locQuality, 10) : null;
            if (loc === null) return null;
            return (
              <span className={`hidden md:inline-flex items-center gap-0.5 ${locColor(loc)}`} title={t('devices.locLabel', { loc })}>
                <Crosshair className="w-3.5 h-3.5" />
                <span className="text-[10px] font-mono">{loc}%</span>
              </span>
            );
          })()}
        </div>
        <div className="flex items-center gap-1 md:gap-3">
          {lastMowedDate && (
            <span className="inline-flex items-center gap-1 text-xs px-1.5 md:px-2 py-0.5 rounded bg-emerald-900/50 text-emerald-400" title={`Laatst gemaaid: ${lastMowedDate}`}>
              <CheckCircle2 className="w-3 h-3" />
              <span className="hidden md:inline">Gemaaid</span>
            </span>
          )}
          {/* View/edit tools moved to the floating tool-rail (over the map). */}
          {polygonMaps.length > 0 && (() => {
            const counts = { work: 0, obstacle: 0, unicom: 0, other: 0 };
            // Channel filename pattern: only inter-map unicoms are user-
            // visible "channels". `mapXtochargeY_unicom` is the dock-route
            // helper line and isn't counted (matches dir26738's expectation
            // in #28: "I have 2 channels" for a mower with 1 charge + 2
            // inter-map unicoms).
            const isChannelUnicom = (m: { fileName?: string | null; canonicalName?: string | null; mapName?: string | null }) =>
              !/tocharge/i.test(`${m.fileName ?? ''} ${m.canonicalName ?? ''} ${m.mapName ?? ''}`);
            // Work + obstacle still need 3+ points to be a real polygon.
            for (const m of polygonMaps) {
              const s = getAreaStyle(m.mapType, m.mapId, m.mapName);
              if (s === AREA_STYLES.work) counts.work++;
              else if (s === AREA_STYLES.obstacle) counts.obstacle++;
              else if (s === AREA_STYLES.unicom) {
                if (isChannelUnicom(m)) counts.unicom++;
              }
              else counts.other++;
            }
            // Issue #28 round 2: LFI cloud stores inter-map channels as
            // metadata-only (empty CSV by design — see setup.ts line 396),
            // so they have mapArea.length === 0 and were dropped by both
            // the polygon-only filter AND the previous "2-point lines"
            // fallback. Count any DB row of mapType === 'unicom' as a
            // channel regardless of point count, dedup against polygons
            // already counted by mapId.
            const polygonUnicomIds = new Set(polygonMaps.filter(m => m.mapType === 'unicom').map(m => m.mapId));
            for (const m of maps) {
              if (m.mapType === 'unicom' && !polygonUnicomIds.has(m.mapId) && isChannelUnicom(m)) {
                counts.unicom++;
              }
            }
            const parts: string[] = [];
            if (counts.work > 0) parts.push(t('map.maps', { count: counts.work }));
            if (counts.obstacle > 0) parts.push(t('map.obstacles', { count: counts.obstacle }));
            if (counts.unicom > 0) parts.push(t('map.channels', { count: counts.unicom }));
            if (counts.other > 0) parts.push(t('map.otherCount', { count: counts.other }));
            return (
              <span className="hidden md:inline-flex items-center gap-1 text-xs text-gray-500">
                <MapIcon className="w-3 h-3" />
                {parts.join(', ')}
              </span>
            );
          })()}
          {hasGps ? (
            <span className="hidden md:inline text-xs text-gray-500 font-mono">
              {parseFloat(lat).toFixed(6)}, {parseFloat(lng).toFixed(6)}
            </span>
          ) : (
            <span className="hidden md:inline text-xs text-gray-600">{t('map.noGps')}</span>
          )}
        </div>
      </div>
      <div className="relative flex-1 min-h-0">
        <MapContainer
          center={position}
          zoom={20}
          maxZoom={25}
          className="h-full w-full"
          zoomControl={true}
          scrollWheelZoom={true}
          whenReady={() => setUserInteracted(false)}
        >
          <TileLayer
            key={tileLayer}
            attribution={TILE_LAYERS[tileLayer].attribution}
            url={TILE_LAYERS[tileLayer].url}
            maxZoom={TILE_LAYERS[tileLayer].maxZoom}
            maxNativeZoom={TILE_LAYERS[tileLayer].maxNativeZoom}
          />
          {/* Capture the Leaflet instance so paste can read the view center (R6) */}
          <MapInstanceCapture mapRef={leafletMapRef} />
          {/* Saved map polygons with calibration applied */}
          {polygonMaps.map(m => {
            // Dok-route-unicom: punt 0 (het dok-anker) niet meeschuiven — zelfde
            // uitsluiting als server-side shiftPoints, dus preview == maaier.
            const positions = calibratePoints(m.mapArea, activeCal, polyCenter, isToChargeUnicomName(m.canonicalName));
            const baseStyle = getAreaStyle(m.mapType, m.mapId, m.mapName);
            const isBeingEdited = editMode === 'edit' && editingMapId === m.mapId;
            const isSelected = selectedMapId === m.mapId;
            // Dim the polygon being edited (the editor shows its own)
            const style = isBeingEdited
              ? { ...baseStyle, fillOpacity: 0.1, weight: 1, opacity: 0.3, dashArray: '4, 4' }
              : isSelected
                ? { ...baseStyle, fillOpacity: 0.5, weight: 3, opacity: 1 }
                : baseStyle;
            return (
              <Polygon
                key={m.mapId}
                positions={positions}
                pathOptions={style}
                eventHandlers={{
                  // While placing a pattern, the polygon must NOT swallow the click
                  // (stopPropagation) — let it reach the map's PatternClickHandler.
                  click: (editMode === 'none' && !onMapClickForPattern) ? (e) => {
                    L.DomEvent.stopPropagation(e);
                    setSelectedMapId(prev => prev === m.mapId ? null : m.mapId);
                  } : undefined,
                }}
              >
                {m.mapName && editMode === 'none' && (
                  <Tooltip sticky>{m.mapName}</Tooltip>
                )}
              </Polygon>
            );
          })}
          {/* Pending draft overlays (R2) — dashed, drawn on top of saved maps.
              Hidden while actively editing so the in-progress editor is clear. */}
          {editMode === 'none' && draftOverlays.map(d => {
            const positions = calibratePoints(d.gps, activeCal, polyCenter);
            const base = getAreaStyle(d.mapType);
            return (
              <Polygon
                key={`draft-${d.canonical}`}
                positions={positions}
                pathOptions={{ ...base, dashArray: '6 4', weight: 2, fillOpacity: 0.18, opacity: 0.9 }}
              />
            );
          })}
          {/* Coverage-path preview — the real boustrophedon mowing lines the
              mower will cut ("black lines"). Drawn above the satellite tiles,
              projected into the same frame as the work polygons. */}
          {showCoverage && coverageGps.map(cp => {
            // Finished/active coloring only while ACTUALLY mowing (live plan). A
            // static preview must NOT inherit the previous session's progress —
            // finished_area lingers in the sensors after a mow, which would paint
            // the fresh preview as "already done". Preview => uniform planned path.
            const isFinished = coverageLive && !progressIsStale && coverProgress.finished.has(cp.id);
            const isActive = coverageLive && !progressIsStale && cp.id === coverProgress.activeId;
            const full = calibratePoints(cp.gps, activeCal, polyCenter);
            // Finished sub-area → dik groen ("gemaaid"), zoals de app.
            if (isFinished) {
              return (
                <Polyline key={`cov-${cp.id}`} positions={full}
                  pathOptions={{ color: 'rgba(34,197,94,0.9)', weight: 3.5, opacity: 1, lineCap: 'round', lineJoin: 'round' }} />
              );
            }
            // Active lane → the lane the mower is working on RIGHT NOW. Draw it
            // YELLOW (thick) so it stands out, then overlay the already-covered
            // start portion (0..covering_area_points) in green so progress within
            // the lane is visible. When the lane completes it joins `finished`
            // and renders fully green — exactly like the OpenNova app.
            if (isActive) {
              const done = coverProgress.activePoints >= 2
                ? calibratePoints(cp.gps.slice(0, coverProgress.activePoints), activeCal, polyCenter)
                : null;
              return (
                <Fragment key={`cov-${cp.id}`}>
                  <Polyline positions={full}
                    pathOptions={{ color: '#fbbf24', weight: 3, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }} />
                  {done && done.length >= 2 && (
                    <Polyline positions={done}
                      pathOptions={{ color: 'rgba(34,197,94,0.95)', weight: 3.5, opacity: 1, lineCap: 'round', lineJoin: 'round' }} />
                  )}
                </Fragment>
              );
            }
            // Not-yet-started lane → thin faint hint while live; thicker cyan in
            // the static idle preview so the planned path stays clearly visible.
            const baseStyle = coverageLive
              ? { color: 'rgba(255,255,255,0.35)', weight: 1, opacity: 0.8 }
              : { color: 'rgba(56,189,248,0.9)', weight: 1.5, opacity: 0.9 };
            return (
              <Polyline key={`cov-${cp.id}`} positions={full}
                pathOptions={{ ...baseStyle, lineCap: 'round', lineJoin: 'round' }} />
            );
          })}
          {/* Push/pull brush (R3): live in-progress stroke + pointer handler. */}
          {brushMode && brushOverlayGps && brushOverlayGps.length >= 3 && (
            <Polygon
              positions={calibratePoints(brushOverlayGps, activeCal, polyCenter)}
              pathOptions={{ color: '#a78bfa', weight: 2, dashArray: '6 4', fillOpacity: 0.12, fillColor: '#a78bfa' }}
            />
          )}
          {brushMode && editMode === 'none' && !calibrating && (
            <BrushPointerHandler
              toLocal={brushToLocal}
              onDown={handleBrushDown}
              onMove={handleBrushMove}
              onUp={handleBrushUp}
            />
          )}
          {/* Paint/erase brush (primary tool): live in-progress stroke. */}
          {paintMode && paintOverlayGps && paintOverlayGps.length >= 3 && (
            <Polygon
              positions={calibratePoints(paintOverlayGps, activeCal, polyCenter)}
              pathOptions={{
                color: paintTool === 'paint' ? '#34d399' : '#f59e0b',
                weight: 2, dashArray: '6 4', fillOpacity: 0.14,
                fillColor: paintTool === 'paint' ? '#34d399' : '#f59e0b',
              }}
            />
          )}
          {paintMode && editMode === 'none' && !calibrating && (
            <PaintPointerHandler
              toLatLng={paintCursorLatLng}
              toLocal={paintToLocal}
              radius={paintRadius}
              onDown={handlePaintDown}
              onMove={handlePaintMove}
              onUp={handlePaintUp}
            />
          )}
          {/* Move/translate tool: live in-progress dashed overlay of the shape at
              its dragged position, plus the pointer handler. */}
          {moveMode && moveOverlayGps && moveOverlayGps.length >= 3 && (
            <Polygon
              positions={calibratePoints(moveOverlayGps, activeCal, polyCenter)}
              pathOptions={{ color: '#22d3ee', weight: 2, dashArray: '6 4', fillOpacity: 0.14, fillColor: '#22d3ee' }}
            />
          )}
          {moveMode && moveTargetCanonical && editMode === 'none' && !calibrating && (
            <MovePointerHandler
              toLocal={moveToLocal}
              onDown={handleMoveDown}
              onMove={handleMoveMove}
              onUp={handleMoveUp}
            />
          )}
          {/* Polygon editor overlay */}
          {editMode !== 'none' && editVertices.length >= 2 && (
            <PolygonEditor vertices={editVertices} onChange={setEditVertices} color={editorColor} />
          )}
          {/* Draw mode: click handler to add points */}
          {editMode === 'draw' && (
            <DrawClickHandler onPoint={handleDrawPoint} />
          )}
          {/* Edge offset preview (dashed polygon) */}
          {offsetPreview && offsetPreview.length >= 3 && (
            <Polygon
              positions={offsetPreview.map(p => [p.lat, p.lng] as [number, number])}
              pathOptions={{ color: '#22d3ee', weight: 2, dashArray: '6 4', fillOpacity: 0.05, fillColor: '#22d3ee' }}
            />
          )}
          {/* Obstacle expand/shrink dimension annotation: leader line from the
              original boundary to the offset one + a cm badge. */}
          {offsetAnnotation && isUsableChargerGps(chargerGps) && (() => {
            const offX = chargingPose?.x ?? 0, offY = chargingPose?.y ?? 0;
            const fromG = localToGps({ x: offsetAnnotation.from.x - offX, y: offsetAnnotation.from.y - offY }, chargerGps);
            const toG = localToGps({ x: offsetAnnotation.to.x - offX, y: offsetAnnotation.to.y - offY }, chargerGps);
            const pts = calibratePoints([fromG, toG], activeCal, polyCenter);
            if (pts.length < 2) return null;
            const cm = offsetAnnotation.cm;
            const color = cm >= 0 ? '#38bdf8' : '#f59e0b';
            const label = `${cm > 0 ? '+' : ''}${cm} cm`;
            const labelIcon = L.divIcon({
              className: '',
              html: `<div style="transform:translate(-50%,-130%);white-space:nowrap;background:${color};color:#0b1220;font:600 11px/1.2 system-ui,sans-serif;padding:2px 6px;border-radius:6px;box-shadow:0 0 4px rgba(0,0,0,0.55)">${label}</div>`,
              iconSize: [0, 0],
              iconAnchor: [0, 0],
            });
            return (
              <>
                <Polyline positions={pts} pathOptions={{ color, weight: 2, opacity: 0.95 }} />
                <CircleMarker center={pts[0]} radius={3} pathOptions={{ color, fillColor: color, fillOpacity: 1, weight: 0 }} />
                <CircleMarker center={pts[1]} radius={3} pathOptions={{ color, fillColor: color, fillOpacity: 1, weight: 0 }} />
                <Marker position={pts[1]} icon={labelIcon} interactive={false} />
              </>
            );
          })()}
          {/* Afgelegde maai-banen (dunne lijntjes geclipt aan polygon) */}
          {coveredLanes && coveredLanes.length > 0 && !progressIsStale && (() => {
            const wPolys = polygonMaps
              .filter(m => getAreaStyle(m.mapType, m.mapId, m.mapName) === AREA_STYLES.work)
              .map(m => {
                const calPts = calibratePoints(m.mapArea, activeCal, polyCenter);
                return calPts.map(([lat, lng]) => ({ lat, lng }));
              });
            return <CoverageStripes lanes={coveredLanes} workPolys={wPolys} />;
          })()}
          {/* GPS trail centerline — ook TIJDENS maaien tonen als voortgang (waar de
              maaier al geweest is). Eerder verborgen bij work_status==='1', maar dat
              verstopte de maai-voortgang precies wanneer je 'm wilt zien. */}
          {showTrail && !showHeatmap && trailSegments.map((seg, i) => (
            seg.length >= 2 ? (
              <Polyline
                key={`trail-${i}`}
                positions={seg}
                pathOptions={{
                  color: '#06b6d4',
                  weight: 1.5,
                  opacity: 0.5,
                  dashArray: '4, 3',
                }}
              />
            ) : null
          ))}
          {/* Heatmap mode: color trail segments by recency */}
          {showHeatmap && trailPositions.length >= 2 && (() => {
            const chunkSize = Math.max(2, Math.floor(trailPositions.length / 30));
            const chunks: [number, number][][] = [];
            for (let i = 0; i < trailPositions.length; i += chunkSize) {
              const chunk = trailPositions.slice(i, i + chunkSize + 1);
              if (chunk.length >= 2) chunks.push(chunk);
            }
            return chunks.map((chunk, idx) => {
              const tp = chunks.length > 1 ? idx / (chunks.length - 1) : 1;
              const r = Math.round(255 * (1 - tp));
              const g = Math.round(200 * tp);
              const b = Math.round(50 + 100 * (1 - tp));
              return (
                <Polyline
                  key={`heat-${idx}`}
                  positions={chunk}
                  pathOptions={{
                    color: `rgb(${r},${g},${b})`,
                    weight: 4,
                    opacity: 0.3 + 0.5 * tp,
                    lineCap: 'round',
                  }}
                />
              );
            });
          })()}
          {/* Live outline during autonomous mapping (report_state_map_outline) */}
          {liveOutline && liveOutline.length >= 3 && (
            <Polygon
              positions={liveOutline.map(p => [p.lat, p.lng] as [number, number])}
              pathOptions={{
                color: '#a855f7',
                fillColor: '#a855f7',
                fillOpacity: 0.08,
                weight: 2.5,
                opacity: 0.85,
                dashArray: '8, 5',
              }}
            />
          )}
          {/* Mower marker with heading arrow */}
          {hasGps && (
            <Marker position={position} icon={mowerIcon}>
              <Popup>
                <div className="text-xs">
                  <div className="font-semibold">{t('map.mower')}</div>
                  <div>{parseFloat(lat).toFixed(6)}, {parseFloat(lng).toFixed(6)}</div>
                  {heading && <div>{t('map.headingLabel', { deg: parseFloat(heading).toFixed(0) })}</div>}
                </div>
              </Popup>
            </Marker>
          )}
          {/* Click-to-place charger handler */}
          {placingCharger && <ChargerPlacer onPlace={handlePlaceCharger} />}
          {/* Charger marker (draggable to reposition) — apply same calibration offset as polygons */}
          {chargerHasGps && (
            <Marker
              position={[resolvedChargerLat! + activeCal.offsetLat, resolvedChargerLng! + activeCal.offsetLng]}
              icon={chargerIcon}
              draggable
              eventHandlers={{
                dragend: (e) => {
                  // Same path as the menu "Laadstation" placement: set the real
                  // charger anchor (base) to the drop point. Anchor + polygons
                  // shift together; never pushes to the mower.
                  const { lat, lng } = e.target.getLatLng();
                  handlePlaceCharger(lat, lng);
                },
              }}
            >
              <Popup>
                <div className="text-xs">
                  <div className="font-semibold">{t('map.chargingStation')}</div>
                  <div>{(resolvedChargerLat! + activeCal.offsetLat).toFixed(6)}, {(resolvedChargerLng! + activeCal.offsetLng).toFixed(6)}</div>
                  {(activeCal.offsetLat !== 0 || activeCal.offsetLng !== 0) && (
                    <div className="mt-1 font-medium text-gray-500">
                      {t('map.chargerVisualOffset', 'Visuele offset — maaier-data ongemoeid')}
                    </div>
                  )}
                  <div className="text-gray-400 mt-0.5">{t('map.dragToReposition')}</div>
                </div>
              </Popup>
            </Marker>
          )}
          {/* Path direction preview: blauwe lijnen bij richting selectie */}
          {pathDirectionPreview != null && Number.isFinite(polyCenter.lat) && Number.isFinite(polyCenter.lng) && polyCenter.lat !== 0 && (() => {
            const deg = pathDirectionPreview;
            const rad = (deg * Math.PI) / 180;
            const dLat = Math.cos(rad);
            const dLng = Math.sin(rad);
            const pLat = -dLng;
            const pLng = dLat;

            const workPolys = polygonMaps
              .filter(m => getAreaStyle(m.mapType, m.mapId, m.mapName) === AREA_STYLES.work)
              .map(m => {
                const calPts = calibratePoints(m.mapArea, activeCal, polyCenter);
                return calPts.map(([lat, lng]) => ({ lat, lng }));
              });
            if (workPolys.length === 0) return null;

            let minPerp = Infinity, maxPerp = -Infinity;
            let minPar = Infinity, maxPar = -Infinity;
            for (const poly of workPolys) {
              for (const p of poly) {
                const dL = p.lat - polyCenter.lat;
                const dN = p.lng - polyCenter.lng;
                const perp = dL * pLat + dN * pLng;
                const par = dL * dLat + dN * dLng;
                if (perp < minPerp) minPerp = perp;
                if (perp > maxPerp) maxPerp = perp;
                if (par < minPar) minPar = par;
                if (par > maxPar) maxPar = par;
              }
            }

            const spacing = 0.000008;
            const margin = spacing * 2;
            const lineExtent = Math.max(Math.abs(maxPar), Math.abs(minPar)) + margin;
            const startPerp = Math.floor((minPerp - margin) / spacing) * spacing;
            const endPerp = maxPerp + margin;

            const allSegments: [number, number][][] = [];
            for (let offset = startPerp; offset <= endPerp; offset += spacing) {
              const cLat = polyCenter.lat + pLat * offset;
              const cLng = polyCenter.lng + pLng * offset;
              const rawLine: [[number, number], [number, number]] = [
                [cLat - dLat * lineExtent, cLng - dLng * lineExtent],
                [cLat + dLat * lineExtent, cLng + dLng * lineExtent],
              ];
              for (const poly of workPolys) {
                const clipped = clipLineToPolygon(rawLine, poly);
                for (const seg of clipped) allSegments.push(seg);
              }
            }

            return allSegments.map((seg, idx) => (
              <Polyline
                key={`dir-${idx}`}
                positions={seg}
                pathOptions={{ color: '#60a5fa', weight: 2, opacity: 0.7 }}
              />
            ));
          })()}
          {/* Pattern overlay (placed pattern preview) */}
          {patternPlacement && <PatternOverlay placement={patternPlacement} />}
          {/* Pattern placement click handler */}
          {onMapClickForPattern && !placingCharger && editMode === 'none' && (
            <PatternClickHandler onClick={onMapClickForPattern} />
          )}
          {/* Navigate-to click handler */}
          {navigateMode && !placingCharger && editMode === 'none' && !wallDrawMode && (
            <NavigateClickHandler onClick={handleNavigateClick} />
          )}
          {/* Navigate-to target marker */}
          {navigateTarget && (
            <Marker position={[navigateTarget.lat, navigateTarget.lng]} icon={targetIcon}>
              <Popup>
                <div className="text-xs">
                  <div className="font-semibold">Navigation target</div>
                  <div>{navigateTarget.lat.toFixed(6)}, {navigateTarget.lng.toFixed(6)}</div>
                </div>
              </Popup>
            </Marker>
          )}
          {/* Virtual wall draw click handler */}
          {wallDrawMode && !placingCharger && editMode === 'none' && (
            <WallDrawClickHandler onPoint={handleWallPoint} />
          )}
          {/* Virtual wall first corner preview */}
          {wallDrawMode && wallFirstCorner && (
            <Marker
              position={[wallFirstCorner.lat, wallFirstCorner.lng]}
              icon={L.divIcon({
                className: '',
                html: '<div style="width:12px;height:12px;background:#ef4444;border:2px solid white;border-radius:2px"></div>',
                iconSize: [12, 12],
                iconAnchor: [6, 6],
              })}
            />
          )}
          {/* Virtual walls rendered as rectangles */}
          {walls.filter(w => w.enabled).map(w => {
            const bounds: [number, number][] = [
              [w.lat1, w.lng1],
              [w.lat1, w.lng2],
              [w.lat2, w.lng2],
              [w.lat2, w.lng1],
            ];
            return (
              <Polygon
                key={w.wall_id}
                positions={bounds}
                pathOptions={{
                  color: '#ef4444',
                  fillColor: '#ef4444',
                  fillOpacity: 0.25,
                  weight: 2,
                  dashArray: '6, 3',
                }}
                eventHandlers={{
                  click: (editMode === 'none' && !onMapClickForPattern) ? (e) => {
                    L.DomEvent.stopPropagation(e);
                  } : undefined,
                }}
              >
                <Popup>
                  <div className="text-xs">
                    <div className="font-semibold text-red-600">{w.wall_name || 'No-go zone'}</div>
                    <button
                      onClick={() => handleDeleteWall(w.wall_id)}
                      className="mt-1 text-red-500 hover:text-red-400 underline"
                    >
                      Delete
                    </button>
                  </div>
                </Popup>
              </Polygon>
            );
          })}
          <FitToMaps
            maps={(() => {
              // Open zoomed in on the FIRST work map (map 1 / the dock map) instead
              // of fitting every zone + obstacle, which zooms too far out.
              const work = polygonMaps.filter(m => getAreaStyle(m.mapType, m.mapId, m.mapName) === AREA_STYLES.work);
              return work.length > 0 ? [work[0]] : polygonMaps;
            })()}
            onFitted={() => { setMapsFitted(true); setUserInteracted(true); }}
          />
          <RecenterMap position={position} hasManualInteraction={userInteracted} waitForFit={polygonMaps.length > 0 && !mapsFitted} />
          <UserInteractionTracker onInteract={() => setUserInteracted(true)} />
          {editMode === 'none' && !brushMode && !paintMode && !moveMode && <MapClickDeselect onDeselect={() => setSelectedMapId(null)} />}
          <ResizeHandler />
        </MapContainer>

        {/* ── Floating tool-bar — grouped map tools as a horizontal pill at the
            top of the map (replaces the old cramped top toolbar). Centered so it
            clears the Leaflet zoom control (left) and the camera tile (right).
            Hidden while calibrating (that panel owns top-left). */}
        {!calibrating && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[900] flex flex-row flex-wrap justify-center items-center gap-1 max-w-[calc(100%-1.5rem)] bg-gray-900/85 backdrop-blur border border-gray-700 rounded-2xl p-1.5 shadow-xl">
            {/* Mower controls (start/pause/stop/…) supplied by the shell. */}
            {controlsSlot && (
              <>
                <div className="flex flex-row items-center">{controlsSlot}</div>
                <div className="w-px self-stretch bg-gray-700/50 my-0.5" />
              </>
            )}
            {/* WEERGAVE — tiles + display toggles */}
            <div className="relative">
              <button
                onClick={() => setRailFlyout(f => (f === 'view' ? null : 'view'))}
                className={railCat(railFlyout === 'view')}
                title={t('map.toolView', 'Weergave')}
              >
                <Eye className="w-4 h-4" />
                <span className="hidden sm:inline">{t('map.toolView', 'Weergave')}</span>
                <ChevronDown className={`w-3 h-3 text-gray-400 transition-transform ${railFlyout === 'view' ? 'rotate-180' : ''}`} />
                {(showTrail || showHeatmap || showCamera) && railDot}
              </button>
              {railFlyout === 'view' && (
                <div className={railPanel}>
                  {/* Satellite layer — compact row that opens a side submenu */}
                  <div className="relative">
                    <button onClick={() => setRailTileSub(v => !v)} className={railRow(false)} title={TILE_LAYERS[tileLayer].label}>
                      <Layers className="w-4 h-4 opacity-70 shrink-0" />
                      <span className="flex-1 text-left truncate">{cleanTileLabel(TILE_LAYERS[tileLayer].label)}</span>
                      <ChevronRight className={`w-3.5 h-3.5 text-gray-500 transition-transform ${railTileSub ? 'rotate-90' : ''}`} />
                    </button>
                    {railTileSub && (
                      <div className="absolute left-full top-0 ml-2 z-[960] bg-gray-900/95 backdrop-blur border border-gray-700 rounded-xl p-1 shadow-xl min-w-[200px]">
                        <div className={railHdr}>{t('map.switchToSatellite')}</div>
                        {(Object.keys(TILE_LAYERS) as TileLayerKey[])
                          .filter((key) => key === tileLayer || tileLayerInBounds(
                            TILE_LAYERS[key],
                            chargerGps?.lat ?? (lat ? parseFloat(lat) : null),
                            chargerGps?.lng ?? (lng ? parseFloat(lng) : null),
                          ))
                          .map((key) => (
                            <button key={key} onClick={() => { changeTileLayer(key); setRailTileSub(false); }} className={railRow(key === tileLayer)} title={TILE_LAYERS[key].label}>
                              <Layers className="w-4 h-4 opacity-70" />{cleanTileLabel(TILE_LAYERS[key].label)}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                  {(trail.length > 0 || (cameraAvailable && sn)) && (
                    <div className={railHdr}>{t('map.toolShow', 'Tonen')}</div>
                  )}
                  {trail.length > 0 && (
                    <button onClick={() => setShowTrail(!showTrail)} className={railRow(showTrail)}>
                      <Route className="w-4 h-4 opacity-70" />{showTrail ? t('map.hideTrail') : t('map.showTrail')}
                    </button>
                  )}
                  {trail.length > 10 && (
                    <button onClick={() => setShowHeatmap(!showHeatmap)} className={railRow(showHeatmap)}>
                      <Flame className="w-4 h-4 opacity-70" />{showHeatmap ? t('map.hideHeatmap') : t('map.showHeatmap')}
                    </button>
                  )}
                  {trail.length > 0 && (
                    <button onClick={() => handleClearTrail()} className={railRow(false)}>
                      <Trash2 className="w-4 h-4 opacity-70" />{t('map.clearTrail', 'Trail wissen')}
                    </button>
                  )}
                  {cameraAvailable && sn && (
                    <button onClick={() => setShowCamera(v => !v)} className={railRow(showCamera)}>
                      <Camera className="w-4 h-4 opacity-70" />{t('camera.camera')}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* BEWERKEN — draw / navigate / no-go / calibrate */}
            {editMode === 'none' && (
              <>
                <div className="w-px self-stretch bg-gray-700/50 my-0.5" />
                <div className="relative">
                  <button
                    onClick={() => setRailFlyout(f => (f === 'edit' ? null : 'edit'))}
                    className={railCat(railFlyout === 'edit')}
                    title={t('map.toolEdit', 'Bewerken')}
                  >
                    <Pencil className="w-4 h-4" />
                    <span className="hidden sm:inline">{t('map.toolEdit', 'Bewerken')}</span>
                    <ChevronDown className={`w-3 h-3 text-gray-400 transition-transform ${railFlyout === 'edit' ? 'rotate-180' : ''}`} />
                    {(navigateMode || wallDrawMode) && railDot}
                  </button>
                  {railFlyout === 'edit' && (
                    <div className={railPanel}>
                      <button onClick={() => { startDrawMap(); setRailFlyout(null); }} className={railRow(false)}>
                        <Pencil className="w-4 h-4 opacity-70" />{t('map.drawNew')}
                      </button>
                      {sn && (
                        <button
                          onClick={() => {
                            if (navigateMode) { setNavigateMode(false); setWallDrawMode(false); }
                            else { setNavigateMode(true); setWallDrawMode(false); setPlacingCharger(false); }
                            setRailFlyout(null);
                          }}
                          className={railRow(navigateMode)}
                        >
                          <Target className="w-4 h-4 opacity-70" />{t('controls.navigateTo')}
                        </button>
                      )}
                      {navigateTarget && (
                        <button onClick={() => { handleStopNavigation(); setRailFlyout(null); }} className={railRow(false)}>
                          <XCircle className="w-4 h-4 opacity-70 text-red-400" />{t('controls.stopNavigation')}
                        </button>
                      )}
                      {sn && (
                        <button
                          onClick={() => {
                            if (wallDrawMode) { setWallDrawMode(false); setWallFirstCorner(null); }
                            else { setWallDrawMode(true); setNavigateMode(false); setPlacingCharger(false); setWallFirstCorner(null); }
                            setRailFlyout(null);
                          }}
                          className={railRow(wallDrawMode)}
                        >
                          <Fence className="w-4 h-4 opacity-70" />{t('map.noGoZone', 'No-go zone')}
                        </button>
                      )}
                      {polygonMaps.length > 0 && (
                        <button onClick={() => { startCalibrating(); setRailFlyout(null); }} className={railRow(false)}>
                          <SlidersHorizontal className="w-4 h-4 opacity-70" />{t('map.shiftMenu')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* COVERAGE — show path / width / refresh */}
            {polygonMaps.length > 0 && editMode === 'none' && sn && (
              <>
                <div className="w-px self-stretch bg-gray-700/50 my-0.5" />
                <div className="relative">
                  <button
                    onClick={() => setRailFlyout(f => (f === 'coverage' ? null : 'coverage'))}
                    className={railCat(railFlyout === 'coverage')}
                    title={t('map.toolCoverage', 'Coverage')}
                  >
                    {coverageLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Spline className="w-4 h-4" />}
                    <span className="hidden sm:inline">{t('map.toolCoverage', 'Coverage')}</span>
                    <ChevronDown className={`w-3 h-3 text-gray-400 transition-transform ${railFlyout === 'coverage' ? 'rotate-180' : ''}`} />
                    {showCoverage && (
                      <span className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-gray-900 ${coverageLive ? 'animate-pulse' : ''}`} />
                    )}
                  </button>
                  {railFlyout === 'coverage' && (
                    <div className={railPanel}>
                      <button onClick={() => toggleCoverage()} disabled={coverageLoading} className={railRow(showCoverage)}>
                        <Spline className="w-4 h-4 opacity-70" />{showCoverage ? t('map.edit.coverageHide', 'Maaipad verbergen') : t('map.edit.coverageShow')}
                      </button>
                      {showCoverage && (
                        <button
                          onClick={() => {
                            if (liveSession) { void refreshCoverage(); return; }
                            const lp = lastPreviewParamsRef.current;
                            if (lp) void previewMaps(lp.canonicals, lp.covDirection, lp.polygonArea);
                            else void refreshCoverage();
                          }}
                          disabled={coverageLoading}
                          className={railRow(false)}
                        >
                          <RefreshCw className={`w-4 h-4 opacity-70 ${coverageLoading ? 'animate-spin' : ''}`} />{t('map.edit.coverageRefresh')}
                        </button>
                      )}
                      <div className={railHdr}>{t('map.edit.coverageRadiusTitle')}</div>
                      <div className="flex items-center gap-1.5 px-2.5 pb-1.5">
                        <Crosshair className="w-4 h-4 text-gray-400 shrink-0" />
                        <input
                          type="number"
                          min={MIN_COVERAGE_RADIUS}
                          max={MAX_COVERAGE_RADIUS}
                          step="0.01"
                          value={coverageRadiusDraft}
                          onChange={(e) => setCoverageRadiusDraft(e.target.value)}
                          className="w-16 bg-gray-800 rounded px-2 py-1 text-right text-xs text-gray-100 outline-none"
                        />
                        <span className="text-[10px] text-gray-500">m</span>
                        <button
                          onClick={saveCoverageRadius}
                          disabled={coverageRadiusSaving}
                          className={`ml-auto rounded p-1.5 text-gray-300 hover:text-emerald-300 hover:bg-gray-700/60 ${coverageRadiusSaving ? 'cursor-wait opacity-60' : ''}`}
                          title={t('map.edit.coverageRadiusSave')}
                        >
                          {coverageRadiusSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* DOCK — place / calibrate charger */}
            {editMode === 'none' && (
              <>
                <div className="w-px self-stretch bg-gray-700/50 my-0.5" />
                <div className="relative">
                  <button
                    onClick={() => setRailFlyout(f => (f === 'dock' ? null : 'dock'))}
                    className={`${railCat(railFlyout === 'dock')} ${!chargerHasGps ? 'text-amber-300' : ''}`}
                    title={t('map.toolDock', 'Dock')}
                  >
                    <MapPin className="w-4 h-4" />
                    <span className="hidden sm:inline">{t('map.toolDock', 'Dock')}</span>
                    <ChevronDown className={`w-3 h-3 text-gray-400 transition-transform ${railFlyout === 'dock' ? 'rotate-180' : ''}`} />
                    {placingCharger && railDot}
                  </button>
                  {railFlyout === 'dock' && (
                    <div className={railPanel}>
                      <button onClick={() => { setPlacingCharger(!placingCharger); setRailFlyout(null); }} className={railRow(placingCharger)}>
                        <MapPin className="w-4 h-4 opacity-70" />{!chargerHasGps ? t('map.chargerNotSet') : t('map.placeChargerTooltip')}
                      </button>
                      {chargerHasGps && sn && (
                        <button onClick={() => { setConfirmCalibrate(true); setRailFlyout(null); }} className={railRow(false)}>
                          <Navigation className="w-4 h-4 opacity-70" />{t('map.calibrateCharger')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        {/* Close any open tool-bar flyout when clicking elsewhere on the map. */}
        {railFlyout && !calibrating && (
          <div className="absolute inset-0 z-[890]" onClick={() => setRailFlyout(null)} />
        )}

        {/* Mowing stats — floating card op de kaart tijdens maaien (compact). */}
        {mowingActive && (
          <div className="absolute bottom-3 left-3 z-[1000] w-[calc(100vw-1.5rem)] sm:w-72 pointer-events-none">
            <MowingStatsCard sensors={mowingSensors} compact totalAreaM2={totalWorkAreaM2} />
          </div>
        )}

        {/* Coverage legend — explains the path colors. During a live session it
            shows the progress bar + the yellow/green/white legend; for a static
            idle preview it just labels the planned path. Bottom-right (clear of
            the stats card on the left and the camera top-right). */}
        {showCoverage && !calibrating && (() => {
          const rawPct = parseFloat(mowingSensors.mowing_progress ?? '');
          const pct = Number.isFinite(rawPct) ? Math.max(0, Math.min(100, rawPct)) : null;
          const showProgress = coverageLive && !progressIsStale && pct !== null;
          return (
            <div className="absolute bottom-3 right-3 z-[900] w-44 bg-gray-900/85 backdrop-blur border border-gray-700 rounded-2xl p-3 shadow-xl pointer-events-none">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400">
                  {t('map.edit.coverageTitle', 'Coverage')}
                </span>
                {coverageLive && (
                  <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-cyan-300">
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" style={{ boxShadow: '0 0 0 3px rgba(34,211,238,.22)' }} />
                    LIVE
                  </span>
                )}
              </div>
              {showProgress && (
                <div className="h-1.5 rounded-full bg-gray-700/60 overflow-hidden mb-2.5">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'linear-gradient(90deg,#34d399,#a3e635)' }} />
                </div>
              )}
              <div className="flex flex-col gap-1.5 text-[11px] text-gray-300">
                {coverageLive ? (
                  <>
                    <span className="flex items-center gap-2"><span className="w-4 h-[3px] rounded-full" style={{ background: '#fbbf24' }} />{t('map.edit.legendActive', 'Huidige baan')}</span>
                    <span className="flex items-center gap-2"><span className="w-4 h-[3px] rounded-full" style={{ background: 'rgba(34,197,94,0.9)' }} />{t('map.edit.legendDone', 'Gemaaid')}</span>
                    <span className="flex items-center gap-2"><span className="w-4 h-[3px] rounded-full" style={{ background: 'rgba(255,255,255,0.45)' }} />{t('map.edit.legendPlanned', 'Gepland')}</span>
                  </>
                ) : (
                  <span className="flex items-center gap-2"><span className="w-4 h-[3px] rounded-full" style={{ background: 'rgba(56,189,248,0.9)' }} />{t('map.edit.legendPreview', 'Maaipad (preview)')}</span>
                )}
              </div>
            </div>
          );
        })()}

        {/* Live camera tile — floating top-right, OpenNova custom firmware only. */}
        {showCamera && cameraAvailable && sn && (
          <div className="absolute top-3 right-3 z-[1000] max-w-[calc(100vw-1.5rem)]">
            <CameraTile sn={sn} onClose={() => setShowCamera(false)} />
          </div>
        )}

        {/* Calibration panel — floating on map */}
        {calibrating && (
          <div className="absolute top-3 left-3 z-[1000] bg-gray-900/95 backdrop-blur border border-gray-700 rounded-lg p-3 w-[calc(100vw-1.5rem)] sm:w-64 shadow-xl">
            <div className="flex items-start justify-between mb-3">
              <div>
                <span className="text-xs font-semibold text-amber-400 uppercase tracking-wide">{t('map.shiftTitle')}</span>
                <p className="text-[10px] text-gray-400 leading-tight mt-0.5 pr-2">{t('map.shiftSubtext')}</p>
              </div>
              <button onClick={cancelCalibrating} className="text-gray-500 hover:text-gray-300 flex-shrink-0" title={t('common.cancel')}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Nudge controls — verschuiven het maaigebied in fijne meter-stappen */}
            <div className="mb-3">
              <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t('map.position')}</label>
              <div className="flex items-center justify-center gap-1 mt-1">
                {/* Pijltjes uit tijdens het laden van de seed (race-fix): geen klik
                    kan verloren gaan doordat de async seed hem overschrijft. */}
                <div className="grid grid-cols-3 gap-0.5 w-fit">
                  <div />
                  <button disabled={seedLoading} onClick={() => nudge(0, NUDGE_STEP_M)} className="bg-gray-700 hover:bg-gray-600 rounded p-1.5 flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed" title={t('map.moveNorth')}>
                    <ChevronUp className="w-3.5 h-3.5 text-gray-300" />
                  </button>
                  <div />
                  <button disabled={seedLoading} onClick={() => nudge(-NUDGE_STEP_M, 0)} className="bg-gray-700 hover:bg-gray-600 rounded p-1.5 flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed" title={t('map.moveWest')}>
                    <ChevronLeft className="w-3.5 h-3.5 text-gray-300" />
                  </button>
                  <div className="bg-gray-800 rounded p-1.5 flex items-center justify-center">
                    <span className="text-[9px] text-gray-500 font-mono">5cm</span>
                  </div>
                  <button disabled={seedLoading} onClick={() => nudge(NUDGE_STEP_M, 0)} className="bg-gray-700 hover:bg-gray-600 rounded p-1.5 flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed" title={t('map.moveEast')}>
                    <ChevronRight className="w-3.5 h-3.5 text-gray-300" />
                  </button>
                  <div />
                  <button disabled={seedLoading} onClick={() => nudge(0, -NUDGE_STEP_M)} className="bg-gray-700 hover:bg-gray-600 rounded p-1.5 flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed" title={t('map.moveSouth')}>
                    <ChevronDown className="w-3.5 h-3.5 text-gray-300" />
                  </button>
                  <div />
                </div>
              </div>
              {/* Huidige totale offset in meters, met windrichting (of laad-staat). */}
              <div className="text-[10px] text-gray-400 font-mono text-center mt-1.5">
                {seedLoading ? t('common.loading', 'Laden…') : (() => {
                  const fmt = (v: number, pos: string, neg: string) =>
                    Math.abs(v) < 0.005 ? '0 m' : `${v > 0 ? '+' : '-'}${Math.abs(v).toFixed(2)} m ${v > 0 ? pos : neg}`;
                  return `dx: ${fmt(shiftOffsetM.dxM, t('map.dirEast'), t('map.dirWest'))}, dy: ${fmt(shiftOffsetM.dyM, t('map.dirNorth'), t('map.dirSouth'))}`;
                })()}
              </div>
            </div>

            {/* Rotation */}
            <div className="mb-3">
              <div className="flex items-center justify-between">
                <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t('map.rotation')}</label>
                <span className="text-[10px] text-gray-400 font-mono">{editCal!.rotation.toFixed(1)}&deg;</span>
              </div>
              <input
                type="range"
                min={-180}
                max={180}
                step={0.5}
                value={editCal!.rotation}
                onChange={e => setEditCal(prev => prev ? { ...prev, rotation: parseFloat(e.target.value) } : prev)}
                className="w-full h-1.5 mt-1 accent-amber-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
              />
            </div>

            {/* Scale */}
            <div className="mb-3">
              <div className="flex items-center justify-between">
                <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t('map.scale')}</label>
                <span className="text-[10px] text-gray-400 font-mono">{editCal!.scale.toFixed(3)}x</span>
              </div>
              <input
                type="range"
                min={0.5}
                max={2.0}
                step={0.01}
                value={editCal!.scale}
                onChange={e => setEditCal(prev => prev ? { ...prev, scale: parseFloat(e.target.value) } : prev)}
                className="w-full h-1.5 mt-1 accent-amber-500 bg-gray-700 rounded-full appearance-none cursor-pointer"
              />
            </div>

            {/* Action buttons — Toepassen stuurt de offset naar de maaier,
                Terugzetten zet de maai-offset terug op nul. */}
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-700">
              <button
                onClick={() => setConfirmShiftReset(true)}
                className="flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
                title={t('map.shiftReset')}
              >
                <RotateCcw className="w-3 h-3" />
                {t('map.shiftReset')}
              </button>
              <button
                onClick={handleApplyOffset}
                className="flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-500 transition-colors"
              >
                <Save className="w-3 h-3" />
                {t('map.shiftApply')}
              </button>
            </div>
          </div>
        )}

        {/* Mowing progress overlay — alleen tonen tijdens actief maaien */}
        {mowing && mowing.workStatus === '1' && (() => {
          const progress = parseInt(mowing.mowingProgress ?? '0', 10);
          if (progress <= 0) return null;
          const covering = parseFloat(mowing.coveringArea ?? '0');
          const finished = parseFloat(mowing.finishedArea ?? '0');
          const speed = parseFloat(mowing.mowSpeed ?? '0');
          const direction = mowing.covDirection ? parseFloat(mowing.covDirection) : null;
          return (
            <div className="absolute top-3 right-3 z-[1000] bg-gray-900/95 backdrop-blur border border-gray-700 rounded-lg p-3 shadow-xl w-[calc(100vw-1.5rem)] sm:w-52">
              <div className="flex items-center gap-2 mb-2">
                <Scissors className="w-4 h-4 text-emerald-400" />
                <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wide">{t('map.mowing')}</span>
                {direction !== null && !isNaN(direction) && (
                  <span className="inline-flex items-center gap-0.5 text-gray-400" title={t('map.direction', { deg: direction.toFixed(0) })}>
                    <Navigation className="w-3.5 h-3.5 text-emerald-300 transition-transform duration-300" style={{ transform: `rotate(${direction}deg)` }} />
                    <span className="text-[10px] font-mono">{direction.toFixed(0)}&deg;</span>
                  </span>
                )}
                <span className="ml-auto text-sm font-bold text-white">{progress}%</span>
              </div>
              <div className="h-2 bg-gray-700 rounded-full overflow-hidden mb-2">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                  style={{ width: `${Math.min(progress, 100)}%` }}
                />
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                {covering > 0 && (
                  <>
                    <span className="text-gray-500">{t('map.area')}</span>
                    <span className="text-gray-300 text-right">{covering.toFixed(0)} m&sup2;</span>
                  </>
                )}
                {finished > 0 && (
                  <>
                    <span className="text-gray-500">{t('map.mowed')}</span>
                    <span className="text-gray-300 text-right">{finished.toFixed(0)} m&sup2;</span>
                  </>
                )}
                {speed > 0 && (
                  <>
                    <span className="text-gray-500">{t('map.speed')}</span>
                    <span className="text-gray-300 text-right">{speed.toFixed(1)} m/s</span>
                  </>
                )}
              </div>
            </div>
          );
        })()}

        {/* Mowing complete celebration */}
        {showCelebration && (
          <CelebrationOverlay area={celebrationArea.current} onDismiss={() => setShowCelebration(false)} />
        )}

        {/* Wall drawing hint */}
        {wallDrawMode && (
          <div className="absolute top-3 left-3 z-[1000] bg-gray-900/95 backdrop-blur border border-red-700/50 rounded-lg p-3 shadow-xl w-[calc(100vw-1.5rem)] sm:w-56">
            <div className="flex items-center gap-2 mb-2">
              <Fence className="w-4 h-4 text-red-400" />
              <span className="text-xs font-semibold text-red-400 uppercase tracking-wide">No-go zone</span>
            </div>
            <p className="text-[11px] text-gray-400 mb-2">
              {!wallFirstCorner
                ? 'Click first corner of the no-go rectangle'
                : 'Click opposite corner to complete'}
            </p>
            <button
              onClick={() => { setWallDrawMode(false); setWallFirstCorner(null); }}
              className="w-full text-xs py-1.5 rounded bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors flex items-center justify-center gap-1"
            >
              <X className="w-3 h-3" />
              {t('common.cancel')}
            </button>
          </div>
        )}

        {/* Edit/Draw control panel */}
        {editMode !== 'none' && (
          <div className="absolute top-3 left-3 z-[1000] bg-gray-900/95 backdrop-blur border border-gray-700 rounded-lg p-3 shadow-xl w-[calc(100vw-1.5rem)] sm:w-64">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: editorColor }}>
                {editMode === 'edit' ? t('map.editMap') : t('map.drawNewMap')}
              </span>
              <button onClick={cancelEditPolygon} className="text-gray-500 hover:text-gray-300" title={t('common.cancel')}>
                <X className="w-4 h-4" />
              </button>
            </div>
            {/* Area type selector (only in draw mode) */}
            {editMode === 'draw' && (
              <div className="flex gap-1.5 mb-3">
                {(Object.keys(AREA_TYPE_META) as AreaType[]).map(type => {
                  const meta = AREA_TYPE_META[type];
                  const active = drawType === type;
                  return (
                    <button
                      key={type}
                      onClick={() => setDrawType(type)}
                      className={`flex-1 text-[11px] py-1.5 rounded border transition-colors ${
                        active
                          ? 'border-current font-medium'
                          : 'border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-500'
                      }`}
                      style={active ? { color: meta.color, borderColor: meta.color, backgroundColor: meta.color + '20' } : undefined}
                    >
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            )}
            {/* Name input (draw mode only) */}
            {editMode === 'draw' && (
              <input
                type="text"
                value={drawName}
                onChange={e => setDrawName(e.target.value)}
                placeholder={t('map.mapNamePlaceholder')}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-emerald-600 transition-colors mb-3"
              />
            )}
            <p className="text-[11px] text-gray-400 mb-3">
              {editMode === 'draw'
                ? t('map.drawHelp')
                : t('map.editHelp')}
            </p>
            <div className="flex items-center gap-2 text-[11px] text-gray-500 mb-3">
              <span>{t('map.points', { count: editVertices.length })}</span>
              {editMode === 'draw' && editVertices.length < 3 && (
                <span className="text-amber-400">{t('map.needMore', { count: 3 - editVertices.length })}</span>
              )}
            </div>
            <div className="flex items-center gap-2 pt-2 border-t border-gray-700">
              <button
                onClick={cancelEditPolygon}
                className="flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
              >
                <X className="w-3 h-3" />
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSavePolygon}
                disabled={editVertices.length < 3}
                className="flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded transition-colors text-white disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ backgroundColor: editorColor }}
              >
                <Save className="w-3 h-3" />
                {t('common.save')}
              </button>
            </div>
          </div>
        )}

        {/* Selected map info panel */}
        {selectedMapId && !calibrating && editMode === 'none' && !brushMode && !paintMode && !moveMode && (() => {
          const m = polygonMaps.find(p => p.mapId === selectedMapId);
          if (!m) return null;
          const style = getAreaStyle(m.mapType, m.mapId, m.mapName);
          return (
            <div className="absolute bottom-3 left-3 z-[1000] bg-gray-900/95 backdrop-blur border border-gray-700 rounded-lg p-3 shadow-xl max-w-72">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ backgroundColor: style.color }} />
                {editingName !== null ? (
                  <form
                    className="flex items-center gap-1 flex-1 min-w-0"
                    onSubmit={e => { e.preventDefault(); handleRenameMap(m.mapId, editingName); }}
                  >
                    <input
                      autoFocus
                      value={editingName}
                      onChange={e => setEditingName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Escape') setEditingName(null); }}
                      className="flex-1 min-w-0 text-sm bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5 text-gray-200 focus:outline-none focus:border-blue-500"
                    />
                    <button type="submit" className="text-green-400 hover:text-green-300 flex-shrink-0" title={t('map.saveRename')}>
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button type="button" onClick={() => setEditingName(null)} className="text-gray-500 hover:text-gray-300 flex-shrink-0" title={t('map.cancelRename')}>
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="text-sm font-medium text-gray-200 truncate">
                      {m.mapName || m.mapId}
                    </span>
                    <button
                      onClick={() => setEditingName(m.mapName ?? '')}
                      className="text-gray-500 hover:text-gray-300 flex-shrink-0"
                      title={t('map.rename')}
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                  </>
                )}
                <button
                  onClick={() => { setSelectedMapId(null); setEditingName(null); }}
                  className="ml-auto text-gray-500 hover:text-gray-300 flex-shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-gray-400">
                <span>{t('map.points', { count: m.mapArea.length })}</span>
                {(() => {
                  const area = polygonAreaM2(m.mapArea);
                  return area > 0 ? <span>{area.toFixed(0)} m&sup2;</span> : null;
                })()}
                {m.mapType === 'unicom' && (() => {
                  const len = polylineLengthM(m.mapArea);
                  return len > 0 ? <span>{len.toFixed(1)} m</span> : null;
                })()}
                {m.createdAt && (
                  <span>{new Date(m.createdAt).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                )}
              </div>
              {/* Coverage stats for work areas — only while actively mowing
                  (otherwise it just shows last session's stale trail). */}
              {mowingActive && coverageStats.has(m.mapId) && (() => {
                const stats = coverageStats.get(m.mapId)!;
                // Rough coverage: each trail point covers ~0.25m² (0.5m mow width × 0.5m spacing)
                const coveredM2 = stats.points * 0.25;
                const pct = stats.area > 0 ? Math.min(100, (coveredM2 / stats.area) * 100) : 0;
                return (
                  <div className="mt-1.5">
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="text-gray-500">{t('map.coverage')}</span>
                      <span className="text-emerald-400 font-mono">{pct.toFixed(0)}%</span>
                    </div>
                    <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-500">
                      <span>{t('map.trailPts', { count: stats.points })}</span>
                      <span>{t('map.mowedArea', { area: coveredM2.toFixed(0) })}</span>
                    </div>
                  </div>
                );
              })()}
              <div className="mt-2 pt-2 border-t border-gray-700">
                {/* PRIMARY tool: Paint brush — work + obstacle only */}
                {(m.mapType === 'work' || m.mapType === 'obstacle') && m.canonicalName && (
                  <button
                    onClick={(e) => { e.stopPropagation(); enterPaintMode(); }}
                    className="w-full mb-2 inline-flex items-center justify-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded bg-amber-500 text-gray-900 hover:bg-amber-400 transition-colors shadow"
                    title={t('map.edit.paintHint')}
                  >
                    <Paintbrush className="w-4 h-4" />
                    {t('map.edit.paintTool')}
                  </button>
                )}
                {/* Secondary tools */}
                <div className="flex items-center flex-wrap gap-2">
                  {/* Push/pull brush (R3) — work + obstacle only */}
                  {(m.mapType === 'work' || m.mapType === 'obstacle') && m.canonicalName && (
                    <button
                      onClick={(e) => { e.stopPropagation(); enterBrushMode(); }}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-violet-900/40 text-violet-300 hover:bg-violet-900/70 hover:text-violet-200 transition-colors"
                      title={t('map.edit.brushOn')}
                    >
                      <Brush className="w-3 h-3" />
                      {t('map.edit.brush')}
                    </button>
                  )}
                  {/* Move/translate the whole shape — work + obstacle (with a
                      canonical, since the draft flow keys on it). Primary use is
                      repositioning a pasted obstacle, but allowed for work too. */}
                  {(m.mapType === 'work' || m.mapType === 'obstacle') && m.canonicalName && (
                    <button
                      onClick={(e) => { e.stopPropagation(); enterMoveMode(m.canonicalName!); }}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-cyan-900/40 text-cyan-300 hover:bg-cyan-900/70 hover:text-cyan-200 transition-colors"
                      title={t('map.edit.moveHint')}
                    >
                      <MoveIcon className="w-3 h-3" />
                      {t('map.edit.move')}
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); startEditMap(m.mapId, m.mapArea); }}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-emerald-900/40 text-emerald-400 hover:bg-emerald-900/70 hover:text-emerald-300 transition-colors"
                  >
                    <Pencil className="w-3 h-3" />
                    {t('common.edit')}
                  </button>
                  {/* Obstacle expand / shrink (R3, Part A) */}
                  {m.mapType === 'obstacle' && m.canonicalName && (
                    <>
                      <button
                        onClick={(e) => { e.stopPropagation(); offsetSelectedObstacle(1); }}
                        disabled={applying}
                        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-sky-900/40 text-sky-300 hover:bg-sky-900/70 hover:text-sky-200 transition-colors disabled:opacity-50"
                        title={t('map.edit.expand')}
                      >
                        <Plus className="w-3 h-3" />
                        {t('map.edit.expand')}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); offsetSelectedObstacle(-1); }}
                        disabled={applying}
                        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-sky-900/40 text-sky-300 hover:bg-sky-900/70 hover:text-sky-200 transition-colors disabled:opacity-50"
                        title={t('map.edit.shrink')}
                      >
                        <Minus className="w-3 h-3" />
                        {t('map.edit.shrink')}
                      </button>
                      {/* Copy obstacle to clipboard (R6) — persists for paste onto
                          this or another work map, even after switching mowers. */}
                      <button
                        onClick={(e) => { e.stopPropagation(); copySelectedObstacle(); }}
                        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-indigo-900/40 text-indigo-300 hover:bg-indigo-900/70 hover:text-indigo-200 transition-colors"
                        title={t('map.edit.copy')}
                      >
                        <Copy className="w-3 h-3" />
                        {t('map.edit.copy')}
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => {
                      setConfirmDeleteMapId(m.mapId);
                      setConfirmDeleteMapName(m.mapName || m.mapId);
                    }}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-red-900/40 text-red-400 hover:bg-red-900/70 hover:text-red-300 transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Obstacle paste button (R6) — reachable even with nothing selected,
            since paste targets a WORK map (not the selected obstacle). Disabled
            when there is no work map to attach to. Hidden during edit/draw/brush/
            paint/calibrate to avoid clutter. The clipboard persists across mower
            switches (localStorage), so this stays available after switching. */}
        {obstacleClipboard && !calibrating && editMode === 'none' && !brushMode && !paintMode && !moveMode && (() => {
          const hasWork = maps.some(m => m.mapType === 'work' && m.canonicalName);
          return (
            <div className="absolute bottom-3 right-3 z-[1000] inline-flex items-center gap-1 rounded-xl bg-gray-900/85 backdrop-blur border border-gray-700 p-1 shadow-xl">
              <button
                onClick={(e) => { e.stopPropagation(); pasteObstacle(); }}
                disabled={applying || !hasWork}
                className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title={hasWork ? t('map.edit.paste') : t('map.edit.pasteNoWork')}
              >
                <ClipboardPaste className="w-4 h-4" />
                {t('map.edit.paste')}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setObstacleClipboard(null); }}
                className="grid place-items-center w-7 h-7 rounded-lg text-gray-400 hover:text-red-300 hover:bg-red-900/30 transition-colors"
                title={t('map.edit.pasteDismiss', 'Clear clipboard')}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })()}

        {/* Push/pull brush control panel (R3) */}
        {brushMode && !calibrating && (
          <div className="absolute bottom-3 left-3 z-[1000] bg-gray-900/95 backdrop-blur border border-violet-700/60 rounded-lg p-3 shadow-xl w-64">
            <div className="flex items-center gap-2 mb-2">
              <Brush className="w-4 h-4 text-violet-300" />
              <span className="text-sm font-medium text-violet-200">{t('map.edit.brushOn')}</span>
              <button
                onClick={exitBrushMode}
                className="ml-auto text-gray-500 hover:text-gray-300 flex-shrink-0"
                title={t('common.cancel')}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-gray-400">
              <span className="whitespace-nowrap">{t('map.edit.radius')}</span>
              <input
                type="range"
                min={0.3}
                max={2.0}
                step={0.1}
                value={brushRadius}
                onChange={e => setBrushRadius(parseFloat(e.target.value))}
                className="flex-1 accent-violet-500"
              />
              <span className="font-mono text-violet-300 w-10 text-right">{brushRadius.toFixed(1)}m</span>
            </div>
          </div>
        )}

        {/* Paint/erase brush control panel (primary tool) */}
        {paintMode && !calibrating && (
          <div className="absolute bottom-3 left-3 z-[1000] bg-gray-900/95 backdrop-blur border border-amber-600/60 rounded-lg p-3 shadow-xl w-72">
            <div className="flex items-center gap-2 mb-2">
              <Paintbrush className="w-4 h-4 text-amber-300" />
              <span className="text-sm font-medium text-amber-200">{t('map.edit.paintTool')}</span>
              <button
                onClick={exitPaintMode}
                className="ml-auto text-gray-500 hover:text-gray-300 flex-shrink-0"
                title={t('common.done')}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            {/* Paint / Erase toggle */}
            <div className="grid grid-cols-2 gap-1.5 mb-2">
              <button
                onClick={() => setPaintTool('paint')}
                className={`inline-flex items-center justify-center gap-1.5 text-xs font-medium px-2 py-1.5 rounded transition-colors ${
                  paintTool === 'paint'
                    ? 'bg-emerald-500 text-gray-900'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
              >
                <Paintbrush className="w-3.5 h-3.5" />
                {t('map.edit.paint')}
              </button>
              <button
                onClick={() => setPaintTool('erase')}
                className={`inline-flex items-center justify-center gap-1.5 text-xs font-medium px-2 py-1.5 rounded transition-colors ${
                  paintTool === 'erase'
                    ? 'bg-amber-500 text-gray-900'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
              >
                <Eraser className="w-3.5 h-3.5" />
                {t('map.edit.erase')}
              </button>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-gray-400">
              <span className="whitespace-nowrap">{t('map.edit.paintRadius')}</span>
              <input
                type="range"
                min={0.15}
                max={1.2}
                step={0.05}
                value={paintRadius}
                onChange={e => setPaintRadius(parseFloat(e.target.value))}
                className="flex-1 accent-amber-500"
              />
              <span className="font-mono text-amber-300 w-10 text-right">{paintRadius.toFixed(2)}m</span>
            </div>
            <p className="mt-2 text-[10px] text-gray-500 leading-snug">{t('map.edit.paintHint')}</p>
          </div>
        )}

        {/* Move/translate control panel */}
        {moveMode && !calibrating && (
          <div className="absolute bottom-3 left-3 z-[1000] bg-gray-900/95 backdrop-blur border border-cyan-600/60 rounded-lg p-3 shadow-xl w-64">
            <div className="flex items-center gap-2 mb-1.5">
              <MoveIcon className="w-4 h-4 text-cyan-300" />
              <span className="text-sm font-medium text-cyan-200">{t('map.edit.move')}</span>
              <button
                onClick={exitMoveMode}
                className="ml-auto text-gray-500 hover:text-gray-300 flex-shrink-0"
                title={t('common.done')}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-[11px] text-gray-400 leading-snug">{t('map.edit.moveHint')}</p>
          </div>
        )}

        {/* Geen floating hint-paneel meer — alleen de toolbar-toggle + refresh-icon
            bovenin (met live-stip + spinner) is genoeg. coverageStatus wordt nog
            in de logica gezet maar bewust niet als paneel getoond. */}

        {/* Draft → apply-to-mower bar (R2) */}
        {showEditBar && (
          <MapEditBar
            pendingCount={pendingDraftCount}
            pendingSync={editGeometry!.pendingSync}
            hasVersions={editGeometry!.hasVersions}
            status={editStatus}
            statusKind={editStatusKind}
            busy={applying || historyBusy}
            onApply={handleApplyEdits}
            onRevert={handleRevertEdits}
            onDiscard={handleDiscardEdits}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
          />
        )}
      </div>

      {/* Confirm map delete dialog */}
      <ConfirmDialog
        open={!!confirmDeleteMapId}
        title={t('map.confirmDelete', { name: confirmDeleteMapName })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          if (confirmDeleteMapId) handleDeleteMap(confirmDeleteMapId);
          setConfirmDeleteMapId(null);
        }}
        onCancel={() => setConfirmDeleteMapId(null)}
      />
      <ConfirmDialog
        open={confirmCalibrate}
        title={t('map.calibrateConfirm')}
        confirmLabel={t('map.calibrateCharger')}
        cancelLabel={t('common.cancel')}
        onConfirm={async () => {
          setConfirmCalibrate(false);
          try {
            await calibrateCharger(sn);
            toast(t('map.calibrateStarted'), 'success');
          } catch {
            toast(t('map.calibrateCharger') + ' ✗', 'error');
          }
        }}
        onCancel={() => setConfirmCalibrate(false)}
      />
      <ConfirmDialog
        open={confirmShiftReset}
        title={t('map.shiftResetConfirm')}
        confirmLabel={t('map.shiftReset')}
        cancelLabel={t('common.cancel')}
        onConfirm={async () => {
          setConfirmShiftReset(false);
          await handleResetOffset();
        }}
        onCancel={() => setConfirmShiftReset(false)}
      />

      {/* Charger placement is now a single unified action (menu click OR marker
          drag → handlePlaceCharger), which stores a VISUAL offset only and never
          pushes to the mower. The old relocate-vs-correct dialog (which could
          recalc + push maps to the mower) has been removed. */}
    </div>
  );
}
