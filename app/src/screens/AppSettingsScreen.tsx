/**
 * App settings screen — server info, account, device controls, logout.
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ScrollView,
  Switch,
  Modal,
  ActivityIndicator,
  Linking,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useStyles, type Colors, type ThemeMode } from '../theme';
import { useMowerColor, type MowerColor } from '../hooks/useMowerColor';
import { getServerUrl, setServerUrl as saveServerUrl, getToken, clearToken } from '../services/auth';
import { initSocket, disconnectSocket } from '../services/socket';
import { discoverServers } from '../services/discovery';
import {
  getReleaseManifestUrl,
  setReleaseManifestUrl,
  getDefaultReleaseManifestUrl,
  fetchLatest,
  compareSemver,
  type AppLatest,
} from '../services/appUpdate';
import { UpdatePromptModal } from '../components/UpdatePromptModal';
import { useMowerState } from '../hooks/useMowerState';
import { useActiveMower } from '../hooks/useActiveMower';
import { ApiClient } from '../services/api';
import { useExperimental } from '../context/ExperimentalContext';
import { useMapLabels } from '../context/MapLabelsContext';
import { useFirmwareUpdate } from '../context/FirmwareUpdateContext';
import { useI18n, LANGUAGES } from '../i18n';
import * as Application from 'expo-application';
import { PUSH_CATEGORIES, getMutedCategories, setMutedCategories, type PushCategory } from '../services/pushNotifications';

interface AppSettingsScreenProps {
  onLogout: () => void;
  onGoToProvision: () => void;
  onGoToOta?: () => void;
  onGoToMowerSettings?: () => void;
}

export default function AppSettingsScreen({
  onLogout,
  onGoToProvision,
  onGoToOta,
  onGoToMowerSettings,
}: AppSettingsScreenProps) {
  const insets = useSafeAreaInsets();
  const { mode, setMode, colors } = useTheme();
  const { activeMower } = useActiveMower();
  const { mowerColor, setMowerColor } = useMowerColor(activeMower?.sn);
  const styles = useStyles(makeStyles);
  const { devices, connected } = useMowerState();
  const [serverUrl, setServerUrl] = useState('');
  const [editingUrl, setEditingUrl] = useState('');
  const [isEditingServer, setIsEditingServer] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [discoveredServers, setDiscoveredServers] = useState<string[]>([]);
  const [email, setEmail] = useState('');
  const [updateUrl, setUpdateUrl] = useState('');
  const [editingUpdateUrl, setEditingUpdateUrl] = useState('');
  const [isEditingUpdateUrl, setIsEditingUpdateUrl] = useState(false);
  const defaultUpdateUrl = getDefaultReleaseManifestUrl();
  const isCustomUpdateUrl = updateUrl !== defaultUpdateUrl;
  // Manual "Check for updates" (#135). Ignores the skipped-version flag on
  // purpose: the user explicitly asked, so a skipped release must show again.
  const [updateCheck, setUpdateCheck] = useState<'idle' | 'checking' | 'latest' | 'error'>('idle');
  const [manualLatest, setManualLatest] = useState<AppLatest | null>(null);
  const experimental = useExperimental();
  const mapLabels = useMapLabels();
  const { language, setLanguage, t } = useI18n();
  const { available: fwUpdate } = useFirmwareUpdate();

  const { activeMower: mower } = useActiveMower();

  const charger = useMemo(() => {
    return [...devices.values()].find((d) => d.deviceType === 'charger') ?? null;
  }, [devices]);

  // Notificatie-categorieën (per installatie; server filtert de Expo-push).
  const [muted, setMuted] = useState<PushCategory[]>([]);
  useEffect(() => { getMutedCategories().then(setMuted).catch(() => {}); }, []);
  const toggleCategory = (cat: PushCategory) => {
    const next = muted.includes(cat) ? muted.filter(c => c !== cat) : [...muted, cat];
    setMuted(next);
    void setMutedCategories(next, [...devices.keys()]);
  };

  // "Report a problem": opens the GitHub bug template with the fields we can
  // fill in ourselves (versions, SN, last error). Saves the triage round-trip
  // that most issues start with. Query keys = the template's field ids.
  const handleReportProblem = useCallback(async () => {
    let serverVersion = '';
    try {
      const url = await getServerUrl();
      if (url) {
        const r = await fetch(`${url}/api/dashboard/version`);
        serverVersion = ((await r.json()) as { version?: string }).version ?? '';
      }
    } catch { /* offline: leave empty */ }
    const mowerSn = activeMower?.sn ?? mower?.sn ?? '';
    const dev = mowerSn ? devices.get(mowerSn) : undefined;
    const err = dev?.sensors?.error_status;
    const q = new URLSearchParams({
      template: 'bug_report.yml',
      app: Platform.OS === 'ios' ? 'OpenNova — iOS' : 'OpenNova — Android',
      app_version: `v${Application.nativeApplicationVersion ?? '?'}${Application.nativeBuildVersion ? ` (build ${Application.nativeBuildVersion})` : ''}`,
      server_version: serverVersion,
      mower_sn: mowerSn,
      mower_firmware: dev?.firmwareVersion ?? '',
      charger_firmware: charger?.firmwareVersion ?? '',
      what_happened: err && err !== '0' ? `Last error_status: ${err}\nLast msg: ${dev?.sensors?.msg ?? ''}\n\n` : '',
    });
    await Linking.openURL(`https://github.com/rvbcrs/Novabot/issues/new?${q.toString()}`);
  }, [activeMower?.sn, mower?.sn, devices, charger?.firmwareVersion]);

  useEffect(() => {
    (async () => {
      const url = await getServerUrl();
      if (url) setServerUrl(url);

      const manifestUrl = await getReleaseManifestUrl();
      setUpdateUrl(manifestUrl);

      const token = await getToken();
      if (token) {
        try {
          const parts = token.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(atob(parts[1]));
            if (payload.email) setEmail(payload.email);
          }
        } catch { /* not JWT */ }
      }
    })();
  }, []);

  const handleCheckForUpdates = async () => {
    setUpdateCheck('checking');
    const latest = await fetchLatest();
    if (!latest) {
      setUpdateCheck('error');
      return;
    }
    const installed = Application.nativeApplicationVersion ?? '0.0.0';
    if (compareSemver(latest.version, installed) > 0) {
      setManualLatest(latest);
      setUpdateCheck('idle');
    } else {
      setUpdateCheck('latest');
    }
  };

  const handleSaveUpdateUrl = async (raw: string) => {
    const trimmed = raw.trim();
    // Empty input = revert to default. Any non-empty value persists verbatim.
    if (trimmed.length === 0 || trimmed === defaultUpdateUrl) {
      await setReleaseManifestUrl(null);
      setUpdateUrl(defaultUpdateUrl);
    } else {
      await setReleaseManifestUrl(trimmed);
      setUpdateUrl(trimmed);
    }
    setIsEditingUpdateUrl(false);
  };

  const handleResetUpdateUrl = async () => {
    await setReleaseManifestUrl(null);
    setUpdateUrl(defaultUpdateUrl);
    setIsEditingUpdateUrl(false);
  };

  const handleChangeServer = async (newUrl: string) => {
    const normalized = newUrl.trim().replace(/\/+$/, '');
    if (!normalized) return;
    await saveServerUrl(normalized);
    setServerUrl(normalized);
    setIsEditingServer(false);
    // Reconnect: logout triggers full re-init with new server URL.
    // Pass the current token so the brief pre-logout socket window still
    // gets per-user gating (replaced by the post-login initSocket).
    disconnectSocket();
    initSocket(normalized, await getToken());
    // Force re-login so socket hooks re-attach to the new socket
    await clearToken();
    onLogout();
  };

  const handleDiscover = () => {
    setScanning(true);
    setDiscoveredServers([]);
    discoverServers((server) => {
      // Format: "http://opennova.local|192.168.0.222" so the render layer
      // can split and display the LAN IP in muted text below the URL.
      // For raw-IP finds the host already IS the IP, so lanIp is omitted.
      const url = `http://${server.ip}`;
      const entry = server.lanIp && server.lanIp !== server.ip
        ? `${url}|${server.lanIp}`
        : url;
      setDiscoveredServers((prev) => prev.includes(entry) ? prev : [...prev, entry]);
    }).finally(() => setScanning(false));
  };

  const handleLogout = async () => {
    await clearToken();
    onLogout();
  };

  const modes: ThemeMode[] = ['auto', 'light', 'dark'];
  const modeLabel: Record<ThemeMode, string> = {
    auto: t('appearanceAuto'),
    light: t('appearanceLight'),
    dark: t('appearanceDark'),
  };
  const captionKey: Record<ThemeMode, 'appearanceAutoCaption' | 'appearanceLightCaption' | 'appearanceDarkCaption'> = {
    auto: 'appearanceAutoCaption',
    light: 'appearanceLightCaption',
    dark: 'appearanceDarkCaption',
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>{t('settings')}</Text>

        {/* Appearance */}
        <View style={styles.appearanceSection}>
          <Text style={styles.sectionTitle}>{t('appearance')}</Text>
          <View style={styles.segment}>
            {modes.map((m) => (
              <TouchableOpacity
                key={m}
                style={[styles.segmentItem, m === mode && styles.segmentItemActive]}
                onPress={() => { setMode(m); }}
                activeOpacity={0.7}
              >
                <Text style={[styles.segmentLabel, m === mode && styles.segmentLabelActive]}>
                  {modeLabel[m]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.segmentCaption}>{t(captionKey[mode])}</Text>
        </View>

        {/* Mower colour — per active mower SN */}
        {activeMower?.sn && (
          <View style={styles.appearanceSection}>
            <Text style={styles.sectionTitle}>{t('mowerColor')}</Text>
            <View style={styles.segment}>
              {(['white', 'grey'] as MowerColor[]).map((mc) => (
                <TouchableOpacity
                  key={mc}
                  style={[styles.segmentItem, mc === mowerColor && styles.segmentItemActive]}
                  onPress={() => { setMowerColor(mc); }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.segmentLabel, mc === mowerColor && styles.segmentLabelActive]}>
                    {mc === 'white' ? t('mowerColorWhite') : t('mowerColorGrey')}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* Server info */}
        <Section title={t('stServer')}>
          {!isEditingServer && (
            <View style={styles.rowContainer}>
              <Ionicons name="server-outline" size={20} color={colors.textDim} />
              <Text style={styles.rowLabel}>{t('serverUrl')}</Text>
              <Text style={[styles.rowValue, { fontSize: 13 }]} numberOfLines={1}>{serverUrl || t('stNotConfigured')}</Text>
              <TouchableOpacity
                style={styles.changeBtn}
                onPress={() => { setEditingUrl(serverUrl); setIsEditingServer(true); }}
                activeOpacity={0.7}
              >
                <Text style={styles.changeText}>{t('stChange')}</Text>
              </TouchableOpacity>
            </View>
          )}
          {isEditingServer && (
            <View style={styles.editContainer}>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.input}
                  value={editingUrl}
                  onChangeText={setEditingUrl}
                  placeholder="http://192.168.0.222"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="done"
                  onSubmitEditing={() => handleChangeServer(editingUrl)}
                />
              </View>
              {/* Discover servers */}
              <TouchableOpacity style={styles.discoverBtn} onPress={handleDiscover} disabled={scanning} activeOpacity={0.7}>
                {scanning ? (
                  <ActivityIndicator size="small" color={colors.emerald} />
                ) : (
                  <Ionicons name="search" size={16} color={colors.emerald} />
                )}
                <Text style={styles.discoverText}>
                  {scanning ? t('stScanning') : t('stFindServers')}
                </Text>
              </TouchableOpacity>
              {discoveredServers.map((entry) => {
                const [url, lanIp] = entry.split('|');
                return (
                  <TouchableOpacity
                    key={entry}
                    style={styles.serverItem}
                    onPress={() => { setEditingUrl(url); handleChangeServer(url); }}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="server" size={16} color={colors.emerald} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.serverUrl}>{url}</Text>
                      {lanIp ? (
                        <Text style={[styles.serverUrl, { fontSize: 11, opacity: 0.6 }]}>
                          {lanIp}
                        </Text>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                );
              })}
              {/* Cancel / Save */}
              <View style={styles.buttonRow}>
                <TouchableOpacity style={styles.cancelBtn} onPress={() => setIsEditingServer(false)} activeOpacity={0.7}>
                  <Text style={styles.cancelText}>{t('cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.saveBtn} onPress={() => handleChangeServer(editingUrl)} activeOpacity={0.7}>
                  <Text style={styles.saveText}>{t('stConnect')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          <SettingsRow
            icon="pulse"
            label={t('stConnection')}
            value={connected ? t('connected') : t('disconnected')}
            valueColor={connected ? colors.green : colors.red}
          />
        </Section>

        {/* App update — current version (always) + manifest URL override
            (Android only — iOS can't sideload APKs). */}
        <Section title={t('stAppUpdates')}>
          <SettingsRow
            icon="information-circle-outline"
            label={t('stInstalledVersion')}
            value={`v${Application.nativeApplicationVersion ?? '?'}${
              Application.nativeBuildVersion ? ` ${t('stBuild', { n: Application.nativeBuildVersion })}` : ''
            }`}
          />
          <View style={styles.rowContainer}>
            <Ionicons name="refresh-outline" size={20} color={colors.textDim} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>{t('stCheckForUpdates')}</Text>
              {updateCheck === 'latest' && (
                <Text style={[styles.rowValue, { fontSize: 12, color: colors.green }]}>
                  {t('stLatestVersion')}
                </Text>
              )}
              {updateCheck === 'error' && (
                <Text style={[styles.rowValue, { fontSize: 12, color: colors.red }]}>
                  {t('stUpdateServerUnreachable')}
                </Text>
              )}
            </View>
            <TouchableOpacity
              style={styles.changeBtn}
              onPress={handleCheckForUpdates}
              disabled={updateCheck === 'checking'}
              activeOpacity={0.7}
            >
              {updateCheck === 'checking' ? (
                <ActivityIndicator size="small" color={colors.emerald} />
              ) : (
                <Text style={styles.changeText}>{t('stCheck')}</Text>
              )}
            </TouchableOpacity>
          </View>
          {manualLatest && (
            <UpdatePromptModal latest={manualLatest} onClose={() => setManualLatest(null)} />
          )}
          {Platform.OS === 'android' && !isEditingUpdateUrl && (
            <View style={styles.rowContainer}>
              <Ionicons name="cloud-download-outline" size={20} color={colors.textDim} />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowLabel}>{t('stUpdateUrl')}</Text>
                <Text
                  style={[styles.rowValue, { fontSize: 12, opacity: 0.75 }]}
                  numberOfLines={2}
                >
                  {updateUrl || t('loading')}
                </Text>
                {isCustomUpdateUrl && (
                  <Text style={[styles.rowValue, { fontSize: 11, color: colors.amber }]}>
                    {t('stCustomDefault', { url: defaultUpdateUrl })}
                  </Text>
                )}
              </View>
              <TouchableOpacity
                style={styles.changeBtn}
                onPress={() => {
                  setEditingUpdateUrl(updateUrl);
                  setIsEditingUpdateUrl(true);
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.changeText}>{t('stChange')}</Text>
              </TouchableOpacity>
            </View>
          )}
          {Platform.OS === 'android' && isEditingUpdateUrl && (
            <View style={styles.editContainer}>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.input}
                  value={editingUpdateUrl}
                  onChangeText={setEditingUpdateUrl}
                  placeholder={defaultUpdateUrl}
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="done"
                  onSubmitEditing={() => handleSaveUpdateUrl(editingUpdateUrl)}
                />
              </View>
              <Text style={[styles.rowValue, { fontSize: 11, opacity: 0.7, marginTop: 6 }]}>
                {t('stUpdateUrlHint')}
              </Text>
              <View style={styles.buttonRow}>
                <TouchableOpacity
                  style={styles.cancelBtn}
                  onPress={() => setIsEditingUpdateUrl(false)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.cancelText}>{t('cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.cancelBtn, { flex: 0, paddingHorizontal: 14 }]}
                  onPress={handleResetUpdateUrl}
                  activeOpacity={0.7}
                >
                  <Text style={styles.cancelText}>{t('stDefault')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.saveBtn}
                  onPress={() => handleSaveUpdateUrl(editingUpdateUrl)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.saveText}>{t('save')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </Section>

        {/* Account */}
        <Section title={t('stAccount')}>
          <SettingsRow icon="mail-outline" label={t('stEmail')} value={email || t('stUnknown')} />
        </Section>

        {/* Headlight toggle + brightness slider leven in Mower Settings
            (één plek, met 0-255 brightness control). Hier geen duplicaat. */}

        {/* Actions */}
        <Section title={t('actions')}>
          {onGoToMowerSettings && (
            <TouchableOpacity
              testID="settings-mower"
              style={styles.actionRow}
              onPress={onGoToMowerSettings}
              activeOpacity={0.7}
            >
              <Ionicons name="options-outline" size={20} color={colors.amber} />
              <Text style={styles.actionLabel}>{t('mowerSettings')}</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
            </TouchableOpacity>
          )}
          {onGoToOta && (
            <TouchableOpacity
              testID="settings-ota"
              style={styles.actionRow}
              onPress={onGoToOta}
              activeOpacity={0.7}
            >
              <Ionicons name="cloud-download-outline" size={20} color={colors.blue} />
              <Text style={styles.actionLabel}>{t('stFirmwareUpdates')}</Text>
              {fwUpdate && (
                <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: colors.red, marginRight: 8 }} />
              )}
              <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.actionRow}
            onPress={onGoToProvision}
            activeOpacity={0.7}
          >
            <Ionicons name="add-circle-outline" size={20} color={colors.emerald} />
            <Text style={styles.actionLabel}>{t('stAddDevice')}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
          </TouchableOpacity>
        </Section>

        {/* Language */}
        <Section title={t('language')}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 4 }}>
            {LANGUAGES.map(lang => (
              <TouchableOpacity
                key={lang.code}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10,
                  backgroundColor: language === lang.code ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.06)',
                  borderWidth: 1,
                  borderColor: language === lang.code ? colors.emerald : 'rgba(255,255,255,0.08)',
                }}
                onPress={() => setLanguage(lang.code)}
                activeOpacity={0.7}
              >
                <Text style={{ fontSize: 18 }}>{lang.flag}</Text>
                <Text style={{
                  color: language === lang.code ? colors.emerald : colors.textDim,
                  fontSize: 13, fontWeight: '600',
                }}>{lang.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Section>

        {/* Experimental features */}
        <Section title={t('stFeatures')}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 4 }}>
            <Ionicons name="flask" size={22} color={experimental.enabled ? '#a855f7' : colors.textMuted} style={{ marginRight: 12 }} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.white, fontSize: 15, fontWeight: '600' }}>{t('experimentalFeatures')}</Text>
              <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 4, lineHeight: 16 }}>{t('experimentalSub')}</Text>
            </View>
            <Switch
              value={experimental.enabled}
              onValueChange={experimental.toggle}
              trackColor={{ false: 'rgba(255,255,255,0.1)', true: 'rgba(168,85,247,0.4)' }}
              thumbColor={experimental.enabled ? '#a855f7' : '#666'}
            />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 4 }}>
            <Ionicons name="text" size={22} color={mapLabels.enabled ? colors.emerald : colors.textMuted} style={{ marginRight: 12 }} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.white, fontSize: 15, fontWeight: '600' }}>{t('stMapLabels')}</Text>
              <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 4, lineHeight: 16 }}>{t('stMapLabelsSub')}</Text>
            </View>
            <Switch
              value={mapLabels.enabled}
              onValueChange={mapLabels.toggle}
              trackColor={{ false: 'rgba(255,255,255,0.1)', true: 'rgba(16,185,129,0.4)' }}
              thumbColor={mapLabels.enabled ? colors.emerald : '#666'}
            />
          </View>
        </Section>

        {/* Support / donate — three external links. OpenNova is free + open
            source; tips keep the lights on. Each row opens its respective
            payment platform in the browser via Linking.openURL. */}
        {/* Push-notificaties per categorie. Uit = server stuurt die events
            niet naar dit toestel; ntfy/HA-kanalen blijven ongemoeid. */}
        <Section title={t('notifications')}>
          {PUSH_CATEGORIES.map(cat => {
            const on = !muted.includes(cat);
            return (
              <View key={cat} style={styles.rowContainer}>
                <Ionicons name={NOTIFY_ICON[cat]} size={20} color={on ? colors.emerald : colors.textMuted} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowLabel}>{t(`notify_${cat}`)}</Text>
                  <Text style={[styles.rowValue, { fontSize: 12, opacity: 0.75 }]}>{t(`notify_${cat}_sub`)}</Text>
                </View>
                <Switch value={on} onValueChange={() => toggleCategory(cat)} trackColor={{ true: colors.emerald }} />
              </View>
            );
          })}
        </Section>

        <Section title={t('stHelp')}>
          <TouchableOpacity style={styles.rowContainer} onPress={() => void handleReportProblem()} activeOpacity={0.7}>
            <Ionicons name="bug-outline" size={20} color={colors.textDim} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>{t('stReportProblem')}</Text>
              <Text style={[styles.rowValue, { fontSize: 12, opacity: 0.75 }]}>
                {t('stReportProblemSub')}
              </Text>
            </View>
            <Ionicons name="open-outline" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        </Section>

        <Section title={t('stSupportOpenNova')}>
          <Text style={styles.donateBlurb}>
            {t('stDonateBlurb')}
          </Text>
          <DonateRow
            icon="cafe-outline"
            label="Buy Me a Coffee"
            sub={t('stDonateOneOff')}
            color={colors.amber}
            url="https://buymeacoffee.com/rvbcrs"
          />
          <DonateRow
            icon="logo-paypal"
            label="PayPal"
            sub={t('stDonateAnyAmount')}
            color="#0070ba"
            url="https://paypal.me/rvbcrs"
          />
          <DonateRow
            icon="logo-github"
            label="GitHub Sponsors"
            sub={t('stDonateMonthly')}
            color={colors.white}
            url="https://github.com/sponsors/rvbcrs"
          />
        </Section>

        {/* Logout */}
        <TouchableOpacity
          style={styles.logoutButton}
          onPress={handleLogout}
          activeOpacity={0.7}
        >
          <Ionicons name="log-out-outline" size={20} color={colors.red} />
          <Text style={styles.logoutText}>{t('signOut')}</Text>
        </TouchableOpacity>

        <Text style={styles.versionText}>
          OpenNova App v{Application.nativeApplicationVersion ?? '?'}
          {Application.nativeBuildVersion ? ` ${t('stBuild', { n: Application.nativeBuildVersion })}` : ''}
        </Text>
      </ScrollView>

    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function DonateRow({
  icon,
  label,
  sub,
  color,
  url,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  sub: string;
  color: string;
  url: string;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      style={styles.donateRow}
      onPress={() => Linking.openURL(url).catch(() => {})}
      activeOpacity={0.7}
    >
      <View style={[styles.donateIcon, { backgroundColor: `${color}25` }]}>
        <Ionicons name={icon} size={20} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.donateLabel}>{label}</Text>
        <Text style={styles.donateSub}>{sub}</Text>
      </View>
      <Ionicons name="open-outline" size={16} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

const NOTIFY_ICON: Record<PushCategory, React.ComponentProps<typeof Ionicons>['name']> = {
  activity: 'play-circle-outline', errors: 'alert-circle-outline', safety: 'shield-outline',
  battery: 'battery-half-outline', maintenance: 'construct-outline',
};

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
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.rowContainer}>
      <Ionicons name={icon} size={20} color={colors.textDim} />
      <Text style={styles.rowLabel}>{label}</Text>
      <Text
        style={[styles.rowValue, valueColor ? { color: valueColor } : undefined]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  // Layout
  container: { flex: 1, backgroundColor: c.bg },
  scroll: { padding: 24, paddingBottom: 32 },
  title: { fontSize: 28, fontWeight: '700', color: c.text, marginBottom: 24 },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 13, fontWeight: '600', color: c.textDim,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginLeft: 4,
  },
  card: {
    backgroundColor: c.card, borderRadius: 16,
    borderWidth: 1, borderColor: c.cardBorder, overflow: 'hidden',
  },
  actionRow: {
    flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12,
  },
  actionLabel: { flex: 1, fontSize: 16, color: c.text },
  logoutButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    height: 48, borderRadius: 12,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.2)',
    gap: 8, marginTop: 8,
  },
  logoutText: { fontSize: 16, fontWeight: '600', color: c.red },
  versionText: { fontSize: 12, color: c.textMuted, textAlign: 'center', marginTop: 24 },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },

  // Server edit styles
  changeBtn: {
    paddingHorizontal: 12, paddingVertical: 5, borderRadius: 8,
    backgroundColor: 'rgba(0,212,170,0.15)',
  },
  changeText: { fontSize: 13, fontWeight: '600', color: c.emerald },
  editContainer: { padding: 16, gap: 12 },
  inputRow: { flexDirection: 'row', alignItems: 'center' },
  input: {
    flex: 1, height: 44, backgroundColor: c.inputBg,
    borderRadius: 10, borderWidth: 1, borderColor: c.inputBorder,
    paddingHorizontal: 14, fontSize: 15, color: c.text,
  },
  discoverBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 8,
  },
  discoverText: { fontSize: 14, color: c.emerald },
  serverItem: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: 12,
    backgroundColor: 'rgba(0,212,170,0.08)', borderRadius: 10,
  },
  serverUrl: { fontSize: 14, color: c.text, fontFamily: 'monospace' },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  cancelBtn: {
    flex: 1, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.inputBg, borderWidth: 1, borderColor: c.cardBorder,
  },
  cancelText: { fontSize: 14, fontWeight: '600', color: c.textDim },
  saveBtn: {
    flex: 1, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.emerald,
  },
  saveText: { fontSize: 14, fontWeight: '600', color: c.white },

  // Row styles (formerly rowStyles)
  rowContainer: {
    flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12,
    borderBottomWidth: 1, borderBottomColor: c.cardBorder,
  },
  rowLabel: { fontSize: 15, color: c.textDim },
  rowValue: { flex: 1, fontSize: 15, color: c.text, textAlign: 'right' },

  // Donate section
  donateBlurb: {
    fontSize: 13, color: c.textMuted, lineHeight: 18,
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6,
  },
  donateRow: {
    flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12,
    borderTopWidth: 1, borderTopColor: c.cardBorder,
  },
  donateIcon: {
    width: 36, height: 36, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  donateLabel: { fontSize: 15, fontWeight: '600', color: c.text },
  donateSub: { fontSize: 12, color: c.textMuted, marginTop: 2 },

  // Appearance segment
  appearanceSection: {
    marginBottom: 24,
  },
  segment: {
    flexDirection: 'row',
    backgroundColor: c.card,
    borderRadius: 10,
    padding: 4,
    borderWidth: 1,
    borderColor: c.cardBorder,
  },
  segmentItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 7,
  },
  segmentItemActive: {
    backgroundColor: c.emerald,
  },
  segmentLabel: {
    fontSize: 14,
    color: c.textDim,
    fontWeight: '600',
  },
  segmentLabelActive: {
    color: c.white,
  },
  segmentCaption: {
    fontSize: 12,
    color: c.textMuted,
    marginTop: 8,
    marginLeft: 4,
  },
});
