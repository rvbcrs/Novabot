import type { LucideIcon } from 'lucide-react';

interface Props {
  label: string;
  value: string;
  unit?: string;
  icon?: LucideIcon;
  iconColor?: string;
  wide?: boolean;
}

export function SensorCard({ label, value, unit, icon: Icon, iconColor = 'text-gray-500', wide }: Props) {
  return (
    <div className={`bg-gray-800/60 rounded px-2 py-1 border border-gray-700/50 min-w-0${wide ? ' col-span-2' : ''}`}>
      <div className="text-[8px] text-gray-500 leading-none truncate mb-0.5">{label}</div>
      <div className="flex items-center gap-1">
        {Icon && <Icon className={`w-3 h-3 ${iconColor} flex-shrink-0`} />}
        <span className={`font-semibold text-white leading-tight ${wide ? 'text-[10px] truncate' : 'text-xs'}`}>
          {value}{unit ? <span className="text-gray-400 ml-0.5 text-[10px]">{unit}</span> : null}
        </span>
      </div>
    </div>
  );
}
