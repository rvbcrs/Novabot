import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceState } from '../types';
import { MowerMap } from '../components/map/MowerMap';
import { AutoMapPanel } from '../components/map/AutoMapPanel';
import type { PatternPlacement } from '../components/patterns/PatternOverlay';

type OtaProgressEntry = { status: string; percentage: number | null; timestamp: number };

interface Props {
  mower: DeviceState | null;
  connected: boolean;
  liveOutlines: Map<string, Array<{ lat: number; lng: number }>>;
  coveredLanes: Map<string, Array<{ lat1: number; lng1: number; lat2: number; lng2: number }>>;
  otaProgress: Map<string, OtaProgressEntry>;
  /** Bumped by the Start-sheet Preview button to show a fresh coverage preview. */
  previewRequest?: { nonce: number; covDirection: number; canonicals: string[]; polygonArea?: Array<{ latitude: number; longitude: number }> } | null;
  /** Placed pattern overlay (controls→map) + map-click handler (map→controls). */
  patternPlacement?: PatternPlacement | null;
  onMapClickForPattern?: (center: { lat: number; lng: number }) => void;
  /** Mower control buttons hosted in the map's floating tool-bar. */
  controlsSlot?: ReactNode;
  /** True only right after a dashboard-initiated Start, until the mower reports
   *  fresh cover data — hides the previous session's carried-over progress. */
  progressSuppressed?: boolean;
  /** Reports when the map is actually fetching the mower coverage preview. */
  onPreviewLoading?: (loading: boolean) => void;
}

export function MapTab({ mower, connected, liveOutlines, coveredLanes, previewRequest, patternPlacement, onMapClickForPattern, controlsSlot, progressSuppressed, onPreviewLoading }: Props) {
  const { t } = useTranslation();
  if (!mower) {
    return <div className="p-8 text-zinc-500">{t('pages.selectMowerForMap')}</div>;
  }

  // The mower is "actively mowing" across every work phase — kept in sync with
  // MowerControls' own test so the live plan + progress + stats card stay
  // visible the whole session. Critically this includes BOUNDARY_COVERING (the
  // edge-cut finale) — note a substring `includes('Work:COVERING')` would NOT
  // match `Work:BOUNDARY_COVERING`, which is why the progress used to vanish
  // during edge cutting — and AVOIDING (obstacle stops between lanes).
  const msg = mower.sensors.msg ?? '';
  const isMowing = mower.online && /Work:(RUNNING|COVERING|NAVIGATING|BOUNDARY_COVERING|AVOIDING|MOVING)/.test(msg);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      <MowerMap
        sn={mower.sn}
        mowingActive={isMowing}
        sensors={mower.sensors}
        lat={mower.sensors.latitude}
        lng={mower.sensors.longitude}
        mapX={mower.sensors.map_position_x}
        mapY={mower.sensors.map_position_y}
        heading={mower.sensors.theta}
        online={mower.online && connected}
        signals={{
          wifiRssi: mower.sensors.wifi_rssi,
          rtkSat: mower.sensors.rtk_sat,
          locQuality: mower.sensors.loc_quality,
          batteryPower: mower.sensors.battery_power ?? mower.sensors.battery_capacity,
          batteryState: mower.sensors.battery_state,
        }}
        mowing={{
          mowingProgress: mower.sensors.mowing_progress,
          coveringArea: mower.sensors.covering_area,
          finishedArea: mower.sensors.finished_area,
          workStatus: mower.sensors.work_status,
          mowSpeed: mower.sensors.mow_speed,
          covDirection: mower.sensors.cov_direction,
        }}
        liveOutline={liveOutlines.get(mower.sn) ?? null}
        coveredLanes={coveredLanes.get(mower.sn) ?? null}
        previewRequest={previewRequest}
        patternPlacement={patternPlacement}
        onMapClickForPattern={onMapClickForPattern}
        controlsSlot={controlsSlot}
        progressSuppressed={progressSuppressed}
        onPreviewLoading={onPreviewLoading}
      />
      <AutoMapPanel sn={mower.sn} />
    </div>
  );
}
