/**
 * NightSky — twinkling stars rendered during charging (night scene).
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withDelay,
  useSharedValue,
  Easing,
} from 'react-native-reanimated';
import { useEffect } from 'react';

interface StarDef {
  x: string;
  y: string;
  size: number;
  baseOpacity: number;
  delay: number;
}

const STARS: StarDef[] = [
  { x: '15%', y: '12%', size: 3, baseOpacity: 0.5, delay: 0 },
  { x: '72%', y: '8%', size: 4, baseOpacity: 0.7, delay: 400 },
  { x: '45%', y: '18%', size: 3, baseOpacity: 0.4, delay: 800 },
  { x: '88%', y: '15%', size: 3, baseOpacity: 0.6, delay: 200 },
  { x: '30%', y: '6%', size: 4, baseOpacity: 0.5, delay: 600 },
  { x: '60%', y: '22%', size: 3, baseOpacity: 0.3, delay: 1000 },
  { x: '8%', y: '20%', size: 2, baseOpacity: 0.4, delay: 300 },
  { x: '52%', y: '5%', size: 3, baseOpacity: 0.6, delay: 700 },
];

function Star({ x, y, size, baseOpacity, delay }: StarDef) {
  const opacity = useSharedValue(baseOpacity * 0.4);

  useEffect(() => {
    opacity.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(baseOpacity, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
          withTiming(baseOpacity * 0.3, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        true,
      ),
    );
  }, []);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[
        styles.star,
        { left: x as any, top: y as any, width: size, height: size, borderRadius: size / 2 },
        style,
      ]}
    />
  );
}

export function NightSky() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {STARS.map((s, i) => (
        <Star key={i} {...s} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  star: {
    position: 'absolute',
    backgroundColor: '#ffffff',
  },
});
