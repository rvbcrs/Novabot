/**
 * BatteryIndicator — top-right battery icon inside the MowerScene.
 * Matches dashboard MowerAnimation battery display exactly.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface Props {
  battery: number;
}

export function BatteryIndicator({ battery }: Props) {
  const color = battery >= 30 ? '#34d399' : battery >= 15 ? '#fbbf24' : '#ef4444';
  const fillWidth = Math.max(battery, 5);

  return (
    <View style={styles.container}>
      {/* Battery outline */}
      <View style={styles.batteryOutline}>
        {/* Battery nub */}
        <View style={styles.batteryNub} />
        {/* Fill */}
        <View style={[styles.batteryFill, { width: `${fillWidth}%` as any, backgroundColor: color }]} />
      </View>
      {/* Percentage text */}
      <Text style={styles.text}>{battery}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  batteryOutline: {
    width: 28,
    height: 14,
    borderRadius: 2,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    position: 'relative',
    overflow: 'hidden',
  },
  batteryNub: {
    position: 'absolute',
    right: -4,
    top: 3,
    width: 3,
    height: 6,
    borderTopRightRadius: 2,
    borderBottomRightRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  batteryFill: {
    position: 'absolute',
    left: 1,
    top: 1,
    bottom: 1,
    borderRadius: 1,
  },
  text: {
    fontSize: 10,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.7)',
    fontVariant: ['tabular-nums'],
  },
});
