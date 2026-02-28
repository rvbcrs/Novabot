import {
  Cog, Cpu, AlertTriangle, MapPin,
  Activity, Radio, Gauge, Scissors, AreaChart, CheckCircle2,
  Clock, Wrench, Code, RotateCcw, Zap, Navigation,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
    title: 'sensors.work',
    icon: Activity,
    iconColor: 'text-emerald-400',
    fields: [
      { key: 'work_status', label: 'sensors.workStatus', icon: Activity, iconColor: 'text-emerald-400' },
      { key: 'work_mode', label: 'sensors.mode', icon: Cog, iconColor: 'text-gray-400' },
      { key: 'mowing_progress', label: 'sensors.progress', unit: '%', icon: Gauge, iconColor: 'text-emerald-400' },
      { key: 'mow_speed', label: 'sensors.speed', icon: Gauge, iconColor: 'text-blue-400' },
      { key: 'covering_area', label: 'sensors.coveringArea', icon: AreaChart, iconColor: 'text-teal-400' },
      { key: 'finished_area', label: 'sensors.finishedArea', icon: CheckCircle2, iconColor: 'text-green-400' },
    ],
  },
  {
    title: 'sensors.hardware',
    icon: Cpu,
    iconColor: 'text-orange-400',
    fields: [
      { key: 'cpu_temperature', label: 'sensors.cpuTemp', unit: '\u00B0C', icon: Cpu, iconColor: 'text-orange-400' },
      { key: 'mow_blade_work_time', label: 'sensors.bladeTime', unit: 's', icon: Scissors, iconColor: 'text-gray-400' },
      { key: 'working_hours', label: 'sensors.workHours', unit: 'h', icon: Clock, iconColor: 'text-blue-400' },
      { key: 'sw_version', label: 'sensors.firmware', icon: Code, iconColor: 'text-purple-400' },
    ],
  },
  {
    title: 'sensors.errors',
    icon: AlertTriangle,
    iconColor: 'text-red-400',
    fields: [
      { key: 'error_status', label: 'sensors.errorStatus', icon: AlertTriangle, iconColor: 'text-red-400' },
      { key: 'error_code', label: 'sensors.errorCode', icon: AlertTriangle, iconColor: 'text-red-400' },
      { key: 'error_msg', label: 'sensors.errorMessage', icon: AlertTriangle, iconColor: 'text-red-400' },
      { key: 'chassis_err', label: 'sensors.chassisError', icon: Wrench, iconColor: 'text-red-400' },
      { key: 'button_stop', label: 'sensors.emergencyStop', icon: Zap, iconColor: 'text-red-500' },
    ],
  },
  {
    title: 'sensors.position',
    icon: MapPin,
    iconColor: 'text-blue-400',
    fields: [
      { key: 'x', label: 'X', icon: Navigation, iconColor: 'text-blue-400' },
      { key: 'y', label: 'Y', icon: Navigation, iconColor: 'text-blue-400' },
      { key: 'z', label: 'Z', icon: Navigation, iconColor: 'text-blue-400' },
      { key: 'localization_state', label: 'sensors.localization', icon: MapPin, iconColor: 'text-purple-400' },
    ],
  },
];

const CHARGER_GROUPS: SensorGroup[] = [
  {
    title: 'sensors.status',
    icon: Activity,
    iconColor: 'text-yellow-400',
    fields: [
      { key: 'charger_status', label: 'sensors.chargerStatus', icon: Zap, iconColor: 'text-yellow-400' },
      { key: 'mower_error', label: 'sensors.loraSearch', icon: Radio, iconColor: 'text-orange-400' },
      { key: 'recharge_status', label: 'sensors.recharge', icon: RotateCcw, iconColor: 'text-blue-400' },
    ],
  },
  {
    title: 'sensors.work',
    icon: Activity,
    iconColor: 'text-emerald-400',
    fields: [
      { key: 'work_mode', label: 'sensors.mode', icon: Cog, iconColor: 'text-gray-400' },
      { key: 'work_state', label: 'sensors.state', icon: Activity, iconColor: 'text-emerald-400' },
      { key: 'work_status', label: 'sensors.workStatus', icon: Activity, iconColor: 'text-emerald-400' },
      { key: 'task_mode', label: 'sensors.taskMode', icon: Cog, iconColor: 'text-gray-400' },
      { key: 'mowing_progress', label: 'sensors.progress', unit: '%', icon: Gauge, iconColor: 'text-emerald-400' },
    ],
  },
  {
    title: 'sensors.mowerPositionLora',
    icon: Radio,
    iconColor: 'text-sky-400',
    fields: [
      { key: 'mower_x', label: 'X', icon: Navigation, iconColor: 'text-sky-400' },
      { key: 'mower_y', label: 'Y', icon: Navigation, iconColor: 'text-sky-400' },
      { key: 'mower_z', label: 'Z', icon: Navigation, iconColor: 'text-sky-400' },
    ],
  },
  {
    title: 'sensors.errors',
    icon: AlertTriangle,
    iconColor: 'text-red-400',
    fields: [
      { key: 'error_code', label: 'sensors.errorCode', icon: AlertTriangle, iconColor: 'text-red-400' },
      { key: 'error_msg', label: 'sensors.errorMessage', icon: AlertTriangle, iconColor: 'text-red-400' },
      { key: 'error_status', label: 'sensors.errorStatus', icon: AlertTriangle, iconColor: 'text-red-400' },
    ],
  },
];

interface Props {
  device: DeviceState;
}

export function SensorGrid({ device }: Props) {
  const { t } = useTranslation();
  const groups = device.deviceType === 'mower' ? MOWER_GROUPS : CHARGER_GROUPS;

  return (
    <div className="space-y-4">
      {groups.map(group => {
        const available = group.fields.filter(f => device.sensors[f.key] !== undefined);
        if (available.length === 0) return null;

        // Hide "Mower Position (LoRa)" when all values are zero (no mower communicating)
        if (group.title === 'sensors.mowerPositionLora') {
          const hasNonZero = available.some(f => String(device.sensors[f.key]) !== '0');
          if (!hasNonZero) return null;
        }

        const GroupIcon = group.icon;
        return (
          <div key={group.title}>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <GroupIcon className={`w-3.5 h-3.5 ${group.iconColor}`} />
              {t(group.title)}
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {available.map(f => (
                <SensorCard
                  key={f.key}
                  label={t(f.label)}
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
