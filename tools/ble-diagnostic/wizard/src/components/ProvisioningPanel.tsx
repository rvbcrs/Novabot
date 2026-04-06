import { useState, useEffect, useRef } from 'react';
import { useT } from '../i18n';
import type { DiagnosticData } from './RadioDashboard';

interface Props {
  mac: string;
  deviceType: 'charger' | 'mower' | 'unknown';
  data?: DiagnosticData;
}

interface CommandResult {
  command: string;
  ok: boolean;
  error?: string;
}

export default function ProvisioningPanel({ mac, deviceType, data }: Props) {
  const { t } = useT();
  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [loraAddr, setLoraAddr] = useState<number | ''>('');
  const [loraChannel, setLoraChannel] = useState<number | ''>('');
  const [mqttHost, setMqttHost] = useState('');
  const [mqttPort, setMqttPort] = useState(1883);
  const [loading, setLoading] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<CommandResult | null>(null);

  // Track which fields were auto-filled from BLE or server
  const [filledFrom, setFilledFrom] = useState<Set<string>>(new Set());

  // Auto-fill MQTT host from server's LAN IP
  const filledMqtt = useRef(false);
  useEffect(() => {
    if (filledMqtt.current) return;
    fetch('/api/server-info')
      .then(r => r.json())
      .then((info: { ip?: string }) => {
        if (info.ip && !filledMqtt.current) {
          setMqttHost(info.ip);
          setFilledFrom(prev => new Set([...prev, 'mqttHost']));
          filledMqtt.current = true;
        }
      })
      .catch(() => {});
  }, []);

  // Auto-fill from BLE diagnostic data (only once, don't overwrite user edits)
  const filledLora = useRef(false);
  useEffect(() => {
    const lora = data?.lora;
    if (lora && !filledLora.current) {
      const filled = new Set(filledFrom);
      if (lora.addr !== undefined) { setLoraAddr(lora.addr); filled.add('loraAddr'); }
      if (lora.channel !== undefined) { setLoraChannel(lora.channel); filled.add('loraChannel'); }
      setFilledFrom(filled);
      filledLora.current = true;
    }
  }, [data?.lora]); // eslint-disable-line react-hooks/exhaustive-deps

  const macEncoded = encodeURIComponent(mac);
  const effectiveType = deviceType === 'unknown' ? 'charger' : deviceType;

  const sendCommand = async (endpoint: string, body: Record<string, unknown>, label: string) => {
    setLoading(label);
    setLastResult(null);
    try {
      const res = await fetch(`/api/ble/device/${macEncoded}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      setLastResult({ command: label, ok: result.ok ?? !result.error, error: result.error });
    } catch (err) {
      setLastResult({ command: label, ok: false, error: String(err) });
    } finally {
      setLoading(null);
    }
  };

  const bleTag = (field: string) =>
    filledFrom.has(field) ? (
      <span className="text-[9px] text-green-400/60 ml-1">BLE</span>
    ) : null;

  return (
    <div className="glass-card p-4 md:p-6">
      <div className="relative z-10">
        <h3 className="text-sm font-semibold text-white/60 mb-4 flex items-center gap-2">
          <span className="text-base">⚙</span>
          {t('provisioning.title')}
        </h3>

        {/* Result toast */}
        {lastResult && (
          <div
            className={`mb-4 p-2 rounded text-sm ${
              lastResult.ok
                ? 'bg-green-500/10 border border-green-500/20 text-green-300'
                : 'bg-red-500/10 border border-red-500/20 text-red-300'
            }`}
          >
            <span className="font-medium">{lastResult.command}:</span>{' '}
            {lastResult.ok ? t('provisioning.success') : `${t('provisioning.error')}: ${lastResult.error}`}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* WiFi */}
          <div className="panel-card">
            <h4 className="text-xs font-semibold text-white/50 mb-2">{t('provisioning.wifi')}</h4>
            <div className="space-y-2">
              <input
                type="text"
                value={wifiSsid}
                onChange={(e) => setWifiSsid(e.target.value)}
                placeholder={t('provisioning.ssid')}
                className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-sm"
              />
              <input
                type="password"
                value={wifiPassword}
                onChange={(e) => setWifiPassword(e.target.value)}
                placeholder={t('provisioning.password')}
                className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-sm"
              />
              <button
                onClick={() => sendCommand('set-wifi', {
                  ssid: wifiSsid,
                  password: wifiPassword,
                  deviceType: effectiveType,
                }, 'set_wifi_info')}
                disabled={loading !== null || !wifiSsid}
                className="w-full px-3 py-1.5 bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 rounded text-sm transition-colors disabled:opacity-40"
              >
                {loading === 'set_wifi_info' ? '...' : t('provisioning.set')}
              </button>
            </div>
          </div>

          {/* LoRa */}
          <div className="panel-card">
            <h4 className="text-xs font-semibold text-white/50 mb-2">{t('provisioning.lora')}</h4>
            <div className="space-y-2">
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-[10px] text-white/30">
                    {t('provisioning.address')}{bleTag('loraAddr')}
                  </label>
                  <input
                    type="number"
                    value={loraAddr}
                    onChange={(e) => setLoraAddr(e.target.value === '' ? '' : Number(e.target.value))}
                    placeholder="718"
                    className={`w-full bg-white/5 border rounded px-2 py-1 text-sm ${
                      filledFrom.has('loraAddr') ? 'border-green-500/30' : 'border-white/10'
                    }`}
                  />
                </div>
                <div className="flex-1">
                  <label className="text-[10px] text-white/30">
                    {t('provisioning.channel')}{bleTag('loraChannel')}
                  </label>
                  <input
                    type="number"
                    value={loraChannel}
                    onChange={(e) => setLoraChannel(e.target.value === '' ? '' : Number(e.target.value))}
                    placeholder="15"
                    className={`w-full bg-white/5 border rounded px-2 py-1 text-sm ${
                      filledFrom.has('loraChannel') ? 'border-green-500/30' : 'border-white/10'
                    }`}
                  />
                </div>
              </div>
              <button
                onClick={() => sendCommand('set-lora', {
                  addr: loraAddr || 718,
                  channel: loraChannel || 15,
                  hc: 20,
                  lc: 14,
                }, 'set_lora_info')}
                disabled={loading !== null}
                className="w-full px-3 py-1.5 bg-orange-500/20 hover:bg-orange-500/30 text-orange-300 rounded text-sm transition-colors disabled:opacity-40"
              >
                {loading === 'set_lora_info' ? '...' : t('provisioning.set')}
              </button>
            </div>
          </div>

          {/* MQTT */}
          <div className="panel-card">
            <h4 className="text-xs font-semibold text-white/50 mb-2">
              {t('provisioning.mqtt')}
              {filledFrom.has('mqttHost') && (
                <span className="text-[9px] text-green-400/60 ml-1 font-normal">auto</span>
              )}
            </h4>
            <div className="space-y-2">
              <input
                type="text"
                value={mqttHost}
                onChange={(e) => setMqttHost(e.target.value)}
                placeholder={t('provisioning.host')}
                className={`w-full bg-white/5 border rounded px-2 py-1 text-sm ${
                  filledFrom.has('mqttHost') ? 'border-green-500/30' : 'border-white/10'
                }`}
              />
              <input
                type="number"
                value={mqttPort}
                onChange={(e) => setMqttPort(Number(e.target.value))}
                placeholder={t('provisioning.port')}
                className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-sm"
              />
              <button
                onClick={() => sendCommand('set-mqtt', {
                  addr: mqttHost,
                  port: mqttPort,
                }, 'set_mqtt_info')}
                disabled={loading !== null || !mqttHost}
                className="w-full px-3 py-1.5 bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 rounded text-sm transition-colors disabled:opacity-40"
              >
                {loading === 'set_mqtt_info' ? '...' : t('provisioning.set')}
              </button>
            </div>
          </div>
        </div>

        {/* Commit button */}
        <div className="mt-4">
          <button
            onClick={() => sendCommand('commit', { deviceType: effectiveType }, 'set_cfg_info')}
            disabled={loading !== null}
            className="w-full px-4 py-2 bg-green-500/20 hover:bg-green-500/30 text-green-300 rounded-lg text-sm font-semibold transition-colors disabled:opacity-40"
          >
            {loading === 'set_cfg_info' ? '...' : t('provisioning.commit')}
          </button>
        </div>
      </div>
    </div>
  );
}
