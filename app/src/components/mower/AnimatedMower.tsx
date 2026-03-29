/**
 * AnimatedMower — real Novabot body + spinning wheel PNG, grass clippings.
 * Matches dashboard MowerAnimation.tsx exactly.
 */
import React, { useEffect } from 'react';
import { View, Image, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
  Easing,
} from 'react-native-reanimated';
import type { MowerActivity } from '../../types';

interface Props {
  activity: MowerActivity;
  battery: number;
}

// Grass clippings data (dashboard: 8 clippings)
const CLIPPINGS = Array.from({ length: 8 }, (_, i) => ({
  delay: i * 300,
  dx: -8 + (i % 4) * 6,
  size: 2 + (i % 3),
}));

function GrassClipping({ delay, dx, size }: { delay: number; dx: number; size: number }) {
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const opacity = useSharedValue(0);
  const scale = useSharedValue(1);

  useEffect(() => {
    const startAnim = () => {
      translateX.value = 0;
      translateY.value = 0;
      opacity.value = 0.8;
      scale.value = 1;

      translateX.value = withRepeat(
        withTiming(dx, { duration: 800, easing: Easing.out(Easing.ease) }),
        -1,
        false,
      );
      translateY.value = withRepeat(
        withTiming(-20, { duration: 800, easing: Easing.out(Easing.ease) }),
        -1,
        false,
      );
      opacity.value = withRepeat(
        withSequence(
          withTiming(0.6, { duration: 400 }),
          withTiming(0, { duration: 400 }),
        ),
        -1,
        false,
      );
      scale.value = withRepeat(
        withTiming(0.3, { duration: 800, easing: Easing.out(Easing.ease) }),
        -1,
        false,
      );
    };

    const timer = setTimeout(startAnim, delay);
    return () => clearTimeout(timer);
  }, []);

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: '#6ee7b7',
        },
        style,
      ]}
    />
  );
}

export function AnimatedMower({ activity, battery }: Props) {
  const translateY = useSharedValue(0);
  const translateX = useSharedValue(0);
  const wheelRotation = useSharedValue(0);

  const isMowing = activity === 'mowing';
  const isMapping = activity === 'mapping';
  const isReturning = activity === 'returning';
  const isCharging = activity === 'charging';
  const isPaused = activity === 'paused';
  const isError = activity === 'error';
  const isOffline = activity === 'idle' && battery === 0;

  useEffect(() => {
    cancelAnimation(translateY);
    cancelAnimation(translateX);
    cancelAnimation(wheelRotation);

    if (isMowing) {
      // Dashboard: mower-drive 0.6s — subtle vertical bounce
      translateY.value = withRepeat(
        withSequence(
          withTiming(-1.5, { duration: 150, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 150, easing: Easing.inOut(Easing.ease) }),
          withTiming(-1, { duration: 150, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 150, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      );
      translateX.value = withTiming(0, { duration: 200 });
      // Dashboard: wheel-spin 0.4s linear infinite
      wheelRotation.value = withRepeat(
        withTiming(360, { duration: 400, easing: Easing.linear }),
        -1,
        false,
      );
    } else if (isMapping) {
      // Dashboard: mower-map-drive 5s linear infinite (-350 to 350)
      translateX.value = withRepeat(
        withSequence(
          withTiming(-100, { duration: 0 }),
          withTiming(100, { duration: 5000, easing: Easing.linear }),
        ),
        -1,
        false,
      );
      translateY.value = withTiming(0, { duration: 200 });
      wheelRotation.value = withRepeat(
        withTiming(360, { duration: 400, easing: Easing.linear }),
        -1,
        false,
      );
    } else if (isReturning) {
      // Animate from far left to charger position (baseLeft=58%, end at 0 offset)
      translateX.value = -160;
      translateX.value = withTiming(0, { duration: 4000, easing: Easing.out(Easing.ease) });
      translateY.value = withTiming(0, { duration: 200 });
      // Dashboard: wheel-decel 4s — 1150deg with decel
      wheelRotation.value = withTiming(1150, { duration: 4000, easing: Easing.out(Easing.ease) });
    } else if (isPaused || isError) {
      translateY.value = withTiming(0, { duration: 200 });
      translateX.value = withTiming(0, { duration: 200 });
    } else {
      // Dashboard: mower-idle-bob 3s ease-in-out infinite
      translateX.value = withTiming(0, { duration: 300 });
      translateY.value = withRepeat(
        withSequence(
          withTiming(-2, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        true,
      );
      wheelRotation.value = withTiming(0, { duration: 300 });
    }
  }, [activity]);

  const mowerStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
    ],
  }));

  const wheelStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${wheelRotation.value}deg` }],
  }));

  // Position: charging = parked at charger, returning = animates toward charger
  // Charger is at right ~6%, so mower should end up at ~58% to be adjacent
  const baseLeft = isReturning || isCharging ? '58%' : '50%';
  const opacity = isOffline ? 0.3 : isPaused ? 0.7 : 1;

  return (
    <Animated.View
      style={[
        styles.container,
        { left: baseLeft as any, opacity },
        mowerStyle,
      ]}
    >
      <View style={styles.mowerFrame}>
        {/* Body (without wheel) */}
        <Image
          source={isOffline
            ? require('../../../assets/novabot-body-offline.png')
            : require('../../../assets/novabot-body.png')
          }
          style={styles.bodyImage}
          resizeMode="contain"
        />
        {/* Rear wheel — separate image so it can rotate */}
        <Animated.Image
          source={require('../../../assets/novabot-wheel.png')}
          style={[styles.wheelImage, wheelStyle]}
          resizeMode="contain"
        />
      </View>

      {/* Grass clippings (only when mowing) */}
      {isMowing && (
        <View style={styles.clippingsContainer}>
          {CLIPPINGS.map((c, i) => (
            <GrassClipping key={i} delay={c.delay} dx={c.dx} size={c.size} />
          ))}
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: -28,
    marginLeft: -72,
    width: 144,
    height: 144,
  },
  mowerFrame: {
    width: 144,
    height: 144,
    position: 'relative',
  },
  bodyImage: {
    position: 'absolute',
    width: '100%',
    height: '100%',
  },
  wheelImage: {
    position: 'absolute',
    // Dashboard: left 12.89%, top 47.83%, size 27.34%
    left: '12.89%',
    top: '47.83%',
    width: '27.34%',
    height: '27.34%',
  },
  clippingsContainer: {
    position: 'absolute',
    top: '45%',
    left: -12,
  },
});
