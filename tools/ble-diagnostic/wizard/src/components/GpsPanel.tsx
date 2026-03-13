import { useT } from '../i18n';
import type { DiagnosticData } from './RadioDashboard';

interface Props {
  data: DiagnosticData;
}

export default function GpsPanel({ data }: Props) {
  const { t } = useT();

  const rtk = data.rtk;
  const hasData = rtk !== undefined;

  const getRtkLabel = (status?: number) => {
    if (status === 4) return t('gps.fixed');
    if (status === 5) return t('gps.float');
    return t('gps.none');
  };

  const getRtkColor = (status?: number) => {
    if (status === 4) return 'text-green-400';
    if (status === 5) return 'text-yellow-400';
    return 'text-red-400';
  };

  return (
    <div className="glass-card p-4">
      <div className="relative z-10">
        <h3 className="text-sm font-semibold text-white/60 mb-3 flex items-center gap-2">
          <span className="text-base">🛰</span>
          {t('gps.title')}
        </h3>

        {hasData ? (
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-white/40">{t('gps.satellites')}</span>
              <span className="text-2xl font-mono font-bold text-cyan-400">
                {rtk.satellite_num ?? '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/40">{t('gps.rtk')}</span>
              <span className={`text-sm font-semibold ${getRtkColor(rtk.status)}`}>
                {getRtkLabel(rtk.status)}
              </span>
            </div>
            {rtk.valid !== undefined && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-white/40">{t('gps.valid')}</span>
                <span className={`text-sm ${rtk.valid ? 'text-green-400' : 'text-red-400'}`}>
                  {rtk.valid ? 'Yes' : 'No'}
                </span>
              </div>
            )}
          </div>
        ) : (
          <p className="text-white/30 text-sm">{t('gps.noData')}</p>
        )}
      </div>
    </div>
  );
}
