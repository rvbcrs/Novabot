import { useState } from 'react';
import type { FirmwareInfo, MowerInfo } from '../App.tsx';
import { useT } from '../i18n/index.ts';

interface Props {
  mower: MowerInfo;
  firmware: FirmwareInfo;
  selectedIp: string;
  mowerVersion: string | null;
  onBack: () => void;
}

export default function OtaConfirm({ mower, firmware, selectedIp, mowerVersion, onBack }: Props) {
  const { t } = useT();
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forceOverride, setForceOverride] = useState(false);

  const sameVersion = mowerVersion !== null && mowerVersion === firmware.version;
  const canFlash = !sameVersion || forceOverride;

  async function handleFlash() {
    setTriggering(true);
    setError(null);
    try {
      const resp = await fetch('/api/ota/trigger', { method: 'POST' });
      const data = await resp.json() as { ok?: boolean; error?: string };
      if (!resp.ok || data.error) {
        setError(data.error ?? t('confirm.triggerFailed'));
        setTriggering(false);
      }
      // On success, server emits 'ota-started' via Socket.io → App.tsx transitions to step 6
    } catch {
      setError(t('confirm.connectionError'));
      setTriggering(false);
    }
  }

  return (
    <div className="glass-card p-8">
      <h2 className="text-xl font-bold text-white mb-2">{t('confirm.title')}</h2>
      <p className="text-gray-400 mb-6 text-sm" dangerouslySetInnerHTML={{ __html: t('confirm.description') }} />

      <div className="space-y-3 mb-6">
        <div className="p-4 bg-gray-800/50 rounded-xl">
          <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">{t('confirm.mowerLabel')}</p>
          <p className="text-white font-mono">{mower.sn}</p>
          {mower.ip && <p className="text-gray-400 text-sm">{mower.ip}</p>}
        </div>

        {/* Version comparison */}
        <div className={`p-4 rounded-xl ${sameVersion ? 'bg-amber-900/20 border border-amber-700/40' : 'bg-gray-800/50'}`}>
          <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">{t('confirm.versionLabel')}</p>
          <div className="flex items-center gap-3 flex-wrap">
            <div>
              <p className="text-gray-500 text-xs mb-0.5">{t('confirm.currentLabel')}</p>
              <p className={`font-mono text-sm font-medium ${mowerVersion ? (sameVersion ? 'text-amber-400' : 'text-gray-300') : 'text-gray-600 italic'}`}>
                {mowerVersion ?? t('confirm.unknown')}
              </p>
            </div>
            {mowerVersion && (
              <>
                <span className="text-gray-600 text-lg">→</span>
                <div>
                  <p className="text-gray-500 text-xs mb-0.5">{t('confirm.newLabel')}</p>
                  <p className={`font-mono text-sm font-medium ${sameVersion ? 'text-amber-400' : 'text-emerald-400'}`}>
                    {firmware.version}
                  </p>
                </div>
              </>
            )}
            {!mowerVersion && (
              <div>
                <p className="text-gray-500 text-xs mb-0.5">{t('confirm.newLabel')}</p>
                <p className="font-mono text-sm font-medium text-emerald-400">{firmware.version}</p>
              </div>
            )}
          </div>
          {sameVersion && (
            <p className="text-amber-400 text-xs mt-2">
              {t('confirm.sameVersionShort')}
            </p>
          )}
          <p className="text-gray-500 text-xs mt-1.5">
            {(firmware.size / 1024 / 1024).toFixed(1)} MB
          </p>
        </div>

        <div className="p-4 bg-gray-800/50 rounded-xl">
          <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">{t('confirm.downloadUrlLabel')}</p>
          <p className="text-white font-mono text-sm break-all">
            http://{selectedIp}:7789/firmware/{firmware.name}
          </p>
        </div>
      </div>

      {/* Same-version warning with override option */}
      {sameVersion && !forceOverride && (
        <div className="p-4 bg-amber-900/30 border border-amber-700/50 rounded-xl mb-4">
          <div className="flex items-start gap-2 text-sm">
            <span className="text-amber-400 mt-0.5">⚠</span>
            <div>
              <p className="text-amber-300 font-medium mb-1">{t('confirm.sameVersionTitle')}</p>
              <p className="text-amber-400 text-xs mb-3" dangerouslySetInnerHTML={{ __html: t('confirm.sameVersionMsg', { version: firmware.version }) }} />
              <button
                onClick={() => setForceOverride(true)}
                className="text-xs py-1.5 px-3 bg-amber-800/50 hover:bg-amber-700/50 text-amber-300 rounded-lg transition-colors"
              >
                {t('confirm.forceBtn')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Standard warning */}
      <div className="p-4 bg-gray-800/40 border border-gray-700/50 rounded-xl mb-6">
        <div className="flex items-start gap-2 text-sm">
          <span className="text-gray-400 mt-0.5">⚠</span>
          <ul className="space-y-1 text-gray-400 text-xs">
            <li>• {t('confirm.warnRestart')}</li>
            <li>• {t('confirm.warnNoPower')}</li>
            <li>• {t('confirm.warnOffline')}</li>
          </ul>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-900/30 border border-red-700/50 rounded-xl text-red-400 text-sm mb-4">
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={onBack}
          disabled={triggering}
          className="flex-1 py-3 px-4 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 font-medium rounded-xl transition-colors"
        >
          {t('confirm.back')}
        </button>
        <button
          onClick={handleFlash}
          disabled={triggering || !canFlash}
          className="flex-[2] py-3 px-6 bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
        >
          {triggering ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              {t('confirm.sending')}
            </>
          ) : (
            t('confirm.flashBtn')
          )}
        </button>
      </div>
    </div>
  );
}
