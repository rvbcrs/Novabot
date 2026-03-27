import type { DeviceMode } from '../App.tsx';

interface Props {
  onSelect: (mode: DeviceMode) => void;
}

const CHOICES: Array<{ mode: DeviceMode; icon: string; title: string; description: string }> = [
  {
    mode: 'charger',
    icon: '\u26A1',
    title: 'Charger Only',
    description: 'Set up a charging station (ESP32). Configure WiFi, MQTT, and optionally flash firmware.',
  },
  {
    mode: 'mower',
    icon: '\uD83E\uDD16',
    title: 'Mower Only',
    description: 'Set up a Novabot mower. Configure WiFi, MQTT, and optionally flash firmware.',
  },
  {
    mode: 'both',
    icon: '\uD83D\uDD27',
    title: 'Both',
    description: 'Set up charger and mower together in one flow. Recommended for first-time setup.',
  },
];

export default function DeviceChoice({ onSelect }: Props) {
  return (
    <div className="glass-card p-8">
      <h2 className="text-xl font-bold text-white mb-2">Choose Device</h2>
      <p className="text-gray-400 mb-6 text-sm">
        What would you like to set up? Select the device type to continue.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {CHOICES.map(({ mode, icon, title, description }) => (
          <button
            key={mode}
            onClick={() => onSelect(mode)}
            className="flex flex-col items-center gap-3 py-8 px-5 bg-gray-800/40 hover:bg-emerald-900/30 border border-gray-700 hover:border-emerald-600 text-white rounded-xl transition-all duration-200 group"
          >
            <span className="text-4xl group-hover:scale-110 transition-transform">{icon}</span>
            <span className="font-semibold text-base">{title}</span>
            <span className="text-gray-500 text-xs text-center leading-relaxed group-hover:text-gray-400 transition-colors">
              {description}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
