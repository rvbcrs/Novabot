import { useState, useEffect } from 'react';
import { Plug, TreePine, ChevronDown, ChevronUp, Terminal } from 'lucide-react';
import type { DeviceState, MqttLogEntry } from '../../types';
import { Sidebar } from '../layout/Sidebar';
import { MowerMap } from '../map/MowerMap';
import { MowerStatus } from '../status/MowerStatus';
import { ChargerStatus } from '../status/ChargerStatus';
import { StatusBadge } from '../common/StatusBadge';
import { TimeSince } from '../common/TimeSince';
import { LogConsole } from '../log/LogConsole';

interface Props {
  devices: Map<string, DeviceState>;
  loading: boolean;
  logs: MqttLogEntry[];
}

export function DashboardPage({ devices, loading, logs }: Props) {
  const [selectedSn, setSelectedSn] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  // Auto-select first device
  useEffect(() => {
    if (!selectedSn && devices.size > 0) {
      setSelectedSn(devices.keys().next().value!);
    }
  }, [selectedSn, devices.size]);

  const selected = selectedSn ? devices.get(selectedSn) : null;
  const isMower = selected?.deviceType === 'mower';

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-gray-500">Loading devices...</p>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-64px)]">
      <Sidebar devices={devices} selectedSn={selectedSn} onSelect={setSelectedSn} />

      {/* Main content: device view + log console stacked vertically */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Device panel */}
        <main className={`flex-1 min-h-0 p-6 ${isMower ? 'flex flex-col overflow-hidden' : 'overflow-auto'}`}>
          {selected ? (
            <div className={isMower ? 'flex flex-col flex-1 min-h-0' : 'space-y-4'}>
              {/* Device header */}
              <div className={`flex items-center justify-between flex-shrink-0 ${isMower ? 'mb-2' : ''}`}>
                <div className="flex items-center gap-3">
                  {selected.deviceType === 'charger' ? (
                    <Plug className="w-5 h-5 text-yellow-500" />
                  ) : (
                    <TreePine className="w-5 h-5 text-emerald-500" />
                  )}
                  <h1 className="text-lg font-semibold text-white">
                    {selected.deviceType === 'charger' ? 'Charger' : 'Mower'}
                  </h1>
                  <span className="text-sm text-gray-500 font-mono">{selected.sn}</span>
                  <StatusBadge online={selected.online} />
                </div>
                <TimeSince timestamp={selected.lastUpdate} />
              </div>

              {/* Mower: full-height map with status overlay */}
              {isMower && (
                <div className="relative flex-1 min-h-0 flex flex-col">
                  <MowerMap
                    sn={selected.sn}
                    lat={selected.sensors.latitude}
                    lng={selected.sensors.longitude}
                    signals={{
                      wifiRssi: selected.sensors.wifi_rssi,
                      rtkSat: selected.sensors.rtk_sat,
                      locQuality: selected.sensors.loc_quality,
                      batteryPower: selected.sensors.battery_power ?? selected.sensors.battery_capacity,
                      batteryState: selected.sensors.battery_state,
                    }}
                    mowing={{
                      mowingProgress: selected.sensors.mowing_progress,
                      coveringArea: selected.sensors.covering_area,
                      finishedArea: selected.sensors.finished_area,
                      workStatus: selected.sensors.work_status,
                      mowSpeed: selected.sensors.mow_speed,
                      covDirection: selected.sensors.cov_direction,
                    }}
                  />
                  {/* Sensor tiles floating on map */}
                  <div className="absolute bottom-0 left-0 right-0 z-[1000] max-h-[50%] overflow-auto p-4 pointer-events-none">
                    <div className="pointer-events-auto">
                      <MowerStatus device={selected} overlay />
                    </div>
                  </div>
                </div>
              )}

              {/* Charger: just status */}
              {selected.deviceType === 'charger' && (
                <ChargerStatus device={selected} />
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-gray-500">
                {devices.size === 0
                  ? 'No devices connected. Waiting for MQTT data...'
                  : 'Select a device from the sidebar'}
              </p>
            </div>
          )}
        </main>

        {/* Log console — collapsible */}
        <div className={`flex-shrink-0 border-t border-gray-800 transition-all duration-200 ${logOpen ? 'h-56' : 'h-8'}`}>
          {/* Toggle bar */}
          <button
            onClick={() => setLogOpen(!logOpen)}
            className="w-full flex items-center justify-between px-4 h-8 hover:bg-gray-800/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Terminal className="w-3.5 h-3.5 text-green-400" />
              <span className="text-xs text-gray-400">MQTT Log</span>
              <span className="text-[10px] text-gray-600 font-mono">{logs.length}</span>
            </div>
            {logOpen ? (
              <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
            ) : (
              <ChevronUp className="w-3.5 h-3.5 text-gray-500" />
            )}
          </button>
          {/* Log content */}
          {logOpen && (
            <div className="h-[calc(100%-2rem)] px-4 pb-2">
              <LogConsole logs={logs} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
