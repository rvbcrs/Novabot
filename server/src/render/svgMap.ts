/**
 * Server-side SVG renderer for the mower map.
 *
 * Pure-string output, no DOM/canvas/sharp deps — keeps the server image
 * Mac-buildable. The same shapes the React Native MapScreen renders
 * client-side end up here so HA's image entity gets a self-contained,
 * MQTT-discoverable visualisation without any custom Lovelace card.
 *
 * Coordinates: local-meters relative to the charger at (0,0). Y axis
 * is flipped on render (positive Y up in mower frame, positive Y down
 * in SVG) and we add 8 % padding around the bounding box of every
 * input shape.
 */
import { mapRepo } from '../db/repositories/maps.js';
import { deviceCache, getLocalTrail, translateValue } from '../mqtt/sensorData.js';

interface Pt { x: number; y: number }

interface MapPoly {
  id: string;
  type: 'work' | 'obstacle' | 'unicom';
  name: string;
  pts: Pt[];
}

const SVG_W = 600;
const SVG_H = 600;
const PADDING_RATIO = 0.08;

function parsePolygon(json: string | null): Pt[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p): p is Pt =>
        typeof p === 'object' && p !== null
        && Number.isFinite((p as Pt).x) && Number.isFinite((p as Pt).y))
      .map(p => ({ x: p.x, y: p.y }));
  } catch {
    return [];
  }
}

function readMaps(sn: string): MapPoly[] {
  const rows = mapRepo.findWithArea(sn);
  return rows
    .map(r => ({
      id: r.map_id,
      type: (r.map_type === 'work' || r.map_type === 'obstacle' || r.map_type === 'unicom')
        ? r.map_type
        : 'work',
      name: r.canonical_name ?? r.map_name ?? r.map_id,
      pts: parsePolygon(r.map_area),
    }) as MapPoly)
    .filter(m => m.pts.length >= 2);
}

function readMowerPose(sn: string): { pose: Pt | null; theta: number } {
  const cache = deviceCache.get(sn);
  if (!cache) return { pose: null, theta: 0 };
  const x = parseFloat(cache.get('map_position_x') ?? '');
  const y = parseFloat(cache.get('map_position_y') ?? '');
  const theta = parseFloat(cache.get('map_position_orientation') ?? '0') || 0;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { pose: null, theta };
  return { pose: { x, y }, theta };
}

// Read work_status + recharge_status as user-facing text so an overlay can
// always show what the mower is doing — useful when no work polygon exists
// yet (e.g. fresh setup, after map delete) and the canvas would otherwise
// look empty.
function readStatusBadge(sn: string): string | null {
  const cache = deviceCache.get(sn);
  if (!cache) return null;
  const ws = cache.get('work_status');
  const rs = cache.get('recharge_status');
  const battery = cache.get('battery_capacity');
  const parts: string[] = [];
  if (ws) parts.push(translateValue('work_status', ws));
  if (rs && parseInt(rs, 10) > 0) parts.push(translateValue('recharge_status', rs));
  if (battery) parts.push(`${battery}%`);
  return parts.length ? parts.join(' • ') : null;
}

function readProgressLabel(sn: string): string | null {
  const cache = deviceCache.get(sn);
  if (!cache) return null;
  const ratio = parseFloat(cache.get('cov_ratio') ?? '');
  const area = parseFloat(cache.get('cov_area') ?? '');
  if (!Number.isFinite(ratio) && !Number.isFinite(area)) return null;
  const pct = Number.isFinite(ratio)
    ? `${(ratio <= 1 ? Math.round(ratio * 100) : Math.round(ratio))}%`
    : '';
  const m2 = Number.isFinite(area) ? `${area.toFixed(1)} m²` : '';
  return [pct, m2].filter(Boolean).join(' • ') || null;
}

function computeBounds(parts: Pt[][]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const arr of parts) {
    for (const p of arr) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) {
    // No data — show a 4 m × 4 m frame around the charger so the SVG
    // still has scale and the charger marker stays visible.
    minX = -2; maxX = 2; minY = -2; maxY = 2;
  }
  // Square out so meters per pixel matches on both axes.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const half = Math.max(maxX - minX, maxY - minY, 2) / 2;
  const padded = half * (1 + PADDING_RATIO);
  return { minX: cx - padded, maxX: cx + padded, minY: cy - padded, maxY: cy + padded };
}

function makeProjector(b: { minX: number; maxX: number; minY: number; maxY: number }): (p: Pt) => Pt {
  const sx = SVG_W / (b.maxX - b.minX);
  const sy = SVG_H / (b.maxY - b.minY);
  // Flip Y — mower frame is Y-up, SVG is Y-down.
  return (p: Pt) => ({
    x: (p.x - b.minX) * sx,
    y: SVG_H - (p.y - b.minY) * sy,
  });
}

function polyAttr(pts: Pt[], project: (p: Pt) => Pt): string {
  return pts.map(p => {
    const q = project(p);
    return `${q.x.toFixed(2)},${q.y.toFixed(2)}`;
  }).join(' ');
}

const STYLE = `
  .work-fill { fill: rgba(34,197,94,0.18); stroke: #22c55e; stroke-width: 2; stroke-linejoin: round; }
  .obstacle-fill { fill: rgba(239,68,68,0.20); stroke: #ef4444; stroke-width: 2; stroke-dasharray: 6 4; stroke-linejoin: round; }
  .unicom-fill { fill: none; stroke: #3b82f6; stroke-width: 2; stroke-dasharray: 4 3; }
  .trail { fill: none; stroke: rgba(34,197,94,0.7); stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; }
  .charger-base { fill: rgba(245,158,11,0.25); stroke: #f59e0b; stroke-width: 2; }
  .charger-bolt { fill: #f59e0b; }
  .mower { fill: #ffffff; stroke: #0f172a; stroke-width: 1.5; }
  .mower-arrow { stroke: #0f172a; stroke-width: 2; stroke-linecap: round; fill: none; }
  .label { font-family: -apple-system, Roboto, sans-serif; font-size: 11px; fill: #0f172a; }
  .badge { font-family: -apple-system, Roboto, sans-serif; font-size: 13px; font-weight: 600; fill: #ffffff; }
  .bg { fill: #f8fafc; }
`;

/**
 * Render the mower map for `sn` as a self-contained SVG. The output is
 * deterministic given the same inputs — useful for HA cache busting via
 * a `?ts=...` query parameter.
 */
export function renderMowerMapSvg(sn: string): string {
  const maps = readMaps(sn);
  const trail = getLocalTrail(sn).map(p => ({ x: p.x, y: p.y }));
  const { pose, theta } = readMowerPose(sn);
  const charger: Pt = { x: 0, y: 0 };

  const allPts: Pt[][] = [];
  for (const m of maps) allPts.push(m.pts);
  allPts.push(trail);
  allPts.push([charger]);
  if (pose) allPts.push([pose]);

  const bounds = computeBounds(allPts);
  const project = makeProjector(bounds);

  const polys = maps.map(m => {
    const cls = m.type === 'work' ? 'work-fill'
              : m.type === 'obstacle' ? 'obstacle-fill'
              : 'unicom-fill';
    const points = polyAttr(m.pts, project);
    if (m.type === 'unicom') {
      // unicom = open polyline (channel between two work maps)
      return `<polyline class="${cls}" points="${points}" />`;
    }
    return `<polygon class="${cls}" points="${points}" />`;
  }).join('\n');

  const trailSvg = trail.length >= 2
    ? `<polyline class="trail" points="${polyAttr(trail, project)}" />`
    : '';

  const cp = project(charger);
  const chargerSvg = `
    <g>
      <circle class="charger-base" cx="${cp.x.toFixed(2)}" cy="${cp.y.toFixed(2)}" r="12" />
      <path class="charger-bolt"
            d="M${cp.x - 3} ${cp.y - 5} L${cp.x + 3} ${cp.y - 5}
               L${cp.x + 1} ${cp.y} L${cp.x + 4} ${cp.y}
               L${cp.x - 1} ${cp.y + 6} L${cp.x} ${cp.y + 1}
               L${cp.x - 3} ${cp.y + 1} Z" />
    </g>`;

  let mowerSvg = '';
  if (pose) {
    const mp = project(pose);
    // Heading arrow length ≈ 18px; add 180° because Y is flipped on render.
    const headingDeg = -(theta * 180 / Math.PI) + 180;
    mowerSvg = `
      <g transform="translate(${mp.x.toFixed(2)},${mp.y.toFixed(2)}) rotate(${headingDeg.toFixed(1)})">
        <circle class="mower" r="7" />
        <line class="mower-arrow" x1="0" y1="0" x2="14" y2="0" />
      </g>`;
  }

  const progress = readProgressLabel(sn);
  const badge = progress
    ? `<g>
         <rect x="12" y="${SVG_H - 32}" width="${Math.max(80, progress.length * 8)}" height="22" rx="4" fill="#0f172a" opacity="0.78" />
         <text class="badge" x="20" y="${SVG_H - 17}">${progress}</text>
       </g>`
    : '';

  const titleLabel = `<text class="label" x="12" y="20">Mower ${sn}</text>`;

  // Status badge — always visible, top-right. Shows work-status text +
  // recharge state + battery so the picture-entity is never empty even when
  // no work map / trail / mower-pose data is available.
  const status = readStatusBadge(sn);
  const statusBadge = status
    ? `<g>
         <rect x="${SVG_W - Math.max(120, status.length * 7) - 12}" y="10"
               width="${Math.max(120, status.length * 7)}" height="22" rx="4"
               fill="#0f172a" opacity="0.78" />
         <text class="badge" x="${SVG_W - Math.max(120, status.length * 7) - 4}" y="25"
               text-anchor="end">${status}</text>
       </g>`
    : '';

  // No-data overlay — full-canvas hint when there's nothing to draw (no
  // work polygon, no trail, no mower pose). Mirrors the picture-entity
  // overlay UX the user asked for.
  const hasContent = maps.length > 0 || trail.length > 0 || pose;
  const emptyOverlay = !hasContent
    ? `<g>
         <rect x="${SVG_W / 2 - 130}" y="${SVG_H / 2 - 30}" width="260" height="60"
               rx="8" fill="#0f172a" opacity="0.82" />
         <text class="badge" x="${SVG_W / 2}" y="${SVG_H / 2 - 8}" text-anchor="middle">No work map yet</text>
         <text class="label" x="${SVG_W / 2}" y="${SVG_H / 2 + 14}" text-anchor="middle"
               style="fill:#cbd5e1">Start mapping in the OpenNova app</text>
       </g>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_W} ${SVG_H}" width="${SVG_W}" height="${SVG_H}">
  <style>${STYLE}</style>
  <rect class="bg" x="0" y="0" width="${SVG_W}" height="${SVG_H}" />
  ${polys}
  ${trailSvg}
  ${chargerSvg}
  ${mowerSvg}
  ${badge}
  ${titleLabel}
  ${statusBadge}
  ${emptyOverlay}
</svg>`;
}
