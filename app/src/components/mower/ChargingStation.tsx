/**
 * ChargingStation — SVG charging dock, visible when returning or charging.
 * Matches the dashboard's charger house with blinking LED + lightning bolt.
 */
import React, { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedProps,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import Svg, { Rect, Path, Circle } from 'react-native-svg';
import type { MowerActivity } from '../../types';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

interface Props {
  activity: MowerActivity;
}

export function ChargingStation({ activity }: Props) {
  const isCharging = activity === 'charging';

  const ledOpacity = useSharedValue(0.4);
  const boltOpacity = useSharedValue(0.6);

  useEffect(() => {
    ledOpacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: isCharging ? 500 : 750, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.4, { duration: isCharging ? 500 : 750, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      true,
    );

    if (isCharging) {
      boltOpacity.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 600, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.6, { duration: 600, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        true,
      );
    }
  }, [isCharging]);

  const ledProps = useAnimatedProps(() => ({
    opacity: ledOpacity.value,
  }));

  const boltProps = useAnimatedProps(() => ({
    opacity: boltOpacity.value,
  }));

  const bodyColor = isCharging ? '#1e3a5f' : '#4b5563';
  const roofColor = isCharging ? '#2d4a6f' : '#6b7280';
  const baseColor = isCharging ? '#1e3a5f' : '#374151';
  const ledColor = isCharging ? '#fbbf24' : '#34d399';

  return (
    <Animated.View style={styles.container}>
      <Svg viewBox="0 0 50 60" width={56} height={68}>
        {/* Base platform */}
        <Rect x={2} y={50} width={46} height={5} rx={2} fill={baseColor} />
        {/* House body */}
        <Rect x={8} y={16} width={34} height={36} rx={3} fill={bodyColor} />
        {/* Roof */}
        <Path d="M4 18 L25 4 L46 18 Z" fill={roofColor} />
        {/* Windows */}
        <Rect x={12} y={38} width={7} height={12} rx={1} fill="#f59e0b" opacity={isCharging ? 1 : 0.8} />
        <Rect x={31} y={38} width={7} height={12} rx={1} fill="#f59e0b" opacity={isCharging ? 1 : 0.8} />
        {/* LED indicator */}
        <AnimatedCircle
          cx={25}
          cy={27}
          r={3.5}
          fill={ledColor}
          animatedProps={ledProps}
        />
        {/* Lightning bolt (charging only) */}
        {isCharging && (
          <AnimatedPath
            d="M27 20 L23 26 L25.5 26 L23 33 L29 25 L26.5 25 Z"
            fill="#fbbf24"
            animatedProps={boltProps}
          />
        )}
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: -2,
    right: '8%',
  },
});
