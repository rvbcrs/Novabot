import type { DeviceState } from '../../types';
import { MowingStatsCard } from './MowingStatsCard';
import { ErrorDisplay } from './ErrorDisplay';
import { SensorGrid } from '../sensors/SensorGrid';
import { deriveMowerActivity } from '../../utils/mowerActivity';

interface Props {
  device: DeviceState;
  overlay?: boolean;
}

export function MowerStatus({ device, overlay }: Props) {
  const s = device.sensors;

  // Use the shared activity derivation (same one that drives the control
  // buttons) so "is mowing" is consistent everywhere — covers coverage mowing
  // AND edge-cutting, not just the narrow work_status === '1'.
  const activity = deriveMowerActivity(s, { online: device.online });
  const isMowing = activity === 'mowing' || activity === 'edge_cutting';

  // In overlay mode: only show the (compact) mowing card; errors go via toast.
  if (overlay) {
    return (
      <>
        <ErrorDisplay
          errorCode={s.error_code}
          errorMsg={s.error_msg}
          errorStatus={s.error_status}
          workStatus={s.work_status}
          sn={device.sn}
          errorAck={s.error_ack}
        />
        {isMowing && <MowingStatsCard sensors={s} compact />}
      </>
    );
  }

  return (
    <div className="space-y-4">
      <ErrorDisplay
        errorCode={s.error_code}
        errorMsg={s.error_msg}
        errorStatus={s.error_status}
        workStatus={s.work_status}
        sn={device.sn}
        errorAck={s.error_ack}
      />
      {isMowing && <MowingStatsCard sensors={s} />}
      <SensorGrid device={device} />
    </div>
  );
}
