import {
  Cog, Cpu, AlertTriangle, MapPin,
  Activity, Radio, Gauge, Scissors,
  Clock, Code, Zap, Navigation,
  Wifi, Satellite, BatteryMedium, Signal,
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
    title: 'sensors.connectivity',
    icon: Wifi,
    iconColor: 'text-sky-400',
    fields: [
      { key: 'battery_power', label: 'sensors.battery', unit: '%', icon: BatteryMedium, iconColor: 'text-green-400' },
      { key: 'wifi_rssi', label: 'sensors.wifi', unit: 'dBm', icon: Wifi, iconColor: 'text-sky-400' },
      { key: 'rtk_sat', label: 'sensors.rtkSat', icon: Satellite, iconColor: 'text-sky-400' },
      { key: 'gps_sat_num', label: 'sensors.gpsSat', icon: Satellite, iconColor: 'text-sky-400' },
      { key: 'gps_state', label: 'sensors.gpsState', icon: Signal, iconColor: 'text-sky-400' },
    ],
  },
  {
    title: 'sensors.work',
    icon: Activity,
    iconColor: 'text-emerald-400',
    fields: [
      { key: 'work_status', label: 'sensors.workStatus', icon: Activity, iconColor: 'text-emerald-400' },
      { key: 'mowing_progress', label: 'sensors.progress', unit: '%', icon: Gauge, iconColor: 'text-emerald-400' },
      { key: 'mow_speed', label: 'sensors.speed', icon: Gauge, iconColor: 'text-blue-400' },
      { key: 'covering_area', label: 'sensors.coveringArea', icon: Activity, iconColor: 'text-teal-400' },
      { key: 'finished_area', label: 'sensors.finishedArea', icon: Activity, iconColor: 'text-green-400' },
    ],
  },
  {
    title: 'sensors.hardware',
    icon: Cpu,
    iconColor: 'text-orange-400',
    fields: [
      { key: 'cpu_temperature', label: 'sensors.cpuTemp', unit: '\u00B0C', icon: Cpu, iconColor: 'text-orange-400' },
      { key: 'sw_version', label: 'sensors.firmware', icon: Code, iconColor: 'text-purple-400' },
      { key: 'working_hours', label: 'sensors.workHours', unit: 'h', icon: Clock, iconColor: 'text-blue-400' },
      { key: 'mow_blade_work_time', label: 'sensors.bladeTime', unit: 'h', icon: Scissors, iconColor: 'text-gray-400' },
      { key: 'disk_remaining', label: 'sensors.disk', unit: 'MB', icon: Cpu, iconColor: 'text-gray-400' },
      { key: 'memory_remaining', label: 'sensors.memory', unit: 'MB', icon: Cpu, iconColor: 'text-gray-400' },
    ],
  },
  {
    title: 'sensors.errors',
    icon: AlertTriangle,
    iconColor: 'text-red-400',
    fields: [
      { key: 'error_status', label: 'sensors.errorStatus', icon: AlertTriangle, iconColor: 'text-red-400' },
      { key: 'error_msg', label: 'sensors.errorMessage', icon: AlertTriangle, iconColor: 'text-red-400' },
      { key: 'chassis_err', label: 'sensors.chassisError', icon: AlertTriangle, iconColor: 'text-red-400' },
      { key: 'button_stop', label: 'sensors.emergencyStop', icon: Zap, iconColor: 'text-red-500' },
    ],
  },
  {
    title: 'sensors.position',
    icon: MapPin,
    iconColor: 'text-blue-400',
    fields: [
      { key: 'latitude', label: 'Lat', icon: Navigation, iconColor: 'text-blue-400' },
      { key: 'longitude', label: 'Lon', icon: Navigation, iconColor: 'text-blue-400' },
      { key: 'localization_state', label: 'sensors.localization', icon: MapPin, iconColor: 'text-purple-400' },
    ],
  },
  {
    title: 'sensors.config',
    icon: Cog,
    iconColor: 'text-gray-400',
    fields: [
      { key: 'lora_address', label: 'sensors.loraAddress', icon: Radio, iconColor: 'text-sky-400' },
      { key: 'lora_channel', label: 'sensors.loraChannel', icon: Radio, iconColor: 'text-sky-400' },
    ],
  },
];

const CHARGER_GROUPS: SensorGroup[] = [
  {
    title: 'sensors.connectivity',
    icon: Radio,
    iconColor: 'text-sky-400',
    fields: [
      { key: 'gps_satellites', label: 'sensors.gpsSat', icon: Satellite, iconColor: 'text-sky-400' },
      { key: 'rtk_ok', label: 'RTK', icon: Satellite, iconColor: 'text-green-400' },
      { key: 'mower_error', label: 'sensors.loraStatus', icon: Radio, iconColor: 'text-orange-400' },
    ],
  },
  {
    title: 'sensors.status',
    icon: Activity,
    iconColor: 'text-yellow-400',
    fields: [
      { key: 'charger_status', label: 'sensors.chargerStatus', icon: Zap, iconColor: 'text-yellow-400' },
      { key: 'version', label: 'sensors.firmware', icon: Code, iconColor: 'text-purple-400' },
      { key: 'recharge_status', label: 'sensors.recharge', icon: BatteryMedium, iconColor: 'text-blue-400' },
    ],
  },
  {
    title: 'sensors.mowerLora',
    icon: Radio,
    iconColor: 'text-sky-400',
    fields: [
      { key: 'mower_status', label: 'sensors.mowerStatus', icon: Activity, iconColor: 'text-emerald-400' },
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
      { key: 'error_status', label: 'sensors.errorStatus', icon: AlertTriangle, iconColor: 'text-red-400' },
      { key: 'error_msg', label: 'sensors.errorMessage', icon: AlertTriangle, iconColor: 'text-red-400' },
    ],
  },
  {
    title: 'sensors.config',
    icon: Cog,
    iconColor: 'text-gray-400',
    fields: [
      { key: 'lora_address', label: 'sensors.loraAddress', icon: Radio, iconColor: 'text-sky-400' },
      { key: 'lora_channel', label: 'sensors.loraChannel', icon: Radio, iconColor: 'text-sky-400' },
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
    <div className="grid grid-cols-2 gap-1">
      {groups.map(group => {
        const available = group.fields.filter(f => device.sensors[f.key] !== undefined);
        if (available.length === 0) return null;

        // Hide "Mower (LoRa)" when all position values are zero
        if (group.title === 'sensors.mowerLora') {
          const posFields = available.filter(f => ['mower_x', 'mower_y', 'mower_z'].includes(f.key));
          const hasNonZero = posFields.some(f => String(device.sensors[f.key]) !== '0');
          const hasStatus = available.some(f => f.key === 'mower_status' && device.sensors[f.key] !== '0');
          if (!hasNonZero && !hasStatus) return null;
        }

        const GroupIcon = group.icon;
        return [
          <h3 key={`h-${group.title}`} className="col-span-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1 mt-1 first:mt-0">
            <GroupIcon className={`w-3 h-3 ${group.iconColor}`} />
            {t(group.title)}
          </h3>,
          ...available.map(f => (
            <SensorCard
              key={f.key}
              label={t(f.label)}
              value={device.sensors[f.key]}
              unit={f.unit}
              icon={f.icon}
              iconColor={f.iconColor}
            />
          )),
        ];
      })}
    </div>
  );
}
