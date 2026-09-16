/**
 * A user's own drone photo under the map (#124).
 *
 * Open aerial imagery is rectified against a terrain model, so a hedge leans
 * a metre from where it stands and that is the line people trace. A drone
 * shot straight down has no lean at the centre of the frame and a centimetre
 * or two per pixel. This draws that photo below the polygons, placed by its
 * four corners on the map. It is a tracing aid; nothing here ever feeds a
 * coordinate into a map.
 *
 * Drawing: Leaflet's ImageOverlay is axis-aligned. It sizes the <img> to the
 * corners' bounding box and positions it with `transform: translate3d(...)`.
 * A small subclass appends a `matrix3d()` that maps that box onto the four
 * corners (a homography, so a trapezium from a tilted camera comes out as
 * one), re-applied whenever Leaflet resets the element. It has to sit AFTER
 * the translate inside the same transform list; the separate CSS `rotate`
 * property looked like a shortcut but is applied before `transform`, so it
 * rotated Leaflet's translate as well and the photo sat displaced. Mercator
 * is conformal, so a shape on screen is the same shape on the ground at this
 * scale. No plugin needed.
 */
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';
import type { DroneOverlayPlacement, DroneCorners } from '../../api/client';
import { homographyFromPairs, translateCorners } from '../../utils/droneOverlayMath';

const PANE = 'droneOverlay';
/** Between tilePane (200) and overlayPane (400): under polygons, over the map. */
const PANE_Z = '350';

/** CSS matrix3d for a 2D homography [a b c; d e f; g h i]: column-major, z untouched. */
export function matrix3dOf(h: number[]): string {
  const n = (v: number) => (v / h[8]).toPrecision(15);
  return `matrix3d(${n(h[0])}, ${n(h[3])}, 0, ${n(h[6])}, ${n(h[1])}, ${n(h[4])}, 0, ${n(h[7])}, 0, 0, 1, 0, ${n(h[2])}, ${n(h[5])}, 0, 1)`;
}

/** ImageOverlay that keeps its four corners across Leaflet's resets and zoom animations. */
// Leaflet's typings hide these internals; they are stable across 1.x.
const base = L.ImageOverlay.prototype as unknown as { _reset(): void; _animateZoom(e: unknown): void };
const ProjectedImageOverlay = L.ImageOverlay.extend({
  _corners: null as L.LatLng[] | null,
  setCorners(corners: L.LatLng[]) {
    this._corners = corners;
    this.setBounds(L.latLngBounds(corners));   // resets the element, which re-applies the projection
    return this;
  },
  _applyProjection() {
    const img = this._image as HTMLImageElement | undefined;
    const map = this._map as L.Map | undefined;
    const corners = this._corners as L.LatLng[] | null;
    if (!img || !map || !corners) return;
    const bounds = this._bounds as L.LatLngBounds;
    const nw = map.latLngToLayerPoint(bounds.getNorthWest());
    const size = map.latLngToLayerPoint(bounds.getSouthEast()).subtract(nw);
    const quad = corners.map(c => map.latLngToLayerPoint(c).subtract(nw));
    const box = [[0, 0], [size.x, 0], [size.x, size.y], [0, size.y]];
    const h = homographyFromPairs(box.map(([x, y], i) => ({ a: { x, y }, b: { x: quad[i].x, y: quad[i].y } })));
    img.style.transformOrigin = '0 0';
    const own = (img.style.transform || '').replace(/\s*matrix3d\([^)]*\)/, '');
    img.style.transform = h ? `${own} ${matrix3dOf(h)}` : own;
  },
  _reset() { base._reset.call(this); this._applyProjection(); },
  // During the zoom animation Leaflet sets translate + scale in the current
  // zoom's pixels; the matrix is in those same pixels, so it composes.
  _animateZoom(e: unknown) { base._animateZoom.call(this, e); this._applyProjection(); },
}) as unknown as new (url: string, bounds: L.LatLngBoundsExpression, options?: L.ImageOverlayOptions) => L.ImageOverlay & { setCorners(c: L.LatLng[]): L.ImageOverlay };
type ProjectedOverlay = InstanceType<typeof ProjectedImageOverlay>;

const toLeaflet = (c: DroneCorners) => c.map(p => L.latLng(p.lat, p.lng));

interface Props {
  url: string;
  placement: DroneOverlayPlacement;
  /** While placing: the photo is draggable and the map underneath is not. */
  editing: boolean;
  /** The corners after a drag, anchored on where the drag started. */
  onMove?: (corners: DroneCorners) => void;
  /** Point picking: every click, on the photo or beside it, as a map point. */
  onPick?: (ll: { lat: number; lng: number }) => void;
}

export function DroneOverlayLayer({ url, placement, editing, onMove, onPick }: Props) {
  const map = useMap();
  const layerRef = useRef<ProjectedOverlay | null>(null);
  const placementRef = useRef(placement);
  placementRef.current = placement;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const picking = !!onPick;

  // The layer lives as long as the URL does; placement changes adjust it in place.
  useEffect(() => {
    if (!map.getPane(PANE)) map.createPane(PANE).style.zIndex = PANE_Z;
    const layer = new ProjectedImageOverlay(url, L.latLngBounds(toLeaflet(placement.corners)), {
      pane: PANE, opacity: placement.opacity, interactive: true, className: 'drone-overlay',
    }) as ProjectedOverlay;
    layer.setCorners(toLeaflet(placement.corners));
    layer.addTo(map);
    layerRef.current = layer;
    return () => { layer.remove(); layerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, url]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.setCorners(toLeaflet(placement.corners));
    layer.setOpacity(placement.opacity);
    const el = layer.getElement();
    if (el) {
      el.style.cursor = picking ? 'crosshair' : editing ? 'move' : '';
      el.style.pointerEvents = editing ? 'auto' : 'none';
    }
  }, [placement, editing, picking]);

  // Drag to move, through Leaflet's own events so zoom and projection stay
  // consistent. Anchored on the start: the new corners are the corners at
  // mousedown plus the total mouse displacement, so a React update that has
  // not landed yet cannot swallow part of the movement. The map's own drag
  // handler is paused for the duration. Not while picking: a press is then a
  // pick, and the map pans as usual to reach the next point.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !editing || picking) return;
    let startMouse: L.LatLng | null = null;
    let startCorners: DroneCorners | null = null;
    const move = (e: L.LeafletMouseEvent) => {
      if (!startMouse || !startCorners) return;
      onMoveRef.current?.(translateCorners(startCorners, e.latlng.lat - startMouse.lat, e.latlng.lng - startMouse.lng));
    };
    const up = () => { startMouse = null; startCorners = null; map.dragging.enable(); map.off('mousemove', move); };
    const down = (e: L.LeafletMouseEvent) => {
      e.originalEvent.preventDefault();   // no native image drag or text selection
      L.DomEvent.stop(e);                 // and no map mousedown on top of ours
      startMouse = e.latlng;
      startCorners = placementRef.current.corners;
      map.dragging.disable();
      map.on('mousemove', move);
      map.once('mouseup', up);
    };
    layer.on('mousedown', down);
    return () => { layer.off('mousedown', down); map.off('mousemove', move); map.dragging.enable(); };
  }, [map, editing, picking, url]);

  // Picking points: a click on the photo and a click beside it both arrive as
  // one map point. Leaflet dispatches layer and map clicks from one container
  // listener and only stops at the map when the LEAFLET event is stopped
  // (that sets originalEvent._stopped); stopping the DOM event instead let the
  // map fire as well and every pick landed twice. Measured: a shift of exactly
  // 2x the intended distance. The zones, obstacles and markers drawn over the
  // photo let the click through meanwhile (index.css, .drone-picking); before
  // that, a click on an obstacle selected the obstacle instead of picking the
  // photo point under it.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !picking) return;
    const container = map.getContainer();
    container.classList.add('drone-picking');
    const onLayer = (e: L.LeafletMouseEvent) => { L.DomEvent.stop(e); onPickRef.current?.(e.latlng); };
    const onMap = (e: L.LeafletMouseEvent) => onPickRef.current?.(e.latlng);
    layer.on('click', onLayer);
    map.on('click', onMap);
    return () => { container.classList.remove('drone-picking'); layer.off('click', onLayer); map.off('click', onMap); };
  }, [map, picking, url]);

  return null;
}
