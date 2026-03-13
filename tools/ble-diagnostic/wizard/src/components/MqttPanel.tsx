import { useState } from 'react';
import { useT } from '../i18n';

interface Props {
  deviceType?: 'charger' | 'mower' | 'unknown';
  onLoraData: (lora: { addr?: number; channel?: number; hc?: number; lc?: number }) => void;
  onDevInfoData: (info: Record<string, unknown>) => void;
}

const DEFAULT_SNS: Record<string, string> = {
  charger: 'LFIC1230700004',
  mower: 'LFIN2230700238',
  unknown: '',
};

export default function MqttPanel({ deviceType = 'mower', onLoraData, onDevInfoData }: Props) {
  const { t } = useT();
  const [host, setHost] = useState('localhost');
  const [port, setPort] = useState(1883);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [sn, setSn] = useState(DEFAULT_SNS[deviceType] || '');
  const [loading, setLoading] = useState<string | null>(null);

  const connectMqtt = async () => {
    setConnecting(true);
    try {
      const res = await fetch('/api/mqtt/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port }),
      });
      const data = await res.json();
      if (data.ok) {
        setConnected(true);
        // Subscribe to device
        if (sn) {
          await fetch(`/api/mqtt/subscribe/${sn}`, { method: 'POST' });
        }
      } else {
        alert(data.error || 'Connection failed');
      }
    } catch (err) {
      alert(String(err));
    } finally {
      setConnecting(false);
    }
  };

  const disconnectMqtt = async () => {
    await fetch('/api/mqtt/disconnect', { method: 'POST' });
    setConnected(false);
  };

  const queryLora = async () => {
    if (!sn) return;
    setLoading('lora');
    try {
      const res = await fetch(`/api/mqtt/device/${sn}/lora`, { method: 'POST' });
      const result = await res.json();
      if (result.ok && result.response) {
        // Response format: {type:"get_lora_info_respond", message:{result:0, value:{channel,addr,rssi}}}
        const resp = result.response as Record<string, unknown>;
        const message = resp.message as Record<string, unknown> | undefined;
        // Data can be in message.value (charger/mower respond format) or message directly
        const loraData = (message?.value as Record<string, unknown>) ?? message ?? resp.lora_info ?? resp;
        onLoraData(loraData as { addr?: number; channel?: number; hc?: number; lc?: number });
      }
    } catch (err) {
      console.error('MQTT query failed:', err);
    } finally {
      setLoading(null);
    }
  };

  const queryInfo = async () => {
    if (!sn) return;
    setLoading('info');
    try {
      const res = await fetch(`/api/mqtt/device/${sn}/dev-info`, { method: 'POST' });
      const result = await res.json();
      if (result.ok && result.response) {
        // Unwrap message.value if present
        const resp = result.response as Record<string, unknown>;
        const message = resp.message as Record<string, unknown> | undefined;
        const devData = (message?.value as Record<string, unknown>) ?? message ?? resp;
        onDevInfoData(devData);
      }
    } catch (err) {
      console.error('MQTT query failed:', err);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="glass-card p-4">
      <div className="relative z-10">
        <h3 className="text-sm font-semibold text-white/60 mb-3 flex items-center gap-2">
          <span className="text-base">🌐</span>
          {t('mqttPanel.title')}
          <span className={`status-dot ml-1 ${connected ? 'connected' : 'disconnected'}`} />
        </h3>

        <div className="space-y-3">
          {/* Broker connection */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder={t('mqttPanel.host')}
              className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm"
              disabled={connected}
            />
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              placeholder={t('mqttPanel.port')}
              className="w-20 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm"
              disabled={connected}
            />
            {connected ? (
              <button
                onClick={disconnectMqtt}
                className="px-3 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded text-sm transition-colors"
              >
                {t('mqttPanel.disconnect')}
              </button>
            ) : (
              <button
                onClick={connectMqtt}
                disabled={connecting}
                className="px-3 py-1 bg-green-500/20 hover:bg-green-500/30 text-green-300 rounded text-sm transition-colors disabled:opacity-40"
              >
                {connecting ? '...' : t('mqttPanel.connect')}
              </button>
            )}
          </div>

          {/* Mower SN + query buttons */}
          {connected && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs text-white/40">{t('mqttPanel.sn')}</span>
                <input
                  type="text"
                  value={sn}
                  onChange={(e) => setSn(e.target.value)}
                  className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm font-mono"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={queryLora}
                  disabled={loading !== null}
                  className="px-3 py-1 bg-orange-500/20 hover:bg-orange-500/30 text-orange-300 rounded text-sm transition-colors disabled:opacity-40"
                >
                  {loading === 'lora' ? '...' : t('mqttPanel.queryLora')}
                </button>
                <button
                  onClick={queryInfo}
                  disabled={loading !== null}
                  className="px-3 py-1 bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 rounded text-sm transition-colors disabled:opacity-40"
                >
                  {loading === 'info' ? '...' : t('mqttPanel.queryInfo')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
