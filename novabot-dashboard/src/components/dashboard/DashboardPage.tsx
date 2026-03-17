import { useState, useCallback } from 'react';
import {
  Plug, TreePine, ChevronDown, Terminal, Calendar, Circle,
  BatteryMedium, Satellite, Radio, Activity,
  Wifi, Bluetooth, Trash2, Thermometer, HardDrive, Code, Octagon, Settings,
  Map as MapIcon, Camera, Save, StopCircle, X, Gamepad2, SlidersHorizontal,
  ClipboardList, BarChart3, Menu, Lock,
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
import { SetupWizard } from '../setup/SetupWizard';
import { CameraStream } from './CameraStream';
import { JoystickControl } from './JoystickControl';
import { UnboundDevices } from './UnboundDevices';
import { MobileDrawer } from '../common/MobileDrawer';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { SettingsPanel } from '../settings/SettingsPanel';
import { WorkHistory } from '../history/WorkHistory';
import { SignalChart } from '../charts/SignalChart';
import { deleteDevice, sendCommand, pinVerify, dockAndSave } from '../../api/client';
import { PinKeypad } from './PinKeypad';
import { RainOverlay } from './RainOverlay';
import { useToast } from '../common/Toast';
import type { PatternPlacement } from '../patterns/PatternOverlay';

interface Props {
  devices: Map<string, DeviceState>;
  loading: boolean;
  logs: MqttLogEntry[];
  bleLogs: BleLogEntry[];
  otaProgress: Map<string, OtaProgress>;
  liveOutlines: Map<string, Array<{ lat: number; lng: number }>>;
  coveredLanes: Map<string, Array<{ lat1: number; lng1: number; lat2: number; lng2: number }>>;
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
  const loraRaw = s.mower_error;
  const loraKnown = loraRaw != null;
  const loraOk = loraRaw === 'OK' || loraRaw === '0';
  const loraCount = parseInt(loraRaw?.match(/\((\d+)\)/)?.[1] ?? '', 10);
  const loraSearching = !isNaN(loraCount) && loraCount > 0;

  // Mower: directe sensoren
  const mowerSats = parseInt(s.rtk_sat ?? '0', 10);
  const mowerRtk = s.rtk === 'true';
  const wifiRssi = parseInt(s.wifi_rssi ?? '0', 10);
  const cpuTemp = parseInt(s.cpu_temperature ?? '0', 10);

  const hasSensorData = Object.keys(s).length > 0;

  return (
    <div className="relative min-w-0 flex-shrink">
      <button
        onClick={onToggle}
        className={`inline-flex items-center gap-1 md:gap-1.5 h-7 md:h-8 px-1.5 md:px-2.5 rounded-md text-xs transition-colors min-w-0 ${
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
        <span className="text-gray-300 font-medium truncate max-w-[60px] sm:max-w-[80px] md:max-w-none">
          {device.nickname ?? (isCharger ? t('sidebar.charger') : t('sidebar.mower'))}
        </span>
        <Circle className={`w-2.5 h-2.5 fill-current ${device.online ? 'text-green-500' : 'text-gray-600'}`} />

        {hasSensorData && (
          <span className="hidden sm:contents">
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
                <span
                  className={`inline-flex items-center gap-0.5 text-[10px] font-medium ${
                    !loraKnown ? 'text-gray-600'
                    : loraOk ? 'text-green-400'
                    : loraSearching && loraCount <= 5 ? 'text-yellow-400'
                    : 'text-red-400'
                  }`}
                  title={loraKnown
                    ? (loraOk ? 'LoRa: connected' : `LoRa: ${loraRaw}`)
                    : 'LoRa: no data'}
                >
                  <Radio className="w-3 h-3" />
                  {!loraKnown ? '\u2014' : loraOk ? '\u2713' : loraSearching ? loraCount : '!'}
                </span>
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
                <span className={`text-[10px] font-medium ${mowerRtk ? 'text-green-400' : 'text-gray-600'}`}>
                  RTK{mowerRtk ? '\u2713' : '\u2014'}
                </span>
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
          </span>
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
        <div className="absolute top-full left-0 mt-1 w-[calc(100vw-1rem)] sm:w-[380px] md:w-[420px] z-[10000] bg-gray-800 rounded-lg border border-gray-700 shadow-xl p-2 sm:p-3 max-h-[70vh] sm:max-h-96 overflow-auto">
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

/** Menu item for the panels dropdown */
function PanelMenuItem({ icon: Icon, label, active, color, onClick }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  color: string;
  onClick: () => void;
}) {
  const bg: Record<string, string> = {
    blue: 'bg-blue-600', amber: 'bg-amber-600', sky: 'bg-sky-600',
    purple: 'bg-purple-600', orange: 'bg-orange-600', cyan: 'bg-cyan-600', emerald: 'bg-emerald-600',
  };
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors ${
        active ? `${bg[color] ?? 'bg-gray-600'} text-white` : 'text-gray-400 hover:text-white hover:bg-gray-700/50'
      }`}
    >
      <Icon className="w-4 h-4 flex-shrink-0" />
      <span>{label}</span>
    </button>
  );
}

export function DashboardPage({ devices, loading, logs, bleLogs, otaProgress, liveOutlines, coveredLanes }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [logOpen, setLogOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<string | null>(null);
  const [panelsMenuOpen, setPanelsMenuOpen] = useState(false);
  const [pathDirPreview, setPathDirPreview] = useState<number | null>(null);
  const [expandedChip, setExpandedChip] = useState<string | null>(null);
  const [pendingPolygon, setPendingPolygon] = useState<{ mapId: string; mapName: string; mapArea: Array<{ lat: number; lng: number }> } | null>(null);
  const [stopBusy, setStopBusy] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [joystickOpen, setJoystickOpen] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinManualOpen, setPinManualOpen] = useState(false);
  const [patternPlacement, setPatternPlacement] = useState<PatternPlacement | null>(null);
  const [patternCenter, setPatternCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [patternClickActive, setPatternClickActive] = useState(false);
  const [confirmDeleteDevice, setConfirmDeleteDevice] = useState<string | null>(null);
  const [offsetPreview, setOffsetPreview] = useState<Array<{ lat: number; lng: number }> | null>(null);

  const togglePanel = useCallback((panel: string) => {
    setActivePanel(prev => prev === panel ? null : panel);
    setPanelsMenuOpen(false);
    setPathDirPreview(null);
  }, []);

  const handleMapSaved = useCallback((map: MapData) => {
    if (map.mapType === 'work' && map.mapArea.length >= 3) {
      setPendingPolygon({ mapId: map.mapId, mapName: map.mapName ?? map.mapId, mapArea: map.mapArea });
    }
  }, []);

  const handleDeleteDevice = useCallback(async (sn: string) => {
    setConfirmDeleteDevice(sn);
  }, []);
  const executeDeleteDevice = useCallback(async () => {
    if (!confirmDeleteDevice) return;
    await deleteDevice(confirmDeleteDevice);
    setConfirmDeleteDevice(null);
    setExpandedChip(null);
    window.location.reload();
  }, [confirmDeleteDevice]);

  const sorted = Array.from(devices.values()).sort((a, b) => {
    if (a.deviceType !== b.deviceType) return a.deviceType === 'charger' ? -1 : 1;
    return a.sn.localeCompare(b.sn);
  });

  const mower = sorted.find(d => d.deviceType === 'mower');

  const mowerActive = mower?.online && (mower.sensors.work_status === '1' || mower.sensors.work_status === '4');
  const isMappingActive = mower?.online && mower?.sensors.start_edit_or_assistant_map_flag === '1';
  // PIN lock: error_status 151 direct, OR any error whose message mentions PIN input
  // (e.g. error 157 "Robot turn over, please check robot and try again after input pin")
  // STM32 firmware v3.6.7+: extended_commands.py sends type=3 clear error after PIN verify,
  // which clears the error on the mower LCD. Error fields in MQTT will also clear.
  const isPinLocked = mower?.online && (
    mower.sensors.error_status === 'Error (151)' ||
    mower.sensors.error_status === '151' ||
    mower.sensors.error_msg?.toLowerCase().includes('input pin')
  );

  const handlePinSubmit = useCallback(async (code: string) => {
    if (!mower || pinBusy) return;
    setPinBusy(true);
    setPinError(null);
    try {
      await pinVerify(mower.sn, code);
      toast(t('pin.unlockSent'), 'success');
      // Server-side: markPinUnlocked → error_status 151 → 0, overlay verdwijnt automatisch
      setPinManualOpen(false);
      setTimeout(() => setPinBusy(false), 5000);
    } catch {
      setPinError(t('pin.wrongPin'));
      setPinBusy(false);
    }
  }, [mower, pinBusy, t, toast]);

  const handlePinMenuOpen = useCallback(async () => {
    if (!mower?.online) return;
    setPanelsMenuOpen(false);
    setPinManualOpen(true);
    setPinError(null);
  }, [mower]);

  const handleEmergencyStop = useCallback(async () => {
    if (!mower) return;
    setStopBusy(true);
    try {
      await sendCommand(mower.sn, { stop_run: {} });
      await sendCommand(mower.sn, { stop_navigation: {} });
      toast(t('controls.emergencyStopSent'), 'success');
    } catch {
      toast(t('controls.emergencyStopFailed'), 'error');
    }
    setStopBusy(false);
  }, [mower, t, toast]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-gray-500">{t('devices.loading')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-48px)] md:h-[calc(100vh-64px)] overflow-hidden">
      {/* Toolbar */}
      <div className="flex-shrink-0 h-10 flex items-center justify-between gap-1 px-1.5 md:px-3 border-b border-gray-800 bg-gray-900/80 relative z-[10001]">
        {/* Left: device chips */}
        <div className="flex items-center gap-1 min-w-0 flex-shrink">
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

        {/* Right: mower controls + overlays + panels menu */}
        <div className="flex items-center gap-1 md:gap-1.5 flex-shrink-0">
          {mower && (
            <MowerControls
              sn={mower.sn}
              online={mower.online}
              sensors={mower.sensors}
              onPathDirectionChange={setPathDirPreview}
              pendingPolygon={pendingPolygon}
              onStarted={() => { setPendingPolygon(null); setPatternPlacement(null); setPatternCenter(null); setPatternClickActive(false); setOffsetPreview(null); }}
              onPatternPlacementChange={setPatternPlacement}
              onPatternModeChange={setPatternClickActive}
              onOffsetPreviewChange={setOffsetPreview}
              patternCenter={patternCenter}
            />
          )}
          {/* Panels dropdown menu */}
          <div className="relative">
            <button
              onClick={() => setPanelsMenuOpen(!panelsMenuOpen)}
              className={`inline-flex items-center justify-center gap-1 h-7 px-1.5 md:px-2 rounded transition-colors ${
                activePanel ? 'bg-gray-600 text-white' : 'bg-gray-700/60 text-gray-400 hover:text-white'
              }`}
              title="Panels"
            >
              <Menu className="w-4 h-4" />
              {activePanel && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
            </button>
            {panelsMenuOpen && (
              <>
                <div className="fixed inset-0 z-[9999]" onClick={() => setPanelsMenuOpen(false)} />
                <div className="absolute top-full right-0 mt-1 w-52 max-w-[calc(100vw-1rem)] z-[10000] bg-gray-800 rounded-lg border border-gray-700 shadow-xl py-1 overflow-hidden">
                  {mower && (
                    <>
                      <PanelMenuItem icon={Camera} label={t('camera.title')} active={cameraOpen} color="cyan" onClick={() => { setCameraOpen(!cameraOpen); setPanelsMenuOpen(false); }} />
                      <PanelMenuItem icon={Gamepad2} label={t('controls.joystick')} active={joystickOpen} color="emerald" onClick={() => { setJoystickOpen(!joystickOpen); setPanelsMenuOpen(false); }} />
                      <div className="my-1 border-t border-gray-700" />
                      <PanelMenuItem icon={Calendar} label={t('devices.schedule')} active={activePanel === 'schedule'} color="blue" onClick={() => togglePanel('schedule')} />
                      <PanelMenuItem icon={ClipboardList} label={t('history.title')} active={activePanel === 'history'} color="amber" onClick={() => togglePanel('history')} />
                      <PanelMenuItem icon={BarChart3} label={t('charts.title')} active={activePanel === 'charts'} color="sky" onClick={() => togglePanel('charts')} />
                      <PanelMenuItem icon={SlidersHorizontal} label={t('settings.title')} active={activePanel === 'settings'} color="purple" onClick={() => togglePanel('settings')} />
                      <PanelMenuItem icon={Lock} label={t('pin.checkStatus')} active={false} color="amber" onClick={handlePinMenuOpen} />
                      <div className="my-1 border-t border-gray-700" />
                    </>
                  )}
                  <PanelMenuItem icon={HardDrive} label="Firmware (OTA)" active={activePanel === 'ota'} color="orange" onClick={() => togglePanel('ota')} />
                  <PanelMenuItem icon={Settings} label="Setup" active={activePanel === 'setup'} color="blue" onClick={() => togglePanel('setup')} />
                </div>
              </>
            )}
          </div>
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
            pathDirectionPreview={pathDirPreview}
            onMapSaved={handleMapSaved}
            liveOutline={mower ? (liveOutlines.get(mower.sn) ?? null) : null}
            coveredLanes={mower ? (coveredLanes.get(mower.sn) ?? null) : null}
            patternPlacement={patternPlacement}
            onMapClickForPattern={patternClickActive ? (c) => setPatternCenter(c) : undefined}
            offsetPreview={offsetPreview}
          />
          {/* Rain pause overlay */}
          {mower && <RainOverlay mowerSn={mower.sn} />}
          {/* Emergency stop floating button */}
          {mowerActive && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1001]">
              <button
                onClick={handleEmergencyStop}
                disabled={stopBusy}
                className="flex items-center gap-2 px-4 md:px-6 py-3 rounded-full bg-red-600 hover:bg-red-500 active:bg-red-700 text-white font-bold text-xs md:text-sm shadow-lg shadow-red-900/50 animate-pulse hover:animate-none transition-colors disabled:opacity-50"
              >
                <Octagon className="w-5 h-5" />
                {t('controls.emergencyStop')}
              </button>
            </div>
          )}
          {/* PIN lock keypad overlay — auto (when locked) or manual (menu button) */}
          {mower && (isPinLocked && !mowerActive || pinManualOpen) && (
            <PinKeypad
              onSubmit={handlePinSubmit}
              busy={pinBusy}
              error={pinError}
              onClose={pinManualOpen ? () => setPinManualOpen(false) : undefined}
              status={pinManualOpen ? (isPinLocked ? 'locked' : 'unlocked') : undefined}
            />
          )}
          {/* Mapping active overlay */}
          {isMappingActive && mower && (
            <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[1001]">
              <div className="flex items-center gap-2 md:gap-3 flex-wrap justify-center px-3 md:px-4 py-2.5 rounded-2xl md:rounded-full bg-purple-600/90 backdrop-blur shadow-lg shadow-purple-900/40 border border-purple-500/30">
                <span className="flex items-center gap-2 text-sm text-white font-medium">
                  <MapIcon className="w-4 h-4 animate-pulse" />
                  {t('controls.mappingActive')}
                </span>
                <span className="w-px h-5 bg-purple-400/30" />
                <button
                  onClick={async () => {
                    try {
                      await sendCommand(mower.sn, { save_map: { mapName: 'home' } });
                      toast(t('controls.saveMap') + ' ✓', 'success');
                      // Maaier staat in het veld — stuur terug naar station via go_to_charge + ArUco
                      toast(t('map.returningToCharger'), 'info');
                      dockAndSave(mower.sn).then(result => {
                        if (result.ok) toast(t('map.chargerSaveOk'), 'success');
                        else toast(t('map.chargerSaveTimeout'), 'error');
                      }).catch(() => {});
                    } catch { toast(t('controls.saveMap') + ' ✗', 'error'); }
                  }}
                  className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
                >
                  <Save className="w-3.5 h-3.5" />
                  {t('controls.saveMap')}
                </button>
                <button
                  onClick={async () => {
                    try {
                      await sendCommand(mower.sn, { stop_scan_map: {} });
                      toast(t('controls.stopMapping') + ' ✓', 'success');
                    } catch { toast(t('controls.stopMapping') + ' ✗', 'error'); }
                  }}
                  className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-white/10 text-red-300 hover:bg-red-500/20 transition-colors"
                >
                  <StopCircle className="w-3.5 h-3.5" />
                  {t('controls.stopMapping')}
                </button>
                <button
                  onClick={async () => {
                    try {
                      await sendCommand(mower.sn, { quit_mapping_mode: {} });
                      toast(t('controls.cancelMapping') + ' ✓', 'success');
                    } catch { toast(t('controls.cancelMapping') + ' ✗', 'error'); }
                  }}
                  className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-white/10 text-gray-300 hover:bg-gray-500/20 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                  {t('controls.cancelMapping')}
                </button>
              </div>
            </div>
          )}
          {/* Camera stream overlay */}
          {cameraOpen && mower && (
            <div className="absolute top-2 right-2 z-[1001] w-[calc(100vw-1rem)] sm:w-80">
              <CameraStream sn={mower.sn} online={mower.online} onClose={() => setCameraOpen(false)} />
            </div>
          )}
          {/* Joystick overlay */}
          {joystickOpen && mower && (
            <div className="absolute bottom-20 md:bottom-4 left-1/2 md:left-auto md:right-4 -translate-x-1/2 md:translate-x-0 z-[1001]">
              <div className="bg-gray-900/95 backdrop-blur rounded-2xl border border-gray-700 p-4 shadow-xl">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-emerald-400">{t('controls.manualControl')}</span>
                  <button onClick={() => setJoystickOpen(false)} className="text-gray-500 hover:text-gray-300 p-0.5">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <JoystickControl sn={mower.sn} online={mower.online} speedLevel={parseInt(mower.sensors.manual_controller_v ?? '0', 10)} />
              </div>
            </div>
          )}
          {/* Ongebonden apparaten — overlay linksboven op de kaart */}
          <div className="absolute top-3 left-3 z-[1000] w-[calc(100vw-1.5rem)] sm:w-72 pointer-events-auto">
            <UnboundDevices onBound={() => window.location.reload()} />
          </div>
          {/* Mower sensor overlay on map */}
          {mower && (
            <div className="absolute bottom-0 left-0 right-0 z-[1000] max-h-[50%] overflow-auto p-4 pointer-events-none">
              <div className="pointer-events-auto">
                <MowerStatus device={mower} overlay />
              </div>
            </div>
          )}
        </div>
        {/* Side panels (mutually exclusive via activePanel state) */}
        <MobileDrawer open={activePanel === 'schedule' && !!mower} onClose={() => { setActivePanel(null); setPathDirPreview(null); }} title={t('devices.schedule')}>
          {mower && <Scheduler sn={mower.sn} online={mower.online} onPathDirectionChange={setPathDirPreview} />}
        </MobileDrawer>
        <MobileDrawer open={activePanel === 'history' && !!mower} onClose={() => setActivePanel(null)} title={t('history.title')}>
          {mower && <WorkHistory sn={mower.sn} />}
        </MobileDrawer>
        <MobileDrawer open={activePanel === 'charts' && !!mower} onClose={() => setActivePanel(null)} title={t('charts.title')}>
          {mower && <SignalChart sn={mower.sn} />}
        </MobileDrawer>
        <MobileDrawer open={activePanel === 'settings' && !!mower} onClose={() => setActivePanel(null)} title={t('settings.title')}>
          {mower && <SettingsPanel sn={mower.sn} online={mower.online} sensors={mower.sensors} />}
        </MobileDrawer>
        <MobileDrawer open={activePanel === 'ota'} onClose={() => setActivePanel(null)} title="Firmware Update">
          <OtaManager devices={devices} otaProgress={otaProgress} />
        </MobileDrawer>
        <MobileDrawer open={activePanel === 'setup'} onClose={() => setActivePanel(null)} title="Setup">
          <SetupWizard />
        </MobileDrawer>
      </div>

      {/* Log console */}
      <div className={`flex-shrink-0 border-t border-gray-800 transition-all duration-200 ${logOpen ? 'h-32 md:h-56' : 'h-8'}`}>
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

      {/* Confirm device removal dialog */}
      <ConfirmDialog
        open={!!confirmDeleteDevice}
        title={t('devices.confirmRemove', { sn: confirmDeleteDevice ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        onConfirm={executeDeleteDevice}
        onCancel={() => setConfirmDeleteDevice(null)}
      />
    </div>
  );
}
