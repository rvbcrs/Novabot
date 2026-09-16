/** A current position outranks the last trail sample, which may be delayed. */
export function liveMapMarkerPosition(
  trailEnd: { sx: number; sy: number },
  current?: { sx: number; sy: number } | null,
): { sx: number; sy: number } {
  return current ?? trailEnd;
}

/** Keep the closing-distance label outside the mower marker, even at a closed loop. */
export function placeClosingLabel(
  midpoint: { sx: number; sy: number },
  marker: { sx: number; sy: number },
  labelWidth: number, markerRadius: number, viewHeight: number,
): { sx: number; sy: number } {
  const halfHeight = 7.5;
  const sx = Math.max(labelWidth / 2, Math.min(300 - labelWidth / 2, midpoint.sx));
  let sy = Math.max(halfHeight, Math.min(viewHeight - halfHeight, midpoint.sy));
  if (Math.abs(sx - marker.sx) < labelWidth / 2 + markerRadius
      && Math.abs(sy - marker.sy) < halfHeight + markerRadius) {
    const above = marker.sy - markerRadius - halfHeight - 4;
    sy = above >= halfHeight ? above : marker.sy + markerRadius + halfHeight + 4;
  }
  return { sx, sy };
}

export interface MapWindow { minX: number; minY: number; width: number; height: number }

/**
 * The patch of ground the live map draws.
 *
 * Fitting every existing zone plus the new trail is the right thing when you
 * want an overview, but while driving a boundary it shrinks the new trail to a
 * few pixels and you cannot tell how close you are to the neighbouring edge
 * (issue #116). Given a radius it returns a window of that many metres across,
 * centred on the mower and stretched to the canvas aspect so a metre across is
 * a metre down. Without a radius, or without a mower to centre on, it returns
 * the bounds it was given.
 */
export function mapWindow(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  canvas: { width: number; height: number },
  mower: { x: number; y: number } | null,
  radiusM: number | null,
): MapWindow {
  const fit = {
    minX: bounds.minX, minY: bounds.minY,
    width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY,
  };
  if (!radiusM || radiusM <= 0 || !mower) return fit;
  const aspect = canvas.width / Math.max(canvas.height, 1);
  const halfW = (radiusM / 2) * (aspect >= 1 ? aspect : 1);
  const halfH = (radiusM / 2) * (aspect >= 1 ? 1 : 1 / aspect);
  return { minX: mower.x - halfW, minY: mower.y - halfH, width: halfW * 2, height: halfH * 2 };
}
