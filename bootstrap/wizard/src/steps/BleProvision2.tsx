import { useState, useEffect, useCallback } from 'react';
import type { Socket } from 'socket.io-client';
import type { DeviceMode, BleDevice } from '../App.tsx';

interface Props {
  deviceMode: DeviceMode;
  selectedDevices: BleDevice[];
  wifiSsid: string;
  wifiPassword: string;
  mqttAddr: string;
  mqttPort: number;
  socket: Socket;
  onNext: () => void;
}

type StepStatus = 'pending' | 'active' | 'done' | 'error';

interface ProvisionStep {
  key: string;
  label: string;
  status: StepStatus;
}

interface DeviceProgress {
  deviceId: string;
  deviceName: string;
  deviceType: 'charger' | 'mower';
  phase: string;
  error: string | null;
  steps: ProvisionStep[];
  done: boolean;
}

const BLE_STEP_DEFS = [
  { key: 'connecting', phases: ['requesting', 'connecting'], label: 'Connecting to device' },
  { key: 'discovering', phases: ['discovering', 'handshake'], label: 'Discovering services' },
  { key: 'wifi', phases: ['wifi'], label: 'Sending WiFi credentials' },
  { key: 'config', phases: ['rtk', 'lora'], label: 'Configuring device' },
  { key: 'mqtt', phases: ['mqtt'], label: 'Sending MQTT settings' },
  { key: 'commit', phases: ['commit'], label: 'Saving configuration' },
];

function buildSteps(): ProvisionStep[] {
  return BLE_STEP_DEFS.map(d => ({ key: d.key, label: d.label, status: 'pending' as StepStatus }));
}

function updateStepsForPhase(steps: ProvisionStep[], phase: string): ProvisionStep[] {
  // Find which step this phase belongs to
  const activeIdx = BLE_STEP_DEFS.findIndex(d => d.phases.includes(phase));
  if (activeIdx === -1) return steps; // Unknown phase — don't change anything

  // 'done' phase = mark everything as done
  if (phase === 'done') {
    return steps.map(s => ({ ...s, status: 'done' as StepStatus }));
  }

  return steps.map((step, i) => {
    if (i < activeIdx) return { ...step, status: 'done' as StepStatus };
    if (i === activeIdx) return { ...step, status: 'active' as StepStatus };
    return { ...step, status: step.status === 'done' ? 'done' : 'pending' as StepStatus };
  });
}

export default function BleProvision2({ selectedDevices, wifiSsid, wifiPassword, mqttAddr, mqttPort, socket, onNext }: Props) {
  const [deviceProgress, setDeviceProgress] = useState<DeviceProgress[]>(() =>
    selectedDevices.map(d => ({
      deviceId: d.id,
      deviceName: d.name,
      deviceType: d.type,
      phase: 'idle',
      error: null,
      steps: buildSteps(),
      done: false,
    }))
  );
  const [currentDeviceIdx, setCurrentDeviceIdx] = useState(0);
  const [allDone, setAllDone] = useState(false);
  const [retryAvailable, setRetryAvailable] = useState(false);

  // Listen for ble-progress events
  useEffect(() => {
    const onProgress = (data: { phase: string; message?: string; error?: string; deviceId?: string }) => {
      setDeviceProgress(prev => {
        return prev.map((dp, idx) => {
          // Match by deviceId if provided, otherwise use currentDeviceIdx
          if (data.deviceId ? dp.deviceId !== data.deviceId : idx !== currentDeviceIdx) return dp;

          if (data.error) {
            return {
              ...dp,
              phase: 'error',
              error: data.error,
              steps: dp.steps.map(s =>
                s.status === 'active' ? { ...s, status: 'error' as StepStatus } : s
              ),
            };
          }

          if (data.phase === 'done') {
            return {
              ...dp,
              phase: 'done',
              error: null,
              done: true,
              steps: dp.steps.map(s => ({ ...s, status: 'done' as StepStatus })),
            };
          }

          return {
            ...dp,
            phase: data.phase,
            error: null,
            steps: updateStepsForPhase(dp.steps, data.phase),
          };
        });
      });
    };

    socket.on('ble-progress', onProgress);
    return () => { socket.off('ble-progress', onProgress); };
  }, [socket, currentDeviceIdx]);

  // Start provisioning current device
  const provisionDevice = useCallback(async (idx: number) => {
    if (idx >= selectedDevices.length) return;

    const device = selectedDevices[idx];
    setCurrentDeviceIdx(idx);
    setRetryAvailable(false);

    // Reset progress for this device
    setDeviceProgress(prev => prev.map((dp, i) =>
      i === idx ? { ...dp, phase: 'connecting', error: null, steps: buildSteps(), done: false } : dp
    ));

    try {
      const res = await fetch('/api/ble/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mac: device.id,
          wifiSsid,
          wifiPassword,
          mqttAddr,
          mqttPort,
          deviceType: device.type,
        }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok && data.error) {
        setDeviceProgress(prev => prev.map((dp, i) =>
          i === idx ? { ...dp, phase: 'error', error: data.error ?? 'Unknown error' } : dp
        ));
        setRetryAvailable(true);
      }
    } catch (err) {
      setDeviceProgress(prev => prev.map((dp, i) =>
        i === idx ? { ...dp, phase: 'error', error: err instanceof Error ? err.message : 'Connection error' } : dp
      ));
      setRetryAvailable(true);
    }
  }, [selectedDevices, wifiSsid, wifiPassword, mqttAddr, mqttPort]);

  // Start first device on mount
  useEffect(() => {
    if (selectedDevices.length > 0) {
      provisionDevice(0);
    }
  }, []);

  // When a device finishes, start the next one
  useEffect(() => {
    const currentDp = deviceProgress[currentDeviceIdx];
    if (!currentDp?.done) return;

    const nextIdx = currentDeviceIdx + 1;
    if (nextIdx < selectedDevices.length) {
      // Small delay before starting next device
      const timer = setTimeout(() => provisionDevice(nextIdx), 1000);
      return () => clearTimeout(timer);
    } else {
      // All done
      setAllDone(true);
    }
  }, [deviceProgress, currentDeviceIdx, selectedDevices.length, provisionDevice]);

  // Auto-advance when all devices are done
  useEffect(() => {
    if (!allDone) return;
    const timer = setTimeout(onNext, 2000);
    return () => clearTimeout(timer);
  }, [allDone, onNext]);

  const hasError = deviceProgress.some(dp => dp.phase === 'error');

  return (
    <div className="glass-card p-8">
      <h2 className="text-xl font-bold text-white mb-2">BLE Provisioning</h2>
      <p className="text-gray-400 mb-6 text-sm">
        Configuring your device(s) via Bluetooth. Please keep them powered on and in range.
      </p>

      <div className="space-y-6 mb-6">
        {deviceProgress.map((dp, idx) => (
          <div
            key={dp.deviceId}
            className={`p-5 rounded-xl border transition-all ${
              dp.done
                ? 'bg-emerald-900/20 border-emerald-700/40'
                : dp.phase === 'error'
                ? 'bg-red-900/20 border-red-700/40'
                : idx === currentDeviceIdx
                ? 'bg-gray-800/40 border-gray-600'
                : 'bg-gray-800/20 border-gray-800 opacity-50'
            }`}
          >
            {/* Device header */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                {dp.done && <span className="text-emerald-400">{'\u2713'}</span>}
                {dp.phase === 'error' && <span className="text-red-400">{'\u2717'}</span>}
                {!dp.done && dp.phase !== 'error' && idx === currentDeviceIdx && (
                  <div className="w-4 h-4 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
                )}
                <span className="text-white font-medium text-sm">{dp.deviceName}</span>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                dp.deviceType === 'charger'
                  ? 'bg-amber-900/40 text-amber-400'
                  : 'bg-emerald-900/40 text-emerald-400'
              }`}>
                {dp.deviceType === 'charger' ? 'Charger' : 'Mower'}
              </span>
            </div>

            {/* Steps */}
            <div className="space-y-1.5">
              {dp.steps.filter(s => s.key !== 'done').map(step => (
                <div key={step.key} className="flex items-center gap-2 text-sm">
                  {step.status === 'done' && <span className="text-emerald-400 w-4 text-center">{'\u2713'}</span>}
                  {step.status === 'active' && <span className="text-blue-400 w-4 text-center animate-pulse">{'\u25CF'}</span>}
                  {step.status === 'error' && <span className="text-red-400 w-4 text-center">{'\u2717'}</span>}
                  {step.status === 'pending' && <span className="text-gray-600 w-4 text-center">{'\u25CB'}</span>}
                  <span className={
                    step.status === 'done' ? 'text-gray-400' :
                    step.status === 'active' ? 'text-blue-300' :
                    step.status === 'error' ? 'text-red-300' :
                    'text-gray-600'
                  }>
                    {step.label}
                  </span>
                </div>
              ))}
            </div>

            {/* Error message */}
            {dp.error && (
              <div className="mt-3 p-3 bg-red-900/20 border border-red-800/30 rounded-lg">
                <p className="text-red-300 text-sm">{dp.error}</p>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Success message */}
      {allDone && (
        <div className="p-4 bg-emerald-900/20 border border-emerald-700/40 rounded-xl mb-4">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">{'\u2713'}</span>
            <p className="text-emerald-300 text-sm font-medium">
              All devices provisioned successfully! Continuing...
            </p>
          </div>
        </div>
      )}

      {/* Retry / Continue buttons */}
      <div className="flex gap-3">
        {hasError && retryAvailable && (
          <button
            onClick={() => provisionDevice(currentDeviceIdx)}
            className="flex-1 py-3 px-6 bg-gray-700 hover:bg-gray-600 text-white font-semibold rounded-xl transition-colors"
          >
            Retry
          </button>
        )}
        {(hasError || allDone) && (
          <button
            onClick={onNext}
            className="flex-1 py-3 px-6 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors"
          >
            {allDone ? 'Continue' : 'Skip & Continue'}
          </button>
        )}
      </div>
    </div>
  );
}
