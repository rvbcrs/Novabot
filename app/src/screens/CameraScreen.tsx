/**
 * Camera screen — live snapshot feed from the mower's cameras.
 *
 * Polls JPEG snapshots from the server's camera proxy endpoint.
 * Supports multiple camera topics: front, front_hd, tof_gray, tof_depth, aruco.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
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
import { getServerUrl } from '../services/auth';
import { getSocket } from '../services/socket';
import { useI18n } from '../i18n';

// Camera uses MJPEG stream via WebView — no polling needed

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

  // Hide tab bar in landscape
  useEffect(() => {
    navigation.setOptions({
      tabBarStyle: isLandscape
        ? { display: 'none' as const }
        : undefined,
    });
  }, [isLandscape, navigation]);

  // Allow landscape rotation on this screen, reset on leave
  useEffect(() => {
    ScreenOrientation.unlockAsync();
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    };
  }, []);

  const mower = [...devices.values()].find(d => d.deviceType === 'mower' && d.online);
  const sn = mower?.sn ?? '';
  const mowerIp = mower?.sensors?.ip_address ?? '';

  const [selectedTopic, setSelectedTopic] = useState('front');
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [lightOn, setLightOn] = useState(false);

  // Build MJPEG stream URL
  useEffect(() => {
    if (!mower?.online || !sn) { setStreamUrl(null); return; }
    setLoading(true);
    setHasError(false);
    (async () => {
      try {
        const serverUrl = await getServerUrl();
        if (!serverUrl) return;
        setStreamUrl(`${serverUrl}/api/dashboard/camera/${encodeURIComponent(sn)}/stream?ip=${mowerIp}&port=8000&topic=${selectedTopic}`);
      } catch {
        setHasError(true);
      }
    })();
  }, [mower?.online, sn, mowerIp, selectedTopic]);

  const handleTopicChange = (key: string) => {
    setSelectedTopic(key);
    setLoading(true);
    setHasError(false);
  };

  const reload = () => {
    setHasError(false);
    setLoading(true);
    // Force stream URL refresh by toggling topic
    const current = selectedTopic;
    setSelectedTopic('');
    setTimeout(() => setSelectedTopic(current), 100);
  };

  const toggleLight = () => {
    const next = !lightOn;
    setLightOn(next);
    getServerUrl().then(url => {
      if (url) fetch(`${url}/api/dashboard/command/${encodeURIComponent(sn)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: { set_para_info: { headlight: next ? 2 : 0 } } }),
      });
    });
  };

  return (
    <View style={[styles.container, { paddingTop: isLandscape ? 0 : insets.top }]}>
      {/* Topic selector bar — hidden in landscape */}
      {!isLandscape && <View style={styles.topBar}>
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
            <Ionicons
              name="flashlight"
              size={18}
              color={lightOn ? colors.amber : colors.textMuted}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={reload} style={styles.iconBtn} activeOpacity={0.7}>
            <Ionicons name="refresh" size={18} color={colors.textDim} />
          </TouchableOpacity>
        </View>
      </View>}

      {/* Camera view */}
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
            <Text style={styles.centerSub}>{t('cameraRunning')}</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={reload} activeOpacity={0.7}>
              <Text style={styles.retryText}>{t('retry')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {loading && !streamUrl && (
              <View style={styles.loadingOverlay}>
                <ActivityIndicator size="large" color={colors.emerald} />
                <Text style={styles.loadingText}>{t('connectingCamera')}</Text>
              </View>
            )}
            {/* MJPEG stream via WebView — smooth, no polling flicker */}
            {streamUrl && (
              <WebView
                source={{ html: `<html><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh"><img src="${streamUrl}" style="max-width:100%;max-height:100%;object-fit:contain" onerror="document.body.innerHTML='<p style=color:#666;font-family:sans-serif;text-align:center>Camera unavailable</p>'" onload="document.body.style.background='#000'"/></body></html>` }}
                style={styles.cameraImage}
                scrollEnabled={false}
                onLoadStart={() => setLoading(true)}
                onLoadEnd={() => setLoading(false)}
                onError={() => setHasError(true)}
                javaScriptEnabled={false}
                mediaPlaybackRequiresUserAction={false}
                allowsInlineMediaPlayback
              />
            )}
          </>
        )}
      </View>

      {/* Info bar — hidden in landscape */}
      {!isLandscape && mower?.online && (
        <View style={styles.infoBar}>
          <Text style={styles.infoText}>{sn}</Text>
          <Text style={styles.infoText}>Topic: {selectedTopic}</Text>
          <Text style={styles.infoText}>{mowerIp || 'IP unknown'}</Text>
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
  topicBtnActive: {
    backgroundColor: colors.emerald,
  },
  topicText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  topicTextActive: { color: colors.white },
  topBarActions: { flexDirection: 'row', gap: 4, marginLeft: 'auto' },
  iconBtn: { padding: 8 },
  cameraArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  centerMsg: { alignItems: 'center', gap: 8, paddingHorizontal: 32 },
  centerTitle: { fontSize: 18, fontWeight: '600', color: colors.white },
  centerSub: { fontSize: 13, color: colors.textMuted, textAlign: 'center' },
  retryBtn: {
    marginTop: 12,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  retryText: { fontSize: 14, fontWeight: '600', color: colors.white },
  loadingOverlay: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  loadingText: { fontSize: 12, color: colors.textMuted },
  cameraImage: {
    width: '100%',
    height: '100%',
  },
  infoBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: 'rgba(0,0,0,0.9)',
  },
  infoText: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.3)',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
