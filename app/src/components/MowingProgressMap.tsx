/**
 * MowingProgressMap — mini map showing polygon with coverage stripes.
 * Replaces the battery ring during mowing/mapping.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, {
  Polygon as SvgPolygon,
  Line,
  ClipPath,
  Defs,
  Rect,
  G,
  Circle,
} from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';

interface LocalPoint {
  x: number;
  y: number;
}

interface Props {
  polygon: LocalPoint[];
  progress: number;         // 0-100
  pathDirection: number;    // degrees (0=N, 90=E, etc.)
  battery: number;
  size?: number;
}

// ── Convert polygon (local meters) to SVG coordinates ────────────────

function polygonToSvg(
  points: LocalPoint[],
  size: number,
  padding: number,
): { svgPoints: Array<{ x: number; y: number }>; bounds: { minX: number; maxX: number; minY: number; maxY: number } } {
  if (points.length === 0) return { svgPoints: [], bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 } };

  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));

  const rangeX = maxX - minX || 0.1;
  const rangeY = maxY - minY || 0.1;
  const drawSize = size - padding * 2;
  const scale = Math.min(drawSize / rangeX, drawSize / rangeY);

  // Both axes flipped to match MapScreen rendering (bird's-eye view)
  const svgPoints = points.map((p) => ({
    x: padding + (maxX - p.x) * scale + (drawSize - rangeX * scale) / 2,
    y: padding + (p.y - minY) * scale + (drawSize - rangeY * scale) / 2,
  }));

  return {
    svgPoints,
    bounds: {
      minX: padding,
      maxX: padding + drawSize,
      minY: padding,
      maxY: padding + drawSize,
    },
  };
}

// ── Generate parallel stripe lines ───────────────────────────────────

function generateStripes(
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  direction: number,
  progress: number,
  spacing: number,
): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const diagonal = Math.sqrt(
    (bounds.maxX - bounds.minX) ** 2 + (bounds.maxY - bounds.minY) ** 2,
  );

  // Direction: 0=N means stripes go east-west (perpendicular to north)
  const rad = ((direction + 90) * Math.PI) / 180;
  const perpRad = (direction * Math.PI) / 180;

  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const px = Math.cos(perpRad);
  const py = Math.sin(perpRad);

  const totalStripes = Math.ceil(diagonal / spacing);
  const progressStripes = Math.floor((totalStripes * progress) / 100);

  const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

  for (let i = -totalStripes; i <= totalStripes; i++) {
    if (Math.abs(i) > progressStripes) continue;

    const ox = cx + px * i * spacing;
    const oy = cy + py * i * spacing;

    lines.push({
      x1: ox - dx * diagonal,
      y1: oy - dy * diagonal,
      x2: ox + dx * diagonal,
      y2: oy + dy * diagonal,
    });
  }

  return lines;
}

// ── Component ────────────────────────────────────────────────────────

export function MowingProgressMap({ polygon, progress, pathDirection, battery, size = 160 }: Props) {
  const padding = 16;

  const { svgPoints, bounds } = useMemo(
    () => polygonToSvg(polygon, size, padding),
    [polygon, size],
  );

  const stripes = useMemo(
    () => generateStripes(bounds, pathDirection, progress, 5),
    [bounds, pathDirection, progress],
  );

  const pointsStr = svgPoints.map((p) => `${p.x},${p.y}`).join(' ');

  if (svgPoints.length < 3) return null;

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Defs>
          {/* Clip stripes to polygon shape */}
          <ClipPath id="polyClip">
            <SvgPolygon points={pointsStr} />
          </ClipPath>
        </Defs>

        {/* Polygon background */}
        <SvgPolygon
          points={pointsStr}
          fill="rgba(34,197,94,0.15)"
          stroke="#22c55e"
          strokeWidth={2}
          strokeLinejoin="round"
        />

        {/* Coverage stripes (clipped to polygon) */}
        <G clipPath="url(#polyClip)">
          {stripes.map((l, i) => (
            <Line
              key={i}
              x1={l.x1} y1={l.y1}
              x2={l.x2} y2={l.y2}
              stroke="rgba(34,197,94,0.4)"
              strokeWidth={3}
            />
          ))}
        </G>

        {/* Polygon outline on top */}
        <SvgPolygon
          points={pointsStr}
          fill="none"
          stroke="#22c55e"
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </Svg>

      {/* Progress percentage overlay */}
      <View style={styles.overlay}>
        <Text style={styles.progressText}>{progress}%</Text>
      </View>

      {/* Battery chip bottom */}
      <View style={styles.batteryChip}>
        <Ionicons
          name="battery-half"
          size={12}
          color={battery >= 30 ? colors.green : battery >= 15 ? colors.amber : colors.red}
        />
        <Text style={styles.batteryText}>{battery}%</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlay: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressText: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.white,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  batteryChip: {
    position: 'absolute',
    bottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 10,
  },
  batteryText: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.8)',
    fontVariant: ['tabular-nums'],
  },
});
