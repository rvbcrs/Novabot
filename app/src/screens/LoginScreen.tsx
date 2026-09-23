/**
 * Login screen — server URL input, email/password authentication.
 */
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useStyles, useTheme, type Colors } from '../theme';
import type { AuthStackParams } from '../navigation/types';
import { getServerUrl, setServerUrl, setToken } from '../services/auth';
import { ApiClient, AuthError } from '../services/api';
import { discoverServers } from '../services/discovery';
import { useI18n } from '../i18n';

type Props = NativeStackScreenProps<AuthStackParams, 'Login'> & {
  onLoginSuccess: (token: string, serverUrl: string) => void;
};

export default function LoginScreen({ navigation, onLoginSuccess }: Props) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useI18n();
  const [serverUrl, setServerUrlState] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Format: "http://opennova.local|192.168.0.222". The lanIp suffix lets the
  // render layer show the LAN address muted under the hostname so two
  // candidates on a multi-homed network are distinguishable.
  const [discoveredServers, setDiscoveredServers] = useState<string[]>([]);

  const runDiscover = () => {
    if (scanning) return;
    setScanning(true);
    setDiscoveredServers([]);
    discoverServers((server) => {
      const url = `http://${server.ip}`;
      const entry = server.lanIp && server.lanIp !== server.ip
        ? `${url}|${server.lanIp}`
        : url;
      setDiscoveredServers((prev) => prev.includes(entry) ? prev : [...prev, entry]);
    }).finally(() => setScanning(false));
  };

  // Load saved server URL on mount
  useEffect(() => {
    (async () => {
      const saved = await getServerUrl();
      if (saved) {
        setServerUrlState(saved);
      }
      setLoaded(true);
    })();
  }, []);

  // Auto-discover servers on first launch (no saved URL).
  // The discovered list is always shown so users can pick even when a URL
  // is already saved (e.g. moved to a different network).
  useEffect(() => {
    if (!loaded) return;
    if (serverUrl) return;
    runDiscover();
  }, [loaded]);

  const handleLogin = async () => {
    setError('');
    if (!serverUrl.trim()) {
      setError(t('pvServerUrlRequired'));
      return;
    }
    if (!email.trim()) {
      setError(t('pvEmailRequired'));
      return;
    }
    if (!password) {
      setError(t('pvPasswordRequired'));
      return;
    }

    setLoading(true);
    try {
      const normalizedUrl = serverUrl.trim().replace(/\/+$/, '');
      const api = new ApiClient(normalizedUrl);

      // Verify server is reachable
      try {
        await api.healthCheck();
      } catch {
        setError(t('pvCannotReachServer'));
        setLoading(false);
        return;
      }

      const response = await api.login(email.trim(), password);

      if (response.success && response.value?.accessToken) {
        await setServerUrl(normalizedUrl);
        await setToken(response.value.accessToken);
        onLoginSuccess(response.value.accessToken, normalizedUrl);
      } else {
        setError(response.message ?? t('pvInvalidCredentials'));
      }
    } catch (e) {
      if (e instanceof AuthError) {
        setError(t('pvInvalidCredentials'));
      } else if (e instanceof Error) {
        setError(e.message);
      } else {
        setError(t('pvUnexpectedError'));
      }
    } finally {
      setLoading(false);
    }
  };

  if (!loaded) return <View style={styles.container} />;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.iconCircle}>
            <Image source={require('../../assets/icon.png')} style={styles.logo} />
          </View>
          <Text style={styles.title}>OpenNova</Text>
          <Text style={styles.subtitle}>
            {t('pvLoginSubtitle')}
          </Text>
        </View>

        {/* Server URL */}
        <View style={styles.card}>
          <Text style={styles.label}>{t('serverUrl')}</Text>
          <View style={styles.inputRow}>
            <Ionicons
              name="server-outline"
              size={20}
              color={colors.textDim}
              style={styles.inputIcon}
            />
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={(text) => {
                setServerUrlState(text);
                setError('');
              }}
              placeholder="http://192.168.0.222"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="next"
            />
          </View>

          {/* Discover servers — auto-runs on first launch, manual rescan available. */}
          <TouchableOpacity
            style={styles.discoverBtn}
            onPress={runDiscover}
            disabled={scanning}
            activeOpacity={0.7}
          >
            {scanning ? (
              <ActivityIndicator size="small" color={colors.emerald} />
            ) : (
              <Ionicons name="search" size={16} color={colors.emerald} />
            )}
            <Text style={styles.discoverText}>
              {scanning ? t('pvScanning') : t('pvFindServers')}
            </Text>
          </TouchableOpacity>

          {discoveredServers.map((entry) => {
            const [url, lanIp] = entry.split('|');
            return (
              <TouchableOpacity
                key={entry}
                style={styles.serverItem}
                onPress={() => {
                  setServerUrlState(url);
                  setError('');
                }}
                activeOpacity={0.7}
              >
                <Ionicons name="server" size={16} color={colors.emerald} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.serverUrl}>{url}</Text>
                  {lanIp ? (
                    <Text style={styles.serverLanIp}>{lanIp}</Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            );
          })}

          <Text style={[styles.label, { marginTop: 20 }]}>{t('pvEmail')}</Text>
          <View style={styles.inputRow}>
            <Ionicons
              name="mail-outline"
              size={20}
              color={colors.textDim}
              style={styles.inputIcon}
            />
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={(text) => {
                setEmail(text);
                setError('');
              }}
              placeholder="your@email.com"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              returnKeyType="next"
            />
          </View>

          <Text style={[styles.label, { marginTop: 20 }]}>{t('pvPassword')}</Text>
          <View style={styles.inputRow}>
            <Ionicons
              name="lock-closed-outline"
              size={20}
              color={colors.textDim}
              style={styles.inputIcon}
            />
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={(text) => {
                setPassword(text);
                setError('');
              }}
              placeholder={t('pvPassword')}
              placeholderTextColor={colors.textMuted}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleLogin}
            />
            <TouchableOpacity
              onPress={() => setShowPassword(!showPassword)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons
                name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                size={20}
                color={colors.textDim}
              />
            </TouchableOpacity>
          </View>
        </View>

        {/* Error message */}
        {error !== '' && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={18} color={colors.red} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Login button */}
        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleLogin}
          disabled={loading}
          activeOpacity={0.7}
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.white} />
          ) : (
            <>
              <Text style={styles.buttonText}>{t('pvSignIn')}</Text>
              <Ionicons name="arrow-forward" size={20} color={colors.white} />
            </>
          )}
        </TouchableOpacity>

        {/* Register button — promoted to a full button so first-time
            users on a fresh server can see the path to create an account
            immediately. Previously this was a small grey link buried
            below the Sign In button. */}
        <TouchableOpacity
          style={styles.registerButton}
          onPress={() => navigation.navigate('Register')}
          activeOpacity={0.7}
        >
          <Ionicons name="person-add-outline" size={18} color={colors.emerald} />
          <Text style={styles.registerButtonText}>{t('pvCreateNewAccount')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.bg,
  },
  scroll: {
    flexGrow: 1,
    padding: 24,
    paddingTop: 80,
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
  },
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(0,212,170,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    overflow: 'hidden',
  },
  logo: {
    width: 64,
    height: 64,
    borderRadius: 32,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: c.text,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: c.textDim,
    textAlign: 'center',
    lineHeight: 22,
  },
  card: {
    backgroundColor: c.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.cardBorder,
    padding: 20,
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: c.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.inputBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.inputBorder,
    height: 48,
    paddingHorizontal: 12,
  },
  inputIcon: {
    marginRight: 10,
  },
  input: {
    flex: 1,
    fontSize: 16,
    color: c.text,
    height: 48,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.2)',
    padding: 12,
    marginBottom: 16,
    gap: 8,
  },
  errorText: {
    flex: 1,
    fontSize: 14,
    color: c.red,
    lineHeight: 20,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.emerald,
    height: 48,
    borderRadius: 12,
    gap: 8,
  },
  buttonDisabled: {
    backgroundColor: c.emeraldDark,
    opacity: 0.7,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: c.text,
  },
  registerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.emerald,
    backgroundColor: 'rgba(16,185,129,0.08)',
  },
  registerButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: c.emerald,
  },
  discoverBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    marginTop: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.4)',
    backgroundColor: 'rgba(16,185,129,0.08)',
  },
  discoverText: {
    fontSize: 14,
    fontWeight: '600',
    color: c.emerald,
  },
  serverItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 8,
    borderRadius: 10,
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.inputBorder,
  },
  serverUrl: {
    fontSize: 14,
    color: c.text,
    fontWeight: '500',
  },
  serverLanIp: {
    fontSize: 11,
    color: c.textDim,
    marginTop: 2,
  },
});
