/**
 * ScrollingEnvironment — exact replica of dashboard MowerAnimation scenery.
 * Grass blades (28), bushes (4, triple-ellipse), flowers (8, 5-petal + stem + leaf).
 * Scrolls left during mowing with seamless duplicate strip.
 */
import React, { useEffect } from 'react';
import { View, Dimensions, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  cancelAnimation,
  Easing,
} from 'react-native-reanimated';
import Svg, { Ellipse, Line, Circle } from 'react-native-svg';
import type { MowerActivity } from '../../types';

const { width: SCREEN_W } = Dimensions.get('window');

interface Props {
  activity: MowerActivity;
  grassColor: string;
}

// ── Dashboard data ───────────────────────────────────────────────────

const GRASS_BLADES = Array.from({ length: 28 }, (_, i) => ({
  left: (i * 3.6) + 0.5,
  height: 14 + (i % 5) * 4,
  delay: ((i * 0.12) % 1.5),
}));

const SCENERY = [
  // Bushes — triple-ellipse clusters (dashboard exact)
  { type: 'bush' as const, left: 8, w: 18, h: 14, color: '#059669' },
  { type: 'bush' as const, left: 28, w: 14, h: 11, color: '#047857' },
  { type: 'bush' as const, left: 62, w: 20, h: 16, color: '#065f46' },
  { type: 'bush' as const, left: 85, w: 16, h: 12, color: '#059669' },
  // Flowers — 5-petal + stem + leaf (dashboard exact)
  { type: 'flower' as const, left: 15, h: 18, petal: '#f472b6', stem: '#34d399' },
  { type: 'flower' as const, left: 22, h: 14, petal: '#fbbf24', stem: '#6ee7b7' },
  { type: 'flower' as const, left: 38, h: 20, petal: '#c084fc', stem: '#34d399' },
  { type: 'flower' as const, left: 48, h: 16, petal: '#fb923c', stem: '#6ee7b7' },
  { type: 'flower' as const, left: 55, h: 15, petal: '#f472b6', stem: '#34d399' },
  { type: 'flower' as const, left: 72, h: 19, petal: '#60a5fa', stem: '#6ee7b7' },
  { type: 'flower' as const, left: 78, h: 13, petal: '#fbbf24', stem: '#34d399' },
  { type: 'flower' as const, left: 92, h: 17, petal: '#f472b6', stem: '#6ee7b7' },
];

// ── Scenery rendering ────────────────────────────────────────────────

function BushSvg({ w, h, color }: { w: number; h: number; color: string }) {
  return (
    <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {/* Dashboard: triple-ellipse bush */}
      <Ellipse cx={w / 2} cy={h} rx={w / 2} ry={h * 0.85} fill={color} opacity={0.7} />
      <Ellipse cx={w * 0.35} cy={h * 0.7} rx={w * 0.3} ry={h * 0.55} fill={color} opacity={0.85} />
      <Ellipse cx={w * 0.65} cy={h * 0.65} rx={w * 0.35} ry={h * 0.6} fill={color} opacity={0.8} />
    </Svg>
  );
}

function FlowerSvg({ h, petal, stem }: { h: number; petal: string; stem: string }) {
  // Dashboard: 5 petals at 72° intervals around center
  const petals = [0, 72, 144, 216, 288].map((angle) => ({
    cx: 6 + Math.cos((angle * Math.PI) / 180) * 3,
    cy: 5 + Math.sin((angle * Math.PI) / 180) * 3,
  }));

  return (
    <Svg width={12} height={h} viewBox={`0 0 12 ${h}`}>
      {/* Stem */}
      <Line x1={6} y1={h} x2={6} y2={5} stroke={stem} strokeWidth={1.5} />
      {/* Leaf */}
      <Ellipse
        cx={8}
        cy={h * 0.6}
        rx={3}
        ry={1.5}
        fill={stem}
        opacity={0.7}
        rotation={-30}
        origin={`8, ${h * 0.6}`}
      />
      {/* 5 Petals */}
      {petals.map((p, i) => (
        <Circle key={i} cx={p.cx} cy={p.cy} r={2} fill={petal} opacity={0.9} />
      ))}
      {/* Center */}
      <Circle cx={6} cy={5} r={1.5} fill="#fde047" />
    </Svg>
  );
}

function SceneryStrip({ grassColor, offsetPct = 0 }: { grassColor: string; offsetPct?: number }) {
  return (
    <View style={{ width: SCREEN_W, height: '100%', position: 'relative' }}>
      {/* Grass blades */}
      {GRASS_BLADES.map((blade, i) => (
        <View
          key={`g${i}`}
          style={{
            position: 'absolute',
            bottom: 0,
            left: `${blade.left + offsetPct}%` as any,
            width: 3,
            height: blade.height,
            backgroundColor: grassColor,
            opacity: 0.6,
            borderTopLeftRadius: 3,
            borderTopRightRadius: 3,
          }}
        />
      ))}
    </View>
  );
}

function SceneryItems({ offsetPct = 0 }: { offsetPct?: number }) {
  return (
    <>
      {SCENERY.map((item, i) => (
        <View
          key={`s${i}`}
          style={{
            position: 'absolute',
            bottom: 0,
            left: `${item.left + offsetPct}%` as any,
          }}
        >
          {item.type === 'bush' ? (
            <BushSvg w={item.w!} h={item.h} color={item.color!} />
          ) : (
            <FlowerSvg h={item.h} petal={item.petal!} stem={item.stem!} />
          )}
        </View>
      ))}
    </>
  );
}

// ── Main component ───────────────────────────────────────────────────

export function ScrollingEnvironment({ activity, grassColor }: Props) {
  const isMowing = activity === 'mowing';
  const isCharging = activity === 'charging';
  const isOffline = activity === 'idle';

  const translateX = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(translateX);
    if (isMowing) {
      // Dashboard: ground-scroll 3s linear infinite
      translateX.value = 0;
      translateX.value = withRepeat(
        withTiming(-SCREEN_W, { duration: 3000, easing: Easing.linear }),
        -1,
        false,
      );
    } else {
      translateX.value = withTiming(0, { duration: 300 });
    }
  }, [isMowing]);

  const scrollStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <>
      {/* Grass layer (bottom, h=32) — dashboard: h-8 = 32px */}
      <View style={styles.grassContainer} pointerEvents="none">
        {isMowing ? (
          <Animated.View style={[styles.scrollStrip, { width: SCREEN_W * 2 }, scrollStyle]}>
            <SceneryStrip grassColor={grassColor} />
            <SceneryStrip grassColor={grassColor} />
          </Animated.View>
        ) : (
          <SceneryStrip grassColor={grassColor} />
        )}
      </View>

      {/* Scenery layer (bottom+8, h=28) — only for outdoor scenes */}
      {!isOffline && !isCharging && (
        <View style={styles.sceneryContainer} pointerEvents="none">
          {isMowing ? (
            <Animated.View style={[styles.scrollStrip, { width: SCREEN_W * 2 }, scrollStyle]}>
              <View style={{ width: SCREEN_W, height: '100%', position: 'relative' }}>
                <SceneryItems />
              </View>
              <View style={{ width: SCREEN_W, height: '100%', position: 'relative' }}>
                <SceneryItems />
              </View>
            </Animated.View>
          ) : (
            <View style={{ width: SCREEN_W, height: '100%', position: 'relative' }}>
              <SceneryItems />
            </View>
          )}
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  grassContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 32,
    overflow: 'hidden',
  },
  sceneryContainer: {
    position: 'absolute',
    bottom: 8,
    left: 0,
    right: 0,
    height: 28,
    overflow: 'hidden',
  },
  scrollStrip: {
    flexDirection: 'row',
    height: '100%',
  },
});
