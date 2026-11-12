/**
 * Winter sleep on the home screen: while the active mower sleeps no schedule
 * starts (server services/hibernation.ts). Tap "Wake up" to end it.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme, type Colors } from '../theme';
import { useI18n } from '../i18n';
import { useActiveMower } from '../hooks/useActiveMower';
import { getServerUrl } from '../services/auth';
import { ApiClient } from '../services/api';
import { formatWakeDate } from '../utils/wakeDates';

const ICE = '#cfe8ff';

export function WinterSleepBanner() {
  const { colors: c } = useTheme();
  const { t, language } = useI18n();
  const { activeMowerSn } = useActiveMower();
  const [state, setState] = useState<{ sn: string; enabled: boolean; until: string | null } | null>(null);
  const [waking, setWaking] = useState(false);

  // Read again on every visit: the settings screen or Home Assistant may have changed it.
  useFocusEffect(useCallback(() => {
    if (!activeMowerSn) return;
    let alive = true;
    void (async () => {
      const url = await getServerUrl();
      if (!url) return;
      try {
        const s = await new ApiClient(url).getHibernation(activeMowerSn);
        if (alive) setState({ sn: activeMowerSn, enabled: s.enabled === true, until: s.until ?? null });
      } catch { /* keep the last */ }
    })();
    return () => { alive = false; };
  }, [activeMowerSn]));

  if (!activeMowerSn || state?.sn !== activeMowerSn || !state.enabled) return null;
  const styles = makeStyles(c);

  const wake = async () => {
    setWaking(true);
    try {
      const url = await getServerUrl();
      if (url) await new ApiClient(url).setHibernation(activeMowerSn, false, null);
      setState({ ...state, enabled: false });
    } catch { /* the banner stays; the next visit reads the server again */ }
    finally { setWaking(false); }
  };

  return (
    <View style={styles.bar} testID="winter-sleep-banner">
      <Ionicons name="snow-outline" size={20} color={ICE} />
      <Text style={styles.text}>
        {state.until
          ? t('winterSleepBannerUntil', { date: formatWakeDate(state.until, language) })
          : t('winterSleepBanner')}
      </Text>
      <TouchableOpacity onPress={() => void wake()} disabled={waking} style={styles.button} testID="winter-sleep-wake">
        {waking ? <ActivityIndicator size="small" color={ICE} /> : <Text style={styles.buttonText}>{t('winterSleepWake')}</Text>}
      </TouchableOpacity>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    bar: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      marginHorizontal: 16, marginTop: 8, marginBottom: 4,
      paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12,
      backgroundColor: 'rgba(125,180,230,0.12)', borderWidth: 1, borderColor: 'rgba(207,232,255,0.25)',
    },
    text: { flex: 1, color: c.text, fontSize: 13 },
    button: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(207,232,255,0.35)' },
    buttonText: { color: ICE, fontWeight: '700', fontSize: 12 },
  });
}
