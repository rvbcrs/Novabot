import { BatteryMedium, Plug, TreePine } from 'lucide-react';
import type { DeviceState } from '../../types';
import { StatusBadge } from '../common/StatusBadge';

interface Props {
  devices: Map<string, DeviceState>;
  selectedSn: string | null;
  onSelect: (sn: string) => void;
}

export function Sidebar({ devices, selectedSn, onSelect }: Props) {
  const sorted = Array.from(devices.values()).sort((a, b) => {
    // Charger first, then mower
    if (a.deviceType !== b.deviceType) return a.deviceType === 'charger' ? -1 : 1;
    return a.sn.localeCompare(b.sn);
  });

  return (
    <aside className="w-72 bg-gray-900 border-r border-gray-800 overflow-auto">
      <div className="p-4 space-y-2">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Devices</h2>
        {sorted.map(device => (
          <button
            key={device.sn}
            onClick={() => onSelect(device.sn)}
            className={`w-full text-left p-3 rounded-lg transition-colors ${
              selectedSn === device.sn
                ? 'bg-gray-700 border border-gray-600'
                : 'bg-gray-800/50 border border-transparent hover:bg-gray-800'
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                {device.deviceType === 'charger' ? (
                  <Plug className="w-4 h-4 text-yellow-500" />
                ) : (
                  <TreePine className="w-4 h-4 text-emerald-500" />
                )}
                <span className="text-sm font-medium text-white">
                  {device.nickname ?? (device.deviceType === 'charger' ? 'Charger' : 'Mower')}
                </span>
              </div>
              <StatusBadge online={device.online} />
            </div>
            <span className="text-xs text-gray-400 font-mono">{device.sn}</span>
            {(device.sensors.battery_power || device.sensors.battery_capacity) && (
              <div className="mt-2 flex items-center gap-2">
                <BatteryMedium className="w-4 h-4 text-gray-400" />
                <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-green-500 rounded-full transition-all"
                    style={{ width: `${device.sensors.battery_power ?? device.sensors.battery_capacity ?? 0}%` }}
                  />
                </div>
                <span className="text-xs text-gray-400">
                  {device.sensors.battery_power ?? device.sensors.battery_capacity ?? '?'}%
                </span>
              </div>
            )}
          </button>
        ))}
        {sorted.length === 0 && (
          <p className="text-sm text-gray-500 text-center py-8">No devices found</p>
        )}
      </div>
    </aside>
  );
}
