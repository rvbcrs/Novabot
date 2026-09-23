/**
 * The angled 3D render as a picture with its own zoom and pan.
 *
 * It lives outside MowerMap's state on purpose: a wheel tick used to set state
 * on that whole component, and re-rendering it per tick is what made zooming
 * stutter and overshoot. Everything here goes straight to the element's
 * transform; React never hears about it.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Plus, Minus, Crosshair } from 'lucide-react';

/** Ground things to draw on the picture, already in render pixels. The
 *  angled render came from a camera we chose, so the caller can project. */
export interface RenderOverlay {
  width: number; height: number;
  lanes: Array<[[number, number], [number, number]]>;
  /** Planned mow path (the Coverage preview), as polylines. */
  coverage: Array<Array<[number, number]>>;
  dock: [number, number] | null;
  trail: Array<Array<[number, number]>>;
  mower: { x: number; y: number; nose: [number, number] } | null;
}

interface Props {
  src: string;
  alt: string;
  /** Matches the render's own backdrop, so a portrait screen gets a matching border. */
  night: boolean;
  fitTitle: string;
  overlay?: RenderOverlay;
  children?: ReactNode;
}

const BTN = 'w-8 h-8 rounded-lg bg-gray-900/85 border border-gray-700 text-gray-200 hover:bg-gray-800 flex items-center justify-center';

export function RenderPicture({ src, alt, night, fitTitle, overlay, children }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLDivElement>(null);
  const view = useRef({ zoom: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const apply = () => {
    const v = view.current;
    if (img.current) img.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
    if (box.current) box.current.style.cursor = v.zoom > 1 ? (drag.current ? 'grabbing' : 'grab') : 'default';
  };
  /** Scale by `f` around a point given relative to the centre. */
  const zoomBy = (f: number, cx = 0, cy = 0) => {
    const v = view.current;
    const next = Math.min(8, Math.max(1, v.zoom * f));
    v.x = cx - ((cx - v.x) * next) / v.zoom;
    v.y = cy - ((cy - v.y) * next) / v.zoom;
    v.zoom = next;
    if (next === 1) { v.x = 0; v.y = 0; }
    apply();
  };
  const reset = () => { view.current = { zoom: 1, x: 0, y: 0 }; apply(); };

  // React registers wheel listeners as passive, so keeping the page from
  // scrolling under the picture needs a native, non-passive one.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div
      ref={box}
      className="absolute inset-0 z-[800] overflow-hidden flex items-center justify-center select-none"
      style={{ background: night ? '#0f1826' : '#eceff1' }}
      onDoubleClick={reset}
      onPointerDown={e => {
        if (view.current.zoom <= 1) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, px: view.current.x, py: view.current.y };
        apply();
      }}
      onPointerMove={e => {
        const d = drag.current;
        if (!d) return;
        view.current.x = d.px + (e.clientX - d.x);
        view.current.y = d.py + (e.clientY - d.y);
        apply();
      }}
      onPointerUp={() => { drag.current = null; apply(); }}
      onPointerCancel={() => { drag.current = null; apply(); }}
    >
      {/* Image and overlay share one box and one transform. Both are 3:2 and
          both centre in it (object-contain / xMidYMid meet), so the SVG's
          viewBox lands exactly on the picture's pixels. */}
      <div ref={img} className="relative w-full h-full flex items-center justify-center will-change-transform">
        <img src={src} alt={alt} draggable={false} className="max-h-full max-w-full object-contain" />
        {overlay && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${overlay.width} ${overlay.height}`} preserveAspectRatio="xMidYMid meet">
            {overlay.coverage.map((seg, i) => (
              <polyline key={`c${i}`} points={seg.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}
                fill="none" stroke="rgba(96,165,250,0.9)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {overlay.lanes.map(([a, b], i) => (
              <line key={`l${i}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="rgba(34,197,94,0.85)" strokeWidth={6} strokeLinecap="round" />
            ))}
            {overlay.trail.map((seg, i) => (
              <polyline key={`t${i}`} points={seg.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}
                fill="none" stroke="#38bdf8" strokeWidth={3.5} strokeOpacity={0.9} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {/* Dock: the map's orange charger pin, standing on its spot. */}
            {overlay.dock && (
              <g transform={`translate(${overlay.dock[0]} ${overlay.dock[1]})`}>
                <path d="M0 0 L-9 -14 A14 14 0 1 1 9 -14 Z" fill="#f59e0b" stroke="#ffffff" strokeWidth={2.5} />
                <path d="M2 -33 L-5 -21 L0 -21 L-2 -12 L6 -25 L1 -25 Z" fill="#ffffff" />
              </g>
            )}
            {/* Mower: body pointing along its heading, like the map icon. */}
            {overlay.mower && (() => {
              const { x, y, nose } = overlay.mower;
              const deg = (Math.atan2(nose[1] - y, nose[0] - x) * 180) / Math.PI;
              return (
                <g transform={`translate(${x} ${y}) rotate(${deg})`}>
                  <ellipse cx={0} cy={3} rx={17} ry={12} fill="rgba(0,0,0,0.25)" />
                  <rect x={-16} y={-11} width={32} height={22} rx={8} fill="#ffffff" stroke="#0f172a" strokeWidth={2.5} />
                  <rect x={-4} y={-7} width={14} height={14} rx={3} fill="#10b981" />
                  <path d="M16 -6 L25 0 L16 6 Z" fill="#0f172a" />
                </g>
              );
            })()}
          </svg>
        )}
      </div>
      {/* Zoom controls, mirroring Leaflet's so the two views feel alike. */}
      <div className="absolute top-3 right-3 flex flex-col gap-1">
        <button onClick={() => zoomBy(1.3)} className={BTN}><Plus className="w-4 h-4" /></button>
        <button onClick={() => zoomBy(1 / 1.3)} className={BTN}><Minus className="w-4 h-4" /></button>
        <button onClick={reset} title={fitTitle} className={BTN}><Crosshair className="w-4 h-4" /></button>
      </div>
      {children}
    </div>
  );
}
