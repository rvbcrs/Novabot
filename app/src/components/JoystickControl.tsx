/**
 * JoystickControl — circular touch joystick for manual mower control.
 * Ported from dashboard JoystickControl.tsx.
 *
 * Protocol: start_move → repeated mst (80ms) → stop_move
 * Speed levels: Low [0.15, 0.3], Med [0.3, 0.5], High [0.5, 0.8]
 */
import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  PanResponder,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { ApiClient } from '../services/api';
import { getServerUrl } from '../services/auth';

interface Props {
  sn: string;
  onClose: () => void;
}

const JOYSTICK_SIZE = 200;
const THUMB_SIZE = 60;
const DEAD_ZONE = 0.05;
const SEND_INTERVAL = 80; // ms between velocity sends

type SpeedLevel = 'low' | 'med' | 'high';
const SPEED_LIMITS: Record<SpeedLevel, [number, number]> = {
  low: [0.15, 0.3],
  med: [0.3, 0.5],
  high: [0.5, 0.8],
};

function getHoldType(dx: number, dy: number): number {
  // 1=left, 2=right, 3=forward, 4=backward
  if (Math.abs(dy) > Math.abs(dx)) {
    return dy < 0 ? 3 : 4; // forward / backward
  }
  return dx > 0 ? 2 : 1; // right / left
}

export function JoystickControl({ sn, onClose }: Props) {
  const [speedLevel, setSpeedLevel] = useState<SpeedLevel>('med');
  const [active, setActive] = useState(false);
  const [thumbPos, setThumbPos] = useState({ x: 0, y: 0 });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const velocityRef = useRef({ xw: 0, yv: 0 });
  const startedRef = useRef(false);
  const apiRef = useRef<ApiClient | null>(null);

  useEffect(() => {
    (async () => {
      const url = await getServerUrl();
      if (url) apiRef.current = new ApiClient(url);
    })();
    return () => {
      stopJoystick();
    };
  }, []);

  const startJoystick = useCallback(async (dx: number, dy: number) => {
    if (!apiRef.current || startedRef.current) return;
    startedRef.current = true;
    const holdType = getHoldType(dx, dy);
    try {
      await apiRef.current.joystickStart(sn, holdType);
    } catch { /* ignore */ }
  }, [sn]);

  const stopJoystick = useCallback(async () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (startedRef.current && apiRef.current) {
      startedRef.current = false;
      try {
        await apiRef.current.joystickStop(sn);
      } catch { /* ignore */ }
    }
  }, [sn]);

  const sendVelocity = useCallback(() => {
    if (!apiRef.current || !startedRef.current) return;
    const { xw, yv } = velocityRef.current;
    apiRef.current.joystickMove(sn, xw, yv).catch(() => {});
  }, [sn]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        setActive(true);
      },
      onPanResponderMove: (_e, gesture) => {
        const radius = (JOYSTICK_SIZE - THUMB_SIZE) / 2;
        let dx = gesture.dx;
        let dy = gesture.dy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius) {
          dx = (dx / dist) * radius;
          dy = (dy / dist) * radius;
        }
        setThumbPos({ x: dx, y: dy });

        // Normalize to -1..1
        const nx = dx / radius;
        const ny = -dy / radius; // invert Y (up = forward)
        const [maxLinear, maxAngular] = SPEED_LIMITS[speedLevel];

        if (Math.abs(nx) < DEAD_ZONE && Math.abs(ny) < DEAD_ZONE) {
          velocityRef.current = { xw: 0, yv: 0 };
          return;
        }

        velocityRef.current = {
          xw: ny * maxLinear,   // forward/backward
          yv: -nx * maxAngular, // left/right (inverted for robot frame)
        };

        // Start move on first significant input
        if (!startedRef.current) {
          startJoystick(dx, dy);
          intervalRef.current = setInterval(sendVelocity, SEND_INTERVAL);
        }
      },
      onPanResponderRelease: () => {
        setActive(false);
        setThumbPos({ x: 0, y: 0 });
        velocityRef.current = { xw: 0, yv: 0 };
        stopJoystick();
      },
      onPanResponderTerminate: () => {
        setActive(false);
        setThumbPos({ x: 0, y: 0 });
        velocityRef.current = { xw: 0, yv: 0 };
        stopJoystick();
      },
    }),
  ).current;

  const cycleSpeed = () => {
    setSpeedLevel((prev) =>
      prev === 'low' ? 'med' : prev === 'med' ? 'high' : 'low',
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Manual Control</Text>
        <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="close" size={24} color={colors.textDim} />
        </TouchableOpacity>
      </View>

      {/* Speed selector */}
      <TouchableOpacity style={styles.speedChip} onPress={cycleSpeed} activeOpacity={0.7}>
        <Ionicons name="speedometer-outline" size={16} color={colors.emerald} />
        <Text style={styles.speedText}>{speedLevel.toUpperCase()}</Text>
      </TouchableOpacity>

      {/* Joystick */}
      <View style={styles.joystickContainer}>
        {/* Direction labels */}
        <Text style={[styles.dirLabel, styles.dirTop]}>F</Text>
        <Text style={[styles.dirLabel, styles.dirBottom]}>B</Text>
        <Text style={[styles.dirLabel, styles.dirLeft]}>L</Text>
        <Text style={[styles.dirLabel, styles.dirRight]}>R</Text>

        {/* Joystick ring */}
        <View style={styles.joystickRing} {...panResponder.panHandlers}>
          {/* Crosshair */}
          <View style={styles.crosshairH} />
          <View style={styles.crosshairV} />

          {/* Thumb */}
          <View
            style={[
              styles.thumb,
              {
                transform: [
                  { translateX: thumbPos.x },
                  { translateY: thumbPos.y },
                ],
                backgroundColor: active ? colors.emerald : '#4b5563',
              },
            ]}
          />
        </View>
      </View>

      {/* Emergency stop */}
      <TouchableOpacity
        style={styles.stopButton}
        onPress={stopJoystick}
        activeOpacity={0.7}
      >
        <Ionicons name="stop-circle" size={24} color={colors.white} />
        <Text style={styles.stopText}>STOP</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
    alignItems: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    marginBottom: 16,
  },
  title: { fontSize: 20, fontWeight: '700', color: colors.white },
  speedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: 'rgba(0,212,170,0.1)',
    borderRadius: 20,
    marginBottom: 24,
  },
  speedText: { fontSize: 13, fontWeight: '700', color: colors.emerald },
  joystickContainer: {
    width: JOYSTICK_SIZE + 40,
    height: JOYSTICK_SIZE + 40,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  joystickRing: {
    width: JOYSTICK_SIZE,
    height: JOYSTICK_SIZE,
    borderRadius: JOYSTICK_SIZE / 2,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  crosshairH: {
    position: 'absolute',
    width: '60%',
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  crosshairV: {
    position: 'absolute',
    width: 1,
    height: '60%',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    position: 'absolute',
  },
  dirLabel: {
    position: 'absolute',
    fontSize: 14,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.2)',
  },
  dirTop: { top: 0 },
  dirBottom: { bottom: 0 },
  dirLeft: { left: 0 },
  dirRight: { right: 0 },
  stopButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    height: 48,
    borderRadius: 12,
    backgroundColor: colors.red,
    marginTop: 24,
  },
  stopText: { fontSize: 16, fontWeight: '700', color: colors.white },
});
