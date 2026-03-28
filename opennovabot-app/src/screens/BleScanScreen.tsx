import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { colors } from '../theme/colors';
import type { RootStackParams } from '../navigation/types';
import { scanForDevices, type ScannedDevice, type DeviceType } from '../services/ble';

type Props = NativeStackScreenProps<RootStackParams, 'BleScan'>;

const SCAN_DURATION = 10000; // 10 seconds

function isMatchingDevice(device: ScannedDevice, mode: 'charger' | 'mower' | 'both'): boolean {
  if (device.type === 'unknown') return false;
  if (mode === 'both') return device.type === 'charger' || device.type === 'mower';
  return device.type === mode;
}

function getTypeBadgeColor(type: DeviceType | 'unknown'): string {
  if (type === 'charger') return colors.amber;
  if (type === 'mower') return colors.emerald;
  return colors.textDim;
}

function getTypeBadgeLabel(type: DeviceType | 'unknown'): string {
  if (type === 'charger') return 'Charger';
  if (type === 'mower') return 'Mower';
  return 'Unknown';
}

function getRssiIcon(rssi: number): keyof typeof Ionicons.glyphMap {
  if (rssi >= -50) return 'wifi';
  if (rssi >= -70) return 'wifi';
  return 'wifi-outline';
}

export default function BleScanScreen({ navigation, route }: Props) {
  const { mqttAddr, mqttPort, deviceMode, wifiSsid, wifiPassword } = route.params;
  const [devices, setDevices] = useState<ScannedDevice[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const autoSelectedRef = useRef(false);

  const startScan = useCallback(() => {
    setDevices([]);
    setSelectedIds(new Set());
    setScanning(true);
    autoSelectedRef.current = false;

    cancelRef.current = scanForDevices(
      SCAN_DURATION,
      (dev) => {
        setDevices((prev) => {
          // Dedupe by id
          if (prev.some((d) => d.id === dev.id)) return prev;
          const updated = [...prev, dev];

          // Auto-select first matching device
          if (!autoSelectedRef.current && isMatchingDevice(dev, deviceMode)) {
            autoSelectedRef.current = true;
            setSelectedIds(new Set([dev.id]));
          }

          return updated;
        });
      },
      () => setScanning(false),
    );
  }, [deviceMode]);

  useEffect(() => {
    // Delay first scan slightly to allow BLE permissions to settle
    const timer = setTimeout(() => startScan(), 1000);
    return () => { clearTimeout(timer); cancelRef.current?.(); };
  }, [startScan]);

  const toggleDevice = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleRescan = () => {
    cancelRef.current?.();
    startScan();
  };

  const handleStartProvisioning = () => {
    const selected = devices.filter((d) => selectedIds.has(d.id));
    if (selected.length === 0) return;

    // Stop scan before navigating
    cancelRef.current?.();

    navigation.navigate('Provision', {
      mqttAddr,
      mqttPort,
      deviceMode,
      wifiSsid,
      wifiPassword,
      devices: selected,
    });
  };

  const matchingDevices = devices.filter((d) => isMatchingDevice(d, deviceMode));
  const otherDevices = devices.filter((d) => !isMatchingDevice(d, deviceMode));
  const hasSelection = selectedIds.size > 0;

  const renderDevice = (item: ScannedDevice, isMatch: boolean) => {
    const isSelected = selectedIds.has(item.id);
    const badgeColor = getTypeBadgeColor(item.type);

    return (
      <TouchableOpacity
        key={item.id}
        style={[
          styles.deviceRow,
          isSelected && styles.deviceRowSelected,
          !isMatch && styles.deviceRowDimmed,
        ]}
        onPress={() => isMatch && toggleDevice(item.id)}
        disabled={!isMatch}
        activeOpacity={0.7}
      >
        <View style={styles.deviceLeft}>
          <View style={[styles.radioOuter, isSelected && styles.radioOuterSelected]}>
            {isSelected && <View style={styles.radioInner} />}
          </View>
          <View style={styles.deviceInfo}>
            <Text style={[styles.deviceName, !isMatch && styles.deviceNameDim]}>
              {item.name}
            </Text>
            <Text style={styles.deviceId}>{Platform.OS === 'ios' ? item.id.substring(0, 8).toUpperCase() : item.id}</Text>
          </View>
        </View>
        <View style={styles.deviceRight}>
          <View style={[styles.badge, { backgroundColor: badgeColor + '1A' }]}>
            <Text style={[styles.badgeText, { color: badgeColor }]}>
              {getTypeBadgeLabel(item.type)}
            </Text>
          </View>
          <View style={styles.rssiRow}>
            <Ionicons name={getRssiIcon(item.rssi)} size={14} color={colors.textDim} />
            <Text style={styles.rssiText}>{item.rssi} dBm</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>BLE Scan</Text>
        <Text style={styles.subtitle}>
          {scanning
            ? 'Scanning for nearby devices...'
            : `Found ${devices.length} device${devices.length !== 1 ? 's' : ''}`}
        </Text>
      </View>

      {/* Scanning indicator */}
      {scanning && (
        <View style={styles.scanningRow}>
          <ActivityIndicator size="small" color={colors.emerald} />
          <Text style={styles.scanningText}>Scanning...</Text>
        </View>
      )}

      {/* Device list */}
      <FlatList
        data={[...matchingDevices, ...otherDevices]}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => renderDevice(item, isMatchingDevice(item, deviceMode))}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          !scanning ? (
            <View style={styles.emptyState}>
              <Ionicons name="bluetooth-outline" size={48} color={colors.textDim} />
              <Text style={styles.emptyText}>No devices found</Text>
              <Text style={styles.emptySubtext}>
                Make sure your device is powered on and in range.
              </Text>
            </View>
          ) : null
        }
        style={styles.list}
      />

      {/* Section divider for other devices */}
      {matchingDevices.length > 0 && otherDevices.length > 0 && (
        <View style={styles.sectionNote}>
          <Text style={styles.sectionNoteText}>
            Non-matching devices are shown but cannot be selected.
          </Text>
        </View>
      )}

      {/* Bottom buttons */}
      <View style={styles.bottomBar}>
        <TouchableOpacity
          style={styles.rescanButton}
          onPress={handleRescan}
          disabled={scanning}
          activeOpacity={0.7}
        >
          <Ionicons name="refresh" size={18} color={scanning ? colors.textMuted : colors.text} />
          <Text style={[styles.rescanText, scanning && { color: colors.textMuted }]}>
            Rescan
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.provisionButton, !hasSelection && styles.buttonDisabled]}
          onPress={handleStartProvisioning}
          disabled={!hasSelection}
          activeOpacity={0.7}
        >
          <Text style={styles.provisionButtonText}>Start Provisioning</Text>
          <Ionicons name="arrow-forward" size={18} color={colors.white} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 60,
    paddingBottom: 16,
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
  },
  scanningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    gap: 8,
  },
  scanningText: {
    fontSize: 14,
    color: colors.emerald,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 16,
    marginBottom: 10,
  },
  deviceRowSelected: {
    borderColor: colors.emerald,
    backgroundColor: 'rgba(0,212,170,0.05)',
  },
  deviceRowDimmed: {
    opacity: 0.4,
  },
  deviceLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.textDim,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  radioOuterSelected: {
    borderColor: colors.emerald,
  },
  radioInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.emerald,
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.white,
    marginBottom: 2,
  },
  deviceNameDim: {
    color: colors.textDim,
  },
  deviceId: {
    fontSize: 11,
    color: colors.textDim,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  deviceRight: {
    alignItems: 'flex-end',
    gap: 6,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rssiRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  rssiText: {
    fontSize: 11,
    color: colors.textDim,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 48,
    gap: 12,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.textDim,
  },
  emptySubtext: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
  },
  sectionNote: {
    paddingHorizontal: 24,
    paddingBottom: 8,
  },
  sectionNoteText: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
  },
  bottomBar: {
    flexDirection: 'row',
    paddingHorizontal: 24,
    paddingVertical: 16,
    paddingBottom: 34,
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
  },
  rescanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    paddingHorizontal: 20,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    gap: 6,
  },
  rescanText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  provisionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: 12,
    backgroundColor: colors.emerald,
    gap: 8,
  },
  buttonDisabled: {
    backgroundColor: colors.emeraldDark,
    opacity: 0.5,
  },
  provisionButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.white,
  },
});
