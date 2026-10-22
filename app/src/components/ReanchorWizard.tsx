import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ActivityIndicator, ScrollView, AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ApiClient, type ReanchorStatus } from '../services/api';
import { getServerUrl } from '../services/auth';
import ManualJoystick from './ManualJoystick';
import { useI18n } from '../i18n';
import { afterPulse, pulseOutcome, REANCHOR_PULSE_MS } from '../utils/reanchorPulse';

interface Props { visible: boolean; sn: string; sensors: Record<string, string> | undefined; onClose: () => void; }

export default function ReanchorWizard({ visible, sn, sensors, onClose }: Props) {
  const { t } = useI18n();
  const [status, setStatus] = useState<ReanchorStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // The server's map_apply_phase while it installs the maps again.
  const installPhase = sensors?.map_apply_phase ?? '';
  const installing = retrying || ['syncing', 'regenerating', 'settling'].includes(installPhase);
  const owned = useRef<string | null>(null);
  const misses = useRef(0);
  const generation = useRef(0);
  const client = async () => {
    const url = await getServerUrl();
    if (!url) throw new Error(t('reanchorNoServer'));
    return new ApiClient(url);
  };
  useEffect(() => {
    if (!visible) return;
    const session = ++generation.current;
    setStatus(null); setErr(null); setConfirmed(false); setStarting(false);
    let cancelled = false, polling = false;
    const tick = async () => {
      if (polling) return;
      polling = true;
      const id = owned.current;
      try {
        const url = await getServerUrl();
        if (!url || cancelled) return;
        const api = new ApiClient(url);
        if (id) {
          // Only the server's refusal, or a window that has certainly expired, ends supervision.
          const outcome = await pulseOutcome(() => api.reanchor(sn, 'pulse', { cycleId: id }));
          if (!cancelled && owned.current === id) {
            const next = afterPulse(misses.current, outcome);
            if (next === null) owned.current = null; else misses.current = next;
          }
        }
        if (cancelled) return;
        const s = await api.getReanchorStatus(sn);
        if (cancelled) return;
        setStatus(s);
        if (!s.active && s.cycleId === id && owned.current === id) owned.current = null;
      } catch { /* A lost heartbeat stops motion; keep fetching the server's recovery status. */ }
      finally { polling = false; }
    };
    const background = AppState.addEventListener('change', state => {
      if (state !== 'active' && owned.current) {
        const id = owned.current; owned.current = null;
        void getServerUrl().then(url => url ? new ApiClient(url).reanchor(sn, 'stop', { cycleId: id }) : null).catch(() => {});
      }
    });
    void tick();
    const timer = setInterval(tick, REANCHOR_PULSE_MS);
    return () => {
      cancelled = true; generation.current = session + 1; clearInterval(timer); background.remove();
      const id = owned.current; owned.current = null;
      if (id) void getServerUrl().then(url => url ? new ApiClient(url).reanchor(sn, 'stop', { cycleId: id }) : null).catch(() => {});
    };
  }, [visible, sn]);
  const start = async () => {
    const attempt = generation.current;
    setErr(null); setStarting(true);
    try {
      const api = await client();
      const result = await api.reanchor(sn, 'auto', { mode: 'supervised-v2', ownDockUnmoved: confirmed });
      if (!result.ok || !result.cycleId) throw new Error(result.error || t('reanchorStartFailed'));
      if (attempt !== generation.current || AppState.currentState !== 'active') { await api.reanchor(sn, 'stop', { cycleId: result.cycleId }); return; }
      owned.current = result.cycleId; misses.current = 0;
      const s = await api.getReanchorStatus(sn);
      if (attempt === generation.current) setStatus(s);
    } catch (e) { if (attempt === generation.current) setErr(e instanceof Error ? e.message : String(e)); }
    finally { if (attempt === generation.current) setStarting(false); }
  };
  // Re-anchor refuses while a map install is unfinished; installing the maps
  // again is the repair, and the status poll sees installPending clear.
  const retryInstall = async () => {
    setErr(null); setRetrying(true);
    try { await (await client()).retryMapInstall(sn); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setRetrying(false); }
  };
  const stop = async () => {
    const id = owned.current ?? status?.cycleId;
    try { if (id) await (await client()).reanchor(sn, 'stop', { cycleId: id }); }
    catch (e) { setErr(String(e)); }
    owned.current = null;
  };
  if (!visible) return null;
  const active = starting || status?.active;
  const compatible = status?.protocol === 'supervised-reanchor-v2';
  const canStart = compatible && confirmed && status?.onDock && status.rtkFixed && !status.installPending && !active;
  const button = (label: string, onPress: () => void, disabled = false) => <TouchableOpacity accessibilityRole="button" disabled={disabled} onPress={onPress}
    style={{ padding: 14, borderRadius: 12, backgroundColor: '#334155', opacity: disabled ? .4 : 1 }}><Text style={{ color: 'white', textAlign: 'center' }}>{label}</Text></TouchableOpacity>;
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <GestureHandlerRootView style={{ flex: 1, justifyContent: 'center', backgroundColor: '#0009', padding: 20 }}>
      <ScrollView style={{ flexGrow: 0, maxHeight: '90%', backgroundColor: '#111827', borderRadius: 16 }} contentContainerStyle={{ padding: 20, gap: 14 }}>
        <Text style={{ color: 'white', fontSize: 20 }}>{t('reanchorTitle')}</Text>
        <Text style={{ color: '#cbd5e1' }}>{t('reanchorSupervisedIntro')}</Text>
        <Text style={{ color: '#cbd5e1' }}>RTK: {status?.rtkFixed ? 'Fixed' : '?'} · {t(status?.onDock ? 'reanchorOnDock' : 'reanchorOffDock')}</Text>
        {!!status?.message && <Text accessibilityLiveRegion="polite" style={{ color: status.ok ? '#34d399' : status.phase === 'error' ? '#f87171' : 'white' }}>{status.message}</Text>}
        {status?.verificationPending && <Text style={{ color: '#fbbf24' }}>{t('reanchorPendingHint')}</Text>}
        {status?.installPending && <>
          <Text style={{ color: '#fbbf24' }}>{t('reanchorInstallPending')}</Text>
          {installPhase === 'failed' && !installing && <Text style={{ color: '#f87171' }}>{t('reanchorInstallFailed')}</Text>}
          {installing ? <ActivityIndicator /> : button(t('reanchorRetryInstall'), () => void retryInstall())}
        </>}
        {status && !compatible && <Text style={{ color: '#fbbf24' }}>{t('reanchorUpdateRequired')}</Text>}
        {err && <Text accessibilityRole="alert" style={{ color: '#f87171' }}>{err}</Text>}
        {active ? <><ActivityIndicator />{button(t('reanchorStop'), () => void stop())}</> : <>
          {status?.phase === 'error' && <>
            <Text style={{ color: '#cbd5e1' }}>{t('reanchorRetryHint')}</Text>
            <ManualJoystick sn={sn} />
          </>}
          <TouchableOpacity accessibilityRole="checkbox" accessibilityState={{ checked: confirmed }} onPress={() => setConfirmed(!confirmed)}>
            <Text style={{ color: 'white' }}>{confirmed ? '☑' : '☐'} {t('reanchorConfirmOwnDock')}</Text>
          </TouchableOpacity>
          {button(t('reanchorBtnStart'), () => void start(), !canStart)}
        </>}
        {button(t('reanchorBtnLater'), onClose)}
      </ScrollView>
    </GestureHandlerRootView>
  </Modal>;
}
