/**
 * MowerScene — fully native React Native mower animation.
 * Exact replica of dashboard/src/mobile/components/MowerAnimation.tsx.
 *
 * Modules:
 *  - NightSky: twinkling stars (charging)
 *  - ScrollingEnvironment: grass + bushes + flowers (exact dashboard data)
 *  - ChargingStation: charger dock SVG
 *  - AnimatedMower: real novabot-body.png + spinning wheel + clippings
 *  - MappingOverlay: animated polygon with corner dots
 *  - BatteryIndicator: battery icon (top-right)
 */
import React, { useMemo, useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import type { MowerActivity } from '../../types';
import { NightSky } from './NightSky';
import { ScrollingEnvironment } from './ScrollingEnvironment';
import { ChargingStation } from './ChargingStation';
import { AnimatedMower } from './AnimatedMower';
import { MappingOverlay } from './MappingOverlay';
import { BatteryIndicator } from './BatteryIndicator';

interface Props {
  activity: MowerActivity;
  battery: number;
  mowingProgress?: number;
  height?: number;
}

// ── Dashboard gradient colors (exact match) ──────────────────────────

function getGradientColors(activity: MowerActivity, battery: number): [string, string, string] {
  const isOffline = activity === 'idle' && battery === 0;
  if (isOffline) return ['#374151', '#1f2937', '#374151'];
  switch (activity) {
    case 'error':
      return ['#1c1917', '#292524', '#422006'];
    case 'charging':
      return ['#0c1929', '#0f172a', '#1e3a5f'];
    default:
      return ['#065f46', '#047857', '#059669'];
  }
}

function getGrassColor(activity: MowerActivity, battery: number): string {
  const isOffline = activity === 'idle' && battery === 0;
  if (isOffline) return '#4b5563';
  if (activity === 'charging') return '#1e3a5f';
  return '#34d399';
}

function getGroundColor(activity: MowerActivity, battery: number): string {
  const isOffline = activity === 'idle' && battery === 0;
  if (isOffline) return '#374151';
  if (activity === 'charging') return '#0f172a';
  return '#065f46';
}

// Dashboard: sky gradient overlay
function getSkyOverlayColors(activity: MowerActivity): [string, string] {
  if (activity === 'charging') {
    return ['rgba(15,23,42,0.8)', 'transparent'];
  }
  return ['rgba(16,185,129,0.15)', 'transparent'];
}

// ── Component ────────────────────────────────────────────────────────

export function MowerScene({ activity, battery, mowingProgress = 0, height = 140 }: Props) {
  const gradientColors = useMemo(() => getGradientColors(activity, battery), [activity, battery]);
  const skyColors = useMemo(() => getSkyOverlayColors(activity), [activity]);
  const grassColor = useMemo(() => getGrassColor(activity, battery), [activity, battery]);
  const groundColor = useMemo(() => getGroundColor(activity, battery), [activity, battery]);

  const isCharging = activity === 'charging';
  const isReturning = activity === 'returning';
  const isMapping = activity === 'mapping';
  const isError = activity === 'error';
  const isOffline = activity === 'idle' && battery === 0;

  // Dashboard: error-glow 2s ease-in-out infinite
  const errorGlow = useSharedValue(0);
  useEffect(() => {
    if (isError) {
      errorGlow.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 1000, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 1000, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        true,
      );
    } else {
      errorGlow.value = withTiming(0, { duration: 200 });
    }
  }, [isError]);

  const errorStyle = useAnimatedStyle(() => ({
    // Simulate box-shadow glow with border + opacity
    borderColor: `rgba(239, 68, 68, ${errorGlow.value * 0.3})`,
    borderWidth: errorGlow.value > 0.01 ? 2 : 0,
  }));

  return (
    <Animated.View style={[styles.container, { height }, isError && errorStyle]}>
      {/* Background gradient */}
      <LinearGradient colors={gradientColors} style={StyleSheet.absoluteFill} />

      {/* Sky gradient overlay */}
      {!isOffline && (
        <LinearGradient
          colors={skyColors}
          style={styles.skyOverlay}
          pointerEvents="none"
        />
      )}

      {/* Night sky (charging only) */}
      {isCharging && <NightSky />}

      {/* Mapping overlay (polygon being drawn) */}
      {isMapping && <MappingOverlay />}

      {/* Scrolling grass + scenery */}
      <ScrollingEnvironment activity={activity} grassColor={grassColor} />

      {/* Ground line — dashboard: h-3 */}
      <View style={[styles.ground, { backgroundColor: groundColor }]} />

      {/* Charger station (returning + charging) */}
      {(isReturning || isCharging) && <ChargingStation activity={activity} />}

      {/* Animated mower */}
      <AnimatedMower activity={activity} battery={battery} />

      {/* Progress bar (inside scene, bottom) */}
      {activity === 'mowing' && mowingProgress > 0 && (
        <View style={styles.progressTrack}>
          <View style={[styles.progressBar, { width: `${mowingProgress}%` as any }]} />
        </View>
      )}

      {/* Battery indicator (top-right) */}
      <BatteryIndicator battery={battery} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 20,
    overflow: 'hidden',
    marginBottom: 16,
    position: 'relative',
  },
  skyOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '50%',
  },
  ground: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 12,
  },
  progressTrack: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 4,
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  progressBar: {
    height: '100%',
    backgroundColor: 'rgba(52,211,153,0.8)',
  },
});
