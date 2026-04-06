import { useState, useEffect } from 'react';

interface DiscoveredServer {
  ip: string;
  hostname: string;
}

interface Props {
  mqttAddr: string;
  mqttPort: number;
  onChangeAddr: (v: string) => void;
  onChangePort: (v: number) => void;
  onNext: () => void;
}

export default function Settings({ mqttAddr, mqttPort, onChangeAddr, onChangePort, onNext }: Props) {
  const [addrError, setAddrError] = useState('');
  const [servers, setServers] = useState<DiscoveredServer[]>([]);
  const [scanning, setScanning] = useState(true);

  // Auto-discover OpenNova servers on the network
  useEffect(() => {
    setScanning(true);
    fetch('/api/discover')
      .then(r => r.json())
      .then((data: { servers: DiscoveredServer[] }) => {
        setServers(data.servers || []);
        // Auto-fill first discovered server if no address set
        if (data.servers?.length > 0 && (!mqttAddr || mqttAddr === '192.168.0.177')) {
          onChangeAddr(data.servers[0].ip);
        }
      })
      .catch(() => {})
      .finally(() => setScanning(false));
  }, []);

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
        Enter the IP address or hostname of your OpenNova server, or select a discovered server below.
      </p>

      {/* Auto-discovered servers */}
      {scanning && (
        <div className="mb-4 py-3 text-center text-gray-500 text-sm">
          <div className="animate-spin w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full mx-auto mb-2"></div>
          Searching for OpenNova servers on your network...
        </div>
      )}

      {!scanning && servers.length > 0 && (
        <div className="mb-6">
          <label className="block text-gray-400 text-xs font-medium uppercase tracking-wide mb-2">
            Discovered Servers
          </label>
          <div className="space-y-1.5">
            {servers.map(s => (
              <button
                key={s.ip}
                onClick={() => onChangeAddr(s.ip)}
                className={`w-full text-left px-4 py-3 rounded-xl flex items-center justify-between transition-all ${
                  mqttAddr === s.ip
                    ? 'bg-emerald-900/40 border border-emerald-500/60 ring-1 ring-emerald-500/30'
                    : 'bg-gray-800/30 border border-white/5 hover:bg-gray-700/40 hover:border-white/10'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-emerald-900/50 flex items-center justify-center">
                    <span className="text-emerald-400 text-sm">🖥</span>
                  </div>
                  <div>
                    <p className="text-white text-sm font-medium">{s.ip}</p>
                    <p className="text-gray-500 text-xs">{s.hostname}</p>
                  </div>
                </div>
                {mqttAddr === s.ip && <span className="text-emerald-400">✓</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {!scanning && servers.length === 0 && (
        <div className="mb-4 p-3 bg-gray-800/30 rounded-xl text-sm text-gray-500">
          No OpenNova servers found on the network. Enter the address manually below.
        </div>
      )}

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
