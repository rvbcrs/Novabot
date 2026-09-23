/**
 * The angled 3D render as a picture with its own zoom and pan.
 *
 * It lives outside MowerMap's state on purpose: a wheel tick used to set state
 * on that whole component, and re-rendering it per tick is what made zooming
 * stutter and overshoot. Everything here goes straight to the element's
 * transform; React never hears about it.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Plus, Minus, Crosshair } from 'lucide-react';
import { keyBackdrop } from '../../utils/renderBackdrop';
import type { MowerSprite } from './mowerSprite';

/** Ground things to draw on the picture, already in render pixels. The
 *  angled render came from a camera we chose, so the caller can project. */
export interface RenderOverlay {
  width: number; height: number;
  lanes: Array<[[number, number], [number, number]]>;
  /** Planned mow path (the Coverage preview), as polylines. */
  coverage: Array<Array<[number, number]>>;
  dock: [number, number] | null;
  trail: Array<Array<[number, number]>>;
  /** `heading` is ENU radians (0 = east), for the 3D model. */
  mower: { x: number; y: number; nose: [number, number]; heading: number } | null;
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

/**
 * The model paints the plot as an island on a plain backdrop, and the panel is
 * wider than the 3:2 picture, so that backdrop showed as a box. Cut it out and
 * lay the island on a blurred copy of itself that fills the whole panel.
 * Null when the pixels can't be read; the picture then shows as it is.
 */
async function liftIsland(img: HTMLImageElement): Promise<{ fg: string; bg: string } | null> {
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g || !w || !h) return null;
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, w, h);
  const { alpha, box } = keyBackdrop(data.data, w, h);
  if (!box) return null;
  for (let i = 0; i < alpha.length; i++) data.data[i * 4 + 3] = alpha[i];
  // The backdrop blurs the island alone: blurring the whole picture brought
  // the backdrop colour back in at the sides.
  const crop = document.createElement('canvas');
  crop.width = box.w; crop.height = box.h;
  crop.getContext('2d')?.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  g.putImageData(data, 0, 0);
  const url = (cv: HTMLCanvasElement, type: string) =>
    new Promise<string | null>(res => cv.toBlob(b => res(b ? URL.createObjectURL(b) : null), type, 0.85));
  const [fg, bg] = await Promise.all([url(c, 'image/png'), url(crop, 'image/jpeg')]);
  return fg && bg ? { fg, bg } : null;
}

/** Model canvas size in render pixels (the picture is 1536 wide). */
const MOWER_PX = 72;

/**
 * The mower on the angled render: the Novabot 3D model seen from the render's
 * own camera, as in the Terrain view. The flat icon stands in while three.js and
 * the model load, and stays if WebGL is not available.
 */
function RenderMower({ x, y, nose, heading, night }: NonNullable<RenderOverlay['mower']> & { night: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [sprite, setSprite] = useState<MowerSprite | null>(null);
  useEffect(() => {
    let alive = true;
    let made: MowerSprite | null = null;
    import('./mowerSprite')
      .then(m => (canvas.current ? m.createMowerSprite(canvas.current, night) : null))
      .then(s => { made = s; if (alive) setSprite(s); else s?.dispose(); })
      .catch(() => { /* the flat icon stays */ });
    return () => { alive = false; made?.dispose(); };
  }, [night]);
  useEffect(() => { sprite?.draw(heading); }, [sprite, heading]);

  const deg = (Math.atan2(nose[1] - y, nose[0] - x) * 180) / Math.PI;
  return (
    <>
      <ellipse cx={x} cy={y + 3} rx={17} ry={11} fill="rgba(0,0,0,0.3)" />
      {!sprite && (
        <g transform={`translate(${x} ${y}) rotate(${deg})`}>
          <rect x={-16} y={-11} width={32} height={22} rx={8} fill="#ffffff" stroke="#0f172a" strokeWidth={2.5} />
          <rect x={-4} y={-7} width={14} height={14} rx={3} fill="#10b981" />
          <path d="M16 -6 L25 0 L16 6 Z" fill="#0f172a" />
        </g>
      )}
      <foreignObject x={x - MOWER_PX / 2} y={y - MOWER_PX / 2} width={MOWER_PX} height={MOWER_PX}>
        <canvas ref={canvas} width={256} height={256} style={{ width: '100%', height: '100%', display: 'block' }} />
      </foreignObject>
    </>
  );
}

const BTN = 'w-8 h-8 rounded-lg bg-gray-900/85 border border-gray-700 text-gray-200 hover:bg-gray-800 flex items-center justify-center';

export function RenderPicture({ src, alt, night, fitTitle, overlay, children }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLDivElement>(null);
  const view = useRef({ zoom: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [lifted, setLifted] = useState<{ fg: string; bg: string } | null>(null);
  useEffect(() => () => { if (lifted) { URL.revokeObjectURL(lifted.fg); URL.revokeObjectURL(lifted.bg); } }, [lifted]);

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
      {lifted && (
        <img src={lifted.bg} alt="" aria-hidden draggable={false}
          className="absolute inset-0 w-full h-full object-cover scale-110 blur-2xl pointer-events-none" />
      )}
      {/* A veil over the blur: darker at night, lighter by day, so the island stands out. */}
      {lifted && <div className={`absolute inset-0 pointer-events-none ${night ? 'bg-black/35' : 'bg-white/35'}`} />}
      {/* Image and overlay share one box and one transform. Both are 3:2 and
          both centre in it (object-contain / xMidYMid meet), so the SVG's
          viewBox lands exactly on the picture's pixels. */}
      <div ref={img} className="relative w-full h-full flex items-center justify-center will-change-transform">
        <img src={lifted?.fg ?? src} alt={alt} draggable={false} className="max-h-full max-w-full object-contain"
          onLoad={e => { if (!lifted) void liftIsland(e.currentTarget).then(setLifted).catch(() => {}); }} />
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
            {overlay.mower && <RenderMower {...overlay.mower} night={night} />}
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
