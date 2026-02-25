import {
  Cog, Cpu, AlertTriangle, MapPin,
  Activity, Radio, Gauge, Scissors, AreaChart, CheckCircle2,
  Clock, Wrench, Code, RotateCcw, Zap, Navigation,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DeviceState } from '../../types';
import { SensorCard } from './SensorCard';

interface FieldDef {
  key: string;
  label: string;
  unit?: string;
  icon?: LucideIcon;
  iconColor?: string;
}

interface SensorGroup {
  title: string;
  icon: LucideIcon;
  iconColor: string;
  fields: FieldDef[];
}

const MOWER_GROUPS: SensorGroup[] = [
  {
    title: 'Work',
    icon: Activity,
    iconColor: 'text-emerald-400',
    fields: [
      { key: 'work_status', label: 'Status', icon: Activity, iconColor: 'text-emerald-400' },
      { key: 'work_mode', label: 'Mode', icon: Cog, iconColor: 'text-gray-400' },
      { key: 'mowing_progress', label: 'Progress', unit: '%', icon: Gauge, iconColor: 'text-emerald-400' },
      { key: 'mow_speed', label: 'Speed', icon: Gauge, iconColor: 'text-blue-400' },
      { key: 'covering_area', label: 'Covering Area', icon: AreaChart, iconColor: 'text-teal-400' },
      { key: 'finished_area', label: 'Finished Area', icon: CheckCircle2, iconColor: 'text-green-400' },
    ],
  },
  {
    title: 'Hardware',
    icon: Cpu,
    iconColor: 'text-orange-400',
    fields: [
      { key: 'cpu_temperature', label: 'CPU Temp', unit: '\u00B0C', icon: Cpu, iconColor: 'text-orange-400' },
      { key: 'mow_blade_work_time', label: 'Blade Time', unit: 's', icon: Scissors, iconColor: 'text-gray-400' },
      { key: 'working_hours', label: 'Work Hours', unit: 'h', icon: Clock, iconColor: 'text-blue-400' },
      { key: 'sw_version', label: 'Firmware', icon: Code, iconColor: 'text-purple-400' },
    ],
  },
  {
    title: 'Errors',
    icon: AlertTriangle,
    iconColor: 'text-red-400',
    fields: [
      { key: 'error_status', label: 'Error Status', icon: AlertTriangle, iconColor: 'text-red-400' },
      { key: 'error_code', label: 'Error Code', icon: AlertTriangle, iconColor: 'text-red-400' },
      { key: 'error_msg', label: 'Error Message', icon: AlertTriangle, iconColor: 'text-red-400' },
      { key: 'chassis_err', label: 'Chassis Error', icon: Wrench, iconColor: 'text-red-400' },
      { key: 'button_stop', label: 'Emergency Stop', icon: Zap, iconColor: 'text-red-500' },
    ],
  },
  {
    title: 'Position',
    icon: MapPin,
    iconColor: 'text-blue-400',
    fields: [
      { key: 'x', label: 'X', icon: Navigation, iconColor: 'text-blue-400' },
      { key: 'y', label: 'Y', icon: Navigation, iconColor: 'text-blue-400' },
      { key: 'z', label: 'Z', icon: Navigation, iconColor: 'text-blue-400' },
      { key: 'localization_state', label: 'Localization', icon: MapPin, iconColor: 'text-purple-400' },
    ],
  },
];

const CHARGER_GROUPS: SensorGroup[] = [
  {
    title: 'Status',
    icon: Activity,
    iconColor: 'text-yellow-400',
    fields: [
      { key: 'charger_status', label: 'Charger Status', icon: Zap, iconColor: 'text-yellow-400' },
      { key: 'mower_status', label: 'Mower Status', icon: Activity, iconColor: 'text-emerald-400' },
      { key: 'mower_error', label: 'LoRa Search', icon: Radio, iconColor: 'text-orange-400' },
      { key: 'recharge_status', label: 'Recharge', icon: RotateCcw, iconColor: 'text-blue-400' },
    ],
  },
  {
    title: 'Work',
    icon: Activity,
    iconColor: 'text-emerald-400',
    fields: [
      { key: 'work_mode', label: 'Mode', icon: Cog, iconColor: 'text-gray-400' },
      { key: 'work_state', label: 'State', icon: Activity, iconColor: 'text-emerald-400' },
      { key: 'work_status', label: 'Status', icon: Activity, iconColor: 'text-emerald-400' },
      { key: 'task_mode', label: 'Task Mode', icon: Cog, iconColor: 'text-gray-400' },
      { key: 'mowing_progress', label: 'Progress', unit: '%', icon: Gauge, iconColor: 'text-emerald-400' },
    ],
  },
  {
    title: 'Mower Position (LoRa)',
    icon: Radio,
    iconColor: 'text-sky-400',
    fields: [
      { key: 'mower_x', label: 'X', icon: Navigation, iconColor: 'text-sky-400' },
      { key: 'mower_y', label: 'Y', icon: Navigation, iconColor: 'text-sky-400' },
      { key: 'mower_z', label: 'Z', icon: Navigation, iconColor: 'text-sky-400' },
    ],
  },
  {
    title: 'Errors',
    icon: AlertTriangle,
    iconColor: 'text-red-400',
    fields: [
      { key: 'error_code', label: 'Error Code', icon: AlertTriangle, iconColor: 'text-red-400' },
      { key: 'error_msg', label: 'Error Message', icon: AlertTriangle, iconColor: 'text-red-400' },
      { key: 'error_status', label: 'Error Status', icon: AlertTriangle, iconColor: 'text-red-400' },
    ],
  },
];

interface Props {
  device: DeviceState;
}

export function SensorGrid({ device }: Props) {
  const groups = device.deviceType === 'mower' ? MOWER_GROUPS : CHARGER_GROUPS;

  return (
    <div className="space-y-4">
      {groups.map(group => {
        const available = group.fields.filter(f => device.sensors[f.key] !== undefined);
        if (available.length === 0) return null;

        const GroupIcon = group.icon;
        return (
          <div key={group.title}>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <GroupIcon className={`w-3.5 h-3.5 ${group.iconColor}`} />
              {group.title}
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {available.map(f => (
                <SensorCard
                  key={f.key}
                  label={f.label}
                  value={device.sensors[f.key]}
                  unit={f.unit}
                  icon={f.icon}
                  iconColor={f.iconColor}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
