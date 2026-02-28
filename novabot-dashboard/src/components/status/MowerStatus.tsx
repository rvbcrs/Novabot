import type { DeviceState } from '../../types';
import { WorkProgress } from './WorkProgress';
import { ErrorDisplay } from './ErrorDisplay';
import { SensorGrid } from '../sensors/SensorGrid';

interface Props {
  device: DeviceState;
  overlay?: boolean;
}

export function MowerStatus({ device, overlay }: Props) {
  const s = device.sensors;
  const progress = parseInt(s.mowing_progress ?? '0', 10);

  // In overlay mode: only show errors + work progress (sensors are in the chip dropdown)
  if (overlay) {
    const hasError = (s.error_status && s.error_status !== 'OK') ||
                     (s.error_code && s.error_code !== 'None' && s.error_code !== '0');
    const hasProgress = progress > 0;

    if (!hasError && !hasProgress) return null;

    return (
      <div className="space-y-2">
        <ErrorDisplay
          errorCode={s.error_code}
          errorMsg={s.error_msg}
          errorStatus={s.error_status}
          workStatus={s.work_status}
        />
        {hasProgress && <WorkProgress progress={progress} />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ErrorDisplay
        errorCode={s.error_code}
        errorMsg={s.error_msg}
        errorStatus={s.error_status}
        workStatus={s.work_status}
      />
      {progress > 0 && <WorkProgress progress={progress} />}
      <SensorGrid device={device} />
    </div>
  );
}
