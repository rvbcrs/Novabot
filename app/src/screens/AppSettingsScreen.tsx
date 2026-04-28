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
import { useTheme, useStyles, type Colors, type ThemeMode } from '../theme';
import { useMowerColor, type MowerColor } from '../hooks/useMowerColor';
import { getServerUrl, setServerUrl as saveServerUrl, getToken, clearToken } from '../services/auth';
import { initSocket, disconnectSocket } from '../services/socket';
import { discoverServers } from '../services/discovery';
import { useMowerState } from '../hooks/useMowerState';
import { useActiveMower } from '../hooks/useActiveMower';
import { ApiClient } from '../services/api';
import { useDevMode } from '../context/DevModeContext';
import { useExperimental } from '../context/ExperimentalContext';
import { useI18n, LANGUAGES } from '../i18n';

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
  const { mode, setMode, colors } = useTheme();
  const { activeMower } = useActiveMower();
  const { mowerColor, setMowerColor } = useMowerColor(activeMower?.sn);
  const styles = useStyles(makeStyles);
  const { devices, connected } = useMowerState();
  const [serverUrl, setServerUrl] = useState('');
  const [editingUrl, setEditingUrl] = useState('');
  const [isEditingServer, setIsEditingServer] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [discoveredServers, setDiscoveredServers] = useState<string[]>([]);
  const [email, setEmail] = useState('');
  const devMode = useDevMode();
  const experimental = useExperimental();
  const { language, setLanguage, t } = useI18n();

  const { activeMower: mower } = useActiveMower();

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
      const url = `http://${server.ip}`;
      setDiscoveredServers((prev) => prev.includes(url) ? prev : [...prev, url]);
    }).finally(() => setScanning(false));
  };

  const handleLogout = async () => {
    await clearToken();
    onLogout();
  };

  const modes: ThemeMode[] = ['auto', 'light', 'dark'];
  const modeLabel: Record<ThemeMode, string> = {
    auto: t('appearanceAuto'),
    light: t('appearanceLight'),
    dark: t('appearanceDark'),
  };
  const captionKey: Record<ThemeMode, 'appearanceAutoCaption' | 'appearanceLightCaption' | 'appearanceDarkCaption'> = {
    auto: 'appearanceAutoCaption',
    light: 'appearanceLightCaption',
    dark: 'appearanceDarkCaption',
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Settings</Text>

        {/* Appearance */}
        <View style={styles.appearanceSection}>
          <Text style={styles.sectionTitle}>{t('appearance')}</Text>
          <View style={styles.segment}>
            {modes.map((m) => (
              <TouchableOpacity
                key={m}
                style={[styles.segmentItem, m === mode && styles.segmentItemActive]}
                onPress={() => { setMode(m); }}
                activeOpacity={0.7}
              >
                <Text style={[styles.segmentLabel, m === mode && styles.segmentLabelActive]}>
                  {modeLabel[m]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.segmentCaption}>{t(captionKey[mode])}</Text>
        </View>

        {/* Mower colour — per active mower SN */}
        {activeMower?.sn && (
          <View style={styles.appearanceSection}>
            <Text style={styles.sectionTitle}>{t('mowerColor')}</Text>
            <View style={styles.segment}>
              {(['white', 'grey'] as MowerColor[]).map((mc) => (
                <TouchableOpacity
                  key={mc}
                  style={[styles.segmentItem, mc === mowerColor && styles.segmentItemActive]}
                  onPress={() => { setMowerColor(mc); }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.segmentLabel, mc === mowerColor && styles.segmentLabelActive]}>
                    {mc === 'white' ? t('mowerColorWhite') : t('mowerColorGrey')}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* Server info */}
        <Section title="SERVER">
          {!isEditingServer && (
            <View style={styles.rowContainer}>
              <Ionicons name="server-outline" size={20} color={colors.textDim} />
              <Text style={styles.rowLabel}>Server URL</Text>
              <Text style={[styles.rowValue, { fontSize: 13 }]} numberOfLines={1}>{serverUrl || 'Not configured'}</Text>
              <TouchableOpacity
                style={styles.changeBtn}
                onPress={() => { setEditingUrl(serverUrl); setIsEditingServer(true); }}
                activeOpacity={0.7}
              >
                <Text style={styles.changeText}>Change</Text>
              </TouchableOpacity>
            </View>
          )}
          {isEditingServer && (
            <View style={styles.editContainer}>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.input}
                  value={editingUrl}
                  onChangeText={setEditingUrl}
                  placeholder="http://192.168.0.222"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="done"
                  onSubmitEditing={() => handleChangeServer(editingUrl)}
                />
              </View>
              {/* Discover servers */}
              <TouchableOpacity style={styles.discoverBtn} onPress={handleDiscover} disabled={scanning} activeOpacity={0.7}>
                {scanning ? (
                  <ActivityIndicator size="small" color={colors.emerald} />
                ) : (
                  <Ionicons name="search" size={16} color={colors.emerald} />
                )}
                <Text style={styles.discoverText}>
                  {scanning ? 'Scanning...' : 'Find servers on network'}
                </Text>
              </TouchableOpacity>
              {discoveredServers.map((url) => (
                <TouchableOpacity
                  key={url}
                  style={styles.serverItem}
                  onPress={() => { setEditingUrl(url); handleChangeServer(url); }}
                  activeOpacity={0.7}
                >
                  <Ionicons name="server" size={16} color={colors.emerald} />
                  <Text style={styles.serverUrl}>{url}</Text>
                </TouchableOpacity>
              ))}
              {/* Cancel / Save */}
              <View style={styles.buttonRow}>
                <TouchableOpacity style={styles.cancelBtn} onPress={() => setIsEditingServer(false)} activeOpacity={0.7}>
                  <Text style={styles.cancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.saveBtn} onPress={() => handleChangeServer(editingUrl)} activeOpacity={0.7}>
                  <Text style={styles.saveText}>Connect</Text>
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

        {/* Headlight toggle + brightness slider leven in Mower Settings
            (één plek, met 0-255 brightness control). Hier geen duplicaat. */}

        {/* Actions */}
        <Section title="ACTIONS">
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
            <Ionicons name="add-circle-outline" size={20} color={colors.emerald} />
            <Text style={styles.actionLabel}>Add mower</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
          </TouchableOpacity>
        </Section>

        {/* Language */}
        <Section title={t('language')}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 4 }}>
            {LANGUAGES.map(lang => (
              <TouchableOpacity
                key={lang.code}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10,
                  backgroundColor: language === lang.code ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.06)',
                  borderWidth: 1,
                  borderColor: language === lang.code ? colors.emerald : 'rgba(255,255,255,0.08)',
                }}
                onPress={() => setLanguage(lang.code)}
                activeOpacity={0.7}
              >
                <Text style={{ fontSize: 18 }}>{lang.flag}</Text>
                <Text style={{
                  color: language === lang.code ? colors.emerald : colors.textDim,
                  fontSize: 13, fontWeight: '600',
                }}>{lang.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Section>

        {/* Experimental features */}
        <Section title="Features">
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 4 }}>
            <Ionicons name="flask" size={22} color={experimental.enabled ? '#a855f7' : colors.textMuted} style={{ marginRight: 12 }} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.white, fontSize: 15, fontWeight: '600' }}>Experimental Features</Text>
              <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 4, lineHeight: 16 }}>Enable beta features like autonomous mapping</Text>
            </View>
            <Switch
              value={experimental.enabled}
              onValueChange={experimental.toggle}
              trackColor={{ false: 'rgba(255,255,255,0.1)', true: 'rgba(168,85,247,0.4)' }}
              thumbColor={experimental.enabled ? '#a855f7' : '#666'}
            />
          </View>
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

    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const styles = useStyles(makeStyles);
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
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.rowContainer}>
      <Ionicons name={icon} size={20} color={colors.textDim} />
      <Text style={styles.rowLabel}>{label}</Text>
      <Text
        style={[styles.rowValue, valueColor ? { color: valueColor } : undefined]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  // Layout
  container: { flex: 1, backgroundColor: c.bg },
  scroll: { padding: 24, paddingBottom: 32 },
  title: { fontSize: 28, fontWeight: '700', color: c.text, marginBottom: 24 },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 13, fontWeight: '600', color: c.textDim,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginLeft: 4,
  },
  card: {
    backgroundColor: c.card, borderRadius: 16,
    borderWidth: 1, borderColor: c.cardBorder, overflow: 'hidden',
  },
  actionRow: {
    flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12,
  },
  actionLabel: { flex: 1, fontSize: 16, color: c.text },
  logoutButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    height: 48, borderRadius: 12,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.2)',
    gap: 8, marginTop: 8,
  },
  logoutText: { fontSize: 16, fontWeight: '600', color: c.red },
  versionText: { fontSize: 12, color: c.textMuted, textAlign: 'center', marginTop: 24 },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },

  // Server edit styles
  changeBtn: {
    paddingHorizontal: 12, paddingVertical: 5, borderRadius: 8,
    backgroundColor: 'rgba(0,212,170,0.15)',
  },
  changeText: { fontSize: 13, fontWeight: '600', color: c.emerald },
  editContainer: { padding: 16, gap: 12 },
  inputRow: { flexDirection: 'row', alignItems: 'center' },
  input: {
    flex: 1, height: 44, backgroundColor: c.inputBg,
    borderRadius: 10, borderWidth: 1, borderColor: c.inputBorder,
    paddingHorizontal: 14, fontSize: 15, color: c.text,
  },
  discoverBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 8,
  },
  discoverText: { fontSize: 14, color: c.emerald },
  serverItem: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: 12,
    backgroundColor: 'rgba(0,212,170,0.08)', borderRadius: 10,
  },
  serverUrl: { fontSize: 14, color: c.text, fontFamily: 'monospace' },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  cancelBtn: {
    flex: 1, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.inputBg, borderWidth: 1, borderColor: c.cardBorder,
  },
  cancelText: { fontSize: 14, fontWeight: '600', color: c.textDim },
  saveBtn: {
    flex: 1, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.emerald,
  },
  saveText: { fontSize: 14, fontWeight: '600', color: c.white },

  // Row styles (formerly rowStyles)
  rowContainer: {
    flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12,
    borderBottomWidth: 1, borderBottomColor: c.cardBorder,
  },
  rowLabel: { fontSize: 15, color: c.textDim },
  rowValue: { flex: 1, fontSize: 15, color: c.text, textAlign: 'right' },

  // Appearance segment
  appearanceSection: {
    marginBottom: 24,
  },
  segment: {
    flexDirection: 'row',
    backgroundColor: c.card,
    borderRadius: 10,
    padding: 4,
    borderWidth: 1,
    borderColor: c.cardBorder,
  },
  segmentItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 7,
  },
  segmentItemActive: {
    backgroundColor: c.emerald,
  },
  segmentLabel: {
    fontSize: 14,
    color: c.textDim,
    fontWeight: '600',
  },
  segmentLabelActive: {
    color: c.white,
  },
  segmentCaption: {
    fontSize: 12,
    color: c.textMuted,
    marginTop: 8,
    marginLeft: 4,
  },
});
