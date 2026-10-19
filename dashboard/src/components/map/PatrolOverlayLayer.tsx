import { useMemo } from 'react';
import { CircleMarker, LayerGroup, Marker, Polyline } from 'react-leaflet';
import L from 'leaflet';
import { planRoutes, prepareObstacles, prepareRail, prepareZone, type MarkState, type OverlayPoint, type PatrolOverlay, type PlanGeometry, type PlanRail, type PreparedZone, type XY } from '../../utils/patrolPlan';
import { splitTrack, type PatrolTrackView } from '../../utils/patrolTrack';

/**
 * The night patrol on the map. The route: the checkpoints as numbered circles in
 * driving order (grey pending, blue pulsing current, green done, red with a cross
 * skipped), a dashed line through each zone's points, and a separate dashed line
 * from a zone's last point to the next zone's first (the crossing between them).
 * The dashed line is the visiting order. It stays inside the zone and is drawn
 * around the recorded obstacles (their outline, with a margin), because nav2
 * plans in the mapped area and around them; it is not nav2's exact path. The
 * crossing follows the channel recorded between the two zones (zones that touch
 * need none); without either there is no crossing line. A leg that cannot be
 * placed inside its zone (a zone the map does not know, a checkpoint outside the
 * zone as it is now) gets no line: the circles stay. The driven track is a solid
 * line above it, where the mower really went, in pieces (no line across a signal
 * dropout), ending at where it is.
 * One layer group, nothing interactive, and it never moves the map. The styles of
 * the circles are in index.css (.patrol-mark).
 */

const ZONE_LINE = { color: '#60a5fa', weight: 2, opacity: 0.85, dashArray: '6 6' } as const;
const CROSSING_LINE = { color: '#fbbf24', weight: 2, opacity: 0.8, dashArray: '10 8' } as const;
const TRACK_LINE = { color: '#22d3ee', weight: 3, opacity: 0.95 } as const;
const TRACK_END = { color: '#ffffff', weight: 2, fillColor: '#22d3ee', fillOpacity: 1 } as const;
/** How far the dashed line keeps from a recorded obstacle (about what nav2's costmap inflates by). */
const OBSTACLE_CLEAR_M = 0.6;

// A handful of icons (4 states x at most 60 numbers), made once.
const icons = new Map<string, L.DivIcon>();
function markIcon(state: MarkState, seq: number): L.DivIcon {
  const key = `${state}:${seq}`;
  let icon = icons.get(key);
  if (!icon) {
    icon = L.divIcon({
      className: `patrol-mark patrol-mark--${state}`,
      html: state === 'skipped' ? '&times;' : String(seq),
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
    icons.set(key, icon);
  }
  return icon;
}

type LatLng = [number, number];

export interface PatrolChannel { zones: readonly [string, string]; points: readonly XY[] }

interface Props {
  /** The route; null without a plan (the track can still be drawn). */
  overlay: PatrolOverlay | null;
  /** Where the mower drove, and whether it is still on its way. */
  track: PatrolTrackView | null;
  /** The recorded obstacles, in the frame of the route (metres). */
  obstacles: readonly (readonly XY[])[];
  /** The work areas by zone name (map0, map1, ...), same frame: the line stays inside them. */
  zones: ReadonlyMap<string, readonly XY[]>;
  /** The channels recorded between two zones, same frame: the crossing follows them. */
  channels: readonly PatrolChannel[];
  /** The map's own projection for zone-polygon-frame metres (the route); null for a point it cannot place. */
  toLatLng: (p: XY) => LatLng | null;
  /** The projection of the mower's own position (telemetry), like the mower marker uses. */
  trackToLatLng: (p: XY) => LatLng | null;
}

const place = (pts: readonly XY[], to: (p: XY) => LatLng | null): LatLng[] => pts.flatMap(p => { const ll = to(p); return ll ? [ll] : []; });

export function PatrolOverlayLayer({ overlay, track, obstacles, zones, channels, toLatLng, trackToLatLng }: Props) {
  // The overlay is a new object whenever a checkpoint changes state, but the routes only
  // depend on where the checkpoints are: key them on the coordinates, not on the object.
  const geometryKey = overlay ? JSON.stringify(overlay.zones.map(z => [z.zone, z.points.map(p => [p.x, p.y])])) : '';
  const geometry = useMemo(() => (geometryKey ? JSON.parse(geometryKey) as PlanGeometry : []), [geometryKey]);
  const prepared = useMemo(() => prepareObstacles(obstacles, OBSTACLE_CLEAR_M), [obstacles]);
  const ready = useMemo(() => {
    const out = new Map<string, PreparedZone>();
    for (const [name, poly] of zones) {
      const zone = prepareZone(poly);
      if (zone) out.set(name, zone);
    }
    return out;
  }, [zones]);
  const rails = useMemo(() => channels.map((c): PlanRail => ({ zones: c.zones, rail: prepareRail(c.points) })).filter(r => r.rail.length >= 2), [channels]);

  // The routes, in metres: the dashed line through each zone's checkpoints, inside the zone
  // and bent around the obstacles between two of them, and the crossing that joins a zone
  // to the next along the channel between them.
  const routes = useMemo(() => planRoutes(geometry, ready, rails, prepared), [geometry, prepared, ready, rails]);

  // Then onto the map, which changes with the calibration and not with the route.
  const lines = useMemo(() => routes.map(r => ({
    zone: r.zone,
    pieces: r.pieces.map(piece => place(piece, toLatLng)).filter(piece => piece.length > 1),
    crossing: r.crossing ? place(r.crossing, toLatLng) : null,
  })), [routes, toLatLng]);
  const markers = useMemo(() => (overlay?.zones ?? []).flatMap(z => z.points.flatMap((p): Array<OverlayPoint & { ll: LatLng }> => { const ll = toLatLng(p); return ll ? [{ ...p, ll }] : []; })), [overlay, toLatLng]);

  // The driven track, in pieces: no line across a dropout. The end disc sits on the last point.
  const pieces = useMemo(() => (track ? splitTrack(track.points).map(piece => place(piece, trackToLatLng)).filter(piece => piece.length > 1) : []), [track, trackToLatLng]);
  const end = useMemo(() => {
    const last = track?.live ? track.points[track.points.length - 1] : undefined;
    return last ? trackToLatLng(last) : null;
  }, [track, trackToLatLng]);

  return (
    <LayerGroup>
      {lines.map(z => z.pieces.length > 0 && (
        <Polyline key={`line-${z.zone}`} positions={z.pieces} pathOptions={ZONE_LINE} interactive={false} />
      ))}
      {lines.map((z, i) => z.crossing && z.crossing.length > 1 && (
        <Polyline key={`crossing-${z.zone}-${lines[i + 1].zone}`} positions={z.crossing} pathOptions={CROSSING_LINE} interactive={false} />
      ))}
      {pieces.length > 0 && <Polyline key="track" positions={pieces} pathOptions={TRACK_LINE} interactive={false} />}
      {end && <CircleMarker key="track-end" center={end} radius={5} pathOptions={TRACK_END} interactive={false} />}
      {markers.map(p => (
        // Below the mower and the dock, which pass over the checkpoints.
        <Marker key={p.seq} position={p.ll} icon={markIcon(p.state, p.seq)} interactive={false} keyboard={false} zIndexOffset={-1000} />
      ))}
    </LayerGroup>
  );
}
