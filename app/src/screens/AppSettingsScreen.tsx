/**
 * App settings screen — server info, account, device controls, logout.
 */
import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Switch,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { getServerUrl, getToken, clearToken } from '../services/auth';
import { useMowerState } from '../hooks/useMowerState';
import { ApiClient } from '../services/api';
import { JoystickControl } from '../components/JoystickControl';

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
  const [email, setEmail] = useState('');
  const [headlightOn, setHeadlightOn] = useState(false);
  const [showJoystick, setShowJoystick] = useState(false);

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
          <SettingsRow
            icon="server-outline"
            label="Server URL"
            value={serverUrl || 'Not configured'}
          />
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

        {/* Devices */}
        {(mower || charger) && (
          <Section title="DEVICES">
            {mower && (
              <>
                <SettingsRow
                  icon="construct-outline"
                  label="Mower"
                  value={mower.online ? 'Online' : 'Offline'}
                  valueColor={mower.online ? colors.green : colors.red}
                />
                <SettingsRow
                  icon="hardware-chip-outline"
                  label="Serial"
                  value={mower.sn}
                />
                {mower.sensors.mower_version && (
                  <SettingsRow
                    icon="code-outline"
                    label="Firmware"
                    value={`v${mower.sensors.mower_version}`}
                  />
                )}
              </>
            )}
            {charger && (
              <>
                <SettingsRow
                  icon="flash-outline"
                  label="Charger"
                  value={charger.online ? 'Online' : 'Offline'}
                  valueColor={charger.online ? colors.green : colors.red}
                />
                <SettingsRow
                  icon="hardware-chip-outline"
                  label="Serial"
                  value={charger.sn}
                />
              </>
            )}
          </Section>
        )}

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

        <Text style={styles.versionText}>OpenNova App v1.1.0</Text>
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

const rowStyles = StyleSheet.create({
  container: {
    flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  label: { fontSize: 15, color: colors.textDim },
  value: { flex: 1, fontSize: 15, color: colors.white, textAlign: 'right' },
});
