/**
 * App settings screen — server info, account, device controls, logout.
 */
import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ScrollView,
  Switch,
  Modal,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { getServerUrl, setServerUrl as saveServerUrl, getToken, clearToken } from '../services/auth';
import { initSocket, disconnectSocket } from '../services/socket';
import { discoverServers } from '../services/discovery';
import { useMowerState } from '../hooks/useMowerState';
import { ApiClient } from '../services/api';
import { JoystickControl } from '../components/JoystickControl';
import { useDevMode } from '../context/DevModeContext';

interface AppSettingsScreenProps {
  onLogout: () => void;
  onGoToProvision: () => void;
  onGoToOta?: () => void;
  onGoToMowerSettings?: () => void;
}

export default function AppSettingsScreen({
  onLogout,
  onGoToProvision,
  onGoToOta,
  onGoToMowerSettings,
}: AppSettingsScreenProps) {
  const insets = useSafeAreaInsets();
  const { devices, connected } = useMowerState();
  const [serverUrl, setServerUrl] = useState('');
  const [editingUrl, setEditingUrl] = useState('');
  const [isEditingServer, setIsEditingServer] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [discoveredServers, setDiscoveredServers] = useState<string[]>([]);
  const [email, setEmail] = useState('');
  const [headlightOn, setHeadlightOn] = useState(false);
  const [showJoystick, setShowJoystick] = useState(false);
  const devMode = useDevMode();

  const mower = useMemo(() => {
    return [...devices.values()].find((d) => d.deviceType === 'mower') ?? null;
  }, [devices]);

  const charger = useMemo(() => {
    return [...devices.values()].find((d) => d.deviceType === 'charger') ?? null;
  }, [devices]);

  useEffect(() => {
    (async () => {
      const url = await getServerUrl();
      if (url) setServerUrl(url);

      const token = await getToken();
      if (token) {
        try {
          const parts = token.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(atob(parts[1]));
            if (payload.email) setEmail(payload.email);
          }
        } catch { /* not JWT */ }
      }
    })();
  }, []);

  // Track headlight from sensor data
  useEffect(() => {
    if (mower?.sensors.headlight === '1') setHeadlightOn(true);
    else if (mower?.sensors.headlight === '0') setHeadlightOn(false);
  }, [mower?.sensors.headlight]);

  const toggleHeadlight = async () => {
    if (!mower) return;
    const newState = !headlightOn;
    setHeadlightOn(newState);
    try {
      const url = await getServerUrl();
      if (!url) return;
      const api = new ApiClient(url);
      await api.setHeadlight(mower.sn, newState);
    } catch {
      setHeadlightOn(!newState); // revert
    }
  };

  const handleChangeServer = async (newUrl: string) => {
    const normalized = newUrl.trim().replace(/\/+$/, '');
    if (!normalized) return;
    await saveServerUrl(normalized);
    setServerUrl(normalized);
    setIsEditingServer(false);
    // Reconnect: logout triggers full re-init with new server URL
    disconnectSocket();
    initSocket(normalized);
    // Force re-login so socket hooks re-attach to the new socket
    await clearToken();
    onLogout();
  };

  const handleDiscover = () => {
    setScanning(true);
    setDiscoveredServers([]);
    discoverServers((server) => {
      const url = `http://${server.ip}:3000`;
      setDiscoveredServers((prev) => prev.includes(url) ? prev : [...prev, url]);
    }).finally(() => setScanning(false));
  };

  const handleLogout = async () => {
    await clearToken();
    onLogout();
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Settings</Text>

        {/* Server info */}
        <Section title="SERVER">
          {!isEditingServer && (
            <View style={rowStyles.container}>
              <Ionicons name="server-outline" size={20} color={colors.textDim} />
              <Text style={rowStyles.label}>Server URL</Text>
              <Text style={[rowStyles.value, { fontSize: 13 }]} numberOfLines={1}>{serverUrl || 'Not configured'}</Text>
              <TouchableOpacity
                style={serverStyles.changeBtn}
                onPress={() => { setEditingUrl(serverUrl); setIsEditingServer(true); }}
                activeOpacity={0.7}
              >
                <Text style={serverStyles.changeText}>Change</Text>
              </TouchableOpacity>
            </View>
          )}
          {isEditingServer && (
            <View style={serverStyles.editContainer}>
              <View style={serverStyles.inputRow}>
                <TextInput
                  style={serverStyles.input}
                  value={editingUrl}
                  onChangeText={setEditingUrl}
                  placeholder="http://192.168.0.177:3000"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="done"
                  onSubmitEditing={() => handleChangeServer(editingUrl)}
                />
              </View>
              {/* Discover servers */}
              <TouchableOpacity style={serverStyles.discoverBtn} onPress={handleDiscover} disabled={scanning} activeOpacity={0.7}>
                {scanning ? (
                  <ActivityIndicator size="small" color={colors.emerald} />
                ) : (
                  <Ionicons name="search" size={16} color={colors.emerald} />
                )}
                <Text style={serverStyles.discoverText}>
                  {scanning ? 'Scanning...' : 'Find servers on network'}
                </Text>
              </TouchableOpacity>
              {discoveredServers.map((url) => (
                <TouchableOpacity
                  key={url}
                  style={serverStyles.serverItem}
                  onPress={() => { setEditingUrl(url); handleChangeServer(url); }}
                  activeOpacity={0.7}
                >
                  <Ionicons name="server" size={16} color={colors.emerald} />
                  <Text style={serverStyles.serverUrl}>{url}</Text>
                </TouchableOpacity>
              ))}
              {/* Cancel / Save */}
              <View style={serverStyles.buttonRow}>
                <TouchableOpacity style={serverStyles.cancelBtn} onPress={() => setIsEditingServer(false)} activeOpacity={0.7}>
                  <Text style={serverStyles.cancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={serverStyles.saveBtn} onPress={() => handleChangeServer(editingUrl)} activeOpacity={0.7}>
                  <Text style={serverStyles.saveText}>Connect</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          <SettingsRow
            icon="pulse"
            label="Connection"
            value={connected ? 'Connected' : 'Disconnected'}
            valueColor={connected ? colors.green : colors.red}
          />
        </Section>

        {/* Account */}
        <Section title="ACCOUNT">
          <SettingsRow icon="mail-outline" label="Email" value={email || 'Unknown'} />
        </Section>

        {/* Controls */}
        {mower?.online && (
          <Section title="CONTROLS">
            <View style={rowStyles.container}>
              <Ionicons name="flashlight-outline" size={20} color={colors.textDim} />
              <Text style={rowStyles.label}>Headlight</Text>
              <Switch
                value={headlightOn}
                onValueChange={toggleHeadlight}
                trackColor={{ false: '#374151', true: 'rgba(0,212,170,0.3)' }}
                thumbColor={headlightOn ? colors.emerald : '#6b7280'}
              />
            </View>
          </Section>
        )}

        {/* Actions */}
        <Section title="ACTIONS">
          {mower?.online && (
            <TouchableOpacity
              style={styles.actionRow}
              onPress={() => setShowJoystick(true)}
              activeOpacity={0.7}
            >
              <Ionicons name="game-controller-outline" size={20} color={colors.purple} />
              <Text style={styles.actionLabel}>Manual Control</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
            </TouchableOpacity>
          )}
          {onGoToMowerSettings && (
            <TouchableOpacity
              style={styles.actionRow}
              onPress={onGoToMowerSettings}
              activeOpacity={0.7}
            >
              <Ionicons name="options-outline" size={20} color={colors.amber} />
              <Text style={styles.actionLabel}>Mower Settings</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
            </TouchableOpacity>
          )}
          {onGoToOta && (
            <TouchableOpacity
              style={styles.actionRow}
              onPress={onGoToOta}
              activeOpacity={0.7}
            >
              <Ionicons name="cloud-download-outline" size={20} color={colors.blue} />
              <Text style={styles.actionLabel}>Firmware Updates</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.actionRow}
            onPress={onGoToProvision}
            activeOpacity={0.7}
          >
            <Ionicons name="bluetooth-outline" size={20} color={colors.emerald} />
            <Text style={styles.actionLabel}>Re-provision Device</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
          </TouchableOpacity>
        </Section>

        {/* Logout */}
        <TouchableOpacity
          style={styles.logoutButton}
          onPress={handleLogout}
          activeOpacity={0.7}
        >
          <Ionicons name="log-out-outline" size={20} color={colors.red} />
          <Text style={styles.logoutText}>Sign Out</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={devMode.handleTap} activeOpacity={1}>
          <Text style={styles.versionText}>
            OpenNova App v1.1.0
            {devMode.tapCount >= 4 && devMode.tapCount < 7
              ? `  (${7 - devMode.tapCount} taps to go...)`
              : devMode.unlocked
                ? '  [Developer Mode]'
                : ''}
          </Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Joystick modal */}
      {showJoystick && mower && (
        <Modal visible animationType="slide" transparent>
          <View style={styles.modalOverlay}>
            <JoystickControl sn={mower.sn} onClose={() => setShowJoystick(false)} />
          </View>
        </Modal>
      )}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function SettingsRow({
  icon,
  label,
  value,
  valueColor,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={rowStyles.container}>
      <Ionicons name={icon} size={20} color={colors.textDim} />
      <Text style={rowStyles.label}>{label}</Text>
      <Text
        style={[rowStyles.value, valueColor ? { color: valueColor } : undefined]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 24, paddingBottom: 32 },
  title: { fontSize: 28, fontWeight: '700', color: colors.white, marginBottom: 24 },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 13, fontWeight: '600', color: colors.textDim,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginLeft: 4,
  },
  card: {
    backgroundColor: colors.card, borderRadius: 16,
    borderWidth: 1, borderColor: colors.cardBorder, overflow: 'hidden',
  },
  actionRow: {
    flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12,
  },
  actionLabel: { flex: 1, fontSize: 16, color: colors.white },
  logoutButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    height: 48, borderRadius: 12,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.2)',
    gap: 8, marginTop: 8,
  },
  logoutText: { fontSize: 16, fontWeight: '600', color: colors.red },
  versionText: { fontSize: 12, color: colors.textMuted, textAlign: 'center', marginTop: 24 },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
});

const serverStyles = StyleSheet.create({
  changeBtn: {
    paddingHorizontal: 12, paddingVertical: 5, borderRadius: 8,
    backgroundColor: 'rgba(0,212,170,0.15)',
  },
  changeText: { fontSize: 13, fontWeight: '600', color: colors.emerald },
  editContainer: { padding: 16, gap: 12 },
  inputRow: { flexDirection: 'row', alignItems: 'center' },
  input: {
    flex: 1, height: 44, backgroundColor: colors.inputBg,
    borderRadius: 10, borderWidth: 1, borderColor: colors.inputBorder,
    paddingHorizontal: 14, fontSize: 15, color: colors.white,
  },
  discoverBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 8,
  },
  discoverText: { fontSize: 14, color: colors.emerald },
  serverItem: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: 12,
    backgroundColor: 'rgba(0,212,170,0.08)', borderRadius: 10,
  },
  serverUrl: { fontSize: 14, color: colors.white, fontFamily: 'monospace' },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  cancelBtn: {
    flex: 1, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  cancelText: { fontSize: 14, fontWeight: '600', color: colors.textDim },
  saveBtn: {
    flex: 1, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.emerald,
  },
  saveText: { fontSize: 14, fontWeight: '600', color: colors.white },
});

const rowStyles = StyleSheet.create({
  container: {
    flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  label: { fontSize: 15, color: colors.textDim },
  value: { flex: 1, fontSize: 15, color: colors.white, textAlign: 'right' },
});
