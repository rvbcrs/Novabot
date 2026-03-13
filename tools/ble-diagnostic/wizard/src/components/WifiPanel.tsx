import { useT } from '../i18n';
import type { DiagnosticData } from './RadioDashboard';

interface Props {
  data: DiagnosticData;
}

export default function WifiPanel({ data }: Props) {
  const { t } = useT();

  const rssi = data.wifiRssi?.wifi ?? data.wifi?.rssi;
  const hasData = rssi !== undefined;

  const getRssiColor = (value: number) => {
    if (value >= -50) return 'text-green-400';
    if (value >= -70) return 'text-yellow-400';
    return 'text-red-400';
  };

  const getRssiLabel = (value: number) => {
    if (value >= -50) return 'Excellent';
    if (value >= -60) return 'Good';
    if (value >= -70) return 'Fair';
    return 'Poor';
  };

  const getRssiBarWidth = (value: number) => {
    // Map -100 to 0 → 0% to 100%
    return Math.max(0, Math.min(100, (value + 100)));
  };

  return (
    <div className="glass-card p-4">
      <div className="relative z-10">
        <h3 className="text-sm font-semibold text-white/60 mb-3 flex items-center gap-2">
          <span className="text-base">📶</span>
          {t('wifi.title')}
        </h3>

        {hasData ? (
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-white/40">{t('wifi.rssi')}</span>
              <span className={`text-2xl font-mono font-bold ${getRssiColor(rssi!)}`}>
                {rssi}
                <span className="text-xs ml-0.5">dBm</span>
              </span>
            </div>
            <div className="w-full bg-white/5 rounded-full h-1.5">
              <div
                className={`h-1.5 rounded-full transition-all ${
                  rssi! >= -50 ? 'bg-green-400' : rssi! >= -70 ? 'bg-yellow-400' : 'bg-red-400'
                }`}
                style={{ width: `${getRssiBarWidth(rssi!)}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-white/30">
              <span>{t('wifi.status')}</span>
              <span className={getRssiColor(rssi!)}>{getRssiLabel(rssi!)}</span>
            </div>
          </div>
        ) : (
          <p className="text-white/30 text-sm">{t('wifi.noData')}</p>
        )}
      </div>
    </div>
  );
}
