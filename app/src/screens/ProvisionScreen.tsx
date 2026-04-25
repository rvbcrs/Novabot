import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ScrollView,
  Animated,
  ActivityIndicator,
  Platform,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useStyles, useTheme, type Colors } from '../theme';
import type { RootStackParams } from '../navigation/types';
import {
  provisionDevice,
  setBleLogCallback,
  bleLog,
  type ScannedDevice,
  type DeviceType,
  type ProvisionPhase,
} from '../services/ble';
import { ApiClient } from '../services/api';
import { getServerUrl } from '../services/auth';

type Props = NativeStackScreenProps<RootStackParams, 'Provision'>;

// Ordered steps — each step can match multiple BLE phases
const PROVISION_STEPS = [
  { key: 'connecting', phases: ['connecting'], label: 'Connecting' },
  { key: 'discovering', phases: ['discovering'], label: 'Discovering Services' },
  { key: 'wifi', phases: ['wifi'], label: 'Configuring WiFi' },
  { key: 'config', phases: ['rtk', 'lora'], label: 'Configuring Device' },
  { key: 'mqtt', phases: ['mqtt'], label: 'Setting MQTT' },
  { key: 'commit', phases: ['commit'], label: 'Saving Settings' },
];

const STEP_KEYS = PROVISION_STEPS.map(s => s.key);

type DeviceState = {
  device: ScannedDevice;
  currentPhase: ProvisionPhase | 'idle';
  message: string;
  completedPhases: Set<string>;
  success: boolean;
  error: boolean;
};

export default function ProvisionScreen({ navigation, route }: Props) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { mqttAddr, mqttPort, wifiSsid, wifiPassword, devices } = route.params;
  const [deviceStates, setDeviceStates] = useState<Map<string, DeviceState>>(
    () => {
      const map = new Map<string, DeviceState>();
      for (const d of devices) {
        map.set(d.id, {
          device: d,
          currentPhase: 'idle',
          message: 'Waiting...',
          completedPhases: new Set(),
          success: false,
          error: false,
        });
      }
      return map;
    },
  );
  const [bleLogs, setBleLogs] = useState<string[]>([]);
  const [allDone, setAllDone] = useState(false);
  const [allSuccess, setAllSuccess] = useState(false);
  const [otaStatus, setOtaStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [otaMessage, setOtaMessage] = useState('');
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);
  const startedRef = useRef(false);
  const provisionStartTime = useRef(0);

  // Manual LoRa override — user kan addr/channel invullen om de
  // auto-assign vanuit de server te overrulen. Handig bij migraties of
  // wanneer je weet welk paar bij elkaar hoort (bv. charger + mower moet
  // op zelfde addr, ongeacht DB state). Leeg = auto.
  //
  // We houden de waardes zowel in state (voor UI) als in refs (voor
  // runProvisioning). De ref-kopie elimineert elke kans op stale closures
  // (bewezen issue 2026-04-21: user typte 51154, useCallback deps hadden
  // loraAddrOverride, toch kwam auto-assign branch uit runProvisioning).
  // Met een ref werkt het zelfs als Metro een oudere bundle heeft gecached
  // of als React batching de render nog niet heeft gecommit op het
  // moment van onPress.
  const [loraAddrOverride, setLoraAddrOverride] = useState<string>('');
  const [loraChannelOverride, setLoraChannelOverride] = useState<string>('');
  const loraAddrOverrideRef = useRef<string>('');
  const loraChannelOverrideRef = useRef<string>('');
  useEffect(() => { loraAddrOverrideRef.current = loraAddrOverride; }, [loraAddrOverride]);
  useEffect(() => { loraChannelOverrideRef.current = loraChannelOverride; }, [loraChannelOverride]);
  const [loraConflict, setLoraConflict] = useState<null | { sn: string; addr: number | null; channel: number | null }[]>(null);
  const [acknowledgedConflict, setAcknowledgedConflict] = useState(false);

  // Pending LoRa registrations per deviceType — gevuld na een succesvolle BLE
  // provisioning wanneer we GEEN echte SN hebben (iOS anon-UUID issue). Zodra
  // het corresponderende device via MQTT online komt met een echte SN,
  // draint pollDeviceStatus dit naar `/lora/register` zodat de DB direct
  // de override/auto-assign waarden bevat. Dat maakt de DB-state onafhankelijk
  // van de broker.ts get_lora_info_respond auto-sync (die ook werkt, maar pas
  // na eerste MQTT poll van extended_commands).
  const pendingLoraReg = useRef<Map<'charger' | 'mower', { addr: number; channel: number }>>(new Map());
  const completedLoraReg = useRef<Set<string>>(new Set());
  // Expliciete start — user moet zelf op "Start provisioning" tikken
  // zodat LoRa-override kan worden ingevuld voordat het BLE-proces start.
  const [hasStarted, setHasStarted] = useState(false);

  // Success animation
  const successScale = useRef(new Animated.Value(0)).current;
  const successOpacity = useRef(new Animated.Value(0)).current;

  // Debounced LoRa conflict check — triggert zodra de user een addr invult
  // en meer dan 350ms stopt met typen. Toont de SNs van conflicterende
  // apparaten zodat je bewust kan besluiten om (a) een ander addr te kiezen
  // of (b) "ok, is mijn bedoeling" en acknowledgen.
  useEffect(() => {
    setAcknowledgedConflict(false);
    const addrStr = loraAddrOverride.trim();
    if (!addrStr) { setLoraConflict(null); return; }
    const addr = parseInt(addrStr, 10);
    if (!Number.isFinite(addr) || addr < 0) { setLoraConflict(null); return; }
    const channel = loraChannelOverride.trim() ? parseInt(loraChannelOverride.trim(), 10) : undefined;
    const t = setTimeout(async () => {
      try {
        const url = await getServerUrl();
        if (!url) return;
        const api = new ApiClient(url);
        const r = await api.checkLoraAvailability(addr, channel);
        setLoraConflict(r.conflicts.length > 0 ? r.conflicts : null);
      } catch { /* ignore */ }
    }, 350);
    return () => clearTimeout(t);
  }, [loraAddrOverride, loraChannelOverride]);

  const updateDeviceState = useCallback(
    (deviceId: string, updater: (prev: DeviceState) => DeviceState) => {
      setDeviceStates((prev) => {
        const next = new Map(prev);
        const current = next.get(deviceId);
        if (current) {
          next.set(deviceId, updater(current));
        }
        return next;
      });
    },
    [],
  );

  const runProvisioning = useCallback(async () => {
    provisionStartTime.current = Date.now();
    const results: boolean[] = [];

    // Pre-check: als de user een LoRa addr heeft ingevuld dat al in gebruik
    // is en NIET expliciet bevestigd, abort met een duidelijke melding. Dit
    // voorkomt dat je per ongeluk een al-geprovisioned apparaat opnieuw
    // provisioned en daarmee z'n LoRa pair breekt.
    //
    // KRITIEK: lees via refs — NIET via captured state. Zie de ref-setup
    // bovenaan de component. Als de runProvisioning closure een oude
    // `loraAddrOverride` value had gezien (wat in de praktijk gebeurd is
    // op 2026-04-21 ondanks useCallback deps), dan zou auto-assign
    // gedraaid worden met 718/16 ipv de user's 51154/18. Ref-read vermijdt
    // dat volledig.
    const manualAddrStr = loraAddrOverrideRef.current.trim();
    const manualAddr = manualAddrStr ? parseInt(manualAddrStr, 10) : null;
    const manualChannelStr = loraChannelOverrideRef.current.trim();
    const manualChannel = manualChannelStr ? parseInt(manualChannelStr, 10) : null;

    // Log ALTIJD wat we daadwerkelijk hebben gelezen, zodat het in de
    // on-screen BLE debug log staat als onomstotelijk bewijs dat de
    // override-waardes wel/niet zijn doorgekomen. Scheelt eindeloos
    // "heb je de velden wel ingevuld?" discussies.
    bleLog(
      `[LoRa] Read override from UI → addr="${manualAddrStr}" (${manualAddr}), ` +
      `channel="${manualChannelStr}" (${manualChannel}), ` +
      `acknowledgedConflict=${acknowledgedConflict}`,
    );
    if (manualAddr != null && loraConflict && loraConflict.length > 0 && !acknowledgedConflict) {
      Alert.alert(
        'LoRa address already in use',
        `Address ${manualAddr}${manualChannel != null ? ` / channel ${manualChannel}` : ''} is assigned to: ${loraConflict.map(c => c.sn).join(', ')}\n\nProvisioning will overwrite the LoRa parameters on the target device and break its existing pair. Tap the warning badge to acknowledge and continue.`,
      );
      return;
    }

    // Fetch LoRa params from server before provisioning (only when no manual override)
    let chargerLoraParams: { addr: number; channel: number; hc: number; lc: number } | undefined;
    let mowerLoraParams: { addr: number; channel: number; hc: number; lc: number } | undefined;

    const hasCharger = devices.some(d => d.type === 'charger');
    const hasMower = devices.some(d => d.type === 'mower');

    // ── Manual override mode ──────────────────────────────────────
    // User-spec 2026-04-22 (bijgewerkt):
    //   Het "channel" veld in de UI = het CHARGER+MOWER channel (identiek).
    //   Mower en charger zitten ALTIJD op hetzelfde LoRa-paar (zelfde addr,
    //   zelfde channel). Bewezen 22 apr 2026 met working-lora-pair addr=718
    //   ch=17. De oudere "mower = channel - 1" regel was onjuist.
    if (manualAddr != null && Number.isFinite(manualAddr)) {
      const userChannel = manualChannel != null && Number.isFinite(manualChannel) ? manualChannel : 16;
      if (hasCharger && hasMower) {
        // Pair: user-value is gemeenschappelijk channel voor beide devices.
        chargerLoraParams = { addr: manualAddr, channel: userChannel, hc: 20, lc: 14 };
        mowerLoraParams   = { addr: manualAddr, channel: userChannel, hc: 20, lc: 14 };
        bleLog(`[LoRa] MANUAL OVERRIDE (pair): addr=${manualAddr} ch=${userChannel} (charger + mower identiek)`);
      } else if (hasCharger) {
        chargerLoraParams = { addr: manualAddr, channel: userChannel, hc: 20, lc: 14 };
        bleLog(`[LoRa] MANUAL OVERRIDE (charger only): addr=${manualAddr}/ch=${userChannel}`);
      } else {
        // mower only
        mowerLoraParams = { addr: manualAddr, channel: userChannel, hc: 20, lc: 14 };
        bleLog(`[LoRa] MANUAL OVERRIDE (mower only): addr=${manualAddr}/ch=${userChannel}`);
      }

      // Defense in depth: ook via de extended_commands backchannel sturen
      // als het doel-apparaat al online is via MQTT. De BLE-route werkt
      // óók op een al-geprovisioned mower (bewezen 2026-04-21), maar als
      // de BLE stap om wat voor reden dan ook faalt, pakt de MQTT-
      // backchannel het op. Beide routes zijn idempotent.
      try {
        const serverUrl = await getServerUrl();
        if (serverUrl) {
          const api = new ApiClient(serverUrl);
          for (const dev of devices) {
            const sn = (dev as { sn?: string }).sn;
            if (!sn) continue;
            const forThis = dev.type === 'charger' ? chargerLoraParams : mowerLoraParams;
            if (!forThis) continue;
            try {
              await api.sendExtended(sn, {
                set_lora_info: { addr: forThis.addr, channel: forThis.channel },
              });
              bleLog(`[LoRa] extended_commands set_lora_info sent to ${sn} (ch=${forThis.channel})`);
            } catch { /* device may be offline, will rely on BLE path */ }
          }
        }
      } catch { /* ignore */ }
    } else {
      // ── Auto-assign mode ──────────────────────────────────────
      // User-spec: server-side `/lora/resolve` doet authoritative pair-aware
      // resolution. Charger = max(charger addrs)+1. Mower = paart met orphan
      // charger (IDENTIEK addr + channel — mower en charger op hetzelfde paar).
      try {
        const serverUrl = await getServerUrl();
        if (serverUrl) {
          const api = new ApiClient(serverUrl);

          if (hasCharger) {
            const resp = await api.resolveLora('charger');
            chargerLoraParams = { addr: resp.address, channel: resp.channel, hc: resp.hc, lc: resp.lc };
            bleLog(`[LoRa] Auto (charger): addr=${resp.address} ch=${resp.channel} (${resp.basis})`);
          }

          if (hasMower) {
            const resp = await api.resolveLora('mower');
            mowerLoraParams = { addr: resp.address, channel: resp.channel, hc: resp.hc, lc: resp.lc };
            bleLog(`[LoRa] Auto (mower): addr=${resp.address} ch=${resp.channel} (${resp.basis})`);

            // Edge case: mower + charger in dezelfde sessie zonder override.
            // Als de charger nieuw is (net door ons berekend in deze session),
            // moet de mower met die NIEUWE charger paren op IDENTIEK addr+ch
            // (niet met een oude orphan).
            if (chargerLoraParams) {
              mowerLoraParams = {
                addr: chargerLoraParams.addr,
                channel: chargerLoraParams.channel,
                hc: 20,
                lc: 14,
              };
              bleLog(`[LoRa] Mower pair with in-session charger: addr=${mowerLoraParams.addr} ch=${mowerLoraParams.channel} (identiek aan charger)`);
            }
          }
        }
      } catch (e) {
        bleLog(`[LoRa] Could not fetch from server, using defaults: ${e}`);
      }
    }

    for (const dev of devices) {
      const deviceType: DeviceType =
        dev.type === 'charger' || dev.type === 'mower' ? dev.type : 'mower';

      // Pick the right LoRa params per device type
      const loraForDevice = deviceType === 'charger' ? chargerLoraParams : mowerLoraParams;

      updateDeviceState(dev.id, (s) => ({
        ...s,
        currentPhase: 'connecting',
        message: 'Starting...',
      }));

      const ok = await provisionDevice(
        dev.id,
        deviceType,
        { wifiSsid, wifiPassword, mqttAddr, mqttPort, lora: loraForDevice, deviceName: dev.name },
        (phase, message) => {
          updateDeviceState(dev.id, (s) => {
            const completed = new Set(s.completedPhases);

            // Find which step this phase belongs to
            const activeStepIdx = PROVISION_STEPS.findIndex(st => st.phases.includes(phase));

            if (phase === 'done') {
              // Mark all steps as completed
              for (const st of PROVISION_STEPS) completed.add(st.key);
            } else if (activeStepIdx >= 0) {
              // Mark all steps BEFORE the active one as completed
              for (let i = 0; i < activeStepIdx; i++) {
                completed.add(PROVISION_STEPS[i].key);
              }
            }
            // Unknown phase → don't change anything

            return {
              ...s,
              currentPhase: phase,
              message,
              completedPhases: completed,
              success: phase === 'done',
              error: phase === 'error',
            };
          });
        },
      );

      // After successful provisioning, register LoRa params on server for
      // BOTH charger + mower so equipment_lora_cache is consistent en de
      // TRUTH per direct in de DB staat — geen wachten op eventuele MQTT
      // get_lora_info_respond auto-sync.
      //
      // Twee paden:
      //  (A) We HEBBEN een echte SN (dev.sn van MQTT hello, of dev.name met
      //      LFIN/LFIC prefix) → direct POST /lora/register.
      //  (B) We hebben GEEN echte SN (iOS anon-UUID, "NOVABOT"/"CHARGER_PILE"
      //      names) → queue de params in pendingLoraReg. pollDeviceStatus
      //      drain't de queue zodra een matching SN via MQTT online komt.
      //      Zonder deze queue bleef de DB stale op oude waarden na een
      //      re-provision met override (live bug 2026-04-21).
      if (ok) {
        const loraForReg = deviceType === 'charger' ? chargerLoraParams : mowerLoraParams;
        if (loraForReg) {
          const devAny = dev as { name?: string; sn?: string; id?: string };
          const rawSn = devAny.sn ?? devAny.name ?? devAny.id ?? '';
          const isRealSn = rawSn.startsWith('LFIN') || rawSn.startsWith('LFIC');
          if (isRealSn) {
            try {
              const serverUrl = await getServerUrl();
              if (serverUrl) {
                const api = new ApiClient(serverUrl);
                await api.registerLora(rawSn, loraForReg.addr, loraForReg.channel);
                completedLoraReg.current.add(rawSn);
                bleLog(`[LoRa] Registered ${deviceType} ${rawSn}: addr=${loraForReg.addr} ch=${loraForReg.channel}`);
              }
            } catch (e) {
              bleLog(`[LoRa] Failed to register ${rawSn}: ${e}`);
            }
          } else {
            pendingLoraReg.current.set(deviceType, {
              addr: loraForReg.addr,
              channel: loraForReg.channel,
            });
            bleLog(`[LoRa] Queued registration for ${deviceType} (addr=${loraForReg.addr} ch=${loraForReg.channel}) — waits for real SN via MQTT`);
          }
        }
      }

      results.push(ok);
    }

    setAllDone(true);
    setAllSuccess(results.every(Boolean));
  }, [
    devices, mqttAddr, mqttPort, wifiSsid, wifiPassword, updateDeviceState,
    // loraAddrOverride/channel worden NIET uit state gelezen maar uit refs
    // (zie hierboven), dus niet nodig in deps. loraConflict +
    // acknowledgedConflict blijven wel state-reads → in deps.
    loraConflict, acknowledgedConflict,
  ]);

  useEffect(() => {
    // Set up BLE log capture
    setBleLogCallback((msg) => setBleLogs(prev => [...prev.slice(-50), msg]));
    return () => setBleLogCallback(null);
  }, []);

  // Provisioning start NIET meer automatisch zodra het scherm opent —
  // anders kan de user geen LoRa-override invullen. Nu expliciete "Start"
  // knop in de UI; runProvisioning alleen na user tap.

  // Check server reachability + device MQTT status when provisioning completes
  const [deviceOnline, setDeviceOnline] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!allDone || !allSuccess) return;

    const checkServer = async () => {
      const url = `http://${mqttAddr}:3000/api/setup/health`;
      bleLog(`[SERVER] Checking ${url}...`);
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        const body = await res.json() as Record<string, unknown>;
        const reachable = body?.server === 'running';
        bleLog(`[SERVER] Health: server=${body?.server}, mqtt=${body?.mqtt}, devices=${body?.devicesConnected}`);
        setServerReachable(reachable);

        if (reachable) {
          pollDeviceStatus();
        }
      } catch (e: any) {
        bleLog(`[SERVER] Health check failed: ${e.message}`);
        setServerReachable(false);
      }
    };

    const pollDeviceStatus = async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`http://${mqttAddr}:3000/api/setup/health`, {
          signal: controller.signal,
        });
        clearTimeout(timer);
        const body = await res.json() as Record<string, unknown>;
        const lastDevice = body?.lastDeviceOnline as Record<string, unknown> | null;
        const lastSn = lastDevice?.sn as string | null;
        const lastSeen = lastDevice?.last_seen as string | null;
        bleLog(`[MQTT-POLL] lastDevice=${lastSn}, lastSeen=${lastSeen}`);

        // Check if one of our provisioned devices came online recently
        if (lastSn && lastSeen) {
          const seenDate = new Date(lastSeen + 'Z'); // UTC
          const age = Date.now() - seenDate.getTime();
          // Match against BLE device names (charger=CHARGER_PILE, mower=Novabot)
          // or check if the SN is new (wasn't online before provisioning started)
          const isOurDevice = devices.some(d => {
            // SN-based match: device name might contain part of SN
            const nameLower = (d.name ?? '').toLowerCase();
            const snLower = (lastSn ?? '').toLowerCase();
            return nameLower.includes(snLower) || snLower.includes(nameLower);
          });

          if (age < 120000 && age > 0) { // within 2 minutes
            // Only mark as online if the device wasn't already online before we started
            const wasAlreadyOnline = provisionStartTime.current > 0 &&
              seenDate.getTime() < provisionStartTime.current;

            if (!wasAlreadyOnline) {
              const status: Record<string, boolean> = {};
              for (const dev of devices) status[dev.id] = true;
              setDeviceOnline(status);
              bleLog(`[MQTT-POLL] New device online: ${lastSn} (${Math.round(age/1000)}s ago)`);

              // Drain pending LoRa registration queue — we weten nu eindelijk
              // de echte SN achter de BLE-scan anon-UUID. Match op SN prefix
              // (LFIC=charger, LFIN=mower) en registreer met de override/
              // auto-assign waardes die we bij BLE-succes hebben gequeued.
              try {
                const devType: 'charger' | 'mower' | null =
                  lastSn.startsWith('LFIC') ? 'charger' :
                  lastSn.startsWith('LFIN') ? 'mower' : null;
                const pending = devType ? pendingLoraReg.current.get(devType) : null;
                if (devType && pending && !completedLoraReg.current.has(lastSn)) {
                  const serverUrl = await getServerUrl();
                  if (serverUrl) {
                    const api = new ApiClient(serverUrl);
                    await api.registerLora(lastSn, pending.addr, pending.channel);
                    completedLoraReg.current.add(lastSn);
                    pendingLoraReg.current.delete(devType);
                    bleLog(`[LoRa] Drained pending registration → ${devType} ${lastSn}: addr=${pending.addr} ch=${pending.channel}`);
                  }
                }
              } catch (regErr: any) {
                bleLog(`[LoRa] Pending registration drain failed: ${regErr?.message ?? regErr}`);
              }
            } else {
              bleLog(`[MQTT-POLL] ${lastSn} was already online before provisioning`);
            }
          }
        }
      } catch (e: any) {
        bleLog(`[MQTT-POLL] Failed: ${e.message}`);
      }
    };

    checkServer();

    // Poll device status every 5s for 60s
    const interval = setInterval(pollDeviceStatus, 5000);
    const stopAfter = setTimeout(() => clearInterval(interval), 60000);

    return () => {
      clearInterval(interval);
      clearTimeout(stopAfter);
    };
  }, [allDone, allSuccess, mqttAddr, devices]);

  // Animate success state
  useEffect(() => {
    if (allDone && allSuccess) {
      Animated.parallel([
        Animated.spring(successScale, {
          toValue: 1,
          friction: 4,
          tension: 40,
          useNativeDriver: true,
        }),
        Animated.timing(successOpacity, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [allDone, allSuccess, successScale, successOpacity]);

  const handleProvisionAnother = () => {
    navigation.navigate('DeviceChoice', { mqttAddr, mqttPort });
  };

  /** Terug naar het Settings tabblad (SettingsMain).
   *
   *  ProvisionScreen zit 3 navigator-lagen diep:
   *    MainTab.AppSettings → SettingsStack.ProvisionFlow → ProvisionStack.Provision
   *
   *  popToTop() op onze eigen stack landt op DeviceChoice (de root van
   *  ProvisionStack) — dat is niet wat we willen. We moeten UIT de
   *  ProvisionFlow stack via `getParent()` en dan naar `SettingsMain`
   *  binnen de SettingsStack. Als de parent-lookup faalt (edge case bij
   *  screen unmount), fallback op goBack. */
  const handleBackToSettings = () => {
    try {
      // Parent = SettingsStack. navigate('SettingsMain') pop't de nested
      // ProvisionFlow screen én toont SettingsMain (een stack-reset).
      const parent = (navigation as unknown as { getParent?: () => { navigate: (n: string) => void } | null | undefined }).getParent?.();
      if (parent) {
        parent.navigate('SettingsMain');
        return;
      }
    } catch { /* ignore */ }
    const nav = navigation as unknown as { popToTop?: () => void; goBack: () => void };
    if (typeof nav.popToTop === 'function') nav.popToTop();
    else nav.goBack();
  };

  const handleOtaTrigger = async () => {
    setOtaStatus('sending');
    setOtaMessage('Checking for firmware updates...');
    try {
      // Check OTA versions available on the server
      const checkRes = await fetch(`http://${mqttAddr}:3000/api/dashboard/ota/versions`);
      if (!checkRes.ok) throw new Error('Server not reachable');
      const versions = await checkRes.json();

      if (!versions?.data?.length) {
        setOtaStatus('idle');
        setOtaMessage('No firmware updates available on server.');
        return;
      }

      // Trigger OTA for each provisioned device
      for (const dev of devices) {
        const sn = dev.name === 'CHARGER_PILE'
          ? '' // Charger SN comes from MQTT, we don't have it here
          : ''; // Same for mower

        // Try triggering with the latest version
        const latest = versions.data[0];
        setOtaMessage(`Sending firmware ${latest.version} to ${dev.name}...`);

        const triggerRes = await fetch(`http://${mqttAddr}:3000/api/dashboard/ota/trigger/${dev.name}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version_id: latest.id }),
        });

        if (triggerRes.ok) {
          setOtaMessage(`Firmware update sent to ${dev.name}!`);
        } else {
          const err = await triggerRes.json().catch(() => ({}));
          setOtaMessage(`OTA trigger failed: ${(err as any).error || 'Unknown error'}`);
        }
      }
      setOtaStatus('sent');
    } catch (err: any) {
      setOtaStatus('error');
      setOtaMessage(`Could not reach server: ${err.message}`);
    }
  };

  const handleRetry = () => {
    startedRef.current = false;
    setAllDone(false);
    setAllSuccess(false);
    const map = new Map<string, DeviceState>();
    for (const d of devices) {
      map.set(d.id, {
        device: d,
        currentPhase: 'idle',
        message: 'Waiting...',
        completedPhases: new Set(),
        success: false,
        error: false,
      });
    }
    setDeviceStates(map);
    // Re-trigger
    setTimeout(() => {
      startedRef.current = true;
      runProvisioning();
    }, 100);
  };

  const stateArray = Array.from(deviceStates.values());

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Header met terug-pijl. De pijl pakt je uit de hele provisioning
            flow (BleScan/DeviceChoice/Provision) en brengt je in één tik
            terug op SettingsMain. Werkt in elke fase — tijdens provisioning
            (abort), na success, of bij een error. */}
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <TouchableOpacity
              onPress={handleBackToSettings}
              activeOpacity={0.7}
              style={styles.backButton}
              accessibilityLabel="Back to Settings"
            >
              <Ionicons name="arrow-back" size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.title}>Provisioning</Text>
          </View>
          <Text style={styles.subtitle}>
            {allDone
              ? allSuccess
                ? 'All devices provisioned successfully!'
                : 'Provisioning completed with errors.'
              : hasStarted
                ? 'Configuring your devices via BLE...'
                : 'Review the LoRa settings below, then tap Start.'}
          </Text>
        </View>

        {/* Success banner */}
        {allDone && allSuccess && (
          <Animated.View
            style={[
              styles.successBanner,
              {
                transform: [{ scale: successScale }],
                opacity: successOpacity,
              },
            ]}
          >
            <View style={styles.successIconCircle}>
              <Ionicons name="checkmark-circle" size={56} color={colors.green} />
            </View>
            <Text style={styles.successTitle}>Done!</Text>
            <Text style={styles.successSubtitle}>
              Your {devices.length > 1 ? 'devices are' : 'device is'} now configured
              and will reconnect to your network.
            </Text>

            {/* Device MQTT status */}
            {Object.keys(deviceOnline).length > 0 && (
              <View style={styles.onlineStatus}>
                <Ionicons name="pulse" size={16} color={colors.green} />
                <Text style={[styles.otaStatusText, { color: colors.green }]}>
                  Device connected to server via MQTT!
                </Text>
              </View>
            )}
            {serverReachable === true && Object.keys(deviceOnline).length === 0 && (
              <View style={styles.onlineStatus}>
                <ActivityIndicator size="small" color={colors.textDim} />
                <Text style={styles.otaStatusText}>
                  Waiting for device to connect to MQTT...
                </Text>
              </View>
            )}

            {/* OTA Firmware Update */}
            {otaStatus === 'idle' && serverReachable === true && (
              <TouchableOpacity
                style={styles.otaButton}
                onPress={handleOtaTrigger}
                activeOpacity={0.7}
              >
                <Ionicons name="cloud-download-outline" size={18} color={colors.white} />
                <Text style={styles.otaButtonText}>Check for Firmware Updates</Text>
              </TouchableOpacity>
            )}
            {otaStatus === 'idle' && serverReachable === false && (
              <View style={styles.otaStatus}>
                <Ionicons name="cloud-offline-outline" size={16} color={colors.textMuted} />
                <Text style={styles.otaStatusText}>Server not reachable — firmware updates unavailable</Text>
              </View>
            )}
            {otaStatus === 'idle' && serverReachable === null && (
              <View style={styles.otaStatus}>
                <Ionicons name="hourglass-outline" size={16} color={colors.textDim} />
                <Text style={styles.otaStatusText}>Checking server...</Text>
              </View>
            )}
            {otaStatus === 'sending' && (
              <View style={styles.otaStatus}>
                <Ionicons name="hourglass-outline" size={16} color={colors.amber} />
                <Text style={styles.otaStatusText}>{otaMessage}</Text>
              </View>
            )}
            {otaStatus === 'sent' && (
              <View style={styles.otaStatus}>
                <Ionicons name="checkmark-circle" size={16} color={colors.green} />
                <Text style={[styles.otaStatusText, { color: colors.green }]}>{otaMessage}</Text>
              </View>
            )}
            {otaStatus === 'error' && (
              <View style={styles.otaStatus}>
                <Ionicons name="alert-circle" size={16} color={colors.amber} />
                <Text style={[styles.otaStatusText, { color: colors.amber }]}>{otaMessage}</Text>
              </View>
            )}
          </Animated.View>
        )}

        {/* Advanced: LoRa override — tekstboxes die de auto-assign overrulen.
            Leeg = auto vanuit server (safe default). Ingevuld = exact deze
            addr/channel. Bij een conflict met een ander geregistreerd device
            in de DB verschijnt een waarschuwing; je moet 'm expliciet
            acknowledgen voordat provisioning doorgaat. Alleen zichtbaar
            vóórdat provisioning gestart is — daarna wordt de kaart
            verborgen zodat de voortgang vrij staat. */}
        {!hasStarted && !allDone && (
          <View style={styles.loraCard}>
            <Text style={styles.loraTitle}>LoRa parameters (optional)</Text>
            <Text style={styles.loraSubtitle}>
              Leave empty for auto-assign. Fill in when you need to match a
              specific charger/mower pair.
            </Text>
            <View style={styles.loraInputRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.loraInputLabel}>Address</Text>
                <TextInput
                  style={styles.loraInput}
                  value={loraAddrOverride}
                  onChangeText={(v) => {
                    // Update ref ONMIDDELLIJK (synchronoous, geen render-wait)
                    // zodat runProvisioning direct de juiste waarde ziet, zelfs
                    // als user millimeters na 'n keystroke al op Start tikt.
                    loraAddrOverrideRef.current = v;
                    setLoraAddrOverride(v);
                  }}
                  onEndEditing={(e) => {
                    // iOS: forceer dat de native TextInput buffer z'n laatste
                    // waarde commit. Zonder dit kan na fast-type → tap een
                    // char missen in de gecaptured state.
                    const v = e.nativeEvent.text;
                    loraAddrOverrideRef.current = v;
                    setLoraAddrOverride(v);
                  }}
                  placeholder="e.g. 718"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="number-pad"
                  maxLength={6}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.loraInputLabel}>Channel</Text>
                <TextInput
                  style={styles.loraInput}
                  value={loraChannelOverride}
                  onChangeText={(v) => {
                    loraChannelOverrideRef.current = v;
                    setLoraChannelOverride(v);
                  }}
                  onEndEditing={(e) => {
                    const v = e.nativeEvent.text;
                    loraChannelOverrideRef.current = v;
                    setLoraChannelOverride(v);
                  }}
                  placeholder="16"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="number-pad"
                  maxLength={3}
                />
              </View>
            </View>
            {loraConflict && loraConflict.length > 0 && (
              <TouchableOpacity
                style={[styles.loraWarning, acknowledgedConflict && styles.loraWarningAcknowledged]}
                onPress={() => setAcknowledgedConflict(!acknowledgedConflict)}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={acknowledgedConflict ? 'checkmark-circle' : 'warning'}
                  size={16}
                  color={acknowledgedConflict ? colors.emerald : colors.amber}
                />
                <Text style={[styles.loraWarningText, acknowledgedConflict && { color: colors.textDim }]}>
                  {acknowledgedConflict
                    ? `Acknowledged — provisioning will overwrite ${loraConflict.map(c => c.sn).join(', ')}`
                    : `This LoRa is already used by: ${loraConflict.map(c => c.sn).join(', ')} — tap to acknowledge`}
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.startProvisionBtn}
              onPress={() => {
                // Lees via refs — zie comment bij runProvisioning. De state
                // kan op iOS net-net achter lopen op de TextInput als de
                // user na typen direct op Start tikt zonder onBlur fire.
                const manualAddrStr = loraAddrOverrideRef.current.trim();
                bleLog(
                  `[LoRa] Start button → override read addr="${manualAddrStr}" ` +
                  `channel="${loraChannelOverrideRef.current.trim()}" ` +
                  `(state.addr="${loraAddrOverride}" state.channel="${loraChannelOverride}")`,
                );
                if (manualAddrStr && loraConflict && loraConflict.length > 0 && !acknowledgedConflict) {
                  Alert.alert(
                    'LoRa address already in use',
                    `Tap the warning above to acknowledge before starting provisioning.`,
                  );
                  return;
                }
                setHasStarted(true);
                startedRef.current = true;
                runProvisioning();
              }}
              activeOpacity={0.8}
            >
              <Ionicons name="play-circle" size={20} color={colors.white} />
              <Text style={styles.startProvisionText}>Start provisioning</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Device progress cards */}
        {stateArray.map((ds) => (
          <View key={ds.device.id} style={styles.deviceCard}>
            {/* Device header */}
            <View style={styles.deviceHeader}>
              <Ionicons
                name={ds.device.type === 'charger' ? 'flash' : 'construct'}
                size={20}
                color={ds.device.type === 'charger' ? colors.amber : colors.emerald}
              />
              <Text style={styles.deviceName}>{ds.device.name}</Text>
              {ds.success && (
                <View style={styles.successBadge}>
                  <Ionicons name="checkmark" size={14} color={colors.green} />
                  <Text style={styles.successBadgeText}>Done</Text>
                </View>
              )}
              {ds.error && (
                <View style={[styles.successBadge, { backgroundColor: 'rgba(239,68,68,0.15)' }]}>
                  <Ionicons name="close" size={14} color={colors.red} />
                  <Text style={[styles.successBadgeText, { color: colors.red }]}>Error</Text>
                </View>
              )}
            </View>

            {/* Steps */}
            <View style={styles.stepsContainer}>
              {PROVISION_STEPS.map((stepDef, i) => {
                const isCompleted = ds.completedPhases.has(stepDef.key);
                const isCurrent = stepDef.phases.includes(ds.currentPhase);
                const isError = ds.error && isCurrent;
                const isPending = !isCompleted && !isCurrent;

                return (
                  <View key={stepDef.key} style={styles.stepRow}>
                    {/* Connector line */}
                    {i > 0 && (
                      <View
                        style={[
                          styles.stepLine,
                          isCompleted || isCurrent
                            ? styles.stepLineActive
                            : styles.stepLineInactive,
                        ]}
                      />
                    )}
                    {/* Step indicator */}
                    <View style={styles.stepIndicatorRow}>
                      {isCompleted ? (
                        <View style={[styles.stepDot, styles.stepDotCompleted]}>
                          <Ionicons name="checkmark" size={12} color={colors.white} />
                        </View>
                      ) : isCurrent ? (
                        <View style={[styles.stepDot, isError ? styles.stepDotError : styles.stepDotActive]}>
                          {isError ? (
                            <Ionicons name="close" size={12} color={colors.white} />
                          ) : (
                            <View style={styles.stepPulse} />
                          )}
                        </View>
                      ) : (
                        <View style={[styles.stepDot, styles.stepDotPending]} />
                      )}
                      <Text
                        style={[
                          styles.stepLabel,
                          isCompleted && styles.stepLabelCompleted,
                          isCurrent && !isError && styles.stepLabelActive,
                          isError && styles.stepLabelError,
                          isPending && styles.stepLabelPending,
                        ]}
                      >
                        {stepDef.label}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>

            {/* Status message */}
            {ds.message && !ds.success && (
              <Text style={[styles.statusMessage, ds.error && { color: colors.red }]}>
                {ds.message}
              </Text>
            )}
          </View>
        ))}
        {/* Debug console */}
        {bleLogs.length > 0 && (
          <View style={styles.debugCard}>
            <Text style={styles.debugTitle}>BLE Debug Log</Text>
            <ScrollView style={styles.debugScroll} nestedScrollEnabled>
              {bleLogs.map((log, i) => (
                <Text key={i} style={styles.debugLine}>{log}</Text>
              ))}
            </ScrollView>
          </View>
        )}
      </ScrollView>

      {/* Bottom bar — alleen de primaire actie (Provision Another / Retry).
          De "terug naar Settings" knop is nu de header back-arrow, dus
          die hoeft hier niet meer te staan. */}
      {allDone && (
        <View style={styles.bottomBar}>
          {!allSuccess && (
            <TouchableOpacity
              style={styles.retryButton}
              onPress={handleRetry}
              activeOpacity={0.7}
            >
              <Ionicons name="refresh" size={18} color={colors.text} />
              <Text style={styles.retryButtonText}>Retry</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.doneButton, !allSuccess && { flex: 1 }]}
            onPress={allSuccess ? handleProvisionAnother : handleBackToSettings}
            activeOpacity={0.7}
          >
            <Text style={styles.doneButtonText}>
              {allSuccess ? 'Provision Another' : 'Back to Settings'}
            </Text>
            <Ionicons name="arrow-forward" size={18} color={colors.white} />
          </TouchableOpacity>
        </View>
      )}
    </View>
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
    paddingBottom: 120,
  },
  header: {
    marginBottom: 24,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: c.text,
  },
  subtitle: {
    fontSize: 15,
    color: c.textDim,
    lineHeight: 22,
  },
  successBanner: {
    alignItems: 'center',
    paddingVertical: 24,
    marginBottom: 24,
  },
  successIconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(34,197,94,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  successTitle: {
    fontSize: 32,
    fontWeight: '800',
    color: c.green,
    marginBottom: 8,
  },
  successSubtitle: {
    fontSize: 15,
    color: c.textDim,
    textAlign: 'center',
    lineHeight: 22,
  },
  deviceCard: {
    backgroundColor: c.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.cardBorder,
    padding: 20,
    marginBottom: 16,
  },
  loraCard: {
    backgroundColor: c.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.cardBorder,
    padding: 16,
    marginBottom: 16,
  },
  loraTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: c.text,
    marginBottom: 2,
  },
  loraSubtitle: {
    fontSize: 12,
    color: c.textDim,
    marginBottom: 12,
    lineHeight: 17,
  },
  loraInputRow: {
    flexDirection: 'row',
    gap: 10,
  },
  loraInputLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: c.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  loraInput: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: c.text,
    fontVariant: ['tabular-nums'],
  },
  loraWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    padding: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.35)',
  },
  loraWarningAcknowledged: {
    backgroundColor: 'rgba(34,197,94,0.1)',
    borderColor: 'rgba(34,197,94,0.3)',
  },
  loraWarningText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: c.amber,
    lineHeight: 16,
  },
  startProvisionBtn: {
    marginTop: 14,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: c.emerald,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  startProvisionText: {
    fontSize: 15,
    fontWeight: '700',
    color: c.text,
  },
  deviceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    gap: 8,
  },
  deviceName: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: c.text,
  },
  successBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(34,197,94,0.15)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    gap: 4,
  },
  successBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: c.green,
  },
  stepsContainer: {
    marginLeft: 4,
  },
  stepRow: {
    position: 'relative',
  },
  stepLine: {
    position: 'absolute',
    left: 9,
    top: -8,
    width: 2,
    height: 8,
  },
  stepLineActive: {
    backgroundColor: c.emerald,
  },
  stepLineInactive: {
    backgroundColor: c.textMuted,
  },
  stepIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    gap: 12,
  },
  stepDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDotCompleted: {
    backgroundColor: c.green,
  },
  stepDotActive: {
    backgroundColor: c.emerald,
  },
  stepDotError: {
    backgroundColor: c.red,
  },
  stepDotPending: {
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: c.textMuted,
  },
  stepPulse: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: c.white,
  },
  stepLabel: {
    fontSize: 14,
  },
  stepLabelCompleted: {
    color: c.green,
    fontWeight: '500',
  },
  stepLabelActive: {
    color: c.emerald,
    fontWeight: '600',
  },
  stepLabelError: {
    color: c.red,
    fontWeight: '500',
  },
  stepLabelPending: {
    color: c.textMuted,
  },
  statusMessage: {
    marginTop: 12,
    fontSize: 13,
    color: c.textDim,
    fontStyle: 'italic',
  },
  otaButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 16,
    paddingVertical: 12,
    paddingHorizontal: 20,
    backgroundColor: c.purple,
    borderRadius: 12,
  },
  otaButtonText: {
    color: c.text,
    fontSize: 14,
    fontWeight: '600',
  },
  otaStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  debugCard: {
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 12,
    padding: 12,
    marginTop: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  debugTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: c.amber,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  debugScroll: {
    maxHeight: 200,
  },
  debugLine: {
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: c.textDim,
    lineHeight: 16,
  },
  onlineStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(34,197,94,0.1)',
    borderRadius: 8,
  },
  otaStatusText: {
    color: c.textDim,
    fontSize: 13,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    paddingHorizontal: 24,
    paddingVertical: 16,
    paddingBottom: 34,
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: c.cardBorder,
    backgroundColor: c.card,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    paddingHorizontal: 20,
    borderRadius: 12,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.cardBorder,
    gap: 6,
  },
  retryButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: c.text,
  },
  doneButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: 12,
    backgroundColor: c.emerald,
    gap: 8,
  },
  doneButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: c.text,
  },
});
