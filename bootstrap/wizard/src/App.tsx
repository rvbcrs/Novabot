import { useState, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import Welcome from './steps/Welcome.tsx';
import FirmwareSelect from './steps/FirmwareSelect.tsx';
import NetworkConfig from './steps/NetworkConfig.tsx';
import DockerSetup from './steps/DockerSetup.tsx';
import WaitForMower from './steps/WaitForMower.tsx';
import OtaConfirm from './steps/OtaConfirm.tsx';
import OtaProgress from './steps/OtaProgress.tsx';
import Done from './steps/Done.tsx';

export type Step = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

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
  serverUrl: string | null;
  otaLog: string[];
  otaStatus: OtaStatus;
  otaProgress: number; // 0–100
  detect: DetectResult | null;
  otaTimedOut: boolean;
}

const STEP_LABELS = [
  'Welkom',
  'Firmware',
  'Netwerk',
  'Docker',
  'Wachten',
  'Bevestigen',
  'Flashen',
  'Klaar',
];

const socket: Socket = io(window.location.origin, {
  transports: ['websocket'],
  reconnectionDelay: 1000,
});

export default function App() {
  const [step, setStep] = useState<Step>(0);
  const [state, setState] = useState<WizardState>({
    firmware: null,
    selectedIp: null,
    mower: null,
    mowerVersion: null,
    serverUrl: null,
    otaLog: [],
    otaStatus: 'downloading',
    otaProgress: 0,
    detect: null,
    otaTimedOut: false,
  });

  useEffect(() => {
    socket.on('mower-connected', (data: MowerInfo) => {
      setState(s => ({ ...s, mower: data }));
      // Auto-advance from "wait for mower" step (now step 4)
      setStep(prev => (prev === 4 ? 5 : prev));
    });

    socket.on('mower-disconnected', () => {
      // Only clear mower if not yet in OTA confirm/progress/done
      setStep(prev => {
        if (prev < 5) setState(s => ({ ...s, mower: null }));
        return prev;
      });
    });

    socket.on('mower-version', (data: { version: string }) => {
      setState(s => ({ ...s, mowerVersion: data.version }));
    });

    socket.on('ota-log', (data: { message: string }) => {
      setState(s => ({ ...s, otaLog: [...s.otaLog, data.message] }));
    });

    socket.on('ota-started', () => {
      setState(s => ({ ...s, otaStatus: 'downloading' }));
      setStep(6);
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
      setStep(7);
      // Auto-open dashboard in a new tab
      window.open(data.url, '_blank', 'noopener,noreferrer');
    });

    socket.on('ota-timeout', () => {
      setState(s => ({ ...s, otaTimedOut: true }));
    });

    return () => {
      socket.off('mower-connected');
      socket.off('mower-disconnected');
      socket.off('mower-version');
      socket.off('ota-log');
      socket.off('ota-started');
      socket.off('ota-download-progress');
      socket.off('mower-rebooting');
      socket.off('server-detected');
      socket.off('ota-timeout');
    };
  }, []);

  // Sync status + detect infrastructure on load
  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then((data: { firmware: FirmwareInfo | null; selectedIp: string | null; mower: MowerInfo | null; mowerVersion: string | null }) => {
        setState(s => ({
          ...s,
          firmware: data.firmware ?? s.firmware,
          selectedIp: data.selectedIp ?? s.selectedIp,
          mower: data.mower ?? s.mower,
          mowerVersion: data.mowerVersion ?? s.mowerVersion,
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
  const next = () => setStep(prev => Math.min(prev + 1, 7) as Step);

  const setFirmware = (fw: FirmwareInfo) => setState(s => ({ ...s, firmware: fw }));
  const setSelectedIp = (ip: string) => setState(s => ({ ...s, selectedIp: ip }));

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-start py-10 px-4">
      {/* Header */}
      <div className="w-full max-w-2xl mb-8">
        <div className="flex items-center gap-3 mb-6">
          <img src="/OpenNova.png" alt="OpenNova" className="h-10 w-auto" />
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-0">
          {STEP_LABELS.map((label, i) => (
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
              {i < STEP_LABELS.length - 1 && (
                <div className={`flex-1 h-0.5 mx-1 mb-4 sm:mb-5 ${i < step ? 'bg-emerald-600' : 'bg-gray-800'}`} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="w-full max-w-2xl">
        {step === 0 && <Welcome onNext={next} />}
        {step === 1 && <FirmwareSelect firmware={state.firmware} onUploaded={fw => { setFirmware(fw); next(); }} />}
        {step === 2 && <NetworkConfig selectedIp={state.selectedIp} detect={state.detect} onSelected={ip => { setSelectedIp(ip); next(); }} />}
        {step === 3 && <DockerSetup selectedIp={state.selectedIp!} socket={socket} onReady={next} />}
        {step === 4 && <WaitForMower mower={state.mower} firmware={state.firmware} detect={state.detect} onConnected={() => goTo(5)} />}
        {step === 5 && (
          <OtaConfirm
            mower={state.mower!}
            firmware={state.firmware!}
            selectedIp={state.selectedIp!}
            mowerVersion={state.mowerVersion}
            onBack={() => goTo(4)}
          />
        )}
        {step === 6 && <OtaProgress log={state.otaLog} mower={state.mower} otaStatus={state.otaStatus} otaProgress={state.otaProgress} otaTimedOut={state.otaTimedOut} />}
        {step === 7 && <Done serverUrl={state.serverUrl} mower={state.mower} />}
      </div>
    </div>
  );
}
