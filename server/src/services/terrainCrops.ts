import sharp from 'sharp';

export interface ClusterPoint { cx: number; cy: number }
export interface Pose { x: number; y: number; yaw: number }
export interface CropBox { left: number; top: number; width: number; height: number }

const MAX_ANGLE = 0.6; // rad, ≈ 35°
const MIN_DIST = 0.3; // m
const MAX_DIST = 4; // m
const FOV = 1.2; // rad, breedte gebruikt voor horizontale mapping

/** Normaliseert een hoek naar (−π, π]. */
function normalizeAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Score voor hoe geschikt een frame is om dit cluster te fotograferen.
 * Lager = beter. `null` als cluster buiten blikveld valt (|hoek| > 0.6 rad)
 * of afstand buiten [0.3, 4] m.
 */
export function scoreFrame(cluster: ClusterPoint, pose: Pose): number | null {
  const dx = cluster.cx - pose.x;
  const dy = cluster.cy - pose.y;
  const dist = Math.hypot(dx, dy);
  const angle = normalizeAngle(Math.atan2(dy, dx) - pose.yaw);
  if (Math.abs(angle) > MAX_ANGLE) return null;
  if (dist < MIN_DIST || dist > MAX_DIST) return null;
  return Math.abs(angle) + dist * 0.1;
}

/**
 * Bepaalt de (ongeclipte richting) ruwe crop-box voor een cluster in een frame
 * van imgW × imgH pixels. Geen sharp hier — pure wiskunde.
 */
export function cropBox(cluster: ClusterPoint, pose: Pose, imgW: number, imgH: number): CropBox {
  const dx = cluster.cx - pose.x;
  const dy = cluster.cy - pose.y;
  const dist = Math.hypot(dx, dy);
  const angle = normalizeAngle(Math.atan2(dy, dx) - pose.yaw);

  const u = 0.5 - angle / FOV;
  const rawSide = clamp((imgW * 0.9) / Math.max(dist, 1e-6), imgW * 0.25, imgW * 0.9);
  const side = Math.round(Math.min(imgH, imgW, rawSide));

  const cxPx = u * imgW;
  const cyPx = 0.55 * imgH;

  let left = cxPx - side / 2;
  let top = cyPx - side / 2;

  left = clamp(left, 0, Math.max(0, imgW - side));
  top = clamp(top, 0, Math.max(0, imgH - side));

  return { left: Math.round(left), top: Math.round(top), width: side, height: side };
}

/** Snijdt `box` uit het JPEG op `jpegPath` en retourneert een JPEG-buffer. */
export async function cropFrame(jpegPath: string, box: CropBox): Promise<Buffer> {
  return sharp(jpegPath)
    .extract({
      left: Math.round(box.left),
      top: Math.round(box.top),
      width: Math.round(box.width),
      height: Math.round(box.height),
    })
    .jpeg()
    .toBuffer();
}
