/**
 * RainOverlay — rain-aware banner with two modes:
 *
 *   PAUSED  — mowing was halted by the rain monitor; full banner with
 *             paused-since timestamp, animated drops and forecast bars.
 *   WARNING — no active session, but the forecast shows incoming rain
 *             within the next ~3 hours. Compact banner so users get a
 *             heads-up even when the mower is idle (Ramon: "het gaat
 *             zo regenen maar ik zie niets in de app").
 *
 * Forecast comes from /api/dashboard/rain-forecast/:sn which now resolves
 * GPS via map_calibration → live mower snapshot → charger snapshot, so
 * the banner works without any manual map setup.
 */
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { getServerUrl } from '../services/auth';
import { useI18n } from '../i18n';
import { formatTime } from '../lib/format';

interface RainSession {
  session_id: string;
  state: string;
  paused_at: string;
  map_name: string | null;
}

interface RainForecast {
  available: boolean;
  clearAt: string | null;
  upcoming: Array<{ time: string; mm: number; prob: number }>;
}

interface Props {
  mowerSn: string;
}

export function RainOverlay({ mowerSn }: Props) {
  const { t } = useI18n();
  const [session, setSession] = useState<RainSession | null>(null);
  const [forecast, setForecast] = useState<RainForecast | null>(null);

  useEffect(() => {
    if (!mowerSn) return;
    let active = true;

    const load = async () => {
      try {
        const url = await getServerUrl();
        if (!url || !active) return;

        const sessRes = await fetch(`${url}/api/dashboard/rain-sessions/${encodeURIComponent(mowerSn)}`);
        const sessData = await sessRes.json();
        const sessions: RainSession[] = sessData.sessions ?? [];
        if (!active) return;
        setSession(sessions.length > 0 ? sessions[0] : null);

        const fcRes = await fetch(`${url}/api/dashboard/rain-forecast/${encodeURIComponent(mowerSn)}`);
        const fcData = await fcRes.json();
        if (!active) return;
        setForecast(fcData.available ? fcData : null);
      } catch { /* ignore */ }
    };

    load();
    const interval = setInterval(load, 30_000);
    return () => { active = false; clearInterval(interval); };
  }, [mowerSn]);

  // Compute "incoming rain in next 3h" up here so both the JSX render and
  // the animation useEffect can react to it. Without this lift the drops
  // wouldn't animate in WARNING mode.
  const RAIN_MM = 0.1;
  const RAIN_PROB = 50;
  const WARN_HORIZON_MS = 3 * 60 * 60 * 1000;
  const incomingRain = (() => {
    if (!forecast?.upcoming?.length) return null;
    const now = Date.now();
    for (const h of forecast.upcoming) {
      const at = new Date(h.time).getTime();
      if (at < now || at - now > WARN_HORIZON_MS) continue;
      if (h.mm >= RAIN_MM || h.prob >= RAIN_PROB) return { ...h, atMs: at };
    }
    return null;
  })();
  const showOverlay = !!session || !!incomingRain;

  // Rain animation — 20 drops with staggered timing
  const dropAnims = useRef(
    Array.from({ length: 20 }, () => new Animated.Value(0))
  ).current;

  useEffect(() => {
    if (!showOverlay) return;
    const animations = dropAnims.map((anim, i) => {
      const delay = (i * 137) % 2500; // staggered start
      const duration = 700 + (i * 43) % 500;
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, {
            toValue: 1,
            duration,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
          Animated.timing(anim, {
            toValue: 0,
            duration: 0,
            useNativeDriver: true,
          }),
        ]),
      );
    });
    animations.forEach(a => a.start());
    return () => animations.forEach(a => a.stop());
  }, [showOverlay]);

  // Nothing to show — neither paused nor incoming rain.
  if (!showOverlay) return null;

  const pausedAt = session
    ? formatTime(session.paused_at)
    : '';

  let clearLabel: string | null = null;
  if (forecast?.clearAt) {
    const clearDate = new Date(forecast.clearAt);
    const diffMin = Math.round((clearDate.getTime() - Date.now()) / 60_000);
    if (diffMin <= 60) {
      clearLabel = t('dryInMin', { min: String(diffMin) });
    } else {
      clearLabel = t('dryAt', { time: formatTime(clearDate) });
    }
  }

  // Drop positions — deterministic spread
  const drops = dropAnims.map((anim, i) => {
    const left = ((i * 2.9 + 1.5) % 96 + 2);
    const opacity = 0.15 + (i % 6) * 0.05;
    return (
      <Animated.View
        key={i}
        style={[styles.raindrop, {
          left: `${left}%`,
          opacity,
          transform: [{
            translateY: anim.interpolate({
              inputRange: [0, 1],
              outputRange: [-16, 120],
            }),
          }],
        }]}
      />
    );
  });

  // WARNING mode: no session yet, but rain is forecast within 3h.
  const isWarning = !session && !!incomingRain;
  const warningAt = incomingRain
    ? formatTime(incomingRain.atMs)
    : '';

  return (
    <View style={styles.container}>
      {/* Rain drops animation — same look in both PAUSED and WARNING so an
          incoming-rain forecast feels just as visible as an active pause. */}
      <View style={styles.rainLayer} pointerEvents="none">
        {drops}
      </View>

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.iconCircle}>
          <Ionicons name="rainy" size={20} color="#60a5fa" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>
            {isWarning
              ? (t('rainExpected') || 'Rain expected')
              : t('rainDetected')}
          </Text>
          <Text style={styles.subtitle}>
            {isWarning
              ? (t('rainArrivesAt', { time: warningAt }) || `Around ${warningAt} · ${incomingRain?.mm.toFixed(1)}mm · ${incomingRain?.prob}%`)
              : `${t('pausedSince')} ${pausedAt}`}
          </Text>
        </View>
      </View>

      {/* Forecast bars */}
      {forecast?.upcoming && forecast.upcoming.length > 0 && (
        <View style={styles.forecastRow}>
          {forecast.upcoming.slice(0, 8).map((h, i) => {
            const intensity = Math.min(h.mm / 2, 1);
            const barHeight = Math.max(intensity, h.prob / 100);
            const time = formatTime(h.time);
            return (
              <View key={i} style={styles.forecastCol}>
                <View style={styles.forecastBarBg}>
                  <View style={[styles.forecastBar, {
                    height: `${Math.max(barHeight * 100, 8)}%`,
                    backgroundColor: h.mm >= 0.1
                      ? `rgba(96,165,250,${0.3 + barHeight * 0.5})`
                      : 'rgba(96,165,250,0.1)',
                  }]} />
                </View>
                <Text style={styles.forecastTime}>{time}</Text>
              </View>
            );
          })}
        </View>
      )}

      {/* Clear prediction */}
      {clearLabel && (
        <View style={styles.clearRow}>
          <Ionicons name="sunny-outline" size={14} color="#fbbf24" />
          <Text style={styles.clearText}>{clearLabel}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(30,58,138,0.6)',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(96,165,250,0.2)',
    gap: 10,
    overflow: 'hidden',
  },
  rainLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 0,
  },
  raindrop: {
    position: 'absolute',
    top: -16,
    width: 1.5,
    height: 14,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
    backgroundColor: '#60a5fa',
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconCircle: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(96,165,250,0.2)',
    justifyContent: 'center', alignItems: 'center',
  },
  title: { fontSize: 13, fontWeight: '600', color: '#bfdbfe' },
  subtitle: { fontSize: 11, color: 'rgba(147,197,253,0.6)', marginTop: 2 },
  forecastRow: { flexDirection: 'row', gap: 3 },
  forecastCol: { flex: 1, alignItems: 'center', gap: 3 },
  forecastBarBg: {
    width: '100%', height: 32,
    backgroundColor: 'rgba(30,58,138,0.4)',
    borderRadius: 3,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  forecastBar: { width: '100%', borderRadius: 3 },
  forecastTime: { fontSize: 8, color: 'rgba(96,165,250,0.5)' },
  clearRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingTop: 8, borderTopWidth: 1, borderTopColor: 'rgba(96,165,250,0.1)',
  },
  clearText: { fontSize: 11, fontWeight: '500', color: 'rgba(251,191,36,0.8)' },
});
