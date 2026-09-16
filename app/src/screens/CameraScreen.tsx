/**
 * Camera screen — MJPEG live stream from the mower's cameras.
 *
 * Fetches mower's direct IP via /camera/:sn/info, then renders
 * MJPEG stream via <img> tag in WebView (WebKit renders MJPEG natively).
 */
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { WebView } from 'react-native-webview';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useStyles, useTheme, type Colors } from '../theme';
import { useActiveMower } from '../hooks/useActiveMower';
import { useMowerState } from '../hooks/useMowerState';
import { getServerUrl } from '../services/auth';
import { useI18n } from '../i18n';
import { isOpenNovaFirmware } from '../utils/firmwareCapability';

const CAMERA_TOPICS = [
  { key: 'front', label: 'Front' },
  { key: 'tof_gray', label: 'ToF Gray' },
  { key: 'tof_depth', label: 'ToF Depth' },
  { key: 'aruco', label: 'ArUco' },
];

export default function CameraScreen() {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const navigation = useNavigation();

  useEffect(() => {
    navigation.setOptions({
      tabBarStyle: isLandscape ? { display: 'none' as const } : undefined,
    });
  }, [isLandscape, navigation]);

  useEffect(() => {
    ScreenOrientation.unlockAsync();
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    };
  }, []);

  const { activeMower } = useActiveMower();
  const mower = activeMower && activeMower.online ? activeMower : null;
  const sn = mower?.sn ?? '';

  // Live sensor readout for the on-stream overlay chips. Mirrors the chips
  // rendered on HomeScreen so the user gets the same vitals while watching
  // the camera feed.
  const { devices } = useMowerState();
  const sensors = sn ? devices.get(sn)?.sensors : undefined;
  const battery = sensors ? parseInt(sensors.battery_power ?? sensors.battery_capacity ?? '', 10) : NaN;
  const wifiRssi = sensors?.wifi_rssi ?? null;
  const rtkSat = sensors?.rtk_sat ?? null;
  const cpuTemp = sensors?.cpu_temperature ?? null;
  const bladeSpeed = parseInt(sensors?.blade_speed ?? '0', 10) || 0;

  const [selectedTopic, setSelectedTopic] = useState('front');
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [lightOn, setLightOn] = useState(false);
  const [streamKey, setStreamKey] = useState(0);

  // Fetch mower's direct camera URL from server
  useEffect(() => {
    if (!mower?.online || !sn) {
      setStreamUrl(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setHasError(false);
    setErrorMsg('');
    (async () => {
      try {
        const serverUrl = await getServerUrl();
        if (!serverUrl) { setErrorMsg('No server URL'); setHasError(true); return; }
        const res = await fetch(`${serverUrl}/api/dashboard/camera/${encodeURIComponent(sn)}/info`);
        const json = await res.json();
        if (json.streamUrl) {
          setStreamUrl(`${json.streamUrl}?topic=${selectedTopic}`);
        } else {
          setErrorMsg(json.error ?? 'No stream URL');
          setHasError(true);
        }
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : 'Fetch failed');
        setHasError(true);
      }
    })();
  }, [mower?.online, sn, selectedTopic, streamKey]);

  const handleTopicChange = (key: string) => {
    setSelectedTopic(key);
    setLoading(true);
    setHasError(false);
  };

  const reload = () => {
    setHasError(false);
    setLoading(true);
    setStreamKey(k => k + 1);
  };

  const toggleLight = async () => {
    const next = !lightOn;
    setLightOn(next);
    const url = await getServerUrl();
    if (url) fetch(`${url}/api/dashboard/command/${encodeURIComponent(sn)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: { set_para_info: { headlight: next ? 2 : 0 } } }),
    });
  };

  const streamHtml = streamUrl ? `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden}
img{max-width:100%;max-height:100%;object-fit:contain}
</style>
</head><body>
<img src="${streamUrl}" />
</body></html>` : '';

  // The camera stream is served by `camera_stream.py`, a Python daemon
  // that only ships with the OpenNova custom mower firmware. On stock
  // firmware the proxy returns 404 and the WebView renders a broken
  // image icon — replace the screen with an explanation instead.
  if (activeMower && !isOpenNovaFirmware(activeMower.firmwareVersion)) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, justifyContent: 'center', alignItems: 'center', padding: 24 }]}>
        <MaterialCommunityIcons name="camera-off-outline" size={64} color={colors.textMuted ?? '#999'} />
        <Text style={{ marginTop: 16, color: colors.text ?? '#fff', fontSize: 18, fontWeight: '600', textAlign: 'center' }}>
          {t('tabCamera')}
        </Text>
        <Text style={{ marginTop: 12, color: colors.textDim ?? '#888', textAlign: 'center', fontSize: 14, lineHeight: 20, maxWidth: 360 }}>
          The camera stream is provided by a daemon that only runs on
          OpenNova custom firmware. Stock LFI firmware doesn&apos;t ship
          this service, so there&apos;s nothing to display.
        </Text>
        <Text style={{ marginTop: 16, color: colors.textMuted ?? '#999', textAlign: 'center', fontSize: 12, fontStyle: 'italic' }}>
          Active mower firmware: {activeMower.firmwareVersion ?? 'unknown'}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: isLandscape ? 0 : insets.top }]}>
      {!isLandscape && (
        <View style={styles.topBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.topicRow}>
            {CAMERA_TOPICS.map(({ key, label }) => (
              <TouchableOpacity
                key={key}
                style={[styles.topicBtn, selectedTopic === key && styles.topicBtnActive]}
                onPress={() => handleTopicChange(key)}
                activeOpacity={0.7}
              >
                <Text style={[styles.topicText, selectedTopic === key && styles.topicTextActive]}>
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <View style={styles.topBarActions}>
            <TouchableOpacity onPress={toggleLight} style={styles.iconBtn} activeOpacity={0.7}>
              <Ionicons name="flashlight" size={18} color={lightOn ? colors.amber : colors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity onPress={reload} style={styles.iconBtn} activeOpacity={0.7}>
              <Ionicons name="refresh" size={18} color={colors.textDim} />
            </TouchableOpacity>
          </View>
        </View>
      )}

      <View style={styles.cameraArea}>
        {!mower?.online ? (
          <View style={styles.centerMsg}>
            <Ionicons name="camera-outline" size={64} color={colors.textMuted} />
            <Text style={styles.centerTitle}>{t('mowerOffline')}</Text>
            <Text style={styles.centerSub}>{t('cameraOffline')}</Text>
          </View>
        ) : hasError ? (
          <View style={styles.centerMsg}>
            <Ionicons name="camera-outline" size={48} color={colors.textMuted} />
            <Text style={styles.centerTitle}>{t('cameraUnavailable')}</Text>
            <Text style={styles.centerSub}>{errorMsg}</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={reload} activeOpacity={0.7}>
              <Text style={styles.retryText}>{t('retry')}</Text>
            </TouchableOpacity>
          </View>
        ) : streamUrl ? (
          <View style={styles.streamContainer}>
            <WebView
              key={streamKey}
              source={{ html: streamHtml }}
              style={styles.stream}
              scrollEnabled={false}
              onLoadEnd={() => setLoading(false)}
              javaScriptEnabled={false}
              originWhitelist={['*']}
              mixedContentMode="always"
              allowsInlineMediaPlayback
            />
            {/* Sensor chips overlaid on the stream — pointerEvents="none"
                lets touches pass through to the WebView underneath. */}
            <View style={styles.chipOverlay} pointerEvents="none">
              {!Number.isNaN(battery) && (
                <View style={styles.overlayChip}>
                  <Ionicons name="battery-half" size={12} color="#fff" />
                  <Text style={styles.overlayChipText}>{battery}%</Text>
                </View>
              )}
              {wifiRssi != null && (
                <View style={styles.overlayChip}>
                  <Ionicons name="wifi" size={12} color="#fff" />
                  <Text style={styles.overlayChipText}>{wifiRssi}%</Text>
                </View>
              )}
              {rtkSat != null && (
                <View style={styles.overlayChip}>
                  <Ionicons name="navigate" size={12} color="#fff" />
                  <Text style={styles.overlayChipText}>{rtkSat} sat</Text>
                </View>
              )}
              {cpuTemp != null && (
                <View style={styles.overlayChip}>
                  <Ionicons name="thermometer" size={12} color="#fff" />
                  <Text style={styles.overlayChipText}>{cpuTemp}°</Text>
                </View>
              )}
              {bladeSpeed > 0 && (
                <View style={styles.overlayChip}>
                  <MaterialCommunityIcons name="saw-blade" size={12} color="#fff" />
                  <Text style={styles.overlayChipText}>{bladeSpeed} rpm</Text>
                </View>
              )}
            </View>
            {loading && (
              <View style={styles.loadingOverlay}>
                <ActivityIndicator size="large" color={colors.emerald} />
                <Text style={styles.loadingText}>{t('connectingCamera')}</Text>
              </View>
            )}
          </View>
        ) : loading ? (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color={colors.emerald} />
            <Text style={styles.loadingText}>{t('connectingCamera')}</Text>
          </View>
        ) : null}
      </View>

      {!isLandscape && mower?.online && streamUrl && (
        <View style={styles.infoBar}>
          <Text style={styles.infoText}>{sn}</Text>
          <Text style={styles.infoText}>{selectedTopic}</Text>
          <Text style={styles.infoText} numberOfLines={1}>{streamUrl}</Text>
        </View>
      )}
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    backgroundColor: c.card,
    borderBottomWidth: 1,
    borderBottomColor: c.cardBorder,
  },
  topicRow: { gap: 6, paddingRight: 8 },
  topicBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.cardBorder,
  },
  topicBtnActive: { backgroundColor: c.emerald, borderColor: c.emerald },
  topicText: { fontSize: 12, fontWeight: '600', color: c.text },
  topicTextActive: { color: c.text },
  topBarActions: { flexDirection: 'row', gap: 4, marginLeft: 'auto' },
  iconBtn: { padding: 8 },
  cameraArea: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  streamContainer: { width: '100%', flex: 1 },
  // Stream itself stays #000 — that's the video viewport, black is correct
  // when no frame is loaded.
  stream: { flex: 1, backgroundColor: '#000' },
  centerMsg: { alignItems: 'center', gap: 8, paddingHorizontal: 32 },
  centerTitle: { fontSize: 18, fontWeight: '600', color: c.text },
  centerSub: { fontSize: 13, color: c.textMuted, textAlign: 'center' },
  retryBtn: {
    marginTop: 12, paddingHorizontal: 20, paddingVertical: 10,
    borderRadius: 10, backgroundColor: c.inputBg,
    borderWidth: 1, borderColor: c.cardBorder,
  },
  retryText: { fontSize: 14, fontWeight: '600', color: c.text },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  loadingText: { fontSize: 12, color: c.textMuted },
  chipOverlay: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  overlayChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  overlayChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#fff',
    fontVariant: ['tabular-nums'],
  },
  infoBar: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 6,
    backgroundColor: 'rgba(0,0,0,0.9)',
  },
  infoText: {
    fontSize: 9, color: 'rgba(255,255,255,0.3)',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
