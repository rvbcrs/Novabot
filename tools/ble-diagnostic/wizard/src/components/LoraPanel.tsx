import { useT } from '../i18n';
import type { DiagnosticData } from './RadioDashboard';

interface Props {
  data: DiagnosticData;
  deviceType: 'charger' | 'mower' | 'unknown';
}

export default function LoraPanel({ data, deviceType }: Props) {
  const { t } = useT();

  // BLE data (charger), MQTT data (mower)
  const bleLora = data.lora;
  const mqttLora = data.mqttLora;
  const lora = bleLora || mqttLora;
  const source = bleLora ? t('lora.viaBle') : mqttLora ? t('lora.viaMqtt') : null;

  return (
    <div className="glass-card p-4">
      <div className="relative z-10">
        <h3 className="text-sm font-semibold text-white/60 mb-3 flex items-center gap-2">
          <span className="text-base">📡</span>
          {t('lora.title')}
          {source && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/30">{source}</span>
          )}
        </h3>

        {lora ? (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-white/40">{t('lora.address')}</div>
              <div className="text-xl font-mono font-bold text-orange-400">{lora.addr ?? '—'}</div>
            </div>
            <div>
              <div className="text-xs text-white/40">{t('lora.channel')}</div>
              <div className="text-xl font-mono font-bold text-orange-400">{lora.channel ?? '—'}</div>
            </div>
            <div>
              <div className="text-xs text-white/40">{t('lora.hc')}</div>
              <div className="text-lg font-mono text-white/70">{lora.hc ?? '—'}</div>
            </div>
            <div>
              <div className="text-xs text-white/40">{t('lora.lc')}</div>
              <div className="text-lg font-mono text-white/70">{lora.lc ?? '—'}</div>
            </div>
          </div>
        ) : (
          <div className="text-white/30 text-sm">
            <p>LoRa info not available via BLE. Use the MQTT panel below to query.</p>
          </div>
        )}
      </div>
    </div>
  );
}
