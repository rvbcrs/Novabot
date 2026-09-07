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
