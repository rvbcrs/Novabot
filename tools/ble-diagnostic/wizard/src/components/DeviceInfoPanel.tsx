import { useT } from '../i18n';
import type { DiagnosticData } from './RadioDashboard';

interface Props {
  data: DiagnosticData;
}

export default function DeviceInfoPanel({ data }: Props) {
  const { t } = useT();

  const devInfo = data.devInfo;
  const cfg = data.cfg;
  const mqttInfo = data.mqttDevInfo;

  return (
    <div className="glass-card p-4">
      <div className="relative z-10">
        <h3 className="text-sm font-semibold text-white/60 mb-3 flex items-center gap-2">
          <span className="text-base">🔧</span>
          {t('deviceInfo.title')}
        </h3>

        {devInfo || mqttInfo ? (
          <div className="space-y-2">
            {devInfo?.sn && (
              <Row label={t('deviceInfo.sn')} value={devInfo.sn} mono />
            )}
            {devInfo?.fw_version && (
              <Row label={t('deviceInfo.firmware')} value={`v${devInfo.fw_version}`} />
            )}
            {devInfo?.hw_version && (
              <Row label={t('deviceInfo.hardware')} value={`v${devInfo.hw_version}`} />
            )}
            {cfg && (
              <Row
                label={t('deviceInfo.config')}
                value={cfg.value === 1 ? t('deviceInfo.committed') : t('deviceInfo.notCommitted')}
                color={cfg.value === 1 ? 'text-green-400' : 'text-yellow-400'}
              />
            )}
            {mqttInfo && !devInfo && (
              <div className="text-xs text-white/40">
                <pre className="whitespace-pre-wrap break-all">
                  {JSON.stringify(mqttInfo, null, 2)}
                </pre>
              </div>
            )}
          </div>
        ) : (
          <p className="text-white/30 text-sm">{t('deviceInfo.noData')}</p>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, mono, color }: {
  label: string;
  value: string;
  mono?: boolean;
  color?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-white/40">{label}</span>
      <span className={`text-sm ${mono ? 'font-mono' : ''} ${color ?? 'text-white/80'}`}>{value}</span>
    </div>
  );
}
