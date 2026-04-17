/**
 * LiveMapView — real-time SVG trail view for mapping sessions.
 *
 * Draws a polyline of local x/y coordinates (meters, charger = 0,0)
 * on a lightweight SVG canvas. Auto-scales to fit all points.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Polyline, Polygon, Circle, Line, G } from 'react-native-svg';
import { colors } from '../theme/colors';

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
  existingMaps?: ExistingMapOverlay[];
  mowerPosition?: { x: number; y: number } | null; // show mower marker (separate from trail)
}

const PADDING_RATIO = 0.20; // 20% padding around bounding box
const ARROW_LEN = 10;       // direction arrow length in SVG units

function LiveMapViewInner({ points, orientation, closed, height = 150, existingMaps = [], mowerPosition }: LiveMapViewProps) {
  // Compute bounding box (including existing maps + mower position), scale, and projected points
  const { svgPoints, cursorX, cursorY, arrowDx, arrowDy, hasPoints, existingSvg, mowerSvg } = useMemo(() => {
    const allPoints = [...points];
    for (const m of existingMaps) allPoints.push(...m.points);
    if (mowerPosition) allPoints.push(mowerPosition);

    if (allPoints.length === 0) {
      return { svgPoints: '', cursorX: 0, cursorY: 0, arrowDx: 0, arrowDy: 0, hasPoints: false, existingSvg: [] };
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

    return {
      svgPoints: svgPts,
      cursorX: last.sx,
      cursorY: last.sy,
      arrowDx: dx,
      arrowDy: dy,
      hasPoints: points.length > 0 || existingMaps.length > 0 || mowerPosition != null,
      existingSvg: existProj,
      mowerSvg: mowerProj,
    };
  }, [points, orientation, height, existingMaps, mowerPosition]);

  if (!hasPoints) {
    return (
      <View style={[styles.container, { height }]}>
        <Text style={styles.waitingText}>Waiting for position data...</Text>
      </View>
    );
  }

  const hasTrail = points.length > 0;

  const lineColor = closed ? colors.emerald : colors.purple;

  return (
    <View style={[styles.container, { height }]}>
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

        {/* Current position glow + direction arrow (trail mode) */}
        {hasTrail && (
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

        {/* Mower position marker (standalone, when no trail) */}
        {!hasTrail && mowerSvg && (
          <>
            <Circle cx={mowerSvg.sx} cy={mowerSvg.sy} r={10} fill={colors.emerald} opacity={0.25} />
            <Circle cx={mowerSvg.sx} cy={mowerSvg.sy} r={6} fill={colors.emerald} />
            <G opacity={0.9}>
              <Line
                x1={mowerSvg.sx}
                y1={mowerSvg.sy}
                x2={mowerSvg.sx + arrowDx}
                y2={mowerSvg.sy + arrowDy}
                stroke={colors.emerald}
                strokeWidth={2}
                strokeLinecap="round"
              />
            </G>
          </>
        )}
      </Svg>

      {/* Point count label */}
      <Text style={styles.pointCount}>{points.length} pts</Text>
    </View>
  );
}

// Memoize: only rerender when props actually change
export const LiveMapView = React.memo(LiveMapViewInner);

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.card,
    borderRadius: 12,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  waitingText: {
    color: colors.textMuted,
    fontSize: 13,
    fontStyle: 'italic',
  },
  pointCount: {
    position: 'absolute',
    bottom: 4,
    right: 8,
    color: colors.textMuted,
    fontSize: 10,
  },
});
