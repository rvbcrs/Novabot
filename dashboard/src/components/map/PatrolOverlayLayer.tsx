import { useMemo } from 'react';
import { LayerGroup, Marker, Polyline } from 'react-leaflet';
import L from 'leaflet';
import type { MarkState, OverlayPoint, PatrolOverlay } from '../../utils/patrolPlan';

/**
 * The night patrol's route on the map: the checkpoints as numbered circles in
 * driving order (grey pending, blue pulsing current, green done, red with a
 * cross skipped), a dashed line through each zone's points, and a separate
 * dashed line from a zone's last point to the next zone's first (the crossing
 * between them, drawn straight). One layer group, nothing interactive, and it
 * never moves the map. The styles are in index.css (.patrol-mark).
 */

const ZONE_LINE = { color: '#60a5fa', weight: 2, opacity: 0.85, dashArray: '6 6' } as const;
const CROSSING_LINE = { color: '#fbbf24', weight: 2, opacity: 0.8, dashArray: '10 8' } as const;

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

interface Props {
  overlay: PatrolOverlay;
  /** The map's own projection for zone-polygon-frame metres; null for a point it cannot place. */
  toLatLng: (p: { x: number; y: number }) => [number, number] | null;
}

export function PatrolOverlayLayer({ overlay, toLatLng }: Props) {
  const zones = useMemo(() => overlay.zones
    .map(z => ({
      zone: z.zone,
      points: z.points.flatMap((p): Array<OverlayPoint & { ll: [number, number] }> => {
        const ll = toLatLng(p);
        return ll ? [{ ...p, ll }] : [];
      }),
    }))
    .filter(z => z.points.length > 0), [overlay, toLatLng]);

  return (
    <LayerGroup>
      {zones.map(z => z.points.length > 1 && (
        <Polyline key={`line-${z.zone}`} positions={z.points.map(p => p.ll)} pathOptions={ZONE_LINE} interactive={false} />
      ))}
      {zones.slice(1).map((z, i) => (
        <Polyline
          key={`crossing-${zones[i].zone}-${z.zone}`}
          positions={[zones[i].points[zones[i].points.length - 1].ll, z.points[0].ll]}
          pathOptions={CROSSING_LINE}
          interactive={false}
        />
      ))}
      {zones.flatMap(z => z.points.map(p => (
        // Below the mower and the dock, which pass over the checkpoints.
        <Marker key={p.seq} position={p.ll} icon={markIcon(p.state, p.seq)} interactive={false} keyboard={false} zIndexOffset={-1000} />
      )))}
    </LayerGroup>
  );
}
