import { useEffect, useState } from 'react';
import type { DetectResult, FirmwareInfo, MowerInfo } from '../App.tsx';

interface Props {
  mower: MowerInfo | null;
  firmware: FirmwareInfo | null;
  detect: DetectResult | null;
  onConnected: () => void;
}

export default function WaitForMower({ mower, firmware, detect, onConnected }: Props) {
  const existingBroker = detect?.mqtt.clientMode ?? false;
  const [dots, setDots] = useState('');

  useEffect(() => {
    const interval = setInterval(() => {
      setDots(d => d.length >= 3 ? '' : d + '.');
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // Auto-advance if mower already connected when this step mounts
  useEffect(() => {
    if (mower) {
      const t = setTimeout(onConnected, 800);
      return () => clearTimeout(t);
    }
  }, [mower, onConnected]);

  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-8">
      <h2 className="text-xl font-bold text-white mb-2">Wachten op maaier</h2>
      <p className="text-gray-400 mb-8 text-sm">
        Zet je maaier aan. De MQTT broker luistert op poort 1883. Zodra de maaier verbindt
        gaat de wizard automatisch verder.
      </p>

      {!mower ? (
        <div className="flex flex-col items-center gap-6 py-8">
          {/* Animated pulse ring */}
          <div className="relative">
            <div className="w-20 h-20 rounded-full bg-emerald-900/30 flex items-center justify-center overflow-hidden">
              <img src="/OpenNova.png" alt="OpenNova" className="w-16 h-16 object-contain" />
            </div>
            <div className="absolute inset-0 rounded-full border-2 border-emerald-500/50 animate-ping" />
          </div>

          <p className="text-gray-400 text-lg font-mono">Wachten{dots}</p>

          <div className="space-y-2 text-sm text-gray-500 text-center">
            <p>MQTT broker actief op poort 1883</p>
            <p>Zet de maaier aan en controleer WiFi-verbinding</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 py-8">
          <div className="w-20 h-20 rounded-full bg-emerald-900/40 border-2 border-emerald-500 flex items-center justify-center overflow-hidden">
            <img src="/OpenNova.png" alt="OpenNova" className="w-16 h-16 object-contain" />
          </div>
          <div className="text-center">
            <p className="text-emerald-400 font-semibold text-lg">Maaier gevonden!</p>
            <p className="text-gray-300 font-mono text-sm mt-1">{mower.sn}</p>
            <p className="text-gray-500 text-xs">{mower.ip}</p>
          </div>
        </div>
      )}

      <div className="mt-6 p-4 bg-gray-800/40 rounded-xl">
        <p className="text-gray-500 text-xs font-medium uppercase tracking-wide mb-2">Status</p>
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">✓</span>
            <span className="text-gray-300">
              MQTT {existingBroker
                ? <span className="text-blue-400">(bestaande broker, subscriber-mode)</span>
                : '(broker, poort 1883)'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">✓</span>
            <span className="text-gray-300">HTTP server (poort 7789)</span>
          </div>
          <div className="flex items-center gap-2">
            {firmware ? <span className="text-emerald-400">✓</span> : <span className="text-yellow-400">○</span>}
            <span className="text-gray-300">
              Firmware: {firmware ? <span className="text-emerald-400">{firmware.version}</span> : 'niet geladen'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {mower ? <span className="text-emerald-400">✓</span> : <span className="text-gray-600">○</span>}
            <span className="text-gray-300">
              Maaier: {mower ? <span className="text-emerald-400">{mower.sn}</span> : <span className="text-gray-600">niet verbonden</span>}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
