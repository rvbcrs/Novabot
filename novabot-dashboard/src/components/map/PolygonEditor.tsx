import { useCallback, useMemo } from 'react';
import { Marker, Polygon, useMap } from 'react-leaflet';
import L from 'leaflet';

// ── Custom marker icons ─────────────────────────────────────────

function makeVertexIcon(color: string) {
  return L.divIcon({
    className: '',
    html: `<div style="width:12px;height:12px;background:${color};border:2px solid white;border-radius:50%;cursor:grab;box-shadow:0 1px 4px rgba(0,0,0,.4)" />`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
}

const midpointIcon = L.divIcon({
  className: '',
  html: '<div style="width:8px;height:8px;background:#6b7280;border:1px solid white;border-radius:50%;cursor:pointer;opacity:.6" />',
  iconSize: [8, 8],
  iconAnchor: [4, 4],
});

// ── Component ───────────────────────────────────────────────────

interface Props {
  vertices: [number, number][];
  onChange: (v: [number, number][]) => void;
  color?: string;
}

export function PolygonEditor({ vertices, onChange, color = '#10b981' }: Props) {
  const map = useMap();

  const vertexIcon = useMemo(() => makeVertexIcon(color), [color]);

  // Drag a vertex to a new position
  const handleVertexDrag = useCallback((index: number, e: L.DragEndEvent) => {
    const pos = e.target.getLatLng();
    const next = [...vertices];
    next[index] = [pos.lat, pos.lng];
    onChange(next);
  }, [vertices, onChange]);

  // Remove a vertex (right-click), minimum 3
  const handleVertexRemove = useCallback((index: number) => {
    if (vertices.length <= 3) return;
    const next = vertices.filter((_, i) => i !== index);
    onChange(next);
  }, [vertices, onChange]);

  // Insert a new vertex between index and index+1
  const handleMidpointClick = useCallback((index: number) => {
    const a = vertices[index];
    const b = vertices[(index + 1) % vertices.length];
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const next = [...vertices];
    next.splice(index + 1, 0, mid);
    onChange(next);
  }, [vertices, onChange]);

  // Midpoints between each consecutive pair of vertices
  const midpoints = useMemo(() => {
    if (vertices.length < 2) return [];
    return vertices.map((v, i) => {
      const next = vertices[(i + 1) % vertices.length];
      return {
        index: i,
        pos: [(v[0] + next[0]) / 2, (v[1] + next[1]) / 2] as [number, number],
      };
    });
  }, [vertices]);

  if (vertices.length < 2) return null;

  return (
    <>
      {/* Live polygon outline */}
      <Polygon
        positions={vertices}
        pathOptions={{
          color,
          fillColor: color + '40',
          fillOpacity: 0.3,
          weight: 2,
          dashArray: '6, 4',
        }}
      />

      {/* Vertex markers (draggable) */}
      {vertices.map((v, i) => (
        <Marker
          key={`v-${i}`}
          position={v}
          icon={vertexIcon}
          draggable
          eventHandlers={{
            dragend: (e) => handleVertexDrag(i, e),
            contextmenu: (e) => {
              L.DomEvent.preventDefault(e);
              L.DomEvent.stopPropagation(e);
              handleVertexRemove(i);
            },
          }}
        />
      ))}

      {/* Midpoint markers (click to insert new vertex) */}
      {midpoints.map(({ index, pos }) => (
        <Marker
          key={`m-${index}`}
          position={pos}
          icon={midpointIcon}
          eventHandlers={{
            click: (e) => {
              L.DomEvent.stopPropagation(e);
              handleMidpointClick(index);
            },
          }}
        />
      ))}
    </>
  );
}
