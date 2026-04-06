import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SignalHistoryPoint } from '../../types';
import { fetchSignalHistory } from '../../api/client';

interface Props {
  sn: string;
}

const TIME_RANGES = [1, 6, 24, 168] as const; // hours: 1h, 6h, 24h, 7d

interface ChartConfig {
  key: keyof SignalHistoryPoint;
  labelKey: string;
  unit: string;
  color: string;
  thresholds: [number, number]; // [good→warn, warn→bad]
  invert?: boolean; // higher = worse (e.g. wifi_rssi is negative, but stored positive)
}

const CHARTS: ChartConfig[] = [
  { key: 'battery', labelKey: 'charts.battery', unit: '%', color: '#34d399', thresholds: [20, 10] },
  { key: 'wifiRssi', labelKey: 'charts.wifi', unit: 'dBm', color: '#60a5fa', thresholds: [-65, -80], invert: true },
  { key: 'rtkSat', labelKey: 'charts.rtkSat', unit: '', color: '#a78bfa', thresholds: [10, 5] },
  { key: 'cpuTemp', labelKey: 'charts.cpuTemp', unit: '°C', color: '#fb923c', thresholds: [60, 75], invert: true },
];

export function SignalChart({ sn }: Props) {
  const { t } = useTranslation();
  const [hours, setHours] = useState<number>(24);
  const [data, setData] = useState<SignalHistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchSignalHistory(sn, hours)
      .then(setData)
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [sn, hours]);

  if (loading && data.length === 0) {
    return <div className="p-6 text-center text-sm text-gray-500">{t('devices.loading')}</div>;
  }

  return (
    <div className="p-4 space-y-4">
      {/* Time range selector */}
      <div className="flex gap-1">
        {TIME_RANGES.map(h => (
          <button
            key={h}
            onClick={() => setHours(h)}
            className={`flex-1 text-xs py-1.5 rounded transition-colors ${
              hours === h
                ? 'bg-blue-600 text-white font-medium'
                : 'bg-gray-800 text-gray-500 hover:text-gray-300 border border-gray-700'
            }`}
          >
            {h < 24 ? t('charts.hours', { count: h }) : t('charts.days', { count: h / 24 })}
          </button>
        ))}
      </div>

      {data.length < 2 ? (
        <div className="py-8 text-center text-sm text-gray-500">{t('charts.noData')}</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {CHARTS.map(chart => (
            <Sparkline key={chart.key} config={chart} data={data} />
          ))}
        </div>
      )}
    </div>
  );
}

function Sparkline({ config, data }: { config: ChartConfig; data: SignalHistoryPoint[] }) {
  const { t } = useTranslation();
  const points = useMemo(() => {
    return data
      .map(d => d[config.key] as number | null)
      .filter((v): v is number => v != null);
  }, [data, config.key]);

  if (points.length < 2) {
    return (
      <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/50">
        <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">{t(config.labelKey)}</div>
        <div className="text-xs text-gray-600">—</div>
      </div>
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const latest = points[points.length - 1];

  const W = 200;
  const H = 40;
  const step = W / (points.length - 1);

  const pathD = points
    .map((v, i) => {
      const x = i * step;
      const y = H - ((v - min) / range) * H;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  // Fill area
  const fillD = `${pathD} L${((points.length - 1) * step).toFixed(1)},${H} L0,${H} Z`;

  return (
    <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/50">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-gray-500 uppercase tracking-wide">{t(config.labelKey)}</span>
        <span className="text-xs font-mono text-gray-300">
          {latest}{config.unit}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-10" preserveAspectRatio="none">
        <path d={fillD} fill={config.color} opacity="0.1" />
        <path d={pathD} fill="none" stroke={config.color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex items-center justify-between mt-0.5">
        <span className="text-[9px] text-gray-600">{min}{config.unit}</span>
        <span className="text-[9px] text-gray-600">{max}{config.unit}</span>
      </div>
    </div>
  );
}
