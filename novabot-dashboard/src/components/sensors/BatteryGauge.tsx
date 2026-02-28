import { Battery, BatteryCharging, BatteryLow, BatteryFull } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  percentage: number;
  state?: string;
}

export function BatteryGauge({ percentage, state }: Props) {
  const { t } = useTranslation();
  const color =
    percentage > 50 ? 'bg-green-500' :
    percentage > 20 ? 'bg-yellow-500' :
    'bg-red-500';

  const isCharging = state?.toUpperCase() === 'CHARGING';

  const Icon = isCharging ? BatteryCharging
    : percentage > 80 ? BatteryFull
    : percentage < 20 ? BatteryLow
    : Battery;

  const iconColor = isCharging ? 'text-yellow-400'
    : percentage > 50 ? 'text-green-400'
    : percentage > 20 ? 'text-yellow-400'
    : 'text-red-400';

  return (
    <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon className={`w-5 h-5 ${iconColor}`} />
          <span className="text-sm text-gray-400">{t('battery.title')}</span>
        </div>
        {state && (
          <span className="text-xs text-gray-500 bg-gray-700/50 px-2 py-0.5 rounded">
            {state}
          </span>
        )}
      </div>
      <div className="flex items-end gap-3">
        <span className="text-3xl font-bold text-white">{percentage}%</span>
      </div>
      <div className="mt-3 h-2 bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full ${color} rounded-full transition-all duration-500`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}
