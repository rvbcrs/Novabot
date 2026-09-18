/**
 * Dismissible, non-modal bar shown at the top of HomeScreen when a newer mower
 * firmware is available. Tapping opens the existing OTA screen; the × dismisses
 * it for that version (the Settings/OTA dot stays, so it's still discoverable).
 * This is the deliberate alternative to a popup — the user already gets one for
 * app updates, so firmware is surfaced quietly.
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useTheme, type Colors } from '../theme';
import { useI18n } from '../i18n';
import { useFirmwareUpdate } from '../context/FirmwareUpdateContext';

const stripV = (v: string): string => v.replace(/^v/i, '');

export function FirmwareUpdateBanner() {
  const { bannerVisible, available, advisory, dismiss } = useFirmwareUpdate();
  const { colors: c } = useTheme();
  const { t } = useI18n();
  const navigation = useNavigation<any>();

  if (!bannerVisible || (!available && !advisory)) return null;

  const styles = makeStyles(c);
  const openOta = () => navigation.navigate('AppSettings', { screen: 'OTA' });

  // The build the mower runs was withdrawn: red, with the reason, and no ×.
  // It stays until the mower reports another version.
  if (advisory?.required && advisory.target) {
    return (
      <View style={[styles.bar, styles.barRequired]} testID="firmware-required-banner">
        <TouchableOpacity style={styles.main} onPress={openOta} activeOpacity={0.75} testID="firmware-required-open">
          <Ionicons name="warning-outline" size={20} color={c.red} />
          <View style={styles.textCol}>
            <Text style={[styles.title, { color: c.red }]} numberOfLines={2}>
              {t('firmwareRequiredTitle', { version: stripV(advisory.current ?? '') })}
            </Text>
            <Text style={styles.sub} numberOfLines={4}>
              {t('firmwareRequiredSubtitle', { reason: advisory.reason ?? '', version: stripV(advisory.target.version) })}
            </Text>
          </View>
          <Text style={[styles.action, { color: c.red }]}>{t('firmwareRequiredAction')}</Text>
          <Ionicons name="chevron-forward" size={18} color={c.red} />
        </TouchableOpacity>
      </View>
    );
  }
  if (!available) return null;

  return (
    <View style={styles.bar} testID="firmware-update-banner">
      <TouchableOpacity style={styles.main} onPress={openOta} activeOpacity={0.75} testID="firmware-update-open">
        <Ionicons name="cloud-download-outline" size={20} color={c.blue} />
        <View style={styles.textCol}>
          <Text style={styles.title} numberOfLines={1}>{t('firmwareUpdateTitle')}</Text>
          <Text style={styles.sub} numberOfLines={1}>
            {t('firmwareUpdateSubtitle', { version: stripV(available.version) })}
          </Text>
        </View>
        <Text style={styles.action}>{t('firmwareUpdateAction')}</Text>
        <Ionicons name="chevron-forward" size={18} color={c.blue} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={dismiss}
        style={styles.close}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        testID="firmware-update-dismiss"
      >
        <Ionicons name="close" size={18} color={c.textMuted} />
      </TouchableOpacity>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: 16,
      marginTop: 8,
      marginBottom: 4,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: 12,
      backgroundColor: 'rgba(59,130,246,0.12)',
      borderWidth: 1,
      borderColor: 'rgba(59,130,246,0.35)',
      gap: 8,
    },
    barRequired: {
      borderColor: c.red,
      backgroundColor: c.red + '14',
    },
    main: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 10 },
    textCol: { flex: 1 },
    title: { color: c.text, fontWeight: '700', fontSize: 13 },
    sub: { color: c.textMuted, fontSize: 12, marginTop: 1 },
    action: { color: c.blue, fontWeight: '700', fontSize: 13 },
    close: { padding: 2 },
  });
}
