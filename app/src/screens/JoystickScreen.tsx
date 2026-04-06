/**
 * Joystick screen — manual control of the mower via touch joystick.
 *
 * Uses Socket.io events (joystick:start/move/stop) which the server
 * translates to MQTT commands (start_move/mst/stop_move).
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  GestureDetector,
  Gesture,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { colors } from '../theme/colors';
import { useMowerState } from '../hooks/useMowerState';
import { getSocket } from '../services/socket';
import { getServerUrl } from '../services/auth';
import { DemoBanner } from '../components/DemoBanner';
import { useDemo } from '../context/DemoContext';
import { useI18n } from '../i18n';

const { width: SCREEN_W } = Dimensions.get('window');
const JOYSTICK_SIZE = Math.min(SCREEN_W * 0.65, 260);
const THUMB_SIZE = 64;
const DEAD_ZONE = 0.05;
const THROTTLE_MS = 80;

const SPEED_LEVELS = [
  { labelKey: 'slow', linear: 0.15, angular: 0.3 },
  { labelKey: 'normal', linear: 0.3, angular: 0.5 },
  { labelKey: 'fast', linear: 0.5, angular: 0.8 },
];

function getHoldType(x: number, y: number): number {
  if (Math.abs(y) >= Math.abs(x)) {
    return y < 0 ? 3 : 4; // up = forward(3), down = backward(4)
  }
  return x < 0 ? 1 : 2; // left(1), right(2)
}

export default function JoystickScreen() {
  const insets = useSafeAreaInsets();
  const { devices } = useMowerState();
  const demo = useDemo();
  const { t } = useI18n();

  const mower = [...devices.values()].find(d => d.deviceType === 'mower' && d.online);
  const sn = mower?.sn ?? '';

  const [active, setActive] = useState(false);
  const [thumbX, setThumbX] = useState(0);
  const [thumbY, setThumbY] = useState(0);
  const [speedLevel, setSpeedLevel] = useState(1);
  const [lightOn, setLightOn] = useState(false);
  const activeRef = useRef(false);
  const lastSendRef = useRef(0);
  const speedRef = useRef(1);

  useEffect(() => { speedRef.current = speedLevel; }, [speedLevel]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (activeRef.current) {
        const socket = getSocket();
        if (socket) socket.emit('joystick:stop', { sn });
      }
    };
  }, [sn]);

  const sendMove = useCallback((dx: number, dy: number) => {
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < DEAD_ZONE) return;

    const now = Date.now();
    if (now - lastSendRef.current < THROTTLE_MS) return;
    lastSendRef.current = now;

    const socket = getSocket();
    if (!socket) return;

    const holdType = getHoldType(dx, dy);
    const lvl = SPEED_LEVELS[speedRef.current];
    socket.emit('joystick:move', {
      sn,
      holdType,
      mst: {
        x_w: Math.round(dist * lvl.linear * 100) / 100,
        y_v: Math.round(Math.abs(dx) * lvl.angular * 100) / 100,
        z_g: 0,
      },
    });
  }, [sn]);

  const stopAll = useCallback(() => {
    activeRef.current = false;
    setActive(false);
    setThumbX(0);
    setThumbY(0);
    const socket = getSocket();
    if (socket) socket.emit('joystick:stop', { sn });
  }, [sn]);

  const radius = JOYSTICK_SIZE / 2;

  const handleGestureStart = useCallback((x: number, y: number) => {
    activeRef.current = true;
    setActive(true);
    lastSendRef.current = 0;

    let dx = x - radius;
    let dy = y - radius;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > radius) { dx = dx / dist * radius; dy = dy / dist * radius; }
    const nx = dx / radius;
    const ny = dy / radius;
    setThumbX(dx);
    setThumbY(dy);

    const socket = getSocket();
    if (socket) {
      const holdType = getHoldType(nx, ny) || 3;
      socket.emit('joystick:start', { sn, holdType });
      sendMove(nx, ny);
    }
  }, [sn, radius, sendMove]);

  const handleGestureUpdate = useCallback((x: number, y: number) => {
    if (!activeRef.current) return;
    let dx = x - radius;
    let dy = y - radius;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > radius) { dx = dx / dist * radius; dy = dy / dist * radius; }
    setThumbX(dx);
    setThumbY(dy);
    sendMove(dx / radius, dy / radius);
  }, [radius, sendMove]);

  const panGesture = Gesture.Pan()
    .onStart((e) => {
      runOnJS(handleGestureStart)(e.x, e.y);
    })
    .onUpdate((e) => {
      runOnJS(handleGestureUpdate)(e.x, e.y);
    })
    .onEnd(() => {
      runOnJS(stopAll)();
    })
    .onFinalize(() => {
      runOnJS(stopAll)();
    });

  const dist = Math.sqrt(thumbX * thumbX + thumbY * thumbY) / radius;
  const lvl = SPEED_LEVELS[speedLevel];
  const speedMs = (dist * lvl.linear).toFixed(2);

  const battery = parseInt(mower?.sensors?.battery_power ?? mower?.sensors?.battery_capacity ?? '0', 10) || 0;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={[styles.container, { paddingTop: insets.top }]}>


        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>{t('manualControl')}</Text>
          {mower && (
            <View style={styles.statusRow}>
              <View style={[styles.dot, { backgroundColor: mower.online ? colors.green : colors.red }]} />
              <Text style={styles.statusText}>{sn}</Text>
              <Text style={[styles.statusText, { color: colors.textMuted, marginLeft: 8 }]}>
                {battery}%
              </Text>
            </View>
          )}
        </View>

        {!mower?.online && !demo.enabled ? (
          <View style={styles.offlineBox}>
            <Ionicons name="alert-circle" size={32} color={colors.red} />
            <Text style={styles.offlineText}>{t('mowerOffline')}</Text>
            <Text style={styles.offlineSubtext}>{t('connectMowerToMap')}</Text>
          </View>
        ) : (
          <>
            {/* Speed status */}
            <View style={styles.speedInfo}>
              {active ? (
                <Text style={styles.speedText}>{speedMs} m/s</Text>
              ) : (
                <Text style={[styles.speedText, { color: colors.textMuted }]}>{t('dragToMove')}</Text>
              )}
            </View>

            {/* Joystick */}
            <View style={styles.joystickContainer}>
              <GestureDetector gesture={panGesture}>
                <View style={[styles.joystickBase, { width: JOYSTICK_SIZE, height: JOYSTICK_SIZE }]}>
                  {/* Crosshair */}
                  <View style={styles.crossV} />
                  <View style={styles.crossH} />

                  {/* Direction labels */}
                  <Text style={[styles.dirLabel, styles.dirTop]}>F</Text>
                  <Text style={[styles.dirLabel, styles.dirBottom]}>B</Text>
                  <Text style={[styles.dirLabel, styles.dirLeft]}>L</Text>
                  <Text style={[styles.dirLabel, styles.dirRight]}>R</Text>

                  {/* Thumb */}
                  <View
                    style={[
                      styles.thumb,
                      active && styles.thumbActive,
                      {
                        transform: [
                          { translateX: thumbX },
                          { translateY: thumbY },
                        ],
                      },
                    ]}
                  />
                </View>
              </GestureDetector>
            </View>

            {/* Speed level selector */}
            <View style={styles.speedRow}>
              {SPEED_LEVELS.map((lvl, i) => (
                <TouchableOpacity
                  key={i}
                  style={[styles.speedBtn, speedLevel === i && styles.speedBtnActive]}
                  onPress={() => setSpeedLevel(i)}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={i === 0 ? 'speedometer-outline' : i === 1 ? 'speedometer' : 'flash'}
                    size={16}
                    color={speedLevel === i ? colors.white : colors.textMuted}
                  />
                  <Text style={[styles.speedBtnText, speedLevel === i && { color: colors.white }]}>
                    {t(lvl.labelKey)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Emergency stop */}
            <TouchableOpacity
              style={[styles.stopBtn, !active && { opacity: 0.3 }]}
              onPress={stopAll}
              disabled={!active}
              activeOpacity={0.7}
            >
              <Ionicons name="stop-circle" size={24} color={colors.white} />
              <Text style={styles.stopText}>{t('emergencyStop')}</Text>
            </TouchableOpacity>

            {/* Headlight toggle */}
            <TouchableOpacity
              style={[styles.lightBtn, lightOn && styles.lightBtnActive]}
              onPress={() => {
                const next = !lightOn;
                setLightOn(next);
                getServerUrl().then(url => {
                  if (url) fetch(`${url}/api/dashboard/command/${encodeURIComponent(sn)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: { set_para_info: { headlight: next ? 2 : 0 } } }),
                  });
                });
              }}
              activeOpacity={0.7}
            >
              <Ionicons name={lightOn ? 'flashlight' : 'flashlight-outline'} size={20} color={lightOn ? colors.amber : colors.textMuted} />
              <Text style={[styles.lightText, !lightOn && { color: colors.textMuted }]}>{lightOn ? t('lightOn') : t('headlight')}</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
  },
  header: {
    width: '100%',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.white,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    fontSize: 13,
    color: colors.textDim,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  offlineBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  offlineText: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.white,
  },
  offlineSubtext: {
    fontSize: 14,
    color: colors.textMuted,
  },
  speedInfo: {
    marginVertical: 8,
    height: 24,
  },
  speedText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.emerald,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  joystickContainer: {
    marginVertical: 16,
  },
  joystickBase: {
    borderRadius: JOYSTICK_SIZE / 2,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  crossV: {
    position: 'absolute',
    width: 1,
    height: '100%',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  crossH: {
    position: 'absolute',
    height: 1,
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  dirLabel: {
    position: 'absolute',
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.2)',
  },
  dirTop: { top: 8, alignSelf: 'center' },
  dirBottom: { bottom: 8, alignSelf: 'center' },
  dirLeft: { left: 10, top: '50%', marginTop: -7 },
  dirRight: { right: 10, top: '50%', marginTop: -7 },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  thumbActive: {
    backgroundColor: colors.emerald,
    borderColor: colors.white,
    shadowColor: colors.emerald,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 8,
  },
  speedRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
  },
  speedBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  speedBtnActive: {
    backgroundColor: 'rgba(16,185,129,0.2)',
    borderColor: colors.emerald,
  },
  speedBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textMuted,
  },
  stopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 24,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(239,68,68,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.3)',
  },
  stopText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.white,
  },
  lightBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 16,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  lightBtnActive: {
    backgroundColor: 'rgba(245,158,11,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.3)',
  },
  lightText: {
    fontSize: 13,
    color: colors.amber,
    fontWeight: '600',
  },
});
