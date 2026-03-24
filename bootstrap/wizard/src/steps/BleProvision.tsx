import { useState } from 'react';
import { provisionMower, isWebBluetoothAvailable, type BleStatus } from '../ble/webBle.ts';

interface Props {
  selectedIp: string;
  onDone: () => void;
}

export default function BleProvision({ selectedIp, onDone }: Props) {
  const [status, setStatus] = useState<BleStatus>({ phase: 'idle', message: '' });
  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [devicesDone, setDevicesDone] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const webBleAvailable = isWebBluetoothAvailable();
  const mqttPort = 1883;

  async function startProvision() {
    if (!wifiSsid) return;

    const success = await provisionMower(
      selectedIp,
      mqttPort,
      setStatus,
      false, // don't scan all, use name filters
      wifiSsid,
      wifiPassword,
    );

    if (success) {
      setDevicesDone(prev => [...prev, status.deviceName ?? 'Device']);
      setStatus({ phase: 'idle', message: '' });
    }
  }

  const isWorking = ['requesting', 'connecting', 'discovering', 'wifi', 'mqtt', 'commit'].includes(status.phase);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white mb-2">Add New Device via Bluetooth</h2>
        <p className="text-gray-400 text-sm">
          Connect to your charger or mower via Bluetooth to configure WiFi and MQTT settings.
          The device will connect to your OpenNova server at <code className="text-emerald-400">{selectedIp}:{mqttPort}</code>.
        </p>
      </div>

      {!webBleAvailable && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-4">
          <p className="text-red-400 font-medium">Web Bluetooth is not available</p>
          <p className="text-gray-400 text-sm mt-1">
            Use Chrome or Edge on a computer with Bluetooth. Safari and Firefox do not support Web Bluetooth.
          </p>
        </div>
      )}

      {/* WiFi credentials */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-gray-300">WiFi Credentials (2.4 GHz only)</h3>
        <input
          type="text"
          placeholder="WiFi network name (SSID)"
          value={wifiSsid}
          onChange={e => setWifiSsid(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-white placeholder-gray-500 focus:border-emerald-500 focus:outline-none"
          disabled={isWorking}
        />
        <input
          type="password"
          placeholder="WiFi password"
          value={wifiPassword}
          onChange={e => setWifiPassword(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-white placeholder-gray-500 focus:border-emerald-500 focus:outline-none"
          disabled={isWorking}
        />
      </div>

      {/* Provisioned devices */}
      {devicesDone.length > 0 && (
        <div className="bg-emerald-900/20 border border-emerald-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-emerald-400 mb-2">Configured devices:</h3>
          {devicesDone.map((d, i) => (
            <div key={i} className="flex items-center gap-2 text-sm text-gray-300">
              <span className="text-emerald-400">✓</span> {d}
            </div>
          ))}
        </div>
      )}

      {/* Status */}
      {status.phase !== 'idle' && (
        <div className={`rounded-lg p-4 ${
          status.phase === 'error' ? 'bg-red-900/30 border border-red-700' :
          status.phase === 'done' ? 'bg-emerald-900/30 border border-emerald-700' :
          'bg-gray-800 border border-gray-700'
        }`}>
          <div className="flex items-center gap-3">
            {isWorking && (
              <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            )}
            {status.phase === 'done' && <span className="text-emerald-400 text-lg">✓</span>}
            {status.phase === 'error' && <span className="text-red-400 text-lg">✗</span>}
            <div>
              <p className="text-white text-sm font-medium">
                {status.phase === 'requesting' && 'Select your device from the Bluetooth popup...'}
                {status.phase === 'connecting' && `Connecting to ${status.deviceName}...`}
                {status.phase === 'discovering' && 'Discovering BLE services...'}
                {status.phase === 'wifi' && status.message}
                {status.phase === 'mqtt' && status.message}
                {status.phase === 'commit' && 'Saving settings...'}
                {status.phase === 'done' && `${status.deviceName} configured! It will now connect to your server.`}
                {status.phase === 'error' && status.message}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="space-y-3">
        {/* Step 1: Provision charger */}
        <button
          onClick={startProvision}
          disabled={!webBleAvailable || !wifiSsid || isWorking}
          className="w-full py-3 rounded-lg font-medium transition-colors bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {devicesDone.length === 0
            ? '1. Connect Charging Station via Bluetooth'
            : devicesDone.length === 1
            ? '2. Connect Mower via Bluetooth'
            : 'Connect Another Device'}
        </button>

        {/* Show hint for which device to provision */}
        {!isWorking && devicesDone.length === 0 && (
          <p className="text-xs text-gray-500 text-center">
            Make sure the charging station is powered on and within Bluetooth range (~5m).
            It will appear as "CHARGER_PILE" in the Bluetooth popup.
          </p>
        )}
        {!isWorking && devicesDone.length === 1 && (
          <p className="text-xs text-gray-500 text-center">
            Now power on the mower near the charging station.
            It will appear as "Novabot" in the Bluetooth popup.
          </p>
        )}

        {/* Continue when at least one device is done */}
        {devicesDone.length >= 1 && !isWorking && (
          <button
            onClick={onDone}
            className="w-full py-3 rounded-lg font-medium transition-colors bg-gray-700 hover:bg-gray-600 text-white"
          >
            {devicesDone.length >= 2 ? 'Continue →' : 'Skip mower for now, continue →'}
          </button>
        )}
      </div>

      {/* Advanced: scan all devices */}
      <div className="pt-2">
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-xs text-gray-500 hover:text-gray-400"
        >
          {showAdvanced ? '▼' : '▶'} Advanced options
        </button>
        {showAdvanced && (
          <div className="mt-2 text-xs text-gray-500 space-y-2">
            <p>
              MQTT server: <code className="text-emerald-400">{selectedIp}:{mqttPort}</code><br />
              LoRa: addr=718, channel=16, hc=20, lc=14
            </p>
            <button
              onClick={async () => {
                if (!wifiSsid) return;
                await provisionMower(selectedIp, mqttPort, setStatus, true, wifiSsid, wifiPassword);
              }}
              disabled={!webBleAvailable || !wifiSsid || isWorking}
              className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-40"
            >
              Scan all Bluetooth devices (no name filter)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
