/**
 * UnicomTransitAnimation - small looping animation shown while the mower is
 * in the `following_unicom` phase of `mow_zone` (research/documents/
 * unicom-follow-transit-design.md): it drives the recorded map-to-map
 * "unicom" line from the zone it just left to the target zone.
 *
 * Visual: two rounded emerald zone shapes connected by a dashed line, with
 * the Novabot mower silhouette looping from A to B along the dashes. Built
 * with react-native-svg + react-native-reanimated (both already app
 * dependencies, same approach as components/mower/AnimatedMower.tsx) so no
 * new dependency (no Lottie) is introduced. Theme-aware (light/dark),
 * ~2s loop. No Segway assets - original shapes/colors only.
 */
import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Rect, Line, Path as SvgPath } from 'react-native-svg';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { useTheme } from '../theme';
import { MOWER_SVG_PATH } from './mower/mowerIconPath';

const WIDTH = 220;
const HEIGHT = 64;
const ZONE_WIDTH = 56;
const ZONE_HEIGHT = 40;
const ZONE_Y = (HEIGHT - ZONE_HEIGHT) / 2;
const LEFT_ZONE_X = 4;
const RIGHT_ZONE_X = WIDTH - ZONE_WIDTH - 4;
const LINE_Y = HEIGHT / 2;
const LINE_START_X = LEFT_ZONE_X + ZONE_WIDTH;
const LINE_END_X = RIGHT_ZONE_X;
const MOWER_SIZE = 22;
// Mower travels along the dashed connector, from just past the left zone
// to just before the right zone.
const TRAVEL_START = LINE_START_X - MOWER_SIZE / 2 + 4;
const TRAVEL_END = LINE_END_X - MOWER_SIZE / 2 - 4;
const LOOP_DURATION_MS = 2000;

export function UnicomTransitAnimation() {
  const { colors, colorScheme } = useTheme();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, { duration: LOOP_DURATION_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(progress);
  }, [progress]);

  const mowerStyle = useAnimatedStyle(() => {
    const x = TRAVEL_START + (TRAVEL_END - TRAVEL_START) * progress.value;
    // Slight bob so the icon reads as "driving", matching the subtle
    // vertical bounce used elsewhere (AnimatedMower's mowing bounce).
    const bob = Math.sin(progress.value * Math.PI * 4) * 1.5;
    return {
      transform: [{ translateX: x }, { translateY: bob }],
      opacity: 0.5 + 0.5 * Math.min(1, progress.value * 4) * Math.min(1, (1 - progress.value) * 4 + 1),
    };
  });

  const zoneFill = colorScheme === 'dark' ? 'rgba(0,212,170,0.18)' : 'rgba(0,166,136,0.16)';
  const zoneStroke = colors.emerald;
  const lineColor = colorScheme === 'dark' ? 'rgba(0,212,170,0.55)' : 'rgba(0,166,136,0.55)';

  return (
    <View style={styles.container}>
      <Svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        {/* Dashed connector - the recorded unicom line between the zones */}
        <Line
          x1={LINE_START_X}
          y1={LINE_Y}
          x2={LINE_END_X}
          y2={LINE_Y}
          stroke={lineColor}
          strokeWidth={2}
          strokeDasharray="6,5"
          strokeLinecap="round"
        />
        {/* Zone A (origin) */}
        <Rect
          x={LEFT_ZONE_X}
          y={ZONE_Y}
          width={ZONE_WIDTH}
          height={ZONE_HEIGHT}
          rx={14}
          ry={14}
          fill={zoneFill}
          stroke={zoneStroke}
          strokeWidth={1.5}
        />
        {/* Zone B (destination) */}
        <Rect
          x={RIGHT_ZONE_X}
          y={ZONE_Y}
          width={ZONE_WIDTH}
          height={ZONE_HEIGHT}
          rx={14}
          ry={14}
          fill={zoneFill}
          stroke={zoneStroke}
          strokeWidth={1.5}
        />
      </Svg>
      <Animated.View style={[styles.mower, { top: LINE_Y - MOWER_SIZE / 2 }, mowerStyle]}>
        <Svg width={MOWER_SIZE} height={MOWER_SIZE} viewBox="0 0 32 32">
          <SvgPath d={MOWER_SVG_PATH} fill={colors.emerald} />
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: WIDTH,
    height: HEIGHT,
    alignSelf: 'center',
  },
  mower: {
    position: 'absolute',
    left: 0,
    width: MOWER_SIZE,
    height: MOWER_SIZE,
  },
});
