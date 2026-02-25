import { useEffect, useState, useCallback, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polygon, Polyline, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import {
  MapPin, Map as MapIcon, Trash2, Route, Wifi, WifiOff, Satellite, Crosshair,
  Battery, BatteryCharging, BatteryLow, BatteryFull, Layers,
  SlidersHorizontal, Save, X, RotateCcw,
  ChevronUp, ChevronDown, ChevronLeft, ChevronRight,
} from 'lucide-react';
import type { MapData, TrailPoint, MapCalibration } from '../../types';
import { fetchMaps, fetchTrail, clearTrail, fetchCalibration, saveCalibration } from '../../api/client';

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
  work:     { color: '#10b981', fillColor: '#10b98140', fillOpacity: 0.25, weight: 2 },   // emerald
  obstacle: { color: '#ef4444', fillColor: '#ef444440', fillOpacity: 0.30, weight: 2 },   // red
  unicom:   { color: '#3b82f6', fillColor: '#3b82f640', fillOpacity: 0.20, weight: 2 },   // blue
  default:  { color: '#8b5cf6', fillColor: '#8b5cf640', fillOpacity: 0.25, weight: 2 },   // purple
} as const;

/** Bepaal kaarttype uit mapId of mapName */
function getAreaStyle(mapId: string, mapName?: string | null) {
  const id = mapId.toLowerCase();
  const name = (mapName ?? '').toLowerCase();
  if (id.includes('obstacle') || name.includes('obstakel')) return AREA_STYLES.obstacle;
  if (id.includes('unicom') || name.includes('pad naar')) return AREA_STYLES.unicom;
  if (id.includes('work') || name.includes('werkgebied')) return AREA_STYLES.work;
  return AREA_STYLES.default;
}

interface SignalInfo {
  wifiRssi?: string;
  rtkSat?: string;
  locQuality?: string;
  batteryPower?: string;
  batteryState?: string;
}

interface Props {
  sn: string;
  lat?: string;
  lng?: string;
  signals?: SignalInfo;
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

function RecenterMap({ position, hasManualInteraction }: { position: [number, number]; hasManualInteraction: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (!hasManualInteraction) {
      map.setView(position, map.getZoom());
    }
  }, [map, position[0], position[1], hasManualInteraction]);
  return null;
}

/** Auto-fit map to polygon bounds on load */
function FitToMaps({ maps }: { maps: MapData[] }) {
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
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 20 });
    setFitted(true);
  }, [map, maps, fitted]);

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
    maxZoom: 21,
  },
  street: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    maxZoom: 19,
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

// ── Nudge step: ~0.5m in degrees ─────────────────────────────────
const NUDGE_STEP = 0.000005; // ~0.55m lat, ~0.35m lng at 52°N

export function MowerMap({ sn, lat, lng, signals }: Props) {
  const [maps, setMaps] = useState<MapData[]>([]);
  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const [showTrail, setShowTrail] = useState(true);
  const [tileLayer, setTileLayer] = useState<'satellite' | 'street'>('satellite');
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);

  // Calibration state
  const [savedCal, setSavedCal] = useState<MapCalibration>(DEFAULT_CAL);
  const [editCal, setEditCal] = useState<MapCalibration | null>(null);
  const calibrating = editCal !== null;
  const activeCal = editCal ?? savedCal;

  useEffect(() => {
    fetchMaps(sn).then(setMaps).catch(() => setMaps([]));
    fetchTrail(sn).then(setTrail).catch(() => setTrail([]));
    fetchCalibration(sn).then(setSavedCal).catch(() => {});
  }, [sn]);

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

  const hasGps = lat && lng && lat !== '0' && lng !== '0';
  const position: [number, number] = hasGps
    ? [parseFloat(lat), parseFloat(lng)]
    : DEFAULT_CENTER;

  const [userInteracted, setUserInteracted] = useState(false);

  const polygonMaps = maps.filter(m => m.mapArea.length >= 3);
  const trailPositions: [number, number][] = trail.map(p => [p.lat, p.lng]);

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
    <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-3">
          <MapPin className="w-4 h-4 text-blue-400" />
          {/* Signal icon bar */}
          {signals && (() => {
            const rssi = signals.wifiRssi ? parseInt(signals.wifiRssi, 10) : null;
            const sats = signals.rtkSat ? parseInt(signals.rtkSat, 10) : null;
            const loc = signals.locQuality ? parseInt(signals.locQuality, 10) : null;
            const bat = signals.batteryPower ? parseInt(signals.batteryPower, 10) : null;
            const charging = signals.batteryState?.toUpperCase() === 'CHARGING';
            const BatIcon = charging ? BatteryCharging : bat !== null && bat <= 15 ? BatteryLow : bat !== null && bat >= 80 ? BatteryFull : Battery;
            return (
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-0.5 ${bat !== null ? batteryColor(bat) : 'text-gray-600'}`} title={bat !== null ? `Battery: ${bat}%${charging ? ' (charging)' : ''}` : 'Battery: no data'}>
                  <BatIcon className="w-3.5 h-3.5" />
                  {bat !== null && <span className="text-[10px] font-mono">{bat}%</span>}
                </span>
                <span className={`inline-flex items-center gap-0.5 ${rssi !== null ? wifiColor(rssi) : 'text-gray-600'}`} title={rssi !== null ? `WiFi: ${rssi} dBm` : 'WiFi: no data'}>
                  {rssi !== null ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                  {rssi !== null && <span className="text-[10px] font-mono">{rssi}</span>}
                </span>
                <span className={`inline-flex items-center gap-0.5 ${sats !== null ? gpsColor(sats) : 'text-gray-600'}`} title={sats !== null ? `RTK Satellites: ${sats}` : 'RTK: no data'}>
                  <Satellite className="w-3.5 h-3.5" />
                  {sats !== null && <span className="text-[10px] font-mono">{sats}</span>}
                </span>
                <span className={`inline-flex items-center gap-0.5 ${loc !== null ? locColor(loc) : 'text-gray-600'}`} title={loc !== null ? `Location Quality: ${loc}%` : 'Location: no data'}>
                  <Crosshair className="w-3.5 h-3.5" />
                  {loc !== null && <span className="text-[10px] font-mono">{loc}%</span>}
                </span>
              </div>
            );
          })()}
        </div>
        <div className="flex items-center gap-3">
          {trail.length > 0 && (
            <button
              onClick={() => setShowTrail(!showTrail)}
              className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded transition-colors ${
                showTrail ? 'bg-cyan-900/50 text-cyan-400' : 'bg-gray-700/50 text-gray-500'
              }`}
              title={showTrail ? 'Hide GPS trail' : 'Show GPS trail'}
            >
              <Route className="w-3 h-3" />
              {trail.length} pts
            </button>
          )}
          {trail.length > 0 && (
            <button
              onClick={handleClearTrail}
              className="text-gray-500 hover:text-red-400 transition-colors"
              title="Clear GPS trail"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          {/* Calibrate toggle */}
          {polygonMaps.length > 0 && !calibrating && (
            <button
              onClick={startCalibrating}
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded transition-colors bg-gray-700/50 text-gray-400 hover:text-amber-400 hover:bg-amber-900/30"
              title="Calibrate map overlay"
            >
              <SlidersHorizontal className="w-3 h-3" />
              Calibrate
            </button>
          )}
          <button
            onClick={() => setTileLayer(tileLayer === 'satellite' ? 'street' : 'satellite')}
            className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded transition-colors ${
              tileLayer === 'satellite' ? 'bg-blue-900/50 text-blue-400' : 'bg-gray-700/50 text-gray-500'
            }`}
            title={tileLayer === 'satellite' ? 'Switch to street map' : 'Switch to satellite'}
          >
            <Layers className="w-3 h-3" />
            {tileLayer === 'satellite' ? 'Sat' : 'Map'}
          </button>
          {polygonMaps.length > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-gray-500">
              <MapIcon className="w-3 h-3" />
              {polygonMaps.length} map{polygonMaps.length !== 1 ? 's' : ''}
            </span>
          )}
          {hasGps ? (
            <span className="text-xs text-gray-500 font-mono">
              {parseFloat(lat).toFixed(6)}, {parseFloat(lng).toFixed(6)}
            </span>
          ) : (
            <span className="text-xs text-gray-600">No GPS data</span>
          )}
        </div>
      </div>
      <div className="relative flex-1 min-h-0">
        <MapContainer
          center={position}
          zoom={20}
          maxZoom={21}
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
          />
          {/* Saved map polygons with calibration applied */}
          {polygonMaps.map(m => {
            const positions = calibratePoints(m.mapArea, activeCal, polyCenter);
            const baseStyle = getAreaStyle(m.mapId, m.mapName);
            const isSelected = selectedMapId === m.mapId;
            const style = isSelected
              ? { ...baseStyle, fillOpacity: 0.5, weight: 3, opacity: 1 }
              : baseStyle;
            return (
              <Polygon
                key={m.mapId}
                positions={positions}
                pathOptions={style}
                eventHandlers={{
                  click: (e) => {
                    L.DomEvent.stopPropagation(e);
                    setSelectedMapId(prev => prev === m.mapId ? null : m.mapId);
                  },
                }}
              >
                {m.mapName && (
                  <Tooltip sticky>{m.mapName}</Tooltip>
                )}
              </Polygon>
            );
          })}
          {/* GPS trail */}
          {showTrail && trailPositions.length >= 2 && (
            <Polyline
              positions={trailPositions}
              pathOptions={{
                color: '#06b6d4',
                weight: 3,
                opacity: 0.7,
                dashArray: '6, 4',
              }}
            />
          )}
          {/* GPS marker */}
          {hasGps && (
            <Marker position={position}>
              <Popup>
                Mower: {parseFloat(lat).toFixed(6)}, {parseFloat(lng).toFixed(6)}
              </Popup>
            </Marker>
          )}
          <FitToMaps maps={polygonMaps} />
          <RecenterMap position={position} hasManualInteraction={userInteracted} />
          <UserInteractionTracker onInteract={() => setUserInteracted(true)} />
          <MapClickDeselect onDeselect={() => setSelectedMapId(null)} />
          <ResizeHandler />
        </MapContainer>

        {/* Calibration panel — floating on map */}
        {calibrating && (
          <div className="absolute top-3 left-3 z-[1000] bg-gray-900/95 backdrop-blur border border-gray-700 rounded-lg p-3 w-64 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-amber-400 uppercase tracking-wide">Map Calibration</span>
              <button onClick={cancelCalibrating} className="text-gray-500 hover:text-gray-300" title="Cancel">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Nudge controls */}
            <div className="mb-3">
              <label className="text-[10px] text-gray-500 uppercase tracking-wide">Position</label>
              <div className="flex items-center justify-center gap-1 mt-1">
                <div className="grid grid-cols-3 gap-0.5 w-fit">
                  <div />
                  <button onClick={() => nudge(NUDGE_STEP, 0)} className="bg-gray-700 hover:bg-gray-600 rounded p-1.5 flex items-center justify-center" title="Move North">
                    <ChevronUp className="w-3.5 h-3.5 text-gray-300" />
                  </button>
                  <div />
                  <button onClick={() => nudge(0, -NUDGE_STEP)} className="bg-gray-700 hover:bg-gray-600 rounded p-1.5 flex items-center justify-center" title="Move West">
                    <ChevronLeft className="w-3.5 h-3.5 text-gray-300" />
                  </button>
                  <div className="bg-gray-800 rounded p-1.5 flex items-center justify-center">
                    <span className="text-[9px] text-gray-500 font-mono">0.5m</span>
                  </div>
                  <button onClick={() => nudge(0, NUDGE_STEP)} className="bg-gray-700 hover:bg-gray-600 rounded p-1.5 flex items-center justify-center" title="Move East">
                    <ChevronRight className="w-3.5 h-3.5 text-gray-300" />
                  </button>
                  <div />
                  <button onClick={() => nudge(-NUDGE_STEP, 0)} className="bg-gray-700 hover:bg-gray-600 rounded p-1.5 flex items-center justify-center" title="Move South">
                    <ChevronDown className="w-3.5 h-3.5 text-gray-300" />
                  </button>
                  <div />
                </div>
              </div>
            </div>

            {/* Rotation */}
            <div className="mb-3">
              <div className="flex items-center justify-between">
                <label className="text-[10px] text-gray-500 uppercase tracking-wide">Rotation</label>
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
                <label className="text-[10px] text-gray-500 uppercase tracking-wide">Scale</label>
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
                title="Reset to default"
              >
                <RotateCcw className="w-3 h-3" />
                Reset
              </button>
              <button
                onClick={handleSaveCalibration}
                className="flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-500 transition-colors"
              >
                <Save className="w-3 h-3" />
                Save
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
