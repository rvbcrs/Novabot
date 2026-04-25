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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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

export default function JoystickScreen() {
  const insets = useSafeAreaInsets();
  const demo = useDemo();
  const { t } = useI18n();
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();

  const { activeMower } = useActiveMower();
  const mower = activeMower && activeMower.online ? activeMower : null;
  const sn = mower?.sn ?? '';

  // Disable manual control while the mower is autonomously busy — mowing, mapping,
  // or returning to the dock. Sending start_move / mst during an active task can
  // corrupt the nav2 plan or cause the firmware to enter an inconsistent state.
  // Matches the activity detection logic from HomeScreen.
  const busyWithTask = (() => {
    const s = mower?.sensors ?? {};
    const msg = s.msg ?? '';
    const taskMode = parseInt(s.task_mode ?? '0', 10);
    const rechargeStatus = parseInt(s.recharge_status ?? '0', 10);
    const batteryState = (s.battery_state ?? '').toUpperCase();
    const workStatus = s.work_status ?? '';
    const onDock = batteryState === 'CHARGING';
    const coverageRunning = msg.includes('Work:RUNNING')
      || msg.includes('Work:COVERING') || msg.includes('Work:NAVIGATING')
      || msg.includes('Work:MOVING') || msg.includes('Work:QUIT_PILE_INIT')
      || msg.includes('Work:SENSOR_INIT') || msg.includes('Work:INIT_SUCCESS')
      || msg.includes('Work:MAP_INIT') || msg.includes('Work:PAUSED');
    const returning = rechargeStatus === 1 || msg.includes('Recharge: GOING')
      || msg.includes('Work:GO_PILE') || msg.includes('Work:BACK_CHARGER')
      || msg.includes('Work:DOCKING');
    const stickyMowing = !onDock && taskMode === 1 && !returning
      && workStatus !== '0' && workStatus !== '9'
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
  // Manual mowing — blade motor control. OFF by default, user moet bevestigen
  // via confirm-dialog. Auto-off bij: unmount, joystick-stop, mower-error,
  // mower-offline, of task-busy. Wordt aangestuurd via extended_commands.py
  // backchannel (blade_on / blade_off), omdat de standaard MQTT API geen
  // blade-motor commando buiten coverage tasks heeft.
  const [bladeOn, setBladeOn] = useState(false);
  const bladeOnRef = useRef(false);
  // Modal state + last-used cutting height (user cm, 2-9, wire = cm-2)
  const [showBladeSheet, setShowBladeSheet] = useState(false);
  const [bladeHeight, setBladeHeight] = useState(5); // 5cm = level 3 = 60mm
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

  // Auto-off the blade if the mower goes offline or enters an error / busy
  // state while manually mowing. The firmware's own safety also kicks in on
  // tilt/overcurrent, but this gives faster UI feedback and doesn't rely on
  // the hardware fault path.
  useEffect(() => {
    if (!bladeOnRef.current) return;
    const online = !!mower?.online;
    const errorStatus = parseInt(mower?.sensors?.error_status ?? '0', 10);
    if (online && !busyWithTask && errorStatus === 0) return;
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
  }, [mower?.online, mower?.sensors?.error_status, busyWithTask, sn]);

  const toggleBlade = useCallback(() => {
    if (bladeOnRef.current) {
      // Turn off — no confirmation, always allowed.
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
  }, []);

  // Start blade met gekozen hoogte. blade_on publisht naar
  // /blade_height_set (chassis inverted index): mm = 90 − level*10,
  // dus level = 9 − userCm. User 4cm → level 5 → 40mm physical.
  // Default gebruiker-cm = 5 (50mm).
  const startBladeWithHeight = useCallback((userCm: number) => {
    setShowBladeSheet(false);
    const level = Math.max(0, Math.min(7, 9 - userCm));
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

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={[styles.container, { paddingTop: insets.top }]}>

        {/* Header — title, plus compact toggle-iconen rechts voor camera
            en koplamp. Vervangt de oude onderkant-knop want die viel vaak
            onder de joystick / buiten beeld op kleine schermen. */}
        <View style={styles.header}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={styles.title}>{t('manualControl')}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
              {/* Blade — alleen zichtbaar als mower online is en niet in een
                  coverage task zit. Rood + outline wanneer uit, rood + fill
                  wanneer aan. Kleuring nadrukkelijk "gevaar" omdat dit een
                  echt cutting-mes aanzet. Bevestig-dialog voor aan. */}
              {mower?.online && !busyWithTask && (
                <TouchableOpacity
                  onPress={toggleBlade}
                  activeOpacity={0.7}
                  style={bladeOn ? styles.bladeBtnActive : undefined}
                >
                  <Ionicons
                    name={bladeOn ? 'cut' : 'cut-outline'}
                    size={22}
                    color={bladeOn ? colors.red : colors.textMuted}
                  />
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
            </View>
          </View>
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

        {/* BLADE ON banner — heel zichtbaar wanneer het mes draait, plus een
            tap-om-uit-te-schakelen zodat je zonder naar de kleine header te
            hoeven ook snel kan stoppen. */}
        {bladeOn && (
          <TouchableOpacity onPress={toggleBlade} activeOpacity={0.85} style={styles.bladeBanner}>
            <Ionicons name="warning" size={16} color={colors.red} />
            <Text style={{ color: colors.red, fontWeight: '700', fontSize: 13, flex: 1 }}>
              Blade is spinning — tap to stop
            </Text>
            <Ionicons name="stop-circle" size={18} color={colors.red} />
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
              <View style={styles.cameraContainer}>
                <WebView
                source={{
                  html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><style>*{margin:0;padding:0;touch-action:none;pointer-events:none}body{background:#000;width:100vw;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden}img{max-width:100%;max-height:100%;object-fit:contain;pointer-events:none}</style></head><body><img src="${streamUrl}" /></body></html>`,
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

            {/* (Headlight verplaatst naar de header, naast het camera-icoon.
                Eerder stond hier een grote toggle die buiten beeld viel op
                kleine schermen.) */}
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
    fontSize: 28,
    fontWeight: '800',
    color: c.text,
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
  },
  offlineText: {
    fontSize: 18,
    fontWeight: '600',
    color: c.white,
  },
  offlineSubtext: {
    fontSize: 14,
    color: c.textMuted,
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
    color: c.white,
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
