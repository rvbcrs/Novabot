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
    <div className="bg-gray-800/60 rounded px-1.5 py-0.5 border border-gray-700/60 flex items-center gap-1 min-w-0" title={`${label}: ${value}${unit ?? ''}`}>
      {Icon && <Icon className={`w-2.5 h-2.5 ${iconColor} flex-shrink-0`} />}
      <span className="text-[9px] text-gray-500 truncate">{label}</span>
      <span className="text-[10px] font-semibold text-white whitespace-nowrap ml-auto">
        {value}{unit ? <span className="text-gray-500 text-[9px]">{unit}</span> : null}
      </span>
    </div>
  );
}
