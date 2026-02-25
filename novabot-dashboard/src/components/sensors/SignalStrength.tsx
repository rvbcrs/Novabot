import { Wifi, Satellite, Crosshair } from 'lucide-react';

interface Props {
  wifiRssi?: string;
  rtkSat?: string;
  locQuality?: string;
}

function rssiLabel(rssi: number): string {
  if (rssi >= -50) return 'Excellent';
  if (rssi >= -60) return 'Good';
  if (rssi >= -70) return 'Fair';
  return 'Weak';
}

function rssiBars(rssi: number): number {
  if (rssi >= -50) return 4;
  if (rssi >= -60) return 3;
  if (rssi >= -70) return 2;
  return 1;
}

export function SignalStrength({ wifiRssi, rtkSat, locQuality }: Props) {
  const rssi = wifiRssi ? parseInt(wifiRssi, 10) : null;
  const sats = rtkSat ? parseInt(rtkSat, 10) : null;
  const bars = rssi !== null ? rssiBars(rssi) : 0;

  return (
    <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
      <div className="flex items-center gap-2 mb-3">
        <Wifi className="w-4 h-4 text-blue-400" />
        <span className="text-sm text-gray-400">Signal</span>
      </div>
      <div className="space-y-3">
        {rssi !== null && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex items-end gap-0.5 h-4">
                {[1, 2, 3, 4].map(i => (
                  <div
                    key={i}
                    className={`w-1 rounded-sm ${i <= bars ? 'bg-green-500' : 'bg-gray-600'}`}
                    style={{ height: `${i * 25}%` }}
                  />
                ))}
              </div>
              <span className="text-sm text-white">WiFi</span>
            </div>
            <span className="text-xs text-gray-400">{rssi} dBm ({rssiLabel(rssi)})</span>
          </div>
        )}
        {sats !== null && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Satellite className="w-4 h-4 text-sky-400" />
              <span className="text-sm text-white">RTK Satellites</span>
            </div>
            <span className="text-sm font-medium text-white">{sats}</span>
          </div>
        )}
        {locQuality && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Crosshair className="w-4 h-4 text-purple-400" />
              <span className="text-sm text-white">Location Quality</span>
            </div>
            <span className="text-sm font-medium text-white">{locQuality}%</span>
          </div>
        )}
      </div>
    </div>
  );
}
