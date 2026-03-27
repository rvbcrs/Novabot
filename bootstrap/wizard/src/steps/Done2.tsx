import type { DeviceMode, FirmwareInfo } from '../App.tsx';

interface Props {
  deviceMode: DeviceMode;
  chargerConnected: boolean;
  mowerConnected: boolean;
  chargerFirmware: FirmwareInfo | null;
  mowerFirmware: FirmwareInfo | null;
  onAddAnother: () => void;
  onDashboard: () => void;
}

export default function Done2({ deviceMode, chargerConnected, mowerConnected, chargerFirmware, mowerFirmware, onAddAnother, onDashboard }: Props) {
  const expectsCharger = deviceMode === 'charger' || deviceMode === 'both';
  const expectsMower = deviceMode === 'mower' || deviceMode === 'both';

  return (
    <div className="glass-card p-8">
      {/* Success header */}
      <div className="flex flex-col items-center gap-4 mb-8">
        <div className="w-20 h-20 rounded-full bg-emerald-900/40 border-2 border-emerald-500 flex items-center justify-center overflow-hidden">
          <img src="/OpenNova.png" alt="OpenNova" className="w-16 h-16 object-contain" />
        </div>
        <h2 className="text-2xl font-bold text-white">Setup Complete</h2>
        <p className="text-gray-400 text-sm text-center">
          Your device(s) have been configured successfully.
        </p>
      </div>

      {/* Summary */}
      <div className="space-y-3 mb-8">
        <h3 className="text-gray-400 text-xs font-medium uppercase tracking-wide">Summary</h3>

        {expectsCharger && (
          <div className="flex items-center justify-between p-4 bg-gray-800/40 rounded-xl border border-gray-700/50">
            <div className="flex items-center gap-3">
              <span className="text-xl">{'\u26A1'}</span>
              <div>
                <p className="text-white text-sm font-medium">Charger</p>
                <p className="text-gray-500 text-xs">
                  {chargerConnected ? 'Connected via MQTT' : 'Provisioned (not yet connected)'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {chargerFirmware && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-400">
                  v{chargerFirmware.version}
                </span>
              )}
              <div className={`w-3 h-3 rounded-full ${chargerConnected ? 'bg-emerald-500' : 'bg-gray-600'}`} />
            </div>
          </div>
        )}

        {expectsMower && (
          <div className="flex items-center justify-between p-4 bg-gray-800/40 rounded-xl border border-gray-700/50">
            <div className="flex items-center gap-3">
              <span className="text-xl">{'\uD83E\uDD16'}</span>
              <div>
                <p className="text-white text-sm font-medium">Mower</p>
                <p className="text-gray-500 text-xs">
                  {mowerConnected ? 'Connected via MQTT' : 'Provisioned (not yet connected)'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {mowerFirmware && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-400">
                  v{mowerFirmware.version}
                </span>
              )}
              <div className={`w-3 h-3 rounded-full ${mowerConnected ? 'bg-emerald-500' : 'bg-gray-600'}`} />
            </div>
          </div>
        )}

        {/* Firmware flash summary */}
        {(chargerFirmware || mowerFirmware) && (
          <div className="p-3 bg-gray-800/30 rounded-xl">
            <p className="text-gray-500 text-xs">
              Firmware flashed: {[chargerFirmware && 'Charger', mowerFirmware && 'Mower'].filter(Boolean).join(' + ')}
            </p>
          </div>
        )}
        {!chargerFirmware && !mowerFirmware && (
          <div className="p-3 bg-gray-800/30 rounded-xl">
            <p className="text-gray-500 text-xs">No firmware was flashed. You can flash firmware later from the dashboard.</p>
          </div>
        )}
      </div>

      {/* Next steps */}
      <div className="mb-8">
        <h3 className="text-white font-medium mb-3">Next steps</h3>
        <div className="space-y-2">
          {[
            { icon: '\uD83D\uDCF1', text: 'Open the Novabot app and verify your device(s) appear.' },
            { icon: '\uD83D\uDCCD', text: 'Map your garden boundaries using the mower.' },
            { icon: '\u2713', text: 'Set up a mowing schedule via the dashboard.' },
          ].map(({ icon, text }, i) => (
            <div key={i} className="flex items-start gap-3 p-3 bg-gray-800/40 rounded-xl">
              <span>{icon}</span>
              <p className="text-gray-300 text-sm">{text}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-4">
        <button
          onClick={onAddAnother}
          className="flex-1 py-3 px-6 bg-teal-800 hover:bg-teal-700 text-white font-semibold rounded-xl transition-colors"
        >
          Add Another Device
        </button>
        <button
          onClick={onDashboard}
          className="flex-1 py-3 px-6 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors"
        >
          Open Dashboard
        </button>
      </div>
    </div>
  );
}
