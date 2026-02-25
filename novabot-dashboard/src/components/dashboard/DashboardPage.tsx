import { useState } from 'react';
import {
  Plug, TreePine, ChevronDown, Terminal, Calendar, Circle,
  BatteryMedium, Satellite, Radio, Activity, Gauge, Cpu, Code,
} from 'lucide-react';
import type { DeviceState, MqttLogEntry } from '../../types';
import { MowerMap } from '../map/MowerMap';
import { MowerStatus } from '../status/MowerStatus';
import { LogConsole } from '../log/LogConsole';
import { Scheduler } from '../schedule/Scheduler';
import { MowerControls } from './MowerControls';
import { SensorGrid } from '../sensors/SensorGrid';

interface Props {
  devices: Map<string, DeviceState>;
  loading: boolean;
  logs: MqttLogEntry[];
}

/** Inline device chip for the toolbar */
function DeviceChip({ device, expanded, onToggle }: {
  device: DeviceState;
  expanded: boolean;
  onToggle: () => void;
}) {
  const s = device.sensors;
  const isCharger = device.deviceType === 'charger';
  const battery = parseInt(s.battery_power ?? s.battery_capacity ?? '0', 10);

  // Parse charger_status bitfield
  const chargerStatus = parseInt(s.charger_status ?? '0', 10);
  const gpsSats = (chargerStatus >> 24) & 0xFF;
  const rtkOk = (chargerStatus & 0x100) !== 0;

  return (
    <div className="relative">
      <button
        onClick={onToggle}
        className={`inline-flex items-center gap-2 h-8 px-2.5 rounded-md text-xs transition-colors ${
          expanded
            ? 'bg-gray-700 border border-gray-600'
            : 'hover:bg-gray-800 border border-transparent'
        }`}
      >
        {/* Icon + name + online dot */}
        {isCharger ? (
          <Plug className="w-3.5 h-3.5 text-yellow-500 flex-shrink-0" />
        ) : (
          <TreePine className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
        )}
        <span className="text-gray-300 font-medium">
          {device.nickname ?? (isCharger ? 'Charger' : 'Mower')}
        </span>
        <Circle className={`w-2.5 h-2.5 fill-current ${device.online ? 'text-green-500' : 'text-gray-600'}`} />

        {/* Key stats inline */}
        <span className="text-gray-600">|</span>

        {/* Battery */}
        {battery > 0 && (
          <span className="inline-flex items-center gap-1">
            <BatteryMedium className="w-3 h-3 text-gray-500" />
            <span className="text-gray-400 tabular-nums">{battery}%</span>
          </span>
        )}

        {/* Charger stats */}
        {isCharger && (
          <>
            <span className="inline-flex items-center gap-0.5">
              <Satellite className="w-3 h-3 text-sky-400" />
              <span className={`tabular-nums ${gpsSats > 0 ? 'text-sky-400' : 'text-gray-600'}`}>{gpsSats}</span>
            </span>
            <span className={`text-[10px] font-medium ${rtkOk ? 'text-green-400' : 'text-gray-600'}`}>
              RTK{rtkOk ? '✓' : '—'}
            </span>
            {s.mower_error && parseInt(s.mower_error) > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <Radio className="w-3 h-3 text-orange-400" />
                <span className="text-orange-400 tabular-nums">{s.mower_error}</span>
              </span>
            )}
          </>
        )}

        {/* Mower stats */}
        {!isCharger && (
          <>
            {s.work_status && (
              <span className="inline-flex items-center gap-0.5">
                <Activity className="w-3 h-3 text-emerald-400" />
                <span className="text-gray-300 truncate max-w-[50px]">{s.work_status}</span>
              </span>
            )}
            {s.mowing_progress && parseInt(s.mowing_progress) > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <Gauge className="w-3 h-3 text-emerald-400" />
                <span className="text-emerald-400 tabular-nums">{s.mowing_progress}%</span>
              </span>
            )}
            {s.cpu_temperature && (
              <span className="inline-flex items-center gap-0.5">
                <Cpu className="w-3 h-3 text-orange-400" />
                <span className="text-gray-400 tabular-nums">{s.cpu_temperature}°</span>
              </span>
            )}
            {s.sw_version && (
              <span className="inline-flex items-center gap-0.5">
                <Code className="w-3 h-3 text-purple-400" />
                <span className="text-gray-500 truncate max-w-[48px]">{s.sw_version}</span>
              </span>
            )}
          </>
        )}

        <ChevronDown className={`w-3 h-3 text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {/* Sensor detail dropdown */}
      {expanded && (
        <div className="absolute top-full left-0 mt-1 w-96 z-[10000] bg-gray-800 rounded-lg border border-gray-700 shadow-xl p-3 max-h-80 overflow-auto">
          <div className="text-[10px] text-gray-500 font-mono mb-2">{device.sn}</div>
          <SensorGrid device={device} />
        </div>
      )}
    </div>
  );
}

export function DashboardPage({ devices, loading, logs }: Props) {
  const [logOpen, setLogOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [pathDirPreview, setPathDirPreview] = useState<number | null>(null);
  const [expandedChip, setExpandedChip] = useState<string | null>(null);

  const sorted = Array.from(devices.values()).sort((a, b) => {
    if (a.deviceType !== b.deviceType) return a.deviceType === 'charger' ? -1 : 1;
    return a.sn.localeCompare(b.sn);
  });

  const mower = sorted.find(d => d.deviceType === 'mower');
  const charger = sorted.find(d => d.deviceType === 'charger');

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-gray-500">Loading devices...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      {/* Toolbar */}
      <div className="flex-shrink-0 h-10 flex items-center justify-between px-3 border-b border-gray-800 bg-gray-900/80">
        {/* Left: device chips */}
        <div className="flex items-center gap-1">
          {sorted.length === 0 && (
            <span className="text-xs text-gray-500">Waiting for devices...</span>
          )}
          {sorted.map(device => (
            <DeviceChip
              key={device.sn}
              device={device}
              expanded={expandedChip === device.sn}
              onToggle={() => setExpandedChip(expandedChip === device.sn ? null : device.sn)}
            />
          ))}
        </div>

        {/* Right: mower controls + schedule */}
        <div className="flex items-center gap-2">
          {mower && (
            <MowerControls
              sn={mower.sn}
              online={mower.online}
              onPathDirectionChange={setPathDirPreview}
            />
          )}
          {mower && (
            <button
              onClick={() => { setScheduleOpen(!scheduleOpen); if (scheduleOpen) setPathDirPreview(null); }}
              className={`inline-flex items-center gap-1.5 text-xs h-7 px-2.5 rounded transition-colors ${
                scheduleOpen ? 'bg-blue-600 text-white' : 'bg-gray-700/60 text-gray-400 hover:text-white'
              }`}
            >
              <Calendar className="w-3.5 h-3.5" />
              Schema
            </button>
          )}
        </div>
      </div>

      {/* Map + scheduler panel */}
      <div className="flex-1 min-h-0 flex">
        {/* Map */}
        <div className="relative flex-1 min-h-0 flex flex-col">
          <MowerMap
            sn={mower?.sn ?? ''}
            lat={mower?.sensors.latitude}
            lng={mower?.sensors.longitude}
            heading={mower?.sensors.z ?? mower?.sensors.mower_z}
            signals={{
              wifiRssi: mower?.sensors.wifi_rssi,
              rtkSat: mower?.sensors.rtk_sat,
              locQuality: mower?.sensors.loc_quality,
              batteryPower: mower?.sensors.battery_power ?? mower?.sensors.battery_capacity,
              batteryState: mower?.sensors.battery_state,
            }}
            mowing={{
              mowingProgress: mower?.sensors.mowing_progress,
              coveringArea: mower?.sensors.covering_area,
              finishedArea: mower?.sensors.finished_area,
              workStatus: mower?.sensors.work_status,
              mowSpeed: mower?.sensors.mow_speed,
              covDirection: mower?.sensors.cov_direction,
            }}
            chargerLat={charger?.sensors.latitude}
            chargerLng={charger?.sensors.longitude}
            pathDirectionPreview={pathDirPreview}
          />
          {/* Mower sensor overlay on map */}
          {mower && (
            <div className="absolute bottom-0 left-0 right-0 z-[1000] max-h-[50%] overflow-auto p-4 pointer-events-none">
              <div className="pointer-events-auto">
                <MowerStatus device={mower} overlay />
              </div>
            </div>
          )}
        </div>
        {/* Scheduler side panel */}
        {scheduleOpen && mower && (
          <div className="w-80 flex-shrink-0 overflow-auto border-l border-gray-800">
            <Scheduler sn={mower.sn} online={mower.online} onPathDirectionChange={setPathDirPreview} />
          </div>
        )}
      </div>

      {/* Log console */}
      <div className={`flex-shrink-0 border-t border-gray-800 transition-all duration-200 ${logOpen ? 'h-56' : 'h-8'}`}>
        <button
          onClick={() => setLogOpen(!logOpen)}
          className="w-full flex items-center justify-between px-4 h-8 hover:bg-gray-800/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5 text-green-400" />
            <span className="text-xs text-gray-400">MQTT Log</span>
            <span className="text-[10px] text-gray-600 font-mono">{logs.length}</span>
          </div>
          <ChevronDown className={`w-3.5 h-3.5 text-gray-500 transition-transform ${logOpen ? 'rotate-180' : ''}`} />
        </button>
        {logOpen && (
          <div className="h-[calc(100%-2rem)] px-4 pb-2">
            <LogConsole logs={logs} />
          </div>
        )}
      </div>
    </div>
  );
}
