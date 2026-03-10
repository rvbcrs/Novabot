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

  // In overlay mode: only show work progress (errors go via toast)
  if (overlay) {
    return (
      <>
        <ErrorDisplay
          errorCode={s.error_code}
          errorMsg={s.error_msg}
          errorStatus={s.error_status}
          workStatus={s.work_status}
        />
        {progress > 0 && <WorkProgress progress={progress} />}
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
      />
      {progress > 0 && <WorkProgress progress={progress} />}
      <SensorGrid device={device} />
    </div>
  );
}
