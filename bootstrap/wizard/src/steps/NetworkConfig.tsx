import { useState, useEffect } from 'react';
import type { DetectResult } from '../App.tsx';

interface NetworkInterface {
  name: string;
  ip: string;
}

interface Props {
  selectedIp: string | null;
  detect: DetectResult | null;
  onSelected: (ip: string) => void;
}

export default function NetworkConfig({ selectedIp: initialIp, detect, onSelected }: Props) {
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([]);
  const [selected, setSelected] = useState<string | null>(initialIp);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dnsOk = detect?.dns.redirected ?? false;

  useEffect(() => {
    fetch('/api/network')
      .then(r => r.json())
      .then((data: NetworkInterface[]) => {
        setInterfaces(data);
        if (!selected && data.length > 0) {
          setSelected(data[0].ip);
        }
        setLoading(false);
      })
      .catch(() => {
        setError('Kan netwerk interfaces niet laden. Is de bootstrap server nog actief?');
        setLoading(false);
      });
  }, []);

  async function handleSubmit() {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const resp = await fetch('/api/network/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: selected }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? `Server fout (${resp.status})`);
        setSaving(false);
        return;
      }
      onSelected(selected);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Onbekende fout';
      setError(`Verbindingsfout: ${msg}. Herstart de bootstrap tool.`);
      setSaving(false);
    }
  }

  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-8">
      <h2 className="text-xl font-bold text-white mb-2">Netwerk instellen</h2>
      <p className="text-gray-400 mb-6 text-sm">
        Selecteer het netwerk waarop je maaier is aangesloten. De maaier haalt de firmware
        via dit IP-adres op.
      </p>

      {loading ? (
        <div className="flex items-center justify-center p-8">
          <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : interfaces.length === 0 && !error ? (
        <div className="p-4 bg-red-900/30 border border-red-700/50 rounded-xl text-red-400 text-sm mb-6">
          Geen netwerk interfaces gevonden. Controleer je WiFi-verbinding.
        </div>
      ) : (
        <div className="space-y-2 mb-6">
          {interfaces.map(iface => (
            <label
              key={iface.ip}
              className={`flex items-center gap-4 p-4 rounded-xl border cursor-pointer transition-colors ${
                selected === iface.ip
                  ? 'bg-emerald-900/20 border-emerald-700'
                  : 'bg-gray-800/50 border-gray-700 hover:border-gray-600'
              }`}
            >
              <input
                type="radio"
                name="network"
                value={iface.ip}
                checked={selected === iface.ip}
                onChange={() => setSelected(iface.ip)}
                className="accent-emerald-500"
              />
              <div className="flex-1">
                <p className="text-white font-medium font-mono">{iface.ip}</p>
                <p className="text-gray-400 text-sm">{iface.name}</p>
              </div>
              {selected === iface.ip && (
                <span className="text-emerald-400 text-sm font-medium">Geselecteerd</span>
              )}
            </label>
          ))}
        </div>
      )}

      {/* DNS info */}
      {dnsOk ? (
        <div className="p-4 bg-emerald-900/20 border border-emerald-700/40 rounded-xl mb-6">
          <div className="flex items-center gap-2 text-sm text-emerald-300">
            <span>&#10003;</span>
            <div>
              <p className="font-medium">DNS rewrite actief</p>
              <p className="text-emerald-400 text-xs">
                <code>mqtt.lfibot.com</code> &#8594; <code>{detect?.dns.address}</code>
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-4 bg-blue-900/20 border border-blue-700/30 rounded-xl mb-6">
          <div className="flex items-start gap-2 text-sm text-blue-300">
            <span className="mt-0.5">i</span>
            <div>
              <p className="font-medium mb-1">DNS wordt automatisch ingesteld</p>
              <p className="text-blue-400">
                De Docker container bevat een DNS server. Stel op je router dit IP in als DNS server:
                <code className="text-blue-300 ml-1">{selected ?? 'jouw IP'}</code>
              </p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-900/30 border border-red-700/50 rounded-xl text-red-400 text-sm mb-4">
          {error}
        </div>
      )}

      <button
        onClick={handleSubmit}
        disabled={!selected || saving || (interfaces.length === 0 && !error)}
        className="w-full py-3 px-6 bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors"
      >
        {saving ? 'Opslaan...' : 'Verder →'}
      </button>
    </div>
  );
}
