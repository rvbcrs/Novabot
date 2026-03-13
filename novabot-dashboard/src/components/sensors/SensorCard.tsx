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
    <div className="bg-gray-800/50 rounded px-2 py-1 border border-gray-700/50 flex items-center gap-1.5 min-w-0">
      {Icon && <Icon className={`w-3 h-3 ${iconColor} flex-shrink-0`} />}
      <div className="min-w-0">
        <div className="text-[9px] text-gray-500 leading-tight truncate">{label}</div>
        <span className="text-[11px] font-medium text-white leading-tight">
          {value}{unit ? <span className="text-gray-400 ml-0.5 text-[10px]">{unit}</span> : null}
        </span>
      </div>
    </div>
  );
}
