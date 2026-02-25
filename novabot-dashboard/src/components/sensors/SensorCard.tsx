import type { LucideIcon } from 'lucide-react';

interface Props {
  label: string;
  value: string;
  unit?: string;
  icon?: LucideIcon;
  iconColor?: string;
}

export function SensorCard({ label, value, unit, icon: Icon, iconColor = 'text-gray-500' }: Props) {
  return (
    <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/50">
      <div className="flex items-center gap-1.5 mb-1">
        {Icon && <Icon className={`w-3.5 h-3.5 ${iconColor}`} />}
        <span className="text-xs text-gray-500">{label}</span>
      </div>
      <span className="text-sm font-medium text-white">
        {value}{unit ? <span className="text-gray-400 ml-1">{unit}</span> : null}
      </span>
    </div>
  );
}
