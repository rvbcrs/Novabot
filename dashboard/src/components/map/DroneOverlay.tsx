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
 * Rotation: Leaflet's ImageOverlay is axis-aligned and positions the <img>
 * with `transform: translate3d(...)`. The rotation has to come AFTER that
 * translate inside the same transform list; the separate CSS `rotate`
 * property looked like a shortcut but is applied before `transform`, so it
 * rotated Leaflet's translate as well and the photo sat displaced by the
 * rotated offset (a 120x60 px drag came out as 42x127). So a small subclass
 * re-appends `rotate()` whenever Leaflet resets the element. Mercator is
 * conformal, so a rotation on screen is the same rotation on the ground at
 * this scale. No plugin needed.
 */
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';
import type { DroneOverlayPlacement } from '../../api/client';

const PANE = 'droneOverlay';

/** ImageOverlay that keeps a rotation about its centre across Leaflet's resets. */
// Leaflet's typings hide these internals; they are stable across 1.x.
const base = L.ImageOverlay.prototype as unknown as { _reset(): void; _animateZoom(e: unknown): void };
const RotatedImageOverlay = L.ImageOverlay.extend({
  _rotationDeg: 0,
  setRotation(deg: number) { this._rotationDeg = deg; this._applyRotation(); return this; },
  _applyRotation() {
    const img = this._image as HTMLImageElement | undefined;
    if (!img) return;
    img.style.transformOrigin = '50% 50%';
    img.style.transform = `${(img.style.transform || '').replace(/\s*rotate\([^)]*\)/, '')} rotate(${this._rotationDeg}deg)`;
  },
  _reset() { base._reset.call(this); this._applyRotation(); },
  _animateZoom(e: unknown) { base._animateZoom.call(this, e); this._applyRotation(); },
}) as unknown as new (url: string, bounds: L.LatLngBoundsExpression, options?: L.ImageOverlayOptions) => L.ImageOverlay & { setRotation(deg: number): L.ImageOverlay };
type RotatedOverlay = InstanceType<typeof RotatedImageOverlay>;
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
  const layerRef = useRef<RotatedOverlay | null>(null);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  // The layer lives as long as the URL does; placement changes adjust it in place.
  useEffect(() => {
    if (!map.getPane(PANE)) map.createPane(PANE).style.zIndex = PANE_Z;
    const layer = new RotatedImageOverlay(url, overlayBounds(placement, aspect), {
      pane: PANE, opacity: placement.opacity, interactive: true, className: 'drone-overlay',
    }).addTo(map) as RotatedOverlay;
    layer.setRotation(placement.rotationDeg);
    layerRef.current = layer;
    return () => { layer.remove(); layerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, url, aspect]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.setBounds(L.latLngBounds(overlayBounds(placement, aspect)));
    layer.setOpacity(placement.opacity);
    layer.setRotation(placement.rotationDeg);
    const el = layer.getElement();
    if (el) {
      el.style.cursor = editing ? 'move' : '';
      el.style.pointerEvents = editing ? 'auto' : 'none';
    }
  }, [placement, aspect, editing]);

  // Drag to move, through Leaflet's own events so zoom and projection stay
  // consistent. Anchored on the start: the new centre is the centre at
  // mousedown plus the total mouse displacement, so a React update that has
  // not landed yet cannot swallow part of the movement. The map's own drag
  // handler is paused for the duration.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !editing) return;
    let startMouse: L.LatLng | null = null;
    let startCenter: L.LatLng | null = null;
    const move = (e: L.LeafletMouseEvent) => {
      if (!startMouse || !startCenter) return;
      onMoveRef.current?.({
        lat: startCenter.lat + (e.latlng.lat - startMouse.lat),
        lng: startCenter.lng + (e.latlng.lng - startMouse.lng),
      });
    };
    const up = () => { startMouse = null; startCenter = null; map.dragging.enable(); map.off('mousemove', move); };
    const down = (e: L.LeafletMouseEvent) => {
      L.DomEvent.stop(e.originalEvent);
      startMouse = e.latlng;
      startCenter = layer.getBounds().getCenter();
      map.dragging.disable();
      map.on('mousemove', move);
      map.once('mouseup', up);
    };
    layer.on('mousedown', down);
    return () => { layer.off('mousedown', down); map.off('mousemove', move); map.dragging.enable(); };
  }, [map, editing, url]);

  return null;
}
