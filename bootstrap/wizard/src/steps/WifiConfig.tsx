import { useState } from 'react';

interface Props {
  wifiSsid: string;
  wifiPassword: string;
  onChangeSsid: (v: string) => void;
  onChangePassword: (v: string) => void;
  onNext: () => void;
}

export default function WifiConfig({ wifiSsid, wifiPassword, onChangeSsid, onChangePassword, onNext }: Props) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="glass-card p-8">
      <h2 className="text-xl font-bold text-white mb-2">WiFi Configuration</h2>
      <p className="text-gray-400 mb-6 text-sm">
        Enter the WiFi network the device(s) should connect to. This must be a 2.4 GHz network
        that can reach the OpenNova server.
      </p>

      <div className="space-y-4 mb-8">
        {/* SSID */}
        <div>
          <label className="block text-gray-400 text-xs font-medium uppercase tracking-wide mb-1.5">
            WiFi Network (SSID)
          </label>
          <input
            type="text"
            value={wifiSsid}
            onChange={e => onChangeSsid(e.target.value)}
            placeholder="Enter your WiFi network name"
            autoFocus
            className="w-full px-4 py-3 rounded-xl bg-gray-900/60 border border-white/10 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors"
          />
        </div>

        {/* Password */}
        <div>
          <label className="block text-gray-400 text-xs font-medium uppercase tracking-wide mb-1.5">
            WiFi Password
          </label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={wifiPassword}
              onChange={e => onChangePassword(e.target.value)}
              placeholder="Enter your WiFi password"
              className="w-full px-4 py-3 pr-20 rounded-xl bg-gray-900/60 border border-white/10 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors"
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
      </div>

      {/* Info box */}
      <div className="p-4 bg-gray-800/40 rounded-xl mb-6">
        <div className="flex items-start gap-2">
          <span className="text-blue-400 text-sm mt-0.5">i</span>
          <div className="text-sm text-gray-400">
            <p>Make sure the WiFi network is <span className="text-gray-300 font-medium">2.4 GHz</span>. The ESP32 charger board does not support 5 GHz networks.</p>
          </div>
        </div>
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
