import { useState, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceState } from '../types';
import { ErrorDisplay } from '../components/status/ErrorDisplay';
import { ThemeProvider } from './ThemeProvider';
import { BottomTabBar } from './components/BottomTabBar';
import { HomeTab } from './components/HomeTab';
import { MapTab } from './components/MapTab';
import { CameraTab } from './components/CameraTab';
import { SchedulesTab } from './components/SchedulesTab';

// ── Types ───────────────────────────────────────────────────────────

export type Tab = 'home' | 'map' | 'camera' | 'schedules';

export type MowerActivity =
  | 'idle' | 'mowing' | 'charging' | 'returning' | 'paused'
  | 'mapping' | 'error' | 'offline';

export interface MowerDerived {
  sn: string;
  online: boolean;
  activity: MowerActivity;
  battery: number;
  batteryCharging: boolean;
  wifiRssi: string | undefined;
  rtkSat: string | undefined;
  lat: number | null;
  lng: number | null;
  heading: number;
  chargerLat: number | null;
  chargerLng: number | null;
  mowingProgress: number;
  errorStatus: string | undefined;
  errorCode: string | undefined;
  errorMsg: string | undefined;
  hasError: boolean;
  nickname: string | null;
  mowerIp: string | undefined;
  headlightOn: boolean;
}

interface Props {
  devices: Map<string, DeviceState>;
  loading: boolean;
  connected: boolean;
  liveOutlines: Map<string, Array<{ lat: number; lng: number }>>;
}

// ── Derive mower state ──────────────────────────────────────────────

function deriveMower(devices: Map<string, DeviceState>): MowerDerived {
  const mower = [...devices.values()].find(d => d.deviceType === 'mower') ?? null;
  const charger = [...devices.values()].find(d => d.deviceType === 'charger') ?? null;
  const s = mower?.sensors ?? {};

  const workStatus = s.work_status ?? '0';
  const isOffline = !mower?.online;
  const hasError = Boolean(
    (s.error_status && s.error_status !== 'OK' && s.error_status !== '0') ||
    (s.error_code && s.error_code !== 'None' && s.error_code !== '0')
  );

  let activity: MowerActivity = 'idle';
  if (isOffline) activity = 'offline';
  else if (hasError && workStatus !== '0') activity = 'error';
  else if (s.start_edit_or_assistant_map_flag === '1') activity = 'mapping';
  else if (workStatus === '2' || s.battery_state?.toUpperCase() === 'CHARGING') activity = 'charging';
  else if (workStatus === '3') activity = 'returning';
  else if (workStatus === '4') activity = 'paused';
  else if (workStatus === '1') activity = 'mowing';

  return {
    sn: mower?.sn ?? '',
    online: mower?.online ?? false,
    activity,
    battery: parseInt(s.battery_power ?? s.battery_capacity ?? '0', 10) || 0,
    batteryCharging: activity === 'charging',
    wifiRssi: s.wifi_rssi,
    rtkSat: s.rtk_sat,
    lat: s.latitude ? parseFloat(s.latitude) : null,
    lng: s.longitude ? parseFloat(s.longitude) : null,
    heading: parseInt(s.z ?? s.mower_z ?? '0', 10) || 0,
    chargerLat: charger?.sensors.latitude ? parseFloat(charger.sensors.latitude) : null,
    chargerLng: charger?.sensors.longitude ? parseFloat(charger.sensors.longitude) : null,
    mowingProgress: parseInt(s.mowing_progress ?? '0', 10) || 0,
    errorStatus: s.error_status,
    errorCode: s.error_code,
    errorMsg: s.error_msg,
    hasError,
    nickname: mower?.nickname ?? null,
    mowerIp: mower?.mowerIp ?? undefined,
    headlightOn: s.headlight === '2',
  };
}

// ── MobilePage ──────────────────────────────────────────────────────

export function MobilePage({ devices, loading, liveOutlines }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('home');
  const mower = useMemo(() => deriveMower(devices), [devices]);
  const rootRef = useRef<HTMLDivElement>(null);

  if (!mower.sn && loading) {
    return (
      <div className="h-screen bg-white dark:bg-gray-950 flex items-center justify-center">
        <div className="text-gray-400 dark:text-gray-500 text-sm">{t('devices.loading')}</div>
      </div>
    );
  }

  return (
    <ThemeProvider rootRef={rootRef}>
      <div
        ref={rootRef}
        className="h-[100dvh] bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-white flex flex-col overflow-hidden"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        {/* Error modal */}
        <ErrorDisplay
          errorCode={mower.errorCode}
          errorMsg={mower.errorMsg}
          errorStatus={mower.errorStatus}
          workStatus={mower.activity === 'idle' ? '0' : '1'}
        />

        {/* Tab content */}
        <div className="flex-1 overflow-hidden">
          {tab === 'home' && (
            <HomeTab mower={mower} />
          )}
          {tab === 'map' && (
            <MapTab mower={mower} liveOutlines={liveOutlines} />
          )}
          {tab === 'camera' && mower.sn && (
            <CameraTab sn={mower.sn} online={mower.online} mowerIp={mower.mowerIp} headlightOn={mower.headlightOn} />
          )}
          {tab === 'schedules' && mower.sn && (
            <SchedulesTab sn={mower.sn} online={mower.online} />
          )}
        </div>

        {/* Bottom tab bar */}
        <BottomTabBar active={tab} onTabChange={setTab} />
      </div>
    </ThemeProvider>
  );
}
