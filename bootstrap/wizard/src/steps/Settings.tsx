import { useState } from 'react';

interface Props {
  mqttAddr: string;
  mqttPort: number;
  onChangeAddr: (v: string) => void;
  onChangePort: (v: number) => void;
  onNext: () => void;
}

export default function Settings({ mqttAddr, mqttPort, onChangeAddr, onChangePort, onNext }: Props) {
  const [addrError, setAddrError] = useState('');

  function handleAddrChange(v: string) {
    setAddrError('');
    onChangeAddr(v);
  }

  function handlePortChange(raw: string) {
    const num = parseInt(raw, 10);
    if (!isNaN(num) && num > 0 && num <= 65535) {
      onChangePort(num);
    }
  }

  function handleNext() {
    if (!mqttAddr.trim()) {
      setAddrError('Please enter an MQTT address.');
      return;
    }
    onNext();
  }

  return (
    <div className="glass-card p-8">
      <h2 className="text-xl font-bold text-white mb-2">Server Settings</h2>
      <p className="text-gray-400 mb-6 text-sm">
        Enter the IP address or hostname of your OpenNova server. This is where
        the MQTT broker is running that your devices will connect to.
      </p>

      <div className="space-y-4 mb-8">
        {/* MQTT Address */}
        <div>
          <label className="block text-gray-400 text-xs font-medium uppercase tracking-wide mb-1.5">
            MQTT Address
          </label>
          <input
            type="text"
            value={mqttAddr}
            onChange={e => handleAddrChange(e.target.value)}
            placeholder="192.168.0.177"
            className={`w-full px-4 py-3 rounded-xl bg-gray-900/60 border text-white text-sm placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors ${
              addrError ? 'border-red-500' : 'border-white/10'
            }`}
          />
          {addrError && (
            <p className="text-red-400 text-xs mt-1">{addrError}</p>
          )}
        </div>

        {/* MQTT Port */}
        <div>
          <label className="block text-gray-400 text-xs font-medium uppercase tracking-wide mb-1.5">
            MQTT Port
          </label>
          <input
            type="number"
            value={mqttPort}
            onChange={e => handlePortChange(e.target.value)}
            min={1}
            max={65535}
            className="w-full px-4 py-3 rounded-xl bg-gray-900/60 border border-white/10 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors"
          />
        </div>
      </div>

      {/* Summary */}
      <div className="p-4 bg-gray-800/40 rounded-xl mb-6">
        <p className="text-gray-500 text-xs font-medium uppercase tracking-wide mb-1">Broker endpoint</p>
        <p className="text-emerald-400 font-mono text-sm">{mqttAddr || '...'}:{mqttPort}</p>
      </div>

      <button
        onClick={handleNext}
        className="w-full py-3 px-6 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors"
      >
        Next
      </button>
    </div>
  );
}
