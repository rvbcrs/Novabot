/**
 * LiveMapView — real-time SVG trail view for mapping sessions.
 *
 * Draws a polyline of local x/y coordinates (meters, charger = 0,0)
 * on a lightweight SVG canvas. Auto-scales to fit all points.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Polyline, Circle, Line, G } from 'react-native-svg';
import { colors } from '../theme/colors';

export interface LiveMapViewProps {
  points: Array<{ x: number; y: number }>;
  orientation: number; // radians
  closed: boolean;     // if_closed_cycle
  height?: number;     // default 150
}

const PADDING_RATIO = 0.20; // 20% padding around bounding box
const ARROW_LEN = 10;       // direction arrow length in SVG units

function LiveMapViewInner({ points, orientation, closed, height = 150 }: LiveMapViewProps) {
  // Compute bounding box, scale, and projected points
  const { svgPoints, cursorX, cursorY, arrowDx, arrowDy, hasPoints } = useMemo(() => {
    if (points.length === 0) {
      return { svgPoints: '', cursorX: 0, cursorY: 0, arrowDx: 0, arrowDy: 0, hasPoints: false };
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    // Ensure minimum extent so a single point doesn't cause division by zero
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

    // SVG viewBox dimensions (fixed aspect based on height prop)
    // We use a virtual coordinate system where the longer axis fills the view.
    const viewW = 300; // virtual SVG width
    const viewH = height;
    const scale = Math.min(viewW / bW, viewH / bH);

    // Center offset
    const offsetX = (viewW - bW * scale) / 2;
    const offsetY = (viewH - bH * scale) / 2;

    // Project: x maps to SVG x, y is flipped (mower y+ = forward = SVG up)
    const project = (px: number, py: number) => ({
      sx: offsetX + (px - bMinX) * scale,
      sy: viewH - (offsetY + (py - bMinY) * scale), // flip Y
    });

    const projected = points.map(p => project(p.x, p.y));
    const svgPts = projected.map(p => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(' ');

    const last = projected[projected.length - 1];
    // Direction arrow from orientation (radians, 0 = +x, counter-clockwise)
    // In SVG flipped-Y: dx = cos(o), dy = -sin(o)
    const dx = Math.cos(orientation) * ARROW_LEN;
    const dy = -Math.sin(orientation) * ARROW_LEN;

    return {
      svgPoints: svgPts,
      cursorX: last.sx,
      cursorY: last.sy,
      arrowDx: dx,
      arrowDy: dy,
      hasPoints: true,
    };
  }, [points, orientation, height]);

  if (!hasPoints) {
    return (
      <View style={[styles.container, { height }]}>
        <Text style={styles.waitingText}>Waiting for position data...</Text>
      </View>
    );
  }

  const lineColor = closed ? colors.emerald : colors.purple;

  return (
    <View style={[styles.container, { height }]}>
      <Svg width="100%" height={height} viewBox={`0 0 300 ${height}`}>
        {/* Trail polyline */}
        <Polyline
          points={svgPoints}
          fill="none"
          stroke={lineColor}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Current position glow */}
        <Circle cx={cursorX} cy={cursorY} r={8} fill={lineColor} opacity={0.25} />
        <Circle cx={cursorX} cy={cursorY} r={5} fill={colors.white} />

        {/* Direction arrow */}
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
