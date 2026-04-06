/**
 * MowingDirectionPreview — small SVG lawn with mowing stripes
 * that rotate live based on the selected direction.
 */
import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Rect, Line, ClipPath, Defs, Polygon, Circle } from 'react-native-svg';

interface Props {
  direction: number; // degrees: 0=N, 90=E, etc.
  size?: number;
}

export function MowingDirectionPreview({ direction, size = 100 }: Props) {
  const padding = 10;
  const lawnSize = size - padding * 2;

  // Lawn polygon (slightly irregular to look natural)
  const lawnPoints = useMemo(() => {
    const cx = size / 2;
    const cy = size / 2;
    const r = lawnSize / 2 - 2;
    // Slightly organic shape with 8 points
    const pts = [
      { x: cx - r * 0.85, y: cy - r * 0.7 },
      { x: cx - r * 0.3, y: cy - r * 0.95 },
      { x: cx + r * 0.4, y: cy - r * 0.85 },
      { x: cx + r * 0.9, y: cy - r * 0.4 },
      { x: cx + r * 0.85, y: cy + r * 0.3 },
      { x: cx + r * 0.5, y: cy + r * 0.9 },
      { x: cx - r * 0.2, y: cy + r * 0.85 },
      { x: cx - r * 0.9, y: cy + r * 0.35 },
    ];
    return pts.map((p) => `${p.x},${p.y}`).join(' ');
  }, [size, lawnSize]);

  // Generate stripe lines at the given direction
  const stripes = useMemo(() => {
    const cx = size / 2;
    const cy = size / 2;
    const diagonal = size * 1.5;
    const spacing = 6;
    const count = Math.ceil(diagonal / spacing);

    // Direction: 0=N means stripes go east-west
    const rad = ((direction + 90) * Math.PI) / 180;
    const perpRad = (direction * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const px = Math.cos(perpRad);
    const py = Math.sin(perpRad);

    const lines: Array<{ x1: number; y1: number; x2: number; y2: number; alt: boolean }> = [];
    for (let i = -count; i <= count; i++) {
      const ox = cx + px * i * spacing;
      const oy = cy + py * i * spacing;
      lines.push({
        x1: ox - dx * diagonal,
        y1: oy - dy * diagonal,
        x2: ox + dx * diagonal,
        y2: oy + dy * diagonal,
        alt: i % 2 === 0,
      });
    }
    return lines;
  }, [direction, size]);

  // Compass arrow
  const arrowRad = ((direction - 90) * Math.PI) / 180;
  const arrowLen = 12;
  const acx = size / 2;
  const acy = size / 2;
  const ax = acx + Math.cos(arrowRad) * arrowLen;
  const ay = acy + Math.sin(arrowRad) * arrowLen;

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Defs>
          <ClipPath id="lawnClip">
            <Polygon points={lawnPoints} />
          </ClipPath>
        </Defs>

        {/* Lawn background */}
        <Polygon
          points={lawnPoints}
          fill="#065f46"
          stroke="#059669"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />

        {/* Mowing stripes (clipped to lawn) */}
        <Svg clipPath="url(#lawnClip)">
          {stripes.map((l, i) => (
            <Line
              key={i}
              x1={l.x1} y1={l.y1}
              x2={l.x2} y2={l.y2}
              stroke={l.alt ? 'rgba(52,211,153,0.35)' : 'rgba(16,185,129,0.2)'}
              strokeWidth={5}
            />
          ))}
        </Svg>

        {/* Lawn outline on top */}
        <Polygon
          points={lawnPoints}
          fill="none"
          stroke="#34d399"
          strokeWidth={1.5}
          strokeLinejoin="round"
          opacity={0.5}
        />

        {/* Direction arrow */}
        <Line
          x1={acx} y1={acy}
          x2={ax} y2={ay}
          stroke="#fbbf24"
          strokeWidth={2}
          strokeLinecap="round"
        />
        <Circle cx={ax} cy={ay} r={3} fill="#fbbf24" />
        <Circle cx={acx} cy={acy} r={2} fill="#fbbf24" opacity={0.5} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
