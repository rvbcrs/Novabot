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
import { colors } from '../theme/colors';
import type { AuthStackParams } from '../navigation/types';
import { getServerUrl, setServerUrl, setToken } from '../services/auth';
import { ApiClient, AuthError } from '../services/api';
import { discoverServers } from '../services/discovery';
import { useDevMode } from '../context/DevModeContext';

type Props = NativeStackScreenProps<AuthStackParams, 'Login'> & {
  onLoginSuccess: (token: string, serverUrl: string) => void;
};

export default function LoginScreen({ navigation, onLoginSuccess }: Props) {
  const [serverUrl, setServerUrlState] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const devMode = useDevMode();

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

  // Auto-discover servers on mount
  useEffect(() => {
    if (!loaded) return;
    if (serverUrl) return; // Don't scan if we already have a URL

    setScanning(true);
    discoverServers((server) => {
      setServerUrlState(`http://${server.ip}:3000`);
    }).finally(() => setScanning(false));
  }, [loaded, serverUrl]);

  const handleLogin = async () => {
    setError('');
    if (!serverUrl.trim()) {
      setError('Server URL is required');
      return;
    }
    if (!email.trim()) {
      setError('Email is required');
      return;
    }
    if (!password) {
      setError('Password is required');
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
        setError('Cannot reach server. Check the URL and try again.');
        setLoading(false);
        return;
      }

      const response = await api.login(email.trim(), password);

      if (response.success && response.value?.accessToken) {
        await setServerUrl(normalizedUrl);
        await setToken(response.value.accessToken);
        onLoginSuccess(response.value.accessToken, normalizedUrl);
      } else {
        setError(response.message ?? 'Invalid email or password');
      }
    } catch (e) {
      if (e instanceof AuthError) {
        setError('Invalid email or password');
      } else if (e instanceof Error) {
        setError(e.message);
      } else {
        setError('An unexpected error occurred');
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
          <TouchableOpacity onPress={devMode.handleTap} activeOpacity={0.9} style={styles.iconCircle}>
            <Image source={require('../../assets/icon.png')} style={styles.logo} />
          </TouchableOpacity>
          <Text style={styles.title}>OpenNova</Text>
          <Text style={styles.subtitle}>
            {devMode.unlocked
              ? 'Developer mode active. Sign in to access the full app.'
              : 'Sign in to your local server to control your mower.'}
          </Text>
          {devMode.unlocked && (
            <View style={{ backgroundColor: 'rgba(124,58,237,0.15)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, marginTop: 8 }}>
              <Text style={{ color: '#c084fc', fontSize: 13, fontWeight: '600', textAlign: 'center' }}>Developer Mode</Text>
            </View>
          )}
        </View>

        {/* Server URL */}
        <View style={styles.card}>
          <Text style={styles.label}>SERVER URL</Text>
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
              placeholder="http://192.168.0.177:3000"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="next"
            />
            {scanning && (
              <ActivityIndicator size="small" color={colors.emerald} />
            )}
          </View>

          <Text style={[styles.label, { marginTop: 20 }]}>EMAIL</Text>
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

          <Text style={[styles.label, { marginTop: 20 }]}>PASSWORD</Text>
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
              placeholder="Password"
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
              <Text style={styles.buttonText}>Sign In</Text>
              <Ionicons name="arrow-forward" size={20} color={colors.white} />
            </>
          )}
        </TouchableOpacity>

        {/* Register link */}
        <TouchableOpacity
          style={styles.registerLink}
          onPress={() => navigation.navigate('Register')}
          activeOpacity={0.7}
        >
          <Text style={styles.registerText}>
            Don't have an account?{' '}
            <Text style={styles.registerTextHighlight}>Create one</Text>
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
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
    color: colors.white,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: colors.textDim,
    textAlign: 'center',
    lineHeight: 22,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 20,
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.inputBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.inputBorder,
    height: 48,
    paddingHorizontal: 12,
  },
  inputIcon: {
    marginRight: 10,
  },
  input: {
    flex: 1,
    fontSize: 16,
    color: colors.white,
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
    color: colors.red,
    lineHeight: 20,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.emerald,
    height: 48,
    borderRadius: 12,
    gap: 8,
  },
  buttonDisabled: {
    backgroundColor: colors.emeraldDark,
    opacity: 0.7,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.white,
  },
  registerLink: {
    alignItems: 'center',
    marginTop: 24,
    paddingVertical: 8,
  },
  registerText: {
    fontSize: 15,
    color: colors.textDim,
  },
  registerTextHighlight: {
    color: colors.emerald,
    fontWeight: '600',
  },
});
