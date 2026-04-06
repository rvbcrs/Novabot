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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { useMowerState } from '../hooks/useMowerState';
import { getServerUrl } from '../services/auth';
import { getSocket } from '../services/socket';
import { useI18n } from '../i18n';

const POLL_INTERVAL_MS = 500;

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

  const mower = [...devices.values()].find(d => d.deviceType === 'mower' && d.online);
  const sn = mower?.sn ?? '';
  const mowerIp = mower?.sensors?.ip_address ?? '';

  const [selectedTopic, setSelectedTopic] = useState('front');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [lightOn, setLightOn] = useState(false);
  const activeRef = useRef(true);
  const counterRef = useRef(0);

  const fetchSnapshot = useCallback(async () => {
    if (!activeRef.current || !sn) return;
    try {
      const serverUrl = await getServerUrl();
      if (!serverUrl) return;
      counterRef.current += 1;
      const url = `${serverUrl}/api/dashboard/camera/${encodeURIComponent(sn)}/snapshot?ip=${mowerIp}&port=8000&topic=${selectedTopic}&_t=${Date.now()}`;
      // Use a cache-busting URI to force Image to reload
      setImageUri(url);
      setLoading(false);
      setHasError(false);
    } catch {
      setLoading(false);
      setHasError(true);
    }
  }, [sn, mowerIp, selectedTopic]);

  useEffect(() => {
    if (!mower?.online) return;
    activeRef.current = true;
    setLoading(true);
    setHasError(false);

    fetchSnapshot();
    const interval = setInterval(fetchSnapshot, POLL_INTERVAL_MS);
    return () => {
      activeRef.current = false;
      clearInterval(interval);
    };
  }, [mower?.online, fetchSnapshot]);

  const handleTopicChange = (key: string) => {
    setSelectedTopic(key);
    setLoading(true);
    setHasError(false);
    setImageUri(null);
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
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Topic selector bar */}
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
            <Ionicons
              name="flashlight"
              size={18}
              color={lightOn ? colors.amber : colors.textMuted}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={fetchSnapshot} style={styles.iconBtn} activeOpacity={0.7}>
            <Ionicons name="refresh" size={18} color={colors.textDim} />
          </TouchableOpacity>
        </View>
      </View>

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
            <TouchableOpacity style={styles.retryBtn} onPress={fetchSnapshot} activeOpacity={0.7}>
              <Text style={styles.retryText}>{t('retry')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {loading && !imageUri && (
              <View style={styles.loadingOverlay}>
                <ActivityIndicator size="large" color={colors.emerald} />
                <Text style={styles.loadingText}>{t('connectingCamera')}</Text>
              </View>
            )}
            {imageUri && (
              <Image
                source={{ uri: imageUri }}
                style={styles.cameraImage}
                resizeMode="contain"
                onError={() => setHasError(true)}
              />
            )}
          </>
        )}
      </View>

      {/* Info bar */}
      {mower?.online && (
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
