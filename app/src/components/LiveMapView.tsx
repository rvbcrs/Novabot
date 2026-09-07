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
import { isMapPoint, normalizeMapPoints } from '../utils/mapPoints';
import { placeClosingLabel } from '../utils/liveMapLayout';
import { MOWER_MAP_IMAGE } from './mower/mowerMapImage';

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
const ARROW_LEN = 20;       // direction arrow length in SVG units

function LiveMapViewInner({ points, orientation, closed, height = 150, width, existingMaps = [], mowerPosition }: LiveMapViewProps) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();

  // Compute bounding box (including existing maps + mower position), scale, and projected points.
  // Also computes a closing-distance label matching the Novabot app: straight-line distance
  // between trail[0] and trail[last], rendered at the midpoint (e.g. "3.5 m"). Novabot uses this
  // to show the user how far they still need to drive to close the loop.
  // Verified from blutter decompile: build_map_painter.dart @ 0xa2187c (distanceTo + "m" label
  // at centerPoint of first/last trail points).
  const { svgPoints, cursorX, cursorY, arrowDx, arrowDy, hasPoints, existingSvg, mowerSvg, closingLabel, pointCount } = useMemo(() => {
    // No rotation — mower local frame ≈ ENU.
    const points_r = normalizeMapPoints(points);
    const existingMaps_r = existingMaps.map(m => ({ ...m, points: normalizeMapPoints(m.points) }))
      .filter(m => m.points.length > 0);
    const mowerPosition_r = isMapPoint(mowerPosition) ? mowerPosition : null;
    const orientation_r = orientation;

    const allPoints = [...points_r];
    for (const m of existingMaps_r) allPoints.push(...m.points);
    if (mowerPosition_r) allPoints.push(mowerPosition_r);

    if (allPoints.length === 0) {
      return { svgPoints: '', cursorX: 0, cursorY: 0, arrowDx: 0, arrowDy: 0, hasPoints: false, existingSvg: [], mowerSvg: null, closingLabel: null, pointCount: 0 };
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
    const existProj = existingMaps_r.map(m => ({
      mapId: m.mapId,
      mapType: m.mapType,
      svgPoints: m.points.map(p => project(p.x, p.y)).map(p => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(' '),
    }));

    // Project current trail
    const projected = points_r.map(p => project(p.x, p.y));
    const svgPts = projected.length > 0
      ? projected.map(p => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(' ')
      : '';

    const last = projected.length > 0 ? projected[projected.length - 1] : { sx: 0, sy: 0 };
    const dx = Math.cos(orientation_r) * ARROW_LEN;
    const dy = -Math.sin(orientation_r) * ARROW_LEN;

    // Project mower position
    const mowerProj = mowerPosition_r ? project(mowerPosition_r.x, mowerPosition_r.y) : null;

    // Closing-distance label: straight-line distance (in meters) between first and last trail
    // points, rendered at their midpoint. Matches Novabot's live loop-closure helper.
    let closing: { text: string; sx: number; sy: number } | null = null;
    if (points_r.length >= 2) {
      const first = points_r[0];
      const lastPt = points_r[points_r.length - 1];
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
      hasPoints: true,
      existingSvg: existProj,
      mowerSvg: mowerProj,
      closingLabel: closing,
      pointCount: points_r.length,
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

  const hasTrail = pointCount > 0;

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

        {/* Move the label clear of the marker, including when first == last. */}
        {closingLabel && (() => {
          const labelW = Math.max(closingLabel.text.length * 5.2 + 10, 32);
          const labelH = 15;
          const { sx: px, sy: py } = placeClosingLabel(
            closingLabel, { sx: cursorX, sy: cursorY }, labelW, ARROW_LEN, height,
          );
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

        {/* The inspected PNG points RIGHT at heading 0; invert rotation for SVG's Y axis.
            Inline image + vector heading stay visible with WiFi off, above every label. */}
        {(hasTrail || mowerSvg) && (() => {
          const mx = hasTrail ? cursorX : mowerSvg!.sx;
          const my = hasTrail ? cursorY : mowerSvg!.sy;
          const mowerSize = hasTrail ? 28 : 34;
          return (
            <G>
              <Circle cx={mx} cy={my} r={mowerSize * 0.55} fill={lineColor} opacity={0.25} />
              <Line x1={mx} y1={my} x2={mx + arrowDx} y2={my + arrowDy}
                stroke={colors.white} strokeWidth={3} strokeLinecap="round" />
              <G transform={`translate(${mx}, ${my}) rotate(${-orientation * 180 / Math.PI})`}>
                <SvgImage x={-mowerSize / 2} y={-mowerSize * 0.34}
                  width={mowerSize} height={mowerSize * 0.68} href={{ uri: MOWER_MAP_IMAGE }} />
              </G>
            </G>
          );
        })()}
      </Svg>

      {/* Point count label */}
      <Text style={styles.pointCount}>{pointCount} pts</Text>
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
