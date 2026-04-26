/**
 * MowingProgressMap — live mini map during mowing.
 * Shows polygon, coverage stripes, mower trail, mower position + heading, charger.
 * Optional interactive mode: pinch-to-zoom + pan + double-tap to reset.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, type LayoutChangeEvent } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import Svg, {
  Polygon as SvgPolygon,
  Polyline,
  Line,
  ClipPath,
  Defs,
  G,
  Circle,
  Path,
  Image as SvgImage,
} from 'react-native-svg';
import { useTheme, useStyles, type Colors } from '../theme';

type MapScheme = 'light' | 'dark';

const MAP_PALETTE: Record<MapScheme, {
  polygonFill: string;
  polygonStroke: string;
  plannedStroke: string;
  finishedStroke: string;
  stripeStroke: string;
  trailStroke: string;
  liveCoverStroke: string;
  chargerCircleFill: string;
  chargerCircleStroke: string;
  chargerBoltFill: string;
  obstacleFill: string;
  obstacleStroke: string;
  progressTextColor: string;
}> = {
  dark: {
    polygonFill: 'rgba(34,197,94,0.12)',
    polygonStroke: '#22c55e',
    plannedStroke: 'rgba(255,255,255,0.22)',
    finishedStroke: 'rgba(34,197,94,0.85)',
    stripeStroke: 'rgba(34,197,94,0.15)',
    trailStroke: 'rgba(34,197,94,0.5)',
    liveCoverStroke: '#fbbf24',
    chargerCircleFill: 'rgba(245,158,11,0.2)',
    chargerCircleStroke: '#f59e0b',
    chargerBoltFill: '#f59e0b',
    obstacleFill: 'rgba(239,68,68,0.25)',
    obstacleStroke: '#ef4444',
    progressTextColor: '#ffffff',
  },
  light: {
    polygonFill: 'rgba(34,197,94,0.25)',
    polygonStroke: '#16a34a',
    plannedStroke: 'rgba(21,128,61,0.45)',
    finishedStroke: 'rgba(21,128,61,0.85)',
    stripeStroke: 'rgba(22,163,74,0.28)',
    trailStroke: '#15803d',
    liveCoverStroke: '#f59e0b',
    chargerCircleFill: 'rgba(245,158,11,0.2)',
    chargerCircleStroke: '#f59e0b',
    chargerBoltFill: '#f59e0b',
    obstacleFill: 'rgba(239,68,68,0.25)',
    obstacleStroke: '#ef4444',
    progressTextColor: '#14532d',
  },
};

interface LocalPoint {
  x: number;
  y: number;
}

interface Props {
  polygon: LocalPoint[];
  progress: number;         // 0-100 (cov_ratio)
  pathDirection: number;    // degrees
  size?: number;            // If omitted the map fills its parent (onLayout).
  fill?: boolean;           // Force "fill parent" mode even if size given (HomeScreen expanded view).
  interactive?: boolean;    // Enable pinch + pan + double-tap gestures.
  trail?: LocalPoint[];     // mowed path in local meters
  plannedPaths?: Array<{ id: string; points: LocalPoint[] }>;  // planned mowing paths
  finishedAreas?: string[]; // IDs of planned paths fully covered (from mower's finished_area)
  activeAreaId?: string;    // ID of the planned path currently being mowed (from covering_area.area_id)
  activeAreaPoints?: number; // # points of the active sub-path already mowed (from covering_area.points)
  liveCoverSegment?: LocalPoint[]; // recent cover_path.covered.covering points
  obstacles?: Array<{ id: string; points: LocalPoint[] }>;    // obstacle polygons
  mowerPos?: LocalPoint | null;  // mower position in local meters
  mowerHeading?: number;    // radians
  showProgressOverlay?: boolean; // show big percentage overlay (default: true)
  /**
   * Real dock pose in map frame. Null falls back to (0,0). Stock
   * heading-discovery shifts the localization origin away from the
   * physical dock, so the polygon's (0,0) is NOT where the dock is —
   * the user-visible discrepancy is "charger icon floats inside the
   * polygon when in reality the dock is on the boundary edge".
   */
  chargerPose?: LocalPoint | null;
}

function toSvg(
  point: LocalPoint,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  size: number,
  padding: number,
) {
  const drawSize = size - padding * 2;
  const xRange = bounds.maxX - bounds.minX || 0.1;
  const yRange = bounds.maxY - bounds.minY || 0.1;
  const scale = Math.min(drawSize / xRange, drawSize / yRange);
  return {
    x: padding + (bounds.maxX - point.x) * scale + (drawSize - xRange * scale) / 2,
    y: padding + (point.y - bounds.minY) * scale + (drawSize - yRange * scale) / 2,
  };
}

function computeBounds(points: LocalPoint[], extra: LocalPoint[]): { minX: number; maxX: number; minY: number; maxY: number } {
  const all = [...points, ...extra];
  if (all.length === 0) return { minX: 0, maxX: 1, minY: 0, maxY: 1 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of all) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = Math.max(maxX - minX, maxY - minY) * 0.1 || 0.5;
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
}

function generateStripes(
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  direction: number,
  progress: number,
  spacing: number,
): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const diagonal = Math.sqrt((bounds.maxX - bounds.minX) ** 2 + (bounds.maxY - bounds.minY) ** 2);
  // Stripes run ALONG the path direction, spacing perpendicular
  // toSvg flips both axes, so add 180° to compensate
  const rad = ((direction + 180) * Math.PI) / 180;
  const perpRad = ((direction + 270) * Math.PI) / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  const px = Math.cos(perpRad), py = Math.sin(perpRad);
  const totalStripes = Math.ceil(diagonal / spacing);
  const progressStripes = Math.floor((totalStripes * progress) / 100);
  const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (let i = -totalStripes; i <= totalStripes; i++) {
    if (Math.abs(i) > progressStripes) continue;
    const ox = cx + px * i * spacing;
    const oy = cy + py * i * spacing;
    lines.push({ x1: ox - dx * diagonal, y1: oy - dy * diagonal, x2: ox + dx * diagonal, y2: oy + dy * diagonal });
  }
  return lines;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const makeStyles = (_c: Colors) => StyleSheet.create({
  container: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  overlay: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressText: {
    fontSize: 28,
    fontWeight: '800',
    // color is set per-scheme via mapPalette.progressTextColor in the render tree.
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
});

export function MowingProgressMap({
  polygon,
  progress,
  pathDirection,
  size,
  fill,
  interactive = false,
  trail,
  plannedPaths,
  finishedAreas,
  activeAreaId,
  activeAreaPoints,
  liveCoverSegment,
  obstacles,
  mowerPos,
  mowerHeading,
  showProgressOverlay = true,
  chargerPose,
}: Props) {
  const { colorScheme } = useTheme();
  const mapPalette = MAP_PALETTE[colorScheme];
  const styles = useStyles(makeStyles);

  const finishedSet = useMemo(
    () => new Set(finishedAreas ?? []),
    [finishedAreas],
  );
  const useFill = fill || size == null;
  const [measured, setMeasured] = useState<number>(0);
  const renderSize = useFill ? (measured || 200) : (size ?? 200);

  // ── Gesture state (only used when `interactive` is true) ─────────
  const scale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedScale = useSharedValue(1);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const pinchGesture = Gesture.Pinch()
    .onStart(() => {
      savedScale.value = scale.value;
    })
    .onUpdate((e) => {
      scale.value = Math.min(Math.max(savedScale.value * e.scale, 0.5), 8);
    });

  const panGesture = Gesture.Pan()
    .onStart(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    })
    .onUpdate((e) => {
      translateX.value = savedTranslateX.value + e.translationX;
      translateY.value = savedTranslateY.value + e.translationY;
    });

  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      scale.value = withTiming(1, { duration: 260 });
      translateX.value = withTiming(0, { duration: 260 });
      translateY.value = withTiming(0, { duration: 260 });
    });

  const composedGesture = Gesture.Simultaneous(
    pinchGesture,
    panGesture,
    doubleTapGesture,
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  const padding = 14;
  // Use the captured dock pose if available; fall back to (0,0).
  const charger: LocalPoint = chargerPose
    ? { x: chargerPose.x, y: chargerPose.y }
    : { x: 0, y: 0 };

  const bounds = useMemo(() => {
    const extra = [charger];
    if (mowerPos) extra.push(mowerPos);
    if (trail && trail.length > 0) extra.push(...trail);
    return computeBounds(polygon, extra);
  }, [polygon, mowerPos, trail]);

  const svgPoints = useMemo(
    () => polygon.map(p => toSvg(p, bounds, renderSize, padding)),
    [polygon, bounds, renderSize],
  );
  const pointsStr = svgPoints.map(p => `${p.x},${p.y}`).join(' ');
  // Add 180° to compensate for both-axes-flipped rendering in toSvg
  const stripes = useMemo(
    () => generateStripes(
      { minX: padding, maxX: renderSize - padding, minY: padding, maxY: renderSize - padding },
      pathDirection + 180,
      progress,
      5,
    ),
    [renderSize, pathDirection, progress],
  );

  const trailSvg = useMemo(
    () => (trail ?? []).map(p => toSvg(p, bounds, renderSize, padding)),
    [trail, bounds, renderSize],
  );

  const chargerSvg = toSvg(charger, bounds, renderSize, padding);
  const mowerSvg = mowerPos ? toSvg(mowerPos, bounds, renderSize, padding) : null;

  const onLayout = useFill
    ? (e: LayoutChangeEvent) => {
        const { width, height } = e.nativeEvent.layout;
        const s = Math.min(width, height);
        if (s > 0 && Math.abs(s - measured) > 1) setMeasured(s);
      }
    : undefined;

  if (svgPoints.length < 3) {
    // Keep the slot so the panel doesn't collapse when we don't have a polygon yet.
    return useFill ? <View style={styles.flex} onLayout={onLayout} /> : null;
  }

  const svgContent = (
    <Svg width={renderSize} height={renderSize} viewBox={`0 0 ${renderSize} ${renderSize}`}>
      <Defs>
        <ClipPath id="polyClipHome">
          <SvgPolygon points={pointsStr} />
        </ClipPath>
      </Defs>

      {/* Polygon background */}
      <SvgPolygon points={pointsStr} fill={mapPalette.polygonFill} stroke={mapPalette.polygonStroke} strokeWidth={1.5} strokeLinejoin="round" />

      {/* Planned mowing paths OR direction stripes as fallback.
          Finished sub-areas (from mower's cover_path.covered.finished_area)
          render as the "mowed" line — persists across app reloads because
          the mower re-reports finished_area every report_state_timer_data tick. */}
      {plannedPaths && plannedPaths.length > 0 ? (
        <G clipPath="url(#polyClipHome)">
          {/* 1. Alle nog niet-voltooide planned paths — dunne witte hint-lijn.
              Inclusief het actieve sub-path zodat ook daar de volledige plan-
              lijn zichtbaar blijft; de al-gedekte portie wordt hieronder in
              emerald overheen getekend. */}
          {plannedPaths.filter(p => !finishedSet.has(p.id)).map((path) => (
            <Polyline
              key={`plan-${path.id}`}
              points={path.points.map(p => toSvg(p, bounds, renderSize, padding)).map(p => `${p.x},${p.y}`).join(' ')}
              fill="none" stroke={mapPalette.plannedStroke} strokeWidth={1} strokeLinecap="round" strokeLinejoin="round"
            />
          ))}
          {/* 2. Finished sub-areas — thick dark green, like Novabot's mowed line */}
          {plannedPaths.filter(p => finishedSet.has(p.id)).map((path) => (
            <Polyline
              key={`done-${path.id}`}
              points={path.points.map(p => toSvg(p, bounds, renderSize, padding)).map(p => `${p.x},${p.y}`).join(' ')}
              fill="none" stroke={mapPalette.finishedStroke} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round"
            />
          ))}
          {/* 3. Currently mowing sub-area — split on activeAreaPoints so the
              mower icon always sits at the "frontier" between done and to-do
              (matches Novabot's rendering). The portion UP TO the current
              point count renders as solid emerald (like finished sub-paths);
              the rest is thin stippel showing what's still coming. */}
          {activeAreaId && plannedPaths.filter(p => p.id === activeAreaId).map((path) => {
            // Alleen de al-gedekte portie van het actieve sub-path tekenen —
            // net zoals Novabot doet. De to-do-portie helemaal niet tonen zodat
            // de mower icon vanzelf op de "frontier" komt te staan zonder dat
            // er een tweede kleurvlak aan de toekomstige kant verschijnt.
            const splitAt = Math.max(0, Math.min(
              typeof activeAreaPoints === 'number' && activeAreaPoints > 0
                ? activeAreaPoints
                : 0,
              path.points.length,
            ));
            const done = path.points.slice(0, splitAt);
            if (done.length < 2) return null;
            const toStr = (pts: LocalPoint[]) => pts.map(p => toSvg(p, bounds, renderSize, padding)).map(p => `${p.x},${p.y}`).join(' ');
            return (
              <Polyline
                key={`active-${path.id}`}
                points={toStr(done)}
                fill="none" stroke={mapPalette.finishedStroke} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round"
              />
            );
          })}
        </G>
      ) : (
        <G clipPath="url(#polyClipHome)">
          {stripes.map((l, i) => (
            <Line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={mapPalette.stripeStroke} strokeWidth={1} />
          ))}
        </G>
      )}

      {/* Mowed trail (thick — shows actual GPS/odom positions this session;
          layered on top of finished_area to show the live movement accurately) */}
      {trailSvg.length > 1 && (
        <G clipPath="url(#polyClipHome)">
          <Polyline
            points={trailSvg.map(p => `${p.x},${p.y}`).join(' ')}
            fill="none" stroke={mapPalette.trailStroke} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round"
          />
        </G>
      )}

      {/* Live cover segment from mower (covering) — tiny red tip of where
          the mower is actually cutting right now. */}
      {liveCoverSegment && liveCoverSegment.length >= 2 && (
        <G clipPath="url(#polyClipHome)">
          <Polyline
            points={liveCoverSegment.map(p => toSvg(p, bounds, renderSize, padding)).map(p => `${p.x},${p.y}`).join(' ')}
            fill="none" stroke={mapPalette.liveCoverStroke} strokeWidth={3} strokeLinecap="round"
          />
        </G>
      )}

      {/* Charger */}
      <Circle cx={chargerSvg.x} cy={chargerSvg.y} r={7} fill={mapPalette.chargerCircleFill} stroke={mapPalette.chargerCircleStroke} strokeWidth={1.5} />
      <Path d={`M${chargerSvg.x - 2} ${chargerSvg.y - 3} L${chargerSvg.x + 2} ${chargerSvg.y - 3} L${chargerSvg.x + 0.5} ${chargerSvg.y} L${chargerSvg.x + 2} ${chargerSvg.y} L${chargerSvg.x - 1} ${chargerSvg.y + 3.5} L${chargerSvg.x} ${chargerSvg.y + 0.5} L${chargerSvg.x - 1.5} ${chargerSvg.y + 0.5} Z`} fill={mapPalette.chargerBoltFill} />

      {/* Mower icon + heading */}
      {mowerSvg && (() => {
        // Icon points RIGHT at 0°; flipped X-axis → negate heading; +360 offset
        const degHeading = mowerHeading != null ? -(mowerHeading * 180 / Math.PI) + 180 : 0;
        const mowerSize = 16;
        return (
          <G transform={`translate(${mowerSvg.x}, ${mowerSvg.y}) rotate(${degHeading})`}>
            <SvgImage
              x={-mowerSize / 2}
              y={-mowerSize * 0.35}
              width={mowerSize}
              height={mowerSize * 0.68}
              href={require('../../assets/lawn_mower.png')}
            />
          </G>
        );
      })()}

      {/* Obstacles */}
      {obstacles && obstacles.map((obs) => {
        const obsSvg = obs.points.map(p => toSvg(p, bounds, renderSize, padding));
        return (
          <SvgPolygon
            key={`obs-${obs.id}`}
            points={obsSvg.map(p => `${p.x},${p.y}`).join(' ')}
            fill={mapPalette.obstacleFill} stroke={mapPalette.obstacleStroke} strokeWidth={1} strokeLinejoin="round" strokeDasharray="3,2"
          />
        );
      })}

      {/* Outline on top */}
      <SvgPolygon points={pointsStr} fill="none" stroke={mapPalette.polygonStroke} strokeWidth={1.5} strokeLinejoin="round" />
    </Svg>
  );

  const outerStyle = useFill ? styles.flex : { width: renderSize, height: renderSize };

  if (interactive) {
    return (
      <View style={[styles.container, outerStyle]} onLayout={onLayout}>
        <GestureDetector gesture={composedGesture}>
          <Animated.View style={[{ width: renderSize, height: renderSize }, animatedStyle]}>
            {svgContent}
          </Animated.View>
        </GestureDetector>
        {showProgressOverlay && (
          <View pointerEvents="none" style={styles.overlay}>
            <Text style={[styles.progressText, { color: mapPalette.progressTextColor }]}>{progress}%</Text>
          </View>
        )}
      </View>
    );
  }

  return (
    <View style={[styles.container, outerStyle]} onLayout={onLayout}>
      {svgContent}
      {showProgressOverlay && (
        <View pointerEvents="none" style={styles.overlay}>
          <Text style={[styles.progressText, { color: mapPalette.progressTextColor }]}>{progress}%</Text>
        </View>
      )}
    </View>
  );
}
