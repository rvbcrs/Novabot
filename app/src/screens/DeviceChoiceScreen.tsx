import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useStyles, useTheme, type Colors } from '../theme';
import type { RootStackParams } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParams, 'DeviceChoice'>;

type DeviceOption = {
  mode: 'charger' | 'mower' | 'both';
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  color: string;
};

function getDeviceOptions(c: Colors): DeviceOption[] {
  return [
    {
      mode: 'charger',
      icon: 'flash',
      title: 'Charger',
      subtitle: 'Provision the charging station (ESP32)',
      color: c.amber,
    },
    {
      mode: 'mower',
      icon: 'construct',
      title: 'Mower',
      subtitle: 'Provision the robot mower',
      color: c.emerald,
    },
    {
      mode: 'both',
      icon: 'build',
      title: 'Both',
      subtitle: 'Provision charger and mower sequentially',
      color: c.purple,
    },
  ];
}

export default function DeviceChoiceScreen({ navigation, route }: Props) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const deviceOptions = getDeviceOptions(colors);
  const { mqttAddr, mqttPort } = route.params;

  const handleSelect = (mode: 'charger' | 'mower' | 'both') => {
    navigation.navigate('Wifi', { mqttAddr, mqttPort, deviceMode: mode });
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scroll}
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Choose Device</Text>
        <Text style={styles.subtitle}>
          What would you like to provision?
        </Text>
      </View>

      {/* Device Cards */}
      {deviceOptions.map((opt) => (
        <TouchableOpacity
          key={opt.mode}
          style={styles.card}
          onPress={() => handleSelect(opt.mode)}
          activeOpacity={0.7}
        >
          <View style={[styles.iconCircle, { backgroundColor: opt.color + '1A' }]}>
            <Ionicons name={opt.icon} size={28} color={opt.color} />
          </View>
          <View style={styles.cardContent}>
            <Text style={styles.cardTitle}>{opt.title}</Text>
            <Text style={styles.cardSubtitle}>{opt.subtitle}</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.textDim} />
        </TouchableOpacity>
      ))}

      {/* Server info */}
      <View style={styles.infoRow}>
        <Ionicons name="server-outline" size={16} color={colors.textDim} />
        <Text style={styles.infoText}>
          {mqttAddr}:{mqttPort}
        </Text>
      </View>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.bg,
  },
  scroll: {
    padding: 24,
    paddingTop: 60,
  },
  header: {
    marginBottom: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: c.text,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: c.textDim,
    lineHeight: 22,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.cardBorder,
    padding: 20,
    marginBottom: 16,
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  cardContent: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: c.text,
    marginBottom: 4,
  },
  cardSubtitle: {
    fontSize: 14,
    color: c.textDim,
    lineHeight: 20,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
    gap: 6,
  },
  infoText: {
    fontSize: 13,
    color: c.textDim,
  },
});
