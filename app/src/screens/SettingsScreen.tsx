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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { colors } from '../theme/colors';
import type { RootStackParams } from '../navigation/types';
import { discoverServers, type DiscoveredServer } from '../services/discovery';

type Props = NativeStackScreenProps<RootStackParams, 'Settings'>;

const STORE_KEY_ADDR = 'mqtt_addr';
const STORE_KEY_PORT = 'mqtt_port';

export default function SettingsScreen({ navigation }: Props) {
  const [mqttAddr, setMqttAddr] = useState('192.168.0.177');
  const [mqttPort, setMqttPort] = useState('1883');
  const [loaded, setLoaded] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [servers, setServers] = useState<DiscoveredServer[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const savedAddr = await SecureStore.getItemAsync(STORE_KEY_ADDR);
        const savedPort = await SecureStore.getItemAsync(STORE_KEY_PORT);
        if (savedAddr) setMqttAddr(savedAddr);
        if (savedPort) setMqttPort(savedPort);
      } catch {}
      setLoaded(true);
    })();
  }, []);

  // Auto-discover servers on mount
  useEffect(() => {
    if (!loaded) return;
    setScanning(true);
    const found: DiscoveredServer[] = [];
    discoverServers((server) => {
      found.push(server);
      setServers([...found]);
      // Auto-fill first discovered server
      if (found.length === 1) {
        setMqttAddr(server.ip);
      }
    }).finally(() => setScanning(false));
  }, [loaded]);

  const handleNext = async () => {
    const port = parseInt(mqttPort, 10);
    if (!mqttAddr.trim() || isNaN(port) || port < 1 || port > 65535) return;

    try {
      await SecureStore.setItemAsync(STORE_KEY_ADDR, mqttAddr.trim());
      await SecureStore.setItemAsync(STORE_KEY_PORT, String(port));
    } catch {}

    navigation.navigate('DeviceChoice', { mqttAddr: mqttAddr.trim(), mqttPort: port });
  };

  const handleRescan = () => {
    setServers([]);
    setScanning(true);
    const found: DiscoveredServer[] = [];
    discoverServers((server) => {
      found.push(server);
      setServers([...found]);
    }).finally(() => setScanning(false));
  };

  const isValid = mqttAddr.trim().length > 0 && !isNaN(parseInt(mqttPort, 10));

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
            <Ionicons name="server-outline" size={32} color={colors.emerald} />
          </View>
          <Text style={styles.title}>Server Settings</Text>
          <Text style={styles.subtitle}>
            Select your OpenNova server or enter the address manually.
          </Text>
        </View>

        {/* Discovered servers */}
        {(scanning || servers.length > 0) && (
          <View style={styles.discoveryCard}>
            <View style={styles.discoveryHeader}>
              <Text style={styles.discoveryTitle}>
                {scanning ? 'Searching for servers...' : `Found ${servers.length} server${servers.length !== 1 ? 's' : ''}`}
              </Text>
              {scanning ? (
                <ActivityIndicator size="small" color={colors.emerald} />
              ) : (
                <TouchableOpacity onPress={handleRescan}>
                  <Ionicons name="refresh" size={18} color={colors.textDim} />
                </TouchableOpacity>
              )}
            </View>

            {servers.map((s) => (
              <TouchableOpacity
                key={s.ip}
                style={[
                  styles.serverItem,
                  mqttAddr === s.ip && styles.serverItemSelected,
                ]}
                onPress={() => setMqttAddr(s.ip)}
                activeOpacity={0.7}
              >
                <View style={styles.serverItemLeft}>
                  <View style={[
                    styles.serverDot,
                    mqttAddr === s.ip && styles.serverDotSelected,
                  ]} />
                  <View>
                    <Text style={[
                      styles.serverIp,
                      mqttAddr === s.ip && styles.serverIpSelected,
                    ]}>{s.ip}</Text>
                    <Text style={styles.serverLabel}>OpenNova Server</Text>
                  </View>
                </View>
                {mqttAddr === s.ip && (
                  <Ionicons name="checkmark-circle" size={20} color={colors.emerald} />
                )}
              </TouchableOpacity>
            ))}

            {!scanning && servers.length === 0 && (
              <Text style={styles.noServers}>No servers found on your network.</Text>
            )}
          </View>
        )}

        {/* Manual input card */}
        <View style={styles.card}>
          <Text style={styles.label}>MQTT Address</Text>
          <View style={styles.inputRow}>
            <Ionicons name="globe-outline" size={20} color={colors.textDim} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              value={mqttAddr}
              onChangeText={setMqttAddr}
              placeholder="192.168.0.177"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="default"
              returnKeyType="next"
            />
          </View>

          <Text style={[styles.label, { marginTop: 20 }]}>MQTT Port</Text>
          <View style={styles.inputRow}>
            <Ionicons name="swap-horizontal-outline" size={20} color={colors.textDim} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              value={mqttPort}
              onChangeText={setMqttPort}
              placeholder="1883"
              placeholderTextColor={colors.textMuted}
              keyboardType="number-pad"
              returnKeyType="done"
            />
          </View>
        </View>

        {/* Next Button */}
        <TouchableOpacity
          style={[styles.button, !isValid && styles.buttonDisabled]}
          onPress={handleNext}
          disabled={!isValid}
          activeOpacity={0.7}
        >
          <Text style={styles.buttonText}>Next</Text>
          <Ionicons name="arrow-forward" size={20} color={colors.white} />
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
    paddingTop: 60,
  },
  header: {
    alignItems: 'center',
    marginBottom: 24,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(0,212,170,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
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
  discoveryCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 16,
    marginBottom: 16,
  },
  discoveryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  discoveryTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  serverItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    marginBottom: 6,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  serverItemSelected: {
    backgroundColor: 'rgba(0,212,170,0.08)',
    borderColor: 'rgba(0,212,170,0.3)',
  },
  serverItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  serverDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.textMuted,
  },
  serverDotSelected: {
    backgroundColor: colors.emerald,
  },
  serverIp: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  serverIpSelected: {
    color: colors.white,
  },
  serverLabel: {
    fontSize: 12,
    color: colors.textDim,
    marginTop: 2,
  },
  noServers: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: 8,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 20,
    marginBottom: 32,
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
    opacity: 0.5,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.white,
  },
});
