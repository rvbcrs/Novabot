import type { DeviceState } from '../../types';
import { WorkProgress } from './WorkProgress';
import { ErrorDisplay } from './ErrorDisplay';
import { SensorGrid } from '../sensors/SensorGrid';

interface Props {
  device: DeviceState;
  overlay?: boolean;
}

const TILE = 'opacity-40 hover:opacity-95 transition-opacity duration-200 backdrop-blur-sm';

export function MowerStatus({ device, overlay }: Props) {
  const s = device.sensors;
  const progress = parseInt(s.mowing_progress ?? '0', 10);
  const t = overlay ? TILE : '';

  return (
    <div className="space-y-4">
      <div className={t}>
        <ErrorDisplay
          errorCode={s.error_code}
          errorMsg={s.error_msg}
          errorStatus={s.error_status}
        />
      </div>

      {progress > 0 && (
        <div className={t}><WorkProgress progress={progress} /></div>
      )}

      <div className={t}>
        <SensorGrid device={device} />
      </div>
    </div>
  );
}
