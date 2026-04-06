import { useState } from 'react';
import { useT } from '../i18n';

interface Props {
  chargerMac?: string;
  deviceType: 'charger' | 'mower' | 'unknown';
}

interface MowerConfig {
  channel: number;
  addr: number;
  source: string;
}

interface FixResult {
  ok: boolean;
  mowerChannel?: number;
  mowerAddr?: number;
  error?: string;
}

export default function LoraFixPanel({ chargerMac, deviceType }: Props) {
  const { t } = useT();
  const [mowerHost, setMowerHost] = useState('192.168.0.244');
  const [mowerPassword, setMowerPassword] = useState('novabot');
  const [loading, setLoading] = useState<string | null>(null);
  const [mowerConfig, setMowerConfig] = useState<MowerConfig | null>(null);
  const [fixResult, setFixResult] = useState<FixResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isCharger = deviceType === 'charger' || deviceType === 'unknown';

  const queryMower = async () => {
    setLoading('query');
    setError(null);
    setMowerConfig(null);
    try {
      const res = await fetch('/api/lora/mower-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: mowerHost, password: mowerPassword }),
      });
      const data = await res.json();
      if (data.ok) {
        setMowerConfig({ channel: data.channel, addr: data.addr, source: data.source });
      } else {
        setError(data.error || 'Failed to query mower');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(null);
    }
  };

  const fixLora = async () => {
    if (!chargerMac) {
      setError(t('loraFix.needCharger'));
      return;
    }
    setLoading('fix');
    setError(null);
    setFixResult(null);
    try {
      const res = await fetch('/api/lora/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mowerHost,
          mowerPassword,
          chargerMac,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setFixResult(data);
        setMowerConfig({ channel: data.mowerChannel, addr: data.mowerAddr, source: '' });
      } else {
        setError(data.error || 'Fix failed');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="glass-card p-4 border border-orange-500/20">
      <div className="relative z-10">
        <h3 className="text-sm font-semibold text-orange-400/80 mb-3 flex items-center gap-2">
          <span className="text-base">🔧</span>
          {t('loraFix.title')}
        </h3>

        <p className="text-xs text-white/40 mb-3">
          {t('loraFix.description')}
        </p>

        {/* Mower SSH config */}
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs text-white/40 whitespace-nowrap">{t('loraFix.mowerIp')}</span>
          <input
            type="text"
            value={mowerHost}
            onChange={(e) => setMowerHost(e.target.value)}
            placeholder="192.168.0.244"
            className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm font-mono"
          />
          <input
            type="password"
            value={mowerPassword}
            onChange={(e) => setMowerPassword(e.target.value)}
            placeholder="password"
            className="w-24 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm"
            autoComplete="off"
            data-1p-ignore
          />
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 mb-3">
          <button
            onClick={queryMower}
            disabled={loading !== null || !mowerHost}
            className="px-3 py-1.5 bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 rounded text-sm transition-colors disabled:opacity-40"
          >
            {loading === 'query' ? '...' : t('loraFix.queryMower')}
          </button>
          {isCharger ? (
            <button
              onClick={fixLora}
              disabled={loading !== null || !mowerHost}
              className="px-3 py-1.5 bg-orange-500/20 hover:bg-orange-500/30 text-orange-300 rounded text-sm font-semibold transition-colors disabled:opacity-40"
            >
              {loading === 'fix' ? '...' : t('loraFix.fix')}
            </button>
          ) : (
            <span className="px-3 py-1.5 text-xs text-white/30 flex items-center">
              {t('loraFix.needCharger')}
            </span>
          )}
        </div>

        {/* Mower config result */}
        {mowerConfig && (
          <div className="p-2 rounded bg-white/5 border border-white/10 mb-2">
            <div className="text-xs text-white/40 mb-1">{t('loraFix.mowerStm32')}</div>
            <div className="flex gap-4">
              <div>
                <span className="text-xs text-white/40">{t('lora.channel')}: </span>
                <span className="text-sm font-mono font-bold text-orange-400">{mowerConfig.channel}</span>
              </div>
              <div>
                <span className="text-xs text-white/40">{t('lora.address')}: </span>
                <span className="text-sm font-mono font-bold text-orange-400">{mowerConfig.addr}</span>
              </div>
            </div>
          </div>
        )}

        {/* Fix result */}
        {fixResult && (
          <div className={`p-2 rounded text-sm ${
            fixResult.ok
              ? 'bg-green-500/10 border border-green-500/20 text-green-300'
              : 'bg-red-500/10 border border-red-500/20 text-red-300'
          }`}>
            {fixResult.ok
              ? t('loraFix.success', { channel: String(fixResult.mowerChannel) })
              : `${t('loraFix.failed')}: ${fixResult.error}`
            }
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="p-2 rounded bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
