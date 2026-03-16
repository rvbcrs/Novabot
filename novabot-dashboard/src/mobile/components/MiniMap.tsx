import { useEffect, useState, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Polygon, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import { Layers } from 'lucide-react';
import type { MapData, TrailPoint } from '../../types';
import { fetchMaps, fetchTrail } from '../../api/client';

// Fix Leaflet default marker icons in Vite
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

// ── Constants (copied from MowerMap to avoid importing heavy component) ──

const DEFAULT_CENTER: [number, number] = [52.1409, 6.231];

const TILE_LAYERS = {
  satellite: {
    url: 'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg',
    attribution: '&copy; <a href="https://www.pdok.nl">PDOK</a>',
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

const AREA_STYLES = {
  work:     { color: '#10b981', fillColor: '#10b981', fillOpacity: 0.25, weight: 2 },
  obstacle: { color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.30, weight: 2 },
  unicom:   { color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.20, weight: 2 },
  default:  { color: '#8b5cf6', fillColor: '#8b5cf6', fillOpacity: 0.25, weight: 2 },
} as const;

function getAreaStyle(mapType?: string, mapId?: string, mapName?: string | null) {
  if (mapType === 'obstacle') return AREA_STYLES.obstacle;
  if (mapType === 'unicom') return AREA_STYLES.unicom;
  if (mapType === 'work') return AREA_STYLES.work;
  const id = (mapId ?? '').toLowerCase();
  const name = (mapName ?? '').toLowerCase();
  if (id.includes('obstacle') || name.includes('obstakel') || name.includes('obstacle')) return AREA_STYLES.obstacle;
  if (id.includes('unicom') || name.includes('pad naar') || name.includes('kanaal') || name.includes('channel')) return AREA_STYLES.unicom;
  if (id.includes('work') || name.includes('werkgebied') || name.includes('map')) return AREA_STYLES.work;
  return AREA_STYLES.default;
}

function makeMowerIcon(heading: number) {
  return L.divIcon({
    className: '',
    html: `<div style="width:36px;height:36px;transform:rotate(${heading}deg);display:flex;align-items:center;justify-content:center">
      <img src="/mower/mower_location.png" style="width:32px;height:20px;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.4))" />
    </div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}

function makeChargerIcon() {
  return L.divIcon({
    className: '',
    html: `<div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center">
      <img src="/mower/lawn_charger.png" style="width:28px;height:28px;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.4))" />
    </div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}

// ── Inner components ────────────────────────────────────────────────

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
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 22 });
    setFitted(true);
  }, [map, maps, fitted]);

  return null;
}

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

function RecenterMap({ position }: { position: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.setView(position, map.getZoom());
  }, [map, position[0], position[1]]);
  return null;
}

// ── MiniMap ─────────────────────────────────────────────────────────

interface Props {
  sn: string;
  lat: number | null;
  lng: number | null;
  heading: number;
  chargerLat: number | null;
  chargerLng: number | null;
  liveOutline?: Array<{ lat: number; lng: number }> | null;
  className?: string;
  onTap?: () => void;
  showControls?: boolean;
}

export function MiniMap({
  sn, lat, lng, heading, chargerLat, chargerLng,
  liveOutline, className = '', onTap, showControls = false,
}: Props) {
  const [maps, setMaps] = useState<MapData[]>([]);
  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const [tileLayer, setTileLayer] = useState<'satellite' | 'street'>('satellite');

  // Fetch maps + trail
  useEffect(() => {
    if (!sn) return;
    fetchMaps(sn).then(setMaps).catch(() => {});
    fetchTrail(sn).then(setTrail).catch(() => {});
  }, [sn]);

  const center: [number, number] = lat && lng ? [lat, lng] : DEFAULT_CENTER;

  const mowerIcon = useMemo(() => makeMowerIcon(heading), [heading]);
  const chargerIcon = useMemo(() => makeChargerIcon(), []);

  const trailPositions = useMemo(
    () => trail.map(p => [p.lat, p.lng] as [number, number]),
    [trail],
  );

  const tile = TILE_LAYERS[tileLayer];

  return (
    <div className={`relative ${className}`}>
      <MapContainer
        center={center}
        zoom={20}
        maxZoom={23}
        zoomControl={false}
        attributionControl={false}
        className="h-full w-full"
        scrollWheelZoom={!onTap}
        dragging={!onTap}
        touchZoom={!onTap}
        doubleClickZoom={false}
      >
        <TileLayer
          key={tileLayer}
          url={tile.url}
          maxZoom={tile.maxZoom}
          maxNativeZoom={tile.maxNativeZoom}
        />

        {/* Work area polygons */}
        {maps.map(m => (
          <Polygon
            key={m.mapId}
            positions={m.mapArea.map(p => [p.lat, p.lng] as [number, number])}
            pathOptions={getAreaStyle(m.mapType, m.mapId, m.mapName)}
          />
        ))}

        {/* GPS trail */}
        {trailPositions.length > 1 && (
          <Polyline
            positions={trailPositions}
            pathOptions={{ color: '#10b981', weight: 2, opacity: 0.5 }}
          />
        )}

        {/* Live mapping outline */}
        {liveOutline && liveOutline.length > 2 && (
          <Polygon
            positions={liveOutline.map(p => [p.lat, p.lng] as [number, number])}
            pathOptions={{ color: '#a78bfa', fillColor: '#a78bfa', fillOpacity: 0.15, weight: 2, dashArray: '6 4' }}
          />
        )}

        {/* Charger marker */}
        {chargerLat && chargerLng && (
          <Marker position={[chargerLat, chargerLng]} icon={chargerIcon} />
        )}

        {/* Mower marker */}
        {lat && lng && (
          <Marker position={[lat, lng]} icon={mowerIcon} />
        )}

        <FitToMaps maps={maps} />
        <ResizeHandler />
        {lat && lng && !onTap && <RecenterMap position={[lat, lng]} />}
      </MapContainer>

      {/* Tap overlay for home mode — blocks Leaflet touch, navigates to map tab */}
      {onTap && (
        <div
          className="absolute inset-0 z-[1000] cursor-pointer"
          onClick={onTap}
        />
      )}

      {/* Tile layer switcher */}
      {showControls && (
        <button
          onClick={() => setTileLayer(l => l === 'satellite' ? 'street' : 'satellite')}
          className="absolute top-3 right-3 z-[1001]
                     bg-white/85 dark:bg-gray-900/80 backdrop-blur-sm
                     rounded-lg p-2 border border-gray-200/60 dark:border-gray-700/50
                     text-gray-600 dark:text-gray-300
                     active:scale-95 transition-transform"
        >
          <Layers className="w-5 h-5" />
        </button>
      )}
    </div>
  );
}
