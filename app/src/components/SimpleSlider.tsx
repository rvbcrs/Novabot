/**
 * SimpleSlider — lightweight horizontal slider without external deps.
 *
 * Uses react-native-gesture-handler's Pan + Tap gestures. The track fills the
 * container width; user can tap anywhere to set the value or drag the thumb.
 * Emits onChange continuously during drag and onCommit on release so you can
 * throttle network calls (mower set_para_info) to release-only.
 */
import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, LayoutChangeEvent, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useStyles, useTheme, type Colors } from '../theme';

interface Props {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  trackColor?: string;
  fillColor?: string;
  thumbColor?: string;
  label?: string;
  valueSuffix?: string;
  style?: ViewStyle;
  onChange?: (v: number) => void;
  onCommit?: (v: number) => void;
  disabled?: boolean;
}

export function SimpleSlider({
  value,
  min = 0,
  max = 100,
  step = 1,
  trackColor = 'rgba(255,255,255,0.1)',
  fillColor,
  thumbColor = '#ffffff',
  label,
  valueSuffix = '',
  style,
  onChange,
  onCommit,
  disabled = false,
}: Props) {
  const [width, setWidth] = useState(0);
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();

  const onLayout = (e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
  };

  const clamp = useCallback((n: number): number => {
    let v = Math.max(min, Math.min(max, n));
    if (step > 0) v = Math.round(v / step) * step;
    return v;
  }, [min, max, step]);

  const fromX = useCallback((x: number): number => {
    if (width <= 0) return value;
    const ratio = Math.max(0, Math.min(1, x / width));
    return clamp(min + ratio * (max - min));
  }, [width, value, min, max, clamp]);

  const commitValue = useCallback((v: number) => {
    onCommit?.(clamp(v));
  }, [onCommit, clamp]);

  const updateValue = useCallback((v: number) => {
    onChange?.(clamp(v));
  }, [onChange, clamp]);

  const tap = Gesture.Tap()
    .enabled(!disabled)
    .onEnd((e) => {
      'worklet';
      const v = (() => {
        if (width <= 0) return value;
        const ratio = Math.max(0, Math.min(1, e.x / width));
        return min + ratio * (max - min);
      })();
      runOnJS(updateValue)(v);
      runOnJS(commitValue)(v);
    });

  const pan = Gesture.Pan()
    .enabled(!disabled)
    .onUpdate((e) => {
      'worklet';
      const v = (() => {
        if (width <= 0) return value;
        const ratio = Math.max(0, Math.min(1, e.x / width));
        return min + ratio * (max - min);
      })();
      runOnJS(updateValue)(v);
    })
    .onEnd((e) => {
      'worklet';
      const v = (() => {
        if (width <= 0) return value;
        const ratio = Math.max(0, Math.min(1, e.x / width));
        return min + ratio * (max - min);
      })();
      runOnJS(commitValue)(v);
    });

  const composed = Gesture.Simultaneous(tap, pan);

  const pct = max > min ? ((value - min) / (max - min)) : 0;
  const fillW = Math.max(0, Math.min(1, pct)) * width;
  const thumbLeft = Math.max(0, Math.min(width - 20, fillW - 10));

  const fill = fillColor ?? colors.emerald;

  return (
    <View style={style}>
      {(label || valueSuffix !== undefined) && (
        <View style={styles.header}>
          {label && <Text style={styles.label}>{label}</Text>}
          <Text style={styles.value}>{Math.round(value)}{valueSuffix}</Text>
        </View>
      )}
      <GestureDetector gesture={composed}>
        <View style={styles.hitArea} onLayout={onLayout}>
          <View style={[styles.track, { backgroundColor: trackColor }]}>
            <View style={[styles.fill, { width: fillW, backgroundColor: fill }]} />
          </View>
          <View
            style={[
              styles.thumb,
              { left: thumbLeft, backgroundColor: thumbColor },
              disabled && { opacity: 0.4 },
            ]}
          />
        </View>
      </GestureDetector>
    </View>
  );
}

const TRACK_HEIGHT = 6;
const THUMB_SIZE = 20;

const makeStyles = (c: Colors) => StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  label: {
    fontSize: 13,
    color: c.textDim,
    fontWeight: '600',
  },
  value: {
    fontSize: 13,
    color: c.white,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  hitArea: {
    height: THUMB_SIZE + 12,
    justifyContent: 'center',
  },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: TRACK_HEIGHT / 2,
  },
  thumb: {
    position: 'absolute',
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    top: (THUMB_SIZE + 12 - THUMB_SIZE) / 2,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
});
