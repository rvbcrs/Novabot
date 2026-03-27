import { useState, useEffect, useCallback } from 'react';

interface WifiNetwork {
  ssid: string;
  bssid: string;
  signal_level: number;
  quality: number;
  security: string;
  channel: number;
  current: boolean;
}

interface ScanResponse {
  success: boolean;
  data?: WifiNetwork[];
  source?: string;
  error?: string;
}

interface Props {
  wifiSsid: string;
  wifiPassword: string;
  onChangeSsid: (v: string) => void;
  onChangePassword: (v: string) => void;
  onNext: () => void;
}

export default function WifiConfig({ wifiSsid, wifiPassword, onChangeSsid, onChangePassword, onNext }: Props) {
  const [showPassword, setShowPassword] = useState(false);
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string>('');

  const fetchNetworks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/wifi/scan');
      const result: ScanResponse = await response.json();

      if (result.success && result.data && result.data.length > 0) {
        setNetworks(result.data);
        setSource(result.source || '');
        // Auto-select current network if nothing selected yet
        if (!wifiSsid) {
          const current = result.data.find(n => n.current);
          if (current) onChangeSsid(current.ssid);
        }
      } else {
        setError(result.error || 'No networks found');
      }
    } catch {
      setError('Could not connect to server');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchNetworks(); }, [fetchNetworks]);

  const getSignalIcon = (quality: number) => {
    if (quality > 75) return { bars: '▂▄▆█', color: 'text-emerald-400' };
    if (quality > 50) return { bars: '▂▄▆░', color: 'text-yellow-400' };
    if (quality > 25) return { bars: '▂▄░░', color: 'text-orange-400' };
    return { bars: '▂░░░', color: 'text-red-400' };
  };

  return (
    <div className="glass-card p-8">
      <div className="flex justify-between items-start mb-6">
        <div>
          <h2 className="text-xl font-bold text-white">WiFi Configuration</h2>
          <p className="text-gray-400 text-sm mt-1">Select the network for your device(s)</p>
        </div>
        <button
          onClick={fetchNetworks}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 bg-gray-800/60 hover:bg-gray-700/60 text-gray-300 text-sm rounded-lg border border-white/10 transition-colors disabled:opacity-50"
        >
          <span className={loading ? 'animate-spin' : ''}>↻</span>
          {loading ? 'Scanning...' : 'Rescan'}
        </button>
      </div>

      {/* Network grid */}
      {!loading && networks.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6 max-h-64 overflow-y-auto pr-1">
          {networks.map(n => {
            const sig = getSignalIcon(n.quality);
            const selected = wifiSsid === n.ssid;
            return (
              <button
                key={n.bssid || n.ssid}
                onClick={() => onChangeSsid(n.ssid)}
                className={`text-left p-4 rounded-xl border transition-all ${
                  selected
                    ? 'bg-emerald-900/40 border-emerald-500/60 ring-1 ring-emerald-500/30'
                    : 'bg-gray-800/30 border-white/5 hover:bg-gray-700/40 hover:border-white/10'
                }`}
              >
                <div className="flex justify-between items-start mb-2">
                  <span className={`text-sm font-semibold truncate pr-2 ${selected ? 'text-white' : 'text-gray-200'}`}>
                    {n.ssid}
                  </span>
                  <span className={`text-xs font-mono ${sig.color}`}>{sig.bars}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  {n.quality > 0 && <span>{n.signal_level} dBm</span>}
                  {n.quality > 0 && n.security !== 'known' && <span>·</span>}
                  {n.security && n.security !== 'known' && n.security !== 'unknown' && (
                    <span className="flex items-center gap-0.5">🔒 {n.security}</span>
                  )}
                  {n.channel > 0 && <span>· Ch {n.channel}</span>}
                  {n.current && (
                    <span className="ml-auto bg-emerald-800/60 text-emerald-300 px-1.5 py-0.5 rounded-full">connected</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="py-12 text-center mb-6">
          <div className="animate-spin w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full mx-auto mb-3"></div>
          <p className="text-gray-400 text-sm">Scanning for WiFi networks...</p>
        </div>
      )}

      {/* Error / no scan available */}
      {!loading && error && (
        <div className="mb-6 p-4 bg-gray-800/30 rounded-xl border border-white/5">
          <p className="text-gray-400 text-sm mb-1">WiFi scan not available — enter network name manually below.</p>
          <p className="text-gray-600 text-xs">{error}</p>
        </div>
      )}

      {/* Source hint */}
      {!loading && source === 'known' && networks.length > 0 && (
        <p className="text-xs text-gray-600 mb-4">
          Showing known networks (live scan requires Location Services permission).
        </p>
      )}

      {/* Manual SSID input */}
      <div className="mb-4">
        <label className="block text-gray-400 text-xs font-medium uppercase tracking-wide mb-1.5">
          Network Name (SSID)
        </label>
        <input
          type="text"
          value={wifiSsid}
          onChange={e => onChangeSsid(e.target.value)}
          placeholder="Enter or select a WiFi network"
          className="w-full px-4 py-3 rounded-xl bg-gray-900/60 border border-white/10 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors"
        />
      </div>

      {/* Password */}
      <div className="mb-6">
        <label className="block text-gray-400 text-xs font-medium uppercase tracking-wide mb-1.5">
          Password
        </label>
        <div className="relative">
          <input
            type={showPassword ? 'text' : 'password'}
            value={wifiPassword}
            onChange={e => onChangePassword(e.target.value)}
            placeholder="WiFi password"
            className="w-full px-4 py-3 pr-16 rounded-xl bg-gray-900/60 border border-white/10 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors"
          />
          <button
            type="button"
            onClick={() => setShowPassword(v => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-xs transition-colors"
          >
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      {/* 2.4 GHz note */}
      <div className="p-3 bg-gray-800/30 rounded-xl mb-6 flex items-start gap-2">
        <span className="text-blue-400 text-sm mt-0.5">ℹ</span>
        <p className="text-xs text-gray-500">
          The charger only supports <span className="text-gray-400 font-medium">2.4 GHz</span> WiFi networks.
          5 GHz networks will not work.
        </p>
      </div>

      <button
        onClick={onNext}
        disabled={!wifiSsid.trim()}
        className="w-full py-3 px-6 bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors"
      >
        Next
      </button>
    </div>
  );
}
