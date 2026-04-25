/**
 * LiveMapView — real-time SVG trail view for mapping sessions.
 *
 * Draws a polyline of local x/y coordinates (meters, charger = 0,0)
 * on a lightweight SVG canvas. Auto-scales to fit all points.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Polyline, Polygon, Circle, Line, G, Image as SvgImage, Text as SvgText, Rect } from 'react-native-svg';
import { useStyles, useTheme, type Colors } from '../theme';

export interface ExistingMapOverlay {
  mapId: string;
  mapType: string; // 'work' | 'obstacle' | 'unicom'
  points: Array<{ x: number; y: number }>;
}

export interface LiveMapViewProps {
  points: Array<{ x: number; y: number }>;
  orientation: number; // radians
  closed: boolean;     // if_closed_cycle
  height?: number;     // default 150
  width?: number;      // explicit width; defaults to flex/stretch
  existingMaps?: ExistingMapOverlay[];
  mowerPosition?: { x: number; y: number } | null; // show mower marker (separate from trail)
}

const PADDING_RATIO = 0.20; // 20% padding around bounding box
const ARROW_LEN = 10;       // direction arrow length in SVG units

function LiveMapViewInner({ points, orientation, closed, height = 150, width, existingMaps = [], mowerPosition }: LiveMapViewProps) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();

  // Compute bounding box (including existing maps + mower position), scale, and projected points.
  // Also computes a closing-distance label matching the Novabot app: straight-line distance
  // between trail[0] and trail[last], rendered at the midpoint (e.g. "3.5 m"). Novabot uses this
  // to show the user how far they still need to drive to close the loop.
  // Verified from blutter decompile: build_map_painter.dart @ 0xa2187c (distanceTo + "m" label
  // at centerPoint of first/last trail points).
  const { svgPoints, cursorX, cursorY, arrowDx, arrowDy, hasPoints, existingSvg, mowerSvg, closingLabel } = useMemo(() => {
    const allPoints = [...points];
    for (const m of existingMaps) allPoints.push(...m.points);
    if (mowerPosition) allPoints.push(mowerPosition);

    if (allPoints.length === 0) {
      return { svgPoints: '', cursorX: 0, cursorY: 0, arrowDx: 0, arrowDy: 0, hasPoints: false, existingSvg: [], closingLabel: null };
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of allPoints) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const rangeX = Math.max(maxX - minX, 0.5);
    const rangeY = Math.max(maxY - minY, 0.5);

    const padX = rangeX * PADDING_RATIO;
    const padY = rangeY * PADDING_RATIO;
    const bMinX = minX - padX;
    const bMaxX = maxX + padX;
    const bMinY = minY - padY;
    const bMaxY = maxY + padY;

    const bW = bMaxX - bMinX;
    const bH = bMaxY - bMinY;

    const viewW = 300;
    const viewH = height;
    const scale = Math.min(viewW / bW, viewH / bH);

    const offsetX = (viewW - bW * scale) / 2;
    const offsetY = (viewH - bH * scale) / 2;

    const project = (px: number, py: number) => ({
      sx: offsetX + (px - bMinX) * scale,
      sy: viewH - (offsetY + (py - bMinY) * scale),
    });

    // Project existing maps
    const existProj = existingMaps.map(m => ({
      mapId: m.mapId,
      mapType: m.mapType,
      svgPoints: m.points.map(p => project(p.x, p.y)).map(p => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(' '),
    }));

    // Project current trail
    const projected = points.map(p => project(p.x, p.y));
    const svgPts = projected.length > 0
      ? projected.map(p => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(' ')
      : '';

    const last = projected.length > 0 ? projected[projected.length - 1] : { sx: 0, sy: 0 };
    const dx = Math.cos(orientation) * ARROW_LEN;
    const dy = -Math.sin(orientation) * ARROW_LEN;

    // Project mower position
    const mowerProj = mowerPosition ? project(mowerPosition.x, mowerPosition.y) : null;

    // Closing-distance label: straight-line distance (in meters) between first and last trail
    // points, rendered at their midpoint. Matches Novabot's live loop-closure helper.
    let closing: { text: string; sx: number; sy: number } | null = null;
    if (points.length >= 2) {
      const first = points[0];
      const lastPt = points[points.length - 1];
      const dxM = first.x - lastPt.x;
      const dyM = first.y - lastPt.y;
      const distM = Math.sqrt(dxM * dxM + dyM * dyM);
      const firstProj = project(first.x, first.y);
      const lastProj = projected[projected.length - 1];
      closing = {
        text: `${distM.toFixed(1)} m`,
        sx: (firstProj.sx + lastProj.sx) / 2,
        sy: (firstProj.sy + lastProj.sy) / 2,
      };
    }

    return {
      svgPoints: svgPts,
      cursorX: last.sx,
      cursorY: last.sy,
      arrowDx: dx,
      arrowDy: dy,
      hasPoints: points.length > 0 || existingMaps.length > 0 || mowerPosition != null,
      existingSvg: existProj,
      mowerSvg: mowerProj,
      closingLabel: closing,
    };
  }, [points, orientation, height, existingMaps, mowerPosition]);

  const containerStyle = [
    styles.container,
    { height },
    width != null ? { width } : { alignSelf: 'stretch' as const },
  ];

  if (!hasPoints) {
    return (
      <View style={containerStyle}>
        <Text style={styles.waitingText}>Waiting for position data...</Text>
      </View>
    );
  }

  const hasTrail = points.length > 0;

  const lineColor = closed ? colors.emerald : colors.purple;

  return (
    <View style={containerStyle}>
      <Svg width="100%" height={height} viewBox={`0 0 300 ${height}`}>
        {/* Existing maps (greyed-out background) */}
        {existingSvg.map(m => {
          const isObstacle = m.mapType === 'obstacle';
          return (
            <Polygon
              key={m.mapId}
              points={m.svgPoints}
              fill={isObstacle ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.06)'}
              stroke={isObstacle ? 'rgba(239,68,68,0.3)' : 'rgba(255,255,255,0.2)'}
              strokeWidth={1.5}
              strokeDasharray={isObstacle ? '4 3' : undefined}
            />
          );
        })}

        {/* Current mapping trail */}
        {svgPoints.length > 0 && (
          <Polyline
            points={svgPoints}
            fill="none"
            stroke={lineColor}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Current position glow (trail mode, no mowerPosition) */}
        {hasTrail && !mowerSvg && (
          <>
            <Circle cx={cursorX} cy={cursorY} r={8} fill={lineColor} opacity={0.25} />
            <Circle cx={cursorX} cy={cursorY} r={5} fill={colors.white} />
            <G opacity={0.9}>
              <Line
                x1={cursorX}
                y1={cursorY}
                x2={cursorX + arrowDx}
                y2={cursorY + arrowDy}
                stroke={colors.white}
                strokeWidth={2}
                strokeLinecap="round"
              />
            </G>
          </>
        )}

        {/* Mower icon (standalone marker or at end of trail). Icon's "front" faces LEFT
            in the source PNG, so we use `-heading` with no 180° offset — matches the
            MapScreen convention. */}
        {mowerSvg && (() => {
          const mx = hasTrail ? cursorX : mowerSvg.sx;
          const my = hasTrail ? cursorY : mowerSvg.sy;
          const degHeading = -(orientation * 180 / Math.PI);
          const mowerSize = 20;
          return (
            <G transform={`translate(${mx}, ${my}) rotate(${degHeading})`}>
              <SvgImage
                x={-mowerSize / 2}
                y={-mowerSize * 0.35}
                width={mowerSize}
                height={mowerSize * 0.68}
                href={require('../../assets/lawn_mower.png')}
              />
            </G>
          );
        })()}

        {/* Closing distance label — rendered LAST so it sits on top of both trail and
            mower icon. If the midpoint is too close to the mower (end of trail) we nudge
            the label perpendicular to the first→last line so it stays readable. */}
        {closingLabel && (() => {
          const labelW = Math.max(closingLabel.text.length * 5.2 + 10, 32);
          const labelH = 15;
          // Nudge the label away from the mower icon (at trail's last point).
          // Perpendicular offset so the label sits on the "outside" of the chord.
          const dxToLast = cursorX - closingLabel.sx;
          const dyToLast = cursorY - closingLabel.sy;
          const distLast = Math.sqrt(dxToLast * dxToLast + dyToLast * dyToLast);
          const nudge = distLast < 16 ? 14 : 0;
          // Perpendicular vector (rotated 90°): (-dy, dx) normalized
          const perpLen = Math.sqrt(dxToLast * dxToLast + dyToLast * dyToLast) || 1;
          const px = closingLabel.sx + (-dyToLast / perpLen) * nudge;
          const py = closingLabel.sy + (dxToLast / perpLen) * nudge;
          return (
            <G>
              <Rect
                x={px - labelW / 2}
                y={py - labelH / 2}
                width={labelW}
                height={labelH}
                rx={3}
                fill="rgba(0,0,0,0.8)"
                stroke={colors.white}
                strokeWidth={0.5}
                strokeOpacity={0.3}
              />
              <SvgText
                x={px}
                y={py + 3.8}
                fontSize="10"
                fontWeight="700"
                fill={colors.white}
                textAnchor="middle"
              >
                {closingLabel.text}
              </SvgText>
            </G>
          );
        })()}
      </Svg>

      {/* Point count label */}
      <Text style={styles.pointCount}>{points.length} pts</Text>
    </View>
  );
}

// Memoize: only rerender when props actually change
export const LiveMapView = React.memo(LiveMapViewInner);

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {
    backgroundColor: c.card,
    borderRadius: 12,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: c.cardBorder,
  },
  waitingText: {
    color: c.textMuted,
    fontSize: 13,
    fontStyle: 'italic',
  },
  pointCount: {
    position: 'absolute',
    bottom: 4,
    right: 8,
    color: c.textMuted,
    fontSize: 10,
  },
});
