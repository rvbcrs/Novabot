/**
 * SVG circle ring showing battery percentage.
 * Green >=65%, amber 35-64%, red <35%.
 *
 * When `charging` is true the ring gets two subtle "alive" effects so the
 * user sees at a glance that current is flowing:
 *   - the percentage arc breathes (opacity 0.55↔1.0 over 1.4s)
 *   - a short bright arc rotates around the full circle continuously
 *   - small drops rise from below into the ring, like energy being pulled
 *     in. Drops grow + brighten as they approach the rim and disappear
 *     where they "merge" with the fill, suggesting absorption rather than
 *     overflow. Three drops with staggered phases keep the rhythm gentle.
 * Everything stops cleanly when `charging` flips to false.
 */
import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import Animated, {
  useSharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  withDelay,
  Easing,
  cancelAnimation,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import { useStyles, useTheme, type Colors } from '../theme';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

interface BatteryRingProps {
  percentage: number;
  size?: number;
  strokeWidth?: number;
  /** Override the auto activity-based color. */
  color?: string;
  /** When true, overlay a rotating bright arc + pulse on the percentage fill. */
  charging?: boolean;
}

export function BatteryRing({
  percentage,
  size = 120,
  strokeWidth = 10,
  color,
  charging = false,
}: BatteryRingProps) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();

  function getBatteryColor(pct: number): string {
    if (pct >= 65) return colors.green;
    if (pct >= 35) return colors.amber;
    return colors.red;
  }

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clampedPct = Math.max(0, Math.min(100, percentage));
  const strokeDashoffset = circumference - (circumference * clampedPct) / 100;
  const batteryColor = color ?? getBatteryColor(clampedPct);

  // Continuous rotation (degrees) for the bright energy arc. Driving the
  // ring color with reanimated keeps the work on the UI thread.
  const sweepRotation = useSharedValue(0);
  const fillPulse = useSharedValue(1);
  // Three drop progress values 0→1; staggered so they don't bunch up.
  // 0 = far below ring, faded; 1 = absorbed at the rim.
  const dropA = useSharedValue(0);
  const dropB = useSharedValue(0);
  const dropC = useSharedValue(0);

  useEffect(() => {
    if (charging) {
      sweepRotation.value = 0;
      sweepRotation.value = withRepeat(
        withTiming(360, { duration: 1400, easing: Easing.linear }),
        -1,
        false,
      );
      fillPulse.value = withRepeat(
        withSequence(
          withTiming(1.0, { duration: 700, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.55, { duration: 700, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        true,
      );
      // Drop loop: gentle ease-in (slow start, faster as it gets absorbed).
      const dropCycle = (sv: typeof dropA, delayMs: number) => {
        sv.value = 0;
        sv.value = withDelay(
          delayMs,
          withRepeat(
            withTiming(1, { duration: 1800, easing: Easing.in(Easing.quad) }),
            -1,
            false,
          ),
        );
      };
      dropCycle(dropA, 0);
      dropCycle(dropB, 600);
      dropCycle(dropC, 1200);
    } else {
      cancelAnimation(sweepRotation);
      cancelAnimation(fillPulse);
      cancelAnimation(dropA);
      cancelAnimation(dropB);
      cancelAnimation(dropC);
      sweepRotation.value = 0;
      fillPulse.value = 1;
      dropA.value = 0;
      dropB.value = 0;
      dropC.value = 0;
    }
    // Note: cleanup is handled implicitly when the next effect fires.
    return () => {
      cancelAnimation(sweepRotation);
      cancelAnimation(fillPulse);
      cancelAnimation(dropA);
      cancelAnimation(dropB);
      cancelAnimation(dropC);
    };
  }, [charging, sweepRotation, fillPulse, dropA, dropB, dropC]);

  // The bright sweep is a short arc — we use a dasharray trick: stroke for
  // 1/6 of the circumference, gap for the rest. Then we rotate the parent
  // <Svg> via an Animated.View transform.
  const sweepLength = circumference / 6;
  const sweepDash = `${sweepLength} ${circumference - sweepLength}`;

  const sweepStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${sweepRotation.value}deg` }],
  }));

  const fillProps = useAnimatedProps(() => ({
    opacity: fillPulse.value,
  }));

  // Drops travel from `riseFrom` px below the ring up to the bottom rim.
  // Anchored to the bottom-center via positioning; transform handles motion.
  const riseFrom = Math.round(size * 0.28);
  const useDropStyle = (sv: typeof dropA, xOffset: number) =>
    useAnimatedStyle(() => {
      const p = sv.value;
      // Rise + fade-in early, fade-out as it merges into the ring.
      const translateY = interpolate(p, [0, 1], [riseFrom, 0], Extrapolation.CLAMP);
      const opacity = interpolate(
        p,
        [0, 0.15, 0.85, 1],
        [0, 0.85, 0.85, 0],
        Extrapolation.CLAMP,
      );
      const scale = interpolate(p, [0, 0.6, 1], [0.6, 1, 0.7], Extrapolation.CLAMP);
      return {
        opacity,
        transform: [
          { translateX: xOffset },
          { translateY },
          { scale },
        ],
      };
    });

  const dropAStyle = useDropStyle(dropA, -8);
  const dropBStyle = useDropStyle(dropB, 0);
  const dropCStyle = useDropStyle(dropC, 8);

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      {/* Static layer: background ring + percentage fill */}
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={strokeWidth}
          fill="none"
        />
        <AnimatedCircle
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
          animatedProps={charging ? fillProps : undefined}
        />
      </Svg>

      {/* Animated overlay: a bright sweeping arc that rotates while charging */}
      {charging && (
        <Animated.View
          pointerEvents="none"
          style={[
            { position: 'absolute', width: size, height: size },
            sweepStyle,
          ]}
        >
          <Svg width={size} height={size}>
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              stroke={batteryColor}
              strokeOpacity={0.95}
              strokeWidth={strokeWidth}
              fill="none"
              strokeDasharray={sweepDash}
              strokeLinecap="round"
              rotation="-90"
              origin={`${size / 2}, ${size / 2}`}
            />
          </Svg>
        </Animated.View>
      )}

      {/* Drops being pulled UP into the ring's bottom rim while charging.
          Anchored just inside the bottom edge so the absorption point sits
          on the stroke; translateY rises them from below into that spot. */}
      {charging && (
        <View pointerEvents="none" style={[styles.dropAnchor, { bottom: strokeWidth / 2 }]}>
          <Animated.View style={[styles.drop, { backgroundColor: batteryColor }, dropAStyle]} />
          <Animated.View
            style={[
              styles.drop,
              { backgroundColor: batteryColor, position: 'absolute' },
              dropBStyle,
            ]}
          />
          <Animated.View
            style={[
              styles.drop,
              { backgroundColor: batteryColor, position: 'absolute' },
              dropCStyle,
            ]}
          />
        </View>
      )}
    </View>
  );
}

const makeStyles = (_c: Colors) => StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  dropAnchor: {
    position: 'absolute',
    alignSelf: 'center',
    width: 30,
    height: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  drop: {
    width: 5,
    height: 7,
    borderRadius: 3,
  },
});
