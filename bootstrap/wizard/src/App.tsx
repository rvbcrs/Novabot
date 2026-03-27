import { useState, useEffect, useMemo, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { I18nContext, createT, detectLocale, LOCALE_LABELS, type Locale } from './i18n/index.ts';

// ── Step components ──────────────────────────────────────────────────────────

import Settings from './steps/Settings.tsx';
import DeviceChoice from './steps/DeviceChoice.tsx';
import FirmwareSelect from './steps/FirmwareSelect2.tsx';
import WifiConfig from './steps/WifiConfig.tsx';
import BleScan from './steps/BleScan.tsx';
import BleProvision from './steps/BleProvision2.tsx';
import MqttWait from './steps/MqttWait.tsx';
import OtaFlash from './steps/OtaFlash.tsx';
import Done from './steps/Done2.tsx';

// ── Types ─────────────────────────────────────────────────────────────────────

export type Step = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type DeviceMode = 'charger' | 'mower' | 'both';

export interface FirmwareInfo {
  name: string;
  version: string;
  size: number;
}

export interface MowerInfo {
  sn: string;
  ip: string;
}

export interface BleDevice {
  id: string;
  name: string;
  rssi: number;
  type: 'charger' | 'mower';
}

export type OtaStatus = 'idle' | 'downloading' | 'rebooting' | 'waiting' | 'done';

// Legacy type kept for backward compatibility with old step files
export interface DetectResult {
  dns: { redirected: boolean; address?: string };
  mqtt: { clientMode: boolean };
}

export interface WizardState {
  // Settings
  mqttAddr: string;
  mqttPort: number;
  // Device choice
  deviceMode: DeviceMode | null;
  // Firmware
  chargerFirmware: FirmwareInfo | null;
  mowerFirmware: FirmwareInfo | null;
  // WiFi
  wifiSsid: string;
  wifiPassword: string;
  // BLE
  selectedDevices: BleDevice[];
  alreadyConnectedDevices: string[]; // device IDs already on MQTT
  // MQTT connectivity
  chargerConnected: boolean;
  mowerConnected: boolean;
  mower: MowerInfo | null;
  // OTA
  otaLog: string[];
  otaStatus: OtaStatus;
  otaProgress: number; // 0-100
}

const STEP_KEYS = [
  'steps.settings',
  'steps.device',
  'steps.firmware',
  'steps.wifi',
  'steps.bleScan',
  'steps.bleProvision',
  'steps.mqttWait',
  'steps.ota',
  'steps.done',
];

const STEP_LABELS_FALLBACK = [
  'Settings',
  'Device',
  'Firmware',
  'WiFi',
  'BLE Scan',
  'Provision',
  'MQTT',
  'OTA',
  'Done',
];

// ── localStorage helpers ──────────────────────────────────────────────────────

function loadSetting(key: string, fallback: string): string {
  return localStorage.getItem(`opennova-${key}`) ?? fallback;
}

function saveSetting(key: string, value: string): void {
  localStorage.setItem(`opennova-${key}`, value);
}

// ── Socket.io ─────────────────────────────────────────────────────────────────

const socket: Socket = io(window.location.origin, {
  transports: ['websocket'],
  reconnectionDelay: 1000,
});

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [step, setStep] = useState<Step>(0);
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const [state, setState] = useState<WizardState>({
    mqttAddr: loadSetting('mqtt-addr', '192.168.0.177'),
    mqttPort: parseInt(loadSetting('mqtt-port', '1883'), 10),
    deviceMode: null,
    chargerFirmware: null,
    mowerFirmware: null,
    wifiSsid: loadSetting('wifi-ssid', ''),
    wifiPassword: '',
    selectedDevices: [],
    alreadyConnectedDevices: [],
    chargerConnected: false,
    mowerConnected: false,
    mower: null,
    otaLog: [],
    otaStatus: 'idle',
    otaProgress: 0,
  });

  const t = useMemo(() => createT(locale), [locale]);
  const setLocale = (l: Locale) => {
    setLocaleState(l);
    localStorage.setItem('opennova-locale', l);
  };

  // ── State updaters ────────────────────────────────────────────────────────

  const setMqttAddr = useCallback((v: string) => {
    setState(s => ({ ...s, mqttAddr: v }));
    saveSetting('mqtt-addr', v);
  }, []);

  const setMqttPort = useCallback((v: number) => {
    setState(s => ({ ...s, mqttPort: v }));
    saveSetting('mqtt-port', String(v));
  }, []);

  const setDeviceMode = useCallback((mode: DeviceMode) => {
    setState(s => ({ ...s, deviceMode: mode }));
  }, []);

  const setWifiSsid = useCallback((v: string) => {
    setState(s => ({ ...s, wifiSsid: v }));
    saveSetting('wifi-ssid', v);
  }, []);

  const setWifiPassword = useCallback((v: string) => {
    setState(s => ({ ...s, wifiPassword: v }));
  }, []);

  const setFirmware = useCallback((type: 'charger' | 'mower', fw: FirmwareInfo) => {
    setState(s => ({
      ...s,
      ...(type === 'charger' ? { chargerFirmware: fw } : { mowerFirmware: fw }),
    }));
  }, []);

  const setSelectedDevices = useCallback((devices: BleDevice[]) => {
    setState(s => ({ ...s, selectedDevices: devices }));
  }, []);

  const setAlreadyConnected = useCallback((ids: string[]) => {
    setState(s => ({ ...s, alreadyConnectedDevices: ids }));
  }, []);

  // ── Socket.io events ──────────────────────────────────────────────────────

  useEffect(() => {
    socket.on('mower-connected', (data: MowerInfo) => {
      setState(s => ({ ...s, mower: data, mowerConnected: true }));
    });

    socket.on('mower-disconnected', () => {
      setState(s => ({ ...s, mowerConnected: false }));
    });

    socket.on('charger-connected', () => {
      setState(s => ({ ...s, chargerConnected: true }));
    });

    socket.on('charger-disconnected', () => {
      setState(s => ({ ...s, chargerConnected: false }));
    });

    socket.on('ota-log', (data: { message: string }) => {
      setState(s => ({ ...s, otaLog: [...s.otaLog, data.message] }));
    });

    socket.on('ota-started', () => {
      setState(s => ({ ...s, otaStatus: 'downloading', otaProgress: 0 }));
    });

    socket.on('ota-download-progress', (data: { percent: number }) => {
      setState(s => ({ ...s, otaProgress: data.percent }));
    });

    socket.on('mower-rebooting', () => {
      setState(s => ({ ...s, otaStatus: 'rebooting' }));
      setTimeout(() => setState(s => ({ ...s, otaStatus: 'waiting' })), 3000);
    });

    socket.on('ota-complete', () => {
      setState(s => ({ ...s, otaStatus: 'done' }));
    });

    socket.on('server-detected', () => {
      setState(s => ({ ...s, otaStatus: 'done' }));
    });

    return () => {
      socket.off('mower-connected');
      socket.off('mower-disconnected');
      socket.off('charger-connected');
      socket.off('charger-disconnected');
      socket.off('ota-log');
      socket.off('ota-started');
      socket.off('ota-download-progress');
      socket.off('mower-rebooting');
      socket.off('ota-complete');
      socket.off('server-detected');
    };
  }, []);

  // ── Navigation ────────────────────────────────────────────────────────────

  const goTo = (s: Step) => setStep(s);

  const next = useCallback(() => {
    setStep(prev => {
      const nextStep = (prev + 1) as Step;

      // Smart skipping logic
      switch (nextStep) {
        case 7: {
          // Skip OTA if no firmware was uploaded
          const hasFirmware = state.deviceMode === 'charger'
            ? !!state.chargerFirmware
            : state.deviceMode === 'mower'
            ? !!state.mowerFirmware
            : !!(state.chargerFirmware || state.mowerFirmware);
          if (!hasFirmware) return 8 as Step;
          break;
        }
        case 6: {
          // Skip MQTT wait if device(s) already connected
          const chargerOk = state.deviceMode !== 'charger' && state.deviceMode !== 'both' || state.chargerConnected;
          const mowerOk = state.deviceMode !== 'mower' && state.deviceMode !== 'both' || state.mowerConnected;
          if (chargerOk && mowerOk) return 7 as Step;
          break;
        }
      }

      return Math.min(nextStep, 8) as Step;
    });
  }, [state.deviceMode, state.chargerFirmware, state.mowerFirmware, state.chargerConnected, state.mowerConnected]);

  const resetForNewDevice = useCallback(() => {
    setState(s => ({
      ...s,
      deviceMode: null,
      chargerFirmware: null,
      mowerFirmware: null,
      selectedDevices: [],
      alreadyConnectedDevices: [],
      otaLog: [],
      otaStatus: 'idle',
      otaProgress: 0,
    }));
    goTo(1);
  }, []);

  const openDashboard = useCallback(() => {
    const url = `http://${state.mqttAddr.split(':')[0]}:3000`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [state.mqttAddr]);

  // ── Step labels ───────────────────────────────────────────────────────────

  const stepLabels = STEP_KEYS.map((k, i) => {
    const translated = t(k);
    // If i18n key is missing (returns the key itself), use fallback
    return translated === k ? STEP_LABELS_FALLBACK[i] : translated;
  });

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <I18nContext.Provider value={{ locale, t, setLocale }}>
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-start py-10 px-4 relative">
        {/* Background glow blobs */}
        <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
          <div className="absolute top-[-20%] left-[-20%] w-[70%] h-[70%] bg-emerald-800/40 rounded-full" style={{ filter: 'blur(100px)' }} />
          <div className="absolute bottom-[-20%] right-[-20%] w-[65%] h-[65%] bg-teal-900/50 rounded-full" style={{ filter: 'blur(90px)' }} />
          <div className="absolute top-[30%] right-[5%] w-[45%] h-[45%] bg-emerald-700/20 rounded-full" style={{ filter: 'blur(80px)' }} />
          <div className="absolute top-[55%] left-[0%] w-[35%] h-[35%] bg-teal-800/25 rounded-full" style={{ filter: 'blur(70px)' }} />
        </div>

        {/* Header */}
        <div className="w-full max-w-2xl mb-8 relative z-10">
          <div className="flex items-center justify-between mb-6">
            <img src="/OpenNova.png" alt="OpenNova" className="h-10 w-auto" />
            {/* Language selector */}
            <div className="flex gap-1">
              {(Object.keys(LOCALE_LABELS) as Locale[]).map(l => (
                <button
                  key={l}
                  onClick={() => setLocale(l)}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    l === locale
                      ? 'bg-emerald-700 text-white'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Step indicator */}
          <div className="flex items-center gap-0">
            {stepLabels.map((label, i) => (
              <div key={i} className="flex items-center flex-1 last:flex-none">
                <div className="flex flex-col items-center">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
                      i < step
                        ? 'bg-emerald-600 text-white'
                        : i === step
                        ? 'bg-emerald-700 text-white ring-2 ring-emerald-500 ring-offset-2 ring-offset-gray-950'
                        : 'bg-gray-800 text-gray-500'
                    }`}
                  >
                    {i < step ? '\u2713' : i + 1}
                  </div>
                  <span className={`text-xs mt-1 hidden sm:block whitespace-nowrap ${
                    i === step ? 'text-emerald-400' : i < step ? 'text-gray-400' : 'text-gray-600'
                  }`}>
                    {label}
                  </span>
                </div>
                {i < stepLabels.length - 1 && (
                  <div className={`flex-1 h-0.5 mx-1 mb-4 sm:mb-5 ${i < step ? 'bg-emerald-600' : 'bg-gray-800'}`} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="w-full max-w-2xl relative z-10">
          {step === 0 && (
            <Settings
              mqttAddr={state.mqttAddr}
              mqttPort={state.mqttPort}
              onChangeAddr={setMqttAddr}
              onChangePort={setMqttPort}
              onNext={next}
            />
          )}

          {step === 1 && (
            <DeviceChoice
              onSelect={(mode) => { setDeviceMode(mode); next(); }}
            />
          )}

          {step === 2 && (
            <FirmwareSelect
              deviceMode={state.deviceMode!}
              onUploaded={setFirmware}
              onNext={next}
              onSkip={next}
            />
          )}

          {step === 3 && (
            <WifiConfig
              wifiSsid={state.wifiSsid}
              wifiPassword={state.wifiPassword}
              onChangeSsid={setWifiSsid}
              onChangePassword={setWifiPassword}
              onNext={next}
            />
          )}

          {step === 4 && (
            <BleScan
              deviceMode={state.deviceMode!}
              socket={socket}
              onDeviceSelected={setSelectedDevices}
              onAlreadyConnected={setAlreadyConnected}
              onNext={next}
            />
          )}

          {step === 5 && (
            <BleProvision
              deviceMode={state.deviceMode!}
              selectedDevices={state.selectedDevices}
              wifiSsid={state.wifiSsid}
              wifiPassword={state.wifiPassword}
              mqttAddr={state.mqttAddr}
              mqttPort={state.mqttPort}
              socket={socket}
              onNext={next}
            />
          )}

          {step === 6 && (
            <MqttWait
              deviceMode={state.deviceMode!}
              chargerConnected={state.chargerConnected}
              mowerConnected={state.mowerConnected}
              socket={socket}
              onNext={next}
              onSkip={next}
            />
          )}

          {step === 7 && (
            <OtaFlash
              deviceMode={state.deviceMode!}
              chargerFirmware={state.chargerFirmware}
              mowerFirmware={state.mowerFirmware}
              socket={socket}
              otaLog={state.otaLog}
              otaStatus={state.otaStatus}
              otaProgress={state.otaProgress}
              onNext={next}
            />
          )}

          {step === 8 && (
            <Done
              deviceMode={state.deviceMode!}
              chargerConnected={state.chargerConnected}
              mowerConnected={state.mowerConnected}
              chargerFirmware={state.chargerFirmware}
              mowerFirmware={state.mowerFirmware}
              onAddAnother={resetForNewDevice}
              onDashboard={openDashboard}
            />
          )}
        </div>
      </div>
    </I18nContext.Provider>
  );
}
