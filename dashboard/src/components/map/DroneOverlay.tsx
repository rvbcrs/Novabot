/**
 * A user's own drone photo under the map (#124).
 *
 * Open aerial imagery is rectified against a terrain model, so a hedge leans
 * a metre from where it stands and that is the line people trace. A drone
 * shot straight down has no lean at the centre of the frame and a centimetre
 * or two per pixel. This draws that photo below the polygons, placed by hand:
 * centre, width in metres, rotation. It is a tracing aid; nothing here ever
 * feeds a coordinate into a map.
 *
 * Rotation: Leaflet's ImageOverlay is axis-aligned and owns the element's
 * `transform`. The separate CSS `rotate` property composes with it, so the
 * axis-aligned box of the unrotated image is placed by Leaflet and the image
 * is turned about its centre by CSS. Mercator is conformal, so a rotation on
 * screen is the same rotation on the ground at this scale. No plugin needed.
 */
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';
import type { DroneOverlayPlacement } from '../../api/client';

const PANE = 'droneOverlay';
/** Between tilePane (200) and overlayPane (400): under polygons, over the map. */
const PANE_Z = '350';
const M_PER_DEG_LAT = 111_320;

/** Axis-aligned bounds of the unrotated image for this placement and aspect. */
export function overlayBounds(p: DroneOverlayPlacement, aspect: number): L.LatLngBoundsLiteral {
  const heightM = p.widthM / aspect;
  const dLat = heightM / 2 / M_PER_DEG_LAT;
  const dLng = p.widthM / 2 / (M_PER_DEG_LAT * Math.cos(p.lat * Math.PI / 180));
  return [[p.lat - dLat, p.lng - dLng], [p.lat + dLat, p.lng + dLng]];
}

interface Props {
  url: string;
  /** width / height in pixels. */
  aspect: number;
  placement: DroneOverlayPlacement;
  /** While placing: the photo is draggable and the map underneath is not. */
  editing: boolean;
  onMove?: (center: { lat: number; lng: number }) => void;
}

export function DroneOverlayLayer({ url, aspect, placement, editing, onMove }: Props) {
  const map = useMap();
  const layerRef = useRef<L.ImageOverlay | null>(null);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  // The layer lives as long as the URL does; placement changes adjust it in place.
  useEffect(() => {
    if (!map.getPane(PANE)) map.createPane(PANE).style.zIndex = PANE_Z;
    const layer = L.imageOverlay(url, overlayBounds(placement, aspect), {
      pane: PANE, opacity: placement.opacity, interactive: true, className: 'drone-overlay',
    }).addTo(map);
    layerRef.current = layer;
    return () => { layer.remove(); layerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, url, aspect]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.setBounds(L.latLngBounds(overlayBounds(placement, aspect)));
    layer.setOpacity(placement.opacity);
    const el = layer.getElement();
    if (el) {
      el.style.rotate = `${placement.rotationDeg}deg`;
      el.style.cursor = editing ? 'move' : '';
      el.style.pointerEvents = editing ? 'auto' : 'none';
    }
  }, [placement, aspect, editing]);

  // Drag to move, through Leaflet's own events so zoom and projection stay
  // consistent. The map's drag handler is paused for the duration.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !editing) return;
    let last: L.LatLng | null = null;
    const move = (e: L.LeafletMouseEvent) => {
      if (!last) return;
      const c = layerRef.current?.getBounds().getCenter();
      if (!c) return;
      onMoveRef.current?.({ lat: c.lat + (e.latlng.lat - last.lat), lng: c.lng + (e.latlng.lng - last.lng) });
      last = e.latlng;
    };
    const up = () => { last = null; map.dragging.enable(); map.off('mousemove', move); };
    const down = (e: L.LeafletMouseEvent) => {
      L.DomEvent.stop(e.originalEvent);
      last = e.latlng;
      map.dragging.disable();
      map.on('mousemove', move);
      map.once('mouseup', up);
    };
    layer.on('mousedown', down);
    return () => { layer.off('mousedown', down); map.off('mousemove', move); map.dragging.enable(); };
  }, [map, editing, url]);

  return null;
}
