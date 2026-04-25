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
import { View, StyleSheet, Text, TouchableOpacity } from 'react-native';
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
import { useTheme } from '../../theme';
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
  /** Optional mower nickname; rendered in the top-left corner of the tile. */
  nickname?: string | null;
  /** Tap-to-rename callback fired when the user taps the nickname. */
  onPressNickname?: () => void;
}

// ── Dashboard gradient colors (exact match) ──────────────────────────

type Scheme = 'light' | 'dark';

function getGradientColors(
  activity: MowerActivity, battery: number, scheme: Scheme,
): [string, string, string] {
  const isOffline = activity === 'idle' && battery === 0;
  if (isOffline) {
    return scheme === 'light'
      ? ['#e2dccf', '#d4cdb8', '#e2dccf']
      : ['#374151', '#1f2937', '#374151'];
  }
  switch (activity) {
    case 'error':
      return scheme === 'light'
        ? ['#fce7e7', '#f5d4d4', '#f0d8d8']
        : ['#1c1917', '#292524', '#422006'];
    case 'charging':
      return scheme === 'light'
        ? ['#e0e9f5', '#cbd9ec', '#a8bfdb']
        : ['#0c1929', '#0f172a', '#1e3a5f'];
    default:
      return scheme === 'light'
        ? ['#d4f0d4', '#bce0bc', '#a8d5aa']
        : ['#065f46', '#047857', '#059669'];
  }
}

function getGrassColor(activity: MowerActivity, battery: number, scheme: Scheme): string {
  const isOffline = activity === 'idle' && battery === 0;
  if (isOffline) return scheme === 'light' ? '#a39680' : '#4b5563';
  if (activity === 'charging') return scheme === 'light' ? '#a8bfdb' : '#1e3a5f';
  return scheme === 'light' ? '#86c98a' : '#34d399';
}

function getGroundColor(activity: MowerActivity, battery: number, scheme: Scheme): string {
  const isOffline = activity === 'idle' && battery === 0;
  if (isOffline) return scheme === 'light' ? '#8a7a4d' : '#374151';
  if (activity === 'charging') return scheme === 'light' ? '#8da9c4' : '#0f172a';
  return scheme === 'light' ? '#5fa066' : '#065f46';
}

// Dashboard: sky gradient overlay
function getSkyOverlayColors(activity: MowerActivity, scheme: Scheme): [string, string] {
  if (activity === 'charging') {
    return scheme === 'light'
      ? ['rgba(168,191,219,0.35)', 'transparent']
      : ['rgba(15,23,42,0.8)', 'transparent'];
  }
  return scheme === 'light'
    ? ['rgba(34,197,94,0.10)', 'transparent']
    : ['rgba(16,185,129,0.15)', 'transparent'];
}

// ── Component ────────────────────────────────────────────────────────

export function MowerScene({ activity, battery, mowingProgress = 0, height = 140, nickname, onPressNickname }: Props) {
  const { colorScheme } = useTheme();

  const gradientColors = useMemo(
    () => getGradientColors(activity, battery, colorScheme),
    [activity, battery, colorScheme],
  );
  const skyColors = useMemo(
    () => getSkyOverlayColors(activity, colorScheme),
    [activity, colorScheme],
  );
  const grassColor = useMemo(
    () => getGrassColor(activity, battery, colorScheme),
    [activity, battery, colorScheme],
  );
  const groundColor = useMemo(
    () => getGroundColor(activity, battery, colorScheme),
    [activity, battery, colorScheme],
  );

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

  const errorOverlayStyle = useAnimatedStyle(() => ({
    opacity: errorGlow.value * 0.2,
  }));

  return (
    <View style={[styles.container, { height }]}>
      {/* Background gradient */}
      <LinearGradient colors={gradientColors} style={StyleSheet.absoluteFill} />

      {/* Error red pulse overlay */}
      {isError && (
        <Animated.View
          style={[StyleSheet.absoluteFill, styles.errorGlow, errorOverlayStyle]}
          pointerEvents="none"
        />
      )}

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
      <BatteryIndicator battery={battery} colorScheme={colorScheme} />

      {/* Mower nickname (top-left). Tap to rename if onPressNickname is wired. */}
      {nickname != null && nickname !== '' && (
        <TouchableOpacity
          style={styles.nicknameWrap}
          onPress={onPressNickname}
          disabled={!onPressNickname}
          activeOpacity={onPressNickname ? 0.7 : 1}
        >
          <Text style={styles.nicknameText} numberOfLines={1}>
            {nickname}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 20,
    overflow: 'hidden',
    marginBottom: 16,
    position: 'relative',
  },
  nicknameWrap: {
    position: 'absolute',
    top: 10,
    left: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.35)',
    maxWidth: '60%',
  },
  nicknameText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
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
  errorGlow: {
    backgroundColor: '#ef4444',
    borderRadius: 20,
  },
});
