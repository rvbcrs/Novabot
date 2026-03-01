import { useState, useCallback } from 'react';
import {
  Plug, TreePine, ChevronDown, Terminal, Calendar, Circle,
  BatteryMedium, Satellite, Radio, Activity,
  Wifi, Bluetooth, Trash2, Thermometer, HardDrive, Code,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DeviceState, MqttLogEntry, BleLogEntry, MapData } from '../../types';
import type { OtaProgress } from '../../hooks/useDevices';
import { MowerMap } from '../map/MowerMap';
import { MowerStatus } from '../status/MowerStatus';
import { LogConsole } from '../log/LogConsole';
import { Scheduler } from '../schedule/Scheduler';
import { MowerControls } from './MowerControls';
import { SensorGrid } from '../sensors/SensorGrid';
import { OtaManager } from '../ota/OtaManager';
import { deleteDevice } from '../../api/client';

interface Props {
  devices: Map<string, DeviceState>;
  loading: boolean;
  logs: MqttLogEntry[];
  bleLogs: BleLogEntry[];
  otaProgress: Map<string, OtaProgress>;
}

/** Small stat pill used in the DeviceChip */
function Stat({ icon: Icon, value, color = 'text-gray-400', label }: {
  icon: React.ComponentType<{ className?: string }>;
  value: string | number;
  color?: string;
  label?: string;
}) {
  return (
    <span className="inline-flex items-center gap-0.5" title={label}>
      <Icon className={`w-3 h-3 ${color}`} />
      <span className={`tabular-nums ${color}`}>{value}</span>
    </span>
  );
}

/** Inline device chip for the toolbar */
function DeviceChip({ device, expanded, onToggle, onDelete, otaProgress }: {
  device: DeviceState;
  expanded: boolean;
  onToggle: () => void;
  onDelete?: (sn: string) => void;
  otaProgress?: OtaProgress;
}) {
  const { t } = useTranslation();
  const s = device.sensors;
  const isCharger = device.deviceType === 'charger';
  const battery = parseInt(s.battery_power ?? s.battery_capacity ?? '0', 10);

  // Charger: virtuele velden uit charger_status (geëxtraheerd door server)
  const gpsSats = parseInt(s.gps_satellites ?? '0', 10);
  const rtkOk = s.rtk_ok === '1';

  // Mower: directe sensoren
  const mowerSats = parseInt(s.rtk_sat ?? '0', 10);
  const wifiRssi = parseInt(s.wifi_rssi ?? '0', 10);
  const cpuTemp = parseInt(s.cpu_temperature ?? '0', 10);

  const hasSensorData = Object.keys(s).length > 0;

  return (
    <div className="relative">
      <button
        onClick={onToggle}
        className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs transition-colors ${
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
          {device.nickname ?? (isCharger ? t('sidebar.charger') : t('sidebar.mower'))}
        </span>
        <Circle className={`w-2.5 h-2.5 fill-current ${device.online ? 'text-green-500' : 'text-gray-600'}`} />

        {hasSensorData && (
          <>
            <span className="text-gray-700">|</span>

            {/* Battery (both devices) */}
            {battery > 0 && (
              <Stat icon={BatteryMedium} value={`${battery}%`}
                color={battery > 20 ? 'text-green-400' : 'text-red-400'}
                label={t('devices.batteryLabel', { pct: battery })} />
            )}

            {/* Charger inline stats */}
            {isCharger && (
              <>
                <Stat icon={Satellite} value={gpsSats}
                  color={gpsSats > 0 ? 'text-sky-400' : 'text-gray-600'}
                  label={t('devices.gpsSatellites', { sats: gpsSats })} />
                <span className={`text-[10px] font-medium ${rtkOk ? 'text-green-400' : 'text-gray-600'}`}>
                  RTK{rtkOk ? '\u2713' : '\u2014'}
                </span>
                {s.mower_error && parseInt(s.mower_error) > 0 && (
                  <Stat icon={Radio} value={s.mower_error} color="text-orange-400" label={t('devices.loraSearch')} />
                )}
              </>
            )}

            {/* Mower inline stats */}
            {!isCharger && (
              <>
                {mowerSats > 0 && (
                  <Stat icon={Satellite} value={mowerSats}
                    color={mowerSats >= 15 ? 'text-sky-400' : mowerSats >= 8 ? 'text-yellow-400' : 'text-red-400'}
                    label={t('devices.rtkLabel', { sats: mowerSats })} />
                )}
                {wifiRssi !== 0 && (
                  <Stat icon={Wifi} value={`${wifiRssi}dB`}
                    color={Math.abs(wifiRssi) < 60 ? 'text-green-400' : Math.abs(wifiRssi) < 75 ? 'text-yellow-400' : 'text-red-400'}
                    label={t('devices.wifiLabel', { rssi: wifiRssi })} />
                )}
                {cpuTemp > 0 && (
                  <Stat icon={Thermometer} value={`${cpuTemp}\u00b0`}
                    color={cpuTemp < 50 ? 'text-gray-400' : cpuTemp < 65 ? 'text-yellow-400' : 'text-red-400'}
                    label={`CPU: ${cpuTemp}\u00b0C`} />
                )}
                {s.work_status && s.work_status !== '0' && (
                  <Stat icon={Activity} value={s.work_status} color="text-emerald-400" label={t('devices.workStatus')} />
                )}
                {s.sw_version && (
                  <span className="text-gray-600 text-[10px] truncate max-w-[48px]">{s.sw_version}</span>
                )}
              </>
            )}
          </>
        )}

        {!hasSensorData && device.online && (
          <span className="text-gray-600 text-[10px] italic">{t('devices.waitingForData')}</span>
        )}

        {/* OTA progress indicator in chip */}
        {otaProgress && (Date.now() - otaProgress.timestamp < 120_000) && (
          <>
            <span className="text-gray-700">|</span>
            <span className={`text-[10px] font-medium ${
              otaProgress.status === 'success' ? 'text-emerald-400' :
              otaProgress.status === 'failed' ? 'text-red-400' :
              'text-orange-400 animate-pulse'
            }`}>
              <HardDrive className="w-3 h-3 inline mr-0.5" />
              {otaProgress.status === 'upgrade' ? 'OTA' : otaProgress.status === 'success' ? 'OTA OK' : otaProgress.status === 'failed' ? 'OTA FAIL' : 'OTA'}
              {otaProgress.percentage != null && ` ${otaProgress.percentage.toFixed(0)}%`}
            </span>
          </>
        )}

        <ChevronDown className={`w-3 h-3 text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {/* Sensor detail dropdown */}
      {expanded && (
        <div className="absolute top-full left-0 mt-1 w-[420px] z-[10000] bg-gray-800 rounded-lg border border-gray-700 shadow-xl p-3 max-h-96 overflow-auto">
          {/* Header with SN + actions */}
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 font-mono">{device.sn}</span>
              {device.macAddress && (
                <span className="inline-flex items-center gap-1 text-[10px] text-gray-600">
                  <Bluetooth className="w-2.5 h-2.5" />
                  {device.macAddress}
                </span>
              )}
            </div>
            {onDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(device.sn); }}
                className="text-gray-600 hover:text-red-400 transition-colors p-1 rounded hover:bg-gray-700"
                title={t('devices.removeTitle')}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Quick info row */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] mb-3 pb-2 border-b border-gray-700">
            <span className={device.online ? 'text-green-400' : 'text-gray-600'}>
              {device.online ? t('common.online') : t('common.offline')}
            </span>
            {(s.sw_version || s.version) && (
              <span className="inline-flex items-center gap-1 text-purple-400">
                <Code className="w-3 h-3" />
                {s.sw_version ?? s.version}
              </span>
            )}
            {device.lastSeen && (
              <span className="text-gray-600">
                {t('devices.lastSeen', { time: new Date(device.lastSeen + 'Z').toLocaleString() })}
              </span>
            )}
            {s.localization_state && (
              <span className="text-gray-500">{t('devices.locState', { state: s.localization_state })}</span>
            )}
            {s.battery_state && (
              <span className="text-gray-500">{s.battery_state}</span>
            )}
          </div>

          {/* Full sensor grid */}
          <SensorGrid device={device} />
        </div>
      )}
    </div>
  );
}

export function DashboardPage({ devices, loading, logs, bleLogs, otaProgress }: Props) {
  const { t } = useTranslation();
  const [logOpen, setLogOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [otaOpen, setOtaOpen] = useState(false);
  const [pathDirPreview, setPathDirPreview] = useState<number | null>(null);
  const [expandedChip, setExpandedChip] = useState<string | null>(null);
  const [pendingPolygon, setPendingPolygon] = useState<{ mapId: string; mapName: string; mapArea: Array<{ lat: number; lng: number }> } | null>(null);

  const handleMapSaved = useCallback((map: MapData) => {
    if (map.mapArea.length >= 3) {
      setPendingPolygon({ mapId: map.mapId, mapName: map.mapName ?? map.mapId, mapArea: map.mapArea });
    }
  }, []);

  const handleDeleteDevice = useCallback(async (sn: string) => {
    if (!confirm(t('devices.confirmRemove', { sn }))) return;
    await deleteDevice(sn);
    setExpandedChip(null);
    window.location.reload();
  }, [t]);

  const sorted = Array.from(devices.values()).sort((a, b) => {
    if (a.deviceType !== b.deviceType) return a.deviceType === 'charger' ? -1 : 1;
    return a.sn.localeCompare(b.sn);
  });

  const mower = sorted.find(d => d.deviceType === 'mower');
  const charger = sorted.find(d => d.deviceType === 'charger');

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-gray-500">{t('devices.loading')}</p>
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
            <span className="text-xs text-gray-500">{t('devices.waitingForDevices')}</span>
          )}
          {sorted.map(device => (
            <DeviceChip
              key={device.sn}
              device={device}
              expanded={expandedChip === device.sn}
              onToggle={() => setExpandedChip(expandedChip === device.sn ? null : device.sn)}
              onDelete={handleDeleteDevice}
              otaProgress={otaProgress.get(device.sn)}
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
              pendingPolygon={pendingPolygon}
              onStarted={() => setPendingPolygon(null)}
            />
          )}
          {mower && (
            <button
              onClick={() => { setScheduleOpen(!scheduleOpen); if (scheduleOpen) setPathDirPreview(null); setOtaOpen(false); }}
              className={`inline-flex items-center gap-1.5 text-xs h-7 px-2.5 rounded transition-colors ${
                scheduleOpen ? 'bg-blue-600 text-white' : 'bg-gray-700/60 text-gray-400 hover:text-white'
              }`}
            >
              <Calendar className="w-3.5 h-3.5" />
              {t('devices.schedule')}
            </button>
          )}
          <button
            onClick={() => { setOtaOpen(!otaOpen); setScheduleOpen(false); setPathDirPreview(null); }}
            className={`inline-flex items-center gap-1.5 text-xs h-7 px-2.5 rounded transition-colors ${
              otaOpen ? 'bg-orange-600 text-white' : 'bg-gray-700/60 text-gray-400 hover:text-white'
            }`}
            title="Firmware updates"
          >
            <HardDrive className="w-3.5 h-3.5" />
            OTA
          </button>
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
            onMapSaved={handleMapSaved}
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
        {/* OTA side panel */}
        {otaOpen && (
          <div className="w-80 flex-shrink-0 overflow-auto border-l border-gray-800">
            <OtaManager devices={devices} otaProgress={otaProgress} />
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
            <span className="text-xs text-gray-400">{t('log.title')}</span>
            <span className="text-[10px] text-gray-600 font-mono">{logs.length}</span>
            {bleLogs.length > 0 && (
              <>
                <Bluetooth className="w-3 h-3 text-blue-400 ml-1" />
                <span className="text-[10px] text-gray-600 font-mono">{bleLogs.length}</span>
              </>
            )}
          </div>
          <ChevronDown className={`w-3.5 h-3.5 text-gray-500 transition-transform ${logOpen ? 'rotate-180' : ''}`} />
        </button>
        {logOpen && (
          <div className="h-[calc(100%-2rem)] px-4 pb-2">
            <LogConsole logs={logs} bleLogs={bleLogs} />
          </div>
        )}
      </div>
    </div>
  );
}
