import { useState, useEffect, useMemo } from 'react';
import { io, Socket } from 'socket.io-client';
import Welcome from './steps/Welcome.tsx';
import FirmwareSelect from './steps/FirmwareSelect.tsx';
import NetworkConfig from './steps/NetworkConfig.tsx';
import DockerSetup from './steps/DockerSetup.tsx';
import CloudLogin from './steps/CloudLogin.tsx';
import WaitForMower from './steps/WaitForMower.tsx';
import OtaConfirm from './steps/OtaConfirm.tsx';
import OtaProgress from './steps/OtaProgress.tsx';
import Done from './steps/Done.tsx';
import BleProvision from './steps/BleProvision.tsx';
import { I18nContext, createT, detectLocale, LOCALE_LABELS, type Locale } from './i18n/index.ts';

export type Step = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface FirmwareInfo {
  name: string;
  version: string;
  size: number;
}

export interface MowerInfo {
  sn: string;
  ip: string;
}

export interface OtaResult {
  url: string;
}

export interface DetectResult {
  mqtt: { clientMode: boolean };
  dns: { redirected: boolean; address: string | null };
}

export type OtaStatus = 'downloading' | 'rebooting' | 'waiting';

export interface WizardState {
  firmware: FirmwareInfo | null;
  selectedIp: string | null;
  mower: MowerInfo | null;
  mowerVersion: string | null;
  isCustomFirmware: boolean | null;
  serverUrl: string | null;
  otaLog: string[];
  otaStatus: OtaStatus;
  otaProgress: number; // 0–100
  detect: DetectResult | null;
  otaTimedOut: boolean;
  otaSshRecovery: boolean;
  cloudImported: boolean;
}

const STEP_KEYS = [
  'steps.welcome',
  'steps.firmware',
  'steps.network',
  'steps.docker',
  'steps.account',
  'steps.waiting',
  'steps.confirm',
  'steps.flashing',
  'steps.done',
];

const socket: Socket = io(window.location.origin, {
  transports: ['websocket'],
  reconnectionDelay: 1000,
});

export default function App() {
  const [step, setStep] = useState<Step>(0);
  const [locale, setLocaleState] = useState<Locale>(detectLocale);
  const [state, setState] = useState<WizardState>({
    firmware: null,
    selectedIp: null,
    mower: null,
    mowerVersion: null,
    isCustomFirmware: null,
    serverUrl: null,
    otaLog: [],
    otaStatus: 'downloading',
    otaProgress: 0,
    detect: null,
    otaTimedOut: false,
    otaSshRecovery: false,
    cloudImported: false,
  });

  const t = useMemo(() => createT(locale), [locale]);
  const setLocale = (l: Locale) => {
    setLocaleState(l);
    localStorage.setItem('opennova-locale', l);
  };

  useEffect(() => {
    socket.on('mower-connected', (data: MowerInfo) => {
      setState(s => ({ ...s, mower: data }));
      // Don't auto-advance — let user choose to use this mower or add a new device
    });

    socket.on('mower-disconnected', () => {
      // Only clear mower if not yet in OTA confirm/progress/done
      setStep(prev => {
        if (prev < 6) setState(s => ({ ...s, mower: null }));
        return prev;
      });
    });

    socket.on('mower-version', (data: { version: string }) => {
      setState(s => ({ ...s, mowerVersion: data.version }));
    });

    socket.on('mower-firmware-type', (data: { isCustom: boolean }) => {
      setState(s => ({ ...s, isCustomFirmware: data.isCustom }));
    });

    socket.on('ota-log', (data: { message: string }) => {
      setState(s => ({ ...s, otaLog: [...s.otaLog, data.message] }));
    });

    socket.on('ota-started', () => {
      setState(s => ({ ...s, otaStatus: 'downloading' }));
      setStep(7);
    });

    socket.on('ota-download-progress', (data: { percent: number }) => {
      setState(s => ({ ...s, otaProgress: data.percent }));
    });

    socket.on('mower-rebooting', () => {
      setState(s => ({ ...s, otaStatus: 'rebooting' }));
      // After a moment, transition to 'waiting' (polling for server)
      setTimeout(() => setState(s => ({ ...s, otaStatus: 'waiting' })), 3000);
    });

    socket.on('server-detected', (data: OtaResult) => {
      setState(s => ({ ...s, serverUrl: data.url }));
      setStep(8);
      // Auto-open dashboard in a new tab
      window.open(data.url, '_blank', 'noopener,noreferrer');
    });

    socket.on('ota-timeout', () => {
      setState(s => ({ ...s, otaTimedOut: true }));
    });

    socket.on('ota-ssh-recovery', (data: { active: boolean }) => {
      setState(s => ({ ...s, otaSshRecovery: data.active }));
    });

    return () => {
      socket.off('mower-connected');
      socket.off('mower-disconnected');
      socket.off('mower-version');
      socket.off('mower-firmware-type');
      socket.off('ota-log');
      socket.off('ota-started');
      socket.off('ota-download-progress');
      socket.off('mower-rebooting');
      socket.off('server-detected');
      socket.off('ota-timeout');
      socket.off('ota-ssh-recovery');
    };
  }, []);

  // Sync status + detect infrastructure on load
  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then((data: { firmware: FirmwareInfo | null; selectedIp: string | null; mower: MowerInfo | null; mowerVersion: string | null; isCustomFirmware: boolean | null }) => {
        setState(s => ({
          ...s,
          firmware: data.firmware ?? s.firmware,
          selectedIp: data.selectedIp ?? s.selectedIp,
          mower: data.mower ?? s.mower,
          mowerVersion: data.mowerVersion ?? s.mowerVersion,
          isCustomFirmware: data.isCustomFirmware ?? s.isCustomFirmware,
        }));
      })
      .catch(() => {});

    fetch('/api/detect')
      .then(r => r.json())
      .then((data: DetectResult) => {
        setState(s => ({ ...s, detect: data }));
      })
      .catch(() => {});
  }, []);

  const goTo = (s: Step) => setStep(s);
  const next = () => setStep(prev => Math.min(prev + 1, 8) as Step);

  const setFirmware = (fw: FirmwareInfo) => setState(s => ({ ...s, firmware: fw }));
  const setSelectedIp = (ip: string) => setState(s => ({ ...s, selectedIp: ip }));

  const stepLabels = STEP_KEYS.map(k => t(k));

  return (
    <I18nContext.Provider value={{ locale, t, setLocale }}>
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-start py-10 px-4 relative">
        {/* Background glow blobs — give the glass something to blur over */}
        <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
          <div className="absolute top-[-20%] left-[-20%] w-[70%] h-[70%] bg-emerald-800/40 rounded-full" style={{filter:'blur(100px)'}} />
          <div className="absolute bottom-[-20%] right-[-20%] w-[65%] h-[65%] bg-teal-900/50 rounded-full" style={{filter:'blur(90px)'}} />
          <div className="absolute top-[30%] right-[5%] w-[45%] h-[45%] bg-emerald-700/20 rounded-full" style={{filter:'blur(80px)'}} />
          <div className="absolute top-[55%] left-[0%] w-[35%] h-[35%] bg-teal-800/25 rounded-full" style={{filter:'blur(70px)'}} />
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
                  <span className={`text-xs mt-1 hidden sm:block ${i === step ? 'text-emerald-400' : i < step ? 'text-gray-400' : 'text-gray-600'}`}>
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
          {step === 0 && <Welcome onNext={next} />}
          {step === 1 && <FirmwareSelect firmware={state.firmware} onUploaded={fw => { setFirmware(fw); next(); }} />}
          {step === 2 && <NetworkConfig selectedIp={state.selectedIp} detect={state.detect} onSelected={ip => { setSelectedIp(ip); next(); }} />}
          {step === 3 && <DockerSetup selectedIp={state.selectedIp!} socket={socket} onReady={next} />}
          {step === 4 && <CloudLogin onDone={(imported) => { setState(s => ({ ...s, cloudImported: imported })); goTo(5); }} />}
          {step === 5 && <WaitForMower mower={state.mower} firmware={state.firmware} detect={state.detect} ip={state.selectedIp ?? ''} cloudImported={state.cloudImported} isCustomFirmware={state.isCustomFirmware} socket={socket} onConnected={() => goTo(6)} onAddNewDevice={() => goTo(9)} />}
          {step === 6 && (
            <OtaConfirm
              mower={state.mower!}
              firmware={state.firmware!}
              selectedIp={state.selectedIp!}
              mowerVersion={state.mowerVersion}
              isCustomFirmware={state.isCustomFirmware}
              onBack={() => goTo(5)}
            />
          )}
          {step === 7 && <OtaProgress log={state.otaLog} mower={state.mower} otaStatus={state.otaStatus} otaProgress={state.otaProgress} otaTimedOut={state.otaTimedOut} otaSshRecovery={state.otaSshRecovery} isCustomFirmware={state.isCustomFirmware} />}
          {step === 8 && <Done serverUrl={state.serverUrl} mower={state.mower} onAddDevice={() => goTo(9)} />}
          {step === 9 && <BleProvision selectedIp={state.selectedIp ?? '192.168.0.177'} onDone={() => goTo(5)} />}
        </div>
      </div>
    </I18nContext.Provider>
  );
}
