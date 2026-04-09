/**
 * MowingProgressMap — live mini map during mowing.
 * Shows polygon, coverage stripes, mower trail, mower position + heading, charger.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, {
  Polygon as SvgPolygon,
  Polyline,
  Line,
  ClipPath,
  Defs,
  G,
  Circle,
  Path,
} from 'react-native-svg';
import { colors } from '../theme/colors';

interface LocalPoint {
  x: number;
  y: number;
}

interface Props {
  polygon: LocalPoint[];
  progress: number;         // 0-100 (cov_ratio)
  pathDirection: number;    // degrees
  size?: number;
  trail?: LocalPoint[];     // mowed path in local meters
  mowerPos?: LocalPoint | null;  // mower position in local meters
  mowerHeading?: number;    // radians
}

function toSvg(
  point: LocalPoint,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  size: number,
  padding: number,
) {
  const drawSize = size - padding * 2;
  const xRange = bounds.maxX - bounds.minX || 0.1;
  const yRange = bounds.maxY - bounds.minY || 0.1;
  const scale = Math.min(drawSize / xRange, drawSize / yRange);
  return {
    x: padding + (bounds.maxX - point.x) * scale + (drawSize - xRange * scale) / 2,
    y: padding + (point.y - bounds.minY) * scale + (drawSize - yRange * scale) / 2,
  };
}

function computeBounds(points: LocalPoint[], extra: LocalPoint[]): { minX: number; maxX: number; minY: number; maxY: number } {
  const all = [...points, ...extra];
  if (all.length === 0) return { minX: 0, maxX: 1, minY: 0, maxY: 1 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of all) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = Math.max(maxX - minX, maxY - minY) * 0.1 || 0.5;
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
}

function generateStripes(
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  direction: number,
  progress: number,
  spacing: number,
): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const diagonal = Math.sqrt((bounds.maxX - bounds.minX) ** 2 + (bounds.maxY - bounds.minY) ** 2);
  const rad = ((direction + 90) * Math.PI) / 180;
  const perpRad = (direction * Math.PI) / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  const px = Math.cos(perpRad), py = Math.sin(perpRad);
  const totalStripes = Math.ceil(diagonal / spacing);
  const progressStripes = Math.floor((totalStripes * progress) / 100);
  const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (let i = -totalStripes; i <= totalStripes; i++) {
    if (Math.abs(i) > progressStripes) continue;
    const ox = cx + px * i * spacing;
    const oy = cy + py * i * spacing;
    lines.push({ x1: ox - dx * diagonal, y1: oy - dy * diagonal, x2: ox + dx * diagonal, y2: oy + dy * diagonal });
  }
  return lines;
}

export function MowingProgressMap({ polygon, progress, pathDirection, size = 200, trail, mowerPos, mowerHeading }: Props) {
  const padding = 14;
  const charger: LocalPoint = { x: 0, y: 0 };

  const bounds = useMemo(() => {
    const extra = [charger];
    if (mowerPos) extra.push(mowerPos);
    if (trail && trail.length > 0) extra.push(...trail);
    return computeBounds(polygon, extra);
  }, [polygon, mowerPos, trail]);

  const svgPoints = useMemo(() => polygon.map(p => toSvg(p, bounds, size, padding)), [polygon, bounds, size]);
  const pointsStr = svgPoints.map(p => `${p.x},${p.y}`).join(' ');
  // Add 180° to compensate for both-axes-flipped rendering in toSvg
  const stripes = useMemo(() => generateStripes({ minX: padding, maxX: size - padding, minY: padding, maxY: size - padding }, pathDirection + 180, progress, 5), [size, pathDirection, progress]);

  const trailSvg = useMemo(() =>
    (trail ?? []).map(p => toSvg(p, bounds, size, padding)),
    [trail, bounds, size]);

  const chargerSvg = toSvg(charger, bounds, size, padding);
  const mowerSvg = mowerPos ? toSvg(mowerPos, bounds, size, padding) : null;

  if (svgPoints.length < 3) return null;

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Defs>
          <ClipPath id="polyClipHome">
            <SvgPolygon points={pointsStr} />
          </ClipPath>
        </Defs>

        {/* Polygon background */}
        <SvgPolygon points={pointsStr} fill="rgba(34,197,94,0.12)" stroke="#22c55e" strokeWidth={1.5} strokeLinejoin="round" />

        {/* Direction stripes (thin — shows planned mow direction) */}
        <G clipPath="url(#polyClipHome)">
          {stripes.map((l, i) => (
            <Line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="rgba(34,197,94,0.15)" strokeWidth={1} />
          ))}
        </G>

        {/* Mowed trail (thick — shows actual coverage) */}
        {trailSvg.length > 1 && (
          <G clipPath="url(#polyClipHome)">
            <Polyline
              points={trailSvg.map(p => `${p.x},${p.y}`).join(' ')}
              fill="none" stroke="rgba(34,197,94,0.5)" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round"
            />
          </G>
        )}

        {/* Charger */}
        <Circle cx={chargerSvg.x} cy={chargerSvg.y} r={7} fill="rgba(245,158,11,0.2)" stroke="#f59e0b" strokeWidth={1.5} />
        <Path d={`M${chargerSvg.x - 2} ${chargerSvg.y - 3} L${chargerSvg.x + 2} ${chargerSvg.y - 3} L${chargerSvg.x + 0.5} ${chargerSvg.y} L${chargerSvg.x + 2} ${chargerSvg.y} L${chargerSvg.x - 1} ${chargerSvg.y + 3.5} L${chargerSvg.x} ${chargerSvg.y + 0.5} L${chargerSvg.x - 1.5} ${chargerSvg.y + 0.5} Z`} fill="#f59e0b" />

        {/* Mower + heading */}
        {mowerSvg && (() => {
          const rad = mowerHeading != null ? (mowerHeading - Math.PI / 2) : 0;
          const ax = mowerSvg.x + Math.cos(rad) * 10;
          const ay = mowerSvg.y + Math.sin(rad) * 10;
          return (
            <G>
              <Line x1={mowerSvg.x} y1={mowerSvg.y} x2={ax} y2={ay} stroke={colors.emerald} strokeWidth={1.5} strokeLinecap="round" />
              <Circle cx={mowerSvg.x} cy={mowerSvg.y} r={5} fill={colors.emerald} />
              <Circle cx={mowerSvg.x} cy={mowerSvg.y} r={2.5} fill={colors.white} />
            </G>
          );
        })()}

        {/* Outline on top */}
        <SvgPolygon points={pointsStr} fill="none" stroke="#22c55e" strokeWidth={1.5} strokeLinejoin="round" />
      </Svg>

      {/* Progress overlay */}
      <View style={styles.overlay}>
        <Text style={styles.progressText}>{progress}%</Text>
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
});
