import { useEffect, useState } from 'react';
import type { DetectResult, FirmwareInfo, MowerInfo } from '../App.tsx';
import { useT } from '../i18n/index.ts';

interface Props {
  mower: MowerInfo | null;
  firmware: FirmwareInfo | null;
  detect: DetectResult | null;
  onConnected: () => void;
}

export default function WaitForMower({ mower, firmware, detect, onConnected }: Props) {
  const { t } = useT();
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
      const timer = setTimeout(onConnected, 800);
      return () => clearTimeout(timer);
    }
  }, [mower, onConnected]);

  return (
    <div className="glass-card p-8">
      <h2 className="text-xl font-bold text-white mb-2">{t('wait.title')}</h2>
      <p className="text-gray-400 mb-8 text-sm">
        {t('wait.description')}
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

          <p className="text-gray-400 text-lg font-mono">{t('wait.waiting')}{dots}</p>

          <div className="space-y-2 text-sm text-gray-500 text-center">
            <p>{t('wait.mqttActive')}</p>
            <p>{t('wait.instruction')}</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 py-8">
          <div className="w-20 h-20 rounded-full bg-emerald-900/40 border-2 border-emerald-500 flex items-center justify-center overflow-hidden">
            <img src="/OpenNova.png" alt="OpenNova" className="w-16 h-16 object-contain" />
          </div>
          <div className="text-center">
            <p className="text-emerald-400 font-semibold text-lg">{t('wait.found')}</p>
            <p className="text-gray-300 font-mono text-sm mt-1">{mower.sn}</p>
            <p className="text-gray-500 text-xs">{mower.ip}</p>
          </div>
        </div>
      )}

      <div className="mt-6 p-4 bg-gray-800/40 rounded-xl">
        <p className="text-gray-500 text-xs font-medium uppercase tracking-wide mb-2">{t('wait.statusTitle')}</p>
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">✓</span>
            <span className="text-gray-300">
              MQTT {existingBroker
                ? <span className="text-blue-400">({t('wait.mqttSubscriber').replace('MQTT ', '')})</span>
                : `(${t('wait.mqttBroker').replace('MQTT ', '')})`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">✓</span>
            <span className="text-gray-300">{t('wait.httpServer')}</span>
          </div>
          <div className="flex items-center gap-2">
            {firmware ? <span className="text-emerald-400">✓</span> : <span className="text-yellow-400">○</span>}
            <span className="text-gray-300">
              {firmware ? t('wait.firmwareLoaded', { version: firmware.version }) : t('wait.firmwareNone')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {mower ? <span className="text-emerald-400">✓</span> : <span className="text-gray-600">○</span>}
            <span className="text-gray-300">
              {mower ? t('wait.mowerConnected', { sn: mower.sn }) : <span className="text-gray-600">{t('wait.mowerNone').replace('Mower: ', '').replace('Maaier: ', '').replace('Tondeuse : ', '')}</span>}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
