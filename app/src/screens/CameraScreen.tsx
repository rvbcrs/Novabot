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
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { WebView } from 'react-native-webview';
import * as ScreenOrientation from 'expo-screen-orientation';
import { colors } from '../theme/colors';
import { useMowerState } from '../hooks/useMowerState';
import { useActiveMower } from '../hooks/useActiveMower';
import { getServerUrl } from '../services/auth';
import { useI18n } from '../i18n';

const CAMERA_TOPICS = [
  { key: 'front', label: 'Front' },
  { key: 'tof_gray', label: 'ToF Gray' },
  { key: 'tof_depth', label: 'ToF Depth' },
  { key: 'aruco', label: 'ArUco' },
];

export default function CameraScreen() {
  const insets = useSafeAreaInsets();
  const { devices } = useMowerState();
  const { t } = useI18n();
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    backgroundColor: 'rgba(0,0,0,0.9)',
  },
  topicRow: { gap: 6, paddingRight: 8 },
  topicBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  topicBtnActive: { backgroundColor: colors.emerald },
  topicText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  topicTextActive: { color: colors.white },
  topBarActions: { flexDirection: 'row', gap: 4, marginLeft: 'auto' },
  iconBtn: { padding: 8 },
  cameraArea: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  streamContainer: { width: '100%', flex: 1 },
  stream: { flex: 1, backgroundColor: '#000' },
  centerMsg: { alignItems: 'center', gap: 8, paddingHorizontal: 32 },
  centerTitle: { fontSize: 18, fontWeight: '600', color: colors.white },
  centerSub: { fontSize: 13, color: colors.textMuted, textAlign: 'center' },
  retryBtn: {
    marginTop: 12, paddingHorizontal: 20, paddingVertical: 10,
    borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.1)',
  },
  retryText: { fontSize: 14, fontWeight: '600', color: colors.white },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  loadingText: { fontSize: 12, color: colors.textMuted },
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
