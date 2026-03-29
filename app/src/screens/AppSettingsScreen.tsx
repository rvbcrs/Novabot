/**
 * App settings screen — server info, account, logout.
 */
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { getServerUrl, getToken, clearToken } from '../services/auth';
import { useMowerState } from '../hooks/useMowerState';

interface AppSettingsScreenProps {
  onLogout: () => void;
  onGoToProvision: () => void;
}

export default function AppSettingsScreen({
  onLogout,
  onGoToProvision,
}: AppSettingsScreenProps) {
  const insets = useSafeAreaInsets();
  const { connected } = useMowerState();
  const [serverUrl, setServerUrl] = useState('');
  const [email, setEmail] = useState('');

  useEffect(() => {
    (async () => {
      const url = await getServerUrl();
      if (url) setServerUrl(url);

      // Try to extract email from token (JWT)
      const token = await getToken();
      if (token) {
        try {
          const parts = token.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(atob(parts[1]));
            if (payload.email) setEmail(payload.email);
          }
        } catch {
          // Token format not standard JWT, that's ok
        }
      }
    })();
  }, []);

  const handleLogout = async () => {
    await clearToken();
    onLogout();
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Settings</Text>

        {/* Server info */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>SERVER</Text>
          <View style={styles.card}>
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
          </View>
        </View>

        {/* Account */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>ACCOUNT</Text>
          <View style={styles.card}>
            <SettingsRow
              icon="mail-outline"
              label="Email"
              value={email || 'Unknown'}
            />
          </View>
        </View>

        {/* Actions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>ACTIONS</Text>
          <View style={styles.card}>
            <TouchableOpacity
              style={styles.actionRow}
              onPress={onGoToProvision}
              activeOpacity={0.7}
            >
              <Ionicons
                name="bluetooth-outline"
                size={20}
                color={colors.emerald}
              />
              <Text style={styles.actionLabel}>Re-provision Device</Text>
              <Ionicons
                name="chevron-forward"
                size={18}
                color={colors.textDim}
              />
            </TouchableOpacity>
          </View>
        </View>

        {/* Logout */}
        <TouchableOpacity
          style={styles.logoutButton}
          onPress={handleLogout}
          activeOpacity={0.7}
        >
          <Ionicons name="log-out-outline" size={20} color={colors.red} />
          <Text style={styles.logoutText}>Sign Out</Text>
        </TouchableOpacity>

        {/* App version */}
        <Text style={styles.versionText}>OpenNova App v1.0.0</Text>
      </ScrollView>
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
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    padding: 24,
    paddingBottom: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.white,
    marginBottom: 24,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    overflow: 'hidden',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
  },
  actionLabel: {
    flex: 1,
    fontSize: 16,
    color: colors.white,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: 12,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.2)',
    gap: 8,
    marginTop: 8,
  },
  logoutText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.red,
  },
  versionText: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 24,
  },
});

const rowStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  label: {
    fontSize: 15,
    color: colors.textDim,
  },
  value: {
    flex: 1,
    fontSize: 15,
    color: colors.white,
    textAlign: 'right',
  },
});
