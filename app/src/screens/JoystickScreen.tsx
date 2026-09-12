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
  Alert,
  Modal,
  Animated,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  GestureDetector,
  Gesture,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { WebView } from 'react-native-webview';
import { useStyles, useTheme, type Colors } from '../theme';
import { useActiveMower } from '../hooks/useActiveMower';
import { useHeadlightBrightness } from '../hooks/useHeadlightBrightness';
import { getSocket } from '../services/socket';
import { getServerUrl } from '../services/auth';
import { ApiClient } from '../services/api';
import { DemoBanner } from '../components/DemoBanner';
import { useDemo } from '../context/DemoContext';
import { useI18n } from '../i18n';
import { isOpenNovaFirmware } from '../utils/firmwareCapability';
import { fixQualityLabel } from '../utils/fixQuality';

const { width: SCREEN_W } = Dimensions.get('window');
const JOYSTICK_SIZE = Math.min(SCREEN_W * 0.65, 260);
const THUMB_SIZE = 64;
const DEAD_ZONE = 0.05;
const THROTTLE_MS = 80;

// Matcht BLE joystick (MappingScreen.tsx) — die snelheden zijn live
// bewezen comfortabel en reageren 1:1 op firmware (mst *100 = gebruikt).
const SPEED_LEVELS = [
  { labelKey: 'slow', linear: 0.5, angular: 0.4 },
  { labelKey: 'normal', linear: 1.0, angular: 0.8 },
  { labelKey: 'fast', linear: 2.0, angular: 1.5 },
];

function getHoldType(x: number, y: number): number {
  if (Math.abs(y) >= Math.abs(x)) {
    return y < 0 ? 3 : 4; // up = forward(3), down = backward(4)
  }
  return x < 0 ? 1 : 2; // left(1), right(2)
}

/** Spinning saw-blade icon — same pattern as HomeScreen's BladeIcon.
 *  Loops a 700ms 360° rotation while `spinning` is true. Used in the
 *  manual-control blade banner so the operator can SEE the firmware
 *  actually engaged the motor (chassis_control_node publishes RPM on
 *  /blade_speed_get and extended_commands.py relays it as
 *  sensors.blade_speed). */
function BladeSpinIcon({ size, color, spinning }: { size: number; color: string; spinning: boolean }) {
  const rotation = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!spinning) {
      rotation.stopAnimation();
      rotation.setValue(0);
      return;
    }
    rotation.setValue(0);
    const loop = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 700,
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    loop.start();
    return () => { loop.stop(); };
  }, [spinning, rotation]);
  const spin = rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View style={{ transform: [{ rotate: spin }] }}>
      <MaterialCommunityIcons name="saw-blade" size={size} color={color} />
    </Animated.View>
  );
}

export default function JoystickScreen() {
  const insets = useSafeAreaInsets();
  const demo = useDemo();
  const { t } = useI18n();
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();

  const { activeMower } = useActiveMower();
  const mower = activeMower && activeMower.online ? activeMower : null;
  const sn = mower?.sn ?? '';

  // Manual mowing blade-on flag. Hoisted here so busyWithTask can reference
  // it: when the user turns on the manual blade, extended_commands.py forces
  // a RobotStatus override (task_mode=1, work_status=10, merged_work_status
  // =COVER) so STM32 enables the cutting motor. That override propagates
  // back through mqtt_node → MQTT → the sensor cache, which would normally
  // trip busyWithTask and lock the joystick. Suppress that lock while the
  // user explicitly drives the blade themselves — the COVERING state is
  // synthetic, not a real autonomous task.
  const [bladeOn, setBladeOn] = useState(false);
  const bladeOnRef = useRef(false);
  // Physical blade RPM from chassis `/blade_speed_get` (relayed by
  // extended_commands.py blade-relay). Drives the saw-blade spin
  // animation + rpm chip so the operator can tell the firmware actually
  // engaged the motor, instead of trusting the local toggle.
  const bladeSpeed = parseInt(mower?.sensors?.blade_speed ?? '0', 10) || 0;

  // Mower physically on the charging dock — `battery_state` is published
  // by the charger ESP32 over LoRa and reaches us through the sensor
  // cache. Used to block the blade button: enabling the cutter while
  // docked would spin the blades against the charging contacts.
  const onDock = (mower?.sensors?.battery_state ?? '').toUpperCase() === 'CHARGING';

  // Disable manual control while the mower is autonomously busy — mowing, mapping,
  // or returning to the dock. Sending start_move / mst during an active task can
  // corrupt the nav2 plan or cause the firmware to enter an inconsistent state.
  // Matches the activity detection logic from HomeScreen.
  const busyWithTask = (() => {
    // User-driven manual mowing publishes a synthetic COVERING state to
    // unlock the STM32 blade gate. Don't treat that as autonomous busy.
    if (bladeOn) return false;
    const s = mower?.sensors ?? {};
    const msg = s.msg ?? '';
    const taskMode = parseInt(s.task_mode ?? '0', 10);
    const rechargeStatus = parseInt(s.recharge_status ?? '0', 10);
    const workStatus = s.work_status ?? '';
    const coverageRunning = msg.includes('Work:RUNNING')
      || msg.includes('Work:COVERING') || msg.includes('Work:NAVIGATING')
      || msg.includes('Work:MOVING') || msg.includes('Work:QUIT_PILE_INIT')
      || msg.includes('Work:SENSOR_INIT') || msg.includes('Work:INIT_SUCCESS')
      || msg.includes('Work:MAP_INIT') || msg.includes('Work:PAUSED');
    const returning = rechargeStatus === 1 || msg.includes('Recharge: GOING')
      || msg.includes('Work:GO_PILE') || msg.includes('Work:BACK_CHARGER')
      || msg.includes('Work:DOCKING');
    // The server translates work_status numeric → human label
    // (sensorData.ts WORK_STATUS_LABELS). Check both raw and translated
    // forms. Idle-like states (mower not actively executing a coverage
    // path): '0'/'Idle', '9'/'Ready', '70'/'Finished once', '72'/'Cancelled'.
    // A failed or cancelled task is over: the mower is idle, not mowing.
    const IDLE_WORK_STATES = ['0', '1', '2', '7', '8', '9', '70', '72',
      'Idle', 'Ready', 'Failed', 'Failed once', 'Finished once', 'Finished', 'Cancelled'];
    const stickyMowing = !onDock && taskMode === 1 && !returning
      && !IDLE_WORK_STATES.includes(workStatus)
      && !msg.includes('Work:FINISHED') && !msg.includes('Work:CANCELLED');
    const mapping = s.start_edit_or_assistant_map_flag === '1' && taskMode !== 1;
    return coverageRunning || returning || stickyMowing || mapping;
  })();

  const [active, setActive] = useState(false);
  const [thumbX, setThumbX] = useState(0);
  const [thumbY, setThumbY] = useState(0);
  const [speedLevel, setSpeedLevel] = useState(1);
  const [lightOn, setLightOn] = useState(false);
  const { brightness: headlightBrightness } = useHeadlightBrightness();
  // Modal state + last-used cutting height (user cm, 2-9, wire = cm-2)
  const [showBladeSheet, setShowBladeSheet] = useState(false);
  const [bladeHeight, setBladeHeight] = useState(5); // 5cm = level 3 = 50mm
  const activeRef = useRef(false);
  const lastSendRef = useRef(0);
  const speedRef = useRef(1);

  useEffect(() => { speedRef.current = speedLevel; }, [speedLevel]);

  // Cleanup on unmount — stop joystick + guarantee blade off. Safety-critical:
  // if user navigates away while blade spinning, we turn it off.
  useEffect(() => {
    return () => {
      if (activeRef.current) {
        const socket = getSocket();
        if (socket) socket.emit('joystick:stop', { sn });
      }
      if (bladeOnRef.current) {
        (async () => {
          try {
            const url = await getServerUrl();
            if (!url) return;
            const api = new ApiClient(url);
            await api.sendExtended(sn, { blade_off: {} });
          } catch { /* best-effort */ }
        })();
      }
    };
  }, [sn]);

  // Auto-off the blade if the mower goes offline, lands on the charger,
  // or enters an error / busy state while manually mowing. The firmware's
  // own safety also kicks in on tilt/overcurrent, but this gives faster
  // UI feedback and doesn't rely on the hardware fault path.
  useEffect(() => {
    if (!bladeOnRef.current) return;
    const online = !!mower?.online;
    const errorStatus = parseInt(mower?.sensors?.error_status ?? '0', 10);
    if (online && !busyWithTask && !onDock && errorStatus === 0) return;
    (async () => {
      bladeOnRef.current = false;
      setBladeOn(false);
      try {
        const url = await getServerUrl();
        if (!url) return;
        const api = new ApiClient(url);
        await api.sendExtended(sn, { blade_off: {} });
      } catch { /* ignore */ }
    })();
  }, [mower?.online, mower?.sensors?.error_status, busyWithTask, onDock, sn]);

  const toggleBlade = useCallback(() => {
    // Treat blade as ON whenever EITHER our local toggle says so OR the
    // chassis is reporting RPM > 0. Auto-off effects can flip
    // bladeOnRef.current to false while the motor is still spinning (e.g.
    // a transient busy state during the RobotStatus override race), and
    // without the bladeSpeed check the banner becomes inert and the user
    // can't kill the motor — they'd just keep reopening the height sheet.
    const motorRunning = bladeOnRef.current || bladeSpeed > 0;
    if (motorRunning) {
      bladeOnRef.current = false;
      setBladeOn(false);
      (async () => {
        try {
          const url = await getServerUrl();
          if (!url) return;
          const api = new ApiClient(url);
          await api.sendExtended(sn, { blade_off: {} });
        } catch { /* ignore */ }
      })();
      return;
    }
    // Turn on — toon de hoogte-picker modal zodat de user een maai-hoogte
    // kiest. Blades MOETEN in cutting positie staan voor het mes fysiek
    // kan snijden; zonder blade_height stap draait alleen de motor maar
    // gebeurt er niks. De modal regelt de bevestiging + hoogte-keuze in
    // één stap. Persist gekozen hoogte in state zodat volgende keer weer
    // dezelfde default verschijnt.
    setShowBladeSheet(true);
  }, [bladeSpeed, sn]);

  // Start blade met gekozen hoogte. `blade_on` neemt de wire-level
  // enum (0..7). Firmware-mapping in extended_commands.py:_publish_blade_height
  // is `mm = (level + 2) * 10`, dus userCm = 2 → level 0 (20mm), userCm
  // = 9 → level 7 (90mm). Het oude `9 - userCm` was geïnverteerd en
  // zette de blade altijd op (11-userCm)cm — bv 2cm gekozen → 9cm
  // fysiek, blade raakte het gras nauwelijks (issue van 2026-05-16).
  const startBladeWithHeight = useCallback((userCm: number) => {
    setShowBladeSheet(false);
    const level = Math.max(0, Math.min(7, userCm - 2));
    bladeOnRef.current = true;
    setBladeOn(true);
    (async () => {
      try {
        const url = await getServerUrl();
        if (!url) return;
        const api = new ApiClient(url);
        await api.sendExtended(sn, { blade_on: { speed: 3000, height: level } });
      } catch { /* ignore */ }
    })();
  }, [sn]);

  const sendMove = useCallback((dx: number, dy: number) => {
    if (busyWithTask) return;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < DEAD_ZONE) return;

    const now = Date.now();
    if (now - lastSendRef.current < THROTTLE_MS) return;
    lastSendRef.current = now;

    const socket = getSocket();
    if (!socket) return;

    const holdType = getHoldType(dx, dy);
    const lvl = SPEED_LEVELS[speedRef.current];
    // Match de BLE joystick semantiek (MappingScreen.tsx sendMove) exact —
    // die werkt bewezen live op dezelfde firmware:
    //   x_w = angular (turn left/right), SIGNED — negatief is links
    //   y_v = linear  (forward/backward), SIGNED — negatief is achteruit
    //   z_g = 0
    // De eerdere "unsigned magnitudes" variant stuurde alleen positieve
    // waarden en verwarde firmware omdat die de sign nodig heeft voor de
    // richting per as. Ook waren x_w/y_v rollen verwisseld t.o.v. BLE wat
    // "vooruit" liet interpreteren als "turn only" → erratisch gedrag.
    //
    // dy is in schermcoord (naar beneden = positief), dus -dy = voorwaarts.
    socket.emit('joystick:move', {
      sn,
      holdType,
      mst: {
        x_w: Math.round(dx * lvl.angular * 100) / 100,
        y_v: Math.round(-dy * lvl.linear * 100) / 100,
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

  // ── Camera stream ──
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [cameraVisible, setCameraVisible] = useState(true);
  // Bump this counter to force the WebView to remount + re-pull the stream.
  // Used by the refresh button when the MJPEG feed silently stalls (server
  // socket dropped, mower camera_node restarted, etc.).
  const [cameraReloadKey, setCameraReloadKey] = useState(0);

  useEffect(() => {
    if (!mower?.online || !sn) { setStreamUrl(null); return; }
    // Use the server's proxy route, NOT the direct mower-IP URL from /info.
    // Reasons: (a) `/info` 404s when the mower's LAN IP isn't yet known to
    // the server (mDNS still warming up after boot), which used to leave the
    // joystick screen permanently camera-less. (b) the proxy works regardless
    // of whether the app device is on the same LAN as the mower — important
    // for remote / VPN access. CameraScreen.tsx uses the same approach.
    (async () => {
      const serverUrl = await getServerUrl();
      if (!serverUrl) return;
      setStreamUrl(`${serverUrl}/api/dashboard/camera/${encodeURIComponent(sn)}/stream?topic=front`);
    })();
  }, [mower?.online, sn]);

  // Manual control depends on MQTT commands (`start_move`, `mst`,
  // `blade_on`, `blade_off`) that ship in the OpenNova-custom mqtt_node
  // additions. Stock LFI firmware doesn't accept them, so the joystick
  // and blade toggle would silently do nothing. Replace the screen with
  // an explainer when the active mower is on stock.
  if (activeMower && !isOpenNovaFirmware(activeMower.firmwareVersion)) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, justifyContent: 'center', alignItems: 'center', padding: 24 }]}>
        <MaterialCommunityIcons name="lock-outline" size={64} color={colors.textMuted ?? '#999'} />
        <Text style={[styles.title, { marginTop: 16, textAlign: 'center' }]}>{t('manualControl')}</Text>
        <Text style={{ marginTop: 12, color: colors.textDim ?? '#888', textAlign: 'center', fontSize: 14, lineHeight: 20, maxWidth: 360 }}>
          Manual control needs OpenNova custom firmware. The MQTT commands
          for driving the mower and toggling the blade aren&apos;t part of
          the stock LFI firmware, so the joystick would have nothing to
          talk to here.
        </Text>
        <Text style={{ marginTop: 16, color: colors.textMuted ?? '#999', textAlign: 'center', fontSize: 12, fontStyle: 'italic' }}>
          Active mower firmware: {activeMower.firmwareVersion ?? 'unknown'}
        </Text>
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={[styles.container, { paddingTop: insets.top }]}>

        {/* Header — title, plus compact toggle-iconen rechts voor camera
            en koplamp. Vervangt de oude onderkant-knop want die viel vaak
            onder de joystick / buiten beeld op kleine schermen. */}
        <View style={styles.header}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={styles.title} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{t('manualControl')}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, marginLeft: 12 }}>
              {/* Blade — alleen zichtbaar als mower online is en niet in een
                  coverage task zit. Rood + outline wanneer uit, rood + fill
                  wanneer aan. Kleuring nadrukkelijk "gevaar" omdat dit een
                  echt cutting-mes aanzet. Bevestig-dialog voor aan. */}
              {mower?.online && !busyWithTask && (
                <TouchableOpacity
                  onPress={onDock ? undefined : toggleBlade}
                  activeOpacity={0.7}
                  disabled={onDock}
                  style={[
                    (bladeOn || bladeSpeed > 0) ? styles.bladeBtnActive : undefined,
                    onDock && { opacity: 0.35 },
                  ]}
                >
                  {bladeSpeed > 0 ? (
                    <BladeSpinIcon size={22} color={colors.red} spinning={true} />
                  ) : (
                    <MaterialCommunityIcons
                      name="saw-blade"
                      size={22}
                      color={onDock ? colors.textMuted : (bladeOn ? colors.amber : colors.textMuted)}
                    />
                  )}
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={() => {
                  const next = !lightOn;
                  setLightOn(next);
                  getServerUrl().then(url => {
                    if (url) fetch(`${url}/api/dashboard/command/${encodeURIComponent(sn)}`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ command: { set_para_info: { headlight: next ? headlightBrightness : 0 } } }),
                    });
                  });
                }}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={lightOn ? 'flashlight' : 'flashlight-outline'}
                  size={22}
                  color={lightOn ? colors.amber : colors.textMuted}
                />
              </TouchableOpacity>
              {streamUrl && (
                <TouchableOpacity onPress={() => setCameraVisible(!cameraVisible)} activeOpacity={0.7}>
                  <Ionicons name={cameraVisible ? 'videocam' : 'videocam-off'} size={22} color={cameraVisible ? colors.emerald : colors.textMuted} />
                </TouchableOpacity>
              )}
              {streamUrl && cameraVisible && (
                <TouchableOpacity onPress={() => setCameraReloadKey(k => k + 1)} activeOpacity={0.7}>
                  <Ionicons name="refresh" size={22} color={colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          </View>
          {mower && (
            <View style={styles.statusRow}>
              <View style={[styles.dot, { backgroundColor: mower.online ? colors.green : colors.red }]} />
              <Text style={styles.statusText}>{sn}</Text>
              <Text style={[styles.statusText, { color: colors.textMuted, marginLeft: 8 }]}>
                {battery}%
              </Text>
              {(() => {
                const rtk = fixQualityLabel(mower.sensors?.rtk_fix_quality);
                return (
                  <Text style={[styles.statusText, { color: rtk.color, fontWeight: '700', marginLeft: 8 }]}>
                    RTK: {rtk.label}
                  </Text>
                );
              })()}
            </View>
          )}
        </View>

        {/* Blade banner — separated into "command requested" (local bladeOn
            toggle) and "actually spinning" (chassis RPM > 0). Spinning
            saw-blade icon + live RPM mirror the HomeScreen activity card so
            the operator can tell when the firmware engaged the motor vs
            when it silently rejected the request (e.g. IMU zero-bias not
            initialized or mower in protect_mode). */}
        {!busyWithTask && (bladeOn || bladeSpeed > 0) && (
          <TouchableOpacity onPress={toggleBlade} activeOpacity={0.85} style={styles.bladeBanner}>
            <BladeSpinIcon size={28} color={bladeSpeed > 0 ? colors.red : colors.amber} spinning={bladeSpeed > 0} />
            <Text style={{ color: bladeSpeed > 0 ? colors.red : colors.amber, fontWeight: '700', fontSize: 13, flex: 1 }}>
              {bladeSpeed > 0
                ? `Blade spinning at ${bladeSpeed} rpm. Tap to stop.`
                : 'Blade requested, waiting for motor. Tap to cancel.'}
            </Text>
            <Ionicons name="stop-circle" size={20} color={bladeSpeed > 0 ? colors.red : colors.amber} />
          </TouchableOpacity>
        )}

        {!mower?.online && !demo.enabled ? (
          <View style={styles.offlineBox}>
            <Ionicons name="alert-circle" size={32} color={colors.red} />
            <Text style={styles.offlineText}>{t('mowerOffline')}</Text>
            <Text style={styles.offlineSubtext}>{t('connectMowerToMap')}</Text>
          </View>
        ) : busyWithTask ? (
          <View style={styles.offlineBox}>
            <Ionicons name="lock-closed" size={32} color={colors.amber} />
            <Text style={[styles.offlineText, { color: colors.amber }]}>
              {t('manualControlLocked') || 'Manual control locked'}
            </Text>
            <Text style={styles.offlineSubtext}>
              {t('manualControlLockedDesc') || 'Stop the current task before driving the mower manually.'}
            </Text>
          </View>
        ) : (
          <>
            {/* Camera stream */}
            {cameraVisible && streamUrl && (
              <View style={[
                styles.cameraContainer,
                (bladeOn || bladeSpeed > 0) && { height: 130 },
              ]}>
                <WebView
                key={cameraReloadKey}
                source={{
                  html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><style>*{margin:0;padding:0;touch-action:none;pointer-events:none}body{background:#000;width:100vw;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden}img{max-width:100%;max-height:100%;object-fit:contain;pointer-events:none}</style></head><body><img src="${streamUrl}&_=${cameraReloadKey}" /></body></html>`,
                }}
                style={styles.cameraStream}
                scrollEnabled={false}
                javaScriptEnabled={false}
                originWhitelist={['*']}
                mixedContentMode="always"
                allowsInlineMediaPlayback
                overScrollMode="never"
              />
              </View>
            )}

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

            {/* Headlight + camera icons live in the header now. The
                old emergency stop button below the speed picker was
                effectively invisible on dark backgrounds and duplicated
                the joystick's own release-to-stop behaviour, so removed. */}
          </>
        )}
      </View>

      {/* Blade height picker — geopend vanuit het ✂️ icoon in de header.
          User kiest een maai-hoogte (2-9 cm, matcht StartMowSheet) voordat
          het mes aangaat. Height wordt samen met speed naar de mower
          gestuurd in één blade_on commando (blade_height_set dan
          blade_speed_set, atomisch op server-side). */}
      <Modal
        visible={showBladeSheet}
        transparent
        animationType="fade"
        onRequestClose={() => setShowBladeSheet(false)}
      >
        <View style={styles.bladeSheetBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setShowBladeSheet(false)}
          />
          <View style={styles.bladeSheetCard}>
            <View style={{ alignItems: 'center', marginBottom: 8 }}>
              <Ionicons name="warning" size={28} color={colors.red} />
            </View>
            <Text style={styles.bladeSheetTitle}>Start blade</Text>
            <Text style={styles.bladeSheetSubtitle}>
              Choose cutting height. The blades will extend and spin up —
              keep hands and feet clear. Auto-stops if the app closes or the
              mower goes offline.
            </Text>

            <Text style={styles.bladeSheetLabel}>Cutting height</Text>
            <View style={styles.bladeSheetHeightRow}>
              {[2, 3, 4, 5, 6, 7, 8, 9].map((cm) => (
                <TouchableOpacity
                  key={cm}
                  style={[
                    styles.bladeSheetHeightChip,
                    bladeHeight === cm && styles.bladeSheetHeightChipActive,
                  ]}
                  onPress={() => setBladeHeight(cm)}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.bladeSheetHeightText,
                      bladeHeight === cm && styles.bladeSheetHeightTextActive,
                    ]}
                  >
                    {cm} cm
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
              <TouchableOpacity
                style={[styles.bladeSheetBtn, { backgroundColor: 'rgba(255,255,255,0.08)' }]}
                onPress={() => setShowBladeSheet(false)}
                activeOpacity={0.7}
              >
                <Text style={[styles.bladeSheetBtnText, { color: colors.textDim }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.bladeSheetBtn, { backgroundColor: colors.red }]}
                onPress={() => startBladeWithHeight(bladeHeight)}
                activeOpacity={0.7}
              >
                <Ionicons name="cut" size={18} color={colors.white} />
                <Text style={styles.bladeSheetBtnText}>Start blade</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </GestureHandlerRootView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.bg,
    alignItems: 'center',
  },
  cameraContainer: {
    width: '100%',
    height: 180,
    backgroundColor: '#000',
    borderRadius: 12,
    overflow: 'hidden',
    marginHorizontal: 16,
    marginBottom: 4,
  },
  cameraStream: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    width: '100%',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: c.text,
    flexShrink: 1,
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
    color: c.textDim,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  offlineBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 32,
  },
  offlineText: {
    fontSize: 18,
    fontWeight: '600',
    color: c.white,
    textAlign: 'center',
  },
  offlineSubtext: {
    fontSize: 14,
    color: c.textMuted,
    textAlign: 'center',
  },
  speedInfo: {
    marginVertical: 8,
    height: 24,
  },
  speedText: {
    fontSize: 16,
    fontWeight: '700',
    color: c.emerald,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  joystickContainer: {
    marginVertical: 16,
  },
  joystickBase: {
    borderRadius: JOYSTICK_SIZE / 2,
    // Neutral semi-transparent so the pad reads on both schemes — slight
    // gray tint against light gradient AND against dark navy.
    backgroundColor: 'rgba(125,125,125,0.10)',
    borderWidth: 3,
    borderColor: 'rgba(125,125,125,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  crossV: {
    position: 'absolute',
    width: 1,
    height: '100%',
    backgroundColor: 'rgba(125,125,125,0.30)',
  },
  crossH: {
    position: 'absolute',
    height: 1,
    width: '100%',
    backgroundColor: 'rgba(125,125,125,0.30)',
  },
  dirLabel: {
    position: 'absolute',
    fontSize: 11,
    fontWeight: '600',
    color: c.textMuted,
  },
  dirTop: { top: 8, alignSelf: 'center' },
  dirBottom: { bottom: 8, alignSelf: 'center' },
  dirLeft: { left: 10, top: '50%', marginTop: -7 },
  dirRight: { right: 10, top: '50%', marginTop: -7 },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: 'rgba(125,125,125,0.35)',
    borderWidth: 2,
    borderColor: 'rgba(125,125,125,0.55)',
  },
  thumbActive: {
    backgroundColor: c.emerald,
    borderColor: c.white,
    shadowColor: c.emerald,
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
    borderColor: c.emerald,
  },
  speedBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: c.textMuted,
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
  bladeBtnActive: {
    // Subtle rode glow achter het cut-icoon zodra de mes motor draait.
    // Padding zodat de border niet over andere iconen valt.
    padding: 2,
    borderRadius: 10,
    backgroundColor: 'rgba(239,68,68,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.55)',
  },
  bladeSheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  bladeSheetCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: c.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.35)',
    padding: 24,
  },
  bladeSheetTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: c.white,
    textAlign: 'center',
    marginBottom: 4,
  },
  bladeSheetSubtitle: {
    fontSize: 13,
    color: c.textDim,
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 18,
  },
  bladeSheetLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: c.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  bladeSheetHeightRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  bladeSheetHeightChip: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    minWidth: 54,
    alignItems: 'center',
  },
  bladeSheetHeightChipActive: {
    backgroundColor: 'rgba(239,68,68,0.2)',
    borderColor: 'rgba(239,68,68,0.7)',
  },
  bladeSheetHeightText: {
    fontSize: 13,
    fontWeight: '600',
    color: c.textDim,
    fontVariant: ['tabular-nums'],
  },
  bladeSheetHeightTextActive: {
    color: c.white,
  },
  bladeSheetBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  bladeSheetBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: c.white,
  },
  bladeBanner: {
    marginTop: 8,
    marginHorizontal: 16,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(239,68,68,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.55)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  lightText: {
    fontSize: 13,
    color: c.amber,
    fontWeight: '600',
  },
});
