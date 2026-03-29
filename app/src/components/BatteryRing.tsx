/**
 * SVG circle ring showing battery percentage.
 * Green >60%, amber 20-60%, red <20%.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { colors } from '../theme/colors';

interface BatteryRingProps {
  percentage: number;
  size?: number;
  strokeWidth?: number;
  color?: string;  // Override auto color (activity-based)
}

function getBatteryColor(pct: number): string {
  if (pct > 60) return colors.green;
  if (pct >= 20) return colors.amber;
  return colors.red;
}

export function BatteryRing({
  percentage,
  size = 120,
  strokeWidth = 10,
  color,
}: BatteryRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clampedPct = Math.max(0, Math.min(100, percentage));
  const strokeDashoffset = circumference - (circumference * clampedPct) / 100;
  const batteryColor = color ?? getBatteryColor(clampedPct);

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <Svg width={size} height={size}>
        {/* Background circle */}
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={strokeWidth}
          fill="none"
        />
        {/* Progress circle */}
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={batteryColor}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={`${circumference}`}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          rotation="-90"
          origin={`${size / 2}, ${size / 2}`}
        />
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
