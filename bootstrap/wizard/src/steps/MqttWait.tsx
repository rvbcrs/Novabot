import { useState, useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import type { DeviceMode } from '../App.tsx';

interface Props {
  deviceMode: DeviceMode;
  chargerConnected: boolean;
  mowerConnected: boolean;
  socket: Socket;
  onNext: () => void;
  onSkip: () => void;
}

export default function MqttWait({ deviceMode, chargerConnected, mowerConnected, socket: _socket, onNext, onSkip }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const [skipEnabled, setSkipEnabled] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  const expectsCharger = deviceMode === 'charger' || deviceMode === 'both';
  const expectsMower = deviceMode === 'mower' || deviceMode === 'both';

  const chargerOk = !expectsCharger || chargerConnected;
  const mowerOk = !expectsMower || mowerConnected;
  const allConnected = chargerOk && mowerOk;

  // Timer for elapsed seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(prev => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Enable skip after 10s
  useEffect(() => {
    const timer = setTimeout(() => setSkipEnabled(true), 10000);
    return () => clearTimeout(timer);
  }, []);

  // Timeout message after 60s
  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), 60000);
    return () => clearTimeout(timer);
  }, []);

  // Auto-advance when all devices connected
  useEffect(() => {
    if (allConnected) {
      const timer = setTimeout(onNext, 1500);
      return () => clearTimeout(timer);
    }
  }, [allConnected, onNext]);

  return (
    <div className="glass-card p-8">
      <h2 className="text-xl font-bold text-white mb-2">Waiting for MQTT Connection</h2>
      <p className="text-gray-400 mb-6 text-sm">
        Waiting for your device(s) to connect to the MQTT broker. After provisioning, they should
        automatically connect within 15-30 seconds.
      </p>

      {/* Status indicators */}
      <div className="space-y-3 mb-6">
        {expectsCharger && (
          <div className={`flex items-center gap-4 p-4 rounded-xl border transition-all ${
            chargerConnected
              ? 'bg-emerald-900/20 border-emerald-700/40'
              : 'bg-gray-800/30 border-gray-700'
          }`}>
            <div className="relative">
              <div className={`w-4 h-4 rounded-full ${chargerConnected ? 'bg-emerald-500' : 'bg-red-500'}`} />
              {!chargerConnected && (
                <div className="absolute inset-0 rounded-full bg-red-500/50 animate-ping" />
              )}
            </div>
            <div className="flex-1">
              <p className="text-white text-sm font-medium">Charger</p>
              <p className={`text-xs ${chargerConnected ? 'text-emerald-400' : 'text-gray-500'}`}>
                {chargerConnected ? 'Connected' : 'Waiting...'}
              </p>
            </div>
            {chargerConnected && <span className="text-emerald-400">{'\u2713'}</span>}
          </div>
        )}

        {expectsMower && (
          <div className={`flex items-center gap-4 p-4 rounded-xl border transition-all ${
            mowerConnected
              ? 'bg-emerald-900/20 border-emerald-700/40'
              : 'bg-gray-800/30 border-gray-700'
          }`}>
            <div className="relative">
              <div className={`w-4 h-4 rounded-full ${mowerConnected ? 'bg-emerald-500' : 'bg-red-500'}`} />
              {!mowerConnected && (
                <div className="absolute inset-0 rounded-full bg-red-500/50 animate-ping" />
              )}
            </div>
            <div className="flex-1">
              <p className="text-white text-sm font-medium">Mower</p>
              <p className={`text-xs ${mowerConnected ? 'text-emerald-400' : 'text-gray-500'}`}>
                {mowerConnected ? 'Connected' : 'Waiting...'}
              </p>
            </div>
            {mowerConnected && <span className="text-emerald-400">{'\u2713'}</span>}
          </div>
        )}
      </div>

      {/* Spinner while waiting */}
      {!allConnected && !timedOut && (
        <div className="flex flex-col items-center gap-3 py-4 mb-6">
          <div className="relative">
            <div className="w-12 h-12 rounded-full bg-gray-800/40 flex items-center justify-center">
              <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            </div>
          </div>
          <p className="text-gray-500 text-xs font-mono">{elapsed}s elapsed</p>
        </div>
      )}

      {/* All connected */}
      {allConnected && (
        <div className="p-4 bg-emerald-900/20 border border-emerald-700/40 rounded-xl mb-6">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">{'\u2713'}</span>
            <p className="text-emerald-300 text-sm font-medium">
              All devices connected! Continuing...
            </p>
          </div>
        </div>
      )}

      {/* Timeout message */}
      {timedOut && !allConnected && (
        <div className="p-4 bg-amber-900/20 border border-amber-700/40 rounded-xl mb-6">
          <p className="text-amber-300 text-sm font-medium mb-2">Taking longer than expected</p>
          <p className="text-amber-400/80 text-xs leading-relaxed">
            Device(s) have not connected after 60 seconds. This could mean:
          </p>
          <ul className="text-amber-400/80 text-xs mt-2 space-y-1 list-disc list-inside">
            <li>WiFi credentials may be incorrect</li>
            <li>The device may be out of WiFi range</li>
            <li>The MQTT broker address may be unreachable from the device</li>
          </ul>
          <p className="text-amber-400/60 text-xs mt-2">
            You can skip this step and check the dashboard later, or go back to fix the WiFi settings.
          </p>
        </div>
      )}

      {/* Skip button */}
      {!allConnected && (
        <button
          onClick={onSkip}
          disabled={!skipEnabled}
          className={`w-full py-3 px-6 rounded-xl font-semibold transition-colors ${
            skipEnabled
              ? 'bg-gray-700 hover:bg-gray-600 text-white'
              : 'bg-gray-800 text-gray-600 cursor-not-allowed'
          }`}
        >
          {skipEnabled ? 'Skip & Continue' : `Skip available in ${Math.max(0, 10 - elapsed)}s`}
        </button>
      )}
    </div>
  );
}
