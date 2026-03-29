/**
 * MappingOverlay — animated polygon being drawn with corner dots.
 * Matches dashboard MowerAnimation mapping state exactly.
 */
import React, { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedProps,
  withRepeat,
  withSequence,
  withTiming,
  withDelay,
  Easing,
} from 'react-native-reanimated';
import Svg, { Line, Polygon, Circle } from 'react-native-svg';

const AnimatedPolygon = Animated.createAnimatedComponent(Polygon);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// Dashboard polygon points
const POLYGON_POINTS = '45,95 80,30 170,22 240,45 255,90 220,115 100,118';

// Dashboard corner markers with staggered delays
const CORNERS = [
  { x: 45, y: 95, delay: 0 },
  { x: 80, y: 30, delay: 700 },
  { x: 170, y: 22, delay: 1400 },
  { x: 240, y: 45, delay: 2100 },
  { x: 255, y: 90, delay: 2500 },
  { x: 220, y: 115, delay: 2900 },
  { x: 100, y: 118, delay: 3300 },
];

function CornerDot({ x, y, delay }: { x: number; y: number; delay: number }) {
  const scale = useSharedValue(0);
  const opacity = useSharedValue(0);

  useEffect(() => {
    scale.value = withRepeat(
      withDelay(
        delay,
        withSequence(
          withTiming(0, { duration: 0 }),
          withTiming(1.3, { duration: 250, easing: Easing.out(Easing.ease) }),
          withTiming(1, { duration: 250, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 4500 - 500 }), // hold for rest of 5s cycle
        ),
      ),
      -1,
      false,
    );
    opacity.value = withRepeat(
      withDelay(
        delay,
        withSequence(
          withTiming(0, { duration: 0 }),
          withTiming(1, { duration: 250 }),
          withTiming(0.9, { duration: 250 }),
          withTiming(0.9, { duration: 4500 - 500 }),
        ),
      ),
      -1,
      false,
    );
  }, []);

  const props = useAnimatedProps(() => ({
    r: 3 * scale.value,
    opacity: opacity.value,
  }));

  return <AnimatedCircle cx={x} cy={y} fill="#c4b5fd" animatedProps={props} />;
}

export function MappingOverlay() {
  // Polygon draw animation — dashoffset from 400 to 0
  const dashOffset = useSharedValue(400);
  const fillOpacity = useSharedValue(0);

  useEffect(() => {
    // Dashboard: draw-polygon 5s — offset 400→0 at 80%
    dashOffset.value = withRepeat(
      withSequence(
        withTiming(400, { duration: 0 }),
        withTiming(0, { duration: 4000, easing: Easing.inOut(Easing.ease) }),
        withTiming(0, { duration: 1000 }),
      ),
      -1,
      false,
    );
    // Dashboard: fill-polygon 5s — fill appears at 75%
    fillOpacity.value = withRepeat(
      withSequence(
        withTiming(0, { duration: 3750 }),
        withTiming(0.12, { duration: 1250, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      false,
    );
  }, []);

  const polygonProps = useAnimatedProps(() => ({
    strokeDashoffset: dashOffset.value,
    fillOpacity: fillOpacity.value,
  }));

  return (
    <Svg
      viewBox="0 0 300 140"
      style={StyleSheet.absoluteFill}
      preserveAspectRatio="none"
    >
      {/* Grid lines (subtle surveying feel) */}
      {[35, 70, 105].map((y) => (
        <Line key={`h${y}`} x1={0} y1={y} x2={300} y2={y} stroke="#a78bfa" strokeWidth={0.3} opacity={0.15} />
      ))}
      {[60, 120, 180, 240].map((x) => (
        <Line key={`v${x}`} x1={x} y1={0} x2={x} y2={140} stroke="#a78bfa" strokeWidth={0.3} opacity={0.15} />
      ))}

      {/* Polygon outline — drawn progressively */}
      <AnimatedPolygon
        points={POLYGON_POINTS}
        fill="#a78bfa"
        stroke="#c4b5fd"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeDasharray="400"
        animatedProps={polygonProps}
      />

      {/* Corner markers — appear sequentially */}
      {CORNERS.map((p, i) => (
        <CornerDot key={i} x={p.x} y={p.y} delay={p.delay} />
      ))}
    </Svg>
  );
}
