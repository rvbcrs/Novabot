import { useEffect, useState, useCallback, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polygon, Polyline, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import {
  MapPin, Map as MapIcon, Trash2, Route, Wifi, WifiOff, Satellite, Crosshair,
  Battery, BatteryCharging, BatteryLow, BatteryFull, Layers,
  SlidersHorizontal, Save, X, RotateCcw, Pencil, Check, Scissors, Navigation,
  ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Download, Flame,
  Fence, Target, XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MapData, TrailPoint, MapCalibration } from '../../types';
import {
  fetchMaps, fetchAllMaps, fetchTrail, clearTrail, fetchCalibration, saveCalibration,
  deleteMap, renameMap, updateMapArea, createMap, exportMaps,
  navigateToPosition, stopNavigation,
  fetchVirtualWalls, createVirtualWall, deleteVirtualWall,
  type VirtualWall,
} from '../../api/client';
import { useToast } from '../common/Toast';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { PolygonEditor } from './PolygonEditor';
import { PatternOverlay, type PatternPlacement } from '../patterns/PatternOverlay';

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
  heading?: string;
  chargerLat?: string;
  chargerLng?: string;
  signals?: SignalInfo;
  mowing?: MowingInfo;
  /** Wanneer ingesteld, toon een richting-overlay lijn op de kaart (graden, 0=N) */
  pathDirectionPreview?: number | null;
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
}

function wifiColor(rssi: number): string {
  if (rssi >= -50) return 'text-green-400';
  if (rssi >= -60) return 'text-yellow-400';
  if (rssi >= -70) return 'text-orange-400';
  return 'text-red-400';
}

function gpsColor(sats: number): string {
  if (sats >= 20) return 'text-green-400';
  if (sats >= 10) return 'text-yellow-400';
  return 'text-red-400';
}

function locColor(quality: number): string {
  if (quality >= 80) return 'text-green-400';
  if (quality >= 50) return 'text-yellow-400';
  return 'text-red-400';
}

function batteryColor(pct: number): string {
  if (pct >= 60) return 'text-green-400';
  if (pct >= 30) return 'text-yellow-400';
  if (pct >= 15) return 'text-orange-400';
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
function FitToMaps({ maps, onFitted }: { maps: MapData[]; onFitted?: () => void }) {
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
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 23 });
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

/** Zoom-aware mowing coverage band — renders trail as wide stripes representing mowed area */
function CoverageTrail({ positions, widthMeters = 0.5 }: { positions: [number, number][]; widthMeters?: number }) {
  const map = useMap();
  const [weight, setWeight] = useState(6);

  useEffect(() => {
    const updateWeight = () => {
      const zoom = map.getZoom();
      const center = map.getCenter();
      // meters per pixel at this zoom level and latitude
      const metersPerPixel = 156543.03 * Math.cos(center.lat * Math.PI / 180) / Math.pow(2, zoom);
      setWeight(Math.max(2, widthMeters / metersPerPixel));
    };
    updateWeight();
    map.on('zoomend', updateWeight);
    return () => { map.off('zoomend', updateWeight); };
  }, [map, widthMeters]);

  if (positions.length < 2) return null;

  return (
    <Polyline
      positions={positions}
      pathOptions={{
        color: '#10b981',
        weight,
        opacity: 0.35,
        lineCap: 'butt',
        lineJoin: 'round',
      }}
    />
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

const TILE_LAYERS = {
  satellite: {
    url: 'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg',
    attribution: '&copy; <a href="https://www.pdok.nl">PDOK</a> Luchtfoto',
    maxNativeZoom: 21,
    maxZoom: 23,
  },
  street: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    maxNativeZoom: 19,
    maxZoom: 23,
  },
} as const;

// ── Calibration transform ────────────────────────────────────────

/** Apply calibration (offset + rotation + scale) to polygon points */
function calibratePoints(
  points: Array<{ lat: number; lng: number }>,
  cal: MapCalibration,
  center: { lat: number; lng: number },
): [number, number][] {
  if (cal.offsetLat === 0 && cal.offsetLng === 0 && cal.rotation === 0 && cal.scale === 1) {
    return points.map(p => [p.lat, p.lng]);
  }

  const rad = (cal.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  return points.map(p => {
    // Translate to center
    let dLat = p.lat - center.lat;
    let dLng = p.lng - center.lng;

    // Scale
    dLat *= cal.scale;
    dLng *= cal.scale;

    // Rotate
    const rLat = dLat * cos - dLng * sin;
    const rLng = dLat * sin + dLng * cos;

    // Translate back + offset
    return [center.lat + rLat + cal.offsetLat, center.lng + rLng + cal.offsetLng] as [number, number];
  });
}

const DEFAULT_CAL: MapCalibration = { offsetLat: 0, offsetLng: 0, rotation: 0, scale: 1 };

type AreaType = 'work' | 'obstacle' | 'unicom';

// ── Mower marker icon ────────────────────────────────────────────

function makeMowerIcon(heading: number) {
  return L.divIcon({
    className: '',
    html: `<div style="width:32px;height:32px;transform:rotate(${heading}deg)">
      <svg viewBox="0 0 32 32" width="32" height="32">
        <circle cx="16" cy="16" r="12" fill="#10b981" stroke="white" stroke-width="2" opacity="0.9"/>
        <polygon points="16,4 22,18 16,14 10,18" fill="white" opacity="0.9"/>
      </svg>
    </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

// ── Charger marker icon ────────────────────────────────────────
function makeChargerIcon(live = false) {
  const ring = live
    ? `<circle cx="16" cy="16" r="15" fill="none" stroke="#22c55e" stroke-width="2" opacity="0.8"/>`
    : '';
  return L.divIcon({
    className: '',
    html: `<div style="width:32px;height:32px">
      <svg viewBox="0 0 32 32" width="32" height="32">
        ${ring}
        <circle cx="16" cy="16" r="12" fill="#f59e0b" stroke="white" stroke-width="2" opacity="0.9"/>
        <polygon points="18,6 12,17 16,17 14,26 20,15 16,15" fill="white" opacity="0.9"/>
      </svg>
    </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
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

// ── Clip a line segment to a polygon (Sutherland-Hodgman style) ──

/** Returns segments of `line` that lie inside `polygon`. */
function clipLineToPolygon(
  line: [[number, number], [number, number]],
  polygon: Array<{ lat: number; lng: number }>,
): [number, number][][] {
  const pts = polygon.map(p => [p.lat, p.lng] as [number, number]);
  const n = pts.length;
  if (n < 3) return [];

  // Collect all intersection t-values of line with polygon edges
  const [aLat, aLng] = line[0];
  const [bLat, bLng] = line[1];
  const dLat = bLat - aLat;
  const dLng = bLng - aLng;

  const tValues: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [eLat, eLng] = pts[i];
    const [fLat, fLng] = pts[j];
    const edLat = fLat - eLat;
    const edLng = fLng - eLng;
    const denom = dLat * edLng - dLng * edLat;
    if (Math.abs(denom) < 1e-15) continue;
    const t = ((eLat - aLat) * edLng - (eLng - aLng) * edLat) / denom;
    const u = ((eLat - aLat) * dLng - (eLng - aLng) * dLat) / denom;
    if (u >= 0 && u <= 1 && t >= 0 && t <= 1) {
      tValues.push(t);
    }
  }

  // Add start/end if inside polygon
  const startInside = pointInPolygon(aLat, aLng, polygon);
  const endInside = pointInPolygon(bLat, bLng, polygon);
  if (startInside) tValues.push(0);
  if (endInside) tValues.push(1);

  tValues.sort((a, b) => a - b);

  // Build segments from consecutive pairs (enter→exit)
  const segments: [number, number][][] = [];
  for (let i = 0; i < tValues.length - 1; i++) {
    const t1 = tValues[i];
    const t2 = tValues[i + 1];
    const midT = (t1 + t2) / 2;
    const midLat = aLat + dLat * midT;
    const midLng = aLng + dLng * midT;
    if (pointInPolygon(midLat, midLng, polygon)) {
      segments.push([
        [aLat + dLat * t1, aLng + dLng * t1],
        [aLat + dLat * t2, aLng + dLng * t2],
      ]);
    }
  }
  return segments;
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
const NUDGE_STEP = 0.000005; // ~0.55m lat, ~0.35m lng at 52°N

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

export function MowerMap({ sn, lat, lng, heading, chargerLat, chargerLng, signals, mowing, pathDirectionPreview, onMapSaved, liveOutline, patternPlacement, onMapClickForPattern, offsetPreview }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [maps, setMaps] = useState<MapData[]>([]);
  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const [showTrail, setShowTrail] = useState(true);
  const [tileLayer, setTileLayer] = useState<'satellite' | 'street'>('satellite');
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);

  // Polygon edit/draw state
  const [editMode, setEditMode] = useState<'none' | 'edit' | 'draw'>('none');
  const [editVertices, setEditVertices] = useState<[number, number][]>([]);
  const [editingMapId, setEditingMapId] = useState<string | null>(null);
  const [drawType, setDrawType] = useState<'work' | 'obstacle' | 'unicom'>('work');
  const [showHeatmap, setShowHeatmap] = useState(false);

  // Place charger mode
  const [placingCharger, setPlacingCharger] = useState(false);

  // Navigate-to mode
  const [navigateMode, setNavigateMode] = useState(false);
  const [navigateTarget, setNavigateTarget] = useState<{ lat: number; lng: number } | null>(null);

  // Confirm delete dialog
  const [confirmDeleteMapId, setConfirmDeleteMapId] = useState<string | null>(null);
  const [confirmDeleteMapName, setConfirmDeleteMapName] = useState<string>('');

  // Virtual walls
  const [walls, setWalls] = useState<VirtualWall[]>([]);
  const [wallDrawMode, setWallDrawMode] = useState(false);
  const [wallFirstCorner, setWallFirstCorner] = useState<{ lat: number; lng: number } | null>(null);

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
      fetchMaps(sn).then(setMaps).catch(() => setMaps([]));
      fetchTrail(sn).then(setTrail).catch(() => setTrail([]));
      fetchCalibration(sn).then(setSavedCal).catch(() => {});
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

  // Mower GPS parsed — used as charger position fallback (mower sits on charger when idle)
  const mowerLat = lat ? parseFloat(lat) : null;
  const mowerLng = lng ? parseFloat(lng) : null;
  const mowerHasGps = !!(mowerLat && mowerLng && mowerLat !== 0 && mowerLng !== 0);

  // Auto-save mower GPS as charger position — de charger zelf rapporteert geen
  // lat/lng via MQTT, maar de maaier WEL. Als de maaier op het laadstation staat
  // (idle, opladen), is zijn GPS positie gelijk aan de charger positie.
  // Sla dit automatisch op zodat de charger marker altijd correct staat.
  const chargerLiveLat = chargerLat ? parseFloat(chargerLat) : null;
  const hasLiveChargerGps = !!(chargerLiveLat && chargerLiveLat !== 0);
  useEffect(() => {
    if (!sn || !mowerHasGps || hasLiveChargerGps) return;
    // Alleen auto-updaten als er nog geen positie is, of als de afstand > 5m
    // (voorkomt continue saves maar corrigeert GPS drift)
    if (savedCal.chargerLat && savedCal.chargerLng) {
      const dLat = Math.abs(mowerLat! - savedCal.chargerLat);
      const dLng = Math.abs(mowerLng! - savedCal.chargerLng);
      if (dLat < 0.00005 && dLng < 0.00005) return; // < ~5m, geen update nodig
    }
    const updated = { ...savedCal, chargerLat: mowerLat!, chargerLng: mowerLng! };
    setSavedCal(updated);
    saveCalibration(sn, updated).catch(() => {});
  }, [sn, mowerHasGps, mowerLat, mowerLng, hasLiveChargerGps]);

  // Append new trail points when lat/lng changes
  useEffect(() => {
    if (!lat || !lng || lat === '0' || lng === '0') return;
    const numLat = parseFloat(lat);
    const numLng = parseFloat(lng);
    if (isNaN(numLat) || isNaN(numLng)) return;

    setTrail(prev => {
      if (prev.length > 0) {
        const last = prev[prev.length - 1];
        if (Math.abs(last.lat - numLat) < 0.0000005 && Math.abs(last.lng - numLng) < 0.0000005) {
          return prev;
        }
      }
      return [...prev, { lat: numLat, lng: numLng, ts: Date.now() }];
    });
  }, [lat, lng]);

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
  const startEditMap = useCallback((mapId: string, mapArea: Array<{ lat: number; lng: number }>) => {
    if (mapArea.length < 3) return;
    setEditingMapId(mapId);
    setEditVertices(mapArea.map(p => [p.lat, p.lng] as [number, number]));
    setEditMode('edit');
    setSelectedMapId(null);
    setEditingName(null);
    setUserInteracted(true);
  }, []);

  // Start drawing a new polygon
  const startDrawMap = useCallback(() => {
    setEditingMapId(null);
    setEditVertices([]);
    setEditMode('draw');
    setSelectedMapId(null);
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

  // Save edited/drawn polygon
  const handleSavePolygon = useCallback(() => {
    if (editVertices.length < 3) return;
    const area = editVertices.map(([lat, lng]) => ({ lat, lng }));

    if (editMode === 'edit' && editingMapId) {
      updateMapArea(sn, editingMapId, area).then(() => {
        const updated = maps.find(m => m.mapId === editingMapId);
        setMaps(prev => prev.map(m => m.mapId === editingMapId ? { ...m, mapArea: area } : m));
        setEditMode('none');
        setEditVertices([]);
        setEditingMapId(null);
        if (updated) onMapSaved?.({ ...updated, mapArea: area });
      }).catch(() => {});
    } else if (editMode === 'draw') {
      const typeMeta = AREA_TYPE_META[drawType];
      const count = maps.filter(m => {
        const s = getAreaStyle(m.mapType, m.mapId, m.mapName);
        return s.color === typeMeta.color;
      }).length;
      const name = `${typeMeta.label} ${count + 1}`;
      createMap(sn, name, area, drawType).then(newMap => {
        setMaps(prev => [...prev, newMap]);
        setEditMode('none');
        setEditVertices([]);
        setSelectedMapId(newMap.mapId);
        onMapSaved?.(newMap);
      }).catch(() => {});
    }
  }, [editVertices, editMode, editingMapId, sn, maps, drawType, AREA_TYPE_META, onMapSaved]);

  // Cancel edit/draw
  const cancelEditPolygon = useCallback(() => {
    setEditMode('none');
    setEditVertices([]);
    setEditingMapId(null);
  }, []);

  // Add point in draw mode
  const handleDrawPoint = useCallback((latlng: [number, number]) => {
    setEditVertices(prev => [...prev, latlng]);
  }, []);

  const hasGps = lat && lng && lat !== '0' && lng !== '0';
  const position: [number, number] = hasGps
    ? [parseFloat(lat), parseFloat(lng)]
    : DEFAULT_CENTER;

  const [userInteracted, setUserInteracted] = useState(false);
  const [mapsFitted, setMapsFitted] = useState(false);

  const polygonMaps = maps.filter(m => m.mapArea.length >= 3);
  const trailPositions: [number, number][] = trail.map(p => [p.lat, p.lng]);

  // Mower heading icon (rotates with heading data)
  const headingDeg = heading ? parseFloat(heading) : 0;
  const mowerIcon = useMemo(() => makeMowerIcon(isNaN(headingDeg) ? 0 : headingDeg), [headingDeg]);
  const chargerGpsIsLive = !!(chargerLat && parseFloat(chargerLat) !== 0 && chargerLng && parseFloat(chargerLng) !== 0);
  const chargerIcon = useMemo(() => makeChargerIcon(chargerGpsIsLive), [chargerGpsIsLive]);

  // Coverage stats per polygon (trail points inside each work area)
  const coverageStats = useMemo(() => {
    if (trail.length === 0) return new Map<string, { points: number; area: number }>();
    const stats = new Map<string, { points: number; area: number }>();
    for (const m of polygonMaps) {
      const style = getAreaStyle(m.mapType, m.mapId, m.mapName);
      if (style !== AREA_STYLES.work) continue;
      const area = polygonAreaM2(m.mapArea);
      let count = 0;
      for (const tp of trail) {
        if (pointInPolygon(tp.lat, tp.lng, m.mapArea)) count++;
      }
      stats.set(m.mapId, { points: count, area });
    }
    return stats;
  }, [trail, polygonMaps]);

  // Charger GPS: prefer live charger sensor, then calibration, then mower GPS as fallback
  const resolvedChargerLat = (chargerLat && parseFloat(chargerLat)) || savedCal.chargerLat || (mowerHasGps ? mowerLat : null);
  const resolvedChargerLng = (chargerLng && parseFloat(chargerLng)) || savedCal.chargerLng || (mowerHasGps ? mowerLng : null);
  const chargerHasGps = !!(resolvedChargerLat && resolvedChargerLng);

  // Place charger on map click
  const handlePlaceCharger = useCallback((lat: number, lng: number) => {
    const updated = { ...savedCal, chargerLat: lat, chargerLng: lng };
    setSavedCal(updated);
    setPlacingCharger(false);
    saveCalibration(sn, updated).then(() => {
      toast(t('map.chargerSaved'), 'success');
    });
  }, [sn, savedCal, t]);

  // Export handler
  const handleExport = useCallback(() => {
    if (!chargerHasGps) return;
    exportMaps(sn, { lat: resolvedChargerLat!, lng: resolvedChargerLng! }).then(url => {
      window.open(url, '_blank');
      toast(t('map.exported'), 'success');
    }).catch(() => toast(t('map.exportFailed'), 'error'));
  }, [sn, resolvedChargerLat, resolvedChargerLng, chargerHasGps, t]);

  // Push maps to mower via SSH
  // Navigate-to handler
  const handleNavigateClick = useCallback((lat: number, lng: number) => {
    setNavigateTarget({ lat, lng });
    setNavigateMode(false);
    navigateToPosition(sn, lat, lng).then(() => {
      toast(`✓ ${t('controls.navigateTo')}`, 'success');
    }).catch(() => toast(`✗ ${t('controls.navigateTo')}`, 'error'));
    // Auto-clear target after 60s
    setTimeout(() => setNavigateTarget(null), 60_000);
  }, [sn, t, toast]);

  const handleStopNavigation = useCallback(() => {
    setNavigateTarget(null);
    stopNavigation(sn).then(() => {
      toast(`✓ ${t('controls.stopNavigation')}`, 'success');
    }).catch(() => {});
  }, [sn, t, toast]);

  // Virtual wall drawing
  const handleWallPoint = useCallback((lat: number, lng: number) => {
    if (!wallFirstCorner) {
      setWallFirstCorner({ lat, lng });
    } else {
      // Second corner → save wall
      createVirtualWall(sn, {
        lat1: wallFirstCorner.lat,
        lng1: wallFirstCorner.lng,
        lat2: lat,
        lng2: lng,
      }).then(() => {
        // Refresh walls
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

  // Center of all polygon points (used as rotation/scale pivot)
  const polyCenter = useMemo(() => {
    let totalLat = 0, totalLng = 0, count = 0;
    for (const m of polygonMaps) {
      for (const p of m.mapArea) {
        totalLat += p.lat;
        totalLng += p.lng;
        count++;
      }
    }
    if (count === 0) return { lat: position[0], lng: position[1] };
    return { lat: totalLat / count, lng: totalLng / count };
  }, [polygonMaps, position]);

  // Calibration handlers
  const startCalibrating = useCallback(() => {
    setEditCal({ ...savedCal });
    setUserInteracted(true); // prevent auto-recenter during calibration
  }, [savedCal]);

  const cancelCalibrating = useCallback(() => {
    setEditCal(null);
  }, []);

  const resetCalibrating = useCallback(() => {
    setEditCal(DEFAULT_CAL);
  }, []);

  const handleSaveCalibration = useCallback(() => {
    if (!editCal) return;
    saveCalibration(sn, editCal).then(() => {
      setSavedCal(editCal);
      setEditCal(null);
    }).catch(() => {});
  }, [sn, editCal]);

  const nudge = useCallback((dLat: number, dLng: number) => {
    setEditCal(prev => prev ? { ...prev, offsetLat: prev.offsetLat + dLat, offsetLng: prev.offsetLng + dLng } : prev);
  }, []);

  return (
    <div className="bg-gray-800 rounded-none md:rounded-xl border-0 md:border md:border-gray-700 overflow-hidden flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between px-1.5 md:px-4 py-1.5 md:py-2 border-b border-gray-700 flex-shrink-0 overflow-x-auto gap-1 md:gap-2">
        <div className="flex items-center gap-1.5 md:gap-3">
          <MapPin className="w-4 h-4 text-blue-400 hidden md:block" />
          {/* Signal icon bar */}
          {signals && (() => {
            const rssi = signals.wifiRssi ? parseInt(signals.wifiRssi, 10) : null;
            const sats = signals.rtkSat ? parseInt(signals.rtkSat, 10) : null;
            const loc = signals.locQuality ? parseInt(signals.locQuality, 10) : null;
            const bat = signals.batteryPower ? parseInt(signals.batteryPower, 10) : null;
            const charging = signals.batteryState?.toUpperCase() === 'CHARGING';
            const BatIcon = charging ? BatteryCharging : bat !== null && bat <= 15 ? BatteryLow : bat !== null && bat >= 80 ? BatteryFull : Battery;
            return (
              <div className="flex items-center gap-1 md:gap-2">
                <span className={`inline-flex items-center gap-0.5 ${bat !== null ? batteryColor(bat) : 'text-gray-600'}`} title={bat !== null ? (charging ? t('devices.batteryCharging', { pct: bat }) : t('devices.batteryLabel', { pct: bat })) : t('devices.batteryNoData')}>
                  <BatIcon className="w-3.5 h-3.5" />
                  {bat !== null && <span className="hidden md:inline text-[10px] font-mono">{bat}%</span>}
                </span>
                <span className={`inline-flex items-center gap-0.5 ${rssi !== null ? wifiColor(rssi) : 'text-gray-600'}`} title={rssi !== null ? t('devices.wifiLabel', { rssi }) : t('devices.wifiNoData')}>
                  {rssi !== null ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                  {rssi !== null && <span className="hidden md:inline text-[10px] font-mono">{rssi}</span>}
                </span>
                <span className={`inline-flex items-center gap-0.5 ${sats !== null ? gpsColor(sats) : 'text-gray-600'}`} title={sats !== null ? t('devices.rtkLabel', { sats }) : t('devices.rtkNoData')}>
                  <Satellite className="w-3.5 h-3.5" />
                  {sats !== null && <span className="hidden md:inline text-[10px] font-mono">{sats}</span>}
                </span>
                <span className={`hidden md:inline-flex items-center gap-0.5 ${loc !== null ? locColor(loc) : 'text-gray-600'}`} title={loc !== null ? t('devices.locLabel', { loc }) : t('devices.locNoData')}>
                  <Crosshair className="w-3.5 h-3.5" />
                  {loc !== null && <span className="text-[10px] font-mono">{loc}%</span>}
                </span>
              </div>
            );
          })()}
        </div>
        <div className="flex items-center gap-1 md:gap-3">
          {trail.length > 0 && (
            <button
              onClick={() => setShowTrail(!showTrail)}
              className={`inline-flex items-center gap-1 text-xs px-1.5 md:px-2 py-0.5 rounded transition-colors ${
                showTrail ? 'bg-cyan-900/50 text-cyan-400' : 'bg-gray-700/50 text-gray-500'
              }`}
              title={showTrail ? t('map.hideTrail') : t('map.showTrail')}
            >
              <Route className="w-3 h-3" />
              <span className="hidden md:inline">{trail.length} pts</span>
            </button>
          )}
          {trail.length > 0 && (
            <button
              onClick={handleClearTrail}
              className="hidden md:inline-flex text-gray-500 hover:text-red-400 transition-colors"
              title="Clear GPS trail"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          {/* Draw new polygon */}
          {editMode === 'none' && !calibrating && (
            <button
              onClick={startDrawMap}
              className="inline-flex items-center gap-1 text-xs px-1.5 md:px-2 py-0.5 rounded transition-colors bg-gray-700/50 text-gray-400 hover:text-emerald-400 hover:bg-emerald-900/30"
              title={t('map.drawNew')}
            >
              <Pencil className="w-3 h-3" />
              <span className="hidden md:inline">{t('map.draw')}</span>
            </button>
          )}
          {/* Navigate-to toggle */}
          {editMode === 'none' && !calibrating && sn && (
            navigateMode ? (
              <button
                onClick={() => { setNavigateMode(false); setWallDrawMode(false); }}
                className="inline-flex items-center gap-1 text-xs px-1.5 md:px-2 py-0.5 rounded transition-colors bg-blue-600 text-white animate-pulse"
                title={t('controls.navigateTo')}
              >
                <Target className="w-3 h-3" />
                <span className="hidden md:inline">{t('controls.navigateTo')}</span>
              </button>
            ) : (
              <button
                onClick={() => { setNavigateMode(true); setWallDrawMode(false); setPlacingCharger(false); }}
                className="inline-flex items-center gap-1 text-xs px-1.5 md:px-2 py-0.5 rounded transition-colors bg-gray-700/50 text-gray-400 hover:text-blue-400 hover:bg-blue-900/30"
                title={t('controls.navigateTo')}
              >
                <Target className="w-3 h-3" />
              </button>
            )
          )}
          {/* Navigate target cancel */}
          {navigateTarget && (
            <button
              onClick={handleStopNavigation}
              className="inline-flex items-center gap-1 text-xs px-1.5 md:px-2 py-0.5 rounded transition-colors bg-red-900/50 text-red-400 hover:bg-red-800/50"
              title={t('controls.stopNavigation')}
            >
              <XCircle className="w-3 h-3" />
            </button>
          )}
          {/* Virtual wall draw toggle */}
          {editMode === 'none' && !calibrating && sn && (
            wallDrawMode ? (
              <button
                onClick={() => { setWallDrawMode(false); setWallFirstCorner(null); }}
                className="inline-flex items-center gap-1 text-xs px-1.5 md:px-2 py-0.5 rounded transition-colors bg-red-600 text-white animate-pulse"
                title="No-go zone"
              >
                <Fence className="w-3 h-3" />
                <span className="hidden md:inline">No-go</span>
              </button>
            ) : (
              <button
                onClick={() => { setWallDrawMode(true); setNavigateMode(false); setPlacingCharger(false); setWallFirstCorner(null); }}
                className="inline-flex items-center gap-1 text-xs px-1.5 md:px-2 py-0.5 rounded transition-colors bg-gray-700/50 text-gray-400 hover:text-red-400 hover:bg-red-900/30"
                title="No-go zone"
              >
                <Fence className="w-3 h-3" />
              </button>
            )
          )}
          {/* Calibrate toggle */}
          {polygonMaps.length > 0 && !calibrating && editMode === 'none' && (
            <button
              onClick={startCalibrating}
              className="inline-flex items-center gap-1 text-xs px-1.5 md:px-2 py-0.5 rounded transition-colors bg-gray-700/50 text-gray-400 hover:text-amber-400 hover:bg-amber-900/30"
              title={t('map.calibrateOverlay')}
            >
              <SlidersHorizontal className="w-3 h-3" />
              <span className="hidden md:inline">{t('map.calibrate')}</span>
            </button>
          )}
          {/* Heatmap toggle */}
          {trail.length > 10 && (
            <button
              onClick={() => setShowHeatmap(!showHeatmap)}
              className={`inline-flex items-center gap-1 text-xs px-1.5 md:px-2 py-0.5 rounded transition-colors ${
                showHeatmap ? 'bg-orange-900/50 text-orange-400' : 'bg-gray-700/50 text-gray-500'
              }`}
              title={showHeatmap ? t('map.hideHeatmap') : t('map.showHeatmap')}
            >
              <Flame className="w-3 h-3" />
              <span className="hidden md:inline">{t('map.heat')}</span>
            </button>
          )}
          {/* Export button (hidden on mobile) */}
          {polygonMaps.length > 0 && editMode === 'none' && !calibrating && (
            <button
              onClick={handleExport}
              disabled={!chargerHasGps}
              className={`hidden md:inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded transition-colors ${
                chargerHasGps
                  ? 'bg-gray-700/50 text-gray-400 hover:text-cyan-400 hover:bg-cyan-900/30'
                  : 'bg-gray-700/30 text-gray-600 cursor-not-allowed'
              }`}
              title={chargerHasGps ? t('map.exportTooltip') : t('map.exportNoCharger')}
            >
              <Download className="w-3 h-3" />
              {t('map.export')}
            </button>
          )}
          {/* Place/reposition charger button — highlighted when no charger position set */}
          {editMode === 'none' && !calibrating && (
            <button
              onClick={() => setPlacingCharger(!placingCharger)}
              className={`inline-flex items-center gap-1 text-xs px-1.5 md:px-2 py-0.5 rounded transition-colors ${
                placingCharger
                  ? 'bg-amber-600 text-white animate-pulse'
                  : !chargerHasGps
                    ? 'bg-amber-900/50 text-amber-400 border border-amber-700/50 hover:bg-amber-800/50'
                    : 'bg-gray-700/50 text-gray-400 hover:text-amber-400 hover:bg-amber-900/30'
              }`}
              title={placingCharger ? t('map.placeChargerClick') : !chargerHasGps ? t('map.chargerNotSet') : t('map.placeChargerTooltip')}
            >
              <MapPin className="w-3 h-3" />
              <span className="hidden md:inline">{placingCharger ? t('map.placeChargerActive') : t('map.charger')}</span>
            </button>
          )}
          <button
            onClick={() => setTileLayer(tileLayer === 'satellite' ? 'street' : 'satellite')}
            className={`inline-flex items-center gap-1 text-xs px-1.5 md:px-2 py-0.5 rounded transition-colors ${
              tileLayer === 'satellite' ? 'bg-blue-900/50 text-blue-400' : 'bg-gray-700/50 text-gray-500'
            }`}
            title={tileLayer === 'satellite' ? t('map.switchToStreet') : t('map.switchToSatellite')}
          >
            <Layers className="w-3 h-3" />
            <span className="hidden md:inline">{tileLayer === 'satellite' ? t('map.sat') : t('map.streetMap')}</span>
          </button>
          {polygonMaps.length > 0 && (() => {
            const counts = { work: 0, obstacle: 0, unicom: 0, other: 0 };
            for (const m of polygonMaps) {
              const s = getAreaStyle(m.mapType, m.mapId, m.mapName);
              if (s === AREA_STYLES.work) counts.work++;
              else if (s === AREA_STYLES.obstacle) counts.obstacle++;
              else if (s === AREA_STYLES.unicom) counts.unicom++;
              else counts.other++;
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
          maxZoom={23}
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
          {/* Saved map polygons with calibration applied */}
          {polygonMaps.map(m => {
            const positions = calibratePoints(m.mapArea, activeCal, polyCenter);
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
                  click: editMode === 'none' ? (e) => {
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
          {/* Mowing coverage band (wide green stripes) */}
          {showTrail && trailPositions.length >= 2 && (
            <CoverageTrail positions={trailPositions} />
          )}
          {/* GPS trail centerline */}
          {showTrail && !showHeatmap && trailPositions.length >= 2 && (
            <Polyline
              positions={trailPositions}
              pathOptions={{
                color: '#06b6d4',
                weight: 1.5,
                opacity: 0.5,
                dashArray: '4, 3',
              }}
            />
          )}
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
          {/* Charger marker (draggable to reposition) */}
          {chargerHasGps && (
            <Marker
              position={[resolvedChargerLat!, resolvedChargerLng!]}
              icon={chargerIcon}
              draggable
              eventHandlers={{
                dragend: (e) => {
                  const { lat, lng } = e.target.getLatLng();
                  const updated = { ...savedCal, chargerLat: lat, chargerLng: lng };
                  setSavedCal(updated);
                  saveCalibration(sn, updated).then(() => {
                    toast(t('map.chargerSaved'), 'success');
                  });
                },
              }}
            >
              <Popup>
                <div className="text-xs">
                  <div className="font-semibold">{t('map.chargingStation')}</div>
                  <div>{resolvedChargerLat!.toFixed(6)}, {resolvedChargerLng!.toFixed(6)}</div>
                  <div className={`mt-1 font-medium ${chargerGpsIsLive ? 'text-green-600' : 'text-gray-500'}`}>
                    {chargerGpsIsLive ? t('map.chargerGpsLive', 'Live GPS') : t('map.chargerGpsManual', 'Handmatig geplaatst')}
                  </div>
                  {!chargerGpsIsLive && <div className="text-gray-400 mt-0.5">{t('map.dragToReposition')}</div>}
                </div>
              </Popup>
            </Marker>
          )}
          {/* Path direction preview: hatching lines clipped to work polygons */}
          {pathDirectionPreview != null && polyCenter.lat !== 0 && (() => {
            const deg = pathDirectionPreview;
            const rad = (deg * Math.PI) / 180;
            // Direction vector (bearing: 0=N, 90=E)
            const dLat = Math.cos(rad);
            const dLng = Math.sin(rad);
            // Perpendicular for parallel offset lines
            const pLat = -dLng;
            const pLng = dLat;

            // Collect all work-area polygons (calibrated)
            const workPolys = polygonMaps
              .filter(m => getAreaStyle(m.mapType, m.mapId, m.mapName) === AREA_STYLES.work)
              .map(m => {
                const calPts = calibratePoints(m.mapArea, activeCal, polyCenter);
                return calPts.map(([lat, lng]) => ({ lat, lng }));
              });
            if (workPolys.length === 0) return null;

            // Compute bounding box of all work polygons to determine line count + extent
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

            const spacing = 0.000008; // ~0.9m between lines — dense hatching
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
                for (const seg of clipped) {
                  allSegments.push(seg);
                }
              }
            }

            return allSegments.map((seg, idx) => (
              <Polyline
                key={`dir-${idx}`}
                positions={seg}
                pathOptions={{
                  color: '#60a5fa',
                  weight: 2,
                  opacity: 0.7,
                }}
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
                  click: editMode === 'none' ? (e) => {
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
          <FitToMaps maps={polygonMaps} onFitted={() => { setMapsFitted(true); setUserInteracted(true); }} />
          <RecenterMap position={position} hasManualInteraction={userInteracted} waitForFit={polygonMaps.length > 0 && !mapsFitted} />
          <UserInteractionTracker onInteract={() => setUserInteracted(true)} />
          {editMode === 'none' && <MapClickDeselect onDeselect={() => setSelectedMapId(null)} />}
          <ResizeHandler />
        </MapContainer>

        {/* Calibration panel — floating on map */}
        {calibrating && (
          <div className="absolute top-3 left-3 z-[1000] bg-gray-900/95 backdrop-blur border border-gray-700 rounded-lg p-3 w-[calc(100vw-1.5rem)] sm:w-64 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-amber-400 uppercase tracking-wide">{t('map.calibrationTitle')}</span>
              <button onClick={cancelCalibrating} className="text-gray-500 hover:text-gray-300" title={t('common.cancel')}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Nudge controls */}
            <div className="mb-3">
              <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t('map.position')}</label>
              <div className="flex items-center justify-center gap-1 mt-1">
                <div className="grid grid-cols-3 gap-0.5 w-fit">
                  <div />
                  <button onClick={() => nudge(NUDGE_STEP, 0)} className="bg-gray-700 hover:bg-gray-600 rounded p-1.5 flex items-center justify-center" title={t('map.moveNorth')}>
                    <ChevronUp className="w-3.5 h-3.5 text-gray-300" />
                  </button>
                  <div />
                  <button onClick={() => nudge(0, -NUDGE_STEP)} className="bg-gray-700 hover:bg-gray-600 rounded p-1.5 flex items-center justify-center" title={t('map.moveWest')}>
                    <ChevronLeft className="w-3.5 h-3.5 text-gray-300" />
                  </button>
                  <div className="bg-gray-800 rounded p-1.5 flex items-center justify-center">
                    <span className="text-[9px] text-gray-500 font-mono">0.5m</span>
                  </div>
                  <button onClick={() => nudge(0, NUDGE_STEP)} className="bg-gray-700 hover:bg-gray-600 rounded p-1.5 flex items-center justify-center" title={t('map.moveEast')}>
                    <ChevronRight className="w-3.5 h-3.5 text-gray-300" />
                  </button>
                  <div />
                  <button onClick={() => nudge(-NUDGE_STEP, 0)} className="bg-gray-700 hover:bg-gray-600 rounded p-1.5 flex items-center justify-center" title={t('map.moveSouth')}>
                    <ChevronDown className="w-3.5 h-3.5 text-gray-300" />
                  </button>
                  <div />
                </div>
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

            {/* Action buttons */}
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-700">
              <button
                onClick={resetCalibrating}
                className="flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
                title={t('map.resetToDefault')}
              >
                <RotateCcw className="w-3 h-3" />
                {t('common.reset')}
              </button>
              <button
                onClick={handleSaveCalibration}
                className="flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-500 transition-colors"
              >
                <Save className="w-3 h-3" />
                {t('common.save')}
              </button>
            </div>
          </div>
        )}

        {/* Mowing progress overlay */}
        {mowing && (() => {
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
        {selectedMapId && !calibrating && editMode === 'none' && (() => {
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
                {m.createdAt && (
                  <span>{new Date(m.createdAt).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                )}
              </div>
              {/* Coverage stats for work areas */}
              {coverageStats.has(m.mapId) && (() => {
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
              <div className="mt-2 pt-2 border-t border-gray-700 flex items-center gap-2">
                <button
                  onClick={(e) => { e.stopPropagation(); startEditMap(m.mapId, m.mapArea); }}
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-emerald-900/40 text-emerald-400 hover:bg-emerald-900/70 hover:text-emerald-300 transition-colors"
                >
                  <Pencil className="w-3 h-3" />
                  {t('common.edit')}
                </button>
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
          );
        })()}
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
    </div>
  );
}
